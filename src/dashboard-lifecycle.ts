import { type ParkReason } from "./state.ts";
import { type OrchestratorEvent } from "./event-log.ts";
import { normalize } from "./issue-id.ts";
import { type DisplayStatus, type Membership, type ReducedCampaign, issueLifecycle, reduceCampaign } from "./campaign-fold.ts";
// The campaign fold moved to `campaign-fold.ts` (a domain module, so prune/graft/merge reach it
// without a cycle through the dashboard); re-exported by name so every importer compiles unchanged.
export {
  type IssueStatus,
  type DisplayStatus,
  type Membership,
  type IssueLifecycle,
  type WaveStatus,
  type CampaignState,
  type ReducedCampaign,
  parkReasonFromEvent,
  reduceCampaign,
  issueLifecycle,
  answeredAwaitingReadmit,
  waveState,
  campaignState,
  campaignRunning,
  campaignStarted,
  campaignSettled,
} from "./campaign-fold.ts";

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
const ANSWERED: IssuePhase = { label: "answered", steady: true };
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
 * - `answered` → `answered` (an answer delivered to a park, waiting for the live campaign's
 *   re-admit — a wait, so a steady dot); the re-admit's `spawn` replaces it with `starting`.
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
    } else if (kind === "answered") {
      phase = ANSWERED;
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
 * `opts.alive` is the live-lease probe {@link issueLifecycle} reads for its answered overlay — only
 * that; it never crash-folds here.
 */
export function reconstructIssueDetail(events: OrchestratorEvent[], issueNumber: string, opts: { alive?: boolean } = {}): IssueDetail {
  const id = normalize(issueNumber);
  const reduced = reduceCampaign(events);
  const { titles, name } = reduced;
  const life = issueLifecycle(reduced, id, opts);
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
