import type { ResolvedConfig } from "./config.ts";
import {
  buildStatusWithIssueNames,
  type CampaignStatus,
  type DisplayStatus,
  type StatusIssue,
  type StatusWave,
  type WaveStatus,
} from "./dashboard-model.ts";

/**
 * The dashboard's single colour source (`docs/dashboard-color-rules.md`, #83): one
 * `:root` palette emitted verbatim into every surface's `<style>` — the all-repos
 * landing, the repo/campaign page, and the issue-detail sheet they share. No
 * surface defines a colour locally, so a token can never be "defined in one root,
 * missing in the other" (the #78 class of bug). Every colour that carries meaning
 * is one of the six ADR-0007 states or the carve action (§1); the teal
 * `--color-primary` is the product accent and is never a state.
 */
export const DASHBOARD_PALETTE_CSS = `  :root {
    /* Neutral surfaces (§1) */
    --color-body: #090c10; --color-box-body: #0b0e12; --color-box-header: #10151b;
    --color-card: #10151b; --color-chip: #0b0e12; --color-card-hover: #131a21; --color-chip-hover: #151d24;
    --color-secondary: #232b35; --color-light-border: #1b212a;
    --color-text: #e6edf3; --color-text-light: #cdd6e0; --color-text-light-2: #8b98a5; --color-dim: #5f6b78;
    /* Product accent — never a state (§1) */
    --color-primary: #3fb9b0; --color-primary-alpha-20: rgb(63 185 176 / 20%);
    /* State palette (§1): running · parked · failure · completed · unstarted(dim) · carved */
    --color-blue: #6cb6ff; --color-yellow: #c8a24e; --color-failure: #f85149; --color-green: #3fb984; --color-carved: #a371f7;
    /* State colours at 40% alpha — the muted chip borders (§4) */
    --color-blue-40: rgb(108 182 255 / 40%); --color-yellow-40: rgb(200 162 78 / 40%); --color-failure-40: rgb(248 81 73 / 40%); --color-green-40: rgb(63 185 132 / 40%); --color-carved-40: rgb(163 113 247 / 40%); --color-dim-40: rgb(95 107 120 / 40%);
    /* Carve action — a control, never a state; a different red from failure (§1) */
    --color-red: #f79287;
    --border-radius: 9px; --border-radius-medium: 12px;
  }`;

/**
 * The one state→colour mapping every surface derives from (§3), never authoring a
 * hex per instance. Maps each ADR-0007 status — plus the landing's `idle` roll-up
 * and its `queued` tally bucket, both display aliases of `unstarted`'s dim grey —
 * to its palette token. `stateColor` returns the full state colour (dots, borders,
 * pills); `stateBorderColor` its 40%-alpha variant for muted chip borders (§4).
 */
const STATE_COLOR_TOKEN: Record<string, string> = {
  running: "blue",
  parked: "yellow",
  failure: "failure",
  completed: "green",
  carved: "carved",
  unstarted: "dim",
  queued: "dim",
  idle: "dim",
};
export const stateColor = (state: string): string => `var(--color-${STATE_COLOR_TOKEN[state] ?? "dim"})`;
export const stateBorderColor = (state: string): string => `var(--color-${STATE_COLOR_TOKEN[state] ?? "dim"}-40)`;

/**
 * The status-dot colour rules, generated once from `stateColor` and shared by both
 * pages (previously two hand-kept copies). Scoped to `.dot` so a state colour tints
 * only the dot, never a whole card or list row (#81). Motion is a second channel for
 * `running` alone (§5): its dot pulses, reduced-motion aware; nothing else animates.
 */
export const STATE_DOT_CSS =
  `.dot { width: .75rem; height: .75rem; border-radius: 999px; display: inline-block; } ` +
  ["running", "parked", "failure", "completed", "unstarted", "carved", "queued"].map((s) => `.dot.${s} { background: ${stateColor(s)}; }`).join(" ") +
  ` @keyframes chip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } } .dot.running { animation: chip-pulse 1.4s ease-in-out infinite; } @media (prefers-reduced-motion: reduce) { .dot.running { animation: none; } }`;

/**
 * An issue chip borders its own status at 40% alpha (§4) — muted so a wave of a
 * dozen chips does not vibrate, while each chip's full-strength dot still lets you
 * count states at a glance. Generated once from `stateBorderColor`; the campaign
 * page's issue chips carry a matching status class. Tally chips (counts, not states)
 * are deliberately left out — they keep a neutral border (§7).
 */
export const STATE_CHIP_BORDER_CSS = ["running", "parked", "failure", "completed", "unstarted", "carved"].map((s) => `.chip.${s} { border-color: ${stateBorderColor(s)}; }`).join(" ");

const ISSUE_EMOJI: Record<DisplayStatus, string> = {
  completed: "✅",
  running: "🔄",
  parked: "⏸",
  failure: "❌",
  unstarted: "⚪",
  carved: "✂️",
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

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const escapeTitle = (value: string) => escapeHtml(value).replaceAll("\n", "&#10;");

const chipTitle = (issue: StatusIssue) => [issue.name, issue.detail].filter(Boolean).join("\n");

/**
 * Is this issue still carvable? Only the unfinished remainder is — an unstarted
 * (future-wave) or parked issue is exactly what a carve would actually drop
 * (ADR 0005). A completed issue is banked and a running one is in flight, so
 * carve would do nothing useful there and gets no control (story 20).
 */
export const isCarvable = (issue: StatusIssue) => issue.status === "unstarted" || issue.status === "parked";

const renderIssueChip = (issue: StatusIssue, project: string, carve: boolean, interactive: boolean) => {
  const detail = chipTitle(issue) || `#${issue.issueNumber}: ${issue.status}`;
  // A live (interactive) chip carries its issue and project so a tap opens the
  // detail sheet — and, under carve, so the panel can route a carve; an archived
  // chip is inert (its turn log lives in a different log than /api/issue reads).
  // Only a still-carvable chip is flagged `data-carvable`, so the panel offers
  // Carve for exactly those (ADR 0005). No control is drawn on the chip itself.
  const openData = interactive || carve ? ` data-issue="${escapeHtml(issue.issueNumber)}" data-project="${escapeHtml(project)}"` : "";
  const carveData = carve && isCarvable(issue) ? ` data-carvable="1"` : "";
  // The chip carries its status class so its border reads that status at 40% alpha
  // (§4); the dot carries the same status at full strength.
  return `<button type="button" class="chip ${issue.status}" title="${escapeTitle(detail)}"${openData}${carveData}><span class="dot ${issue.status}"></span>#${escapeHtml(issue.issueNumber)} <small>${escapeHtml(issue.status)}</small></button>`;
};

const renderWaveContents = (wave: StatusWave, project: string, carve: boolean, interactive: boolean) => `<div class="chips">${wave.issues.map((issue) => renderIssueChip(issue, project, carve, interactive)).join("")}</div>`;

/**
 * The open wave's issue titles, listed under its chips so the wave reads at a
 * glance without hovering every chip. Each line is the resolved title (falling
 * back to just the issue number when none has resolved yet), carrying its status
 * class so a carved issue reads struck-through.
 */
const renderWaveTitles = (wave: StatusWave) =>
  `<ul class="wave-issues">${wave.issues
    .map((issue) => `<li class="wave-issue ${issue.status}">#${escapeHtml(issue.issueNumber)}${issue.name ? ` ${escapeHtml(issue.name)}` : ""}</li>`)
    .join("")}</ul>`;

/**
 * A wave's human label, derived at render from the issue titles the dashboard
 * already resolved — nothing is stored (story: wave names from issue titles). A
 * wave is a file-disjoint layer that crosses epics, so its issues name it, never
 * an epic: a single-issue wave reads as that issue's title, a many-issue wave as
 * its lead issue's title + "+N" for the rest (every issue still carries its own
 * title on its chip). The bare "Wave N" index always leads; the name is appended
 * only once the lead issue's title has resolved, so an unresolved wave keeps the
 * plain index.
 */
const renderWaveLabel = (wave: StatusWave) => {
  const lead = wave.issues[0];
  const index = `Wave ${wave.index + 1}`;
  if (!lead?.name) return index;
  const extra = wave.issues.length - 1;
  return `${index} — ${escapeHtml(lead.name)}${extra > 0 ? ` +${extra}` : ""}`;
};

/** How many issues the campaign spans, across every wave — the count in the
 * `<name> · N issues · M waves` meta line. */
const campaignIssueCount = (status: CampaignStatus) => status.waves.reduce((total, wave) => total + wave.issues.length, 0);

/** A wave's merged tally — how many of its issues have completed, out of its total —
 * shown on the right of an open wave card's head and on a closed wave's chip. */
const waveMerged = (wave: StatusWave) => wave.issues.filter((issue) => issue.status === "completed").length;

const renderOpenWave = (wave: StatusWave, project: string, carve: boolean, interactive: boolean) => {
  // A carved tally beside the merged count, so a wave a carve pruned reads at a
  // glance — the carved chips are a display overlay (ADR 0007), and this counts them.
  const carved = wave.issues.filter((issue) => issue.status === "carved").length;
  const tally = carved ? ` <span class="wave-carved">${carved} carved</span>` : "";
  // A wave card: its label + status pill on the left, its merged/total on the right,
  // its issue chips, then the title list. The section carries the wave status so a
  // running wave gets the blue top accent and an unstarted wave a neutral one.
  return `<section class="wave ${wave.status}"><div class="wave-head"><h2>${renderWaveLabel(wave)} <span class="wave-status ${wave.status}">${wave.status}</span></h2><span class="wave-tally">${waveMerged(wave)}/${wave.issues.length}</span>${tally}</div>${renderWaveContents(wave, project, carve, interactive)}${renderWaveTitles(wave)}</section>`;
};

const renderCompletedWave = (wave: StatusWave, project: string, carve: boolean, interactive: boolean) =>
  `<details class="completed-wave"><summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓</span> ${renderWaveLabel(wave)} <span class="completed-wave-tally">${waveMerged(wave)}/${wave.issues.length}</span></summary>${renderWaveContents(wave, project, carve, interactive)}</details>`;

/** The wave/issue body a status renders — closed waves collapsed into chips, open
 * waves expanded. Shared by the live run and a read-only archived run: the live run
 * renders `interactive` (its chips open the detail sheet and, under carve, route a
 * carve); the archived run passes `interactive: false`, so its chips are inert. */
const renderWaves = (status: CampaignStatus, carve: boolean, interactive: boolean) => {
  if (!status.waves.length) return "<p>No active campaign or queue found.</p>";
  const openWaves = status.waves.filter((wave) => wave.status !== "closed");
  return `${
    status.waves.some((wave) => wave.status === "closed")
      ? `<div class="completed-waves"><div class="completed-wave-bar">${status.waves.filter((wave) => wave.status === "closed").map((wave) => renderCompletedWave(wave, status.project, carve, interactive)).join("")}</div></div>`
      : ""
  }${openWaves.length ? `<div class="waves-grid">${openWaves.map((wave) => renderOpenWave(wave, status.project, carve, interactive)).join("")}</div>` : ""}`;
};

/**
 * The multi-project chrome around a single project's status: the list of every
 * registered project for the dropdown and which one is selected. Omitted when no
 * project list is given (the empty-registry page renders no picker).
 */
export interface StatusPageOptions {
  projects?: string[];
  selected?: string;
  /**
   * Render the per-chip carve control. The aggregated `serveAllStatus` is a dumb
   * router (ADR 0002) with no project's `blockedBy` resolver, so it routes both
   * preview and confirm to the selected project's own install (`carve … --dry-run`
   * then `carve …`); the control carries its `project` so the aggregated `/carve`
   * targets the right one.
   */
  carve?: boolean;
  /** The selected project's archived runs, newest-first, for the "Archived runs"
   * list under the live run. Each links back to `GET /?project=…&run=<token>`; the
   * run's `--name` (when it had one) is the primary label, the timestamp token the
   * fallback, and `summary` the secondary label. */
  archivedRuns?: { run: string; summary: string; name?: string }[];
  /** The archived run's reconstructed status to render read-only below the list,
   * when a `run` token selected one. */
  archived?: CampaignStatus;
  /** The selected run token — marks its list entry current and titles the
   * archived section. */
  archivedRun?: string;
}

const renderProjectPicker = (projects: string[], selected: string | undefined) =>
  `<form method="get" action="/" class="project-picker"><select name="project" onchange="this.form.submit()"><option value="">All repos</option>${projects
    .map((p) => `<option value="${escapeHtml(p)}"${p === selected ? " selected" : ""}>${escapeHtml(p)}</option>`)
    .join("")}</select></form>`;

/**
 * The aggregated site's carve preview: it is a dumb router (ADR 0002) with no
 * project's `blockedBy` resolver, so it does not compute the closure itself — it
 * shows the closure the selected project's own `carve <issue> --dry-run` printed,
 * behind a confirm form (preview-then-confirm parity, story 19/23). Confirming
 * shells `carve` in that project's root. Serves as the no-JS carve fallback.
 */
export const renderAggregatedCarvePreview = (project: string, target: string, previewText: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project)} — carve #${escapeHtml(target)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: #090c10; color: #e6edf3; }
  h1 { letter-spacing: -0.035em; }
  .card { background: #0b0e12; border: 1px solid #232b35; border-left: 3px solid #f79287; border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; }
  pre { white-space: pre-wrap; margin: 0; }
  .actions { display: flex; gap: .75rem; align-items: center; }
  form { margin: 0; }
  button { padding: .5rem .9rem; border: 0; border-radius: 9px; cursor: pointer; font-weight: 700; }
  .confirm button { background: #f79287; color: #2a0a06; }
  a.cancel { color: #8b98a5; text-decoration: none; padding: .5rem .9rem; }
</style>
</head>
<body>
<h1>Carve #${escapeHtml(target)} from ${escapeHtml(project)}?</h1>
<section class="card"><pre>${escapeHtml(previewText)}</pre></section>
<div class="actions">
<form method="post" action="/carve" class="confirm"><input type="hidden" name="taskId" value="${escapeHtml(target)}" /><input type="hidden" name="project" value="${escapeHtml(project)}" /><input type="hidden" name="confirm" value="1" /><button type="submit">✂️ Confirm carve</button></form>
<a class="cancel" href="/?project=${encodeURIComponent(project)}">Cancel</a>
</div>
</body>
</html>`;

/**
 * The issue-detail sheet's markup — one definition rendered by both the campaign
 * page and the all-repos landing (previously hand-synced copies, #76). `carve`
 * includes the in-sheet carve panel: always on the landing (every parked row is
 * carvable), and on the campaign page only when its carve controls are enabled.
 */
export const issueDetailSheetMarkup = (carve: boolean) =>
  `<div id="issue-detail" class="issue-detail" role="dialog" aria-modal="true" aria-live="polite" hidden><div class="issue-detail-sheet"><header class="issue-detail-header"><div class="issue-detail-head-main"><span class="issue-detail-status"><span class="dot"></span><span class="issue-detail-num"></span> <span class="issue-detail-statuslabel"></span></span><h2 class="issue-detail-title"></h2><p class="issue-detail-context"></p></div><button type="button" id="issue-detail-close" class="issue-detail-close" aria-label="Dismiss">&times;</button></header><div class="issue-detail-meta"><div class="meta-tile"><span class="meta-label">Turns</span><span class="meta-value" id="issue-detail-turns"></span></div><div class="meta-tile"><span class="meta-label">Elapsed</span><span class="meta-value" id="issue-detail-elapsed"></span></div></div><ol class="turn-log" id="issue-detail-turnlog"></ol><div id="issue-detail-reply" class="issue-detail-reply" hidden><h3 class="reply-heading">Reply &amp; resume</h3><p class="reply-question" id="reply-question"></p><div class="reply-options" id="reply-options"></div><form method="post" action="/answer" id="reply-form"><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><textarea name="text" id="reply-text" placeholder="Type your reply…"></textarea></form></div><div class="sheet-actions"><button type="submit" form="reply-form" id="reply-resume" class="reply-resume" hidden>Resume</button>${
    carve
      ? `<div id="carve-panel" class="carve-panel" hidden><button type="button" id="carve-start" class="carve-start">Carve</button><span id="carve-explainer" class="carve-explainer" hidden>Removes this issue and everything blocked by it from the running campaign; merged and mergeable work is kept.</span><form method="post" action="/carve" id="carve-confirm" class="carve-confirm" hidden><span class="carve-confirm-text"></span><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><input type="hidden" name="confirm" value="1" /><button type="submit" class="carve-confirm-btn">Confirm</button><button type="button" id="carve-cancel" class="carve-cancel">Cancel</button></form><span id="carve-note" class="carve-note"></span></div>`
      : ""
  }</div></div></div>`;

/**
 * The issue-detail sheet's CSS — one definition included by both pages' `<style>`
 * (previously hand-synced, #76). Covers `.issue-detail-*`, `.meta-*`, `.turn-*`,
 * `.reply-*`, `.sheet-actions`, and the `.carve-*` panel. The `.dot` status
 * colours and the campaign-only `.carve-fallback` noscript styling stay with each
 * page, since those differ between the two.
 */
export const ISSUE_DETAIL_SHEET_STYLES = `  .carve-panel { display: flex; align-items: center; gap: .5rem; }
  /* A flex display beats the UA [hidden] rule, so the carve panel needs it back explicitly. */
  .carve-panel[hidden] { display: none; }
  .carve-start, .carve-confirm-btn, .carve-cancel { padding: .35rem .7rem; border: 1px solid var(--color-red); border-radius: 999px; background: rgb(247 146 135 / 12%); color: var(--color-red); font: inherit; line-height: 1; cursor: pointer; }
  .carve-cancel { border-color: var(--color-secondary); background: none; color: var(--color-text-light-2); }
  .carve-confirm { display: flex; align-items: center; gap: .5rem; margin: 0; }
  .carve-confirm-text { color: var(--color-red); }
  .carve-note { color: var(--color-blue); font-size: .85rem; }
  .carve-explainer { color: var(--color-text-light-2); font-size: .85rem; }
  .issue-detail { position: fixed; inset: 0; z-index: 10; display: none; align-items: center; justify-content: center; padding: 1rem; background: #0009; }
  .issue-detail.show { display: flex; }
  .issue-detail[hidden] { display: none; }
  .issue-detail-sheet { display: flex; flex-direction: column; width: min(640px, 100%); max-height: 85vh; overflow: hidden; background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); box-shadow: 0 18px 48px #0009; }
  .issue-detail-header { position: sticky; top: 0; display: flex; align-items: flex-start; gap: .75rem; padding: 1rem 1.15rem; background: var(--color-box-header); border-bottom: 1px solid var(--color-light-border); }
  .issue-detail-head-main { flex: 1; min-width: 0; }
  .issue-detail-status { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; color: var(--color-text-light-2); }
  .issue-detail-title { margin: .35rem 0 .15rem; font-size: 1.15rem; letter-spacing: -0.01em; color: var(--color-text); }
  .issue-detail-context { margin: 0; font-size: .82rem; color: var(--color-text-light-2); }
  .issue-detail-close { flex: none; background: none; border: 0; color: var(--color-text-light-2); font-size: 1.4rem; line-height: 1; cursor: pointer; padding: .1rem .4rem; border-radius: var(--border-radius); }
  .issue-detail-close:hover { color: var(--color-text); background: var(--color-secondary); }
  .issue-detail-meta { display: flex; gap: .75rem; padding: .9rem 1.15rem; border-bottom: 1px solid var(--color-light-border); }
  .meta-tile { flex: 1; display: flex; flex-direction: column; gap: .2rem; padding: .6rem .75rem; background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); }
  .meta-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-light-2); }
  .meta-value { font-size: 1.25rem; font-weight: 600; color: var(--color-text); }
  .turn-log { list-style: none; margin: 0; padding: .5rem 1.15rem 1.15rem; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
  .turn-entry { display: flex; gap: .6rem; padding: .55rem 0; border-bottom: 1px solid var(--color-light-border); }
  .turn-entry:last-child { border-bottom: 0; }
  .turn-num { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
  ${["completed", "parked", "failure", "running", "unstarted", "carved"].map((s) => `.turn-num.${s} { color: ${stateColor(s)}; }`).join(" ")}
  .turn-summary { color: var(--color-text-light); }
  .turn-empty { color: var(--color-text-light-2); padding: .55rem 0; }
  /* Parked-reply block + the actions row pin to the sheet foot so Resume/Carve stay
     reachable one-handed while the turn log scrolls above. */
  .issue-detail-reply { flex: none; padding: .9rem 1.15rem; border-top: 1px solid var(--color-light-border); background: var(--color-box-header); }
  .reply-heading { margin: 0 0 .5rem; font-size: .95rem; color: var(--color-text-light); }
  .reply-question { margin: 0 0 .6rem; color: var(--color-text-light); white-space: pre-wrap; max-height: 30vh; overflow-y: auto; }
  .reply-options { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .6rem; }
  .reply-option { min-height: 44px; text-align: left; padding: .4rem .7rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; cursor: pointer; }
  .reply-option:hover { border-color: var(--color-primary); background: var(--color-primary-alpha-20); }
  .issue-detail-reply textarea { min-height: 5rem; margin: 0; }
  .sheet-actions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .9rem 1.15rem; border-top: 1px solid var(--color-light-border); }
  /* A flex display beats the UA [hidden] rule, so these need it back explicitly. */
  .sheet-actions[hidden], .reply-options[hidden] { display: none; }
  .reply-resume { min-height: 44px; padding: .5rem 1rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; font: inherit; font-weight: 700; cursor: pointer; }
  @media (max-width: 640px) { .issue-detail-sheet { width: 100%; max-height: 88vh; border-radius: var(--border-radius-medium) var(--border-radius-medium) 0 0; padding-bottom: env(safe-area-inset-bottom); } .issue-detail { align-items: flex-end; padding: 0; } }`;

/**
 * The issue-detail sheet's client script — one definition included by both pages
 * (previously hand-synced, #76). It wires the sheet itself: the element refs,
 * `openIssue`/`renderDetail`/`renderReply`, `closeSheet`, the foot's Resume/Carve
 * visibility, and the carve preview→confirm flow. Each page adds its own trigger
 * wiring around this (the campaign page's issue chips + parked cards; the
 * landing's parked-queue rows), which is what calls `openIssue`.
 */
export const ISSUE_DETAIL_SHEET_SCRIPT = `  const issueDetail = document.getElementById("issue-detail");
  const detailNum = issueDetail.querySelector(".issue-detail-num");
  const detailStatusDot = issueDetail.querySelector(".issue-detail-status .dot");
  const detailStatusLabel = issueDetail.querySelector(".issue-detail-statuslabel");
  const detailTitle = issueDetail.querySelector(".issue-detail-title");
  const detailContext = issueDetail.querySelector(".issue-detail-context");
  const detailTurns = document.getElementById("issue-detail-turns");
  const detailElapsed = document.getElementById("issue-detail-elapsed");
  const detailTurnLog = document.getElementById("issue-detail-turnlog");
  const detailReply = document.getElementById("issue-detail-reply");
  const replyResume = document.getElementById("reply-resume");
  const replyQuestion = document.getElementById("reply-question");
  const replyOptions = document.getElementById("reply-options");
  const replyText = document.getElementById("reply-text");
  const replyForm = document.getElementById("reply-form");
  const sheetActions = document.querySelector(".sheet-actions");
  // The foot (reply + actions) shows only while it holds a live control — a parked
  // reply to send or a carve to offer — so a plain issue's sheet grows no empty bar.
  const updateFoot = () => {
    const carve = document.getElementById("carve-panel");
    const carveShown = Boolean(carve && !carve.hidden);
    sheetActions.hidden = replyResume.hidden && !carveShown;
    // A standalone Carve — offered, not beside a parked issue's Resume, and not yet
    // in its confirm step — gets a plain-words explainer of what a carve does; a
    // parked issue's Resume gives the context instead, so the explainer stays hidden.
    const explainer = document.getElementById("carve-explainer");
    const start = document.getElementById("carve-start");
    if (explainer) explainer.hidden = !carveShown || !replyResume.hidden || (start ? start.hidden : true);
  };
  // Elapsed is a working span in ms; show it as coarse minutes/hours.
  const fmtElapsed = (ms) => {
    const mins = Math.max(0, Math.round((ms || 0) / 60000));
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? h + "h " + m + "m" : h + "h";
  };
  const closeSheet = () => { issueDetail.classList.remove("show"); issueDetail.hidden = true; };
  document.getElementById("issue-detail-close").addEventListener("click", closeSheet);
  // Tap the backdrop (outside the sheet) to dismiss.
  issueDetail.addEventListener("click", (event) => { if (event.target === issueDetail) closeSheet(); });
  // Reassigned by the carve block when carve is enabled; a no-op otherwise.
  let onOpenIssue = () => {};
  // A parked issue's reply block: the full question, the offered options as buttons
  // that fill the field (never submit), and the free-text field itself; Resume posts
  // it through /answer to resume the parked task. Options are best-effort — absent,
  // only the free-text field shows. Any other status hides the whole block.
  const renderReply = (d) => {
    const parked = d.status === "parked";
    detailReply.hidden = !parked;
    replyResume.hidden = !parked;
    if (parked) {
      replyForm.querySelector('input[name="taskId"]').value = d.issueNumber;
      replyForm.querySelector('input[name="project"]').value = d.project;
      const question = d.parked && d.parked.question;
      replyQuestion.textContent = question || "";
      replyQuestion.hidden = !question;
      const options = (d.parked && d.parked.options) || [];
      replyOptions.replaceChildren(...options.map((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "reply-option";
        button.textContent = option;
        button.addEventListener("click", () => { replyText.value = option; replyText.focus(); });
        return button;
      }));
      replyOptions.hidden = !options.length;
    }
    updateFoot();
  };
  const renderDetail = (d) => {
    renderReply(d);
    detailNum.textContent = "#" + d.issueNumber;
    detailStatusDot.className = "dot " + d.status;
    detailStatusLabel.textContent = d.status;
    detailTitle.textContent = d.title || ("Issue #" + d.issueNumber);
    detailContext.textContent = [d.project, d.campaignName].filter(Boolean).join(" · ");
    detailTurns.textContent = String(d.turns);
    detailElapsed.textContent = fmtElapsed(d.elapsedMs);
    detailTurnLog.textContent = "";
    if (!d.turnLog || !d.turnLog.length) {
      const li = document.createElement("li");
      li.className = "turn-empty";
      li.textContent = "No turns recorded yet.";
      detailTurnLog.appendChild(li);
      return;
    }
    // Newest first, as reconstructed; the turn number reads in the issue's status colour.
    for (const t of d.turnLog) {
      const li = document.createElement("li");
      li.className = "turn-entry";
      const n = document.createElement("span");
      n.className = "turn-num " + d.status;
      n.textContent = "Turn " + ((t.turn ?? 0) + 1);
      const s = document.createElement("span");
      s.className = "turn-summary";
      s.textContent = t.summary || "(no summary this turn)";
      li.appendChild(n);
      li.appendChild(s);
      detailTurnLog.appendChild(li);
    }
  };
  const openIssue = async (project, issue, carvable) => {
    issueDetail.hidden = false;
    issueDetail.classList.add("show");
    detailNum.textContent = "#" + issue;
    detailStatusDot.className = "dot";
    detailStatusLabel.textContent = "";
    detailTitle.textContent = "Loading…";
    detailContext.textContent = project;
    detailTurns.textContent = "…";
    detailElapsed.textContent = "…";
    detailTurnLog.textContent = "";
    // Hide the reply block until the fetched status confirms the issue is parked.
    detailReply.hidden = true;
    replyResume.hidden = true;
    onOpenIssue(carvable, project, issue);
    updateFoot();
    try {
      const res = await fetch("/api/issue?project=" + encodeURIComponent(project) + "&issue=" + encodeURIComponent(issue));
      if (!res.ok) throw new Error(String(res.status));
      renderDetail(await res.json());
    } catch {
      detailTitle.textContent = "Couldn't load issue #" + issue;
      detailContext.textContent = project;
    }
  };
  const carvePanel = document.getElementById("carve-panel");
  if (carvePanel) {
    const carveStart = document.getElementById("carve-start");
    const carveConfirm = document.getElementById("carve-confirm");
    const carveConfirmText = carveConfirm.querySelector(".carve-confirm-text");
    const carveTaskId = carveConfirm.querySelector('input[name="taskId"]');
    const carveProject = carveConfirm.querySelector('input[name="project"]');
    let carveTarget = null;
    let carveProj = null;
    const resetCarve = () => {
      carveConfirm.hidden = true;
      carveStart.hidden = false;
      updateFoot();
    };
    // The carve affordance reveals inside the sheet for a carvable issue, keyed off
    // the issue the sheet just opened (ADR 0005); a non-carvable issue hides it.
    onOpenIssue = (carvable, project, issue) => {
      carvePanel.hidden = !carvable;
      if (carvable) {
        carveTarget = issue;
        carveProj = project;
        resetCarve();
      }
    };
    carveStart.addEventListener("click", async () => {
      try {
        const res = await fetch("/carve?preview&taskId=" + encodeURIComponent(carveTarget) + "&project=" + encodeURIComponent(carveProj));
        if (!res.ok) throw new Error(String(res.status));
        // The structured closure (E2): the dependents that would leave (dropped)
        // and the banked work kept (keptBanked). Name each so a confirm discloses
        // the exact closure and never implies merged/mergeable work is discarded.
        const { target, dropped, keptBanked } = await res.json();
        const drops = (dropped || []).filter((id) => id !== target);
        const kept = keptBanked || [];
        carveConfirmText.textContent =
          "Carve #" + target +
          (drops.length ? " — also drops " + drops.map((id) => "#" + id).join(", ") : " — no dependents") +
          (kept.length ? ". Keeps banked (merged or mergeable) " + kept.map((id) => "#" + id).join(", ") : "");
        carveTaskId.value = target;
        carveProject.value = carveProj;
      } catch {
        carveConfirmText.textContent = "Couldn't preview this carve — is a campaign still running?";
        carveTaskId.value = "";
      }
      carveStart.hidden = true;
      carveConfirm.hidden = false;
      updateFoot();
    });
    document.getElementById("carve-cancel").addEventListener("click", resetCarve);
    carveConfirm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!carveTaskId.value) return;
      await fetch("/carve", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ taskId: carveTaskId.value, project: carveProject.value, confirm: "1" }),
      });
      carvePanel.hidden = true;
      document.getElementById("carve-note").textContent = "carving… #" + carveTaskId.value + " will drop from the plan on the next refresh";
    });
  }`;

/**
 * The all-repos landing shell: a client-rendered (vanilla, no build step) page the
 * aggregated server serves at `GET /`, replacing the old server-rendered status
 * page. The server renders only the chrome — the title, the All-repos↔project
 * dropdown, and four empty counter tiles — then the inline script fetches
 * `/api/landing` and mounts the four counters and one card per project. Each card
 * links to that project's campaign view (`/?project=…`); picking a project in the
 * dropdown navigates the same way, and "All repos" returns here. Statuses use the
 * ADR 0007 vocabulary. Single-column and touch-friendly on a phone (44px targets).
 */
export const renderLandingShell = (projects: string[]) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>All repos — sandcastle</title>
<style>
${DASHBOARD_PALETTE_CSS}
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; background: var(--color-body); color: var(--color-text); }
  h1 { font-size: clamp(1.6rem, 4vw, 2.6rem); margin: 0; letter-spacing: -0.035em; }
  .page-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid var(--color-light-border); padding-bottom: 1rem; }
  .project-picker { margin: 0; }
  .project-picker select { min-height: 44px; color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .7rem; font: inherit; cursor: pointer; }
  .project-picker select:hover { border-color: var(--color-primary); }
  .counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 1.25rem 0; }
  .counter { background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; }
  .counter-toggle { font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .counter-toggle:hover:not(:disabled) { background: var(--color-card-hover); }
  .counter-toggle:disabled { cursor: default; }
  .counter-value { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 700; letter-spacing: -0.02em; }
  .counter-toggle:not(:disabled) .counter-value::after { content: " ▸"; color: var(--color-text-light-2); font-size: .9em; }
  .counter-toggle[aria-expanded="true"] .counter-value::after { content: " ▾"; }
  .counter-label { color: var(--color-text-light-2); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; margin-top: .25rem; }
  /* Each counter value reads in its status colour; queued stays neutral (#80). */
  [data-counter="working"] .counter-value { color: var(--color-blue); } [data-counter="parked"] .counter-value { color: var(--color-yellow); } [data-counter="mergedToday"] .counter-value { color: var(--color-green); }
  /* Parked is the one actionable counter — gold border while it holds questions (enabled) (#80). */
  .counter-toggle[data-counter="parked"]:not(:disabled) { border-color: var(--color-yellow); }
  .counter-sub { color: var(--color-text-light-2); font-size: .75rem; margin-top: .2rem; }
  .parked-queue { display: grid; gap: .5rem; margin: -0.5rem 0 1.25rem; }
  /* A grid display beats the UA [hidden] rule, so the collapse needs it back explicitly. */
  .parked-queue[hidden] { display: none; }
  .parked-row { display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline; gap: .3rem .75rem; min-height: 44px; text-decoration: none; color: inherit; background: var(--color-card); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: .7rem 1rem; }
  .parked-row:hover { background: var(--color-card-hover); }
  .parked-issue { font-weight: 700; color: var(--color-yellow); }
  .parked-repo { color: var(--color-primary); font-weight: 600; }
  .parked-question { color: var(--color-text-light); min-width: 0; }
  .parked-waited { color: var(--color-text-light-2); font-size: .85rem; white-space: nowrap; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; }
  .card { display: block; min-height: 44px; text-decoration: none; color: inherit; background: var(--color-card); border: 1px solid var(--color-secondary); border-top: 3px solid var(--color-dim); border-radius: var(--border-radius-medium); padding: 1rem 1.15rem; box-shadow: 0 8px 22px #0004; }
  /* Hover lifts the fill only; the state-coloured top edge never changes on hover (§6). */
  .card:hover { background: var(--color-card-hover); }
  .card-top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
  .card-project { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; }
  .run-state { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-radius: 999px; padding: .2rem .6rem; border: 1px solid var(--color-dim); color: var(--color-dim); }
  .run-state.running { border-color: var(--color-blue); color: var(--color-blue); }
  .run-state.parked { border-color: var(--color-yellow); color: var(--color-yellow); }
  .run-state.failure { border-color: var(--color-failure); color: var(--color-failure); }
  .run-state.completed { border-color: var(--color-green); color: var(--color-green); }
  .card-campaign { color: var(--color-primary); font-weight: 600; margin: .5rem 0 .1rem; }
  .card-meta { color: var(--color-text-light); font-size: .9rem; display: flex; flex-wrap: wrap; gap: .3rem .9rem; margin: .35rem 0; }
  /* A percentMerged-width progress bar under the meta line, coloured by run state (#80). */
  .progress { height: .4rem; background: var(--color-secondary); border-radius: 999px; overflow: hidden; margin: .1rem 0 .55rem; }
  .progress-fill { height: 100%; border-radius: 999px; background: var(--color-dim); }
  .progress-fill.running { background: var(--color-blue); } .progress-fill.parked { background: var(--color-yellow); } .progress-fill.completed { background: var(--color-green); }
  /* The tally reads as status-dot pill chips, matching the campaign page's chips (#80). */
  .card-tally { display: flex; flex-wrap: wrap; gap: .4rem; color: var(--color-text-light); font-size: .8rem; }
  .tally-chip { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--color-secondary); border-radius: 999px; padding: .15rem .5rem; background: var(--color-chip); }
  .card-last { color: var(--color-text-light-2); font-size: .85rem; margin-top: .5rem; white-space: pre-line; }
  .empty { color: var(--color-text-light-2); }
  .feed { margin-top: 2rem; border-top: 1px solid var(--color-light-border); padding-top: 1rem; }
  .feed h2 { color: var(--color-text-light); font-size: 1.1rem; margin: 0 0 .75rem; }
  .feed-row { display: flex; align-items: baseline; gap: .6rem .9rem; flex-wrap: wrap; padding: .5rem 0; border-bottom: 1px solid var(--color-light-border); font-size: .9rem; }
  .feed-time { color: var(--color-text-light-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .feed-kind { color: var(--color-primary); font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  /* Each activity event reads in its comms-category colour (#78). */
  .feed-kind.progress { color: var(--color-blue); } .feed-kind.success { color: var(--color-green); } .feed-kind.attention { color: var(--color-yellow); } .feed-kind.failure { color: var(--color-failure); } .feed-kind.carved { color: var(--color-carved); }
  .feed-text { color: var(--color-text-light); flex: 1; }
  .live-bar { display: inline-flex; align-items: center; gap: .75rem; color: var(--color-text-light-2); font-size: .85rem; }
  .live-indicator { display: inline-flex; align-items: center; gap: .4rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--color-green); }
  .live-indicator::before { content: ""; width: .55rem; height: .55rem; border-radius: 999px; background: currentColor; }
  .live-indicator[data-live-state="paused"] { color: var(--color-yellow); }
  .pause { min-height: 44px; color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .8rem; font: inherit; cursor: pointer; }
  .pause:hover { border-color: var(--color-primary); }
  /* The card's highlight (top border) tracks its run state (#75) — its only coloured edge (§2). */
  .card.running { border-top-color: var(--color-blue); } .card.parked { border-top-color: var(--color-yellow); } .card.failure { border-top-color: var(--color-failure); } .card.completed { border-top-color: var(--color-green); } .card.idle { border-top-color: var(--color-dim); }
  /* Status dot colours, generated once from stateColor and shared with the campaign
     page (§3), scoped to .dot so a state never tints a run-state pill or a whole card. */
  ${STATE_DOT_CSS}
  textarea { width: 100%; max-width: 100%; min-height: 7rem; margin: .5rem 0; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; }
${ISSUE_DETAIL_SHEET_STYLES}
  @media (max-width: 640px) {
    body { padding: 1rem; }
    .counters { grid-template-columns: repeat(2, 1fr); }
    .cards { grid-template-columns: 1fr; }
    .feed { display: none; }
    .parked-row { grid-template-columns: auto 1fr; }
    .parked-question { grid-column: 1 / -1; }
    .live-bar { width: 100%; justify-content: space-between; }
  }
</style>
</head>
<body>
<div class="page-top"><h1>All repos</h1><div class="live-bar" title="Live updates over SSE; pause to freeze the view while it keeps collecting"><span class="live-indicator" data-live-state="live">Live</span><span class="updated" data-updated>waiting for updates</span><button type="button" id="pause" class="pause">Pause</button></div><form method="get" action="/" class="project-picker"><select onchange="location = this.value ? '/?project=' + encodeURIComponent(this.value) : '/'"><option value="" selected>All repos</option>${projects
  .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
  .join("")}</select></form></div>
<section class="counters">
  <div class="counter" data-counter="working"><div class="counter-value">–</div><div class="counter-label">Agents working</div><div class="counter-sub" data-counter-sub="working"></div></div>
  <button type="button" class="counter counter-toggle" data-counter="parked" disabled aria-controls="parked-queue"><div class="counter-value">–</div><div class="counter-label">Parked</div><div class="counter-sub" data-counter-sub="parked"></div></button>
  <div class="counter" data-counter="queued"><div class="counter-value">–</div><div class="counter-label">Queued</div><div class="counter-sub" data-counter-sub="queued"></div></div>
  <div class="counter" data-counter="mergedToday"><div class="counter-value">–</div><div class="counter-label">Merged today</div><div class="counter-sub" data-counter-sub="mergedToday"></div></div>
</section>
<section id="parked-queue" class="parked-queue" hidden aria-label="Parked questions across all repos"></section>
<section id="cards" class="cards"><p class="empty">Loading…</p></section>
<section id="feed" class="feed" aria-label="Recent activity across all repos"><h2>Recent activity</h2><div id="feed-rows"><p class="empty">Loading…</p></div></section>
${issueDetailSheetMarkup(true)}
<script>
  const fmtWave = (w) => (w ? "Wave " + w.current + " of " + w.total : "idle");
  const fmtTime = (ts) => { const d = new Date(ts); return isNaN(d) ? ts : d.toLocaleString(); };
  const fmtWaited = (iso) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms > 0)) return "just now";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + "m";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h";
    return Math.floor(hrs / 24) + "d";
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // Map an event kind to its comms category so the activity feed reads in colour
  // (#78): merges/dones green, a parked question yellow, a halt red, a carve purple,
  // everything else (starts, waves, turns) the in-flight blue.
  const feedKindClass = (kind) => {
    if (["green", "campaign-done", "campaign-complete", "campaign-batch-done", "queue-done"].includes(kind)) return "success";
    if (kind === "parked") return "attention";
    if (kind === "campaign-halt") return "failure";
    if (kind === "carve") return "carved";
    return "progress";
  };
${ISSUE_DETAIL_SHEET_SCRIPT}
  async function loadFeed() {
    const rows = document.getElementById("feed-rows");
    let feed;
    try {
      feed = await (await fetch("/api/feed")).json();
    } catch {
      rows.replaceChildren(el("p", "empty", "Couldn't load the activity feed."));
      return;
    }
    rows.replaceChildren();
    if (!feed.length) { rows.append(el("p", "empty", "No activity yet.")); return; }
    for (const e of feed) {
      const row = el("div", "feed-row");
      row.append(el("span", "feed-time", fmtTime(e.ts)), el("span", "feed-kind " + feedKindClass(e.kind), e.kind), el("span", "feed-text", e.text));
      rows.append(row);
    }
  }
  function renderParked(parked) {
    const toggle = document.querySelector('[data-counter="parked"]');
    const panel = document.getElementById("parked-queue");
    if (!parked.length) { toggle.disabled = true; toggle.removeAttribute("aria-expanded"); panel.hidden = true; return; }
    toggle.disabled = false;
    toggle.setAttribute("aria-expanded", "false");
    panel.replaceChildren(...parked.map((p) => {
      const row = el("a", "parked-row");
      // Keep an href as the no-JS fallback, but open the issue-detail sheet inline so
      // a pending issue shows its detail here instead of a full navigation to the
      // campaign refresh view (#74). Parked issues are always carvable.
      row.href = "/?project=" + encodeURIComponent(p.project);
      row.addEventListener("click", (event) => { event.preventDefault(); openIssue(p.project, p.issueNumber, true); });
      row.append(el("span", "parked-issue", "#" + p.issueNumber), el("span", "parked-repo", p.project), el("span", "parked-question", p.question), el("span", "parked-waited", "waited " + fmtWaited(p.parkedAt)));
      return row;
    }));
    toggle.onclick = () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      panel.hidden = open;
    };
  }
  async function load() {
    let data;
    try {
      const res = await fetch("/api/landing");
      data = await res.json();
    } catch {
      document.getElementById("cards").replaceChildren(el("p", "empty", "Couldn't load the landing — is the server still up?"));
      return;
    }
    for (const [key, val] of Object.entries(data.counters)) {
      const value = document.querySelector('[data-counter="' + key + '"] .counter-value');
      if (value) value.textContent = String(val);
    }
    // Each counter's sublabel, derived client-side from the same payload (#80): working
    // names how many repos have a running agent, parked how long the oldest question has
    // waited (the queue is oldest-first), and the other two carry fixed context.
    const repos = (data.projects || []).filter((p) => p.tally && p.tally.running > 0).length;
    const oldestParked = (data.parked || [])[0];
    const subs = {
      working: "across " + repos + " repo" + (repos === 1 ? "" : "s"),
      parked: oldestParked ? "oldest " + fmtWaited(oldestParked.parkedAt) : "",
      queued: "in later waves",
      mergedToday: "issues closed",
    };
    for (const [key, text] of Object.entries(subs)) {
      const sub = document.querySelector('[data-counter-sub="' + key + '"]');
      if (sub) sub.textContent = text;
    }
    renderParked(data.parked || []);
    const cards = document.getElementById("cards");
    cards.replaceChildren();
    if (!data.projects.length) { cards.append(el("p", "empty", "No projects registered.")); return; }
    for (const p of data.projects) {
      // The card's highlight (top border) tracks its run state (#75).
      const card = el("a", "card " + p.runState);
      card.href = "/?project=" + encodeURIComponent(p.project);
      const top = el("div", "card-top");
      top.append(el("span", "card-project", p.project), el("span", "run-state " + p.runState, p.runState));
      card.append(top);
      if (p.campaignName) card.append(el("div", "card-campaign", p.campaignName));
      const meta = el("div", "card-meta");
      meta.append(el("span", null, fmtWave(p.wave)), el("span", null, p.percentMerged + "% merged"));
      card.append(meta);
      // A percentMerged-width bar under the meta line, filled in the run state's colour (#80).
      const progress = el("div", "progress");
      const fill = el("div", "progress-fill " + p.runState);
      fill.style.width = p.percentMerged + "%";
      progress.append(fill);
      card.append(progress);
      // The tally reads as status-dot chips rather than plain text (#80): running blue,
      // parked yellow, queued neutral — the dots scoped to .dot so they don't tint the pills.
      const tally = el("div", "card-tally");
      for (const [bucket, count] of [["running", p.tally.running], ["parked", p.tally.parked], ["queued", p.tally.queued]]) {
        const chip = el("span", "tally-chip");
        chip.append(el("span", "dot " + bucket), el("span", null, count + " " + bucket));
        tally.append(chip);
      }
      card.append(tally);
      card.append(el("div", "card-last", p.lastEvent));
      cards.append(card);
    }
  }
  // Live updates (ADR 0008): one SSE stream feeds re-reads of the landing as
  // events land. Pause is a client-side presentation freeze — the stream keeps
  // flowing and events keep being collected; resuming re-reads once to flush the
  // whole backlog that arrived while paused. "updated Ns ago" counts from the last
  // time the view actually refreshed, so it visibly ages while paused.
  const indicator = document.querySelector("[data-live-state]");
  const updatedEl = document.querySelector("[data-updated]");
  const pauseBtn = document.getElementById("pause");
  let paused = false;
  let buffered = 0;
  let lastUpdate = null;
  const renderUpdated = () => {
    updatedEl.textContent = lastUpdate == null ? "waiting for updates" : "updated " + Math.round((Date.now() - lastUpdate) / 1000) + "s ago";
  };
  const renderState = () => {
    indicator.dataset.liveState = paused ? "paused" : "live";
    indicator.textContent = paused ? "Paused" + (buffered ? " · " + buffered + " buffered" : "") : "Live";
  };
  // Refresh both the landing and the cross-project feed on every live tick, so the
  // feed (#55) stays current alongside the cards.
  const refresh = async () => { await Promise.all([load(), loadFeed()]); lastUpdate = Date.now(); renderUpdated(); };
  const events = new EventSource("/api/events");
  events.onmessage = () => {
    // Freeze presentation while paused, but keep counting what lands so resume can flush it.
    if (paused) { buffered++; renderState(); return; }
    refresh();
  };
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused && buffered) { buffered = 0; refresh(); }
    renderState();
  });
  renderState();
  setInterval(renderUpdated, 1000);
  refresh();
</script>
</body>
</html>`;

export const renderStatusPage = (status: CampaignStatus, opts: StatusPageOptions = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(status.project)} status</title>
<style>
${DASHBOARD_PALETTE_CSS}
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: var(--color-body); color: var(--color-text); }
  h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: 0; letter-spacing: -0.035em; color: var(--color-text); }
  h2 { color: var(--color-text-light); }
  .campaign-meta { margin: .75rem 0 0; color: var(--color-text-light-2); font-size: .95rem; }
  .campaign-name { color: var(--color-primary); font-weight: 600; letter-spacing: -0.01em; }
  .page-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid var(--color-light-border); padding-bottom: 1rem; }
  .project-picker { margin: 0; }
  .project-picker select { color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .6rem; font: inherit; cursor: pointer; }
  .project-picker select:hover { border-color: var(--color-primary); }
  .live-bar { display: inline-flex; align-items: center; gap: .75rem; color: var(--color-text-light-2); font-size: .85rem; }
  .live-indicator { display: inline-flex; align-items: center; gap: .4rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--color-green); }
  .live-indicator::before { content: ""; width: .55rem; height: .55rem; border-radius: 999px; background: currentColor; }
  .live-indicator[data-live-state="paused"] { color: var(--color-yellow); }
  .pause { min-height: 44px; color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .8rem; font: inherit; cursor: pointer; }
  .pause:hover { border-color: var(--color-primary); }
  .waves-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; margin: 1rem 0; }
  .wave { background: var(--color-card); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; box-shadow: 0 8px 22px #0004; border-top: 3px solid var(--color-dim); }
  .wave.running { border-top-color: var(--color-blue); }
  .wave-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  .wave-head h2 { margin: 0; font-size: 1.1rem; }
  .wave-tally { color: var(--color-text-light-2); font-variant-numeric: tabular-nums; font-size: .9rem; white-space: nowrap; }
  .completed-waves { display: flex; align-items: flex-start; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; color: var(--color-text-light); }
  .completed-wave-chip .check { color: var(--color-green); font-weight: 700; }
  .completed-wave-bar, .chips { display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: .5rem; }
  .completed-wave { display: inline-block; }
  .completed-wave[open] { display: block; flex-basis: 100%; border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; background: var(--color-card); }
  .completed-wave[open] > .completed-wave-chip { display: flex; width: max-content; margin-bottom: .6rem; }
  .completed-wave-chip { cursor: pointer; list-style: none; }
  .completed-wave-chip::-webkit-details-marker { display: none; }
  .chip, .wave-status, .completed-wave-chip { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--color-secondary); border-radius: 999px; padding: .3rem .65rem; background: var(--color-chip); color: var(--color-text); }
  /* An issue chip borders its own status at 40% alpha (§4); the small status word is muted. */
  ${STATE_CHIP_BORDER_CSS}
  .chip small { color: var(--color-text-light-2); }
  /* Hover lifts the chip fill only; its border is unchanged (§6). */
  .chip:hover, .completed-wave-chip:hover { background: var(--color-chip-hover); }
  .wave-status { font-size: .85rem; margin-left: .5rem; text-transform: uppercase; letter-spacing: .03em; }
  .wave-status.closed { border-color: var(--color-green); color: var(--color-green); background: rgb(63 185 132 / 12%); }
  .wave-status.running { border-color: var(--color-blue); color: var(--color-blue); background: rgb(108 182 255 / 12%); }
  .wave-status.unstarted { border-color: var(--color-dim); color: var(--color-dim); background: rgb(95 107 120 / 12%); }
  .wave-carved { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--color-carved); border: 1px solid var(--color-carved); background: rgb(163 113 247 / 12%); border-radius: 999px; padding: .1rem .5rem; }
  .wave-issues { list-style: none; margin: .7rem 0 0; padding: 0; }
  .wave-issue { color: var(--color-text-light); font-size: .9rem; padding: .15rem 0; }
  .wave-issue.carved { color: var(--color-text-light-2); text-decoration: line-through; }
  /* Status dot colours, generated once from stateColor and shared with the landing
     (§3), scoped to .dot so a state never tints a whole chip, card, or list row (#81). */
  ${STATE_DOT_CSS}
  textarea { width: 100%; max-width: 100%; min-height: 7rem; margin: .5rem 0; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; }
  button.chip { cursor: pointer; color: inherit; font: inherit; }
${ISSUE_DETAIL_SHEET_STYLES}
  .carve-fallback form { display: inline; }
  form button { padding: .5rem .8rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; cursor: pointer; font-weight: 700; }
  .parked-issues { margin: 1rem 0 2rem; }
  .parked-issues > h2 { display: flex; align-items: baseline; flex-wrap: wrap; gap: .35rem; }
  .parked-count { color: var(--color-yellow); }
  .parked-card { display: block; text-decoration: none; color: inherit; background: var(--color-card); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: .8rem 1rem; margin: .5rem 0; box-shadow: 0 8px 22px #0004; }
  /* Hover lifts the fill only; the amber left edge (the human-action queue, §2) stays. */
  .parked-card:hover { background: var(--color-card-hover); }
  .parked-card-title { color: var(--color-text-light); }
  .parked-issue { font-weight: 700; color: var(--color-yellow); }
  .parked-card-meta { color: var(--color-text-light-2); font-size: .85rem; margin-top: .35rem; }
  .parked-waited { white-space: nowrap; }
  .run-summary { color: var(--color-text-light-2); font-size: .85rem; font-weight: 400; }
</style>
</head>
<body>
<div class="page-top">${
  opts.projects?.length ? renderProjectPicker(opts.projects, opts.selected ?? status.project) : `<h1>${escapeHtml(status.project)}</h1>`
}<div class="live-bar" title="Live updates over SSE; pause to freeze the view while it keeps collecting"><span class="live-indicator" data-live-state="live">Live</span><span class="updated" data-updated>waiting for updates</span><button type="button" id="pause" class="pause">Pause</button></div></div>
${
  status.waves.length
    ? `<p class="campaign-meta">${status.name ? `<span class="campaign-name">${escapeHtml(status.name)}</span> · ` : ""}${campaignIssueCount(status)} issue${campaignIssueCount(status) === 1 ? "" : "s"} · ${status.waves.length} wave${status.waves.length === 1 ? "" : "s"}</p>`
    : ""
}
${
  status.parked.length
    ? `<section class="parked-issues"><h2>Parked · <span class="parked-count">${status.parked.length}</span></h2>${status.parked
        .map(
          // A clickable question card that opens the issue-detail sheet (the reply now
          // happens there — no inline /answer form). The href to the campaign view is
          // the no-JS fallback; parked issues are always carvable, so under carve the
          // card carries data-carvable so the sheet offers Carve (ADR 0005).
          (p) => `<a class="parked-card" href="/?project=${encodeURIComponent(status.project)}" data-issue="${escapeHtml(p.issueNumber)}" data-project="${escapeHtml(status.project)}"${opts.carve ? ` data-carvable="1"` : ""}><div class="parked-card-title"><span class="parked-issue">#${escapeHtml(p.issueNumber)}</span> ${escapeHtml(p.description)}</div><div class="parked-card-meta">waiting <span class="parked-waited" data-parked-at="${escapeHtml(p.parkedAt)}">…</span> · ${escapeHtml(p.reason)}</div></a>`,
        )
        .join("")}</section>`
    : ""
}
${renderWaves(status, Boolean(opts.carve), true)}
${
  opts.archivedRuns?.length
    ? `<section class="archived-runs"><h2>Archived runs</h2><ul>${opts.archivedRuns
        .map(
          (run) =>
            `<li><a href="/?project=${encodeURIComponent(opts.selected ?? status.project)}&amp;run=${encodeURIComponent(run.run)}"${
              run.run === opts.archivedRun ? ` aria-current="true"` : ""
            }>${escapeHtml(run.name ?? run.run)}</a> <span class="run-summary">${escapeHtml(run.summary)}</span> <a href="/archive/log?project=${encodeURIComponent(opts.selected ?? status.project)}&amp;run=${encodeURIComponent(run.run)}">raw log</a></li>`,
        )
        .join("")}</ul></section>`
    : ""
}
${
  // The selected archived run's own wave/issue view, rendered read-only: `carve:
  // false` so its chips carry no carve affordance, and no parked/answer form (a
  // finished run has nothing to act on). Additive — the live run stays above.
  opts.archived
    ? `<section class="archived-run"><h2>Archived run ${
        opts.archived.name ? `${escapeHtml(opts.archived.name)} <small class="run-summary">${escapeHtml(opts.archivedRun ?? "")}</small>` : escapeHtml(opts.archivedRun ?? "")
      }</h2>${renderWaves(opts.archived, false, false)}</section>`
    : ""
}
${issueDetailSheetMarkup(Boolean(opts.carve))}${
  // No-JS fallback: a plain server-side form per carvable issue that reaches
  // POST /carve → the preview page → confirm without any JavaScript. The inline
  // panel above is the progressive enhancement layered over it.
  opts.carve && status.waves.some((wave) => wave.issues.some(isCarvable))
    ? `<noscript><section class="carve-fallback"><h2>Carve</h2>${status.waves
        .flatMap((wave) => wave.issues)
        .filter(isCarvable)
        .map(
          (issue) =>
            `<form method="post" action="/carve"><input type="hidden" name="taskId" value="${escapeHtml(issue.issueNumber)}" /><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit">Carve #${escapeHtml(issue.issueNumber)}</button></form>`,
        )
        .join("")}</section></noscript>`
    : ""
}
<script>
  // A parked card's "waiting Nm" ages off its parkedAt, filled client-side so the
  // server render stays pure (mirrors the landing's fmtWaited).
  const fmtWaited = (iso) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms > 0)) return "just now";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + "m";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h";
    return Math.floor(hrs / 24) + "d";
  };
  for (const waited of document.querySelectorAll(".parked-waited[data-parked-at]")) waited.textContent = fmtWaited(waited.dataset.parkedAt);
  // A reply being composed anywhere (a parked card's sheet reply) must never be lost
  // to a live reload; this guards the reload the way the old fixed-interval one did.
  const isComposing = () =>
    [...document.querySelectorAll("textarea")].some((el) => el === document.activeElement || el.value.trim() !== "");
  // Live updates (ADR 0008): this page is server-rendered, so a live event reloads the
  // whole page rather than re-fetching a model. The reload is guarded (never while a
  // reply is being composed) and pausable — a client-side presentation freeze that
  // keeps counting what lands and flushes on resume, the landing's live-bar behaviour.
  const indicator = document.querySelector("[data-live-state]");
  const updatedEl = document.querySelector("[data-updated]");
  const pauseBtn = document.getElementById("pause");
  let paused = false;
  let buffered = 0;
  const lastUpdate = Date.now();
  const renderUpdated = () => { updatedEl.textContent = "updated " + Math.round((Date.now() - lastUpdate) / 1000) + "s ago"; };
  const renderState = () => {
    indicator.dataset.liveState = paused ? "paused" : "live";
    indicator.textContent = paused ? "Paused" + (buffered ? " · " + buffered + " buffered" : "") : "Live";
  };
  const events = new EventSource("/api/events");
  events.onmessage = () => {
    // Freeze while paused or mid-compose; count what lands so a resume can flush it.
    if (paused || isComposing()) { buffered++; renderState(); return; }
    location.reload();
  };
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused && buffered && !isComposing()) location.reload();
    renderState();
  });
  renderState();
  renderUpdated();
  setInterval(renderUpdated, 1000);
${ISSUE_DETAIL_SHEET_SCRIPT}
  // A live chip and a parked card both open the sheet, carrying their issue+project.
  // The parked card is an <a> with a no-JS href, so its click is prevented before the
  // sheet opens; a chip is a button, where preventDefault is harmless.
  document.querySelectorAll(".chip[data-issue], .parked-card[data-issue]").forEach((el) =>
    el.addEventListener("click", (event) => { event.preventDefault(); openIssue(el.dataset.project, el.dataset.issue, el.dataset.carvable === "1"); }));
</script>
</body>
</html>`;
