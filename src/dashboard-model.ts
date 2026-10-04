import { existsSync } from "node:fs";
import { ownerRepoFromRemote, repoForProject } from "./config.ts";
// Re-exported so `status.ts`'s `export *` and `dashboard-route-page.ts` keep
// reaching them here; the definitions moved to config.ts once the registry and CLI
// came to depend on this project-identity edge (an odd fit under dashboard-model).
export { ownerRepoFromRemote, repoForProject };
import { hostLogger, type Logger } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { type ParkReason } from "./state.ts";
import { projectHasLiveCampaign } from "./host-slots.ts";
import { readEventLog, type OrchestratorEvent } from "./event-log.ts";
import { humanizeLogLine, localTime, type HumanizedRow } from "./log-view.ts";
import { describeEvent, festiveFor, formatFeedEvent, lastEventText, titlesFromLog } from "./dashboard-event-text.ts";
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
import { campaignState, reduceCampaign } from "./dashboard-lifecycle.ts";
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
import {
  type ArchivedRunState,
  archivedRunState,
  lastEventStamp,
  listArchivedRuns,
  runTokenFor,
  summarizeRun,
} from "./dashboard-archived-runs.ts";
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
import { type CampaignStatus, buildStatus, statusConfigFromPointer } from "./dashboard-status.ts";
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
