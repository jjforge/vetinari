import { dotClass, freezeIntent, resumeIntent, tallyDotClass } from "./dashboard-visual-state.ts";
import { splitOverflow } from "./log-view.ts";
import {
  DASHBOARD_PALETTE_CSS,
  HOST_LOG_SCRIPT,
  HOST_LOG_STYLES,
  ISSUE_DETAIL_SHEET_SCRIPT,
  ISSUE_DETAIL_SHEET_STYLES,
  LIVE_TAIL_STYLES,
  MONO_FONT,
  REPO_DROPDOWN_SCRIPT,
  STATE_DOT_CSS,
  TOP_BAR_STYLES,
} from "./dashboard-assets.ts";
import {
  asRepoOption,
  followView,
  humanizedRow,
  type RepoOption,
  renderHostLog,
  renderRepoDropdown,
  renderTopBar,
  tailAppend,
} from "./dashboard-render.ts";
import { issueDetailSheetMarkup } from "./dashboard-render-issue.ts";

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
      prune: "issue.pruned",
      graft: "issue.grafted",
      "wave-start": "wave.started",
      "wave-done": "wave.closed",
      "campaign-start": "campaign.started",
      "campaign-parked": "campaign.parked",
      "campaign-done": "campaign.closed",
      "campaign-failed": "campaign.failed",
      turn: "agent.turn",
    }[kind] ?? kind
  );
}

/**
 * A stable identity for a feed row (#196): an event is immutable, so its project, ts, kind and
 * text together key it. Used to dedup across re-fetches of the rolling window — the feed has no
 * per-file index the tail keys on, so it keys on the row's own content. Pure; shipped via `.toString()`.
 */
export function feedKey(row: { project: string; ts: string; kind: string; text: string }): string {
  return row.project + "\0" + row.ts + "\0" + row.kind + "\0" + row.text;
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
 * The event-log feed's body view-model (#220): the sibling of `tailView`, swapping the tail's
 * issue criterion for a **project** one. The project dropdown and the (kind, text) filter fold
 * into one match predicate — a row shows only when it is in the chosen project (empty = all repos)
 * **and** matches the substring filter — that the shared `followView` applies to both the visible
 * set and the backlog count. Pure and self-contained, unit-tested in node and shipped to the
 * browser via `.toString()` (ADR 0012).
 */
export function feedView<T extends { project: string; kind: string; text: string }>(state: {
  buffer: T[];
  mark: number;
  live: boolean;
  project: string;
  query: string;
  cap: number;
}): { rows: T[]; visible: number; total: number; backlog: number; empty: boolean; following: boolean } {
  const match = (row: T) => (!state.project || row.project === state.project) && feedRowMatches(row, state.query);
  return followView({ buffer: state.buffer, mark: state.mark, live: state.live, cap: state.cap, match });
}

/**
 * The event-log feed's project-dropdown options (#220): the distinct `project` keys present in the
 * buffer, sorted for a stable menu — so the dropdown offers only repos with events in the window
 * (no dead options) and grows as a new project's events arrive, mirroring how the live tail's agent
 * dropdown tracks running issues. Pure and self-contained, unit-tested in node and shipped to the
 * browser via `.toString()` (ADR 0012).
 */
export function feedProjects(buffer: Array<{ project: string }>): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const row of buffer) {
    if (row.project && !seen[row.project]) {
      seen[row.project] = true;
      out.push(row.project);
    }
  }
  return out.sort();
}

/** project → owner/name label map for the event-log feed's project dropdown (#220): the same
 * `repo` display the top-bar switcher shows, so a buffer-sourced option reads as owner/name.
 * A project with no parseable remote is absent, so the menu falls back to its bare project key. */
const feedRepoLabelMap = (repos: readonly (string | RepoOption)[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const opt of repos.map(asRepoOption)) if (opt.repo) map[opt.project] = opt.repo;
  return map;
};

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
  .run-state.failed { border-color: var(--color-failure); color: var(--color-failure); }
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
     .tail-footer) from LIVE_TAIL_STYLES; its humanized rows are the shared .lv-row component
     (#216), so only the prose scroll body below differs from the tail's mono raw lines. */
  .feed { margin-top: 2rem; }
  /* The feed's own scroll body — the tail's .tail-body is mono/fixed-height for raw JSON, so
     the narrated feed keeps sans-serif prose in a bounded, scrollable pane of its own. */
  .feed-body { max-height: 22rem; overflow-y: auto; background: var(--color-body); padding: 0 .9rem; }
  .feed-body[hidden] { display: none; }
  /* A Raw-mode row (#203): the underlying event as one highlighted NDJSON line, mono in the feed's
     own prose scroll pane; the token colours come from the shared .tail-code palette (LIVE_TAIL_STYLES). */
  .feed-raw { padding: .1rem 0; font-family: ${MONO_FONT}; font-size: .78rem; line-height: 1.5; }
  /* The feed body's loading/empty placeholder sits inside the padded scroll pane. */
  .feed-body .empty { padding: .6rem 0; }
  /* The card's highlight (top border) tracks its run state (#75) — its only coloured edge (§2). */
  .card.running { border-top-color: var(--color-blue); } .card.parked { border-top-color: var(--color-yellow); } .card.failed { border-top-color: var(--color-failure); } .card.completed { border-top-color: var(--color-green); } .card.idle { border-top-color: var(--color-dim); }
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
<section id="feed" class="live-tail feed" data-feed aria-label="Event log across all repos"><div class="tail-head"><span class="tail-dot" data-feed-dot aria-hidden="true"></span><span class="tail-title tail-title-static">Event log · all repos</span><span class="tail-summary" data-feed-summary></span><span class="tail-gap"></span><span class="tail-controls" data-feed-controls><span class="tail-issue-dd" data-feed-project-dd><button type="button" class="tail-issue-trigger" data-feed-project-trigger aria-haspopup="listbox" aria-expanded="false"><span data-feed-project-label>all repos</span><span class="tail-issue-caret" aria-hidden="true">▾</span></button><ul class="tail-issue-menu" role="listbox" aria-label="Filter by project" data-feed-project-menu hidden></ul></span><input type="text" class="tail-filter" placeholder="filter events…" aria-label="Filter events" data-feed-filter /><button type="button" class="lv-ico lv-pause" data-feed-play data-following="true" aria-label="Pause"></button><button type="button" class="lv-ico" data-feed-save aria-label="Download JSON" title="Download JSON">⤓</button></span></div><div class="feed-body" data-feed-body><p class="empty">Loading…</p></div><button type="button" class="tail-backlog" data-feed-backlog hidden></button><div class="tail-footer" data-feed-footer></div></section>
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
  // The resume-reconnect reducer (dashboard-visual-state.ts, ADR 0012, #351), single-sourced
  // into the browser via .toString() so the node test runs the very function this page ships:
  // a tab backgrounded past iOS's ~20s connection-close window returns with a dead EventSource
  // that never fires error and keeps readyState OPEN, freezing the board until a manual reload.
  ${resumeIntent.toString()}
  const fmtWave = (w) => (w ? "Wave " + w.current + " of " + w.total : "idle");
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
  // its kind→label/category maps, its (kind, text) filter, and its composed project+text body
  // view-model (feedView) with the buffer-sourced project options (feedProjects, #220) — so the
  // node tests exercise the very functions the browser runs and the two panes share one tested
  // path (#196).
  ${followView.toString()}
  ${tailAppend.toString()}
  ${feedKey.toString()}
  ${feedFresh.toString()}
  ${feedKindLabel.toString()}
  ${feedRowMatches.toString()}
  ${feedView.toString()}
  ${feedProjects.toString()}
  ${splitOverflow.toString()}
  ${humanizedRow.toString()}
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
  const feedFilter = fq("[data-feed-filter]"), feedSave = fq("[data-feed-save]");
  // The project dropdown (#220): a buffer-sourced menu (feedProjects) labelled by owner/name
  // (the repo switcher's label, from this map), scoping the feed in place — client-only, no URL
  // param (that is the repo switcher's ?project=), resets on reload.
  const feedProjectDd = fq("[data-feed-project-dd]"), feedProjectTrigger = fq("[data-feed-project-trigger]");
  const feedProjectMenu = fq("[data-feed-project-menu]"), feedProjectLabel = fq("[data-feed-project-label]");
  const feedRepoLabels = ${JSON.stringify(feedRepoLabelMap(projects))};
  let feedBuffer = [], feedSeen = {}, feedLive = true, feedMark = 0, feedQuery = "", feedProject = "", feedLoaded = false, feedError = false;
  function feedRender() {
    const view = feedView({ buffer: feedBuffer, mark: feedMark, live: feedLive, project: feedProject, query: feedQuery, cap: FEED_RENDER_CAP });
    feedBody.textContent = "";
    if (feedError) { feedBody.append(el("p", "empty", "Couldn't load the activity feed.")); }
    else if (!feedLoaded) { feedBody.append(el("p", "empty", "Loading…")); }
    else if (view.rows.length) {
      for (const e of view.rows) {
        // Humanized-only (#221): the shared .lv-row component (#216) — time · dot · repo-leads-
        // narration, the dot coloured by the event's state — so the feed reads as the same
        // component as the tail, host log and archive, differing only by source.
        feedBody.append(humanizedRow(e.humanized, document));
      }
    } else {
      feedBody.append(el("p", "empty", feedQuery.trim() || feedProject ? "No events match that filter." : "No activity in the last 48 hours."));
    }
    feedFooter.textContent = feedLoaded && !feedError ? (view.visible + " of " + view.total + " event" + (view.total === 1 ? "" : "s") + " · " + (view.following ? "following" : "paused")) : "";
    // Newest-on-top (#195), so the backlog affordance points up to the freshest events.
    if (view.backlog > 0) { feedBacklog.hidden = false; feedBacklog.textContent = "↑ " + view.backlog + " new event" + (view.backlog === 1 ? "" : "s"); } else { feedBacklog.hidden = true; }
    feedPlay.dataset.following = String(feedLive); feedPlay.setAttribute("aria-label", feedLive ? "Pause" : "Play");
    feedDot.dataset.state = feedLive ? "live" : "idle";
    feedSummary.textContent = feedLoaded && !feedError ? (view.total + " event" + (view.total === 1 ? "" : "s")) : "";
    if (feedLive) feedBody.scrollTop = 0;
  }
  function feedRenderMenu() {
    feedProjectMenu.textContent = "";
    const projects = feedProjects(feedBuffer);
    // "all repos" leads (keys on no project), then one row per project present in the buffer,
    // labelled by its owner/name when known — a new project's first event grows this list.
    const rows = [{ project: "", label: "all repos" }].concat(projects.map((p) => ({ project: p, label: feedRepoLabels[p] || p })));
    for (const r of rows) {
      const li = el("li", "tail-issue-option"); li.setAttribute("role", "option"); li.dataset.project = r.project;
      li.append(el("span", null, r.label));
      li.addEventListener("click", () => { feedProject = r.project; feedProjectLabel.textContent = r.label; feedProjectMenu.hidden = true; feedProjectTrigger.setAttribute("aria-expanded", "false"); feedRender(); });
      feedProjectMenu.append(li);
    }
    // If the selected project rolled out of the 48h window, fall back to all repos (no dead option).
    if (feedProject && projects.indexOf(feedProject) === -1) { feedProject = ""; feedProjectLabel.textContent = "all repos"; }
  }
  function feedIngest(entries) {
    const res = feedFresh(entries, feedSeen); feedSeen = res.seen;
    // Grow past the cap while paused so a piling backlog survives to be revealed on unpause;
    // following keeps the buffer bounded to a recent window.
    if (res.fresh.length) feedBuffer = tailAppend(feedBuffer, res.fresh, feedLive, FEED_FOLLOW_CAP);
    feedRenderMenu();
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
  feedProjectTrigger.addEventListener("click", (e) => { e.stopPropagation(); const willOpen = feedProjectMenu.hidden; feedProjectMenu.hidden = !willOpen; feedProjectTrigger.setAttribute("aria-expanded", String(willOpen)); });
  document.addEventListener("click", (e) => { if (!feedProjectDd.contains(e.target)) { feedProjectMenu.hidden = true; feedProjectTrigger.setAttribute("aria-expanded", "false"); } });
  feedSave.addEventListener("click", () => {
    // Download JSON (#203): the currently-filtered rows — uncapped by the render window — as their
    // underlying event NDJSON (e.raw, one per line), so the raw bytes stay faithful in either mode.
    // Honors the project selection too (#220), since feedView composes it with the text filter.
    const view = feedView({ buffer: feedBuffer, mark: feedMark, live: feedLive, project: feedProject, query: feedQuery, cap: Math.max(feedBuffer.length, 1) });
    const blob = new Blob([view.rows.map((e) => e.raw).join("\\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "event-log.jsonl"; a.click(); URL.revokeObjectURL(a.href);
  });
  feedRenderMenu();
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
      // campaign refresh view (#74). Parked issues are always prunable.
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
      // An idle card opens the project page with its last run expanded at the top of the
      // archived list (design §11): carry the run token when the card has one, so
      // dashboard-route-page expands it as the archivedRun; a live card links plain.
      card.href = "/?project=" + encodeURIComponent(p.project) + (p.lastRun ? "&run=" + encodeURIComponent(p.lastRun.run) : "");
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
      // An idle card names its last run's outcome and when it finished (design §11) — the
      // campaign name is the card-campaign line above, completing the three facts step 7
      // promises. Only an idle card with an archived run carries lastRun.
      if (p.lastRun) {
        const outcome = p.lastRun.outcome === "complete" ? "Completed" : "Stalled";
        const ago = p.lastRun.finishedAt ? fmtWaited(p.lastRun.finishedAt) : "";
        const when = !ago ? "" : ago === "just now" ? " · finished just now" : " · finished " + ago + " ago";
        card.append(el("div", "card-last", outcome + when));
      }
      cards.append(card);
    }
  }
  // Live updates (ADR 0008): one SSE stream feeds re-reads of the landing as events
  // land. "updated Ns ago" counts from the last time the view actually refreshed, so it
  // visibly ages between ticks.
  const updatedEl = document.querySelector("[data-updated]");
  let lastUpdate = null;
  // freezeIntent (dashboard-visual-state.ts) decides the readout; the glue only writes it.
  const renderUpdated = () => {
    updatedEl.textContent = freezeIntent({ lastUpdate, now: Date.now() }).updatedText;
  };
  // Refresh both the landing and the cross-project feed on every live tick, so the
  // feed (#55) stays current alongside the cards.
  const refresh = async () => { await Promise.all([load(), loadFeed()]); lastUpdate = Date.now(); renderUpdated(); };
  // A stable event bus the host-log pane binds to once (its host/message listeners in
  // HOST_LOG_SCRIPT) and is never re-bound (#351); \`connect()\` owns the real EventSource and
  // forwards its frames onto the bus, so a forced reconnect swaps the dead stream underneath
  // while the pane's bindings — and thus its #331/#352 connect-ring heal — survive untouched.
  const events = new EventTarget();
  let stream = null;
  // Single-flight latch: pageshow and visibilitychange both fire on one iOS resume and both
  // pass resumeIntent's threshold, so the latch collapses them to one new stream and one heal.
  let connecting = false;
  const connect = () => {
    if (connecting) return;
    connecting = true;
    if (stream) stream.close();
    const s = new EventSource("/api/events");
    stream = s;
    const release = () => { if (stream === s) connecting = false; };
    s.onopen = release;
    s.onerror = release;
    s.onmessage = (e) => events.dispatchEvent(new MessageEvent("message", { data: e.data }));
    s.addEventListener("host", (e) => events.dispatchEvent(new MessageEvent("host", { data: e.data })));
  };
  events.addEventListener("message", () => { refresh(); });
  connect();
  // Reconnect a stream the OS silently killed while the tab was backgrounded (#351): readyState
  // and the error event both lie in that case, so the trigger is visibility, not stream state.
  // Stamp hiddenAt on hide; on resume resumeIntent decides from how long we were away. A brief
  // hide never reconnects; both resume triggers read the same hiddenAt and the latch dedupes.
  let hiddenAt = null;
  const onResume = () => { if (resumeIntent({ hiddenAt, now: Date.now() }).reconnect) connect(); };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else onResume();
  });
  // pageshow covers a bfcache restore, where no visibilitychange may fire.
  window.addEventListener("pageshow", onResume);
  // A live pane (the host-log) that visibly appends is a co-equal update (#198): reset the
  // freshness clock so "updated Ns ago" reflects any live surface, not just a feed refresh.
  window.addEventListener("vetinari:activity", () => { lastUpdate = Date.now(); renderUpdated(); });
  setInterval(renderUpdated, 1000);
  refresh();
${HOST_LOG_SCRIPT}
</script>
</body>
</html>`;

