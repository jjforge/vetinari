import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownerRepoFromRemote, repoForProject, type ResolvedConfig } from "./config.ts";
// Re-exported so `status.ts`'s `export *` and `dashboard-route-page.ts` keep
// reaching them here; the definitions moved to config.ts once the registry and CLI
// came to depend on this project-identity edge (an odd fit under dashboard-model).
export { ownerRepoFromRemote, repoForProject };
import { hostLogger, type Logger } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord, type ParkReason } from "./state.ts";
import { projectHasLiveCampaign } from "./host-slots.ts";
import { readEventLog, type OrchestratorEvent } from "./event-log.ts";
import { activityLogPath } from "./activity.ts";
import { humanizeLogLine, localTime, type HumanizedRow } from "./log-view.ts";
import { normalize } from "./issue-id.ts";
import {
  describeEvent,
  extractParkedDetails,
  festiveFor,
  formatFeedEvent,
  issueNameFromTask,
  lastEventText,
  titlesFromLog,
} from "./dashboard-event-text.ts";
// Re-exported by name (not `export *`) so `status.ts`'s `export *` keeps reaching the event
// text here without leaking `dashboard-event-text.ts`'s internal helpers into the barrel.
export {
  festiveOffsetFor,
  festiveFromCookie,
  type FestiveWaveLabel,
  waveLabel,
  waveMembersLabel,
  describeEvent,
  formatFeedEvent,
  lastEventText,
  titlesFromLog,
  issueStateFromTask,
  issueNameFromTask,
  parkedReplyFor,
  extractParkedDetails,
} from "./dashboard-event-text.ts";
import {
  type DisplayStatus,
  type IssuePhase,
  type IssueStatus,
  type Membership,
  type WaveStatus,
  campaignState,
  issueLifecycle,
  issueMembership,
  issuePhase,
  parkReasonFromEvent,
  reduceCampaign,
  waveState,
} from "./dashboard-lifecycle.ts";
// Re-exported by name (not `export *`) so every importer of the lifecycle through this module
// or `status.ts`'s `export *` compiles unchanged now it lives in `dashboard-lifecycle.ts`.
export {
  type IssueStatus,
  type DisplayStatus,
  type Membership,
  type IssueLifecycle,
  type WaveStatus,
  type CampaignState,
  type ReducedCampaign,
  type IssuePhase,
  type IssueTurn,
  type IssueDetail,
  parkReasonFromEvent,
  reduceCampaign,
  issueLifecycle,
  issueMembership,
  issuePhase,
  reconstructIssueDetail,
  waveState,
  campaignState,
  campaignRunning,
  campaignStarted,
  campaignSettled,
} from "./dashboard-lifecycle.ts";

/**
 * The base branch a redrive would land on, read live from the project checkout's current
 * branch (design §7, §11) — the impure git edge the Redrive confirm dialog names. The dumb
 * router (ADR 0002) holds no project config to read `baseBranch` from, so it reads the tree:
 * a stopped campaign — the only time Redrive enables — sits on its base (the loop merges onto
 * and refuses off base, §5), so HEAD is the base at rest. A non-repo root or a detached/failed
 * read yields `undefined` (the git call is silenced and never throws), and the dialog then
 * says "the base branch" rather than a broken value.
 */
export function baseBranchForProject(projectRoot: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a `parked` issue is held (design §2.3) — metadata set *by the transition*, not a
 * status word: `question` (a `parked{question}` awaiting an answer), `conflict` (an
 * integrator merge conflict), `red-base` (a combined-gate wave-park — the *wave's* reason,
 * never a member's), `stalled` (a `parked{stalled}` on turn budget / idle / no-commit, the
 * run loop's own resource stop), `crash` (reconciliation: the run's process is gone with
 * no terminal stop marker since the latest `wave-start`, so an in-flight issue never
 * verdicted — design §7), or `stopped`
 * (a person signalled the run before it reached a verdict; its work is kept, redrive to resume). The reason
 * selects the recovery affordance; the surface word is one. The single enum lives in
 * `state.ts` and is re-exported here so the render sites can import it beside the model.
 */
export type { ParkReason };

export interface StatusIssue {
  issueNumber: string;
  /** the issue's lifecycle state — the dot/word the chip paints (ADR 0019). */
  status: DisplayStatus;
  /** why it is `parked`, when it is — selects the recovery affordance, not a word. */
  reason?: ParkReason;
  /** the orthogonal membership axis — the badge the chip carries. Absent reads as a
   * plain `member` (the common case), so only a `grafted`/`pruned` chip sets it. */
  membership?: Membership;
  /** true when this `running` chip is a green awaiting merge (design §2.2): it went green but
   * has not banked on the base, so its agent slot is already freed — the live tail must not
   * follow it as an in-flight runner. Absent for a genuinely slot-holding `running` chip. */
  pendingGreen?: boolean;
  /** the step this `running` issue is currently in (design §11, {@link issuePhase}) — the word
   * shown in place of `running` on the row, and whether the dot holds steady. Set only for a
   * live `running` chip; absent for every other lifecycle (they keep their word and no phase). */
  phase?: IssuePhase;
  name?: string;
  detail?: string;
}

export interface StatusWave {
  index: number;
  status: WaveStatus;
  /** why the wave is `parked`, when the hold is a wave-level one: `red-base`, the
   * combined-gate park on a red merged base (design §2.3). It is the *wave's* reason,
   * not any member's — the members keep their own lifecycle. Absent otherwise; a wave
   * parked only because a member is held carries no wave reason (the member has it). */
  reason?: ParkReason;
  /** whether the wave has actually *closed* — the reducer's `closedWaves` membership,
   * carried onto the display wave (derived at render from the event log, so §2.1's
   * no-stored-presentation-state rule is untouched). Set only by `wave-done` and only when
   * no member is conflict-parked, so it lags `status === "completed"`: a wave whose last
   * member merged reads `completed` while its wave-level gates still run, but stays `closed:
   * false` until `wave-done` lands. The renderer keys the collapse-into-chip affordance on
   * this, not on the status word, so a still-integrating wave stays an expanded card. Absent
   * on a hand-built status (reads as not-closed). */
  closed?: boolean;
  issues: StatusIssue[];
}

export interface ParkedIssue {
  issueNumber: string;
  reason: string;
  parkedAt: string;
  branch: string;
  description: string;
  options: string[];
}

export interface CampaignStatus {
  project: string;
  /** the run's optional `--name`, shown as the header label; absent when unnamed. */
  name?: string;
  /** the festive-name offset for this campaign (#193), derived at render from its
   * `campaign-start` timestamp ({@link festiveOffsetFor}); wave `i` renders as
   * `festiveWaveName(festiveOffset, i)` when festive wave names are on. Absent for a run
   * with no `campaign-start`, which then renders nameless under festive. */
  festiveOffset?: number;
  waves: StatusWave[];
  parked: ParkedIssue[];
  /** the issue ids of the wave currently in flight — the reducer's `currentWave` (design §11):
   * what the live tail follows so it lists the slot-holders of the one wave the loop is draining,
   * never a member still reading `running` in a wave that has advanced or one not yet in flight (a
   * racy/partial log leaves such ghosts). An empty array means no wave is in flight; the field is
   * absent only on a hand-built status, where {@link inFlightRunning} falls back to every runner. */
  inFlight?: string[];
  /** whether a stop is pending on the latest campaign ({@link stopPending}) — `vetinari stop` asked
   * it to stop after the wave in flight and it has not yet parked. Absent reads as false, like
   * `inFlight` on a hand-built status. */
  stopPending?: boolean;
}

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

// Issue titles rarely change during a campaign, so we cache them for the process
// lifetime; a rename won't surface until the status server restarts.
const issueNameCache = new Map<string, string | undefined>();

/** An archived run's terminal disposition for the archived-runs list: `complete`
 * when its latest campaign reached the terminal `campaign-done`/`queue-done` (a
 * full, clean finish), else `stalled` — the run stopped with no terminal event
 * (killed mid-wave, a crash), the coarse run-level word for the archived list. A
 * stalled run still expands to the waves that did run; its in-flight issues, dead with
 * no verdict, fold to `parked{crash}` when read back (`buildStatus({ dead: true })`,
 * design §7). */
export type ArchivedRunState = "complete" | "stalled";

/**
 * A run's terminal disposition, scoped to the latest `campaign-start` like the
 * rest of the reducer (#69) so a superseded earlier run never decides it — a run
 * is `complete` once it lands its `campaign-done` marker.
 */
export function archivedRunState(events: OrchestratorEvent[]): ArchivedRunState {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = start >= 0 ? events.slice(start) : events;
  return relevant.some((e) => e.event === "campaign-done") ? "complete" : "stalled";
}

/**
 * The ISO timestamp a run token encodes, or undefined when it doesn't parse.
 * `archiveRun` writes the token as `new Date().toISOString().replace(/[:.]/g, "-")`,
 * so `2026-08-23T22-22-36-267Z` reverses to `2026-08-23T22:22:36.267Z` — only the
 * time's `:`/`.` were flattened to `-`, the date keeps its own. An older token
 * written without the milliseconds or the trailing `Z` still parses (ms → `.000`).
 */
export function parseRunTimestamp(run: string): string | undefined {
  const m = run.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z?$/);
  if (!m) return undefined;
  const [, date, h, mi, s, ms] = m;
  const iso = `${date}T${h}:${mi}:${s}.${ms ?? "000"}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** The archive-token form of an ISO timestamp — the inverse of {@link parseRunTimestamp}:
 * flatten only the time's `:`/`.` to `-`, exactly as `archiveRun` writes a run's token
 * (`new Date().toISOString().replace(/[:.]/g, "-")`). The date keeps its own `-`. Used to
 * mint a `lastRun` token for a finished campaign still living in the live log — never
 * archived, so with no token of its own (design §11). */
const runTokenFor = (iso: string): string => iso.replace(/[:.]/g, "-");

/** The latest event timestamp in a log — the finish stamp of the run it records. Undefined
 * when no event carries a `ts`. */
const lastEventStamp = (events: OrchestratorEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) if (typeof events[i].ts === "string") return events[i].ts as string;
  return undefined;
};

/** An archived run addressable in the dashboard: its timestamp token (`run`), the
 * resolved log path, and a one-line summary of what it did. The token is the only
 * thing a request supplies; `file` is resolved from the listing, never joined from
 * request input, so there is no path to traverse. */
export interface ArchivedRun {
  run: string;
  file: string;
  summary: string;
  /** the run's `--name`, when it was launched with one — the list's primary label
   * (it falls back to the `run` timestamp token when absent). */
  name?: string;
  /** whether the run finished clean (`complete`) or was cut short (`stalled`);
   * a stalled row still expands to the partial waves recorded before it stopped. */
  state: ArchivedRunState;
  /** the run's start time as an ISO timestamp, parsed from its `run` token; undefined
   * for a token that doesn't parse (so the row falls back to the token verbatim). */
  startedAt?: string;
  /** how many issues the run's plan spanned (its full pre-prune membership, so a
   * pruned-out issue still counts — it renders as a chip in the expanded view). */
  issues: number;
}

/** The directory a project's finished-run logs are archived into (mirrors
 * `archiveRun`'s own `logs/archive` layout). */
const archiveDirOf = (baseLocation: string) => join(baseLocation, "logs", "archive");

/**
 * List a project's archived runs newest-first, each with the one-line summary
 * `summarizeRun` folds from its log. The timestamp token is read off the
 * `orchestrator-<timestamp>.jsonl` filename `archiveRun` wrote, so it sorts
 * lexicographically into newest-first (ISO stamps are zero-padded). A malformed
 * archive — one no run can be reconstructed from — is skipped with a log line,
 * never fatal: one bad file must not take the whole list down.
 */
export function listArchivedRuns(baseLocation: string, logger: Logger = hostLogger()): ArchivedRun[] {
  const dir = archiveDirOf(baseLocation);
  if (!existsSync(dir)) return [];
  const runs: ArchivedRun[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(/^orchestrator-(.+)\.jsonl$/);
    if (!match) continue;
    const file = join(dir, name);
    const events = readEventLog({ logFile: file });
    const { waves, layout, name: runName } = reduceCampaign(events);
    if (!waves.length) {
      logger.log("status-archive-skipped", { file });
      continue;
    }
    runs.push({
      run: match[1],
      file,
      summary: summarizeRun(events),
      name: runName,
      state: archivedRunState(events),
      startedAt: parseRunTimestamp(match[1]),
      issues: layout.flat().length,
    });
  }
  return runs.sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0));
}

/**
 * Fold one run's event log into a one-line summary for the archived-runs list:
 * its mode (a `campaign` frame vs a bare `queue` run), how many issues it spanned,
 * and whether it finished clean or failed. Failure is derived from an issue reaching
 * `failure` (the agent could not make it green, ADR 0019) — the same `reduceCampaign`
 * plan the dashboard renders, so the summary can never disagree with the run's
 * reconstructed wave/issue view (ADR 0005).
 */
export function summarizeRun(events: OrchestratorEvent[]): string {
  // Everything derives from the run `reduceCampaign` reconstructs (the latest
  // `campaign-start` onward), so a multi-run archive summarizes its terminal run —
  // a failure in a superseded earlier run in the same log no longer reads a
  // completed run as failed (#69).
  const { waves, outcomes } = reduceCampaign(events);
  const mode = events.some((e) => e.event === "campaign-start") ? "campaign" : "queue";
  const count = waves.flat().length;
  const failed = [...outcomes.values()].includes("failed");
  return `${mode} · ${count} issue${count === 1 ? "" : "s"} · ${failed ? "failed" : "complete"}`;
}

/**
 * The one rule for which parked records count (#379) — the project page (`buildStatus`) and
 * the landing (its card and cross-repo queue, off `status.parked`) both read it, so the two
 * surfaces never disagree. A record counts when its issue is in the current campaign's plan
 * (the reducer's pruned loop-facing `waves`, folded from the latest `campaign-start` only, so a
 * superseded campaign's records drop out) and not in a closed wave. An empty plan — the live
 * log archived or emptied — keeps every surviving record, so a park that outlived its log
 * still counts (#232).
 */
const parkedInCurrentPlan = (records: ParkedRecord[], plan: { waves: string[][]; closedWaves: Set<number> }): ParkedRecord[] => {
  const activeIssueNumbers = new Set(plan.waves.flat());
  const closedIssueNumbers = new Set([...plan.closedWaves].flatMap((index) => plan.waves[index] ?? []));
  return records.filter((parked) => {
    const issueNumber = normalize(parked.taskId);
    return (!activeIssueNumbers.size || activeIssueNumbers.has(issueNumber)) && !closedIssueNumbers.has(issueNumber);
  });
};

/**
 * Reconstruct a project's live campaign status off its event log (ADR 0005/0019).
 * Each chip composes the two orthogonal axes — its `issueLifecycle` (the dot/word) and
 * `issueMembership` (the badge) — and each wave's status is the pure `waveState` fold of
 * its members, so a wave with a red member reads `failed` and a held wave reads `parked`
 * by construction (no render-time precedence). Liveness feeds crash detection (design §7):
 * `dead` marks a run whose process is gone (an archived read) and `alive` carries the live
 * host-slot probe (`projectHasLiveCampaign`); either way an `alive === false` run with no
 * terminal stop marker since the latest `wave-start` reconciles its still-`running` issues
 * to `parked{crash}` inside the
 * reducer. Omitting both leaves the live default — `running` stays `running`.
 */
export function buildStatus(cfg: ResolvedConfig, opts: { dead?: boolean; alive?: boolean } = {}): CampaignStatus {
  const events = readEventLog(cfg);
  // An archived read is dead by definition; a live read passes the slot-lease probe. The
  // reducer folds an in-flight `running` issue of a dead run to `parked{crash}` (§7, §15).
  const alive = opts.dead ? false : opts.alive;
  const reduced = reduceCampaign(events, { alive });
  const { waves, layout, name, festiveOffset, outcomes, details, titles, closedWaves } = reduced;

  const closedIssueNumbers = new Set([...closedWaves].flatMap((index) => waves[index] ?? []));
  const parkedRecords = parkedInCurrentPlan(listParked(cfg), { waves, closedWaves });
  for (const parked of parkedRecords) {
    const taskId = normalize(parked.taskId);
    // `completed` (merged) is terminal (design §2.2): a record that outlived a since-merged issue
    // (durable records are only cleared on re-admit/redrive or `prune --purge`, §2.5) must not flip
    // the merged card back to parked. Leave the outcome; the surviving record is a stale straggler.
    if (outcomes.get(taskId) === "completed") continue;
    outcomes.set(taskId, "parked");
    reduced.parkReasons.set(taskId, parkReasonFromEvent(parked.reason));
    details.set(taskId, `Parked: ${parked.reason}`);
  }

  // Display waves render off `layout` (the pre-prune membership) so a pruned issue still
  // shows as a chip in the wave it left (ADR 0007). Each chip carries both axes; the wave's
  // own status is the pure fold of its members (`waveState`), pruned members excluded. A
  // crashed run's in-flight issues already read `parked{crash}` off the reducer above.
  const displayWaves = layout.map((wave, index) => {
    const issues = wave.map((issueNumber): StatusIssue => {
      const life = issueLifecycle(reduced, issueNumber);
      // A live `running` issue carries its phase (design §11, #359) — the step it is in, derived
      // from its latest event. An archived read (`dead`) renders no phases, so it is skipped there.
      const phase = !opts.dead && life.state === "running" ? issuePhase(events, issueNumber) : undefined;
      return {
        issueNumber,
        status: life.state,
        ...(life.reason ? { reason: life.reason } : {}),
        membership: issueMembership(reduced, issueNumber),
        ...(reduced.pendingGreen.has(issueNumber) ? { pendingGreen: true } : {}),
        ...(phase ? { phase } : {}),
        name: titles.get(issueNumber),
        detail: details.get(issueNumber),
      };
    });
    // A red-base wave-park is the wave's own reason (design §2.3): its members keep their
    // lifecycle (a merged member stays completed), so the hold shows only on the wave.
    const redBase = wave.some((issueNumber) => reduced.redBase.has(issueNumber));
    // An operator stop is likewise the wave's own hold, shown only on the wave.
    const stopped = wave.some((issueNumber) => reduced.stopped.has(issueNumber));
    const waveReason: ParkReason | undefined = redBase ? "red-base" : stopped ? "stopped" : undefined;
    // `closed` is the reducer's `closedWaves` membership carried onto the display wave —
    // the wave actually closed (its gates ran and `wave-done` logged, with no conflict-parked
    // member), which lags the `completed` fold. Keyed on member id (via `closedIssueNumbers`)
    // rather than `wave.index`, because `closedWaves` indexes the pruned loop-facing `waves`
    // while these display waves index `layout` — a mid-campaign prune that empties a wave
    // makes the two indices diverge, but the member ids never lie. The renderer collapses
    // on this, never on the status word. A pruned member left the loop-facing plan and so
    // never appears in `closedWaves`; skip it, exactly as `waveState` does, or a wave whose
    // surviving members all closed could never satisfy the fold (ADR 0007, #363).
    const live = issues.filter((i) => i.membership !== "pruned");
    const closed = live.length > 0 && live.every((i) => closedIssueNumbers.has(i.issueNumber));
    return { index, status: waveState(issues, { redBase, stopped }), ...(waveReason ? { reason: waveReason } : {}), closed, issues };
  });

  return {
    project: cfg.project,
    name,
    festiveOffset,
    waves: displayWaves,
    parked: parkedRecords.map(toParkedIssue),
    // The wave in flight is the reducer's `currentWave` (design §11); its members are what the
    // live tail follows. Always an array (empty when none is in flight) so the tail scopes rather
    // than falling back to every runner across the plan.
    inFlight: reduced.currentWave >= 0 ? [...(reduced.waves[reduced.currentWave] ?? [])] : [],
    stopPending: stopPending(events),
  };
}

/**
 * Is a stop already pending on the latest campaign? One is when the log carries a `stop-requested`
 * after the latest `campaign-start` with no stop marker (`campaign-parked`/`-failed`/`-done`) after
 * it — the campaign took the request and has not yet parked on it. Pure over the event log; the
 * CLI's `stop` and the dashboard's Stop control both read it.
 */
export function stopPending(events: OrchestratorEvent[]): boolean {
  const start = events.findLastIndex((e) => e.event === "campaign-start");
  const request = events.findLastIndex((e) => e.event === "stop-requested");
  if (request < 0 || request < start) return false;
  return !events.slice(request).some((e) => e.event === "campaign-parked" || e.event === "campaign-failed" || e.event === "campaign-done");
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

export async function buildStatusWithIssueNames(cfg: ResolvedConfig): Promise<CampaignStatus> {
  const status = buildStatus(cfg);
  const issues = status.waves.flatMap((wave) => wave.issues);
  await Promise.all(
    issues.map(async (issue) => {
      const cacheKey = `${cfg.project}:${issue.issueNumber}`;
      if (!issueNameCache.has(cacheKey)) {
        try {
          issueNameCache.set(cacheKey, issueNameFromTask(String(await cfg.fetchTask(issue.issueNumber))));
        } catch {
          issueNameCache.set(cacheKey, undefined);
        }
      }
      issue.name = issueNameCache.get(cacheKey);
    }),
  );
  return status;
}

/**
 * The slice of a `ResolvedConfig` that `buildStatus` actually reads, synthesized
 * from a registry pointer's base location. The gateway is a dumb router (ADR
 * 0002): it never imports a project's TS config, it reads the same state files
 * (`logs/`, `parked/`) the run wrote under the base location — the paths a full
 * config's `loadConfig` would have derived from `stateDir`.
 */
/** The orchestrator event log inside a project's base location — the file the
 * gateway reads to reconstruct a project's campaign without its TS config. */
export const logFileOf = (baseLocation: string) => join(baseLocation, "logs", "orchestrator.jsonl");

/**
 * The `ResolvedConfig` slice `buildStatus` needs to render one archived run: its
 * log is the archive file, and its `parkedDir` points at the archive directory —
 * which holds only `orchestrator-*.jsonl`, never parked `*.json` — so `listParked`
 * reads empty and the archived render carries no parked cards (read-only).
 */
export const archiveStatusConfig = (project: string, archiveFile: string): ResolvedConfig =>
  ({
    project,
    stateDir: dirname(archiveFile),
    parkedDir: dirname(archiveFile),
    logFile: archiveFile,
  }) as ResolvedConfig;

/** The `ResolvedConfig` slice a registry pointer resolves to — the paths a full config's
 * `loadConfig` would derive from its base location (ADR 0002). Exported so the live-update
 * route can build a project's `buildLiveTail`/`buildStatus` off its pointer without its TS
 * config, exactly as `buildAllStatus` does internally. */
export const statusConfigFromPointer = (pointer: ProjectPointer): ResolvedConfig =>
  ({
    project: pointer.project,
    stateDir: pointer.baseLocation,
    parkedDir: parkedDirOf(pointer.baseLocation),
    logFile: logFileOf(pointer.baseLocation),
  }) as ResolvedConfig;

/**
 * Build the campaign status for every registered project, reading each project's
 * state live from its base location. A project whose base location is missing
 * (moved or deleted since it registered) is skipped with a log line, never
 * throwing — one stale registration must not take the whole dashboard down (ADR
 * 0002). Uses the pure `buildStatus`, so issue names are not resolved here (that
 * needs the project's own `fetchTask`); the aggregated view is names-free. `configDir`
 * (the gateway config dir) enables live crash detection (design §7): each project's
 * host-slot lease is probed for liveness so a run that died with no verdict folds to
 * `parked{crash}`. Omitted (a pure caller with no lease to reach), the live default holds.
 */
export function buildAllStatus(pointers: ProjectPointer[], logger: Logger = hostLogger(), configDir?: string): CampaignStatus[] {
  const statuses: CampaignStatus[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const alive = configDir !== undefined ? projectHasLiveCampaign(configDir, pointer.project) : undefined;
    statuses.push(buildStatus(statusConfigFromPointer(pointer), { alive }));
  }
  return statuses;
}

/** One row of the cross-project event feed: which project it came from, when it
 * happened (the event's ISO `ts`), the raw event kind, the repo-prefixed
 * plain-words sentence `formatFeedEvent` folds it to, and `raw` — the underlying
 * event serialized back to NDJSON, the bytes the feed's Raw toggle highlights and
 * Download JSON emits (#203), so the humanized default has a faithful raw source. */
export interface FeedEntry {
  project: string;
  ts: string;
  kind: string;
  text: string;
  raw: string;
  /** the row's shared log-view parts (#216): the repo leads the message as the actor, the
   * narration is one plain span, and the dot reads the event's state — so the feed renders in
   * the same `.lv-row` component as the live tail, host log and archive. */
  humanized: HumanizedRow;
}

/** The feed's rolling window: an event feeds only when its `ts` is within this
 * span of render time. 48h — deliberately a fixed rolling window, *not* the
 * merged-today counters' operator-local calendar day (#97): the two surfaces
 * answer different questions ("what has the fleet done lately" vs. "what merged
 * on today's date"), so they carry different time bounds by design. */
const FEED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Margin added to the window when deciding which archived runs to read. An
 * archive's runId (its filename timestamp) is when the run *started*; a run that
 * began just before the window can still hold events inside it. A run's events
 * cluster near its runId, so reading archives whose start falls within the window
 * plus this small margin catches them without opening ancient archives — the
 * per-event `ts` filter then makes the precise 48h cut. */
const FEED_ARCHIVE_MARGIN_MS = 6 * 60 * 60 * 1000;

/**
 * The cross-project event feed: every registered project's narratable events over
 * a rolling 48h window (by event `ts`), repo-prefixed and sorted newest-first.
 * Reads each project's live run **and** its recently-archived runs — an idle
 * project's last run archived and reset its live log (`archiveRun`), so a live-only
 * read would show "No activity" even when it merged issues hours ago (#101). Only
 * archives whose runId falls within the window (plus a small margin) are opened;
 * events are then filtered to the window by `ts`. Reads live off the registry,
 * exactly as `buildLanding`/`buildAllStatus` do — a project whose base location is
 * gone, or a single malformed archive, is skipped with a log line rather than
 * throwing (ADR 0002). Machine-noise events `describeEvent` can't narrate carry no
 * row (`formatFeedEvent` returns ""), so the feed reads as an operator log, not a
 * raw event dump.
 */
export function buildFeed(pointers: ProjectPointer[], now: Date = new Date(), logger: Logger = hostLogger(), festive = false): FeedEntry[] {
  const cutoffMs = now.getTime() - FEED_WINDOW_MS;
  const archiveFloorMs = cutoffMs - FEED_ARCHIVE_MARGIN_MS;
  const entries: FeedEntry[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    // The runs whose events might fall in the window: the live log, plus each
    // archived run whose start is recent enough to still carry in-window events.
    const runs: OrchestratorEvent[][] = [readEventLog(statusConfigFromPointer(pointer))];
    for (const run of listArchivedRuns(pointer.baseLocation, logger)) {
      const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
      if (Number.isNaN(startedMs) || startedMs < archiveFloorMs) continue;
      try {
        runs.push(readEventLog({ logFile: run.file }));
      } catch (error) {
        logger.log("status-feed-archive-skipped", { file: run.file, error: String(error) });
      }
    }
    for (const events of runs) {
      // Each run carries its own reserved offset on its `campaign-start`, so resolve it
      // once per run and narrate that run's wave events festively off it (#193).
      const festiveArg = festiveFor(events, festive);
      const titles = titlesFromLog(events);
      for (const e of events) {
        const tsMs = Date.parse(String(e.ts ?? ""));
        if (Number.isNaN(tsMs) || tsMs < cutoffMs) continue;
        const sentence = describeEvent(e, { festive: festiveArg, titles });
        if (!sentence) continue;
        const raw = JSON.stringify(e);
        // The feed is cross-repo, so the repo leads the message as the actor; the narration is
        // one plain span and the dot borrows the event's state from the shared log-view registry.
        const dot = humanizeLogLine(raw).dot;
        const humanized: HumanizedRow = {
          time: localTime(typeof e.ts === "string" ? e.ts : ""),
          actor: pointer.project,
          verb: "",
          spans: [{ text: sentence, kind: "plain" }],
          dot,
        };
        entries.push({
          project: pointer.project,
          ts: String(e.ts),
          kind: String(e.event ?? ""),
          text: formatFeedEvent(pointer.project, e, { festive: festiveArg, titles }),
          raw,
          humanized,
        });
      }
    }
  }
  return entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

const toParkedIssue = (rec: ParkedRecord): ParkedIssue => {
  const details = extractParkedDetails(rec.question);
  return {
    issueNumber: normalize(rec.taskId),
    reason: rec.reason,
    parkedAt: rec.parkedAt,
    branch: rec.branch,
    ...details,
  };
};

/**
 * Which project the aggregated view shows: the one named in the request, or the
 * first registered project when none is named (or the name is stale). Never
 * undefined given at least one project — the page always shows something useful
 * on a bare open. Callers guard the empty-registry case before calling.
 */
export function selectStatus(statuses: CampaignStatus[], requested?: string): CampaignStatus {
  return statuses.find((s) => s.project === requested) ?? statuses[0];
}

/** A project's run-state rolled up to one word for the landing card (ADR 0019): the
 * card fold of its campaign. `failed` (a broken issue) outranks `parked` (a held
 * one), then `running`; a completed or absent campaign folds to `idle` — the card
 * never reads a bare "completed", and never `idle` while anything is parked or failed. */
export type RunState = "running" | "parked" | "failed" | "idle";

/** One project's row on the all-repos landing: its run state, the campaign it is
 * (or last) running, how far through the waves it is, how much has merged, a
 * running/parked/queued tally, and the last event in plain words. An idle project
 * (no live run) reads `idle` and carries its last campaign's name and summary. */
export interface ProjectCard {
  project: string;
  /** the project's `owner/name`, derived from its checkout's git remote — the label
   * the card heading shows in place of the bare `project` key; omitted (so the
   * display falls back to `project`) for a project with no parseable GitHub remote. */
  repo?: string;
  runState: RunState;
  campaignName?: string;
  wave: { current: number; total: number } | null;
  percentMerged: number;
  tally: { running: number; parked: number; queued: number };
  lastEvent: string;
  /** for an idle project, the facts of its newest archived run (design §11): the run
   * token the card links to (`/?project=…&run=<token>`, which the project page expands
   * as `archivedRun` at the top of the newest-first list), the run's `complete`/`stalled`
   * outcome, its campaign name (the run's `--name`, falling back to the token), and the
   * finish time parsed off the token (the archive stamp `archiveRun` writes at end-of-run).
   * Absent for a live run (running/parked) — there is no finished run to point the card at. */
  lastRun?: { run: string; outcome: ArchivedRunState; name: string; finishedAt?: string };
}

/** The four numbers across the top of the landing, summed across every live
 * project: agents working (running issues), issues awaiting a human (parked),
 * issues still queued (unstarted), and issues merged on the current day. */
export interface LandingCounters {
  working: number;
  parked: number;
  queued: number;
  mergedToday: number;
}

/** One parked question in the cross-repo queue the landing's parked counter
 * expands into: which issue, which repo, the full question, and when it was
 * parked (the client derives the waited duration from `parkedAt`). */
export interface ParkedQuestion {
  issueNumber: string;
  project: string;
  question: string;
  parkedAt: string;
}

/** The all-repos landing model: the four counters, one card per registered
 * project, and the cross-repo parked queue (oldest first). The client shell
 * renders this; it is reconstructed live off the registry each request, exactly
 * as `buildAllStatus` is (ADR 0006). */
export interface LandingView {
  counters: LandingCounters;
  projects: ProjectCard[];
  parked: ParkedQuestion[];
}

/**
 * The card fold (ADR 0019): a project's `RunState` is the pure fold of its campaign
 * (which is itself the fold of its waves), with `completed`/`unstarted`/no-campaign
 * collapsed to `idle`. `failed` outranks `parked` — a broken issue is a louder signal
 * than a held one (the deliberate reversal of the old `parked > failed` order). A
 * counted parked record (`status.parked`, the project page's plan filter — every surviving
 * record when the live log is empty) still forces `parked`, so the card is never `idle`
 * while a question waits (#232, #258, #379). No precedence ladder:
 * the fold is the single derivation, so a card can never disagree with its waves.
 */
export const cardState = (status: CampaignStatus): RunState => {
  const campaign = campaignState(status.waves.map((wave) => wave.status));
  if (campaign === "failed") return "failed";
  if (campaign === "parked" || status.parked.length) return "parked";
  if (campaign === "running") return "running";
  return "idle";
};

/** Same *local* calendar day — the basis for "merged today". The gateway runs in
 * the operator's timezone, so a merge is "today" when its local Y/M/D matches
 * `now`'s local Y/M/D, not its UTC day (#97): near midnight the two diverge, and
 * the operator means their own day. `new Date(iso)` parses the merge stamp and its
 * getters read it in the process timezone, the same one `now` is read in. */
const sameLocalDay = (iso: string, day: Date) => {
  const merged = new Date(iso);
  return merged.getFullYear() === day.getFullYear() && merged.getMonth() === day.getMonth() && merged.getDate() === day.getDate();
};

/**
 * How many of a project's issues merged (completed) on `now`'s day, counted across
 * *every* one of its runs — the live run plus every archived run
 * (`listArchivedRuns`), not just the latest (#97). Each run is reduced
 * independently and an issue that completed today in it is added to a per-project
 * set, so an issue appearing in more than one run (a re-run) is counted once. Read-
 * only over the logs (ADR 0002); a run whose reduce throws is skipped with a log
 * line so one bad archive can never zero the count. "Today" is the operator's
 * local day (see `sameLocalDay`), so a merge just past midnight UTC still counts
 * for the local day the operator is actually in (#97).
 */
const mergedTodayForProject = (baseLocation: string, liveEvents: OrchestratorEvent[], now: Date, logger: Logger): number => {
  const merged = new Set<string>();
  const runs = [liveEvents, ...listArchivedRuns(baseLocation, logger).map((r) => readEventLog({ logFile: r.file }))];
  for (const runEvents of runs) {
    try {
      const { mergedAt, outcomes } = reduceCampaign(runEvents);
      for (const [issueNumber, ts] of mergedAt) {
        if (outcomes.get(issueNumber) === "completed" && sameLocalDay(ts, now)) merged.add(issueNumber);
      }
    } catch (error) {
      logger.log("status-merged-today-skipped", { baseLocation, error: String(error) });
    }
  }
  return merged.size;
};

const buildProjectCard = (
  pointer: ProjectPointer,
  status: CampaignStatus,
  events: OrchestratorEvent[],
  logger: Logger,
  festive = false,
): ProjectCard => {
  // The card heading shows owner/name, read live off the checkout's git remote;
  // undefined for a project with none (the demo), so the display falls back to the key.
  const repo = repoForProject(pointer.projectRoot);
  // The idle branches count `status.parked` — the project page's own filter
  // (`parkedInCurrentPlan`), so the card and the page never disagree (#379). A park that
  // outlived its run's log (the log archived — a killed process, an out-of-band archive —
  // while the record survives on disk) leaves an empty plan, which keeps every surviving
  // record: the card reads `parked` with a real tally, never a clean idle while a question
  // still waits (#232). A record outside the current plan or in a closed wave counts nowhere.
  const parked = status.parked;
  if (!status.waves.length) {
    const [latest] = listArchivedRuns(pointer.baseLocation, logger);
    // An idle card's numbers come from the last archived run, not the emptied live
    // log: reconstruct it and read its real merged % so a completed run no longer
    // reads 0% (#70). `waves` is already the pruned plan (pruned issues dropped), so
    // the ratio matches the live card's pruned-aware count.
    const archived = latest ? reduceCampaign(readEventLog({ logFile: latest.file })) : undefined;
    const archivedIssues = archived ? archived.waves.flat() : [];
    const merged = archived ? archivedIssues.filter((n) => archived.outcomes.get(n) === "completed").length : 0;
    return {
      project: status.project,
      repo,
      runState: parked.length ? "parked" : "idle",
      campaignName: latest?.name ?? latest?.run,
      wave: null,
      percentMerged: archivedIssues.length ? Math.round((merged / archivedIssues.length) * 100) : 0,
      tally: { running: 0, parked: parked.length, queued: 0 },
      lastEvent: latest ? `Last run: ${latest.summary}` : "No runs yet",
      // The card opens onto its newest archived run: its outcome, name and finish time,
      // plus the token the card links to so the project page expands it at the top of the
      // archived list (design §11). Absent when the project has never archived a run.
      ...(latest
        ? { lastRun: { run: latest.run, outcome: latest.state, name: latest.name ?? latest.run, finishedAt: latest.startedAt } }
        : {}),
    };
  }
  // A finished campaign still lingering in the live log folds to idle at render time
  // (#208): the read-only dashboard never archives (ADR 0002), so a campaign whose
  // every wave closed — but whose log the CLI never emptied — otherwise reads live
  // forever. The card fold already collapses a `completed` campaign to `idle`; this
  // branch swaps the live wave counts for the finished run's name + "Last run: …"
  // summary. A counted parked record still wins (parked over idle, #232); the fold's
  // `failed`/`parked`/`running` never reach here, so no attention state ever fades. The
  // live log is left byte-for-byte untouched — this is display-only.
  if (campaignState(status.waves.map((wave) => wave.status)) === "completed") {
    const { waves, outcomes } = reduceCampaign(events);
    const finishedIssues = waves.flat();
    const merged = finishedIssues.filter((n) => outcomes.get(n) === "completed").length;
    // The finished run's facts, read off the live log it still sits in (design §11): its
    // clean/stalled disposition, when it finished (its last stamp), and — since it was never
    // archived so has no archive token — a token derived from that finish stamp (the inverse
    // of `parseRunTimestamp`). The card links `/?project=…&run=<token>`; the run renders as the
    // live campaign at the top of the project page, so the link opens onto it either way.
    const finishedAt = lastEventStamp(events);
    const lastRun = finishedAt
      ? { run: runTokenFor(finishedAt), outcome: archivedRunState(events), name: status.name ?? runTokenFor(finishedAt), finishedAt }
      : undefined;
    return {
      project: status.project,
      repo,
      runState: parked.length ? "parked" : "idle",
      campaignName: status.name,
      wave: null,
      percentMerged: finishedIssues.length ? Math.round((merged / finishedIssues.length) * 100) : 0,
      tally: { running: 0, parked: parked.length, queued: 0 },
      lastEvent: `Last run: ${summarizeRun(events)}`,
      ...(lastRun ? { lastRun } : {}),
    };
  }
  // The card reflects the live plan, not the display's pruned ghosts: drop pruned
  // chips (and any wave left wholly pruned) so wave counts and progress match what
  // is actually still running (ADR 0007/0019's pruned is a membership overlay only).
  const liveWaves = status.waves
    .map((wave) => ({ ...wave, issues: wave.issues.filter((i) => i.membership !== "pruned") }))
    .filter((wave) => wave.issues.length);
  const issues = liveWaves.flatMap((wave) => wave.issues);
  const total = liveWaves.length;
  const closed = liveWaves.filter((wave) => wave.status === "completed").length;
  const runningWave = liveWaves.findIndex((wave) => wave.status === "running");
  const completed = issues.filter((i) => i.status === "completed").length;
  return {
    project: status.project,
    repo,
    runState: cardState(status),
    campaignName: status.name,
    // "N of M": the wave in flight if one is, otherwise how many have closed.
    wave: { current: runningWave >= 0 ? runningWave + 1 : closed, total },
    percentMerged: issues.length ? Math.round((completed / issues.length) * 100) : 0,
    // Count each issue by its lifecycle directly — the two-axis split means a chip's
    // status is already a clean lifecycle (a grafted issue reads `unstarted` → queued,
    // #200), with pruned members dropped above (a pruned chip counts in no bucket).
    tally: {
      running: issues.filter((i) => i.status === "running").length,
      parked: issues.filter((i) => i.status === "parked").length,
      queued: issues.filter((i) => i.status === "unstarted").length,
    },
    lastEvent: lastEventText(events, festive),
  };
};

/**
 * Reconstruct the all-repos landing model live off the registry: one card per
 * project and the four summed counters. A project whose base location is gone is
 * skipped with a log line, never throwing — one stale registration must not take
 * the landing down (ADR 0002), the same tolerance `buildAllStatus` has.
 * merged-today counts each project's issues whose reconstructed merge stamp
 * (`reduceCampaign`'s `mergedAt`) falls on `now`'s local day. `configDir` (the gateway
 * config dir) enables live crash detection (design §7): a project whose run died with no
 * verdict folds to `parked{crash}`, so its card never reads idle or running. Omitted, the
 * live default holds — the same optional probe `buildAllStatus` takes.
 */
export function buildLanding(
  pointers: ProjectPointer[],
  now: Date = new Date(),
  logger: Logger = hostLogger(),
  festive = false,
  configDir?: string,
): LandingView {
  const projects: ProjectCard[] = [];
  const parked: ParkedQuestion[] = [];
  let mergedToday = 0;
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const cfg = statusConfigFromPointer(pointer);
    const events = readEventLog(cfg);
    const alive = configDir !== undefined ? projectHasLiveCampaign(configDir, pointer.project) : undefined;
    const status = buildStatus(cfg, { alive });
    // merged-today counts every issue merged today across all of the project's runs
    // — the live run plus every archived run, deduped per issue — so a project that
    // ran several campaigns today counts them all, not just its latest run (#97).
    // A completed run's merges live in its archive, not the cleared live log (#70).
    mergedToday += mergedTodayForProject(pointer.baseLocation, events, now, logger);
    const card = buildProjectCard(pointer, status, events, logger, festive);
    // Cross-repo parked queue: the project page's own plan-filtered parks (`status.parked`),
    // the same list the card counts — so the counter, the queue and the card agree, and a park
    // that outlived an emptied log (an empty plan keeps every record) still queues (#232, #379).
    // Tagged with the repo for the cross-repo list.
    for (const p of status.parked) {
      parked.push({ issueNumber: p.issueNumber, project: status.project, question: p.description, parkedAt: p.parkedAt });
    }
    projects.push(card);
  }
  // Oldest first — the question that has waited longest surfaces at the top.
  parked.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
  const sum = (pick: (card: ProjectCard) => number) => projects.reduce((total, card) => total + pick(card), 0);
  return {
    counters: {
      working: sum((c) => c.tally.running),
      // The parked counter *is* the length of the cross-repo parked queue it expands into
      // (#259): both derive from the one `parked` array, so the number and the list can never
      // disagree by construction — a conflict/red-base hold shows as an amber chip with its
      // own recovery affordance, not as a phantom row the counter would over-count (ADR 0019).
      parked: parked.length,
      queued: sum((c) => c.tally.queued),
      mergedToday,
    },
    projects,
    parked,
  };
}
