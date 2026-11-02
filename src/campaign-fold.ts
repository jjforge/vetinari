// The campaign fold (ADR 0005, ADR 0019): `reduceCampaign` and the lifecycle/wave/campaign folds
// over it — the domain reducer the `campaign` loop, prune, graft, merge and replan share with the
// dashboard. It imports no `dashboard-*` module but the leaf `dashboard-event-text.ts`, so the
// domain never reaches the dashboard through it (pinned by `import-cycles.test.ts`);
// `dashboard-lifecycle.ts` and `dashboard-model.ts` re-export it.
import { type ParkReason } from "./state.ts";
import { applyPrune } from "./prune.ts";
import { applyGraft, applyReplan } from "./plan.ts";
import { type OrchestratorEvent } from "./event-log.ts";
import { normalize } from "./issue-id.ts";
import { festiveOffsetFor } from "./dashboard-event-text.ts";

/**
 * The issue lifecycle — the single stored axis of the state machine (ADR 0019).
 * An issue is `unstarted` until assigned, then `running`, and ends `completed`,
 * `failed`, or (resumably) `parked`. This is the whole status enum: the old
 * render-time overlays (the conflict hold, `interrupted`) collapse into `parked` plus a
 * reason, and `pruned`/`grafted` move to the orthogonal `Membership` axis.
 */
export type IssueStatus = "completed" | "parked" | "failed" | "running" | "unstarted";

/**
 * An issue's membership in the campaign (ADR 0019) — the axis orthogonal to its
 * lifecycle: a plain `member`, a `grafted` addition still waiting to start, or a
 * `pruned` issue dropped from the plan. Render composes `(lifecycle, membership)`:
 * the dot reads the lifecycle, a badge reads the membership, with no precedence ladder.
 */
export type Membership = "member" | "grafted" | "pruned";

/** An issue's lifecycle snapshot — its FSM state and, when `parked`, the reason. */
export interface IssueLifecycle {
  state: IssueStatus;
  reason?: ParkReason;
}

/**
 * The status a chip renders — now exactly the lifecycle (ADR 0019). The render-time
 * overlays are gone: the conflict hold and `interrupted` fold into `parked`+reason, and
 * `pruned`/`grafted` live on `StatusIssue.membership`. Kept as a distinct name only
 * so the render sites read `DisplayStatus` where they mean "the lifecycle to paint".
 */
export type DisplayStatus = IssueStatus;

/**
 * A wave's status — a **fold of its issues' lifecycles** (ADR 0019), no longer a
 * render-time derivation off campaign structure. `failed` (any member failed) outranks
 * `parked` (any member held — a question or a conflict — or the wave-level `red-base`
 * hold on a red merged base, whose members stay `completed`; design §2.3), then `running`
 * (any in flight), then `completed` (all resolved), else `unstarted`. The old
 * wave-park/`interrupted` words are gone: a held wave is `parked`, its members carry
 * their own `ParkReason` and the wave carries `red-base` when that is the hold.
 */
export type WaveStatus = "completed" | "running" | "unstarted" | "parked" | "failed";

/**
 * A campaign's status — a pure fold of its waves (ADR 0019). Mirrors the wave fold's
 * precedence (`failed` > `parked` > `running`), with `completed` when every wave has
 * closed and `unstarted` when none has begun. The card fold (`cardState`) maps this to
 * the landing's `RunState`, collapsing `completed`/`unstarted` to `idle`.
 */
export type CampaignState = "failed" | "parked" | "running" | "completed" | "unstarted";

const PARK_REASONS: ReadonlySet<string> = new Set(["question", "stalled", "conflict", "red-base", "crash", "stopped", "outdated-agent"]);

/**
 * Coerce a `parked` event/record's `reason` to the one enum (design §2.3). Writers emit the
 * enum directly and archived logs are translated by the alias table before they reach the
 * reducer, so this is a validator: a recognised reason passes through, anything else defaults
 * to `question` (an answerable hold rather than a silent drop).
 */
export const parkReasonFromEvent = (reason: string | undefined): ParkReason =>
  reason && PARK_REASONS.has(reason) ? (reason as ParkReason) : "question";

/**
 * The wave fold (ADR 0019): a wave's status is a pure fold of its issues' lifecycles,
 * skipping `pruned` members (they left the plan, so they never force a wave to read
 * running/unstarted). `failed` outranks `parked` outranks `running`; a wave whose every
 * live member has `completed` is itself `completed`; an empty or all-unstarted wave is
 * `unstarted`.
 * This is what makes a wave with a red member read `failed`, never `running` (#262).
 * `opts.redBase` is the one wave-level hold: a combined-gate park on a red merged base
 * (design §2.3) whose members all merged clean (each `completed`), so nothing in the fold
 * would otherwise read `parked` — it lands at the `parked` rank, still below `failed` (#288).
 * `opts.stopped` is the other: an operator stop parked the campaign before this wave started
 * (`campaign-parked{stopped}`), so its members are still unstarted — same rank as `redBase`.
 */
export function waveState(
  issues: readonly { status: DisplayStatus; membership?: Membership }[],
  opts: { redBase?: boolean; stopped?: boolean } = {},
): WaveStatus {
  const live = issues.filter((i) => i.membership !== "pruned");
  if (!live.length) return "unstarted";
  if (live.some((i) => i.status === "failed")) return "failed";
  if (opts.redBase || opts.stopped || live.some((i) => i.status === "parked")) return "parked";
  if (live.some((i) => i.status === "running")) return "running";
  if (live.every((i) => i.status === "completed")) return "completed";
  return "unstarted";
}

/**
 * The campaign fold (ADR 0019): a pure fold of the wave states below it, same
 * precedence as the wave fold. Any `failed` wave → `failed`; any `parked` wave →
 * `parked`; any `running` wave → `running`; all `completed` → `completed`; else
 * `unstarted`. The card fold (`cardState`) collapses `completed`/`unstarted` to `idle`.
 */
export function campaignState(waves: readonly WaveStatus[]): CampaignState {
  if (!waves.length) return "unstarted";
  if (waves.some((w) => w === "failed")) return "failed";
  if (waves.some((w) => w === "parked")) return "parked";
  if (waves.some((w) => w === "running")) return "running";
  if (waves.every((w) => w === "completed")) return "completed";
  return "unstarted";
}

/**
 * The reconstructed plan of the campaign an event log describes: its waves, the
 * per-issue outcome and hover detail, which waves have closed, and which wave is
 * current (-1 when none is in flight). It is the fold both the dashboard and the
 * `campaign` loop reduce so they agree on "the plan" by construction (ADR 0005).
 */
export interface ReducedCampaign {
  waves: string[][];
  /** the original wave membership as the run was launched (or a queue run's single
   * frame), before any prune pruned it — the layout the dashboard renders so a
   * pruned issue still shows as a chip in the wave it left. `waves` is the pruned,
   * loop-facing plan; `layout` is display-facing and never loses a member. */
  layout: string[][];
  /** the issues a prune actually dropped from the plan (parked/unstarted members),
   * in log order — rendered `pruned` (ADR 0007). A superset key over `outcomes`,
   * which stays `IssueStatus`; pruned is a render overlay, not a stored status. */
  pruned: Set<string>;
  /** the issues a graft added to the running campaign that are still unstarted —
   * rendered `grafted` (ADR 0014), the additive mirror of `pruned`. A render overlay
   * derived from graft events, **transient**: an id drops out of this set the moment it
   * reaches a started outcome (`running`/`completed`/…), so it reads `grafted` only
   * while waiting in a later wave. Both live and archived runs see it. */
  grafted: Set<string>;
  /** the issues a merge conflict held out of integration (ADR 0013), folded from the
   * `parked{conflict}` events in log order and cleared once the issue re-merges. It drives
   * the lifecycle: a held issue passed its own gate (`outcomes` holds `completed`) but
   * `issueLifecycle` reads it as `parked` with reason `conflict` until it re-merges (ADR 0019). */
  conflictParked: Set<string>;
  /** the optional human name the campaign was launched with (`--name`), read off
   * the latest `campaign-start` event; undefined for an unnamed run. */
  name?: string;
  /** the festive-name offset for this campaign (#193), derived from the latest
   * `campaign-start` timestamp ({@link festiveOffsetFor}); undefined for a run with no
   * `campaign-start`. Wave `i` draws `festiveWaveName(festiveOffset, i)` when festive
   * wave names are on. */
  festiveOffset?: number;
  outcomes: Map<string, IssueStatus>;
  /** issue id → the most recent durable session id seen for it, folded from any event that
   * carries one (`turn`, `parked`). A crash redrive reads it to resume a crashed member's session
   * on its existing branch rather than re-run fresh (design §7); absent for a member that never
   * recorded a session (a non-resumable provider, or one that never completed a turn). */
  sessions: Map<string, string>;
  /** issues that went green but are not yet merged onto the base — `running` with a pending
   * green (design §2.2). Cleared when the id merges (`merged`, or a `wave-done`'s merged list).
   * The chip reads `running`; this set drives the distinct "pending merge" chip detail. */
  pendingGreen: Set<string>;
  /** parked issues whose latest lifecycle event is `answered` — an answer delivered, no re-admit
   * `spawn` yet. A display overlay, never an outcome: `outcomes` keeps them `parked` (prune and
   * the CLI read that), and {@link issueLifecycle} reads them `running` only under a live campaign. */
  answered: Set<string>;
  details: Map<string, string>;
  /** issue id → title, captured onto the run's start event at launch by the
   * orchestrator (which has `fetchTask`) so the dumb-router dashboard renders
   * names with no live lookup (ADR 0002). Empty when a run recorded no titles. */
  titles: Map<string, string>;
  /** issue id → ISO timestamp it most recently reached "completed" (a wave merge,
   * a bare green, or a queue-done green). The source the landing's merged-today
   * counter reads: an issue whose stamp falls on the current day merged today. */
  mergedAt: Map<string, string>;
  closedWaves: Set<number>;
  currentWave: number;
  /** the wave a red merged base wave-parked (ADR 0013), indexing the pruned `waves`
   * like `currentWave`/`closedWaves`; -1 when none is parked. Set from the
   * `campaign-parked` event, which lands on the in-flight wave with no `wave-done`
   * to close it, so this holds `currentWave` at the point the wave-park was logged. */
  parkedWave: number;
  /** the wave a running loop is in: `currentWave` when no `campaign-parked` has been logged
   * since the latest `wave-start`, else -1. Whether the loop is actually live is not in the
   * log — a crashed campaign reads the same — so a prune checks liveness itself (#651). */
  inFlightWave: number;
  /** how many leading `waves` have started — one past the last wave in the current (post-prune)
   * plan holding any started member, or 0 if none does. A member is started once a `wave-start`
   * names it (or its wave has one with no `tasks`, or closes). Started is wave-level: one started
   * member makes its whole wave started, slot-starved members included. Counting members on the
   * current plan, not a recorded wave position, means a prune that empties a started wave never
   * makes the next, unstarted one read as started. The prefix a `replan` keeps at its index
   * (ADR 0022); the waves after it are the unstarted remainder. A graceful stop's `parkedWave` is
   * not counted: it names the next wave, which never had a `wave-start`. */
  startedWaves: number;
  /** issue id → the structured `ParkReason` its `parked` event carried (ADR 0019),
   * folded so the lifecycle can surface *why* an issue is held. Absent for an issue
   * parked only by a surviving on-disk record (the reason is read from the record). */
  parkReasons: Map<string, ParkReason>;
  /** the members of the wave a combined-gate `campaign-parked` landed on (ADR 0019) — a red
   * merged base. It is the *wave's* reason, not the members': each member keeps its own
   * lifecycle (a merged member stays `completed`, a question stays `parked{question}`), and
   * this set is what makes the wave fold to `parked{red-base}` (design §2.3, #288). */
  redBase: Set<string>;
  /** the members of the wave a `campaign-parked{stopped}` named — an operator stop (`vetinari stop`,
   * Ctrl-C). Like `redBase` it is the wave's hold, not the members': it folds the wave to
   * `parked{stopped}` even while every member is still unstarted, and the next `wave-start` (the
   * redrive picking the wave back up) clears it. */
  stopped: Set<string>;
  /** events the fold refused to apply because they contradicted a terminal `completed` (merged)
   * state (design §2.2): a stale second process logging a `parked`/`failed`/`spawn` for an issue
   * already merged. Recorded here — the reducer's log of what it ignored — never folded, so a
   * late stale event can never flip a merged card back to parked/failed/running. */
  anomalies: string[];
  /** a real `merged` (one not marked `alreadyMerged`) comes after the last `base-gate` — or after
   * `campaign-start` when there is none: the campaign died between a merge and its base gate, so
   * the merged base was never proven and a redrive re-gates it (design §7). Derived, never stored. */
  ungatedMerge: boolean;
}

/** The display `layout` index of each loop-facing wave, in order: the layout waves still holding
 * a member no prune dropped. A wave a prune emptied stays in `layout` for its chips but is gone
 * from `waves`, so `waves[i]` is shown at `layout[liveLayoutWaves(...)[i]]`. */
const liveLayoutWaves = (layout: string[][], pruned: Set<string>): number[] =>
  layout.flatMap((wave, i) => (wave.some((id) => !pruned.has(id)) ? [i] : []));

/** The lifecycle events that settle a delivered answer — after any of them it no longer awaits re-admit. */
const ANSWER_SETTLING_EVENTS: ReadonlySet<string> = new Set(["spawn", "parked", "failed", "green", "merged"]);

/**
 * Reduce a project's event log to its current campaign's plan — pure, no I/O.
 * Only the latest `campaign-start` and everything after it is folded (a fresh
 * campaign supersedes an earlier one in the same log); the plan (the waves) comes
 * from `campaign-start`, so a log with no `campaign-start` frames no waves. This is
 * the load-bearing seam of ADR 0005: `buildStatus` renders it and the `campaign`
 * loop re-reads it each wave.
 * `opts.alive` is the injected liveness probe (design §7): `false` means the run's
 * process is gone (its host slot is not held, §8), so an in-flight `running` issue with
 * no terminal stop marker since the latest `wave-start` reconciles to parked{crash};
 * omitted/`true` never crash-folds.
 */
export function reduceCampaign(events: OrchestratorEvent[], opts: { alive?: boolean } = {}): ReducedCampaign {
  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  let waves: string[][] = [];
  let layout: string[][] = [];
  const pruned = new Set<string>();
  const grafted = new Set<string>();
  const conflictParked = new Set<string>();
  let name: string | undefined;
  let festiveOffset: number | undefined;
  const outcomes = new Map<string, IssueStatus>();
  const sessions = new Map<string, string>();
  const pendingGreen = new Set<string>();
  const answered = new Set<string>();
  const details = new Map<string, string>();
  const titles = new Map<string, string>();
  const mergedAt = new Map<string, string>();
  const closedWaves = new Set<number>();
  const parkReasons = new Map<string, ParkReason>();
  const anomalies: string[] = [];
  let redBase = new Set<string>();
  let stopped = new Set<string>();
  let currentWave = -1;
  let parkedWave = -1;
  // Whether a `campaign-parked` landed since the latest `wave-start`: `parkedWave` is only ever
  // set, so it cannot tell a parked wave from one a redrive re-entered (#651).
  let parkedSinceWaveStart = false;
  const inFlightWave = () => (currentWave >= 0 && !parkedSinceWaveStart ? currentWave : -1);
  // The members whose wave has had a `wave-start` (or closed). Started is tracked by member, not
  // by wave position: a prune that empties a wave drops it and shifts every later wave down, so a
  // recorded index would land on the next, unstarted wave. `startedCount` counts on the current plan.
  let startedMembers = new Set<string>();
  const startedCount = () => waves.findLastIndex((wave) => wave.some((id) => startedMembers.has(id))) + 1;

  for (const e of relevant) {
    // Any start event may carry an id→title map (`campaign` writes it on
    // `campaign-start`, a standalone `queue` on `queue-start`); fold them all so
    // the plan carries a name for every issue a title was resolved for.
    if ("titles" in e && e.titles && typeof e.titles === "object") {
      for (const [id, title] of Object.entries(e.titles)) {
        if (typeof title === "string" && title.trim()) titles.set(normalize(id), title.trim());
      }
    }
    // Remember the latest durable session id an event carried for a member (`turn`, `parked`),
    // so a crash redrive can resume that session on the existing branch (design §7).
    if ("sessionId" in e && e.sessionId && e.taskId) sessions.set(normalize(String(e.taskId)), String(e.sessionId));
    // An answer awaits its re-admit until the issue's next lifecycle event (the re-admit's `spawn`).
    if (ANSWER_SETTLING_EVENTS.has(e.event) && "taskId" in e && e.taskId) answered.delete(normalize(String(e.taskId)));
    if (e.event === "campaign-start" && Array.isArray(e.waves)) {
      waves = e.waves.map((wave: unknown[]) => wave.map(String).map(normalize));
      layout = waves.map((wave) => [...wave]);
      name = typeof e.name === "string" && e.name.trim() ? e.name : undefined;
      festiveOffset = festiveOffsetFor(typeof e.ts === "string" ? e.ts : undefined);
      currentWave = -1;
      startedMembers = new Set();
    } else if (e.event === "wave-start" && Number.isInteger(e.index)) {
      currentWave = e.index;
      parkedSinceWaveStart = false;
      // An older log's `wave-start` (the legacy `campaign-batch` rename) names no tasks: read the
      // wave's members off the plan as it stands here instead.
      const tasks: unknown[] = Array.isArray(e.tasks) ? e.tasks : (waves[e.index] ?? []);
      for (const id of tasks) startedMembers.add(normalize(String(id)));
      // A wave-start after an operator stop is the redrive picking the campaign back up.
      stopped = new Set();
    } else if (e.event === "spawn" && e.taskId) {
      // A task took an agent slot (design §2.1) — running until a terminal event lands. A spawn
      // promotes an `unstarted` member, a `parked` one (a re-admit, §5 step 3: the answer was
      // delivered and the child re-spawned), OR a `failed` one (a re-run by `redrive --override`)
      // back to `running`; without the parked case a re-admitted chip reads parked until its next
      // verdict, and without the failed case a re-driven member keeps its whole card reading failed.
      // A `completed` (merged) member is terminal (§2.2): a spawn for it is a stale second process,
      // ignored as an anomaly.
      const taskId = normalize(String(e.taskId));
      const prev = outcomes.get(taskId) ?? "unstarted";
      if (prev === "completed") {
        anomalies.push(`spawn for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      if (prev === "unstarted" || prev === "parked" || prev === "failed") {
        outcomes.set(taskId, "running");
        parkReasons.delete(taskId);
      }
      details.set(taskId, `Running in an agent slot (${e.running ?? "?"} active, ${e.left ?? "?"} waiting)`);
    } else if (e.event === "turn" && e.taskId) {
      details.set(normalize(String(e.taskId)), `Agent turn ${e.turn ?? "?"} finished; waiting for verification/redrive`);
    } else if (e.event === "green" && e.taskId) {
      // A green banks nothing on the base yet (design §2.2): the issue is `running` with a
      // pending green, not `completed` — the word for banked work is reserved for `merged`.
      // No `mergedAt` stamp, so it never counts toward "merged today" until it merges.
      const taskId = normalize(String(e.taskId));
      outcomes.set(taskId, "running");
      pendingGreen.add(taskId);
      details.set(taskId, e.branch ? `Green on ${e.branch} — pending merge onto the base` : "Green — pending merge onto the base");
    } else if (e.event === "re-admit" && e.taskId) {
      // A green whose merge collided is re-admitted for one retry by its own agent (design §6): it
      // holds a slot again, so it is no longer a pending green and the live tail follows it.
      const taskId = normalize(String(e.taskId));
      pendingGreen.delete(taskId);
      details.set(taskId, e.gate ? `Retrying a failed check — ${e.gate}` : `Retrying a merge conflict — ${(e.paths ?? []).join(", ")}`);
    } else if (e.event === "merged" && e.taskId) {
      // The integrator landed this green on the base (design §2.1). Completion, and the
      // resolution of any earlier conflict hold or red-base hold on the same id.
      const taskId = normalize(String(e.taskId));
      outcomes.set(taskId, "completed");
      pendingGreen.delete(taskId);
      redBase.delete(taskId);
      conflictParked.delete(taskId);
      details.set(taskId, "Merged into base");
      if (e.ts && !mergedAt.has(taskId)) mergedAt.set(taskId, String(e.ts));
    } else if (e.event === "parked" && e.taskId) {
      const taskId = normalize(String(e.taskId));
      // `completed` (merged) is terminal (design §2.2): a `parked` for an already-merged issue is
      // a stale second process, ignored as an anomaly — it must never flip a merged card to parked.
      if (outcomes.get(taskId) === "completed") {
        anomalies.push(`parked for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      const reason = parkReasonFromEvent(typeof e.reason === "string" ? e.reason : undefined);
      if (reason === "conflict") {
        // A merge conflict pulled this green from integration (design §2.3). Overlay it
        // like `pruned` — the issue's own outcome stays `completed` (it passed its gate),
        // so the set is what makes the chip read `parked{conflict}` until it re-merges.
        conflictParked.add(taskId);
        details.set(taskId, "Parked on a merge conflict — resolve the conflict");
      } else {
        outcomes.set(taskId, "parked");
        parkReasons.set(taskId, reason);
        details.set(taskId, `Parked: ${e.detail ?? reason}`);
      }
    } else if (e.event === "answered" && e.taskId) {
      const taskId = normalize(String(e.taskId));
      if (outcomes.get(taskId) === "parked") answered.add(taskId);
    } else if (e.event === "failed" && e.taskId) {
      // A member the agent could not make green (design §2.1, §5 step 5): a terminal failure
      // that holds its wave — the wave lands no `wave-done`, so it stays out of `closedWaves`
      // and folds to `failed` (failure outranks parked, ADR 0019).
      const taskId = normalize(String(e.taskId));
      // `completed` (merged) is terminal (design §2.2): a `failed` for an already-merged issue is
      // a stale second process, ignored as an anomaly rather than flipping a merged card to failed.
      if (outcomes.get(taskId) === "completed") {
        anomalies.push(`failed for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      outcomes.set(taskId, "failed");
      if (!details.has(taskId)) details.set(taskId, "Failed — the agent could not make it green");
    } else if (e.event === "campaign-parked") {
      // The campaign paused at a wave boundary (design §2.1): a red merged base, an unresolved
      // issue park (question/stalled), or a merge conflict. No `wave-done` follows to close the
      // wave, so it stays `currentWave`; record that as the parked wave. The wave's reason is
      // written on the event (§2.1 rule 2 — read it, never infer): only `red-base` is a wave-level
      // hold whose members all merged clean, so only then do we stamp `redBase` (what folds the
      // wave to parked(red-base), #288). A question/stalled/conflict park is a member's hold, so the
      // members keep their own lifecycle and the wave carries no wave-level reason. A reason-absent
      // event is a legacy/aliased wave-park (historically red-base), kept back-compatible.
      parkedWave = Number.isInteger(e.index) ? (e.index as number) : currentWave;
      parkedSinceWaveStart = true;
      redBase = e.reason === undefined || e.reason === "red-base" ? new Set(waves[parkedWave] ?? []) : new Set();
      // An operator stop is the other wave-level hold: a graceful stop names the next, unstarted
      // wave, whose members would otherwise fold to `unstarted` and the campaign to idle.
      stopped = e.reason === "stopped" ? new Set(waves[parkedWave] ?? []) : new Set();
    } else if (e.event === "wave-done" && Number.isInteger(e.index)) {
      for (const id of waves[e.index] ?? []) startedMembers.add(id);
      for (const taskId of e.merged ?? []) {
        const issueNumber = normalize(String(taskId));
        outcomes.set(issueNumber, "completed");
        pendingGreen.delete(issueNumber);
        // A clean re-merge resolves an earlier conflict hold or a red-base hold, so the chip
        // reads completed — and its stale "resolve the conflict" detail becomes the merge line.
        redBase.delete(issueNumber);
        if (conflictParked.delete(issueNumber)) details.set(issueNumber, "Merged into base");
        if (!details.has(issueNumber)) details.set(issueNumber, "Merged into base");
        if (e.ts && !mergedAt.has(issueNumber)) mergedAt.set(issueNumber, String(e.ts));
      }
      // A wave-done closes the wave only when it holds no conflict-parked member (design §7): a
      // conflict-parked green is unresolved work, so its wave stays out of `closedWaves` and a
      // redrive re-enters it (`resumeIndex` reads the first wave absent from `closedWaves`).
      if (!(waves[e.index] ?? []).some((m) => conflictParked.has(normalize(m)))) {
        closedWaves.add(e.index);
        currentWave = -1;
      }
    } else if (e.event === "prune" && Array.isArray(e.removed)) {
      // Prune the running campaign at the point the prune was issued: banked and
      // in-flight members stay, only parked/unstarted ones leave (ADR 0005).
      // Folding it in log order means `outcomes` already reflects the state the
      // prune saw, so the same rule replays deterministically. The dropped members
      // are remembered (not just removed) so the display can render them `pruned`
      // in the wave they left, while `waves` stays the pruned loop-facing plan.
      // A prune issued against a live in-flight wave carries `keepInFlight`, so it kept that
      // wave's unstarted members (#651); replay it the same way, off the in-flight wave here.
      // A manual prune carries `dropTarget`: its conflict-parked target leaves too (ADR 0005). An
      // auto-prune's or older log's unmarked event keeps it, still holding its wave (ADR 0013).
      const dropTarget = e.dropTarget === true ? normalize(String(e.target)) : undefined;
      const applied = applyPrune({ waves, outcomes, conflictParked }, e.removed.map(String), {
        keepInFlight: e.keepInFlight === true ? inFlightWave() : -1,
        dropTarget,
      });
      for (const id of applied.dropped) {
        // A dropped conflict-parked or failed target reads as a pruned member that never started:
        // its pending green is gone, so a redrive neither re-integrates nor crash-folds it, and its
        // conflict or failure no longer holds the wave.
        if (id === dropTarget && (conflictParked.delete(id) || outcomes.get(id) === "failed")) {
          pendingGreen.delete(id);
          outcomes.delete(id);
        }
        pruned.add(id);
        answered.delete(id);
        // A pruned member is out of the plan; if it is grafted back, its new wave has had no
        // `wave-start`, so it must not count as started there (#635).
        startedMembers.delete(id);
        details.set(id, "Pruned out of the campaign");
      }
      waves = applied.remaining;
    } else if (e.event === "graft" && Array.isArray(e.ids)) {
      // Extend the running campaign at the point the graft was issued: the in-flight
      // and banked waves are pinned, the added issues stable-insert into later waves
      // (ADR 0014). Folding in log order means `outcomes`/`currentWave` reflect the
      // state the graft saw, so the same placement replays deterministically. Mirror
      // the pruned `waves` change into the display `layout` so a grafted issue shows
      // as a chip in the wave it joined, and mark it `grafted` while it stays unstarted.
      // The persisted `fileKeys` wire field maps into the pure fold's `fileKeys`; a log
      // written before the rename carried the same value under `basenames`, read as a fallback.
      // The `fileOverlap: "allow"` marker (ADR 0025) passes through, so an allow-mode graft
      // replays by dependencies alone; an unmarked one replays file-disjointly, as it always has.
      const applied = applyGraft(
        { waves, outcomes, currentWave },
        {
          ids: e.ids.map(String),
          blockedBy: e.blockedBy ?? {},
          fileKeys: e.fileKeys ?? e.basenames ?? {},
          ...(e.fileOverlap === "allow" && { fileOverlap: "allow" as const }),
        },
      );
      const placeOf = new Map<string, number>();
      applied.remaining.forEach((wave, i) => wave.forEach((id) => placeOf.set(id, i)));
      // A graft of an id a prune dropped brings it back unstarted (#662): its prune mark and its
      // leftover `parked` outcome leave, and its chip moves out of the display wave it left
      // (dropping that wave if it empties) — before `survivors`, so the old wave is not counted live.
      const regrafted = new Set(applied.grafted.filter((id) => pruned.delete(id)));
      for (const id of regrafted) outcomes.delete(id);
      if (regrafted.size) {
        layout = layout.flatMap((wave) => {
          const kept = wave.filter((id) => !regrafted.has(id));
          return kept.length || kept.length === wave.length ? [kept] : [];
        });
      }
      const survivors = liveLayoutWaves(layout, pruned);
      const layoutOf = new Map<number, number>();
      survivors.forEach((layoutIndex, prunedIndex) => layoutOf.set(prunedIndex, layoutIndex));
      for (const id of applied.grafted) {
        grafted.add(id);
        details.set(id, "Grafted into the campaign");
        const pruned = placeOf.get(id)!;
        let target = layoutOf.get(pruned);
        if (target === undefined) {
          target = layout.push([]) - 1;
          layoutOf.set(pruned, target);
        }
        layout[target].push(id);
      }
      waves = applied.remaining;
    } else if (e.event === "replan" && Array.isArray(e.waves)) {
      // Re-plan the unstarted remainder at the point the replan was issued (ADR 0022): every
      // started wave keeps its index, the tail is replaced by the event's waves (the result,
      // not the inputs, so a replay after a planner change still gives the plan the run ran).
      // The display `layout` keeps the display waves the started prefix occupies and follows
      // the new tail past it; a pruned member of a replaced display wave moves to one trailing
      // display-only wave, so the dashboard never loses a member (ADR 0007).
      const started = startedCount();
      const replanned = applyReplan(
        { waves, started },
        e.waves.map((wave: unknown[]) => wave.map(String)),
      );
      const survivors = liveLayoutWaves(layout, pruned);
      const layoutStarted = started ? (survivors[started - 1] ?? layout.length - 1) + 1 : 0;
      const prunedOut = layout
        .slice(layoutStarted)
        .flat()
        .filter((id) => pruned.has(id));
      layout = [
        ...layout.slice(0, layoutStarted),
        ...replanned.slice(started).map((wave) => [...wave]),
        ...(prunedOut.length ? [prunedOut] : []),
      ];
      waves = replanned;
      // A graceful stop names the next, unstarted wave — which the replan just rewrote.
      if (stopped.size) stopped = new Set(waves[parkedWave] ?? []);
    }
  }
  // `grafted` is transient (ADR 0014): an id reads `grafted` only while unstarted, and
  // becomes `running` on pickup — so drop any grafted id that has since reached an outcome.
  for (const id of [...grafted]) if (outcomes.has(id)) grafted.delete(id);

  // Crash reconciliation (design §2.3, §7): liveness comes from the host-slot lease — a
  // run holds a slot while alive (§8). When the injected probe says the run is dead
  // (`alive === false`) and its log carries NO `campaign-*` stop marker since the latest
  // `wave-start`, every issue still `running` (its last event non-terminal) died with no
  // verdict, so it reconciles to parked{crash} — never left reading running forever (§15). A
  // crash is the ABSENCE of a stop marker, so any of the three
  // (`campaign-done`/`campaign-parked`/`campaign-failed`) means a clean stop and no
  // crash-fold. Only a marker since the latest `wave-start` counts: every pickup (a redrive
  // included, which writes no fresh `campaign-start`) writes `wave-start` before it spawns,
  // so an earlier marker belongs to a finished stop, not the run that died. Crash is never
  // stored: the probe is an injected input, so the reducer stays pure. A live or unknown run
  // (`alive !== false`) leaves `running` untouched.
  const stopMarkers: ReadonlySet<string> = new Set(["campaign-done", "campaign-parked", "campaign-failed"]);
  const sinceLatestWave = relevant.slice(
    Math.max(
      0,
      relevant.findLastIndex((e) => e.event === "wave-start"),
    ),
  );
  if (opts.alive === false && !sinceLatestWave.some((e) => stopMarkers.has(e.event))) {
    for (const [id, status] of outcomes) {
      // A pending green reads `running` (design §2.2) but reached a green verdict — it is
      // banked-but-unmerged work a redrive lands, not a verdict-less in-flight crash — so it is
      // never crash-folded. Only a genuinely in-flight `running` member (no verdict) reconciles.
      if (status !== "running" || pendingGreen.has(id)) continue;
      outcomes.set(id, "parked");
      parkReasons.set(id, "crash");
      details.set(id, "Crashed — the run died with no verdict; redrive");
    }
  }

  // A redrive's re-log of an already-merged green made no merge, so only a real `merged` counts.
  const lastBaseGate = relevant.findLastIndex((e) => e.event === "base-gate");
  const ungatedMerge = relevant.slice(lastBaseGate + 1).some((e) => e.event === "merged" && !e.alreadyMerged);

  return {
    waves,
    layout,
    pruned,
    grafted,
    conflictParked,
    name,
    festiveOffset,
    outcomes,
    sessions,
    pendingGreen,
    answered,
    details,
    titles,
    mergedAt,
    closedWaves,
    currentWave,
    parkedWave,
    inFlightWave: inFlightWave(),
    startedWaves: startedCount(),
    parkReasons,
    redBase,
    stopped,
    anomalies,
    ungatedMerge,
  };
}

/**
 * The issue lifecycle FSM read off a reduced campaign (ADR 0019): the single stored
 * axis, `{state, reason?}`. The transitions the event fold recorded resolve here —
 * a conflict-parked merge conflict overrides the issue's own green outcome to `parked`
 * with reason `conflict`; a `parked` outcome carries its folded `ParkReason` (defaulting
 * to `question`) — including a dead run's in-flight `running` issue, which the reducer
 * has already reconciled to `parked{crash}` off its injected liveness probe (design §7,
 * §15). A `red-base` wave-park is the *wave's* reason, never a member's (design §2.3): it
 * does not appear here, so a member holds its own reason (a merged member stays
 * `completed`, a question stays `parked{question}` with its reply box). Membership is the
 * orthogonal axis (`issueMembership`) and never appears here.
 *
 * `opts.alive === true` (the project holds a live campaign lease) applies the one display overlay:
 * an answered park ({@link answeredAwaitingReadmit}) reads `running` — the live campaign owns its
 * re-admit, so it is no longer held on a human. With no live campaign it stays `parked`.
 */
export function issueLifecycle(r: ReducedCampaign, id: string, opts: { alive?: boolean } = {}): IssueLifecycle {
  const base = r.outcomes.get(id) ?? "unstarted";
  if (base === "failed") return { state: "failed" };
  if (r.conflictParked.has(id)) return { state: "parked", reason: "conflict" };
  if (base === "parked" && answeredAwaitingReadmit(r, id, opts.alive)) return { state: "running" };
  if (base === "parked") return { state: "parked", reason: r.parkReasons.get(id) ?? "question" };
  return { state: base };
}

/** Is `id` an answered park a live campaign will re-admit — shown `running` in the `answered`
 * phase and left out of the parked panel? Only under a live lease (`alive === true`). */
export const answeredAwaitingReadmit = (r: ReducedCampaign, id: string, alive: boolean | undefined): boolean =>
  alive === true && r.answered.has(id);

/**
 * Is a campaign currently running over this event log? True iff the latest
 * `campaign-start` has no `campaign-done` after it — the condition the no-plan
 * `prune <issue>` needs before it can prune (ADR 0005). A queue-only run with no
 * campaign frame is not a campaign and returns false.
 */
export function campaignRunning(events: OrchestratorEvent[]): boolean {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  if (start < 0) return false;
  return !events.slice(start).some((e) => e.event === "campaign-done");
}

/**
 * Has a campaign ever been launched over this log? True iff any `campaign-start`
 * with a non-empty `waves` plan is present — the "is there a campaign to adjust at all?" guard
 * prune and graft check before `campaignSettled`, so an empty (or campaign-less)
 * log refuses with "nothing to adjust" rather than proceeding into an empty plan.
 * Unlike `campaignRunning` it ignores `campaign-done`: a settled campaign has still
 * been launched, and its "already settled" refusal is `campaignSettled`'s to give.
 */
export function campaignStarted(events: OrchestratorEvent[]): boolean {
  return events.some((e) => e.event === "campaign-start" && Array.isArray(e.waves));
}

/**
 * Is the latest campaign *settled* — every member merged, nothing left to adjust?
 * The single definition prune and graft share (ADR 0019): a campaign is settled
 * exactly when its fold is `completed` — every wave closed, every live member
 * `completed`. `reduceCampaign` is the source; no new state is stored. This is the
 * fold, not the `campaign-done` marker: a run that ended incomplete (parked, failed,
 * or crashed with no `campaign-done`) is *unsettled* and stays adjustable, and a run
 * whose every member merged is settled even if its process died before it logged
 * `campaign-done` (design §5, §15). A log with no campaign folds to no waves, which is
 * not `completed`, so an empty or campaign-less log is never settled — callers that
 * must refuse "nothing to adjust" guard the missing campaign separately.
 */
export function campaignSettled(events: OrchestratorEvent[]): boolean {
  const reduced = reduceCampaign(events);
  if (!reduced.waves.length) return false;
  const waveStates = reduced.waves.map((wave) =>
    waveState(
      wave.map((id) => ({ status: issueLifecycle(reduced, id).state })),
      { redBase: wave.some((id) => reduced.redBase.has(id)), stopped: wave.some((id) => reduced.stopped.has(id)) },
    ),
  );
  return campaignState(waveStates) === "completed";
}
