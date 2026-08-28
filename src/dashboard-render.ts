import type { ResolvedConfig } from "./config.ts";
import {
  type ArchivedRunState,
  buildStatusWithIssueNames,
  type CampaignStatus,
  type DisplayStatus,
  type RunState,
  type StatusIssue,
  type StatusWave,
  waveLabel,
  type WaveStatus,
} from "./dashboard-model.ts";
import { festiveWaveName } from "./festive-names.ts";
import type { StructuredGraftClosure } from "./graft.ts";
import type { GraftRejection } from "./plan.ts";
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
  MONO_FONT,
  REPO_DROPDOWN_SCRIPT,
  STATE_CHIP_BORDER_CSS,
  STATE_DOT_CSS,
  TOP_BAR_STYLES,
} from "./dashboard-assets.ts";
import {
  dotClass,
  freezeIntent,
  hiddenPastCap,
  tallyDotClass,
} from "./dashboard-visual-state.ts";

const ISSUE_EMOJI: Record<DisplayStatus, string> = {
  completed: "✅",
  running: "🔄",
  parked: "⏸",
  failure: "❌",
  unstarted: "⚪",
  carved: "✂️",
  grafted: "🌱",
  quarantined: "🚧",
  interrupted: "⏹",
};

const WAVE_EMOJI: Record<WaveStatus, string> = {
  closed: "✅",
  running: "▶️",
  unstarted: "⚪",
  "wave-parked": "⏸",
  interrupted: "⏹",
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

/**
 * One issue's member row — the single line a wave card gives each of its issues,
 * merging what used to be a status chip and a separate title line into one row:
 * status dot + `#NNN` + resolved title (falling back to just the number until a
 * title resolves) + the status word, right-aligned. The row is the interactive
 * element: a live (interactive) row carries its issue and project so a tap opens
 * the detail sheet — and, under carve, so the panel can route a carve. An archived
 * row is interactive too and additionally carries its `run` token, so the shared
 * sheet reads that run's own log (its turn log lives there, not in the live log);
 * it is never carvable, so the read-only archive offers no Carve (ADR 0005). Only
 * a still-carvable row is flagged `data-carvable`; a carved row reads struck-through
 * off its status class. No control is drawn on the row.
 */
const renderWaveMember = (issue: StatusIssue, project: string, carve: boolean, interactive: boolean, run?: string) => {
  const detail = chipTitle(issue) || `#${issue.issueNumber}: ${issue.status}`;
  const openData = interactive || carve ? ` data-issue="${escapeHtml(issue.issueNumber)}" data-project="${escapeHtml(project)}"${run ? ` data-run="${escapeHtml(run)}"` : ""}` : "";
  const carveData = carve && isCarvable(issue) ? ` data-carvable="1"` : "";
  const title = issue.name ? `<span class="wave-member-title">${escapeHtml(issue.name)}</span>` : "";
  // The row carries its status class so its state reads at 40% alpha on a left edge
  // (§4); the dot carries the same status at full strength, the word spells it out.
  return `<li><button type="button" class="wave-member ${issue.status}" title="${escapeTitle(detail)}"${openData}${carveData}><span class="dot ${dotClass(issue.status)}"></span>#${escapeHtml(issue.issueNumber)} ${title}<small>${escapeHtml(issue.status)}</small></button></li>`;
};

/** A wave's member list — one interactive row per issue (see `renderWaveMember`),
 * the single block that replaced the old chip row + title list. */
const renderWaveMembers = (wave: StatusWave, project: string, carve: boolean, interactive: boolean, run?: string) =>
  `<ul class="wave-members">${wave.issues.map((issue) => renderWaveMember(issue, project, carve, interactive, run)).join("")}</ul>`;

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
const renderWaveCard = (wave: StatusWave, project: string, carve: boolean, interactive: boolean, extraAttrs = "", run?: string, festiveName?: string) => {
  // A carved tally folded into the head's meta group beside the merged count, so a wave
  // a carve pruned reads at a glance — the carved rows are a display overlay (ADR 0007),
  // and this counts them. The label sits in its own element so a long one wraps within
  // itself without shoving the meta group (tally · state · carved) onto its own line.
  const carved = wave.issues.filter((issue) => issue.status === "carved").length;
  const tally = carved ? `<span class="wave-carved">${carved} carved</span>` : "";
  // A wave holding a freshly-grafted issue (#202) is marked so its edge pulses the teal
  // accent once when it appears — the graft confirming on the wave (option 1a).
  const grafted = wave.issues.some((issue) => issue.status === "grafted") ? " has-grafted" : "";
  return `<section class="wave ${wave.status}${grafted}"${extraAttrs}><div class="wave-head"><h2 class="wave-label">${renderWaveLabel(wave, festiveName)}</h2><div class="wave-meta"><span class="wave-tally">${waveMerged(wave)}/${wave.issues.length}</span><span class="wave-status ${wave.status}">${wave.status}</span>${tally}</div></div>${renderWaveMembers(wave, project, carve, interactive, run)}</section>`;
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
 * detail sheet and, under carve, route a carve; the archived run passes it `false`. */
const renderWaves = (status: CampaignStatus, carve: boolean, interactive: boolean, collapsible = true, run?: string, festive = false) => {
  if (!status.waves.length) return "<p>No active campaign or queue found.</p>";
  if (!collapsible) return `<div class="waves-grid">${status.waves.map((wave) => renderWaveCard(wave, status.project, carve, interactive, "", run, festiveNameFor(status, wave, festive))).join("")}</div>`;
  const closedWaves = status.waves.filter((wave) => wave.status === "closed");
  const openWaves = status.waves.filter((wave) => wave.status !== "closed");
  const toggleRow = closedWaves.length
    ? `<div class="completed-waves"><div class="completed-wave-bar" data-project="${escapeHtml(status.project)}">${closedWaves.map((wave) => renderClosedWaveChip(wave, festiveNameFor(status, wave, festive))).join("")}</div></div>`
    : "";
  // The grid holds every closed card (hidden until its chip toggles it open) before
  // the open ones, in wave order; it renders whenever there is any wave to show.
  const cards = [
    ...closedWaves.map((wave) => renderWaveCard(wave, status.project, carve, interactive, ` id="closed-wave-${wave.index}" hidden`, undefined, festiveNameFor(status, wave, festive))),
    ...openWaves.map((wave) => renderWaveCard(wave, status.project, carve, interactive, "", undefined, festiveNameFor(status, wave, festive))),
  ];
  return `${toggleRow}${cards.length ? `<div class="waves-grid">${cards.join("")}</div>` : ""}`;
};

/**
 * Whether the campaign is wave-parked — a red merged base paused it and it holds a
 * `wave-parked` wave (ADR 0013). The Resume control below surfaces only in that state.
 */
const isWaveParked = (status: CampaignStatus) => status.waves.some((wave) => wave.status === "wave-parked");

/** Whether any issue is quarantined — a merge conflict pulled a passed green out of
 * integration (ADR 0013) and it awaits a manual resolve. Gates the informational note. */
const hasQuarantined = (status: CampaignStatus) => status.waves.some((wave) => wave.issues.some((issue) => issue.status === "quarantined"));

/**
 * The wave-park Resume control (#171): when a campaign is paused on a red merged base,
 * a human fixes forward and taps Resume, which POSTs `/resume` for this project — the
 * aggregated dumb router (ADR 0002) shells `campaign --resume` in the project's own
 * root. Resume is non-destructive and project-scoped, so — unlike carve — it needs no
 * preview/confirm gate: a single POST. Emitted only on the interactive aggregated page
 * (`carve`, the same page option carve rides) and only while wave-parked.
 */
const renderResumeControl = (status: CampaignStatus) =>
  `<section class="resume-banner"><div class="resume-banner-text"><strong>Campaign paused</strong> — a wave's merged base gated red, so its greens were kept and the campaign paused for a human. Fix forward, then resume.</div><form method="post" action="/resume" class="resume-form"><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit" class="resume-btn">Resume campaign</button></form></section>`;

/**
 * The quarantine informational affordance (#171): a merge conflict quarantined a passed
 * issue out of integration (ADR 0013). There is deliberately no un-quarantine CLI to
 * shell, so this is a note only — it points the operator at resolve-then-resume, with no
 * action route or button of its own.
 */
const renderQuarantineNote = () =>
  `<section class="quarantine-note"><strong>Issue quarantined</strong> — a merge conflict held a passed green out of integration. Resolve the conflict, then resume the campaign (the Resume control above, or <code>campaign --resume</code> in the project root).</section>`;

/**
 * The Graft affordance (#168, reworked to mockup 1a in #202). Where carve prunes an
 * existing campaign issue (a per-chip control), graft *extends* the running campaign
 * with new issues named by explicit id. 1a places it as a quiet, always-visible input
 * on the campaign summary line rather than a banner: at rest a dim `graft issue ids`
 * placeholder and a greyed (disabled) button; the client enables the button once ids
 * are typed and, on submit, POSTs `/graft` for this project directly — the graft
 * confirms on the wave (the new wave card appears on the live refresh), with no
 * preview/confirm form. `graft` is variadic, so the field carries a set of ids
 * (whitespace/comma-split, matching the CLI). A whole-batch rejection and any per-id
 * validation surface inline in `[data-graft-error]`, never navigating away.
 *
 * When the campaign is finished (no wave left open, so the graft engine has nothing
 * live-or-resumable to layer into — ADR 0014), the affordance renders *structurally
 * disabled* instead: a greyed input and amber guidance with a start-campaign hint,
 * rather than an input that would only fail on submit. Amber marks a structural refusal,
 * distinct from the teal success and the red bad-id/rejection (§1).
 */
const renderGraftInline = (status: CampaignStatus) =>
  isGraftable(status)
    ? `<form method="post" action="/graft" class="graft-inline" data-graft><input type="text" name="ids" class="graft-ids" placeholder="graft issue ids" autocomplete="off" aria-label="Graft issue ids" data-graft-ids /><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit" class="graft-btn" data-graft-submit disabled>graft</button><span class="graft-error" data-graft-error hidden></span></form>`
    : `<div class="graft-inline graft-refused" data-graft-refused><input type="text" class="graft-ids" placeholder="graft issue ids" aria-label="Graft issue ids" disabled /><button type="button" class="graft-btn" disabled>graft</button><span class="graft-refusal">Campaign is on its final wave — nothing left to layer into. Grafting resumes when a new campaign starts (<code>vetinari campaign</code>).</span></div>`;

/** Whether the campaign can still accept a graft: it is live-or-resumable while any wave
 * is not yet closed. A wholly-closed campaign has reached its final wave — nothing left to
 * layer into, which the graft engine refuses (ADR 0014) — so the input renders structurally
 * disabled (amber) rather than failing on submit. */
const isGraftable = (status: CampaignStatus) => status.waves.some((wave) => wave.status !== "closed");

/** The `<name> · N issues · M waves` campaign summary line. Split out so the graft
 * affordance (1a) can ride alongside it on the summary row without disturbing the exact
 * `<p class="campaign-meta">` string every non-graft surface renders. */
const renderCampaignMeta = (status: CampaignStatus) =>
  `<p class="campaign-meta">${status.name ? `<span class="campaign-name">${escapeHtml(status.name)}</span> · ` : ""}${campaignIssueCount(status)} issue${campaignIssueCount(status) === 1 ? "" : "s"} · ${status.waves.length} wave${status.waves.length === 1 ? "" : "s"}</p>`;

/**
 * Is a host-log row one an operator should be alerted to (#180)? A pure, render-time
 * predicate over a parsed `host.jsonl` row — no new severity field on host emitters
 * (consistent with #169's "no severity" decision): a row is notable when its kind
 * matches `/fail|error/i`, or it carries a non-null `error` field, or an `ok: false`
 * field. That catches Telegram send failures, SSE watch failures, and registry read
 * errors without any emitter change. Both the gear's attention badge and any future
 * host-log filtering key off this one predicate; it is unit-tested here and shipped
 * verbatim into the client via `.toString()`, so the badge the browser computes is the
 * same rule the node test exercises.
 */
export function isNotableHostEvent(event: { event?: string; error?: unknown; ok?: unknown; [key: string]: unknown }): boolean {
  if (typeof event.event === "string" && /fail|error/i.test(event.event)) return true;
  if (event.error !== undefined && event.error !== null) return true;
  if (event.ok === false) return true;
  return false;
}

/**
 * Colour one JSON line's tokens for the raw-log view — keys, string values, numbers
 * and the literals `true`/`false`/`null` each get their own span class
 * (`jkey`/`jstr`/`jnum`/`jbool`/`jnull`). A string immediately followed by a colon is
 * a key, otherwise a value. Pure and self-contained (it does its own escaping) so it
 * is unit-tested here *and* shipped verbatim into the client via `.toString()` — one
 * source of truth. Every token's text is HTML-escaped, so nothing in a log line can
 * inject markup; the gaps between tokens are escaped too.
 */
export function highlightJsonLine(line: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#039;"));
  const span = (cls: string, inner: string) => `<span class="${cls}">${inner}</span>`;
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    if (m[1] !== undefined) {
      out += span(m[2] ? "jkey" : "jstr", esc(m[1]));
      if (m[2]) out += esc(m[2]);
    } else if (m[3] !== undefined) {
      out += span(m[3] === "null" ? "jnull" : "jbool", m[3]);
    } else {
      out += span("jnum", m[4]);
    }
    last = m.index + m[0].length;
  }
  out += esc(line.slice(last));
  return out;
}

/** One rendered raw-log row: the original line and its 1-based line number. */
export interface RawRow {
  line: string;
  n: number;
}

/**
 * Select the raw-log rows to render, bounded so a huge log can't build an
 * unbounded DOM (#127): filter to the lines matching `needle` (a lowercased
 * substring, empty = all), then keep the first `cap + expandedCount` matches.
 * `total` is the number of matches (the filtered total when filtering, else the
 * whole log); `hidden` is how many matches were left out — a positive value is
 * what the "show more" control reveals. Line numbers (`n`) stay the original
 * 1-based indices so `#L<n>` anchors keep pointing at the right line. Pure so it
 * unit-tests without a DOM, and shipped verbatim into the client script.
 */
export function cappedRawRows(
  lines: string[],
  needle: string,
  cap: number,
  expandedCount: number,
): { rows: RawRow[]; total: number; hidden: number } {
  const limit = cap + (expandedCount > 0 ? expandedCount : 0);
  const rows: RawRow[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (needle && lines[i].toLowerCase().indexOf(needle) === -1) continue;
    total++;
    if (rows.length < limit) rows.push({ line: lines[i], n: i + 1 });
  }
  return { rows, total, hidden: total - rows.length };
}

/**
 * One line the live-tail pane buffers/renders (#124): the raw JSONL `raw`, the `issue`
 * it came from (gutter number + colour), and its 0-based per-file index `n` (the stable
 * id `tailFresh` dedups appends by). `status`/`ts` ride along for rendering; the reducers
 * below only read `issue`, `n`, and `raw`. The client-side twin of `dashboard-model`'s
 * `TailLine`, redeclared here so the shipped reducers stay self-contained.
 */
export interface TailRow {
  issue: string;
  n: number;
  raw: string;
  status?: string;
  ts?: string;
}

/** The live tail's following-buffer cap: while following, the per-repo buffer keeps only
 * the newest this-many lines, oldest discarded (#124). A paused buffer grows past it. */
export const TAIL_FOLLOW_CAP = 260;
/** How many matching lines the tail body renders — the newest this-many, so a long
 * stream can't build an unbounded DOM (the pane's counterpart to `cappedRawRows`, #124). */
export const TAIL_RENDER_CAP = 160;

/**
 * Fold a fresh server snapshot's lines into the client's dedup state (#124): a snapshot
 * re-sends its whole window each push, so a line counts as *new* only when its per-file
 * index `n` exceeds the highest `n` already seen for its issue (`seen[issue]`). Monotonic
 * by construction, so it never re-appends a line the following buffer has since dropped,
 * nor one a paused buffer already holds. Returns the genuinely-new lines and the advanced
 * `seen` map (pure — the caller swaps its state for the returned one). Shipped to the
 * browser via `.toString()`, so it is a self-contained `function` over plain values.
 */
export function tailFresh(
  lines: TailRow[],
  seen: Record<string, number>,
): { fresh: TailRow[]; seen: Record<string, number> } {
  const next: Record<string, number> = { ...seen };
  const fresh: TailRow[] = [];
  for (const line of lines) {
    const high = next[line.issue];
    if (high === undefined || line.n > high) {
      fresh.push(line);
      next[line.issue] = line.n;
    }
  }
  return { fresh, seen: next };
}

/**
 * Append fresh lines to the tail buffer (#124). While following, the buffer is capped at
 * `cap` (oldest discarded) so it tracks a bounded newest-window; while paused it grows
 * past the cap so a backlog that piles up survives to be revealed on resume. Pure and
 * self-contained — shipped to the browser via `.toString()`.
 */
export function tailAppend(buffer: TailRow[], fresh: TailRow[], live: boolean, cap: number): TailRow[] {
  const next = buffer.concat(fresh);
  return live && next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Relabel an orchestrator event kind to the event-log feed's clean lowercase namespace.verb
 * (#95): a feed-label remap of real events, not a status-vocab change (ADR 0007). Only kinds
 * that actually exist are mapped (no invented `pr.opened`; the turn stays the anonymous
 * `agent.turn`, rule 5); an unmapped kind falls through to its raw value rather than vanishing.
 * Pure and shipped to the browser via `.toString()` so the feed client and its filter agree.
 */
export function feedKindLabel(kind: string): string {
  return (
    {
      green: "issue.merged",
      parked: "issue.parked",
      quarantined: "issue.quarantined",
      "wave-parked": "wave.parked",
      carve: "issue.carved",
      graft: "issue.grafted",
      "campaign-batch": "wave.started",
      "campaign-batch-done": "wave.closed",
      "campaign-start": "campaign.started",
      "queue-start": "campaign.started",
      "campaign-done": "campaign.closed",
      "queue-done": "campaign.closed",
      "campaign-halt": "campaign.halted",
      turn: "agent.turn",
    }[kind] ?? kind
  );
}

/**
 * Map an event kind to its comms category (#78) so the feed reads in colour: merges/dones green,
 * a parked/quarantined/wave-parked wave the attention amber (ADR 0013), a halt red, a carve
 * purple, everything else (starts, waves, turns) the in-flight blue. Pure; shipped via `.toString()`.
 */
export function feedKindClass(kind: string): string {
  if (["green", "campaign-done", "campaign-complete", "campaign-batch-done", "queue-done"].includes(kind)) return "success";
  if (kind === "parked" || kind === "quarantined" || kind === "wave-parked") return "attention";
  if (kind === "campaign-halt") return "failure";
  if (kind === "carve") return "carved";
  return "progress";
}

/**
 * A stable identity for a feed row (#196): an event is immutable, so its project, ts, kind and
 * text together key it. Used to dedup across re-fetches of the rolling window — the feed has no
 * per-file index the tail keys on, so it keys on the row's own content. Pure; shipped via `.toString()`.
 */
export function feedKey(row: { project: string; ts: string; kind: string; text: string }): string {
  return row.project + " " + row.ts + " " + row.kind + " " + row.text;
}

/**
 * Which rows of a re-fetched feed window are new since last seen (#196) — the feed's analogue of
 * `tailFresh`. The server returns the whole window newest-first each fetch; this walks it
 * oldest-first and returns the unseen rows in that chronological order, so they append to the
 * accumulating oldest→newest buffer (`tailAppend`) in order. `seen` is the running key set,
 * carried forward so a re-sent row (or one kept across a Clear) isn't re-imported. Pure; shipped
 * to the browser via `.toString()`.
 */
export function feedFresh(
  entries: Array<{ project: string; ts: string; kind: string; text: string }>,
  seen: Record<string, true>,
): { fresh: Array<{ project: string; ts: string; kind: string; text: string }>; seen: Record<string, true> } {
  const next: Record<string, true> = { ...seen };
  const fresh: Array<{ project: string; ts: string; kind: string; text: string }> = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const key = feedKey(entries[i]);
    if (!next[key]) {
      next[key] = true;
      fresh.push(entries[i]);
    }
  }
  return { fresh, seen: next };
}

/**
 * The event-log filter contract (#196): a feed row matches a case-insensitive substring query
 * over its kind label (`feedKindLabel`, what the operator actually reads) plus its narrated text
 * — the feed has no raw JSON, so this mirrors the tail's line filter over the row's prose. An
 * empty/blank query matches everything (the filter is cleared). Pure; shipped via `.toString()`.
 */
export function feedRowMatches(row: { kind: string; text: string }, query: string): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  return (feedKindLabel(row.kind) + " " + row.text).toLowerCase().indexOf(q) !== -1;
}

/**
 * The follow/pause/backlog view-model shared by the live tail (#124) and the event-log feed
 * (#196): from an accumulating oldest→newest `buffer` and the current controls, decide which
 * rows render and the footer/backlog counts. Following reads the whole buffer; paused freezes
 * the visible set at `mark` (the buffer length when pause was hit) and the rows past it become
 * the backlog. The caller supplies the row shape and its `match` predicate (the tail's
 * issue+substring filter, the feed's kind+text filter), applied to both the visible set and
 * the backlog count. The newest `cap` matches render — **newest-first**, so the latest row sits
 * at the top of the pane (#195). `empty` is true when the predicate matches nothing (the body
 * shows the empty-state text). Pure and self-contained, unit-tested in node and shipped to the
 * browser via `.toString()` (ADR 0012).
 */
export function followView<T>(state: {
  buffer: T[];
  mark: number;
  live: boolean;
  cap: number;
  match: (row: T) => boolean;
}): { rows: T[]; visible: number; total: number; backlog: number; empty: boolean; following: boolean } {
  const source = state.live ? state.buffer : state.buffer.slice(0, state.mark);
  const filtered = source.filter(state.match);
  // Keep the newest `cap` matches (the tail of the canonical oldest→newest array), then
  // reverse so the newest renders first (#195): newest-on-top, older extending downward.
  const rows = filtered.slice(Math.max(0, filtered.length - state.cap)).reverse();
  const backlog = state.live ? 0 : state.buffer.slice(state.mark).filter(state.match).length;
  return { rows, visible: rows.length, total: state.buffer.length, backlog, empty: filtered.length === 0, following: state.live };
}

/**
 * The tail body's view-model (#124): builds the issue-dropdown + case-insensitive substring
 * filter (both applied) over the raw JSONL line and drives the shared `followView` (#196).
 * Pure and self-contained, unit-tested in node and shipped to the browser via `.toString()`.
 */
export function tailView(state: {
  buffer: TailRow[];
  mark: number;
  live: boolean;
  issue: string;
  query: string;
  cap: number;
}): { rows: TailRow[]; visible: number; total: number; backlog: number; empty: boolean; following: boolean } {
  const q = (state.query || "").trim().toLowerCase();
  const match = (line: TailRow) => (!state.issue || line.issue === state.issue) && (!q || line.raw.toLowerCase().indexOf(q) !== -1);
  return followView({ buffer: state.buffer, mark: state.mark, live: state.live, cap: state.cap, match });
}

const ARCHIVE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** A run's start time rendered as `Aug 23, 2026 · 15:22:36` from its ISO timestamp,
 * in the operator's local timezone (the gateway runs in it) — the human-facing chrome
 * localizes; the raw-log pane keeps the JSONL's UTC stamps verbatim (#102). */
const formatRunWhen = (iso: string) => {
  const d = new Date(iso);
  return `${ARCHIVE_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** How many rows the collapsible list shows before the "show older" control — the
 * newest are visible, the rest render hidden and are revealed on demand (in v1). */
const ARCHIVE_CAP = 20;

/**
 * One archived-run row: a collapsed head (chevron, name, `date · time` (local), a state
 * dot + `state · N issues`, and the joined campaign/raw-log control) over a hidden
 * body holding both panes. The campaign pane reuses the live wave renderer read-only
 * (`carve`/`interactive`/`collapsible` all off) so an archived run reads as its own
 * wave cards; the raw pane is a scaffold the client fills from `GET /archive/log`.
 * `open`/`mode` mark the row a `?run=` deep-link selected; `hidden` puts it past the
 * cap behind "show older".
 */
const renderArchiveRow = (project: string, run: ArchivedRunView, open: boolean, mode: "campaign" | "raw", hidden: boolean, festive = false) => {
  const label = run.name ?? run.run;
  const when = run.startedAt ? formatRunWhen(run.startedAt) : run.run;
  const bodyId = `archive-body-${run.run}`;
  const rawActive = open && mode === "raw";
  const count = `${run.issues} issue${run.issues === 1 ? "" : "s"}`;
  const modeBtn = (m: "campaign" | "raw", text: string, active: boolean) =>
    `<button type="button" class="archive-mode${active ? " active" : ""}" data-mode="${m}" aria-pressed="${active}">${text}</button>`;
  // Interactive (chips open the shared sheet) but carve-off, and carrying the run
  // token so the sheet reads this archived run's own log — reuse is the point, no
  // second campaign renderer.
  const campaignPane = `<div class="archive-pane archive-campaign" data-pane="campaign"${rawActive ? " hidden" : ""}>${renderWaves(run.status, false, true, false, run.run, festive)}</div>`;
  const rawPane =
    `<div class="archive-pane archive-raw" data-pane="raw" data-project="${escapeHtml(project)}" data-run="${escapeHtml(run.run)}"${rawActive ? "" : " hidden"}>` +
    `<div class="archive-raw-header">orchestrator-${escapeHtml(run.run)}.jsonl</div>` +
    `<input type="text" class="archive-raw-filter" placeholder="Filter lines…" aria-label="Filter log lines" />` +
    `<div class="archive-raw-lines"></div>` +
    `<div class="archive-raw-footer"></div>` +
    `</div>`;
  return (
    `<li class="archive-row${open ? " open" : ""}" data-run="${escapeHtml(run.run)}"${hidden ? " hidden" : ""}>` +
    `<div class="archive-row-head">` +
    `<button type="button" class="archive-toggle" aria-expanded="${open}" aria-controls="${bodyId}">` +
    `<span class="archive-chevron" aria-hidden="true"></span>` +
    `<span class="archive-name">${escapeHtml(label)}</span>` +
    `<span class="archive-when">${escapeHtml(when)}</span>` +
    `<span class="archive-state ${run.state}"><span class="archive-dot ${run.state}"></span>${run.state} · ${count}</span>` +
    `</button>` +
    `<span class="archive-modes" role="group" aria-label="View mode">${modeBtn("campaign", "campaign", !rawActive)}${modeBtn("raw", "raw log", rawActive)}</span>` +
    `</div>` +
    `<div class="archive-body" id="${bodyId}"${open ? "" : " hidden"}>${campaignPane}${rawPane}</div>` +
    `</li>`
  );
};

/**
 * The collapsible archived-runs list — one row per run, newest-first (the order
 * given), capped at the newest `ARCHIVE_CAP` with a "show older" control that
 * reveals the rest (which render hidden in place). Empty when the project has no
 * archived runs. `openRun`/`openMode` open one row on load from a `?run=` deep-link.
 */
const renderArchivedRuns = (project: string, runs: ArchivedRunView[], openRun?: string, openMode?: "campaign" | "raw", festive = false) => {
  if (!runs.length) return "";
  const rows = runs.map((run, i) => renderArchiveRow(project, run, run.run === openRun, openMode ?? "campaign", hiddenPastCap(i, ARCHIVE_CAP), festive));
  const olderCount = runs.length - ARCHIVE_CAP;
  const older = olderCount > 0 ? `<li class="archive-older-row"><button type="button" class="archive-show-older">Show ${olderCount} older run${olderCount === 1 ? "" : "s"}</button></li>` : "";
  // The show-older control sits between the visible rows and the hidden older ones.
  return `<section class="archived-runs"><h2>Archived runs</h2><ul class="archive-list" data-project="${escapeHtml(project)}">${rows.slice(0, ARCHIVE_CAP).join("")}${older}${rows.slice(ARCHIVE_CAP).join("")}</ul></section>`;
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
   * Render the per-chip carve control. The aggregated `serveAllStatus` is a dumb
   * router (ADR 0002) with no project's `blockedBy` resolver, so it routes both
   * preview and confirm to the selected project's own install (`carve … --dry-run`
   * then `carve …`); the control carries its `project` so the aggregated `/carve`
   * targets the right one.
   */
  carve?: boolean;
  /**
   * Render the graft control — the additive counterpart to `carve`. `graft` is
   * variadic and adds *new* issues by explicit id (not a chip selection), so its
   * control is a small form the operator types ids into; the aggregated dumb router
   * routes its preview and confirm to the selected project's own install (`graft …
   * --dry-run` then `graft …`). Gated by the same page option carve rides.
   */
  graft?: boolean;
  /** The selected project's archived runs, newest-first, for the collapsible
   * "Archived runs" list under the live run. Each row expands inline to either its
   * campaign view (rendered read-only through the live wave renderer off `status`)
   * or its raw JSONL log (fetched client-side). */
  archivedRuns?: ArchivedRunView[];
  /** The selected run token — the row to open on load (a `?run=` deep-link);
   * absent leaves every row collapsed. */
  archivedRun?: string;
  /** Which mode the opened row starts in — `campaign` (the default) or `raw`. */
  archivedMode?: "campaign" | "raw";
  /** "Festive Wave Names" — when on (the gear toggle, read server-side from the
   * `festiveWaveNames` cookie), each wave is labelled `index · name` after a Discworld
   * character instead of the plain `Wave N` (#193). Default off. */
  festive?: boolean;
}

/**
 * One archived run as the collapsible list renders it: its timestamp token, its
 * `--name` (falling back to the token), its start time (parsed from the token) and
 * terminal state for the collapsed row, its issue count, and the reconstructed
 * `CampaignStatus` its campaign pane renders read-only through the live wave
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

const renderProjectPicker = (projects: string[], selected: string | undefined) =>
  `<form method="get" action="/" class="project-picker"><select name="project" onchange="this.form.submit()"><option value=""${selected ? "" : " selected"}>All repos</option>${projects
    .map((p) => `<option value="${escapeHtml(p)}"${p === selected ? " selected" : ""}>${escapeHtml(p)}</option>`)
    .join("")}</select></form>`;

/**
 * One repo the dropdown can switch to: its full `owner/name` and its rolled-up run
 * state (the landing's `runState`, ADR 0007), which colours the row's status dot and
 * is its note. A page's caller derives these from the same `CampaignStatus` list the
 * rest of the view reads; a bare name (a caller that has no run state to hand) reads
 * as an idle repo.
 */
export interface RepoOption {
  project: string;
  /** the project's `owner/name`, derived from its git remote — the label the trigger
   * and this repo's row show in place of the bare `project` key; omitted (so the label
   * falls back to `project`) for a project with no parseable remote. Display-only:
   * `data-project` and routing stay keyed on `project`. */
  repo?: string;
  runState: RunState;
}

const asRepoOption = (repo: string | RepoOption): RepoOption => (typeof repo === "string" ? { project: repo, runState: "idle" } : repo);

/**
 * The repo dropdown (#88): the toolbar's page heading and the repo switcher in one
 * control, shared by the landing and the repo page so the two can never drift. The
 * `.repo-trigger` states the current scope as the largest text in the toolbar —
 * `All repos` for the aggregate (`selected` undefined) or the full `owner/name` for a
 * repo — and toggles the `role="listbox"` menu below it. Each menu row is a status
 * dot in the repo's run-state colour (`All repos` the teal accent, since the aggregate
 * has no run state of its own), the full `owner/name` label, and a note (the run state,
 * or the repo count for `All repos`); the current scope's row is filled. A `<noscript>`
 * keeps the native `<select>` as the no-JS switch, so scope still changes without JS.
 */
export const renderRepoDropdown = (repos: readonly (string | RepoOption)[], selected: string | undefined) => {
  const options = repos.map(asRepoOption);
  // The heading and each row show owner/name (the option's `repo`), falling back to the
  // bare `project` key for a repo without one; routing still keys on `project` below.
  const label = selected ? (options.find((repo) => repo.project === selected)?.repo ?? selected) : "All repos";
  const count = `${options.length} repo${options.length === 1 ? "" : "s"}`;
  const row = (project: string, isSelected: boolean, dotClass: string, optLabel: string, note: string) =>
    `<li class="repo-option${isSelected ? " selected" : ""}" role="option" aria-selected="${isSelected}" data-project="${escapeHtml(project)}" tabindex="-1"><span class="repo-dot ${dotClass}" aria-hidden="true"></span><span class="repo-optlabel">${escapeHtml(optLabel)}</span><span class="repo-note">${escapeHtml(note)}</span></li>`;
  const rows = [
    row("", !selected, "all", "All repos", count),
    ...options.map((repo) => row(repo.project, repo.project === selected, repo.runState, repo.repo ?? repo.project, repo.runState)),
  ].join("");
  return `<div class="repo-dropdown" data-repo-dropdown><button type="button" class="repo-trigger" id="repo-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="repo-menu"><span class="repo-label">${escapeHtml(label)}</span><span class="repo-chevron" aria-hidden="true">▾</span></button><ul class="repo-menu" id="repo-menu" role="listbox" aria-label="Switch repo" tabindex="-1" hidden>${rows}</ul><noscript>${renderProjectPicker(options.map((repo) => repo.project), selected)}</noscript></div>`;
};

/**
 * The top bar every page shares (#81): the heading/dropdown on the left and the
 * live-bar (live dot + "updated Ns ago" + pause) on the right, wrapped in the
 * `.page-top` flex row. One definition rendered by the landing, the repo page, and
 * any archived view, so the two can no longer drift — which is what let the "Live"
 * word survive on one and the pause word on the other. The live indicator is a dot
 * only: its "Live"/"Paused" state is an accessible label (`aria-label`), never
 * visible text, keeping motion the one running-only channel (§5). Pause is an icon
 * control — its CSS-drawn bars/triangle live in `TOP_BAR_STYLES`, flipped by
 * `data-paused`, so a page's script only toggles the attribute and never re-authors it.
 * `trailing` seats extra controls at the right end of the live-bar, after the pause
 * button — the host view passes its settings gear there (#201) so it reads as the last
 * of the live controls; pages with nothing to add leave the live-bar untouched.
 */
export const renderTopBar = (left: string, trailing = "") =>
  `<div class="page-top">${left}<div class="live-bar" title="Live updates over SSE; pause to freeze the view while it keeps collecting"><span class="live-indicator" data-live-state="live" aria-label="Live"></span><span class="updated" data-updated>waiting for updates</span><button type="button" id="pause" class="pause" data-paused="false" aria-label="Pause"></button>${trailing}</div></div>`;

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

/** A graft rejection reason (ADR 0014) as the operator reads it in the verdict list —
 * graft's own words, so the dashboard and the CLI name an offender the same way. */
const GRAFT_REASON_TEXT: Record<GraftRejection["reason"], string> = {
  unknown: "not found",
  closed: "closed on GitHub",
  "already-in-campaign": "already in the campaign",
};

/**
 * The aggregated site's graft rejection surface (option 1a): a whole-batch graft
 * (ADR 0014 — all-or-nothing) that found any offender grafts *nothing* and lands
 * here instead of navigating. It renders the batch as a per-id verdict list —
 * "would graft" for the clean ids, the reason per offender — under a "Nothing
 * grafted — fix these" header, carrying the typed ids so the summary-line input can
 * retain them. The client lifts `[data-graft-verdicts]` to show it inline beside the
 * input; served whole it is the no-JS fallback. Red edge — a rejection, distinct
 * from the teal success and the amber structural refusal.
 */
export const renderAggregatedGraftRejection = (project: string, closure: StructuredGraftClosure) => {
  const verdicts = closure.ids
    .map((id) => {
      const rejection = closure.rejected.find((r) => r.id === id);
      const verdict = rejection ? GRAFT_REASON_TEXT[rejection.reason] : "would graft";
      return `<li class="graft-verdict ${rejection ? "bad" : "ok"}">#${escapeHtml(id)} — ${escapeHtml(verdict)}</li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project)} — graft rejected</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: #090c10; color: #e6edf3; }
  h1 { letter-spacing: -0.035em; }
  .card { background: #0b0e12; border: 1px solid #232b35; border-left: 3px solid #f79287; border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; }
  ul { margin: 0; padding-left: 1.2rem; }
  .graft-verdict.bad { color: #f79287; }
  a.cancel { color: #8b98a5; text-decoration: none; }
</style>
</head>
<body>
<h1>Nothing grafted — fix these</h1>
<section class="card" data-graft-rejection data-graft-ids="${escapeHtml(closure.ids.join(" "))}"><ul data-graft-verdicts>${verdicts}</ul></section>
<a class="cancel" href="/?project=${encodeURIComponent(project)}">Back to ${escapeHtml(project)}</a>
</body>
</html>`;
};

/**
 * The issue-detail sheet's markup — one definition rendered by both the campaign
 * page and the all-repos landing (previously hand-synced copies, #76). `carve`
 * includes the in-sheet carve panel: always on the landing (every parked row is
 * carvable), and on the campaign page only when its carve controls are enabled.
 */
export const issueDetailSheetMarkup = (carve: boolean) =>
  `<div id="issue-detail" class="issue-detail" role="dialog" aria-modal="true" aria-live="polite" hidden><div class="issue-detail-sheet"><header class="issue-detail-header"><div class="issue-detail-head-main"><span class="issue-detail-status"><span class="dot"></span><span class="issue-detail-num"></span> <span class="issue-detail-statuslabel"></span></span><h2 class="issue-detail-title"></h2><p class="issue-detail-context"></p></div><button type="button" id="issue-detail-close" class="issue-detail-close" aria-label="Dismiss">&times;</button></header><div class="issue-detail-meta"><div class="meta-tile"><span class="meta-label">Turns</span><span class="meta-value" id="issue-detail-turns"></span></div><div class="meta-tile meta-tile-path" id="issue-detail-worktree-tile" hidden><span class="meta-label">Worktree</span><span class="meta-value meta-value-path" id="issue-detail-worktree"></span></div></div><h3 class="turn-log-heading">Agent turns</h3><ol class="turn-log" id="issue-detail-turnlog"></ol><div id="issue-detail-reply" class="issue-detail-reply" hidden><h3 class="reply-heading">PARKED — NEEDS YOUR ANSWER</h3><p class="reply-question" id="reply-question"></p><div class="reply-options" id="reply-options"></div><form method="post" action="/answer" id="reply-form"><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><textarea name="text" id="reply-text" placeholder="Type your reply…"></textarea></form></div><div class="sheet-actions"><button type="submit" form="reply-form" id="reply-resume" class="reply-resume" hidden>Resume</button>${
    carve
      ? `<div id="carve-panel" class="carve-panel" hidden><button type="button" id="carve-start" class="carve-start">Carve</button><span id="carve-explainer" class="carve-explainer" hidden>Removes this issue and everything blocked by it from the running campaign; merged and mergeable work is kept.</span><form method="post" action="/carve" id="carve-confirm" class="carve-confirm" hidden><span class="carve-confirm-text"></span><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><input type="hidden" name="confirm" value="1" /><button type="submit" class="carve-confirm-btn">Confirm</button><button type="button" id="carve-cancel" class="carve-cancel">Cancel</button></form><span id="carve-note" class="carve-note"></span></div>`
      : ""
  }</div></div></div>`;

/**
 * The host-log surface on the all-repos landing/host view (#180): a settings gear the
 * fleet-level `host.jsonl` (gateway/registry/Telegram/SSE diagnostics across every
 * project, #157) lives behind, plus its attention badge. The gear rides the top-right
 * live-bar after the pause button (#201) — `renderTopBar`'s `trailing` slot — and its
 * pane opens as a popover anchored under it. The gear is the show/hide —
 * the pane is `hidden` until it is clicked, deliberately *not* an always-visible section
 * and *not* folded into the narrated cross-repo event feed (that feed is per-project
 * narratable milestones; this is host diagnostics). The badge (`data-host-log-badge`)
 * reveals when the current window holds a notable event (`isNotableHostEvent`) newer than
 * the operator last opened the pane. The pane is a raw-JSONL viewer — newest-first,
 * bounded, JSON-highlighted (reusing `highlightJsonLine`) — with a single substring
 * filter as its only control (no follow/pause/save/clear; that fuller surface is the agent
 * live-tail's, #124). The server renders only this shell; the client fills the lines from
 * `GET /api/host-log` on open and appends live over the `/api/events` `host` frame.
 */
export const renderHostLog = () =>
  `<section class="host-log" data-host-log>` +
  `<button type="button" class="host-log-gear" data-host-log-gear aria-expanded="false" aria-haspopup="dialog" aria-label="Host log" title="Host log — fleet-level diagnostics">` +
  `<span class="host-log-gear-icon" aria-hidden="true">⚙</span>` +
  `<span class="host-log-badge" data-host-log-badge hidden aria-hidden="true">!</span>` +
  `</button>` +
  `<div class="host-log-panel" data-host-log-panel hidden role="dialog" aria-label="Host log">` +
  `<div class="host-log-head"><span class="host-log-title">host.jsonl</span><span class="host-log-gap"></span><button type="button" class="host-log-close" data-host-log-close aria-label="Close host log">&times;</button></div>` +
  // The gear doubles as the fleet settings surface: the "Festive Wave Names" toggle (#193),
  // an unchecked-by-default checkbox the client syncs to the `festiveWaveNames` cookie.
  `<div class="host-log-settings"><label class="festive-toggle"><input type="checkbox" data-festive-toggle /> Festive wave names</label></div>` +
  `<input type="text" class="host-log-filter" data-host-log-filter placeholder="filter lines…" aria-label="Filter host log lines" />` +
  // The shared log-view controls (#203): the Humanized ⇄ Raw segmented toggle (humanized the
  // pressed default, seeded server-side; the client re-syncs from the remembered mode) and a
  // Download JSON control that always emits the raw NDJSON. Reuses the live tail's .tail-mode /
  // .tail-save classes (both style blocks ride the landing shell), so the two surfaces match.
  `<div class="host-log-controls">` +
  `<span class="tail-mode" data-host-log-mode role="group" aria-label="Line format">` +
  `<button type="button" class="tail-mode-btn" data-mode="humanized" aria-pressed="true">Humanized</button>` +
  `<button type="button" class="tail-mode-btn" data-mode="raw" aria-pressed="false">Raw</button>` +
  `</span>` +
  `<span class="host-log-gap"></span>` +
  `<button type="button" class="tail-save" data-host-log-save>Download JSON</button>` +
  `</div>` +
  `<div class="host-log-lines" data-host-log-lines></div>` +
  `<div class="host-log-footer" data-host-log-footer></div>` +
  `</div>` +
  `</section>`;

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
export const renderLandingShell = (projects: readonly (string | RepoOption)[]) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>All repos — Vetinari</title>
<style>
${DASHBOARD_PALETTE_CSS}
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; background: var(--color-body); color: var(--color-text); }
  h1 { font-size: clamp(1.6rem, 4vw, 2.6rem); margin: 0; letter-spacing: -0.035em; }
${TOP_BAR_STYLES}
${HOST_LOG_STYLES}
${LIVE_TAIL_STYLES}
  .counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: .75rem; margin: 1.25rem 0; }
  .counter { background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; }
  .counter-toggle { font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .counter-toggle:hover:not(:disabled) { background: var(--color-card-hover); }
  .counter-toggle:disabled { cursor: default; }
  .counter-value { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 700; letter-spacing: -0.02em; }
  .counter-toggle:not(:disabled) .counter-value::after { content: " ▸"; color: var(--color-text-light-2); font-size: .9em; }
  .counter-toggle[aria-expanded="true"] .counter-value::after { content: " ▾"; }
  .counter-label { color: var(--color-text-light-2); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .35rem; }
  /* Value + sublabel share one baseline-aligned row under the label, matching the POC (#94). */
  .counter-line { display: flex; align-items: baseline; gap: .5rem; }
  /* Each counter value reads in its status colour; queued stays neutral (#80). */
  [data-counter="working"] .counter-value { color: var(--color-blue); } [data-counter="parked"] .counter-value { color: var(--color-yellow); } [data-counter="mergedToday"] .counter-value { color: var(--color-green); }
  /* Parked is the one actionable counter — gold border while it holds questions (enabled) (#80). */
  .counter-toggle[data-counter="parked"]:not(:disabled) { border-color: var(--color-yellow); }
  .counter-sub { color: var(--color-text-light-2); font-size: .75rem; }
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
  .progress-track { height: .4rem; background: var(--color-secondary); border-radius: 999px; overflow: hidden; margin: .1rem 0 .55rem; }
  .progress-fill { height: 100%; border-radius: 999px; background: var(--color-dim); }
  .progress-fill.running { background: var(--color-blue); } .progress-fill.parked { background: var(--color-yellow); } .progress-fill.completed { background: var(--color-green); }
  /* The tally reads as status-dot pill chips, matching the campaign page's chips (#80). */
  .card-tally { display: flex; flex-wrap: wrap; gap: .4rem; color: var(--color-text-light); font-size: .8rem; }
  .tally-chip { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--color-secondary); border-radius: 999px; padding: .15rem .5rem; background: var(--color-chip); }
  .card-last { color: var(--color-text-light-2); font-size: .85rem; margin-top: .5rem; white-space: pre-line; }
  .empty { color: var(--color-text-light-2); }
  /* The event-log feed reads as a sibling of the live tail (#196): it draws the shared pane
     chrome (.live-tail container, .tail-head header, .tail-controls strip, .tail-backlog,
     .tail-footer) from LIVE_TAIL_STYLES; only its row anatomy (dot + prose, below) and the
     prose scroll body differ from the tail's mono raw lines. */
  .feed { margin-top: 2rem; }
  /* The feed's own scroll body — the tail's .tail-body is mono/fixed-height for raw JSON, so
     the narrated feed keeps sans-serif prose in a bounded, scrollable pane of its own. */
  .feed-body { max-height: 22rem; overflow-y: auto; background: var(--color-body); padding: 0 .9rem; }
  .feed-body[hidden] { display: none; }
  .feed-row { display: flex; align-items: baseline; gap: .6rem .9rem; flex-wrap: wrap; padding: .5rem 0; border-bottom: 1px solid var(--color-light-border); font-size: .9rem; }
  .feed-time { color: var(--color-text-light-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* The kind reads as a clean lowercase namespace.verb code label (#95), so it is mono
     and no longer uppercased; its category still reads on the full-strength leading dot. */
  .feed-kind { color: var(--color-text); font-family: ${MONO_FONT}; font-size: .72rem; font-weight: 600; letter-spacing: 0; display: inline-flex; align-items: center; gap: .4rem; }
  /* Each activity event reads its comms category as a full-strength leading dot,
     keeping the label at --color-text — a mid-tone tint on tiny near-black text
     struck out the blue progress kind (#85, matching the shared dot model #83). */
  .feed-kind::before { content: ""; width: .5rem; height: .5rem; border-radius: 999px; background: var(--color-dim); flex: none; }
  .feed-kind.progress::before { background: var(--color-blue); } .feed-kind.success::before { background: var(--color-green); } .feed-kind.attention::before { background: var(--color-yellow); } .feed-kind.failure::before { background: var(--color-failure); } .feed-kind.carved::before { background: var(--color-carved); }
  .feed-text { color: var(--color-text-light); flex: 1; }
  /* The feed body's loading/empty placeholder sits inside the padded scroll pane. */
  .feed-body .empty { padding: .6rem 0; }
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
    .parked-row { grid-template-columns: auto 1fr; }
    .parked-question { grid-column: 1 / -1; }
    .live-bar { width: 100%; justify-content: space-between; }
  }
</style>
</head>
<body>
${renderTopBar(renderRepoDropdown(projects, undefined), renderHostLog())}
<section class="counters">
  <div class="counter" data-counter="working"><div class="counter-label">Agents working</div><div class="counter-line"><div class="counter-value">–</div><div class="counter-sub" data-counter-sub="working"></div></div></div>
  <button type="button" class="counter counter-toggle" data-counter="parked" disabled aria-controls="parked-queue"><div class="counter-label">Parked</div><div class="counter-line"><div class="counter-value">–</div><div class="counter-sub" data-counter-sub="parked"></div></div></button>
  <div class="counter" data-counter="queued"><div class="counter-label">Queued</div><div class="counter-line"><div class="counter-value">–</div><div class="counter-sub" data-counter-sub="queued"></div></div></div>
  <div class="counter" data-counter="mergedToday"><div class="counter-label">Merged today</div><div class="counter-line"><div class="counter-value">–</div><div class="counter-sub" data-counter-sub="mergedToday"></div></div></div>
</section>
<section id="parked-queue" class="parked-queue" hidden aria-label="Parked questions across all repos"></section>
<section id="cards" class="cards"><p class="empty">Loading…</p></section>
<section id="feed" class="live-tail feed" data-feed aria-label="Event log across all repos"><div class="tail-head"><span class="tail-dot" data-feed-dot aria-hidden="true"></span><span class="tail-title tail-title-static">Event log · all repos</span><span class="tail-summary" data-feed-summary></span><span class="tail-gap"></span><span class="tail-controls" data-feed-controls><input type="text" class="tail-filter" placeholder="filter events…" aria-label="Filter events" data-feed-filter /><button type="button" class="tail-play" data-feed-play data-following="true" aria-label="Pause"></button><button type="button" class="tail-save" data-feed-save>Save</button><button type="button" class="tail-clear" data-feed-clear>Clear</button></span></div><div class="feed-body" data-feed-body><p class="empty">Loading…</p></div><button type="button" class="tail-backlog" data-feed-backlog hidden></button><div class="tail-footer" data-feed-footer></div></section>
${issueDetailSheetMarkup(true)}
<script>
  // The state → visual-intent reducers (dashboard-visual-state.ts, ADR 0012), single-
  // sourced into the browser via .toString() so the node test runs the very function
  // this page ships. The __name shim satisfies the keepNames wrapper a bundling build
  // could leave on a named function (a no-op when none is applied, matching the archive
  // list's shipped colourer).
  const __name = (fn) => fn;
  ${dotClass.toString()}
  ${tallyDotClass.toString()}
  ${freezeIntent.toString()}
  const fmtWave = (w) => (w ? "Wave " + w.current + " of " + w.total : "idle");
  // The event log's compact time (#95): a same-day event reads as a 24h HH:MM; an
  // older one falls back to a short weekday (POC's "Tue"), then to a M/D date once it
  // is more than a week back so distant weekdays don't collide.
  const fmtTime = (ts) => {
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return d.toTimeString().slice(0, 5);
    if (now - d < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  };
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
  // The event-log feed's pure logic is single-sourced from dashboard-render via .toString()
  // (ADR 0012): the shared follow/pause/backlog view-model (followView) and following-buffer
  // append (tailAppend) the live tail also drives, plus the feed's dedup (feedFresh/feedKey),
  // its kind→label/category maps and its (kind, text) filter — so the node tests exercise the
  // very functions the browser runs and the two panes share one tested path (#196).
  ${followView.toString()}
  ${tailAppend.toString()}
  ${feedKey.toString()}
  ${feedFresh.toString()}
  ${feedKindLabel.toString()}
  ${feedKindClass.toString()}
  ${feedRowMatches.toString()}
${ISSUE_DETAIL_SHEET_SCRIPT}
${REPO_DROPDOWN_SCRIPT}
  // The event-log feed (#196): a live-tail-style pane over the cross-project narrated feed. The
  // server returns the whole 48h window newest-first on each /api/feed fetch; the client folds
  // the genuinely-new rows (feedFresh) into an oldest→newest buffer and drives the shared
  // follow/pause/backlog view-model, so it reads as a sibling of the raw tail. Follow, filter,
  // save and clear are the tail's affordances adapted to narrated rows; the old show-older cap
  // folds into the scrolling pane + render cap.
  const FEED_FOLLOW_CAP = 300, FEED_RENDER_CAP = 160;
  const feedEl = document.querySelector("[data-feed]");
  const fq = (sel) => feedEl.querySelector(sel);
  const feedDot = fq("[data-feed-dot]"), feedSummary = fq("[data-feed-summary]"), feedBody = fq("[data-feed-body]");
  const feedFooter = fq("[data-feed-footer]"), feedBacklog = fq("[data-feed-backlog]"), feedPlay = fq("[data-feed-play]");
  const feedFilter = fq("[data-feed-filter]"), feedSave = fq("[data-feed-save]"), feedClear = fq("[data-feed-clear]");
  let feedBuffer = [], feedSeen = {}, feedLive = true, feedMark = 0, feedQuery = "", feedLoaded = false, feedError = false;
  // One narrated text line per row for the save-visible export (the feed has no raw JSON).
  const feedNarrate = (e) => fmtTime(e.ts) + "  " + feedKindLabel(e.kind) + " — " + e.text;
  const feedMatch = (e) => feedRowMatches(e, feedQuery);
  function feedRender() {
    const view = followView({ buffer: feedBuffer, mark: feedMark, live: feedLive, cap: FEED_RENDER_CAP, match: feedMatch });
    feedBody.textContent = "";
    if (feedError) { feedBody.append(el("p", "empty", "Couldn't load the activity feed.")); }
    else if (!feedLoaded) { feedBody.append(el("p", "empty", "Loading…")); }
    else if (view.rows.length) {
      for (const e of view.rows) {
        const row = el("div", "feed-row");
        row.append(el("span", "feed-time", fmtTime(e.ts)), el("span", "feed-kind " + feedKindClass(e.kind), feedKindLabel(e.kind)), el("span", "feed-text", e.text));
        feedBody.append(row);
      }
    } else {
      feedBody.append(el("p", "empty", feedQuery.trim() ? "No events match that filter." : "No activity in the last 48 hours."));
    }
    feedFooter.textContent = feedLoaded && !feedError ? (view.visible + " of " + view.total + " event" + (view.total === 1 ? "" : "s") + " · " + (view.following ? "following" : "paused")) : "";
    // Newest-on-top (#195), so the backlog affordance points up to the freshest events.
    if (view.backlog > 0) { feedBacklog.hidden = false; feedBacklog.textContent = "↑ " + view.backlog + " new event" + (view.backlog === 1 ? "" : "s"); } else { feedBacklog.hidden = true; }
    feedPlay.dataset.following = String(feedLive); feedPlay.setAttribute("aria-label", feedLive ? "Pause" : "Resume");
    feedDot.dataset.state = feedLive ? "live" : "idle";
    feedSummary.textContent = feedLoaded && !feedError ? (view.total + " event" + (view.total === 1 ? "" : "s")) : "";
    if (feedLive) feedBody.scrollTop = 0;
  }
  function feedIngest(entries) {
    const res = feedFresh(entries, feedSeen); feedSeen = res.seen;
    // Grow past the cap while paused so a piling backlog survives to be revealed on resume;
    // following keeps the buffer bounded to a recent window.
    if (res.fresh.length) feedBuffer = tailAppend(feedBuffer, res.fresh, feedLive, FEED_FOLLOW_CAP);
    feedRender();
  }
  async function loadFeed() {
    let feed;
    try { feed = await (await fetch("/api/feed")).json(); }
    catch { feedError = true; feedLoaded = true; feedRender(); return; }
    feedError = false; feedLoaded = true;
    feedIngest(feed);
  }
  feedPlay.addEventListener("click", () => { feedLive = !feedLive; feedMark = feedBuffer.length; feedRender(); });
  feedBacklog.addEventListener("click", () => { feedLive = true; feedMark = feedBuffer.length; feedRender(); });
  feedFilter.addEventListener("input", () => { feedQuery = feedFilter.value; feedRender(); });
  feedSave.addEventListener("click", () => {
    // The currently visible (filtered) rows — uncapped by the render window — as narrated text
    // lines, one per row (there is no underlying raw JSON to emit).
    const view = followView({ buffer: feedBuffer, mark: feedMark, live: feedLive, cap: Math.max(feedBuffer.length, 1), match: feedMatch });
    const blob = new Blob([view.rows.map(feedNarrate).join("\\n")], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "event-log.txt"; a.click(); URL.revokeObjectURL(a.href);
  });
  // Clear drops only this view's buffered rows client-side; no events or logs are touched. The
  // seen set is kept so the server's still-held window isn't re-imported on the next fetch (the
  // clear sticks until genuinely-new events arrive).
  feedClear.addEventListener("click", () => { feedBuffer = []; feedMark = 0; feedRender(); });
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
      mergedToday: "All repos",
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
      // The heading shows owner/name (p.repo), falling back to the bare key; the card's
      // href and data below stay keyed on p.project, so routing is unchanged (display-only).
      top.append(el("span", "card-project", p.repo ?? p.project), el("span", "run-state " + p.runState, p.runState));
      card.append(top);
      if (p.campaignName) card.append(el("div", "card-campaign", p.campaignName));
      const meta = el("div", "card-meta");
      meta.append(el("span", null, fmtWave(p.wave)), el("span", null, p.percentMerged + "% merged"));
      card.append(meta);
      // A percentMerged-width bar under the meta line, filled in the run state's colour (#80).
      const progress = el("div", "progress-track");
      const fill = el("div", "progress-fill " + p.runState);
      fill.style.width = p.percentMerged + "%";
      progress.append(fill);
      card.append(progress);
      // The tally reads as status-dot chips rather than plain text (#80): running blue,
      // parked yellow, queued neutral — the dots scoped to .dot so they don't tint the pills.
      const tally = el("div", "card-tally");
      for (const [bucket, count] of [["running", p.tally.running], ["parked", p.tally.parked], ["queued", p.tally.queued]]) {
        const chip = el("span", "tally-chip");
        // A "0 running" tally dot stays blue but is marked idle so it doesn't pulse — motion
        // signals active work, and a zero tally has none (§5, #100). tallyDotClass owns that rule.
        chip.append(el("span", "dot " + tallyDotClass({ kind: bucket, count })), el("span", null, count + " " + bucket));
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
  // freezeIntent (dashboard-visual-state.ts) decides; the glue below only writes to the DOM.
  const renderUpdated = () => {
    // While paused the readout reads "Paused" rather than ageing a frozen count; it resumes
    // "updated Ns ago" on unpause (§5, #100).
    updatedEl.textContent = freezeIntent({ paused, buffered, lastUpdate, now: Date.now() }).updatedText;
  };
  // The indicator is a dot only: its state is an accessible label, never visible text.
  // Pause is an icon flipped by data-paused (the CSS-drawn bars/triangle live in CSS).
  const renderState = () => {
    // The single control for all pulsing (§5, #100): one root flag on the body freezes
    // every dot — green live dots and blue running dots — at once via one CSS rule.
    const intent = freezeIntent({ paused, buffered, lastUpdate, now: Date.now() });
    document.body.dataset.paused = intent.bodyPaused;
    indicator.dataset.liveState = intent.liveState;
    indicator.setAttribute("aria-label", intent.ariaLabel);
    pauseBtn.dataset.paused = intent.bodyPaused;
    pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
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
    if (!paused && buffered) { buffered = 0; refresh(); }
    renderState();
    renderUpdated();
  });
  // A live pane (the host-log) that visibly appends is a co-equal update (#198): reset the
  // freshness clock so "updated Ns ago" reflects any live surface, not just a feed refresh.
  // A paused page keeps reading "Paused" (freezeIntent ignores the clock while paused), so
  // background appends never advance a visible clock — normal behaviour returns on resume.
  window.addEventListener("vetinari:activity", () => { if (!paused) { lastUpdate = Date.now(); renderUpdated(); } });
  renderState();
  setInterval(renderUpdated, 1000);
  refresh();
${HOST_LOG_SCRIPT}
</script>
</body>
</html>`;

/**
 * The live raw-log tailing pane (#124): a collapsible card that merges the raw JSONL
 * activity of every currently-running agent into one issue-keyed, following view. The
 * server renders the shell — header (tail status dot, disclosure title, agent-count
 * summary) and the open-only controls (issue dropdown seeded with the running issues,
 * substring filter, play/pause, save, clear) — plus an empty body/footer the client
 * fills from the `/api/events` SSE `tail` frames. It renders `hidden` when no agent is
 * running (so the client can reveal it the moment one starts, since it lives outside the
 * soft-refreshed `#live-region`) and visible otherwise. Status vocabulary is ours (ADR
 * 0007): the gutter/dot colours key off each running issue's `IssueStatus`, never the
 * mockup's `queued`. The body's JSON colouring and line accumulation are wired in the
 * client script (`LIVE_TAIL_SCRIPT`), reusing `highlightJsonLine`.
 */
export const renderLiveTail = (status: CampaignStatus, streaming = true) => {
  const running = status.waves.flatMap((wave) => wave.issues).filter((issue) => issue.status === "running");
  const summary = `${running.length} agent${running.length === 1 ? "" : "s"}`;
  const issueRow = (issue: string, dot: string, label: string) =>
    `<li class="tail-issue-option" role="option" data-issue="${escapeHtml(issue)}"><span class="dot ${dot}"></span>${escapeHtml(label)}</li>`;
  const options = [
    issueRow("", "all", "all agents"),
    ...running.map((issue) => issueRow(issue.issueNumber, dotClass(issue.status), `#${issue.issueNumber}`)),
  ].join("");
  // Each running issue and its status colour, so the client can colour a line's gutter by
  // its issue and rebuild the dropdown as agents come and go over the SSE.
  const agentsJson = escapeHtml(JSON.stringify(running.map((issue) => ({ issue: issue.issueNumber, status: issue.status }))));
  // The Humanized ⇄ Raw segmented toggle (#203): humanized rows by default, Raw flipping the body
  // to highlighted NDJSON. Per-view and remembered client-side; the server seeds humanized active.
  const modeBtn = (mode: "humanized" | "raw", label: string) =>
    `<button type="button" class="tail-mode-btn" data-mode="${mode}" aria-pressed="${mode === "humanized"}">${label}</button>`;
  const modeToggle = `<span class="tail-mode" data-tail-mode role="group" aria-label="Line format">${modeBtn("humanized", "Humanized")}${modeBtn("raw", "Raw")}</span>`;
  // A streaming source follows/pauses and its dot pulses live; a static (archived) source has no
  // stream to follow, so the play/pause control is omitted and the dot is seeded idle (#203).
  const playBtn = streaming ? `<button type="button" class="tail-play" data-tail-play data-following="true" aria-label="Pause"></button>` : "";
  const dot = streaming ? `<span class="tail-dot" data-tail-dot aria-hidden="true"></span>` : `<span class="tail-dot" data-tail-dot data-state="idle" aria-hidden="true"></span>`;
  return (
    `<section class="live-tail" data-live-tail data-project="${escapeHtml(status.project)}" data-agents="${agentsJson}"${running.length ? "" : " hidden"}>` +
    `<div class="tail-head">` +
    dot +
    `<button type="button" class="tail-title" data-tail-toggle aria-expanded="true"><span class="tail-caret" aria-hidden="true"></span>Live tail · agent logs</button>` +
    `<span class="tail-summary" data-tail-summary>${summary}</span>` +
    `<span class="tail-gap"></span>` +
    `<span class="tail-controls" data-tail-controls>` +
    `<span class="tail-issue-dd" data-tail-issue-dd><button type="button" class="tail-issue-trigger" data-tail-issue-trigger aria-haspopup="listbox" aria-expanded="false"><span class="dot all" data-tail-issue-dot></span><span data-tail-issue-label>all agents</span><span class="tail-issue-caret" aria-hidden="true">▾</span></button><ul class="tail-issue-menu" role="listbox" aria-label="Filter by agent" data-tail-issue-menu hidden>${options}</ul></span>` +
    `<input type="text" class="tail-filter" placeholder="filter lines…" aria-label="Filter tail lines" data-tail-filter />` +
    modeToggle +
    playBtn +
    `<button type="button" class="tail-save" data-tail-save>Download JSON</button>` +
    `<button type="button" class="tail-clear" data-tail-clear>Clear</button>` +
    `</span>` +
    `</div>` +
    `<div class="tail-body" data-tail-body></div>` +
    `<button type="button" class="tail-backlog" data-tail-backlog hidden></button>` +
    `<div class="tail-footer" data-tail-footer></div>` +
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
  .waves-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; margin: 1rem 0; }
  .wave { background: var(--color-card); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: 1rem; box-shadow: 0 8px 22px #0004; border-top: 3px solid var(--color-dim); }
  .wave.running { border-top-color: var(--color-blue); }
  /* A closed wave's card carries the green top edge its CLOSED state reads (§2). */
  .wave.closed { border-top-color: var(--color-green); }
  /* A wave-parked wave — a red merged base holds it (ADR 0013) — carries the attention
     amber top edge, the same amber an issue parked reads (§2). */
  .wave.wave-parked { border-top-color: var(--color-yellow); }
  /* An interrupted archived run's in-flight wave (#152) reads the same caution amber
     the run-level state dot does — it stopped without finishing. */
  .wave.interrupted { border-top-color: var(--color-yellow); }
  /* A flex-grid item beats the UA [hidden] rule, so a collapsed closed card needs it back explicitly. */
  .wave.closed[hidden] { display: none; }
  /* One stable head row: the label takes the slack and wraps within itself, the meta
     group (merged/total · state · carved) stays a nowrap unit on the right so the state
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
  .wave-member.carved { color: var(--color-text-light-2); text-decoration: line-through; }
  .wave-status { font-size: .85rem; margin-left: .5rem; text-transform: uppercase; letter-spacing: .03em; }
  .wave-status.closed { border-color: var(--color-green); color: var(--color-green); background: rgb(63 185 132 / 12%); }
  .wave-status.running { border-color: var(--color-blue); color: var(--color-blue); background: rgb(108 182 255 / 12%); }
  .wave-status.unstarted { border-color: var(--color-dim); color: var(--color-dim); background: rgb(95 107 120 / 12%); }
  .wave-status.wave-parked { border-color: var(--color-yellow); color: var(--color-yellow); background: rgb(200 162 78 / 12%); }
  .wave-status.interrupted { border-color: var(--color-yellow); color: var(--color-yellow); background: rgb(200 162 78 / 12%); }
  .wave-carved { font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--color-carved); border: 1px solid var(--color-carved); background: rgb(163 113 247 / 12%); border-radius: 999px; padding: .1rem .5rem; }
  /* Status dot colours, generated once from stateColor and shared with the landing
     (§3), scoped to .dot so a state never tints a whole chip, card, or list row (#81). */
  ${STATE_DOT_CSS}
  textarea { width: 100%; max-width: 100%; min-height: 7rem; margin: .5rem 0; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); padding: .75rem; }
${ISSUE_DETAIL_SHEET_STYLES}
  .carve-fallback form { display: inline; }
  form button { padding: .5rem .8rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; cursor: pointer; font-weight: 700; }
  /* The wave-park Resume banner (#171): an attention-amber left edge (the human-action
     queue, §2) with the Resume action pushed to the right. The button is a control, so it
     takes the primary accent, never a state colour. */
  .resume-banner { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; background: var(--color-card); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: .8rem 1rem; margin: 1rem 0; box-shadow: 0 8px 22px #0004; }
  .resume-banner-text { color: var(--color-text-light); }
  .resume-form { margin: 0; }
  .resume-btn { padding: .5rem .8rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; cursor: pointer; font-weight: 700; }
  /* The quarantine note (#171) is informational only — same amber edge, no action. */
  .quarantine-note { background: var(--color-card); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: .8rem 1rem; margin: 1rem 0; color: var(--color-text-light); box-shadow: 0 8px 22px #0004; }
  .quarantine-note code { color: var(--color-text); }
  /* The Graft affordance (1a, #202): a quiet input riding the campaign summary line,
     pushed to the right so the meta text keeps the left. Unobtrusive at rest — a dim
     placeholder and a greyed button — it wakes to the teal product accent once ids are
     typed (the client flips [data-graft-active]); teal for success, never a state (§1). */
  .campaign-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: .75rem 0 0; }
  .campaign-summary .campaign-meta { margin: 0; }
  .graft-inline { margin: 0; display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
  .graft-ids { padding: .35rem .55rem; border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: var(--color-chip); color: var(--color-text); font: inherit; font-size: .85rem; caret-color: var(--color-primary); }
  .graft-ids:disabled { color: var(--color-dim); }
  .graft-inline[data-graft-active] .graft-ids { border-color: var(--color-primary); }
  /* Greyed and inert at rest; teal outline once ids are entered, filling on hover. */
  .graft-btn { padding: .35rem .7rem; border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: none; color: var(--color-text-light-2); cursor: pointer; font: inherit; font-size: .85rem; }
  .graft-btn:disabled { color: var(--color-dim); cursor: default; }
  .graft-inline[data-graft-active] .graft-btn { border-color: var(--color-primary); color: var(--color-primary); }
  .graft-inline[data-graft-active] .graft-btn:hover { background: var(--color-primary); color: #04110f; }
  /* A bad-id / whole-batch rejection surfaces inline beside the input — the rejection red
     (a control's refusal, distinct from the failure state and the amber refusal, §1). */
  .graft-error { color: var(--color-red); font-size: .82rem; }
  .graft-error[hidden] { display: none; }
  /* Structural refusal — a finished campaign has nothing to layer into. Amber guidance
     (the caution channel, §1), distinct from the teal success and the red rejection. */
  .graft-refusal { color: var(--color-yellow); font-size: .82rem; }
  .graft-refusal code { color: var(--color-text-light); }
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
  /* The collapsible archived-runs list (#98): rows separated by hairlines, one open
     at a time, the open row tinted. */
  .archived-runs { margin: 1.5rem 0; }
  .archive-list { list-style: none; margin: .75rem 0 0; padding: 0; border: 1px solid var(--color-light-border); border-radius: var(--border-radius-medium); overflow: hidden; }
  .archive-row + .archive-row, .archive-older-row { border-top: 1px solid var(--color-light-border); }
  .archive-row.open { background: var(--color-card); }
  .archive-row[hidden] { display: none; }
  .archive-row-head { display: flex; align-items: center; gap: .75rem; }
  .archive-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: .75rem; text-align: left; padding: .7rem 1rem; background: none; border: 0; color: var(--color-text); font: inherit; cursor: pointer; }
  .archive-toggle:hover { background: var(--color-card-hover); }
  /* The chevron is CSS keyed off aria-expanded — the client only flips the attribute. */
  .archive-chevron::before { content: "›"; display: inline-block; color: var(--color-text-light-2); transition: transform 150ms; }
  .archive-toggle[aria-expanded="true"] .archive-chevron::before { transform: rotate(90deg); }
  .archive-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .archive-when { color: var(--color-text-light-2); font-size: .85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .archive-state { margin-left: auto; display: inline-flex; align-items: center; gap: .4rem; font-size: .82rem; color: var(--color-text-light); white-space: nowrap; }
  /* The run-level state dot: complete reads green, interrupted the caution amber
     (a run disposition, not one of the ADR-0007 issue states). */
  .archive-dot { width: .6rem; height: .6rem; border-radius: 999px; flex: none; }
  .archive-dot.complete { background: var(--color-green); }
  .archive-dot.interrupted { background: var(--color-yellow); }
  /* The joined mode control: two segments in one pill, the active side filled. */
  .archive-modes { flex: none; display: inline-flex; margin-right: 1rem; border: 1px solid var(--color-secondary); border-radius: 999px; overflow: hidden; }
  .archive-mode { padding: .25rem .6rem; background: none; border: 0; color: var(--color-text-light-2); font: inherit; font-size: .8rem; cursor: pointer; }
  .archive-mode + .archive-mode { border-left: 1px solid var(--color-secondary); }
  .archive-mode[aria-pressed="true"] { background: var(--color-primary); color: #04110f; }
  .archive-show-older { width: 100%; padding: .6rem 1rem; text-align: left; background: none; border: 0; color: var(--color-primary); font: inherit; cursor: pointer; }
  .archive-show-older:hover { background: var(--color-card-hover); }
  .archive-body { padding: 0 1rem 1rem; }
  .archive-body[hidden] { display: none; }
  .archive-pane[hidden] { display: none; }
  /* Raw-log pane (#98): one JSONL line per row with a line-number gutter, JSON
     syntax colouring, and long lines wrapped rather than scrolled. */
  .archive-raw-header { font-family: ${MONO_FONT}; font-size: .8rem; color: var(--color-text-light-2); padding: .3rem 0 .5rem; }
  .archive-raw-filter { width: 100%; max-width: 100%; margin: 0 0 .6rem; padding: .45rem .6rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; }
  .archive-raw-lines { font-family: ${MONO_FONT}; font-size: .8rem; }
  .archive-raw-line { display: flex; gap: .75rem; padding: .05rem 0; }
  .archive-raw-line:target { background: var(--color-primary-alpha-20); }
  .archive-lineno { flex: none; width: 3ch; text-align: right; color: var(--color-dim); text-decoration: none; font-variant-numeric: tabular-nums; }
  .archive-lineno:hover { color: var(--color-primary); }
  .archive-raw-code { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--color-text-light); }
  .archive-raw-code .jkey { color: var(--color-blue); }
  .archive-raw-code .jstr { color: var(--color-green); }
  .archive-raw-code .jnum { color: var(--color-yellow); }
  .archive-raw-code .jbool, .archive-raw-code .jnull { color: var(--color-carved); }
  .archive-raw-more { display: block; width: 100%; padding: .5rem 0; margin-top: .4rem; text-align: left; background: none; border: 0; color: var(--color-primary); font: inherit; cursor: pointer; }
  .archive-raw-more:hover { color: var(--color-text); }
  .archive-raw-footer { color: var(--color-text-light-2); font-size: .8rem; margin-top: .6rem; }
  .archive-raw-empty { color: var(--color-text-light-2); padding: .5rem 0; }
  /* On a phone the raw-log pane's wide JSONL lines don't fit and the head's mode
     toggle crowds the row (#153), so drop the raw surface: hide the campaign/raw
     toggle and force the campaign (wave) pane, even for a run deep-linked in raw
     mode (its campaign pane carries the hidden attribute, its raw pane does not).
     The raw log is a desktop/debugging surface; a phone wants the wave summary. */
  @media (max-width: 640px) {
    .archive-modes { display: none; }
    .archive-pane.archive-raw { display: none; }
    .archive-pane.archive-campaign[hidden] { display: block; }
  }
</style>${
  // No-JS fallback for the closed-wave toggles: the cards are hidden and the chips
  // inert without JS, so reveal every closed card in the grid and hide the toggle bar,
  // keeping the content reachable (the old <details> degraded the same way). Emitted
  // only when there are closed waves to fall back for.
  status.waves.some((wave) => wave.status === "closed")
    ? `\n<noscript><style>.completed-wave-bar { display: none; } .wave.closed[hidden] { display: block; }</style></noscript>`
    : ""
}
</head>
<body>
${renderTopBar(opts.projects?.length ? renderRepoDropdown(opts.projects, opts.selected ?? status.project) : `<h1>${escapeHtml(status.project)}</h1>`)}
<div id="live-region">${
  // The wave-park Resume control and the quarantine note are aggregated-page actions
  // (the same `carve` page option gates the interactive shell-out affordances), each
  // gated on its attention state so it appears only when there is something to act on.
  opts.carve && isWaveParked(status) ? renderResumeControl(status) : ""
}${opts.carve && hasQuarantined(status) ? renderQuarantineNote() : ""}${
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
${
  // The summary line: the meta bare, or — under the graft page option — the meta paired
  // with the quiet inline graft input (1a), the two laid out as one summary row.
  status.waves.length
    ? opts.graft
      ? `<div class="campaign-summary">${renderCampaignMeta(status)}${renderGraftInline(status)}</div>`
      : renderCampaignMeta(status)
    : ""
}
${renderWaves(status, Boolean(opts.carve), true, true, undefined, Boolean(opts.festive))}</div>
${renderLiveTail(status)}
${opts.archivedRuns?.length ? renderArchivedRuns(opts.selected ?? status.project, opts.archivedRuns, opts.archivedRun, opts.archivedMode, Boolean(opts.festive)) : ""}
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
  // The presentation-freeze reducer (dashboard-visual-state.ts, ADR 0012), single-sourced
  // into the browser via .toString() so the node test runs the very function this page
  // ships. The __name shim satisfies the keepNames wrapper a bundling build could leave on
  // a named function (a no-op when none is applied).
  const __name = (fn) => fn;
  ${freezeIntent.toString()}
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
  // A reply being composed anywhere (a parked card's sheet reply) must never be lost
  // to a live refresh; this guards it the way the old full-reload one did.
  const isComposing = () =>
    [...document.querySelectorAll("textarea")].some((el) => el === document.activeElement || el.value.trim() !== "");
  const indicator = document.querySelector("[data-live-state]");
  const updatedEl = document.querySelector("[data-updated]");
  const pauseBtn = document.getElementById("pause");
  let paused = false;
  let buffered = 0;
  let lastUpdate = Date.now();
  // freezeIntent (dashboard-visual-state.ts) decides; the glue below only writes to the DOM.
  // While paused the readout reads "Paused" rather than ageing a frozen count; it resumes
  // "updated Ns ago" on unpause (§5, #100).
  const renderUpdated = () => { updatedEl.textContent = freezeIntent({ paused, buffered, lastUpdate, now: Date.now() }).updatedText; };
  // The indicator is a dot only: its state is an accessible label, never visible text.
  // Pause is an icon flipped by data-paused (the CSS-drawn bars/triangle live in CSS).
  const renderState = () => {
    // The single control for all pulsing (§5, #100): one root flag on the body freezes
    // every dot — green live dots and blue running dots — at once via one CSS rule.
    const intent = freezeIntent({ paused, buffered, lastUpdate, now: Date.now() });
    document.body.dataset.paused = intent.bodyPaused;
    indicator.dataset.liveState = intent.liveState;
    indicator.setAttribute("aria-label", intent.ariaLabel);
    pauseBtn.dataset.paused = intent.bodyPaused;
    pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
  };
  // Live updates (ADR 0008, #131): a live event soft-refreshes rather than reloading the
  // whole page. It re-fetches this same page and swaps only #live-region (the parked cards,
  // campaign meta and wave grid) — the issue sheet, its open reply/compose, the repo
  // dropdown, the archived-runs list and the scroll position all live outside it and are
  // left untouched. A full-page reload blanked the page and lost scroll/compose state,
  // worst over the tailnet. Guarded (never mid-compose), pausable (buffered and
  // flushed on resume), and single-flighted so overlapping ticks can't race.
  let refreshing = false;
  const softRefresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const res = await fetch(location.href);
      const next = new DOMParser().parseFromString(await res.text(), "text/html").getElementById("live-region");
      const current = document.getElementById("live-region");
      if (next && current) { current.replaceWith(next); wireLiveRegion(); }
      lastUpdate = Date.now();
      renderUpdated();
    } catch (e) {}
    refreshing = false;
  };
  const events = new EventSource("/api/events");
  events.onmessage = () => {
    // Freeze while paused or mid-compose; count what lands so a resume can flush it.
    if (paused || isComposing()) { buffered++; renderState(); return; }
    softRefresh();
  };
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    if (!paused && buffered && !isComposing()) { buffered = 0; softRefresh(); }
    renderState();
    renderUpdated();
  });
  // A live pane (the live-tail) that visibly appends is a co-equal update (#198): reset the
  // freshness clock so "updated Ns ago" reflects any live surface, not just a soft-refresh.
  // A paused page keeps reading "Paused" (freezeIntent ignores the clock while paused), so
  // background appends never advance a visible clock — normal behaviour returns on resume.
  window.addEventListener("vetinari:activity", () => { if (!paused) { lastUpdate = Date.now(); renderUpdated(); } });
  renderState();
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
      el.addEventListener("click", (event) => { event.preventDefault(); openIssue(el.dataset.project, el.dataset.issue, el.dataset.carvable === "1", el.dataset.run); }));
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
    // The summary-line graft input is inside #live-region too, so rebind it each refresh.
    wireGraft();
  }
${GRAFT_SCRIPT}
  wireLiveRegion();
${LIVE_TAIL_SCRIPT}
</script>
</body>
</html>`;
