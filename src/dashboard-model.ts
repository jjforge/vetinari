import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord } from "./state.ts";
import { applyCarve } from "./carve.ts";

export type IssueStatus = "completed" | "parked" | "failure" | "running" | "unstarted";

/**
 * A chip's status as the dashboard renders it: the orchestrator's own `IssueStatus`
 * plus `carved`, the one state derived at render (from carve events) rather than
 * carried as an enum value — the agent loop and `IssueStatus` stay untouched (ADR
 * 0007). Only the view layer knows `carved`; `reduceCampaign`'s `outcomes` stay
 * `IssueStatus`.
 */
export type DisplayStatus = IssueStatus | "carved";

export interface StatusIssue {
  issueNumber: string;
  status: DisplayStatus;
  name?: string;
  detail?: string;
}

export type WaveStatus = "closed" | "running" | "unstarted";

export interface StatusWave {
  index: number;
  status: WaveStatus;
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
  waves: StatusWave[];
  parked: ParkedIssue[];
}

const statusForOutcome = (outcome: string | undefined): IssueStatus => {
  if (outcome === "green") return "completed";
  if (outcome === "parked") return "parked";
  if (outcome?.startsWith("error")) return "failure";
  return "unstarted";
};

export const readEvents = (cfg: Pick<ResolvedConfig, "logFile">): any[] => {
  if (!existsSync(cfg.logFile)) return [];
  return readFileSync(cfg.logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};

const normalizeIssue = (id: string) => id.replace(/^#/, "");

const hash = (id: unknown) => `#${normalizeIssue(String(id))}`;

/**
 * Narrate one event log entry as the single plain-words line the landing card
 * shows for "the last event". A `turn` renders its agent-authored summary verbatim
 * (ADR 0009) — the whole reason that field exists — falling back to a mechanical
 * line only when a pre-summary run has none. Events with no operator-facing
 * narration return "" so `lastEventText` can skip past machine noise.
 */
export function describeEvent(e: any): string {
  switch (e?.event) {
    case "campaign-start":
      return e.name ? `Campaign “${e.name}” started` : "Campaign started";
    case "campaign-batch":
      return `Wave ${(e.index ?? 0) + 1} started`;
    case "campaign-batch-done":
      return `Wave ${(e.index ?? 0) + 1} merged ${(e.merged ?? []).length ? (e.merged as unknown[]).map(hash).join(", ") : "nothing"}`;
    case "campaign-done":
      return "Campaign complete";
    case "campaign-halt":
      return `Campaign halted: ${e.reason ?? "failure"}`;
    case "queue-start":
      return "Queue started";
    case "queue-done":
      return "Queue drained";
    case "green":
      return `${hash(e.taskId)} merged`;
    case "parked":
      return `${hash(e.taskId)} parked${e.reason ? `: ${e.reason}` : ""}`;
    case "carve":
      return `Carved ${(e.removed ?? []).map(hash).join(", ")}`;
    case "turn":
      return e.summary?.trim() ? String(e.summary).trim() : `${hash(e.taskId)} — turn ${e.turn ?? "?"}`;
    default:
      return "";
  }
}

/**
 * One event as a single repo-prefixed sentence for the cross-project feed:
 * `describeEvent`'s plain-words line with the project name in front. Pure — an
 * event `describeEvent` can't narrate (machine noise) returns "" so `buildFeed`
 * can skip past it, exactly as `lastEventText` does.
 */
export function formatFeedEvent(project: string, e: any): string {
  const sentence = describeEvent(e);
  return sentence ? `${project} — ${sentence}` : "";
}

/**
 * The most recent operator-facing event in a log, in plain words — the landing
 * card's "last event" line. Scans newest-first and returns the first entry
 * `describeEvent` can narrate, so machine noise (gate/sandbox/queue-spawn) that
 * lands after a meaningful event never becomes the headline. Empty logs read
 * "No activity yet".
 */
export function lastEventText(events: any[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const text = describeEvent(events[i]);
    if (text) return text;
  }
  return "No activity yet";
}

// Issue titles rarely change during a campaign, so we cache them for the process
// lifetime; a rename won't surface until the status server restarts.
const issueNameCache = new Map<string, string | undefined>();

export const issueNameFromTask = (task: string): string | undefined => {
  try {
    const parsed = JSON.parse(task);
    return typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined;
  } catch {
    return undefined;
  }
};

export function extractParkedDetails(question: string): { description: string; options: string[] } {
  const match = question.match(/(?:^|\n)\s*options?\s*:\s*\n([\s\S]*)/i);
  if (!match) return { description: question.trim(), options: [] };

  const description = question.slice(0, match.index).trim();
  const optionLines: string[] = [];
  for (const raw of match[1].split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (optionLines.length) break;
      continue;
    }
    const cleaned = line.replace(/^[-*]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (cleaned) optionLines.push(cleaned);
  }
  return { description, options: optionLines };
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
   * frame), before any carve pruned it — the layout the dashboard renders so a
   * carved issue still shows as a chip in the wave it left. `waves` is the pruned,
   * loop-facing plan; `layout` is display-facing and never loses a member. */
  layout: string[][];
  /** the issues a carve actually dropped from the plan (parked/unstarted members),
   * in log order — rendered `carved` (ADR 0007). A superset key over `outcomes`,
   * which stays `IssueStatus`; carved is a render overlay, not a stored status. */
  carved: Set<string>;
  /** the optional human name the campaign was launched with (`--name`), read off
   * the latest `campaign-start` event; undefined for an unnamed run. */
  name?: string;
  outcomes: Map<string, IssueStatus>;
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
}

/**
 * Reduce a project's event log to its current campaign's plan — pure, no I/O.
 * Only the latest `campaign-start` and everything after it is folded (a fresh
 * campaign supersedes an earlier one in the same log); a queue-only run with no
 * campaign frames it as a single wave. This is the load-bearing seam of ADR
 * 0005: `buildStatus` renders it and the `campaign` loop re-reads it each wave.
 */
export function reduceCampaign(events: any[]): ReducedCampaign {
  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.batches));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  let waves: string[][] = [];
  let layout: string[][] = [];
  const carved = new Set<string>();
  let name: string | undefined;
  const outcomes = new Map<string, IssueStatus>();
  const details = new Map<string, string>();
  const titles = new Map<string, string>();
  const mergedAt = new Map<string, string>();
  const closedWaves = new Set<number>();
  let currentWave = -1;

  for (const e of relevant) {
    // Any start event may carry an id→title map (`campaign` writes it on
    // `campaign-start`, a standalone `queue` on `queue-start`); fold them all so
    // the plan carries a name for every issue a title was resolved for.
    if (e.titles && typeof e.titles === "object") {
      for (const [id, title] of Object.entries(e.titles)) {
        if (typeof title === "string" && title.trim()) titles.set(normalizeIssue(id), title.trim());
      }
    }
    if (e.event === "campaign-start" && Array.isArray(e.batches)) {
      waves = e.batches.map((batch: unknown[]) => batch.map(String).map(normalizeIssue));
      layout = waves.map((wave) => [...wave]);
      name = typeof e.name === "string" && e.name.trim() ? e.name : undefined;
      currentWave = -1;
    } else if (e.event === "campaign-batch" && Number.isInteger(e.index)) {
      currentWave = e.index;
    } else if (e.event === "queue-start" && Array.isArray(e.taskIds)) {
      const taskIds = e.taskIds.map(String).map(normalizeIssue);
      if (!waves.length) {
        waves = [taskIds];
        layout = [[...taskIds]];
        currentWave = 0;
      }
      for (const taskId of taskIds) {
        outcomes.set(taskId, "running");
        details.set(taskId, "Queued for this wave");
      }
    } else if (e.event === "queue-spawn" && e.taskId) {
      details.set(normalizeIssue(String(e.taskId)), `Running in agent slot (${e.running ?? "?"} active, ${e.left ?? "?"} waiting)`);
    } else if (e.event === "turn" && e.taskId) {
      details.set(normalizeIssue(String(e.taskId)), `Agent turn ${e.turn ?? "?"} finished; waiting for verification/resume`);
    } else if (e.event === "queue-done" && e.outcomes && typeof e.outcomes === "object") {
      for (const [taskId, outcome] of Object.entries(e.outcomes)) {
        const status = statusForOutcome(String(outcome));
        outcomes.set(normalizeIssue(taskId), status);
        if (status === "completed" && e.ts && !mergedAt.has(normalizeIssue(taskId))) mergedAt.set(normalizeIssue(taskId), String(e.ts));
      }
    } else if (e.event === "green" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "completed");
      details.set(taskId, e.branch ? `Completed on ${e.branch}` : "Completed");
      if (e.ts && !mergedAt.has(taskId)) mergedAt.set(taskId, String(e.ts));
    } else if (e.event === "parked" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "parked");
      details.set(taskId, `Parked: ${e.reason ?? "needs attention"}`);
    } else if (e.event === "campaign-batch-done" && Number.isInteger(e.index)) {
      closedWaves.add(e.index);
      currentWave = -1;
      for (const taskId of e.merged ?? []) {
        const issueNumber = normalizeIssue(String(taskId));
        outcomes.set(issueNumber, "completed");
        if (!details.has(issueNumber)) details.set(issueNumber, "Merged into base");
        if (e.ts && !mergedAt.has(issueNumber)) mergedAt.set(issueNumber, String(e.ts));
      }
    } else if (e.event === "campaign-halt" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "failure");
      details.set(taskId, `Campaign halted: ${e.reason ?? "failure"}`);
    } else if (e.event === "carve" && Array.isArray(e.removed)) {
      // Prune the running campaign at the point the carve was issued: banked and
      // in-flight members stay, only parked/unstarted ones leave (ADR 0005).
      // Folding it in log order means `outcomes` already reflects the state the
      // carve saw, so the same rule replays deterministically. The dropped members
      // are remembered (not just removed) so the display can render them `carved`
      // in the wave they left, while `waves` stays the pruned loop-facing plan.
      const applied = applyCarve({ waves, outcomes }, e.removed.map(String));
      for (const id of applied.dropped) {
        carved.add(id);
        details.set(id, "Carved out of the campaign");
      }
      waves = applied.remaining;
    }
  }

  return { waves, layout, carved, name, outcomes, details, titles, mergedAt, closedWaves, currentWave };
}

/**
 * Is a campaign currently running over this event log? True iff the latest
 * `campaign-start` has no `campaign-done` or `campaign-halt` after it — the
 * condition the no-plan `carve <issue>` needs before it can prune (ADR 0005).
 * A queue-only run with no campaign frame is not a campaign and returns false.
 */
export function campaignRunning(events: any[]): boolean {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.batches));
  if (start < 0) return false;
  return !events.slice(start).some((e) => e.event === "campaign-done" || e.event === "campaign-halt");
}

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
export function listArchivedRuns(baseLocation: string): ArchivedRun[] {
  const dir = archiveDirOf(baseLocation);
  if (!existsSync(dir)) return [];
  const runs: ArchivedRun[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(/^orchestrator-(.+)\.jsonl$/);
    if (!match) continue;
    const file = join(dir, name);
    const events = readEvents({ logFile: file });
    const { waves, name: runName } = reduceCampaign(events);
    if (!waves.length) {
      log("status-archive-skipped", { file });
      continue;
    }
    runs.push({ run: match[1], file, summary: summarizeRun(events), name: runName });
  }
  return runs.sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0));
}

/**
 * Fold one run's event log into a one-line summary for the archived-runs list:
 * its mode (a `campaign` frame vs a bare `queue` run), how many issues it spanned,
 * and whether it finished clean or halted. Derived from the same `reduceCampaign`
 * plan the dashboard renders, so the summary can never disagree with the run's
 * reconstructed wave/issue view (ADR 0005).
 */
export function summarizeRun(events: any[]): string {
  const { waves, outcomes } = reduceCampaign(events);
  const mode = events.some((e) => e.event === "campaign-start") ? "campaign" : "queue";
  const count = waves.flat().length;
  const halted = events.some((e) => e.event === "campaign-halt") || [...outcomes.values()].includes("failure");
  return `${mode} · ${count} issue${count === 1 ? "" : "s"} · ${halted ? "halted" : "complete"}`;
}

export function buildStatus(cfg: ResolvedConfig): CampaignStatus {
  const { waves, layout, carved, name, outcomes, details, titles, closedWaves, currentWave } = reduceCampaign(readEvents(cfg));

  const activeIssueNumbers = new Set(waves.flat());
  const closedIssueNumbers = new Set([...closedWaves].flatMap((index) => waves[index] ?? []));
  const parkedRecords = listParked(cfg).filter((parked) => {
    const issueNumber = normalizeIssue(parked.taskId);
    return (!activeIssueNumbers.size || activeIssueNumbers.has(issueNumber)) && !closedIssueNumbers.has(issueNumber);
  });
  for (const parked of parkedRecords) {
    const taskId = normalizeIssue(parked.taskId);
    outcomes.set(taskId, "parked");
    details.set(taskId, `Parked: ${parked.reason}`);
  }

  // Display waves render off `layout` (the pre-carve membership) so a carved issue
  // still shows as a `carved` chip in the wave it left (ADR 0007). `closedWaves`
  // and `currentWave` index the pruned `waves`, so each surviving layout wave maps
  // to its pruned index by counting non-empty layout waves before it; a wholly
  // carved-out wave keeps its slot as an unstarted wave of carved chips.
  let prunedIndex = 0;
  const displayWaves = layout.map((wave, index) => {
    const survives = wave.some((issueNumber) => !carved.has(issueNumber));
    const prunedWave = survives ? prunedIndex++ : -1;
    return {
      index,
      status: (prunedWave >= 0 && closedWaves.has(prunedWave) ? "closed" : prunedWave >= 0 && currentWave === prunedWave ? "running" : "unstarted") as WaveStatus,
      issues: wave.map((issueNumber) => ({
        issueNumber,
        status: (carved.has(issueNumber) ? "carved" : outcomes.get(issueNumber) ?? "unstarted") as DisplayStatus,
        name: titles.get(issueNumber),
        detail: details.get(issueNumber),
      })),
    };
  });

  return {
    project: cfg.project,
    name,
    waves: displayWaves,
    parked: parkedRecords.map(toParkedIssue),
  };
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

const statusConfigFromPointer = (pointer: ProjectPointer): ResolvedConfig =>
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
 * needs the project's own `fetchTask`); the aggregated view is names-free.
 */
export function buildAllStatus(pointers: ProjectPointer[]): CampaignStatus[] {
  const statuses: CampaignStatus[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    statuses.push(buildStatus(statusConfigFromPointer(pointer)));
  }
  return statuses;
}

/** One row of the cross-project event feed: which project it came from, when it
 * happened (the event's ISO `ts`), the raw event kind, and the repo-prefixed
 * plain-words sentence `formatFeedEvent` folds it to. */
export interface FeedEntry {
  project: string;
  ts: string;
  kind: string;
  text: string;
}

/**
 * The cross-project event feed: every registered project's live-run log flattened
 * to its narratable events, repo-prefixed and sorted newest-first. Reads each
 * project's log live off the registry, exactly as `buildLanding`/`buildAllStatus`
 * do, skipping a project whose base location is gone with a log line rather than
 * throwing (ADR 0002). Machine-noise events `describeEvent` can't narrate carry no
 * row (`formatFeedEvent` returns ""), so the feed reads as an operator log, not a
 * raw event dump.
 */
export function buildFeed(pointers: ProjectPointer[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    for (const e of readEvents(statusConfigFromPointer(pointer))) {
      const text = formatFeedEvent(pointer.project, e);
      if (text) entries.push({ project: pointer.project, ts: String(e.ts ?? ""), kind: String(e.event ?? ""), text });
    }
  }
  return entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

const toParkedIssue = (rec: ParkedRecord): ParkedIssue => {
  const details = extractParkedDetails(rec.question);
  return {
    issueNumber: normalizeIssue(rec.taskId),
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

/** A project's run-state rolled up to one word for the landing card, from the
 * ADR 0007 vocabulary: `idle` when there is no live run, else the most demanding
 * state its issues are in (a failure to surface > a human needed > work in flight
 * > all done). */
export type RunState = "running" | "parked" | "failure" | "completed" | "idle";

/** One project's row on the all-repos landing: its run state, the campaign it is
 * (or last) running, how far through the waves it is, how much has merged, a
 * running/parked/queued tally, and the last event in plain words. An idle project
 * (no live run) reads `idle` and carries its last campaign's name and summary. */
export interface ProjectCard {
  project: string;
  runState: RunState;
  campaignName?: string;
  wave: { current: number; total: number } | null;
  percentMerged: number;
  tally: { running: number; parked: number; queued: number };
  lastEvent: string;
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

const projectRunState = (status: CampaignStatus): RunState => {
  if (!status.waves.length) return "idle";
  // Carved chips are display-only ghosts of issues that left the plan — the roll-up
  // reads the live plan, so a run whose only unmerged work was carved still lands.
  const issues = status.waves.flatMap((wave) => wave.issues).filter((i) => i.status !== "carved");
  if (issues.some((i) => i.status === "failure")) return "failure";
  if (status.parked.length) return "parked";
  if (issues.some((i) => i.status === "running")) return "running";
  if (issues.every((i) => i.status === "completed")) return "completed";
  return "running";
};

/** Same UTC calendar day — the basis for "merged today". Deterministic (no local
 * timezone), so a run's merge timestamps and the passed-in "now" compare the same
 * way in tests and in the server. */
const sameUtcDay = (iso: string, day: Date) => iso.slice(0, 10) === day.toISOString().slice(0, 10);

const buildProjectCard = (pointer: ProjectPointer, status: CampaignStatus, events: any[]): ProjectCard => {
  if (!status.waves.length) {
    const [latest] = listArchivedRuns(pointer.baseLocation);
    return {
      project: status.project,
      runState: "idle",
      campaignName: latest?.name ?? latest?.run,
      wave: null,
      percentMerged: 0,
      tally: { running: 0, parked: 0, queued: 0 },
      lastEvent: latest ? `Last run: ${latest.summary}` : "No runs yet",
    };
  }
  // The card reflects the live plan, not the display's carved ghosts: drop carved
  // chips (and any wave left wholly carved) so wave counts and progress match what
  // is actually still running (ADR 0007's carved is a campaign-view overlay only).
  const liveWaves = status.waves
    .map((wave) => ({ ...wave, issues: wave.issues.filter((i) => i.status !== "carved") }))
    .filter((wave) => wave.issues.length);
  const issues = liveWaves.flatMap((wave) => wave.issues);
  const total = liveWaves.length;
  const closed = liveWaves.filter((wave) => wave.status === "closed").length;
  const runningWave = liveWaves.findIndex((wave) => wave.status === "running");
  const completed = issues.filter((i) => i.status === "completed").length;
  return {
    project: status.project,
    runState: projectRunState(status),
    campaignName: status.name,
    // "N of M": the wave in flight if one is, otherwise how many have closed.
    wave: { current: runningWave >= 0 ? runningWave + 1 : closed, total },
    percentMerged: issues.length ? Math.round((completed / issues.length) * 100) : 0,
    tally: {
      running: issues.filter((i) => i.status === "running").length,
      parked: issues.filter((i) => i.status === "parked").length,
      queued: issues.filter((i) => i.status === "unstarted").length,
    },
    lastEvent: lastEventText(events),
  };
};

/**
 * Reconstruct the all-repos landing model live off the registry: one card per
 * project and the four summed counters. A project whose base location is gone is
 * skipped with a log line, never throwing — one stale registration must not take
 * the landing down (ADR 0002), the same tolerance `buildAllStatus` has.
 * merged-today counts each project's issues whose reconstructed merge stamp
 * (`reduceCampaign`'s `mergedAt`) falls on `now`'s UTC day.
 */
export function buildLanding(pointers: ProjectPointer[], now: Date = new Date()): LandingView {
  const projects: ProjectCard[] = [];
  const parked: ParkedQuestion[] = [];
  let mergedToday = 0;
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const cfg = statusConfigFromPointer(pointer);
    const events = readEvents(cfg);
    const { mergedAt, outcomes } = reduceCampaign(events);
    for (const [issueNumber, ts] of mergedAt) {
      if (outcomes.get(issueNumber) === "completed" && sameUtcDay(ts, now)) mergedToday++;
    }
    const status = buildStatus(cfg);
    // The same active parked records the project's campaign view shows, tagged
    // with their repo so the landing can list them cross-repo.
    for (const p of status.parked) {
      parked.push({ issueNumber: p.issueNumber, project: status.project, question: p.description, parkedAt: p.parkedAt });
    }
    projects.push(buildProjectCard(pointer, status, events));
  }
  // Oldest first — the question that has waited longest surfaces at the top.
  parked.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
  const sum = (pick: (card: ProjectCard) => number) => projects.reduce((total, card) => total + pick(card), 0);
  return {
    counters: {
      working: sum((c) => c.tally.running),
      parked: sum((c) => c.tally.parked),
      queued: sum((c) => c.tally.queued),
      mergedToday,
    },
    projects,
    parked,
  };
}
