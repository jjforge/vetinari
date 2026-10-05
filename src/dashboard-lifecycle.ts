import { type ParkReason } from "./state.ts";
import { applyPrune } from "./prune.ts";
import { applyGraft } from "./plan.ts";
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
  details: Map<string, string>;
  /** issue id → title, captured onto the run's start event at launch by the
   * orchestrator (which has `fetchTask`) so the dumb-router dashboard renders
   * names with no live lookup (ADR 0002). Empty when a run recorded no titles. */
  titles: Map<string, string>;
  /** issue id → ISO timestamp it most recently reached "completed" (a batch merge,
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
}

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
    if (e.event === "campaign-start" && Array.isArray(e.waves)) {
      waves = e.waves.map((wave: unknown[]) => wave.map(String).map(normalize));
      layout = waves.map((wave) => [...wave]);
      name = typeof e.name === "string" && e.name.trim() ? e.name : undefined;
      festiveOffset = festiveOffsetFor(typeof e.ts === "string" ? e.ts : undefined);
      currentWave = -1;
    } else if (e.event === "wave-start" && Number.isInteger(e.index)) {
      currentWave = e.index;
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
      redBase = e.reason === undefined || e.reason === "red-base" ? new Set(waves[parkedWave] ?? []) : new Set();
      // An operator stop is the other wave-level hold: a graceful stop names the next, unstarted
      // wave, whose members would otherwise fold to `unstarted` and the campaign to idle.
      stopped = e.reason === "stopped" ? new Set(waves[parkedWave] ?? []) : new Set();
    } else if (e.event === "wave-done" && Number.isInteger(e.index)) {
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
      const applied = applyPrune({ waves, outcomes }, e.removed.map(String));
      for (const id of applied.dropped) {
        pruned.add(id);
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
      const applied = applyGraft(
        { waves, outcomes, currentWave },
        { ids: e.ids.map(String), blockedBy: e.blockedBy ?? {}, fileKeys: e.fileKeys ?? e.basenames ?? {} },
      );
      const placeOf = new Map<string, number>();
      applied.remaining.forEach((wave, i) => wave.forEach((id) => placeOf.set(id, i)));
      const survivors: number[] = [];
      layout.forEach((wave, i) => {
        if (wave.some((id) => !pruned.has(id))) survivors.push(i);
      });
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
    details,
    titles,
    mergedAt,
    closedWaves,
    currentWave,
    parkedWave,
    parkReasons,
    redBase,
    stopped,
    anomalies,
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
 */
export function issueLifecycle(r: ReducedCampaign, id: string): IssueLifecycle {
  const base = r.outcomes.get(id) ?? "unstarted";
  if (base === "failed") return { state: "failed" };
  if (r.conflictParked.has(id)) return { state: "parked", reason: "conflict" };
  if (base === "parked") return { state: "parked", reason: r.parkReasons.get(id) ?? "question" };
  return { state: base };
}

/**
 * An issue's membership axis (ADR 0019): `pruned` (dropped from the plan), `grafted`
 * (an addition still waiting to start — the reducer already scopes the set to
 * still-unstarted ids), else a plain `member`. Orthogonal to the lifecycle, so the
 * two compose at render with no precedence ladder.
 */
export function issueMembership(r: ReducedCampaign, id: string): Membership {
  if (r.pruned.has(id)) return "pruned";
  if (r.grafted.has(id)) return "grafted";
  return "member";
}

/**
 * An issue's **phase** (design §11): the step a `running` issue is currently in, a sub-axis of
 * `running` and never a sixth state — the five words and the `failed > parked > running >
 * completed` roll-up are untouched. It exists because one word ("running") collapses every
 * distinct thing a running issue can be doing, so an operator cannot tell an agent mid-gate
 * from a green that finished minutes ago and is waiting for its wave to integrate.
 *
 * `label` is the word shown in place of `running` on the row and the issue sheet; `steady`
 * says the dot should hold still rather than pulse. Appendix A defines the running dot's pulse
 * as "while work is in flight", so a phase where nothing is executing (`waiting to merge`)
 * reads steady, making that sentence true rather than adding a colour channel.
 */
export interface IssuePhase {
  label: string;
  steady: boolean;
}

const STARTING: IssuePhase = { label: "starting", steady: false };
const CODING: IssuePhase = { label: "coding", steady: false };
const FILING: IssuePhase = { label: "filing findings", steady: false };
const WAITING_TO_MERGE: IssuePhase = { label: "waiting to merge", steady: true };
const testingPhase = (cmd: string | undefined): IssuePhase => ({ label: cmd ? `testing · ${cmd}` : "testing", steady: false });

/** The `taskId` a phase-relevant event names, normalized — or undefined when it carries none
 * (the wave-merge gate, which has no single task, so its gate rows never touch a member). */
const eventTaskId = (e: OrchestratorEvent): string | undefined => {
  const raw = (e as { taskId?: unknown }).taskId;
  return raw != null && String(raw) !== "" ? normalize(String(raw)) : undefined;
};

/**
 * The phase of a `running` issue, derived from its latest own event in the current campaign —
 * a pure reducer, per ADR 0012 (design §2.1 forbids writing presentation state to the log, so
 * nothing is stored). Scoped to the latest `campaign-start` like {@link reduceCampaign}, so a
 * superseded earlier run for the same issue never leaks in. Returns undefined once the issue
 * reaches a terminal event (`merged`/`parked`/`failed`) — phase is `running`-only, so a caller
 * shows the status word instead; and undefined for an issue with no phase-relevant event yet.
 *
 * The mapping (each derived from the issue's latest own event):
 * - `spawn` → `starting` (a slot taken, the container spinning up).
 * - `sandbox`/`turn` → `coding` (the agent is working; the gate has not opened).
 * - `gate` → `testing · <cmd>`, naming the command now running, and each passing `gate-result`
 *   advances it to the next command (#332). A red `gate-result`, or a gate that fully passed,
 *   returns to `coding` (the agent resumes, or a green is imminent).
 * - `findings` → `filing findings` while the post-green harvest files each finding, reverting to
 *   `waiting to merge` once all are filed (so a long wait for the wave never reads as filing).
 * - `green` → `waiting to merge` (a pending green: banked-but-unmerged, its slot already freed,
 *   nothing executing — a steady dot).
 */
export function issuePhase(events: OrchestratorEvent[], issueNumber: string): IssuePhase | undefined {
  const id = normalize(issueNumber);
  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  let phase: IssuePhase | undefined;
  let gateCmds: string[] = [];
  let gatePassed = 0;
  let filingLeft = 0;
  for (const e of relevant) {
    if (eventTaskId(e) !== id) continue;
    // `sandbox`/`findings`/`finding-filed` round-trip as base rows (event-log.ts), so this reads
    // the kind as a plain string and pulls their fields structurally rather than off the union.
    const kind: string = e.event;
    if (kind === "spawn") {
      phase = STARTING;
      gateCmds = [];
    } else if (kind === "sandbox" || kind === "turn") {
      phase = CODING;
      gateCmds = [];
    } else if (kind === "gate") {
      const cmds = (e as { cmds?: unknown[] }).cmds;
      gateCmds = Array.isArray(cmds) ? cmds.map(String) : [];
      gatePassed = 0;
      phase = testingPhase(gateCmds[0]);
    } else if (kind === "gate-result") {
      // A red command stops the gate early (the agent resumes to fix it); a passing one advances
      // to the next, and a gate that has fully passed is back in the agent's hands.
      if ((e as { exitCode?: unknown }).exitCode !== 0) phase = CODING;
      else {
        gatePassed++;
        phase = gatePassed < gateCmds.length ? testingPhase(gateCmds[gatePassed]) : CODING;
      }
    } else if (kind === "green") {
      phase = WAITING_TO_MERGE;
    } else if (kind === "findings") {
      // The harvest runs after the green; it files `count` findings, then teardown → merge.
      filingLeft = Number((e as { count?: unknown }).count ?? 0);
      phase = filingLeft > 0 ? FILING : WAITING_TO_MERGE;
    } else if (kind === "finding-filed") {
      filingLeft = Math.max(0, filingLeft - 1);
      phase = filingLeft > 0 ? FILING : WAITING_TO_MERGE;
    } else if (kind === "merged" || kind === "parked" || kind === "failed") {
      // A terminal event clears the phase (no running step). If a re-admit spawn follows (an
      // answered park re-entering, §5 step 3), a later iteration re-establishes it; a truly
      // terminal issue is not running, so the caller shows its state word, not this.
      phase = undefined;
      gateCmds = [];
    }
  }
  return phase;
}

/** One entry in an issue's turn log (ADR 0009): the turn's number as logged
 * (0-indexed; the display adds one), the agent's own one-sentence account of that
 * turn verbatim, and the ISO timestamp it was logged. */
export interface IssueTurn {
  turn: number;
  summary: string;
  ts: string;
}

/**
 * The issue-detail sheet's reconstructed data (story: issue detail sheet): the
 * issue's status and title, its run's campaign name (the header's "repo · campaign"),
 * how many turns the agent took and how long it worked, and the turn log itself —
 * one agent-authored sentence per turn, newest first (ADR 0009). The turn log is
 * the sheet's reason to exist.
 */
export interface IssueDetail {
  issueNumber: string;
  /** the issue's lifecycle state — the dot/word the sheet paints (ADR 0019). */
  status: DisplayStatus;
  /** why it is `parked`, when it is (ADR 0019) — selects the sheet's recovery affordance. */
  reason?: ParkReason;
  /** the orthogonal membership axis — the badge the sheet carries (ADR 0019); absent
   * reads as a plain `member`. */
  membership?: Membership;
  /** the step this issue is in when `running` (design §11, {@link issuePhase}) — the word the
   * sheet shows in place of `running`, and whether its dot holds steady. Absent for every other
   * lifecycle; the client suppresses it on a read-only archived sheet. */
  phase?: IssuePhase;
  title?: string;
  campaignName?: string;
  turns: number;
  /** the working span in ms: the last event that names this issue minus the first,
   * from the event timestamps. Zero when a single event names it, since a span
   * needs two points; the plan-only `campaign-start` never counts as the start. */
  elapsedMs: number;
  turnLog: IssueTurn[];
  /** the agent's preserved worktree path, from the `worktree-preserved` event the
   * loop logs when it parks a slot — the real per-task identity (ADR/#55 dropped
   * the anonymous-pool agent id, so this is a path, never a fabricated `agent-N`).
   * Undefined when no such event names the issue (e.g. an in-flight or merged run). */
  worktree?: string;
}

/** Does this event name the given issue by an id it carries — its `taskId`, or a
 * membership in one of the id-bearing arrays/maps (`taskIds`, `merged`, `removed`,
 * `queue-done` outcomes)? The plan-only `campaign-start` `batches` are excluded so
 * the working span starts when work does, not at campaign launch. */
const eventNamesIssue = (e: OrchestratorEvent, id: string): boolean => {
  if ("taskId" in e && e.taskId != null && normalize(String(e.taskId)) === id) return true;
  const inArray = (a: unknown) => Array.isArray(a) && a.map(String).map(normalize).includes(id);
  if (("taskIds" in e && inArray(e.taskIds)) || ("merged" in e && inArray(e.merged)) || ("removed" in e && inArray(e.removed))) return true;
  if ("outcomes" in e && e.outcomes && typeof e.outcomes === "object" && Object.keys(e.outcomes).map(normalize).includes(id)) return true;
  return false;
};

/**
 * Reconstruct one issue's detail sheet from an event log — pure, no I/O. Status
 * and title come from the same `reduceCampaign` fold the campaign view renders, so
 * the sheet can never disagree with the chip that opened it; the turn log, count
 * and elapsed span are folded from the events themselves. Only the latest campaign
 * (from its `campaign-start`) is considered, mirroring `reduceCampaign`, so an
 * issue re-run in a fresh campaign shows that run's turns — a queue-only log with
 * no campaign frame is folded whole.
 */
export function reconstructIssueDetail(events: OrchestratorEvent[], issueNumber: string): IssueDetail {
  const id = normalize(issueNumber);
  const reduced = reduceCampaign(events);
  const { titles, name } = reduced;
  const life = issueLifecycle(reduced, id);
  const membership = issueMembership(reduced, id);

  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  const turnLog: IssueTurn[] = [];
  const stamps: number[] = [];
  let worktree: string | undefined;
  for (const e of relevant) {
    if (!eventNamesIssue(e, id)) continue;
    if (typeof e.ts === "string") stamps.push(Date.parse(e.ts));
    if (e.event === "turn") turnLog.push({ turn: Number(e.turn ?? 0), summary: String(e.summary ?? "").trim(), ts: String(e.ts ?? "") });
    // The last preserved worktree wins — a re-park logs a fresh path over a stale one.
    if (e.event === "worktree-preserved" && typeof e.path === "string" && e.path) worktree = e.path;
  }
  const elapsedMs = stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0;
  // A running issue carries its phase (design §11, #359); the client suppresses it on a
  // read-only archived sheet (an archived run renders no phases).
  const phase = life.state === "running" ? issuePhase(events, id) : undefined;

  return {
    issueNumber: id,
    status: life.state,
    ...(life.reason ? { reason: life.reason } : {}),
    membership,
    ...(phase ? { phase } : {}),
    title: titles.get(id),
    campaignName: name,
    turns: turnLog.length,
    elapsedMs,
    turnLog: turnLog.reverse(),
    ...(worktree ? { worktree } : {}),
  };
}

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
 * with wave batches is present — the "is there a campaign to adjust at all?" guard
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
