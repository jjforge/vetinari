import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord } from "./state.ts";
import { applyCarve } from "./carve.ts";

/**
 * Parse a git remote URL to its `owner/name`, handling both the SSH
 * (`git@github.com:owner/name.git`) and HTTPS (`https://github.com/owner/name(.git)`)
 * forms, stripping a `.git` suffix and any trailing slash. Pure and testable — the
 * `git remote get-url` call is the impure edge (`repoForProject`), this is the parse.
 * Anything it can't recognize as a remote is `undefined`, so a caller falls back to
 * the bare project key rather than showing a broken label.
 */
export function ownerRepoFromRemote(url: string): string | undefined {
  const match = url.trim().match(/(?:git@[^:]+:|https?:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, owner, name] = match;
  return owner && name ? `${owner}/${name}` : undefined;
}

/**
 * A project's `owner/name`, read live from its checkout's `origin` remote — the
 * impure edge over the pure `ownerRepoFromRemote` parse. A root that is not a git
 * repo, has no `origin`, or whose URL doesn't parse yields `undefined` (the git
 * call is silenced and never throws), so the display falls back to the bare key.
 */
export function repoForProject(projectRoot: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return ownerRepoFromRemote(url);
  } catch {
    return undefined;
  }
}

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

/**
 * The events appended to a jsonl event log past a character offset, and the
 * offset to resume from next time. Pure — the tail-reading half of the live
 * watcher (ADR 0008), split out so it can be unit-tested without a file or a
 * running server: given the log's full text and where we last stopped, it returns
 * only the newly-appended *complete* lines (parsed, bad lines skipped like
 * `readEvents`) and the new offset — the length of text consumed up to and
 * including the last newline. A partial trailing line (an append caught
 * mid-write) is left unconsumed so it is read whole next time, and a `content`
 * shorter than `offset` means the log was truncated or rotated, so it is re-read
 * from the start.
 */
export function appendedEvents(content: string, offset: number): { events: any[]; offset: number } {
  const from = offset >= 0 && offset <= content.length ? offset : 0;
  const tail = content.slice(from);
  const lastNewline = tail.lastIndexOf("\n");
  if (lastNewline === -1) return { events: [], offset: from };
  const complete = tail.slice(0, lastNewline + 1);
  const events = complete
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return { events, offset: from + complete.length };
}

const normalizeIssue = (id: string) => id.replace(/^#/, "");

const hash = (id: unknown) => `#${normalizeIssue(String(id))}`;

/** The issue number a merge/green event is about: its explicit `taskId`, or —
 * for a merge that names its issue only through the branch (`agent/<id>`, the
 * campaign wave-merge / per-issue green path) — the id embedded in that branch.
 * Keeps the feed from rendering `#undefined` when only the branch carries it. */
const mergedIssue = (e: any): string | undefined => {
  if (e?.taskId != null && String(e.taskId) !== "") return normalizeIssue(String(e.taskId));
  const tail = e?.branch != null ? String(e.branch).split("/").pop() : "";
  return tail ? normalizeIssue(tail) : undefined;
};

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
    case "green": {
      const id = mergedIssue(e);
      return id ? `#${id} merged` : "merged";
    }
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

/**
 * The parked-reply payload the issue-detail sheet needs for a parked issue: the
 * question with any trailing Options section split off, and those options parsed
 * as fill-the-field choices (story: parked-question reply). Reads the matching
 * parked record (by normalized issue number); returns undefined when none names
 * the issue — a log-only parked state — so the sheet falls back to just the
 * free-text field.
 */
export function parkedReplyFor(records: ParkedRecord[], issueNumber: string): { question: string; options: string[] } | undefined {
  const id = normalizeIssue(issueNumber);
  const rec = records.find((r) => normalizeIssue(r.taskId) === id);
  if (!rec) return undefined;
  const { description, options } = extractParkedDetails(rec.question);
  return { question: description, options };
}

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
  /** did the run this fold describes halt? True when its slice holds a
   * `campaign-halt` event — scoped to the latest `campaign-start` like everything
   * else here, so a stale halt from a superseded earlier run in the same (archived)
   * log never bleeds into this run's outcome. */
  halted: boolean;
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
  let halted = false;

  for (const e of relevant) {
    if (e.event === "campaign-halt") halted = true;
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

  return { waves, layout, carved, name, outcomes, details, titles, mergedAt, halted, closedWaves, currentWave };
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
  status: DisplayStatus;
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
const eventNamesIssue = (e: any, id: string): boolean => {
  if (e?.taskId != null && normalizeIssue(String(e.taskId)) === id) return true;
  const inArray = (a: unknown) => Array.isArray(a) && a.map(String).map(normalizeIssue).includes(id);
  if (inArray(e?.taskIds) || inArray(e?.merged) || inArray(e?.removed)) return true;
  if (e?.outcomes && typeof e.outcomes === "object" && Object.keys(e.outcomes).map(normalizeIssue).includes(id)) return true;
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
export function reconstructIssueDetail(events: any[], issueNumber: string): IssueDetail {
  const id = normalizeIssue(issueNumber);
  const { outcomes, carved, titles, name } = reduceCampaign(events);
  const status: DisplayStatus = carved.has(id) ? "carved" : outcomes.get(id) ?? "unstarted";

  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.batches));
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

  return { issueNumber: id, status, title: titles.get(id), campaignName: name, turns: turnLog.length, elapsedMs, turnLog: turnLog.reverse(), ...(worktree ? { worktree } : {}) };
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

/** An archived run's terminal disposition for the archived-runs list: `complete`
 * when its latest campaign reached the terminal `campaign-done`/`queue-done` (a
 * full, clean finish), else `interrupted` — the run was cut short and only its
 * partial waves were recorded, whether killed mid-wave (no terminal event) or
 * halted (base rolled back, later waves never run). Both read `interrupted` and
 * still expand to the waves that did run. */
export type ArchivedRunState = "complete" | "interrupted";

/**
 * A run's terminal disposition, scoped to the latest `campaign-start` like the
 * rest of the reducer (#69) so a superseded earlier run never decides it — a
 * queue-only run (no campaign frame) is folded whole and reads its `queue-done`.
 */
export function archivedRunState(events: any[]): ArchivedRunState {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.batches));
  const relevant = start >= 0 ? events.slice(start) : events;
  return relevant.some((e) => e.event === "campaign-done" || e.event === "queue-done") ? "complete" : "interrupted";
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
  /** whether the run finished clean (`complete`) or was cut short (`interrupted`);
   * an interrupted row still expands to the partial waves recorded before it stopped. */
  state: ArchivedRunState;
  /** the run's start time as an ISO timestamp, parsed from its `run` token; undefined
   * for a token that doesn't parse (so the row falls back to the token verbatim). */
  startedAt?: string;
  /** how many issues the run's plan spanned (its full pre-carve membership, so a
   * carved-out issue still counts — it renders as a chip in the expanded view). */
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
export function listArchivedRuns(baseLocation: string): ArchivedRun[] {
  const dir = archiveDirOf(baseLocation);
  if (!existsSync(dir)) return [];
  const runs: ArchivedRun[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(/^orchestrator-(.+)\.jsonl$/);
    if (!match) continue;
    const file = join(dir, name);
    const events = readEvents({ logFile: file });
    const { waves, layout, name: runName } = reduceCampaign(events);
    if (!waves.length) {
      log("status-archive-skipped", { file });
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
 * and whether it finished clean or halted. Derived from the same `reduceCampaign`
 * plan the dashboard renders, so the summary can never disagree with the run's
 * reconstructed wave/issue view (ADR 0005).
 */
export function summarizeRun(events: any[]): string {
  // Everything derives from the run `reduceCampaign` reconstructs (the latest
  // `campaign-start` onward), so a multi-run archive summarizes its terminal run —
  // a stale `campaign-halt` from a superseded earlier run in the same log no longer
  // reads a completed run as "halted" (#69).
  const { waves, outcomes, halted } = reduceCampaign(events);
  const mode = events.some((e) => e.event === "campaign-start") ? "campaign" : "queue";
  const count = waves.flat().length;
  const ended = halted || [...outcomes.values()].includes("failure");
  return `${mode} · ${count} issue${count === 1 ? "" : "s"} · ${ended ? "halted" : "complete"}`;
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
 * ADR 0007 vocabulary: `idle` when there is no live run, else the most
 * human-blocking state its issues are in, by the §3 precedence (a human needed >
 * a failure to surface > work in flight > all done). */
export type RunState = "running" | "parked" | "failure" | "completed" | "idle";

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
 * The single state→run-state derivation for a project card (§3 precedence:
 * `parked > failure > running > unstarted > completed`). The most human-blocking
 * state wins — a repo with one parked question and four running agents reads
 * `parked`, because the question is the thing that needs a person; `failure` ranks
 * just below, since it also needs a human but a parked question is the more direct
 * ask. Carved chips are display-only ghosts of issues that left the plan, so the
 * roll-up reads the live plan (a run whose only unmerged work was carved still lands).
 */
export const projectRunState = (status: CampaignStatus): RunState => {
  if (!status.waves.length) return "idle";
  const issues = status.waves.flatMap((wave) => wave.issues).filter((i) => i.status !== "carved");
  if (status.parked.length) return "parked";
  if (issues.some((i) => i.status === "failure")) return "failure";
  if (issues.some((i) => i.status === "running")) return "running";
  if (issues.every((i) => i.status === "completed")) return "completed";
  return "running";
};

/** Same UTC calendar day — the basis for "merged today". Deterministic (no local
 * timezone), so a run's merge timestamps and the passed-in "now" compare the same
 * way in tests and in the server. */
const sameUtcDay = (iso: string, day: Date) => iso.slice(0, 10) === day.toISOString().slice(0, 10);

/**
 * How many of a project's issues merged (completed) on `now`'s day, counted across
 * *every* one of its runs — the live run plus every archived run
 * (`listArchivedRuns`), not just the latest (#97). Each run is reduced
 * independently and an issue that completed today in it is added to a per-project
 * set, so an issue appearing in more than one run (a re-run) is counted once. Read-
 * only over the logs (ADR 0002); a run whose reduce throws is skipped with a log
 * line so one bad archive can never zero the count. "Today" is the UTC day (see
 * `sameUtcDay`) — near midnight this can disagree with the operator's local day.
 */
const mergedTodayForProject = (baseLocation: string, liveEvents: any[], now: Date): number => {
  const merged = new Set<string>();
  const runs = [liveEvents, ...listArchivedRuns(baseLocation).map((r) => readEvents({ logFile: r.file }))];
  for (const runEvents of runs) {
    try {
      const { mergedAt, outcomes } = reduceCampaign(runEvents);
      for (const [issueNumber, ts] of mergedAt) {
        if (outcomes.get(issueNumber) === "completed" && sameUtcDay(ts, now)) merged.add(issueNumber);
      }
    } catch (error) {
      log("status-merged-today-skipped", { baseLocation, error: String(error) });
    }
  }
  return merged.size;
};

const buildProjectCard = (pointer: ProjectPointer, status: CampaignStatus, events: any[]): ProjectCard => {
  // The card heading shows owner/name, read live off the checkout's git remote;
  // undefined for a project with none (the demo), so the display falls back to the key.
  const repo = repoForProject(pointer.projectRoot);
  if (!status.waves.length) {
    const [latest] = listArchivedRuns(pointer.baseLocation);
    // An idle card's numbers come from the last archived run, not the emptied live
    // log: reconstruct it and read its real merged % so a completed run no longer
    // reads 0% (#70). `waves` is already the pruned plan (carved issues dropped), so
    // the ratio matches the live card's carved-aware count.
    const archived = latest ? reduceCampaign(readEvents({ logFile: latest.file })) : undefined;
    const archivedIssues = archived ? archived.waves.flat() : [];
    const merged = archived ? archivedIssues.filter((n) => archived.outcomes.get(n) === "completed").length : 0;
    return {
      project: status.project,
      repo,
      runState: "idle",
      campaignName: latest?.name ?? latest?.run,
      wave: null,
      percentMerged: archivedIssues.length ? Math.round((merged / archivedIssues.length) * 100) : 0,
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
    repo,
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
    const status = buildStatus(cfg);
    // merged-today counts every issue merged today across all of the project's runs
    // — the live run plus every archived run, deduped per issue — so a project that
    // ran several campaigns today counts them all, not just its latest run (#97).
    // A completed run's merges live in its archive, not the cleared live log (#70).
    mergedToday += mergedTodayForProject(pointer.baseLocation, events, now);
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
