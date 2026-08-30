import type { ResolvedConfig } from "./config.ts";
import {
  buildStatusWithIssueNames,
  type CampaignStatus,
  type DisplayStatus,
  type Membership,
  type RunState,
  type WaveStatus,
} from "./dashboard-model.ts";
import { splitOverflow, type HumanizedRow } from "./log-view.ts";

const ISSUE_EMOJI: Record<DisplayStatus, string> = {
  completed: "✅",
  running: "🔄",
  parked: "⏸",
  failure: "❌",
  unstarted: "⚪",
};

/** The membership badge glyph (ADR 0019) — the orthogonal axis to the lifecycle emoji:
 * a `grafted` addition or a `pruned` drop. A plain `member` carries none. */
const MEMBERSHIP_EMOJI: Record<Exclude<Membership, "member">, string> = {
  grafted: "🌱",
  pruned: "✂️",
};

const WAVE_EMOJI: Record<WaveStatus, string> = {
  closed: "✅",
  running: "▶️",
  unstarted: "⚪",
  parked: "⏸",
  failed: "❌",
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
      const badge = issue.membership && issue.membership !== "member" ? ` ${MEMBERSHIP_EMOJI[issue.membership]}` : "";
      lines.push(`  ${ISSUE_EMOJI[issue.status]} #${issue.issueNumber}${name}${badge}`);
    }
  }

  if (status.parked.length) {
    lines.push("", `⏸ ${status.parked.length} awaiting your reply:`);
    for (const p of status.parked) lines.push(`  #${p.issueNumber} — ${p.reason}`);
    lines.push("", "Reply to a parked question message to answer and redrive it.");
  }

  return lines.join("\n");
}

/** `formatStatusText` over the live campaign status, with issue names resolved. */
export async function renderStatusText(cfg: ResolvedConfig): Promise<string> {
  return formatStatusText(await buildStatusWithIssueNames(cfg));
}

export const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const escapeTitle = (value: string) => escapeHtml(value).replaceAll("\n", "&#10;");

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

/**
 * Build the shared log-view row (#216, mockup 1a/1c) from a humanized row's structured parts.
 * The `.lv-row` is the three-tier grid `time · dot · message`: `.lv-t` is the dimmest tier,
 * the state `.lv-dot`, then `.lv-msg` — the brightest tier — carries the actor as a `.lv-lead`
 * (option 1a: the actor *leads* the message, no fixed column), a dim `.lv-verb`, and each
 * message span (`code` → `<code>`, `strong` → `<strong>`, plain → `<span>`). Every fragment is
 * set via `textContent`, never innerHTML, so a path/summary/error can't inject markup. `d` is
 * the document (the client passes `document`, a test passes a stub) so the builder is a pure
 * factory, shipped verbatim into the three log surfaces' scripts via `.toString()`.
 *
 * Multiline collapse (#217): a message that is more than one rendered line collapses to its first
 * line — `splitOverflow` keeps the styled first-line spans and hands back the raw remainder. When
 * there is a remainder, a bare `.lv-chev` ends the message and a hidden `.lv-overflow` block (mono,
 * raw, indented under the message column) holds it; clicking the chevron unfolds the block in place
 * and flips `⌄`⇄`⌃`. A single-line row gets neither, so it renders exactly as before. The click
 * wiring is attached only where `addEventListener` exists (the browser), so the test stub — which
 * has none — still exercises the built structure.
 */
export function humanizedRow(h: HumanizedRow, d: Document): HTMLElement {
  const el = d.createElement("div");
  el.className = "lv-row";
  const t = d.createElement("span");
  t.className = "lv-t";
  t.textContent = h.time;
  const dot = d.createElement("span");
  dot.className = "lv-dot " + h.dot;
  const msg = d.createElement("span");
  msg.className = "lv-msg";
  if (h.actor) {
    const lead = d.createElement("span");
    lead.className = "lv-lead";
    lead.textContent = h.actor;
    msg.append(lead);
  }
  if (h.verb) {
    const verb = d.createElement("span");
    verb.className = "lv-verb";
    verb.textContent = h.verb;
    msg.append(verb);
  }
  const split = splitOverflow(h.spans || []);
  for (const s of split.spans) {
    const node = d.createElement(s.kind === "code" ? "code" : s.kind === "strong" ? "strong" : "span");
    node.textContent = s.text;
    msg.append(node);
  }
  el.append(t, dot, msg);
  if (split.overflow) {
    const chev = d.createElement("span");
    chev.className = "lv-chev";
    chev.textContent = "⌄";
    msg.append(chev);
    const overflow = d.createElement("div");
    overflow.className = "lv-overflow";
    overflow.textContent = split.overflow;
    overflow.hidden = true;
    el.append(overflow);
    const toggle = () => {
      overflow.hidden = !overflow.hidden;
      chev.textContent = overflow.hidden ? "⌄" : "⌃";
    };
    if (chev.addEventListener) chev.addEventListener("click", toggle);
  }
  return el;
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
 * past the cap so a backlog that piles up survives to be revealed on unpause. Pure and
 * self-contained — shipped to the browser via `.toString()`.
 */
export function tailAppend(buffer: TailRow[], fresh: TailRow[], live: boolean, cap: number): TailRow[] {
  const next = buffer.concat(fresh);
  return live && next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * The archived-runs filter contract (#256): a row matches a case-insensitive substring query
 * over its visible summary text (the `.lv-row` head — run name + disposition). The same
 * contract the feed/host-log filters carry (`feedRowMatches`), applied to this static list;
 * an empty/blank query matches everything (the filter is cleared). Pure and self-contained,
 * unit-tested in node and shipped to the browser via `.toString()` (ADR 0012).
 */
export function archiveRowMatches(text: string, query: string): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  return (text || "").toLowerCase().indexOf(q) !== -1;
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

export const asRepoOption = (repo: string | RepoOption): RepoOption => (typeof repo === "string" ? { project: repo, runState: "idle" } : repo);

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
 * live-bar (live dot + "updated Ns ago") on the right, wrapped in the `.page-top` flex
 * row. One definition rendered by the landing, the repo page, and any archived view, so
 * the two can no longer drift — which is what let the "Live" word survive on one page.
 * The live indicator is a dot only: its "Live" state is an accessible label
 * (`aria-label`), never visible text, keeping motion the one running-only channel (§5).
 * `trailing` seats extra controls at the right end of the live-bar — the host view passes
 * its settings gear there (#201) so it reads as the last of the live controls; pages with
 * nothing to add leave the live-bar untouched.
 */
export const renderTopBar = (left: string, trailing = "") =>
  `<div class="page-top">${left}<div class="live-bar" title="Live updates over SSE"><span class="live-indicator" data-live-state="live" aria-label="Live"></span><span class="updated" data-updated>waiting for updates</span>${trailing}</div></div>`;

/**
 * The shared settings surface (#180): a settings gear the fleet-level `host.jsonl`
 * (gateway/registry/Telegram/SSE diagnostics across every project, #157) lives behind,
 * plus its attention badge and the global Festive Wave Names toggle. The host log is a
 * host-level view, so the gear rides the top-right live-bar — `renderTopBar`'s `trailing`
 * slot (#201) — on every page, the all-repos landing and each campaign page alike (#215);
 * its pane opens as a popover anchored under it. The gear is the show/hide —
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
  // The shared log-view control row (#203, humanized-only per #221): the filter input and a
  // Download JSON control that always emits the raw NDJSON share one line — the filter flexes to
  // fill the row (#233), the button rides beside it. Reuses the live tail's .lv-ico class (both
  // style blocks ride the landing shell), so the two surfaces match.
  `<div class="host-log-controls">` +
  `<input type="text" class="host-log-filter" data-host-log-filter placeholder="filter lines…" aria-label="Filter host log lines" />` +
  `<button type="button" class="lv-ico" data-host-log-save aria-label="Download JSON" title="Download JSON">⤓</button>` +
  `</div>` +
  `<div class="host-log-lines" data-host-log-lines></div>` +
  `<div class="host-log-footer" data-host-log-footer></div>` +
  `</div>` +
  `</section>`;

// The dashboard's markup functions are split by surface (design §11, §13.4): this module
// keeps the shared primitives above and re-exports the three surface renderers below, so
// every existing `./dashboard-render.ts` import path stays valid.
export * from "./dashboard-render-issue.ts";
export * from "./dashboard-render-project.ts";
export * from "./dashboard-render-landing.ts";
