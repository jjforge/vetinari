import { existsSync, readFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import type { ParkReason } from "./state.ts";

/**
 * The typed shape of the orchestrator's on-disk event log (`logs/orchestrator.jsonl`),
 * one JSON object per line. Every line is written by `log()` (`log.ts`), which stamps
 * a `ts` and an `event` discriminant onto whatever fields the call site passed, so the
 * base every row satisfies is `{ ts; event }`.
 *
 * `OrchestratorEvent` is the design §2.1 event vocabulary — the small, user-worded set
 * the dashboard reconstructs from (`dashboard-model.ts`) — plus `grace-wait` and the
 * activity/diagnostic rows the live tail narrates (gate/tool/commit/…, design §2.1:
 * "activity, not state"). It is a discriminated union keyed on `event`, so a
 * `switch (e.event)` gives narrowed, no-`any` field access. Other produced kinds
 * (sandbox setup, hook failures) still round-trip through `readEventLog` as base rows;
 * they just carry no extra typed fields.
 *
 * Archived logs written in the pre-§2.1 vocabulary (`campaign-batch`, `queue-*`,
 * `wave-parked`, `quarantined`, and the old park reasons) are translated to this set by
 * the single alias table in {@link normalizeLegacyEvent} on the read path — the one and
 * only place the retired names appear.
 */
export interface BaseEvent {
  /** ISO timestamp `log()` stamps on every row. */
  ts: string;
  /** the event kind — the union's discriminant. */
  event: string;
}

/** `campaign-start` — a campaign run's plan: its waves, slot budget, optional `--name`, and
 * the id→title map the orchestrator resolves up front so the dashboard names chips with no
 * lookup. `name` and `titles` are recorded here **once** (design §2.1); no wave event repeats
 * them, and no presentation state (a festive naming offset) is ever written (modes.ts). */
export interface CampaignStartEvent extends BaseEvent {
  event: "campaign-start";
  waves: string[][];
  slots: number;
  name?: string;
  titles?: Record<string, string>;
}

/** `wave-start` — a wave started: its zero-based index and the tasks it drains (modes.ts). */
export interface WaveStartEvent extends BaseEvent {
  event: "wave-start";
  index: number;
  tasks: string[];
}

/** `spawn` — a task took an agent slot (design §2.1). `running`/`left` are carried for the
 * live "N active, M waiting" detail; the reducer seeds the task `running` off it (modes.ts). */
export interface SpawnEvent extends BaseEvent {
  event: "spawn";
  taskId: string;
  running?: number;
  left?: number;
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

/** `merged` — the integrator merged a task's green branch onto the base (design §2.1) (merge.ts). */
export interface MergedEvent extends BaseEvent {
  event: "merged";
  taskId: string;
  branch?: string;
}

/** `parked` — a slot parked its task for a human (design §2.1, §2.3): the task, the one-enum
 * `reason`, and `detail` carrying the specifics (which `stalled`, the conflict output, the gate
 * tail). Written by the run loop (`question`/`stalled`) and the integrator (`conflict`) (state.ts,
 * merge.ts). */
export interface ParkedEvent extends BaseEvent {
  event: "parked";
  taskId: string;
  reason: ParkReason;
  detail?: string;
}

/** `failed` — a task the agent could not make green (its child `run` exited non-zero): a terminal
 * failure that holds its wave (design §2.1, §5 step 5) (modes.ts). */
export interface FailedEvent extends BaseEvent {
  event: "failed";
  taskId: string;
  detail?: string;
}

/** `base-gate` — the integrator ran the full gate against the merged base for a wave: whether it
 * was green, and the gate report tail when not (design §2.1) (merge.ts). */
export interface BaseGateEvent extends BaseEvent {
  event: "base-gate";
  index?: number;
  green: boolean;
  detail?: string;
}

/** `wave-done` — a wave closed with every member completed (design §2.1): its index and the
 * `merged` list, which — because a wave-done fires only when every member merged — is the wave's
 * whole membership. No wave-done is logged for a wave that parked or failed (modes.ts). */
export interface WaveDoneEvent extends BaseEvent {
  event: "wave-done";
  index: number;
  merged?: string[];
}

/** `campaign-parked` — the campaign paused at a wave boundary (design §2.1, the first of the two
 * stop markers): the wave index, the wave-level `reason` written by the code that stopped it
 * (`red-base`, `question`, `stalled`, or `conflict` — §2.1 rule 2: the reducer reads this reason,
 * it never infers one from surrounding events), and the detail. The greens already merged stay on
 * the base (modes.ts). */
export interface CampaignParkedEvent extends BaseEvent {
  event: "campaign-parked";
  index?: number;
  reason?: ParkReason;
  detail?: string;
}

/** `campaign-failed` — the campaign stopped as failed (design §2.1, the second stop marker):
 * the wave index a member could not be made green in, and the detail. The per-task failures are
 * carried by their own `failed` events (modes.ts). */
export interface CampaignFailedEvent extends BaseEvent {
  event: "campaign-failed";
  index?: number;
  detail?: string;
}

/** `campaign-done` — the whole campaign finished cleanly; carries the number of waves merged onto
 * the base and the optional `--name` so a single-event reader can name the run (modes.ts). */
export interface CampaignDoneEvent extends BaseEvent {
  event: "campaign-done";
  waves: number;
  name?: string;
}

/** `prune` — an issue (and its dependency closure) was pruned out of a running campaign: the target
 * issue, the closure computed for removal, and the members actually dropped from the plan
 * (cli.mts, ADR 0005/0007). */
export interface PruneEvent extends BaseEvent {
  event: "prune";
  target: string;
  removed: string[];
  dropped: string[];
}

/** `graft` — issues were added to a running (or resumable) campaign: the added ids and the
 * precomputed layering inputs the pure reducer folds them with (each added id's in-campaign
 * `blockedBy`, and the basenames of the added ids plus the still-unstarted members it places
 * against) so `reduceCampaign` stays free of tracker/filesystem access (cli.mts, ADR 0014/0012).
 * The additive mirror of `prune`. */
export interface GraftEvent extends BaseEvent {
  event: "graft";
  ids: string[];
  blockedBy: Record<string, string[]>;
  basenames: Record<string, string[]>;
  /** each grafted id's issue title (parsed from the task text graft already fetches),
   * so the reducer's title-folding renders the grafted wave's header and rows with a
   * real title instead of a bare `Wave N` / `#num` (#197). */
  titles?: Record<string, string>;
}

/** `redrive` — a paused campaign was redriven on the current base (design §2.1, §7): the wave it
 * re-entered, and how many banked greens it landed without a rerun vs skipped as already merged
 * (modes.ts). */
export interface RedriveEvent extends BaseEvent {
  event: "redrive";
  fromWave: number;
  landed?: number;
  skipped?: number;
}

/** `grace-wait` — a drained wave held its boundary open for up to `seconds`, waiting for an answer to
 * a member parked as `question`/`stalled` before declaring the campaign parked (design §5,
 * `parkGraceSeconds`). Carries the seconds and the parked members being waited on, so the fold and
 * the dashboard can narrate the pause (modes.ts, ADR 0020). */
export interface GraceWaitEvent extends BaseEvent {
  event: "grace-wait";
  seconds: number;
  tasks: string[];
}

/** `gate` — the orchestrator gate selected a set of commands to run for a task: the labels/cmds it will
 * run and how many `when`-scoped gates it skipped for the diff. Carries `taskId` when a per-task run
 * drove it (loop.ts); the wave-merge gate (merge.ts/modes.ts) has no single task and omits it. Part of
 * the shared union so the live-tail activity stream (ADR 0015) can render it (gate.ts). */
export interface GateEvent extends BaseEvent {
  event: "gate";
  taskId?: string;
  cmds: string[];
  skipped: number;
}

/** `gate-result` — one gate command finished: its cmd, exit code, wall-clock seconds, and the captured
 * output file. Carries `taskId` when a per-task run drove it (loop.ts); the wave-merge gate omits it.
 * Part of the shared union for the live-tail activity stream (ADR 0015) (gate.ts). */
export interface GateResultEvent extends BaseEvent {
  event: "gate-result";
  taskId?: string;
  cmd: string;
  exitCode: number;
  seconds: number;
  outFile: string;
}

/** `tool` — a file-operation tool-use the agent invoked, recovered by projecting the raw run stream
 * (ADR 0015): the tool `name` (Read/Edit/Write/Grep/Glob), the `path` it targeted, and `size` — the
 * byte count of content the op wrote (Write/Edit), absent for reads/searches that carry none. A
 * live-only activity-stream row, never in the archived event log (activity.ts). */
export interface ToolEvent extends BaseEvent {
  event: "tool";
  taskId: string;
  name: string;
  path?: string;
  size?: number;
}

/** `sandbox-exec` — a `Bash` tool-use the agent ran, recovered by projecting the raw run stream
 * (ADR 0015): the `cmd` it executed and, when known, the `pid`. A live-only activity-stream row
 * (activity.ts). */
export interface SandboxExecEvent extends BaseEvent {
  event: "sandbox-exec";
  taskId: string;
  cmd: string;
  pid?: number;
}

/** `commit` — one commit an agent landed on its branch: the `taskId`, the `branch`, the commit `sha`,
 * and the `files` it touched. Net-new for the live-tail activity stream (ADR 0015) — commit shas are
 * otherwise only carried in bulk on `green` (loop.ts). */
export interface CommitEvent extends BaseEvent {
  event: "commit";
  taskId: string;
  branch: string;
  sha: string;
  files: string[];
}

/** `worktree-preserved` — a parked slot left its worktree on the host: the task and the preserved
 * path, the genuine per-task identity the issue-detail sheet surfaces (loop.ts). */
export interface WorktreePreservedEvent extends BaseEvent {
  event: "worktree-preserved";
  taskId: string;
  path: string;
}

/** `telegram-unconfigured` — a `campaign` started for a project whose base location resolves no
 * Telegram connection (no `VETINARI_TELEGRAM_*` in its `host.env`): the project name and its base
 * location, so the dashboard can narrate an un-notifiable project whose parked questions won't ping
 * (modes.ts, issue #116). */
export interface TelegramUnconfiguredEvent extends BaseEvent {
  event: "telegram-unconfigured";
  project: string;
  baseLocation: string;
}

/**
 * The narrowed rows the dashboard reconstructs from — a discriminated union on `event`, exactly the
 * design §2.1 vocabulary plus `grace-wait` and the activity/diagnostic rows the live tail narrates.
 * A row whose `event` is none of these is still a valid `BaseEvent`; it simply isn't a member here,
 * so `readEventLog` returns it cast-and-trusted (see there). Kept a closed union of the known kinds so
 * a `switch (e.event)` narrows each member's fields with no `any`.
 */
export type OrchestratorEvent =
  | CampaignStartEvent
  | WaveStartEvent
  | SpawnEvent
  | TurnEvent
  | GreenEvent
  | MergedEvent
  | ParkedEvent
  | FailedEvent
  | BaseGateEvent
  | WaveDoneEvent
  | CampaignParkedEvent
  | CampaignFailedEvent
  | CampaignDoneEvent
  | PruneEvent
  | GraftEvent
  | RedriveEvent
  | GraceWaitEvent
  | GateEvent
  | GateResultEvent
  | ToolEvent
  | SandboxExecEvent
  | CommitEvent
  | WorktreePreservedEvent
  | TelegramUnconfiguredEvent;

/**
 * The one alias table (design §13.2). Every retired event/reason name appears **here and
 * nowhere else** — the reducer, the dashboard and the log views all speak the §2.1
 * vocabulary, and archived logs written in the old names are translated to it on the read
 * path by {@link normalizeLegacyEvent}. Some legacy rows fan out (a `queue-start` seeded a
 * whole wave `running`; an old `campaign-failed` carried its failures inline), so the
 * translation returns an array, not a single row.
 */
const REASON_ALIASES: Record<string, ParkReason> = {
  blocked: "question",
  budget: "stalled",
  "idle-timeout": "stalled",
  "no-commit": "stalled",
};

/** The legacy `stalled` reasons that still name their specific in `detail` (design §2.3). */
const STALLED_DETAILS = new Set(["budget", "idle-timeout", "no-commit"]);

type Row = Record<string, unknown> & { ts?: unknown; event: string };

/**
 * Translate one archived row written in the pre-§2.1 vocabulary into the current event set —
 * the sole home of every retired name (design §13.2). Current-vocabulary rows pass through
 * unchanged. The mappings:
 *
 * - `campaign-batch` → `wave-start`; `campaign-batch-done` → `wave-done`; `queue-spawn` → `spawn`.
 * - `quarantined` → `parked` with reason `conflict`; `wave-parked` → `campaign-parked`.
 * - `queue-start` → a `spawn` per task it seeded; `queue-done` → a `failed` per errored task and a
 *   `green` per completed one (parked members already carry their own `parked` row).
 * - an old `campaign-failed` (carrying `failed`/`merged` inline) → a `failed` per failed id plus the
 *   bare `campaign-failed` stop marker; `campaign-resume` → `redrive`; `campaign-done.batches` →
 *   `campaign-done.waves`.
 * - park reasons `blocked`/`budget`/`idle-timeout`/`no-commit` → `question`/`stalled` (the specific
 *   kept in `detail`).
 *
 * The state words `failed`/`completed` (and their retired forms `failure`/`closed`) are *derived*
 * by the reducer and never written to the log (design §2.1), so no archived row carries them and
 * none needs aliasing here; if a stray one ever did, this is where its translation would live.
 */
export function normalizeLegacyEvent(row: Row): OrchestratorEvent[] {
  const ts = typeof row.ts === "string" ? row.ts : "";
  const rename = (event: string, drop: string[] = []): OrchestratorEvent => {
    const out: Record<string, unknown> = { ...row, event };
    for (const k of drop) delete out[k];
    return out as unknown as OrchestratorEvent;
  };
  switch (row.event) {
    case "campaign-start": {
      // The plan field was `batches`; presentation state (`festiveOffset`) is dropped.
      const out: Record<string, unknown> = { ...row, event: "campaign-start" };
      if (!Array.isArray(out.waves) && Array.isArray(out.batches)) out.waves = out.batches;
      delete out.batches;
      delete out.festiveOffset;
      return [out as unknown as CampaignStartEvent];
    }
    case "campaign-batch":
      return [rename("wave-start", ["name", "titles"])];
    case "campaign-batch-done":
      return [rename("wave-done", ["name", "titles"])];
    case "queue-spawn":
      return [rename("spawn")];
    case "quarantined":
      return [{ ...row, event: "parked", reason: "conflict" } as unknown as ParkedEvent];
    case "wave-parked":
      return [rename("campaign-parked", ["merged"])];
    case "campaign-resume":
      return [{ ts, event: "redrive", fromWave: Number(row.fromIndex ?? 0) } as RedriveEvent];
    case "queue-start": {
      const taskIds = Array.isArray(row.taskIds) ? row.taskIds.map(String) : [];
      return taskIds.map((taskId) => ({ ts, event: "spawn", taskId }) as SpawnEvent);
    }
    case "queue-done": {
      const outcomes = row.outcomes && typeof row.outcomes === "object" ? (row.outcomes as Record<string, string>) : {};
      const out: OrchestratorEvent[] = [];
      for (const [taskId, outcome] of Object.entries(outcomes)) {
        if (String(outcome).startsWith("error")) out.push({ ts, event: "failed", taskId } as FailedEvent);
        else if (outcome === "green") out.push({ ts, event: "green", taskId, branch: "", commits: [] } as GreenEvent);
        // `parked` outcomes already carry their own `parked` row from the run loop.
      }
      return out;
    }
    case "campaign-failed": {
      // Old shape carried the failures inline; the new one is a bare stop marker with the
      // per-task failures on their own `failed` rows.
      if (Array.isArray(row.failed)) {
        const failed = row.failed.map(String);
        return [
          ...failed.map((taskId) => ({ ts, event: "failed", taskId }) as FailedEvent),
          { ts, event: "campaign-failed", detail: `${failed.join(", ")} failed` } as CampaignFailedEvent,
        ];
      }
      return [row as unknown as CampaignFailedEvent];
    }
    case "campaign-done":
      if (typeof (row as { waves?: unknown }).waves !== "number" && typeof row.batches === "number")
        return [{ ...row, event: "campaign-done", waves: row.batches } as unknown as CampaignDoneEvent];
      return [row as unknown as CampaignDoneEvent];
    case "parked": {
      const reason = typeof row.reason === "string" ? row.reason : undefined;
      if (reason && reason in REASON_ALIASES) {
        const mapped: Record<string, unknown> = { ...row, reason: REASON_ALIASES[reason] };
        if (STALLED_DETAILS.has(reason) && mapped.detail === undefined) mapped.detail = reason === "idle-timeout" ? "idle" : reason;
        return [mapped as unknown as ParkedEvent];
      }
      return [row as unknown as ParkedEvent];
    }
    default:
      return [row as unknown as OrchestratorEvent];
  }
}

/**
 * The single parse site for the event log: read the JSONL at `cfg.logFile` and return its rows
 * typed and translated to the current §2.1 vocabulary ({@link normalizeLegacyEvent}). Cast-and-trust
 * — a row is narrowed by its `event` discriminant alone, its fields are trusted rather than
 * validated, matching how the dashboard has always read this log. A line that fails `JSON.parse`, or
 * parses to something without a string `event`, is skipped rather than crashing the read or emitting
 * a junk row. A missing log file reads empty.
 */
export function readEventLog(
  cfg: Pick<ResolvedConfig, "logFile">,
): OrchestratorEvent[] {
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
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { event?: unknown }).event !== "string"
      )
        return [];
      return normalizeLegacyEvent(parsed as Row);
    });
}

/**
 * A typed builder for a well-formed `OrchestratorEvent`, so tests stop hand-rolling `any` literals:
 * pass the kind and its narrowed fields and get back the row with a `ts` filled in (override it by
 * passing `ts`). The field type is the chosen member minus the `ts`/`event` the builder supplies.
 */
export function event<K extends OrchestratorEvent["event"]>(
  kind: K,
  fields: Omit<Extract<OrchestratorEvent, { event: K }>, "ts" | "event"> & {
    ts?: string;
  },
): Extract<OrchestratorEvent, { event: K }> {
  return { ts: new Date().toISOString(), ...fields, event: kind } as Extract<
    OrchestratorEvent,
    { event: K }
  >;
}
