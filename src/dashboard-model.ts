// A permanent re-export barrel: the dashboard data model is defined across six modules —
// `dashboard-event-text.ts`, `dashboard-lifecycle.ts`, `dashboard-archived-runs.ts`,
// `dashboard-status.ts`, `dashboard-live-tail.ts` and `dashboard-landing.ts` — and re-exported
// here by name, so every importer (and `status.ts`'s `export *`) compiles unchanged.
import { ownerRepoFromRemote, repoForProject } from "./config.ts";
// Re-exported so `status.ts`'s `export *` and `dashboard-route-page.ts` keep
// reaching them here; the definitions moved to config.ts once the registry and CLI
// came to depend on this project-identity edge (an odd fit under dashboard-model).
export { ownerRepoFromRemote, repoForProject };
import { type ParkReason } from "./state.ts";
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
// Re-exported by name (not `export *`) so every importer of the archived-run listing through
// this module or `status.ts`'s `export *` compiles unchanged now it lives in
// `dashboard-archived-runs.ts`; `runTokenFor`/`lastEventStamp` stay out of the barrel.
export {
  type ArchivedRunState,
  archivedRunState,
  type ArchivedRun,
  listArchivedRuns,
  summarizeRun,
  parseRunTimestamp,
} from "./dashboard-archived-runs.ts";
// Re-exported by name (not `export *`) so every importer of the status assembly through this
// module or `status.ts`'s `export *` compiles unchanged now it lives in `dashboard-status.ts`.
export {
  type StatusIssue,
  type StatusWave,
  type ParkedIssue,
  type CampaignStatus,
  buildStatus,
  buildStatusWithIssueNames,
  buildAllStatus,
  selectStatus,
  logFileOf,
  archiveStatusConfig,
  statusConfigFromPointer,
  baseBranchForProject,
  stopPending,
} from "./dashboard-status.ts";
// Re-exported by name (not `export *`) so every importer of the live tail or the live-update
// event helpers through this module or `status.ts`'s `export *` compiles unchanged now they live
// in `dashboard-live-tail.ts`.
export {
  type TailLine,
  type TailAgent,
  type LiveTail,
  TAIL_SNAPSHOT_CAP,
  inFlightRunning,
  buildLiveTail,
  appendedEvents,
  SSE_NOISE_EVENTS,
  viewRelevantEvents,
} from "./dashboard-live-tail.ts";

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
// Re-exported by name (not `export *`) so every importer of the landing or the feed through this
// module or `status.ts`'s `export *` compiles unchanged now they live in `dashboard-landing.ts`.
export {
  type FeedEntry,
  buildFeed,
  type RunState,
  type ProjectCard,
  type LandingCounters,
  type ParkedQuestion,
  type LandingView,
  cardState,
  buildLanding,
} from "./dashboard-landing.ts";
