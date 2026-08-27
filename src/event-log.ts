import { existsSync, readFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";

/**
 * The typed shape of the orchestrator's on-disk event log (`logs/orchestrator.jsonl`),
 * one JSON object per line. Every line is written by `log()` (`log.ts`), which stamps
 * a `ts` and an `event` discriminant onto whatever fields the call site passed, so the
 * base every row satisfies is `{ ts; event }`.
 *
 * `OrchestratorEvent` narrows that base for the kinds the dashboard reconstructs from
 * (`dashboard-model.ts`) — a discriminated union keyed on `event`, so a `switch (e.event)`
 * gives narrowed, no-`any` field access. The ~25 other produced kinds (gate/sandbox/queue
 * bookkeeping) are intentionally not narrowed; they still round-trip through `readEventLog`
 * as base rows, they just carry no extra typed fields. The per-event interfaces are exported
 * individually so `log.ts` can type its own emit sites against them later.
 */
export interface BaseEvent {
  /** ISO timestamp `log()` stamps on every row. */
  ts: string;
  /** the event kind — the union's discriminant. */
  event: string;
}

/** `campaign-start` — a campaign run's plan: its batches (waves), slot budget, optional
 * `--name`, and the id→title map the orchestrator resolves up front so the dashboard names
 * chips with no lookup (modes.ts). */
export interface CampaignStartEvent extends BaseEvent {
  event: "campaign-start";
  batches: string[][];
  slots: number;
  name?: string;
  titles?: Record<string, string>;
}

/** `campaign-batch` — a wave started: its zero-based index and the tasks it drains, plus the
 * campaign's optional `--name` and id→title map (carried so a single-event reader can name the
 * run and its wave without re-reading the log) (modes.ts). */
export interface CampaignBatchEvent extends BaseEvent {
  event: "campaign-batch";
  index: number;
  tasks: string[];
  name?: string;
  titles?: Record<string, string>;
}

/** `campaign-batch-done` — a wave closed: what merged into the base, what was held (non-green),
 * the parked records cleared for the completed wave, and any greens a merge conflict quarantined
 * (branch/worktree/session preserved, ADR 0013) (modes.ts). */
export interface CampaignBatchDoneEvent extends BaseEvent {
  event: "campaign-batch-done";
  index: number;
  merged: string[];
  held: string[];
  clearedParked: string[];
  quarantined?: string[];
  /** the campaign's optional `--name` and id→title map, carried like `campaign-batch` so a
   * single-event reader can name the run and its wave. */
  name?: string;
  titles?: Record<string, string>;
}

/** `campaign-done` — the whole campaign finished cleanly; carries the number of batches merged
 * onto the base (modes.ts). */
export interface CampaignDoneEvent extends BaseEvent {
  event: "campaign-done";
  batches: number;
  /** the campaign's optional `--name`, carried so a single-event reader can name the run. */
  name?: string;
}

/** `campaign-halt` — a wave hit a merge conflict or a red merged base, halting the campaign with
 * the base rolled back: the wave index, the reason, and the task it halted on when there is one
 * (modes.ts). */
export interface CampaignHaltEvent extends BaseEvent {
  event: "campaign-halt";
  index: number;
  reason: string;
  taskId?: string;
  /** the campaign's optional `--name`, carried so a single-event reader can name the run. */
  name?: string;
}

/** `queue-start` — a bounded queue run started: its task ids and slot count, optionally the id→title
 * map (a standalone queue records its own) and the host slot budget it ran under (modes.ts). */
export interface QueueStartEvent extends BaseEvent {
  event: "queue-start";
  taskIds: string[];
  slots: number;
  titles?: Record<string, string>;
  hostBudget?: number;
}

/** `queue-done` — a queue drained: the per-task outcome map (`green`/`parked`/`error(n)`) the
 * dashboard reduces to statuses (modes.ts). */
export interface QueueDoneEvent extends BaseEvent {
  event: "queue-done";
  outcomes: Record<string, string>;
}

/** `queue-spawn` — a task took an agent slot: how many are now running and how many still wait
 * (modes.ts). */
export interface QueueSpawnEvent extends BaseEvent {
  event: "queue-spawn";
  taskId: string;
  running: number;
  left: number;
}

/** `turn` — one agent turn finished: its task, zero-based turn number, the completion signal,
 * the resumable session id, token usage, how many commits it landed, and the agent's own
 * one-sentence summary the turn log renders verbatim (loop.ts, ADR 0009). */
export interface TurnEvent extends BaseEvent {
  event: "turn";
  taskId: string;
  turn: number;
  summary: string;
  signal?: string;
  sessionId?: string;
  commits?: number;
  usage?: unknown;
}

/** `green` — an agent's branch passed the orchestrator gate on a real change: the task, the branch,
 * and the landed commit shas (loop.ts). */
export interface GreenEvent extends BaseEvent {
  event: "green";
  taskId: string;
  branch: string;
  commits: string[];
}

/** `parked` — a slot parked its task for a human: the task and why (blocked/budget/idle-timeout/…)
 * (state.ts). */
export interface ParkedEvent extends BaseEvent {
  event: "parked";
  taskId: string;
  reason: string;
}

/** `quarantined` — integration hit a merge conflict on `agent/<id>` and pulled that one green
 * from the wave: the task, its branch, and the tail of the conflict output. Attributable blame,
 * so only this merge is aborted — the earlier greens stay merged and the wave continues; the
 * issue's branch/worktree/session are left intact so it is resumable (merge.ts, ADR 0013). */
export interface QuarantinedEvent extends BaseEvent {
  event: "quarantined";
  taskId: string;
  branch: string;
  detail: string;
}

/** `wave-parked` — a wave's merged base gated red (every green passed alone, the combined base is
 * red): the emergent, unattributable failure. No branch is to blame, so nothing rolls back — the
 * greens stay merged on the base and the campaign pauses (resumably) for a human to fix forward and
 * resume, or carve a suspect. Carries the greens left merged and the tail of the gate report
 * (merge.ts, ADR 0013). */
export interface WaveParkedEvent extends BaseEvent {
  event: "wave-parked";
  merged: string[];
  detail: string;
}

/** `carve` — an issue (and its dependency closure) was carved out of a running campaign: the target
 * issue, the closure computed for removal, and the members actually dropped from the plan
 * (cli.mts, ADR 0005/0007). */
export interface CarveEvent extends BaseEvent {
  event: "carve";
  target: string;
  removed: string[];
  dropped: string[];
}

/** `graft` — issues were added to a running (or resumable) campaign: the added ids and the
 * precomputed layering inputs the pure reducer folds them with (each added id's in-campaign
 * `blockedBy`, and the basenames of the added ids plus the still-unstarted members it places
 * against) so `reduceCampaign` stays free of tracker/filesystem access (cli.mts, ADR 0014/0012).
 * The additive mirror of `carve`. */
export interface GraftEvent extends BaseEvent {
  event: "graft";
  ids: string[];
  blockedBy: Record<string, string[]>;
  basenames: Record<string, string[]>;
}

/** `worktree-preserved` — a parked slot left its worktree on the host: the task and the preserved
 * path, the genuine per-task identity the issue-detail sheet surfaces (loop.ts). */
export interface WorktreePreservedEvent extends BaseEvent {
  event: "worktree-preserved";
  taskId: string;
  path: string;
}

/** `telegram-unconfigured` — a `campaign`/`queue` started for a project whose base location resolves
 * no Telegram connection (no `VETINARI_TELEGRAM_*` in its `host.env`): the project name and its base
 * location, so the dashboard can narrate an un-notifiable project whose parked questions won't ping
 * (modes.ts, issue #116). */
export interface TelegramUnconfiguredEvent extends BaseEvent {
  event: "telegram-unconfigured";
  project: string;
  baseLocation: string;
}

/** `wave-start` — the operator-facing "wave N started" note. Emitted to the outbound message queue
 * (`enqueueOutbound`, modes.ts), not the event log, so it carries only its rendered `text`; typed
 * here so the seam covers the full wave vocabulary. */
export interface WaveStartEvent extends BaseEvent {
  event: "wave-start";
  text: string;
}

/** `wave-merged` — the operator-facing "wave N merged …" note. Like `wave-start`, an outbound-queue
 * message (modes.ts) carrying only its rendered `text`. */
export interface WaveMergedEvent extends BaseEvent {
  event: "wave-merged";
  text: string;
}

/**
 * The narrowed rows the dashboard reconstructs from — a discriminated union on `event`. A row
 * whose `event` is none of these is still a valid `BaseEvent`; it simply isn't a member here, so
 * `readEventLog` returns it cast-and-trusted (see there). Kept a closed union of the known kinds so
 * a `switch (e.event)` narrows each member's fields with no `any`.
 */
export type OrchestratorEvent =
  | CampaignStartEvent
  | CampaignBatchEvent
  | CampaignBatchDoneEvent
  | CampaignDoneEvent
  | CampaignHaltEvent
  | QueueStartEvent
  | QueueDoneEvent
  | QueueSpawnEvent
  | TurnEvent
  | GreenEvent
  | ParkedEvent
  | QuarantinedEvent
  | WaveParkedEvent
  | CarveEvent
  | GraftEvent
  | WorktreePreservedEvent
  | TelegramUnconfiguredEvent
  | WaveStartEvent
  | WaveMergedEvent;

/**
 * The single parse site for the event log: read the JSONL at `cfg.logFile` and return its rows
 * typed. Cast-and-trust — a row is narrowed by its `event` discriminant alone, its fields are
 * trusted rather than validated, matching how the dashboard has always read this log. A line that
 * fails `JSON.parse`, or parses to something without a string `event`, is skipped rather than
 * crashing the read or emitting a junk row. A missing log file reads empty.
 */
export function readEventLog(cfg: Pick<ResolvedConfig, "logFile">): OrchestratorEvent[] {
  if (!existsSync(cfg.logFile)) return [];
  return readFileSync(cfg.logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { event?: unknown }).event !== "string") return [];
      return [parsed as OrchestratorEvent];
    });
}

/**
 * A typed builder for a well-formed `OrchestratorEvent`, so tests stop hand-rolling `any` literals:
 * pass the kind and its narrowed fields and get back the row with a `ts` filled in (override it by
 * passing `ts`). The field type is the chosen member minus the `ts`/`event` the builder supplies.
 */
export function event<K extends OrchestratorEvent["event"]>(
  kind: K,
  fields: Omit<Extract<OrchestratorEvent, { event: K }>, "ts" | "event"> & { ts?: string },
): Extract<OrchestratorEvent, { event: K }> {
  return { ts: new Date().toISOString(), ...fields, event: kind } as Extract<OrchestratorEvent, { event: K }>;
}
