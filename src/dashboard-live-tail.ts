// The dashboard's live surfaces: the activity-log tail that follows the in-flight wave's agents,
// and the pure helpers the live-update stream (ADR 0008) uses to read appended log lines and drop
// machine noise.
import { existsSync, readFileSync } from "node:fs";
import { type ResolvedConfig } from "./config.ts";
import { type OrchestratorEvent } from "./event-log.ts";
import { activityLogPath } from "./activity.ts";
import { humanizeLogLine, type HumanizedRow } from "./log-view.ts";
import { type IssueStatus } from "./dashboard-lifecycle.ts";
import { type CampaignStatus, type StatusIssue, buildStatus } from "./dashboard-status.ts";

/**
 * The events appended to a jsonl event log past a character offset, and the
 * offset to resume from next time. Pure — the tail-reading half of the live
 * watcher (ADR 0008), split out so it can be unit-tested without a file or a
 * running server: given the log's full text and where we last stopped, it returns
 * only the newly-appended *complete* lines (parsed, bad lines skipped like
 * `readEventLog`) and the new offset — the length of text consumed up to and
 * including the last newline. A partial trailing line (an append caught
 * mid-write) is left unconsumed so it is read whole next time, and a `content`
 * shorter than `offset` means the log was truncated or rotated, so it is re-read
 * from the start.
 */
export function appendedEvents(content: string, offset: number): { events: OrchestratorEvent[]; offset: number } {
  const from = offset >= 0 && offset <= content.length ? offset : 0;
  const tail = content.slice(from);
  const lastNewline = tail.lastIndexOf("\n");
  if (lastNewline === -1) return { events: [], offset: from };
  const complete = tail.slice(0, lastNewline + 1);
  const events = complete
    .split("\n")
    .filter(Boolean)
    .flatMap((line): OrchestratorEvent[] => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { event?: unknown }).event !== "string") return [];
      return [parsed as OrchestratorEvent];
    });
  return { events, offset: from + complete.length };
}

/**
 * The event kinds the live-update stream (ADR 0008) treats as machine-noise: rows
 * that land in `orchestrator.jsonl` but never change any rendered dashboard view, so
 * an SSE frame pushed for them refreshes the client for nothing. This is a **denylist,
 * fail-open by design** — the per-repo page renders more than the cross-project feed
 * (its issue-detail sheet folds turn/gate/worktree rows), so an allowlist keyed on
 * `describeEvent` would drop events the detail view needs. Only kinds known to be pure
 * side-channel noise (the outbound message queue, a failed Telegram send) are listed;
 * anything unrecognized is kept.
 */
export const SSE_NOISE_EVENTS: ReadonlySet<string> = new Set(["telegram-send-failed", "outbound-enqueued"]);

/**
 * The view-relevant subset of a batch of appended events — everything except the
 * `SSE_NOISE_EVENTS` denylist above. The live watcher (ADR 0008) filters through this
 * before emitting, so a burst of pure machine-noise appends yields no SSE frame and no
 * wasted client refresh; a frame is emitted only when at least one surviving event
 * remains. Pure and order-preserving so it is unit-testable without a running server.
 */
export function viewRelevantEvents(events: OrchestratorEvent[]): OrchestratorEvent[] {
  return events.filter((e) => !SSE_NOISE_EVENTS.has(e.event));
}

/**
 * One line in the live tail (#124): the running issue it came from (the gutter
 * number), that issue's status (the gutter colour), its ISO `ts`, its 0-based index
 * within its own `activity-<issue>.jsonl` (`n` — a stable id the client dedups its
 * appends by, immune to the snapshot window sliding), and the exact JSONL text (the
 * client tokenises it with `highlightJsonLine` and substring-filters it whole).
 */
export interface TailLine {
  issue: string;
  status: IssueStatus;
  ts: string;
  n: number;
  raw: string;
  /** the line's humanized parts (#203) — `time · actor · what happened` + a state dot, so
   * the log-view component renders humanized-by-default without re-parsing the raw client-side. */
  humanized: HumanizedRow;
}

/** One running agent the live tail merges: its issue number and status (always
 * `running` — the pane only tails agents in flight). */
export interface TailAgent {
  issue: string;
  status: IssueStatus;
}

/** A project's live-tail snapshot: the running agents (for the issue dropdown) and
 * their merged, newest-last activity lines (capped at `TAIL_SNAPSHOT_CAP`). */
export interface LiveTail {
  agents: TailAgent[];
  lines: TailLine[];
}

/**
 * The server-side merge window a tail snapshot carries — the newest lines across every
 * running agent (#124). The client accumulates its own following buffer (capped smaller)
 * from these snapshots; a generous server window keeps a *paused* client's growing
 * backlog fed even across many appends.
 */
export const TAIL_SNAPSHOT_CAP = 500;

/**
 * The running (slot-holding) members of the wave in flight (design §11) — what the live tail
 * follows. The tail answers "what is it doing right now", so it lists the runners of the one wave
 * the loop is draining (`status.inFlight`), never a member still reading `running` in a wave that
 * has advanced or one not yet in flight (a racy/partial log leaves such ghosts). A hand-built
 * status with no `inFlight` field falls back to every running issue across the plan.
 */
export function inFlightRunning(status: CampaignStatus): StatusIssue[] {
  // A pending green reads `running` (design §2.2) but its slot is already freed, so it is not an
  // in-flight runner the tail should follow — exclude it, leaving only slot-holding runners.
  const running = status.waves.flatMap((wave) => wave.issues).filter((issue) => issue.status === "running" && !issue.pendingGreen);
  if (status.inFlight === undefined) return running;
  const ids = new Set(status.inFlight);
  return running.filter((issue) => ids.has(issue.issueNumber));
}

/**
 * The live-tail snapshot for a project (#124): every running agent of the wave in flight
 * ({@link inFlightRunning}), its raw `activity-<issue>.jsonl` merged into one issue-keyed,
 * newest-last stream. Each agent's activity file (the live-only scratch the loop writes per
 * tool-use, ADR 0015) is read whole, every line tagged with its issue, status, ISO `ts`, and
 * 0-based file index, then all lines merged by `ts` and capped to the newest window. A running
 * agent whose file does not exist yet (just spawned) still appears in `agents` so the dropdown
 * lists it; it simply contributes no lines. Pure over the filesystem — no clock — so it is
 * unit-testable.
 */
export function buildLiveTail(cfg: ResolvedConfig): LiveTail {
  const status = buildStatus(cfg);
  const agents: TailAgent[] = inFlightRunning(status).map((issue) => ({ issue: issue.issueNumber, status: "running" }));
  const lines: TailLine[] = [];
  for (const agent of agents) {
    const file = activityLogPath(cfg.stateDir, agent.issue);
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content
      .split("\n")
      .filter(Boolean)
      .forEach((text, n) => {
        let ts = "";
        try {
          const parsed = JSON.parse(text) as { ts?: unknown };
          if (typeof parsed?.ts === "string") ts = parsed.ts;
        } catch {
          // An unparseable line still renders in the raw tail; an empty `ts` sorts it first.
        }
        lines.push({ issue: agent.issue, status: "running", ts, n, raw: text, humanized: humanizeLogLine(text) });
      });
  }
  // Stable sort merges the per-agent streams newest-last by `ts`; ties keep file order.
  lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { agents, lines: lines.length > TAIL_SNAPSHOT_CAP ? lines.slice(lines.length - TAIL_SNAPSHOT_CAP) : lines };
}
