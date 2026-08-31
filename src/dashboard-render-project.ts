import {
  type ArchivedRunState,
  type CampaignStatus,
  campaignState,
  inFlightRunning,
  type StatusIssue,
  type StatusWave,
  waveLabel,
} from "./dashboard-model.ts";
import { festiveWaveName } from "./festive-names.ts";
import type { LogDotState } from "./log-view.ts";
import {
  ARCHIVE_LIST_SCRIPT,
  DASHBOARD_PALETTE_CSS,
  GRAFT_SCRIPT,
  HOST_LOG_SCRIPT,
  HOST_LOG_STYLES,
  ISSUE_DETAIL_SHEET_SCRIPT,
  ISSUE_DETAIL_SHEET_STYLES,
  LIVE_TAIL_SCRIPT,
  LIVE_TAIL_STYLES,
  REDRIVE_SCRIPT,
  REPO_DROPDOWN_SCRIPT,
  STATE_CHIP_BORDER_CSS,
  STATE_DOT_CSS,
  TOP_BAR_STYLES,
} from "./dashboard-assets.ts";
import { dotClass, freezeIntent, graftCarry, reasonWord, redriveAllowed, resumeIntent } from "./dashboard-visual-state.ts";
import {
  escapeHtml,
  escapeTitle,
  type RepoOption,
  renderHostLog,
  renderRepoDropdown,
  renderTopBar,
} from "./dashboard-render.ts";
import {
  hasConflict,
  isPrunable,
  issueDetailSheetMarkup,
  renderConflictNote,
  renderGraftInline,
} from "./dashboard-render-issue.ts";

const chipTitle = (issue: StatusIssue) => [issue.name, issue.detail].filter(Boolean).join("\n");

/**
 * The whole-campaign Redrive control (design §7, §11, #325). Redrive picks up an unfinished
 * campaign — it is not a per-issue move, so it lives here on the project page beside graft,
 * never on the issue sheet. It is a *risky* action (the observed bug: fired on a draining
 * wave, it spawned a second campaign process over the live one), so it is rendered greyed-out
 * with a one-line reason unless `gate.allowed` — the pure {@link redriveAllowed} rule off the
 * campaign fold and the live-lease probe. Enabled, the button opens a confirm dialog naming
 * exactly what a redrive will do (the campaign, the wave it re-enters, its members, the base)
 * with Cancel the default; only Confirm POSTs `/redrive`, which the aggregated dumb router
 * (ADR 0002) shells in the project's own root. A campaign-less page renders nothing.
 *
 * `baseBranch` is the base the redrive lands on, read live from the project checkout by the
 * page (the dumb router has no config to read it from); when unknown the dialog says so.
 */
export const renderRedriveControl = (status: CampaignStatus, gate: { allowed: boolean; reason: string }, baseBranch?: string) => {
  if (!status.waves.length) return "";
  const openBtn = `<button type="button" class="redrive-btn" data-redrive-open${gate.allowed ? "" : " disabled"}>Redrive</button>`;
  if (!gate.allowed) return `<div class="redrive-control">${openBtn}<span class="redrive-reason">${escapeHtml(gate.reason)}</span></div>`;
  // The resume wave is the first not-fully-completed wave (design §7); its non-pruned members
  // are what a redrive re-enters. The name falls back to the project key for an unnamed run.
  const resume = status.waves.find((wave) => wave.status !== "completed");
  const members = (resume?.issues ?? []).filter((issue) => issue.membership !== "pruned").map((issue) => `#${escapeHtml(issue.issueNumber)}`).join(", ");
  const text = `Redrive <strong>${escapeHtml(status.name || status.project)}</strong>: re-enters wave ${(resume?.index ?? 0) + 1} — ${members} — on <code>${escapeHtml(baseBranch ?? "the base branch")}</code>`;
  const dialog = `<dialog class="redrive-dialog" data-redrive-dialog><p class="redrive-dialog-text">${text}</p><form method="post" action="/redrive" class="redrive-dialog-actions" data-redrive-form><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="button" class="redrive-cancel" data-redrive-cancel autofocus>Cancel</button><button type="submit" class="redrive-confirm" data-redrive-confirm>Redrive</button></form></dialog>`;
  return `<div class="redrive-control">${openBtn}${dialog}</div>`;
};

/**
 * One issue's member row — the single line a wave card gives each of its issues,
 * merging what used to be a status chip and a separate title line into one row:
 * status dot + `#NNN` + resolved title (falling back to just the number until a
 * title resolves) + the status word, right-aligned. The row is the interactive
 * element: a live (interactive) row carries its issue and project so a tap opens
 * the detail sheet — and, under prune, so the panel can route a prune. An archived
 * row is interactive too and additionally carries its `run` token, so the shared
 * sheet reads that run's own log (its turn log lives there, not in the live log);
 * it is never prunable, so the read-only archive offers no Prune (ADR 0005). Only
 * a still-prunable row is flagged `data-prunable`; a pruned row reads struck-through
 * off its status class. No control is drawn on the row.
 */
const renderWaveMember = (issue: StatusIssue, project: string, prune: boolean, interactive: boolean, run?: string) => {
  const detail = chipTitle(issue) || `#${issue.issueNumber}: ${issue.status}`;
  const openData = interactive || prune ? ` data-issue="${escapeHtml(issue.issueNumber)}" data-project="${escapeHtml(project)}"${run ? ` data-run="${escapeHtml(run)}"` : ""}` : "";
  const pruneData = prune && isPrunable(issue) ? ` data-prunable="1"` : "";
  const title = issue.name ? `<span class="wave-member-title">${escapeHtml(issue.name)}</span>` : "";
  // Compose the two orthogonal axes (ADR 0019): the lifecycle class colours the left
  // edge (§4) and its dot at full strength, and the word spells it out; the membership
  // (a `grafted`/`pruned` chip) rides a separate class + badge, never a lifecycle word.
  const membership = issue.membership ?? "member";
  const memberClass = membership !== "member" ? ` ${membership}` : "";
  const badge = membership !== "member" ? `<span class="member-badge ${membership}">${escapeHtml(membership)}</span>` : "";
  return `<li><button type="button" class="wave-member ${issue.status}${memberClass}" title="${escapeTitle(detail)}"${openData}${pruneData}><span class="dot ${dotClass(issue.status)}"></span>#${escapeHtml(issue.issueNumber)} ${title}${badge}<small>${escapeHtml(issue.status)}</small></button></li>`;
};

/** A wave's member list — one interactive row per issue (see `renderWaveMember`),
 * the single block that replaced the old chip row + title list. */
const renderWaveMembers = (wave: StatusWave, project: string, prune: boolean, interactive: boolean, run?: string) =>
  `<ul class="wave-members">${wave.issues.map((issue) => renderWaveMember(issue, project, prune, interactive, run)).join("")}</ul>`;

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
const renderWaveLabel = (wave: StatusWave, festiveName?: string) => {
  const lead = wave.issues[0];
  // The title is escaped before it reaches the shared `waveLabel`, whose output lands in HTML.
  // A resolved festive name (the gear toggle on) switches the label to `index · name`.
  return waveLabel(wave.index, lead?.name ? escapeHtml(lead.name) : undefined, wave.issues.length - 1, festiveName ? { name: festiveName, surface: "card" } : undefined);
};

/** The festive name for a wave when the gear toggle is on and the run reserved an offset
 * block (#193) — `festiveWaveName(offset, wave.index)`; undefined when festive is off or
 * the run predates the feature (no offset), so the label degrades to the plain `Wave N`. */
const festiveNameFor = (status: CampaignStatus, wave: StatusWave, festive: boolean): string | undefined =>
  festive && status.festiveOffset !== undefined ? festiveWaveName(status.festiveOffset, wave.index) : undefined;

/** How many issues the campaign spans, across every wave — the count in the
 * `<name> · N issues · M waves` meta line. */
const campaignIssueCount = (status: CampaignStatus) => status.waves.reduce((total, wave) => total + wave.issues.length, 0);

/** A wave's merged tally — how many of its issues have completed, out of its total —
 * shown on the right of an open wave card's head and on a closed wave's chip. */
const waveMerged = (wave: StatusWave) => wave.issues.filter((issue) => issue.status === "completed").length;

/**
 * One wave card — the single card component both an open (running/queued) wave and
 * an expanded closed wave render as (they must not fork): its label + status pill on
 * the left, its merged/total on the right, then one member row per issue. The
 * section carries the wave status so a running wave gets the blue top accent, a
 * closed one the green, and an unstarted one a neutral edge. `extraAttrs` lets a
 * closed card carry the id + `hidden` its toggle chip drives.
 */
const renderWaveCard = (wave: StatusWave, project: string, prune: boolean, interactive: boolean, extraAttrs = "", run?: string, festiveName?: string) => {
  // A pruned tally folded into the head's meta group beside the merged count, so a wave
  // a prune pruned reads at a glance — the pruned rows are a display overlay (ADR 0007),
  // and this counts them. The label sits in its own element so a long one wraps within
  // itself without shoving the meta group (tally · state · pruned) onto its own line.
  const pruned = wave.issues.filter((issue) => issue.membership === "pruned").length;
  const tally = pruned ? `<span class="wave-pruned">${pruned} pruned</span>` : "";
  // A wave holding a freshly-grafted issue (#202) is marked so its edge pulses the teal
  // accent once when it appears — the graft confirming on the wave (option 1a).
  const grafted = wave.issues.some((issue) => issue.membership === "grafted") ? " has-grafted" : "";
  return `<section class="wave ${wave.status}${grafted}"${extraAttrs}><div class="wave-head"><h2 class="wave-label">${renderWaveLabel(wave, festiveName)}</h2><div class="wave-meta"><span class="wave-tally">${waveMerged(wave)}/${wave.issues.length}</span><span class="wave-status ${wave.status}">${wave.status}</span>${tally}</div></div>${renderWaveMembers(wave, project, prune, interactive, run)}</section>`;
};

/** A closed wave's compact toggle chip — the affordance that reveals its full card in
 * the grid. `aria-controls`/`aria-expanded` (+ the client script) make it keyboard-
 * operable and expose its state; the chevron and green accent are CSS keyed off
 * `aria-expanded`. Only the compact "Wave N" + merged tally rides the chip; the lead
 * title and issue list live on the card it opens. */
const renderClosedWaveChip = (wave: StatusWave, festiveName?: string) =>
  `<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-${wave.index}" data-wave="${wave.index}"><span class="check" aria-hidden="true">✓</span> ${waveLabel(wave.index, undefined, 0, festiveName ? { name: festiveName, surface: "card" } : undefined)} <span class="completed-wave-tally">${waveMerged(wave)}/${wave.issues.length}</span></button>`;

/** The wave/issue body a status renders. On the live run (`collapsible`), closed waves
 * show as a compact toggle row of chips directly above the wave grid; each chip reveals
 * that wave's full card — the same card an open wave renders — in the grid, before the
 * open waves and in wave order (the client script drives which are open, persisted
 * across a live reload). The read-only archived run passes `collapsible: false`: it has
 * no live toggle script (and would collide on the `closed-wave-N` ids), so it renders
 * every wave as a full card, expanded. `interactive` (the live run) makes chips open the
 * detail sheet and, under prune, route a prune; the archived run passes it `false`. */
const renderWaves = (status: CampaignStatus, prune: boolean, interactive: boolean, collapsible = true, run?: string, festive = false) => {
  if (!status.waves.length) return "<p>No active campaign or queue found.</p>";
  if (!collapsible) return `<div class="waves-grid">${status.waves.map((wave) => renderWaveCard(wave, status.project, prune, interactive, "", run, festiveNameFor(status, wave, festive))).join("")}</div>`;
  const closedWaves = status.waves.filter((wave) => wave.status === "completed");
  const openWaves = status.waves.filter((wave) => wave.status !== "completed");
  const toggleRow = closedWaves.length
    ? `<div class="completed-waves"><div class="completed-wave-bar" data-project="${escapeHtml(status.project)}">${closedWaves.map((wave) => renderClosedWaveChip(wave, festiveNameFor(status, wave, festive))).join("")}</div></div>`
    : "";
  // The grid holds every closed card (hidden until its chip toggles it open) before
  // the open ones, in wave order; it renders whenever there is any wave to show.
  const cards = [
    ...closedWaves.map((wave) => renderWaveCard(wave, status.project, prune, interactive, ` id="closed-wave-${wave.index}" hidden`, undefined, festiveNameFor(status, wave, festive))),
    ...openWaves.map((wave) => renderWaveCard(wave, status.project, prune, interactive, "", undefined, festiveNameFor(status, wave, festive))),
  ];
  return `${toggleRow}${cards.length ? `<div class="waves-grid">${cards.join("")}</div>` : ""}`;
};

/** The `<name> · N issues · M waves` campaign summary line. Split out so the graft
 * affordance (1a) can ride alongside it on the summary row without disturbing the exact
 * `<p class="campaign-meta">` string every non-graft surface renders. */
const renderCampaignMeta = (status: CampaignStatus) =>
  `<p class="campaign-meta">${status.name ? `<span class="campaign-name">${escapeHtml(status.name)}</span> · ` : ""}${campaignIssueCount(status)} issue${campaignIssueCount(status) === 1 ? "" : "s"} · ${status.waves.length} wave${status.waves.length === 1 ? "" : "s"}</p>`;

const ARCHIVE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A run's start time rendered as `Aug 23, 2026 · 15:22:36` from its ISO timestamp,
 * in the operator's local timezone (the gateway runs in it) — the human-facing chrome
 * localizes; the raw-log pane keeps the JSONL's UTC stamps verbatim (#102). */
const formatRunWhen = (iso: string) => {
  const d = new Date(iso);
  return `${ARCHIVE_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/**
 * An archived run's terminal disposition → the shared log-view dot state its `.lv-dot`
 * paints through (#248). The `.lv-dot` palette is keyed on `LogDotState` names, not the
 * run's own `complete`/`stalled`, so the row translates rather than minting new dot
 * variants: `complete` reads the success green (`merged`), `stalled` the held-attention
 * amber (`parked`) — the colours the bespoke `.archive-dot` carried before.
 */
const ARCHIVE_DOT_STATE: Record<ArchivedRunState, LogDotState> = {
  complete: "merged",
  stalled: "parked",
};

/**
 * One archived-run row rendered through the shared log-view control (#248): a collapsed
 * `.lv-row` head — the when-time in the dim `.lv-t` tier, a mapped `.lv-dot` (see
 * `ARCHIVE_DOT_STATE`), the run name as the brightest `.lv-lead` and the disposition
 * `state · N issues` as the dim `.lv-verb` — over a hidden body. The `.lv-row` is emitted
 * as the clickable `<button>` head of the expandable row (`aria-expanded`/`aria-controls`
 * wiring keeps it keyboard-operable), so an archived run reads as the same component the
 * live tail / feed / host-log use rather than bespoke `.archive-*` chrome. An archived run
 * is a campaign artifact, so its detail is the wave cards only — the body reuses the live
 * wave renderer read-only (`prune`/`collapsible` off, `interactive` on) so its member chips
 * open the shared issue-detail sheet scoped to this run. There is no run-level log pane.
 * `open` marks the row a `?run=` deep-link selected.
 */
const renderArchiveRow = (run: ArchivedRunView, open: boolean, festive = false) => {
  const label = run.name ?? run.run;
  const when = run.startedAt ? formatRunWhen(run.startedAt) : run.run;
  const bodyId = `archive-body-${run.run}`;
  const count = `${run.issues} issue${run.issues === 1 ? "" : "s"}`;
  // Interactive (chips open the shared sheet) but prune-off, and carrying the run
  // token so the sheet reads this archived run's own log — reuse is the point, no
  // second campaign renderer.
  const body = renderWaves(run.status, false, true, false, run.run, festive);
  return (
    `<li${open ? ' class="open"' : ""} data-run="${escapeHtml(run.run)}">` +
    `<button type="button" class="lv-row" aria-expanded="${open}" aria-controls="${bodyId}">` +
    `<span class="lv-t">${escapeHtml(when)}</span>` +
    `<span class="lv-dot ${ARCHIVE_DOT_STATE[run.state]}"></span>` +
    `<span class="lv-msg"><span class="lv-lead">${escapeHtml(label)}</span><span class="lv-verb">${run.state} · ${count}</span></span>` +
    `</button>` +
    `<div class="archive-body" id="${bodyId}"${open ? "" : " hidden"}>${body}</div>` +
    `</li>`
  );
};

/**
 * The archived-runs list under the shared log-view chrome (#256): the same `.tail-head`
 * control bar the live-tail / feed / host-log carry — an "Archived runs" static title and
 * a substring filter (`data-archive-filter`) — over a scrollable pane of one `.lv-row`
 * per run, newest-first (the order given). Every run renders (no show-older cap — the pane
 * scrolls, like the feed), and the stream-only affordances are deliberately absent: an
 * archived list is static and non-downloadable, so no follow/pause and no Download JSON
 * `.lv-ico`. Empty when the project has no archived runs. `openRun` opens one row on load
 * from a `?run=` deep-link.
 */
const renderArchivedRuns = (project: string, runs: ArchivedRunView[], openRun?: string, festive = false) => {
  if (!runs.length) return "";
  const rows = runs.map((run) => renderArchiveRow(run, run.run === openRun, festive));
  return (
    `<section class="archived-runs">` +
    `<div class="tail-head">` +
    `<span class="tail-title tail-title-static">Archived runs</span>` +
    `<span class="tail-gap"></span>` +
    `<span class="tail-controls">` +
    `<input type="text" class="tail-filter" placeholder="filter runs…" aria-label="Filter archived runs" data-archive-filter />` +
    `</span>` +
    `</div>` +
    `<ul class="archive-list" data-project="${escapeHtml(project)}">${rows.join("")}</ul>` +
    `</section>`
  );
};

/**
 * The multi-project chrome around a single project's status: the list of every
 * registered project for the dropdown and which one is selected. Omitted when no
 * project list is given (the empty-registry page renders no picker).
 */
export interface StatusPageOptions {
  projects?: readonly (string | RepoOption)[];
  selected?: string;
  /**
   * Render the per-chip prune control. The aggregated `serveAllStatus` is a dumb
   * router (ADR 0002) with no project's `blockedBy` resolver, so it routes both
   * preview and confirm to the selected project's own install (`prune … --dry-run`
   * then `prune …`); the control carries its `project` so the aggregated `/prune`
   * targets the right one.
   */
  prune?: boolean;
  /**
   * Render the graft control — the additive counterpart to `prune`. `graft` is
   * variadic and adds *new* issues by explicit id (not a chip selection), so its
   * control is a small form the operator types ids into; the aggregated dumb router
   * routes its preview and confirm to the selected project's own install (`graft …
   * --dry-run` then `graft …`). Gated by the same page option prune rides.
   */
  graft?: boolean;
  /** The selected project's archived runs, newest-first, for the collapsible
   * "Archived runs" list under the live run. Each row expands inline to its wave-card
   * grid, rendered read-only through the live wave renderer off `status`. */
  archivedRuns?: ArchivedRunView[];
  /** The selected run token — the row to open on load (a `?run=` deep-link);
   * absent leaves every row collapsed. */
  archivedRun?: string;
  /** "Festive Wave Names" — when on (the gear toggle, read server-side from the
   * `festiveWaveNames` cookie), each wave is labelled `index · name` after a Discworld
   * character instead of the plain `Wave N` (#193). Default off. */
  festive?: boolean;
  /** Whether a campaign process for this project still holds the host lease — the same
   * live-lease probe crash detection reads (design §7, §8). It gates the Redrive campaign
   * control through {@link redriveAllowed}: a live lease means a process to collide with, so
   * redrive stays disabled. Absent reads as no live lease (a pure caller with none to probe). */
  leaseLive?: boolean;
  /** The base branch a redrive lands on, read live from the project checkout by the page —
   * named in the Redrive confirm dialog. Absent leaves the dialog saying "the base branch". */
  baseBranch?: string;
}

/**
 * One archived run as the collapsible list renders it: its timestamp token, its
 * `--name` (falling back to the token), its start time (parsed from the token) and
 * terminal state for the collapsed row, its issue count, and the reconstructed
 * `CampaignStatus` its expanded body renders read-only through the live wave
 * renderer (reuse is the point — no second campaign renderer).
 */
export interface ArchivedRunView {
  run: string;
  name?: string;
  startedAt?: string;
  state: ArchivedRunState;
  issues: number;
  status: CampaignStatus;
}

/**
 * The live raw-log tailing pane (#124): a collapsible card that merges the raw JSONL
 * activity of every currently-running agent into one issue-keyed, following view. The
 * server renders the shell — header (tail status dot, disclosure title, agent-count
 * summary) and the open-only controls (issue dropdown seeded with the running issues,
 * substring filter, play/pause, save, clear) — plus an empty body/footer the client
 * fills from the `/api/events` SSE `tail` frames. The pane holds its space at all times
 * (#330): with no runner it seeds *collapsed* — the head bar stays, `aria-expanded="false"`
 * and the controls/body/footer folded — rather than `hidden` (which dropped it from the
 * layout and reflowed the board on every gap between agents). The client re-expands it when
 * an agent returns unless the operator folded it themselves. Status vocabulary is ours (ADR
 * 0007): the gutter/dot colours key off each running issue's `IssueStatus`, never the
 * mockup's `queued`. The body's JSON colouring and line accumulation are wired in the
 * client script (`LIVE_TAIL_SCRIPT`), reusing `highlightJsonLine`.
 */
export const renderLiveTail = (status: CampaignStatus, streaming = true) => {
  // Only the runners of the wave in flight (design §11) — never a ghost still reading `running` in
  // a wave that has advanced or one not yet in flight, which a racy/partial log can leave behind.
  const running = inFlightRunning(status);
  // With no runner the pane rests collapsed rather than removed (#330): the head bar holds its
  // space and the summary reads exactly `no agents running` — never `0 agents`, and the client's
  // renderSummary seeds the identical string, since it overwrites this span on the first frame.
  const collapsed = running.length === 0;
  const hide = collapsed ? " hidden" : "";
  const summary = collapsed ? "no agents running" : `${running.length} agent${running.length === 1 ? "" : "s"}`;
  const issueRow = (issue: string, dot: string, label: string) =>
    `<li class="tail-issue-option" role="option" data-issue="${escapeHtml(issue)}"><span class="dot ${dot}"></span>${escapeHtml(label)}</li>`;
  const options = [
    issueRow("", "all", "all agents"),
    ...running.map((issue) => issueRow(issue.issueNumber, dotClass(issue.status), `#${issue.issueNumber}`)),
  ].join("");
  // Each running issue and its status colour, so the client can colour a line's gutter by
  // its issue and rebuild the dropdown as agents come and go over the SSE.
  const agentsJson = escapeHtml(JSON.stringify(running.map((issue) => ({ issue: issue.issueNumber, status: issue.status }))));
  // A streaming source follows/pauses and its dot pulses live; a static (archived) source has no
  // stream to follow, so the play/pause control is omitted and the dot is seeded idle (#203).
  const playBtn = streaming ? `<button type="button" class="lv-ico lv-pause" data-tail-play data-following="true" aria-label="Pause"></button>` : "";
  const dot = streaming ? `<span class="tail-dot" data-tail-dot aria-hidden="true"></span>` : `<span class="tail-dot" data-tail-dot data-state="idle" aria-hidden="true"></span>`;
  return (
    `<section class="live-tail" data-live-tail data-project="${escapeHtml(status.project)}" data-agents="${agentsJson}">` +
    `<div class="tail-head">` +
    dot +
    `<button type="button" class="tail-title" data-tail-toggle aria-expanded="${collapsed ? "false" : "true"}"><span class="tail-caret" aria-hidden="true"></span>Live tail · agent logs</button>` +
    `<span class="tail-summary" data-tail-summary>${summary}</span>` +
    `<span class="tail-gap"></span>` +
    `<span class="tail-controls" data-tail-controls${hide}>` +
    `<span class="tail-issue-dd" data-tail-issue-dd><button type="button" class="tail-issue-trigger" data-tail-issue-trigger aria-haspopup="listbox" aria-expanded="false"><span class="dot all" data-tail-issue-dot></span><span data-tail-issue-label>all agents</span><span class="tail-issue-caret" aria-hidden="true">▾</span></button><ul class="tail-issue-menu" role="listbox" aria-label="Filter by agent" data-tail-issue-menu hidden>${options}</ul></span>` +
    `<input type="text" class="tail-filter" placeholder="filter lines…" aria-label="Filter tail lines" data-tail-filter />` +
    playBtn +
    `<button type="button" class="lv-ico" data-tail-save aria-label="Download JSON" title="Download JSON">⤓</button>` +
    `</span>` +
    `</div>` +
    `<div class="tail-body" data-tail-body${hide}></div>` +
    `<button type="button" class="tail-backlog" data-tail-backlog hidden></button>` +
    `<div class="tail-footer" data-tail-footer${hide}></div>` +
    `</section>`
  );
};

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
  .campaign-name { font-weight: 600; letter-spacing: -0.01em; }
${TOP_BAR_STYLES}
${LIVE_TAIL_STYLES}
${HOST_LOG_STYLES}
  .waves-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; margin: 1rem 0; }
  .wave { background: var(--color-card); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; box-shadow: 0 8px 22px #0004; border-top: 3px solid var(--color-dim); }
  .wave.running { border-top-color: var(--color-blue); }
  /* A completed wave's card carries the green top edge its COMPLETED state reads (§2). */
  .wave.completed { border-top-color: var(--color-green); }
  /* A parked wave — a held member (a question, a conflict, or a red merged base) — carries
     the attention amber top edge, the same amber an issue parked reads (§2, ADR 0019). */
  .wave.parked { border-top-color: var(--color-yellow); }
  /* A failed wave — a member the agent could not make green — reads the failure red (§2). */
  .wave.failed { border-top-color: var(--color-failure); }
  /* A flex-grid item beats the UA [hidden] rule, so a collapsed completed card needs it back explicitly. */
  .wave.completed[hidden] { display: none; }
  /* One stable head row: the label takes the slack and wraps within itself, the meta
     group (merged/total · state · pruned) stays a nowrap unit on the right so the state
     pill never drops onto its own line in one card while it stays inline in a neighbour. */
  .wave-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem .75rem; flex-wrap: wrap; }
  .wave-label { margin: 0; font-size: 1.1rem; flex: 1 1 12rem; min-width: 0; }
  .wave-meta { display: flex; align-items: baseline; gap: .5rem; flex: 0 0 auto; margin-left: auto; }
  .wave-tally { color: var(--color-text-light-2); font-variant-numeric: tabular-nums; font-size: .9rem; white-space: nowrap; }
  .completed-waves { display: flex; align-items: flex-start; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; color: var(--color-text-light); }
  .completed-wave-chip .check { color: var(--color-green); font-weight: 700; }
  .completed-wave-bar { display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: .5rem; }
  .completed-wave-chip { cursor: pointer; font: inherit; }
  /* The chevron is CSS keyed off aria-expanded — collapsed › flips to expanded ⌄ — so
     the client script only flips the attribute, never re-authors the glyph. */
  .completed-wave-chip::after { content: "›"; color: var(--color-text-light-2); }
  .completed-wave-chip[aria-expanded="true"]::after { content: "⌄"; }
  /* An expanded chip takes a green accent (its card is open); collapsed chips stay neutral (§6). */
  .completed-wave-chip[aria-expanded="true"] { border-color: var(--color-green); }
  .wave-status, .completed-wave-chip { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--color-secondary); border-radius: 999px; padding: .3rem .65rem; background: var(--color-chip); color: var(--color-text); }
  /* Each member row is a full-width button — a flat list line, not a pill: dot · #NNN ·
     title (truncating) · status word pushed to the right. Its status reads at 40% alpha
     on a left edge (§4); hover lifts the fill only, the edge is unchanged (§6). */
  .wave-members { list-style: none; margin: .7rem 0 0; padding: 0; }
  .wave-member { display: flex; align-items: baseline; gap: .5rem; width: 100%; text-align: left; font: inherit; color: var(--color-text); background: none; border: 0; border-left: 2px solid transparent; border-radius: 0; padding: .2rem .5rem; cursor: pointer; }
  ${STATE_CHIP_BORDER_CSS}
  .wave-member-title { color: var(--color-text-light); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wave-member small { margin-left: auto; color: var(--color-text-light-2); white-space: nowrap; }
  .wave-member:hover, .completed-wave-chip:hover { background: var(--color-chip-hover); }
  /* Membership badges (ADR 0019) — the axis orthogonal to the lifecycle word: a pruned
     chip strikes through and dims, and each badge reads its own accent (pruned purple,
     grafted the product teal), keyed on the membership class, never a lifecycle status. */
  .wave-member.pruned { color: var(--color-text-light-2); text-decoration: line-through; }
  .member-badge { font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; border-radius: 999px; padding: .05rem .4rem; }
  .member-badge.pruned { color: var(--color-pruned); border: 1px solid var(--color-pruned); background: rgb(163 113 247 / 12%); }
  .member-badge.grafted { color: var(--color-primary); border: 1px solid var(--color-primary); background: var(--color-primary-alpha-20); }
  .wave-status { font-size: .85rem; margin-left: .5rem; text-transform: uppercase; letter-spacing: .03em; }
  .wave-status.completed { border-color: var(--color-green); color: var(--color-green); background: rgb(63 185 132 / 12%); }
  .wave-status.running { border-color: var(--color-blue); color: var(--color-blue); background: rgb(108 182 255 / 12%); }
  .wave-status.unstarted { border-color: var(--color-dim); color: var(--color-dim); background: rgb(95 107 120 / 12%); }
  .wave-status.parked { border-color: var(--color-yellow); color: var(--color-yellow); background: rgb(200 162 78 / 12%); }
  .wave-status.failed { border-color: var(--color-failure); color: var(--color-failure); background: rgb(248 81 73 / 12%); }
  .wave-pruned { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--color-pruned); border: 1px solid var(--color-pruned); background: rgb(163 113 247 / 12%); border-radius: 999px; padding: .1rem .5rem; }
  /* Status dot colours, generated once from stateColor and shared with the landing
     (§3), scoped to .dot so a state never tints a whole chip, card, or list row (#81). */
  ${STATE_DOT_CSS}
  textarea { width: 100%; max-width: 100%; min-height: 7rem; margin: .5rem 0; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; }
${ISSUE_DETAIL_SHEET_STYLES}
  .prune-fallback form { display: inline; }
  form button { padding: .5rem .8rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: var(--color-on-accent); cursor: pointer; font-weight: 700; }
  /* The whole-campaign Redrive control (design §11, #325, #328): a small control riding the
     campaign summary row beside graft. Redrive re-runs stopped work, so it is a risky action
     (Appendix A) and its enabled button wears the risky-action coral, never the plain accent;
     disabled it greys neutral and the one-line reason reads beside it — colour is never the only
     channel, the disabled-with-reason and the confirm dialog are the load-bearing guards. */
  .redrive-control { display: inline-flex; align-items: center; gap: .5rem; }
  .redrive-btn { padding: .35rem .7rem; border: 0; border-radius: var(--border-radius); background: var(--color-red); color: var(--color-on-accent); cursor: pointer; font: inherit; font-size: .85rem; font-weight: 700; }
  .redrive-btn:disabled { background: none; border: 1px solid var(--color-secondary); color: var(--color-dim); cursor: default; }
  .redrive-reason { color: var(--color-text-light-2); font-size: .82rem; }
  /* The confirm dialog (Cancel the default): a modal naming exactly what the redrive will do
     before any POST. A risky confirmation, so it takes the 1px-outline confirmation treatment in
     the risky-action coral and its Confirm the coral fill (§11, Appendix A). */
  .redrive-dialog { border: 1px solid var(--color-red); border-radius: var(--border-radius-medium); background: var(--color-card); color: var(--color-text); padding: 1rem 1.25rem; max-width: 32rem; box-shadow: 0 8px 22px #0006; }
  .redrive-dialog::backdrop { background: #0009; }
  .redrive-dialog-text { margin: 0 0 1rem; }
  .redrive-dialog-text code { color: var(--color-text); }
  .redrive-dialog-actions { display: flex; justify-content: flex-end; gap: .75rem; margin: 0; }
  .redrive-cancel { padding: .5rem .9rem; border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: none; color: var(--color-text); cursor: pointer; font: inherit; font-weight: 700; }
  .redrive-confirm { padding: .5rem .9rem; border: 0; border-radius: var(--border-radius); background: var(--color-red); color: var(--color-on-accent); cursor: pointer; font: inherit; font-weight: 700; }
  /* The merge-conflict note (#171) is informational only — same amber edge, no action. */
  .conflict-note { background: var(--color-card); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: .8rem 1rem; margin: 1rem 0; color: var(--color-text-light); box-shadow: 0 8px 22px #0004; }
  .conflict-note code { color: var(--color-text); }
  /* The Graft affordance (1a, #202): a quiet input riding the campaign summary line,
     pushed to the right so the meta text keeps the left. Unobtrusive at rest — a dim
     placeholder and a greyed button — it wakes to the teal product accent once ids are
     typed (the client flips [data-graft-active]); teal for success, never a state (§1). */
  .campaign-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: .75rem 0 0; }
  .campaign-summary .campaign-meta { margin: 0; }
  .graft-inline { margin: 0; display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
  .graft-ids { padding: .35rem .55rem; border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: var(--color-chip); color: var(--color-text); font: inherit; font-size: .85rem; caret-color: var(--color-primary); }
  /* The graft-issue-ids placeholder is a directive/example, not entered content — mute it
     to the dim token so it reads as a hint, distinct from the full-text-colour typed ids. */
  .graft-ids::placeholder { color: var(--color-dim); }
  .graft-ids:disabled { color: var(--color-dim); }
  .graft-inline[data-graft-active] .graft-ids { border-color: var(--color-primary); }
  /* Greyed and inert at rest; teal outline once ids are entered, filling on hover. */
  .graft-btn { padding: .35rem .7rem; border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: none; color: var(--color-text-light-2); cursor: pointer; font: inherit; font-size: .85rem; }
  .graft-btn:disabled { color: var(--color-dim); cursor: default; }
  .graft-inline[data-graft-active] .graft-btn { border-color: var(--color-primary); color: var(--color-primary); }
  .graft-inline[data-graft-active] .graft-btn:hover { background: var(--color-primary); color: var(--color-on-accent); }
  /* A bad-id / whole-batch rejection surfaces inline beside the input — the rejection red
     (a control's refusal, distinct from the failure state and the amber refusal, §1). */
  .graft-error { color: var(--color-red); font-size: .82rem; }
  .graft-error[hidden] { display: none; }
  /* A graft confirms on the wave (#202): the wave holding the freshly-grafted issues
     takes the teal product accent on its edge, so the new card reads at a glance when it
     arrives on the live refresh. Static, not a pulse — §5 reserves motion for the work
     (running dot) and stream (live dot) channels and nothing else animates its colour;
     the mockup's teal pulse is translated to this motion-free emphasis (CLAUDE.md rule 5).
     The grafted tags themselves already lift on pickup (the grafted overlay drops when a
     wave picks the issue up, ADR 0007) — the "fade" is that lifecycle, not an animation. */
  .wave.has-grafted { border-top-color: var(--color-primary); }
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
  /* The archived-runs list under the shared log-view chrome (#98, #248, #256): the .tail-head
     control bar (from LIVE_TAIL_STYLES) over a scrollable pane of rows separated by hairlines,
     one open at a time, the open row tinted. Each row's collapsed head is the shared lv-row
     control emitted as a full-width toggle button — the reset below strips the button's own
     chrome so the shared grid/hierarchy/dot CSS paints it exactly as the other log surfaces. */
  .archived-runs { margin: 1.5rem 0; border: 1px solid var(--color-light-border); border-radius: var(--border-radius-medium); overflow: hidden; }
  .archive-list { list-style: none; margin: 0; padding: 0; max-height: 22rem; overflow-y: auto; overflow-x: hidden; border-top: 1px solid var(--color-light-border); }
  .archive-list > li + li { border-top: 1px solid var(--color-light-border); }
  .archive-list > li.open { background: var(--color-card); }
  .archive-list > li[hidden] { display: none; }
  .archive-list .lv-row { width: 100%; text-align: left; background: none; border: 0; color: var(--color-text); font: inherit; cursor: pointer; }
  .archive-list .lv-row:hover { background: var(--color-card-hover); }
  .archive-body { padding: 0 1rem 1rem; }
  .archive-body[hidden] { display: none; }
</style>${
  // No-JS fallback for the closed-wave toggles: the cards are hidden and the chips
  // inert without JS, so reveal every closed card in the grid and hide the toggle bar,
  // keeping the content reachable (the old <details> degraded the same way). Emitted
  // only when there are closed waves to fall back for.
  status.waves.some((wave) => wave.status === "completed")
    ? `\n<noscript><style>.completed-wave-bar { display: none; } .wave.completed[hidden] { display: block; }</style></noscript>`
    : ""
}
</head>
<body>
${renderTopBar(opts.projects?.length ? renderRepoDropdown(opts.projects, opts.selected ?? status.project) : `<h1>${escapeHtml(status.project)}</h1>`, renderHostLog())}
<div id="live-region">${
  // The merge-conflict note is an aggregated-page affordance (the same `prune` page option
  // gates the interactive shell-out affordances), gated on the conflict state so it appears
  // only when there is a held conflict to act on.
  opts.prune && hasConflict(status) ? renderConflictNote() : ""
}${
  status.parked.length
    ? `<section class="parked-issues"><h2>Parked · <span class="parked-count">${status.parked.length}</span></h2>${status.parked
        .map(
          // A clickable question card that opens the issue-detail sheet (the reply now
          // happens there — no inline /answer form). The href to the campaign view is
          // the no-JS fallback; parked issues are always prunable, so under prune the
          // card carries data-prunable so the sheet offers Prune (ADR 0005).
          (p) => `<a class="parked-card" href="/?project=${encodeURIComponent(status.project)}" data-issue="${escapeHtml(p.issueNumber)}" data-project="${escapeHtml(status.project)}"${opts.prune ? ` data-prunable="1"` : ""}><div class="parked-card-title"><span class="parked-issue">#${escapeHtml(p.issueNumber)}</span> ${escapeHtml(p.description)}</div><div class="parked-card-meta">waiting <span class="parked-waited" data-parked-at="${escapeHtml(p.parkedAt)}">…</span> · ${escapeHtml(reasonWord(p.reason))}</div></a>`,
        )
        .join("")}</section>`
    : ""
}
${
  // The summary line: the meta bare, or — under the graft page option — the meta paired with
  // the campaign controls (the quiet inline graft input, 1a, and the greyed-until-safe Redrive
  // control, design §11/#325), the three laid out as one summary row.
  status.waves.length
    ? opts.graft
      ? `<div class="campaign-summary">${renderCampaignMeta(status)}<div class="campaign-controls">${renderGraftInline(status)}${renderRedriveControl(status, redriveAllowed(campaignState(status.waves.map((wave) => wave.status)), Boolean(opts.leaseLive)), opts.baseBranch)}</div></div>`
      : renderCampaignMeta(status)
    : ""
}
${renderWaves(status, Boolean(opts.prune), true, true, undefined, Boolean(opts.festive))}</div>
${renderLiveTail(status)}
${opts.archivedRuns?.length ? renderArchivedRuns(opts.selected ?? status.project, opts.archivedRuns, opts.archivedRun, Boolean(opts.festive)) : ""}
${issueDetailSheetMarkup(Boolean(opts.prune))}${
  // No-JS fallback: a plain server-side form per prunable issue that reaches
  // POST /prune → the preview page → confirm without any JavaScript. The inline
  // panel above is the progressive enhancement layered over it.
  opts.prune && status.waves.some((wave) => wave.issues.some(isPrunable))
    ? `<noscript><section class="prune-fallback"><h2>Prune</h2>${status.waves
        .flatMap((wave) => wave.issues)
        .filter(isPrunable)
        .map(
          (issue) =>
            `<form method="post" action="/prune"><input type="hidden" name="taskId" value="${escapeHtml(issue.issueNumber)}" /><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit">Prune #${escapeHtml(issue.issueNumber)}</button></form>`,
        )
        .join("")}</section></noscript>`
    : ""
}
<script>
  // The presentation-freeze reducer (dashboard-visual-state.ts, ADR 0012), single-sourced
  // into the browser via .toString() so the node test runs the very function this page
  // ships. The __name shim satisfies the keepNames wrapper a bundling build could leave on
  // a named function (a no-op when none is applied).
  const __name = (fn) => fn;
  ${freezeIntent.toString()}
  // The graft carry-over reducer (dashboard-visual-state.ts, ADR 0012, #329), single-sourced
  // the same way: the soft-refresh captures the outgoing graft control's state and this decides
  // what wireGraft restores onto the freshly-swapped node, so nothing typed/erroring/in-flight
  // is lost. Held here for both softRefresh (the capture) and wireGraft (the apply) to reach.
  ${graftCarry.toString()}
  // The resume-reconnect reducer (dashboard-visual-state.ts, ADR 0012, #351), single-sourced
  // the same way: a tab backgrounded past iOS's ~20s connection-close window comes back with a
  // dead EventSource that never fires an error and keeps readyState OPEN, so no reconnect is
  // attempted and the whole board freezes. This decides, from how long the page was hidden,
  // whether a resume should force a fresh connection.
  ${resumeIntent.toString()}
  let pendingGraftCarry = null;
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
  const updatedEl = document.querySelector("[data-updated]");
  let lastUpdate = Date.now();
  // freezeIntent (dashboard-visual-state.ts) decides the readout; the glue only writes it.
  const renderUpdated = () => { updatedEl.textContent = freezeIntent({ lastUpdate, now: Date.now() }).updatedText; };
  // Live updates (ADR 0008, #131): a live event soft-refreshes rather than reloading the
  // whole page. It re-fetches this same page and swaps only #live-region (the parked cards,
  // campaign meta and wave grid) — the issue sheet, its open reply/compose, the repo
  // dropdown, the archived-runs list and the scroll position all live outside it and are
  // left untouched. A full-page reload blanked the page and lost scroll/compose state,
  // worst over the tailnet. Single-flighted so overlapping ticks can't race.
  let refreshing = false;
  const softRefresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const res = await fetch(location.href);
      const next = new DOMParser().parseFromString(await res.text(), "text/html").getElementById("live-region");
      const current = document.getElementById("live-region");
      if (next && current) {
        // Capture the graft control's operator state *immediately before* the swap (#329) —
        // not before the re-fetch above, so an id typed while the fetch was in flight is the
        // value seen here. graftCarry decides what wireGraft restores onto the fresh node.
        const graftForm = current.querySelector("[data-graft]");
        pendingGraftCarry = null;
        if (graftForm) {
          const gIds = graftForm.querySelector("[data-graft-ids]");
          const gErr = graftForm.querySelector("[data-graft-error]");
          pendingGraftCarry = graftCarry({
            ids: gIds ? gIds.value : "",
            error: gErr && !gErr.hidden ? gErr.textContent : "",
            busy: graftForm.hasAttribute("aria-busy"),
          });
        }
        current.replaceWith(next);
        wireLiveRegion();
      }
      lastUpdate = Date.now();
      renderUpdated();
    } catch (e) {}
    refreshing = false;
  };
  // A stable event bus the panes bind to once, at wiring time, and are never re-bound (#351).
  // \`connect()\` owns the real EventSource and forwards its message/tail/host frames onto this
  // bus; replacing a dead stream swaps the EventSource underneath while every closure the panes
  // hold — the live-tail's per-issue high-water \`seen\` above all — survives untouched. Re-running
  // the pane wiring would reset \`seen\` to {}, so the connect ring's re-seed snapshot would read
  // as entirely fresh and the tail would duplicate itself; the bus is what prevents that.
  const events = new EventTarget();
  let stream = null;
  // Single-flight latch: a \`pageshow\` and a \`visibilitychange\` both fire on one iOS resume,
  // milliseconds apart, and both pass resumeIntent's threshold reading the same stale hiddenAt.
  // The latch — mirroring softRefresh's \`refreshing\` — is what collapses them to one new stream,
  // one connect ring and one re-fetch. Released when the fresh connection opens or errors.
  let connecting = false;
  const connect = () => {
    if (connecting) return;
    connecting = true;
    // Explicitly drop the previous stream so a forced reconnect never leaves two live.
    if (stream) stream.close();
    const s = new EventSource("/api/events");
    stream = s;
    const release = () => { if (stream === s) connecting = false; };
    s.onopen = release;
    s.onerror = release;
    // Forward each frame onto the bus verbatim (data preserved) so the panes' one-time
    // listeners see it exactly as a direct EventSource binding would.
    s.onmessage = (e) => events.dispatchEvent(new MessageEvent("message", { data: e.data }));
    s.addEventListener("tail", (e) => events.dispatchEvent(new MessageEvent("tail", { data: e.data })));
    s.addEventListener("host", (e) => events.dispatchEvent(new MessageEvent("host", { data: e.data })));
  };
  events.addEventListener("message", () => { softRefresh(); });
  connect();
  // Reconnect a stream the OS silently killed while the tab was backgrounded (#351). readyState
  // and the error event both lie in this case, so the trigger is visibility, not stream state:
  // stamp hiddenAt on hide, and on resume let resumeIntent decide from how long we were away.
  // A brief hide never reconnects (the connect ring is not free); hiddenAt is left for the next
  // hide to overwrite, so both resume triggers read the same value and the latch dedupes them.
  // No direct softRefresh() here — the new connection's own ring already turns into one (#331).
  let hiddenAt = null;
  const onResume = () => { if (resumeIntent({ hiddenAt, now: Date.now() }).reconnect) connect(); };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else onResume();
  });
  // pageshow covers a bfcache restore, where no visibilitychange may fire. Not focus (it fires
  // constantly on desktop) and not online (a network blip does not imply a dead stream).
  window.addEventListener("pageshow", onResume);
  // A live pane (the live-tail) that visibly appends is a co-equal update (#198): reset the
  // freshness clock so "updated Ns ago" reflects any live surface, not just a soft-refresh.
  window.addEventListener("vetinari:activity", () => { lastUpdate = Date.now(); renderUpdated(); });
  renderUpdated();
  setInterval(renderUpdated, 1000);
${ISSUE_DETAIL_SHEET_SCRIPT}
${REPO_DROPDOWN_SCRIPT}
${ARCHIVE_LIST_SCRIPT}
  // Wire the swappable #live-region: the parked-waited "waiting Nm" fill, the sheet-opening
  // click on each wave-member/parked-card, and the closed-wave toggles. Re-run after every
  // soft-refresh so the freshly-swapped nodes are live again (the old nodes' listeners went
  // out with them). Idempotent by construction — each call rebinds only current nodes.
  function wireLiveRegion() {
    for (const waited of document.querySelectorAll(".parked-waited[data-parked-at]")) waited.textContent = fmtWaited(waited.dataset.parkedAt);
    // A live wave-member row and a parked card both open the sheet, carrying their
    // issue+project. The parked card is an <a> with a no-JS href, so its click is
    // prevented before the sheet opens; a member row is a button, where preventDefault
    // is harmless.
    document.querySelectorAll(".wave-member[data-issue], .parked-card[data-issue]").forEach((el) =>
      el.addEventListener("click", (event) => { event.preventDefault(); openIssue(el.dataset.project, el.dataset.issue, el.dataset.prunable === "1", el.dataset.run); }));
    // Closed-wave toggles: each chip reveals/hides its own wave card in the grid. The set
    // of open waves is persisted per project so a soft-refresh — which re-renders the grid
    // collapsed — does not silently collapse everything the operator opened.
    const waveBar = document.querySelector(".completed-wave-bar");
    if (waveBar) {
      const storeKey = "vetinari:closed-waves:" + waveBar.dataset.project;
      const readOpen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(storeKey) || "[]")); } catch { return new Set(); } };
      const open = readOpen();
      const setOpen = (chip, isOpen) => {
        chip.setAttribute("aria-expanded", String(isOpen));
        const card = document.getElementById(chip.getAttribute("aria-controls"));
        if (card) card.hidden = !isOpen;
      };
      for (const chip of waveBar.querySelectorAll(".completed-wave-chip")) {
        if (open.has(chip.dataset.wave)) setOpen(chip, true);
        chip.addEventListener("click", () => {
          const isOpen = chip.getAttribute("aria-expanded") !== "true";
          setOpen(chip, isOpen);
          if (isOpen) open.add(chip.dataset.wave); else open.delete(chip.dataset.wave);
          try { sessionStorage.setItem(storeKey, JSON.stringify([...open])); } catch {}
        });
      }
    }
    // The summary-line graft input and the Redrive control are inside #live-region too, so
    // rebind them each refresh (their nodes are replaced on every soft-refresh).
    wireGraft();
    wireRedrive();
  }
${GRAFT_SCRIPT}
${REDRIVE_SCRIPT}
  wireLiveRegion();
${LIVE_TAIL_SCRIPT}
${HOST_LOG_SCRIPT}
</script>
</body>
</html>`;

