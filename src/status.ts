import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { listProjects, type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord } from "./state.ts";
import { applyCarve } from "./carve.ts";

export type IssueStatus = "completed" | "parked" | "failure" | "running" | "unstarted";

export interface StatusIssue {
  issueNumber: string;
  status: IssueStatus;
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

// Issue titles rarely change during a campaign, so we cache them for the process
// lifetime; a rename won't surface until the status server restarts.
const issueNameCache = new Map<string, string | undefined>();

const issueNameFromTask = (task: string): string | undefined => {
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

const ISSUE_EMOJI: Record<IssueStatus, string> = {
  completed: "✅",
  running: "🔄",
  parked: "⏸",
  failure: "❌",
  unstarted: "⚪",
};

const WAVE_EMOJI: Record<WaveStatus, string> = {
  closed: "✅",
  running: "▶️",
  unstarted: "⚪",
};

/**
 * Render a campaign status as a plain-text summary for a Telegram chat — the
 * same model the web dashboard draws, flattened to lines that read on a phone.
 * Kept pure (no I/O) so it is trivially testable; `renderStatusText` is the
 * async wrapper that fetches issue names first.
 */
export function formatStatusText(status: CampaignStatus): string {
  const lines: string[] = [`📊 ${status.project} — status`];

  if (!status.waves.length) {
    lines.push("", "No active run right now. Start a queue or campaign and it'll show up here.");
    return lines.join("\n");
  }

  const total = status.waves.length;
  for (const wave of status.waves) {
    lines.push("", `Wave ${wave.index + 1}/${total} ${WAVE_EMOJI[wave.status]} ${wave.status}`);
    for (const issue of wave.issues) {
      const name = issue.name ? ` ${issue.name}` : "";
      lines.push(`  ${ISSUE_EMOJI[issue.status]} #${issue.issueNumber}${name}`);
    }
  }

  if (status.parked.length) {
    lines.push("", `⏸ ${status.parked.length} awaiting your reply:`);
    for (const p of status.parked) lines.push(`  #${p.issueNumber} — ${p.reason}`);
    lines.push("", "Reply to a parked question message to answer and resume it.");
  }

  return lines.join("\n");
}

/** `formatStatusText` over the live campaign status, with issue names resolved. */
export async function renderStatusText(cfg: ResolvedConfig): Promise<string> {
  return formatStatusText(await buildStatusWithIssueNames(cfg));
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
 * The reconstructed plan of the campaign an event log describes: its waves, the
 * per-issue outcome and hover detail, which waves have closed, and which wave is
 * current (-1 when none is in flight). It is the fold both the dashboard and the
 * `campaign` loop reduce so they agree on "the plan" by construction (ADR 0005).
 */
export interface ReducedCampaign {
  waves: string[][];
  outcomes: Map<string, IssueStatus>;
  details: Map<string, string>;
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
  const outcomes = new Map<string, IssueStatus>();
  const details = new Map<string, string>();
  const closedWaves = new Set<number>();
  let currentWave = -1;

  for (const e of relevant) {
    if (e.event === "campaign-start" && Array.isArray(e.batches)) {
      waves = e.batches.map((batch: unknown[]) => batch.map(String).map(normalizeIssue));
      currentWave = -1;
    } else if (e.event === "campaign-batch" && Number.isInteger(e.index)) {
      currentWave = e.index;
    } else if (e.event === "queue-start" && Array.isArray(e.taskIds)) {
      const taskIds = e.taskIds.map(String).map(normalizeIssue);
      if (!waves.length) {
        waves = [taskIds];
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
      for (const [taskId, outcome] of Object.entries(e.outcomes)) outcomes.set(normalizeIssue(taskId), statusForOutcome(String(outcome)));
    } else if (e.event === "green" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "completed");
      details.set(taskId, e.branch ? `Completed on ${e.branch}` : "Completed");
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
      }
    } else if (e.event === "campaign-halt" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "failure");
      details.set(taskId, `Campaign halted: ${e.reason ?? "failure"}`);
    } else if (e.event === "carve" && Array.isArray(e.removed)) {
      // Prune the running campaign at the point the carve was issued: banked and
      // in-flight members stay, only parked/unstarted ones leave (ADR 0005).
      // Folding it in log order means `outcomes` already reflects the state the
      // carve saw, so the same rule replays deterministically.
      waves = applyCarve({ waves, outcomes }, e.removed.map(String)).remaining;
    }
  }

  return { waves, outcomes, details, closedWaves, currentWave };
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

export function buildStatus(cfg: ResolvedConfig): CampaignStatus {
  const { waves, outcomes, details, closedWaves, currentWave } = reduceCampaign(readEvents(cfg));

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

  return {
    project: cfg.project,
    waves: waves.map((wave, index) => ({
      index,
      status: closedWaves.has(index) ? "closed" : currentWave === index ? "running" : "unstarted",
      issues: wave.map((issueNumber) => ({ issueNumber, status: outcomes.get(issueNumber) ?? "unstarted", detail: details.get(issueNumber) })),
    })),
    parked: parkedRecords.map(toParkedIssue),
  };
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

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const escapeTitle = (value: string) => escapeHtml(value).replaceAll("\n", "&#10;");

const chipTitle = (issue: StatusIssue) => [issue.name, issue.detail].filter(Boolean).join("\n");

const renderIssueChip = (issue: StatusIssue) => {
  const detail = chipTitle(issue) || `#${issue.issueNumber}: ${issue.status}`;
  return `<button type="button" class="chip" title="${escapeTitle(detail)}" data-detail="${escapeTitle(detail)}"><span class="dot ${issue.status}"></span>#${escapeHtml(issue.issueNumber)} <small>${escapeHtml(issue.status)}</small></button>`;
};

const renderWaveContents = (wave: StatusWave) => `<div class="chips">${wave.issues.map(renderIssueChip).join("")}</div>`;

const renderOpenWave = (wave: StatusWave) =>
  `<section class="wave"><h2>Wave ${wave.index + 1} <span class="wave-status ${wave.status}">${wave.status}</span></h2>${renderWaveContents(wave)}</section>`;

const renderCompletedWave = (wave: StatusWave) =>
  `<details class="completed-wave"><summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓</span> Wave ${wave.index + 1}</summary>${renderWaveContents(wave)}</details>`;

/**
 * The multi-project chrome around a single project's status: the list of every
 * registered project for the dropdown and which one is selected. Omitted for the
 * standalone per-project server, which renders exactly one project with no picker.
 */
export interface StatusPageOptions {
  projects?: string[];
  selected?: string;
}

const renderProjectPicker = (projects: string[], selected: string | undefined) =>
  `<form method="get" action="/" class="project-picker"><select name="project" onchange="this.form.submit()">${projects
    .map((p) => `<option value="${escapeHtml(p)}"${p === selected ? " selected" : ""}>${escapeHtml(p)}</option>`)
    .join("")}</select></form>`;

export const renderStatusPage = (status: CampaignStatus, opts: StatusPageOptions = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(status.project)} status</title>
<style>
  :root { --color-body: #090c10; --color-box-body: #0b0e12; --color-box-header: #10151b; --color-card: #0b0e12; --color-primary: #3fb9b0; --color-primary-alpha-20: rgb(63 185 176 / 20%); --color-text: #e6edf3; --color-text-light: #cdd6e0; --color-text-light-2: #8b98a5; --color-secondary: #232b35; --color-light-border: #1b212a; --color-green: #3fb984; --color-yellow: #c8a24e; --color-red: #f79287; --color-blue: #6cb6ff; --border-radius: 9px; --border-radius-medium: 12px; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: var(--color-body); color: var(--color-text); }
  h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: 0; letter-spacing: -0.035em; color: var(--color-text); }
  h2 { color: var(--color-text-light); }
  .page-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--color-light-border); padding-bottom: 1rem; }
  .project-picker { margin: 0; }
  .project-picker select { color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .6rem; font: inherit; cursor: pointer; }
  .project-picker select:hover { border-color: var(--color-primary); }
  .refresh { margin-left: auto; display: inline-flex; align-items: center; gap: .5rem; color: var(--color-text-light-2); }
  .refresh label { display: inline-flex; align-items: center; gap: .4rem; }
  .refresh input[type="checkbox"] { width: 1.15rem; height: 1.15rem; margin: 0; accent-color: var(--color-primary); cursor: pointer; }
  .refresh input[type="number"] { width: 3ch; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .25rem; }
  .refresh-every:has(#refresh-seconds:disabled) { opacity: .45; }
  .wave, .card { background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; margin: 1rem 0; box-shadow: 0 8px 22px #0004; }
  .wave { border-top: 3px solid var(--color-primary); }
  .completed-waves { display: flex; align-items: flex-start; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; color: var(--color-text-light); }
  .completed-wave-chip .check { color: var(--color-green); font-weight: 700; }
  .completed-wave-bar, .chips { display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: .5rem; }
  .completed-wave { display: inline-block; }
  .completed-wave[open] { display: block; flex-basis: 100%; border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; background: var(--color-box-body); }
  .completed-wave[open] > .completed-wave-chip { display: flex; width: max-content; margin-bottom: .6rem; }
  .completed-wave-chip { cursor: pointer; list-style: none; }
  .completed-wave-chip::-webkit-details-marker { display: none; }
  .chip, .wave-status, .completed-wave-chip { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--color-secondary); border-radius: 999px; padding: .3rem .65rem; background: var(--color-box-header); color: var(--color-text); }
  .chip:hover, .completed-wave-chip:hover { border-color: var(--color-primary); background: var(--color-primary-alpha-20); }
  .wave-status { font-size: .85rem; margin-left: .5rem; text-transform: uppercase; letter-spacing: .03em; }
  .wave-status.closed { border-color: var(--color-green); color: var(--color-green); background: rgb(63 185 132 / 12%); }
  .wave-status.running { border-color: var(--color-blue); color: var(--color-blue); background: rgb(108 182 255 / 12%); }
  .wave-status.unstarted { border-color: var(--color-text-light-2); color: var(--color-text-light-2); background: rgb(139 152 165 / 12%); }
  .dot { width: .75rem; height: .75rem; border-radius: 999px; display: inline-block; }
  .completed { background: var(--color-green); } .parked { background: var(--color-yellow); } .failure { background: var(--color-red); } .running { background: var(--color-blue); } .unstarted { background: var(--color-text-light-2); }
  textarea { width: 100%; min-height: 7rem; margin: .5rem 0; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; }
  button.chip { cursor: pointer; color: inherit; font: inherit; }
  .issue-detail { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: none; align-items: center; gap: .75rem; margin: 0; padding: .75rem 1rem calc(.75rem + env(safe-area-inset-bottom)); color: var(--color-blue); background: var(--color-box-header); border-top: 1px solid var(--color-primary); box-shadow: 0 -8px 22px #0006; }
  .issue-detail.show { display: flex; }
  .issue-detail-text { flex: 1; white-space: pre-line; }
  .issue-detail-close { flex: none; background: none; border: 0; color: var(--color-text-light-2); font-size: 1.25rem; line-height: 1; cursor: pointer; padding: .1rem .35rem; border-radius: var(--border-radius); }
  .issue-detail-close:hover { color: var(--color-text); background: var(--color-secondary); }
  form button { padding: .5rem .8rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; cursor: pointer; font-weight: 700; }
  pre { white-space: pre-wrap; }
  .parked-issues { margin: 1rem 0 2rem; }
  .parked-issues > h2 { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
  .parked-count { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--color-yellow); border: 1px solid var(--color-yellow); background: rgb(200 162 78 / 12%); border-radius: 999px; padding: .15rem .55rem; }
  .parked-issues .card { border-left: 3px solid var(--color-yellow); }
</style>
</head>
<body>
<div class="page-top"><h1>${escapeHtml(status.project)} status</h1>${
  opts.projects?.length ? renderProjectPicker(opts.projects, opts.selected ?? status.project) : ""
}<div class="refresh" title="Auto-refresh the page every N seconds"><label><input id="refresh-enabled" type="checkbox" checked /> <span>Refresh</span></label><label class="refresh-every"><input id="refresh-seconds" type="number" min="1" max="999" step="1" value="45" /></label></div></div>
${
  status.parked.length
    ? `<section class="parked-issues"><h2>Parked issues <span class="parked-count">${status.parked.length} awaiting you</span></h2>${status.parked
        .map(
          (p) => `<section class="card"><h3>Issue #${escapeHtml(p.issueNumber)}</h3><p><strong>Parked on:</strong></p><pre>${escapeHtml(p.description)}</pre>${
            p.options.length ? `<p><strong>Options:</strong></p><ul>${p.options.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>` : ""
          }<form method="post" action="/answer"><input type="hidden" name="taskId" value="${escapeHtml(p.issueNumber)}" /><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><textarea name="text" placeholder="Type your response..."></textarea><button>Send response</button></form></section>`,
        )
        .join("")}</section>`
    : ""
}
${
  status.waves.length
    ? `${
        status.waves.some((wave) => wave.status === "closed")
          ? `<div class="completed-waves"><div class="completed-wave-bar">${status.waves.filter((wave) => wave.status === "closed").map(renderCompletedWave).join("")}</div></div>`
          : ""
      }${status.waves.filter((wave) => wave.status !== "closed").map(renderOpenWave).join("")}`
    : "<p>No active campaign or queue found.</p>"
}
<div id="issue-detail" class="issue-detail" aria-live="polite"><span class="issue-detail-text"></span><button type="button" id="issue-detail-close" class="issue-detail-close" aria-label="Dismiss">&times;</button></div>
<script>
  const refreshInput = document.getElementById("refresh-seconds");
  const refreshEnabled = document.getElementById("refresh-enabled");
  refreshInput.value = localStorage.getItem("sandcastle-status-refresh-seconds") ?? "45";
  refreshEnabled.checked = localStorage.getItem("sandcastle-status-refresh-enabled") !== "false";
  let refreshTimer;
  const isComposing = () =>
    [...document.querySelectorAll("textarea")].some((el) => el === document.activeElement || el.value.trim() !== "");
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    const seconds = Number(refreshInput.value);
    localStorage.setItem("sandcastle-status-refresh-seconds", String(Number.isFinite(seconds) && seconds > 0 ? seconds : 0));
    localStorage.setItem("sandcastle-status-refresh-enabled", String(refreshEnabled.checked));
    refreshInput.disabled = !refreshEnabled.checked;
    if (refreshEnabled.checked && Number.isFinite(seconds) && seconds > 0)
      refreshTimer = setTimeout(() => (isComposing() ? scheduleRefresh() : location.reload()), seconds * 1000);
  };
  refreshInput.addEventListener("input", scheduleRefresh);
  refreshEnabled.addEventListener("change", scheduleRefresh);
  scheduleRefresh();
  const issueDetail = document.getElementById("issue-detail");
  const issueDetailText = issueDetail.querySelector(".issue-detail-text");
  const showDetail = (text) => {
    issueDetailText.textContent = text;
    issueDetail.classList.toggle("show", Boolean(text));
  };
  document.getElementById("issue-detail-close").addEventListener("click", () => showDetail(""));
  document.querySelectorAll(".chip[data-detail]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const text = chip.getAttribute("data-detail") ?? "";
      showDetail(issueDetailText.textContent === text ? "" : text);
    });
  });
</script>
</body>
</html>`;

export async function serveStatus(cfg: ResolvedConfig, opts: { port: number; host: string; configPath?: string }) {
  mkdirSync(cfg.stateDir, { recursive: true });
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/api/status") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(await buildStatusWithIssueNames(cfg)));
        return;
      }
      if (req.method === "POST" && req.url === "/answer") {
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const taskId = form.get("taskId");
        const text = form.get("text");
        if (!taskId || !text) {
          res.writeHead(400).end("taskId and text are required");
          return;
        }
        const args = [...process.execArgv, process.argv[1], "answer", taskId, text, ...(opts.configPath ? ["--config", opts.configPath] : [])];
        spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
        res.writeHead(303, { location: "/" }).end();
        return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url === undefined)) {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(renderStatusPage(await buildStatusWithIssueNames(cfg)));
        return;
      }
      res.writeHead(404).end("not found");
    })().catch((err) => {
      res.writeHead(500).end(String(err?.stack ?? err));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const address = server.address() as AddressInfo;
  const shownHost = opts.host === "0.0.0.0" ? "<tailnet-or-host-ip>" : opts.host;
  console.log(`sandcastle-tdd status: http://${shownHost}:${address.port}`);
}

/**
 * Which project the aggregated view shows: the one named in the request, or the
 * first registered project when none is named (or the name is stale). Never
 * undefined given at least one project — the page always shows something useful
 * on a bare open. Callers guard the empty-registry case before calling.
 */
export function selectStatus(statuses: CampaignStatus[], requested?: string): CampaignStatus {
  return statuses.find((s) => s.project === requested) ?? statuses[0];
}

/**
 * The gateway's aggregated status site: one port fronting every registered
 * project. It reads the registry live each request (so a newly run project shows
 * up with no restart), builds each project's status from its base location, and
 * renders the one the `project` query param selects — defaulting to the first.
 * The parked-answer POST carries its project so the resume runs in that project's
 * own root with its own config and gates (ADR 0003), mirroring the gateway's
 * reply routing. The standalone `serveStatus` remains the no-gateway fallback.
 */
export async function serveAllStatus(configDir: string, opts: { port: number; host: string }) {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pointers = () => listProjects(configDir);
      if (req.method === "GET" && url.pathname === "/api/status") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(buildAllStatus(pointers())));
        return;
      }
      if (req.method === "POST" && url.pathname === "/answer") {
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const taskId = form.get("taskId");
        const text = form.get("text");
        const project = form.get("project");
        if (!taskId || !text || !project) {
          res.writeHead(400).end("taskId, text and project are required");
          return;
        }
        const pointer = pointers().find((p) => p.project === project);
        if (!pointer) {
          res.writeHead(404).end(`unknown project: ${project}`);
          return;
        }
        // Resume in the project's own root so `answer` loads that project's config
        // and gates — the same shell-out the gateway's reply router uses.
        spawn(process.execPath, [...process.execArgv, process.argv[1], "answer", taskId, text], {
          cwd: pointer.projectRoot,
          stdio: ["ignore", "inherit", "inherit"],
        });
        res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || req.url === undefined)) {
        const statuses = buildAllStatus(pointers());
        res.setHeader("content-type", "text/html; charset=utf-8");
        if (!statuses.length) {
          res.end(renderStatusPage({ project: "No projects registered", waves: [], parked: [] }));
          return;
        }
        const selected = selectStatus(statuses, url.searchParams.get("project") ?? undefined);
        res.end(renderStatusPage(selected, { projects: statuses.map((s) => s.project), selected: selected.project }));
        return;
      }
      res.writeHead(404).end("not found");
    })().catch((err) => {
      res.writeHead(500).end(String(err?.stack ?? err));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const address = server.address() as AddressInfo;
  const shownHost = opts.host === "0.0.0.0" ? "<tailnet-or-host-ip>" : opts.host;
  console.log(`sandcastle-tdd gateway status: http://${shownHost}:${address.port}`);
  return server;
}

const readBody = (req: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
