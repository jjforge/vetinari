import { archiveRowMatches, archiveRunHref, cappedRawRows, followView, humanizedRow, isNotableHostEvent, tailAppend, tailFresh, tailView } from "./dashboard-render.ts";
import { issueMoves, paneActivity, reasonWord, tailCollapseIntent } from "./dashboard-visual-state.ts";
import { humanizeHostLine, LOG_DOT_STATE_COLOR, splitOverflow } from "./log-view.ts";

/**
 * The dashboard's inert browser payloads — the CSS and client-side JavaScript
 * shipped verbatim to the browser and never executed in Node, lifted out of
 * `dashboard-render.ts` (#112) so `render` is a clean view-model → HTML seam.
 * The state→colour derivation (`stateColor`, `STATE_DOT_CSS`, …) lives here too:
 * the style payloads interpolate it at module-load time, so it is co-located with
 * them. `cappedRawRows`/`humanizedRow` stay in `dashboard-render.ts` as the tested
 * server-side source and are shipped into the log-view client scripts (the live tail
 * and host log) via `.toString()` — the back-reference this module makes.
 */
/**
 * The dashboard's single colour source (`docs/design.md` appendix A, #83): one
 * `:root` palette emitted verbatim into every surface's `<style>` — the all-repos
 * landing, the repo/campaign page, and the issue-detail sheet they share. No
 * surface defines a colour locally, so a token can never be "defined in one root,
 * missing in the other" (the #78 class of bug). Every colour that carries meaning
 * is one of the six ADR-0007 states or the risky action (§1); the teal
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
    /* State palette (§1): running · parked · failure · completed · unstarted(dim) · pruned */
    --color-blue: #6cb6ff; --color-yellow: #c8a24e; --color-failure: #f85149; --color-green: #3fb984; --color-pruned: #a371f7;
    /* State colours at 40% alpha — the muted chip borders (§4) */
    --color-blue-40: rgb(108 182 255 / 40%); --color-yellow-40: rgb(200 162 78 / 40%); --color-failure-40: rgb(248 81 73 / 40%); --color-green-40: rgb(63 185 132 / 40%); --color-pruned-40: rgb(163 113 247 / 40%); --color-dim-40: rgb(95 107 120 / 40%);
    /* Risky action (prune, redrive) — a control, never a state; a different red from failure (§1, #328) */
    --color-red: #f79287;
    /* The dark ink for text on a bright (accent/risky-action) button — the one on-bright colour, so
       no button hand-authors its own foreground hex (§1). */
    --color-on-accent: #04110f;
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
  // The single held state is `parked` — a question, a conflict, or a red base all read
  // the same attention amber (ADR 0019); the specific reason lives in the detail, not a
  // distinct colour. A failed `wave`/`failed` roll-up reads the failure red like an issue.
  parked: "yellow",
  // The lifecycle `failed` state and the log-view's `failure` dot-state both read the danger
  // red (`--color-failure`); the state word is `failed` (design §13.1), the CSS var keeps its
  // Primer name, and `failure` stays only as the log-view dot-state token (log-view.ts).
  failed: "failure",
  failure: "failure",
  completed: "green",
  // `pruned` is a membership badge colour (ADR 0019), not a lifecycle dot state.
  pruned: "pruned",
  unstarted: "dim",
  queued: "dim",
  idle: "dim",
};
export const stateColor = (state: string): string => `var(--color-${STATE_COLOR_TOKEN[state] ?? "dim"})`;
export const stateBorderColor = (state: string): string => `var(--color-${STATE_COLOR_TOKEN[state] ?? "dim"}-40)`;

/**
 * The landing counters' value→colour mapping (#80): the one state→colour surface with
 * no reducer of its own. Only the three status-bearing counters carry a colour — working
 * blue, parked amber, merged-today green; queued (and any other kind) stays the neutral
 * dim, matching the render that emits no rule for it. The counter kind is the surface's
 * own vocabulary (`working`/`parked`/`queued`/`mergedToday`), not an ADR-0007 status, so
 * this maps kinds rather than states.
 */
const COUNTER_COLOR_TOKEN: Record<string, string> = {
  working: "blue",
  parked: "yellow",
  mergedToday: "green",
};
export const counterColor = (kind: string): string => `var(--color-${COUNTER_COLOR_TOKEN[kind] ?? "dim"})`;

/**
 * The status-dot colour rules, generated once from `stateColor` and shared by both
 * pages (previously two hand-kept copies). Scoped to `.dot` so a state colour tints
 * only the dot, never a whole card or list row (#81). The leading base rule carries the
 * "small solid circle that never shrinks" invariant — `border-radius` + `flex: none` —
 * for every status dot (`.dot`, `.repo-dot`, `.tail-dot`, `.lv-dot`) in one place rather
 * than four; `flex: none` keeps a dot from collapsing into a pill or bar when it sits in a
 * flex row whose sibling exerts fill pressure (a wave-member title, #234). Each variant
 * then declares only its own `width`/`height`/`background`. Because those variants live in
 * `TOP_BAR_STYLES`/`LIVE_TAIL_STYLES`, this block must ship alongside them — both pages
 * already include all three. Motion is a second channel for
 * `running` alone (§5): a running dot pulses to signal active work, reduced-motion aware;
 * nothing else animates. A
 * `.running.idle` dot (a zero-count "0 running" tally chip) keeps the blue but no pulse —
 * motion means work in flight, and an idle tally has none.
 */
export const STATE_DOT_CSS =
  `.dot, .repo-dot, .tail-dot, .lv-dot { border-radius: 999px; flex: none; } ` +
  `.dot { width: .75rem; height: .75rem; display: inline-block; } ` +
  ["running", "parked", "failed", "completed", "unstarted", "queued"].map((s) => `.dot.${s} { background: ${stateColor(s)}; }`).join(" ") +
  ` @keyframes chip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } } .dot.running { animation: chip-pulse 1.4s ease-in-out infinite; } .dot.running.idle { animation: none; } @media (prefers-reduced-motion: reduce) { .dot.running { animation: none; } }`;

/**
 * A wave-member row carries its own status at 40% alpha on a left edge (§4) — muted
 * so a wave of a dozen rows does not vibrate, while each row's full-strength dot
 * still lets you count states at a glance. Generated once from `stateBorderColor`;
 * each member row carries a matching status class. Tally counts (not states) are
 * deliberately left out — they keep a neutral edge (§7).
 */
export const STATE_CHIP_BORDER_CSS = ["running", "parked", "failed", "completed", "unstarted"].map((s) => `.wave-member.${s} { border-color: ${stateBorderColor(s)}; }`).join(" ");

/**
 * The mono treatment for the repo dropdown's label (#88). The dashboard loads no
 * web font, so this is a system-monospace stack — IBM Plex Mono (the POC's face) is
 * deliberately not added. If a shared `--font-mono` token is later introduced, use that.
 */
export const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * The top bar's CSS, shared by every page's `<style>` alongside `renderTopBar` so the
 * markup and its presentation move together (#81). Covers `.page-top`, the
 * `.project-picker`, and the `.live-bar`/`.live-indicator` (green dot that pulses while
 * live, reduced-motion aware).
 */
export const TOP_BAR_STYLES = `  .page-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; border-bottom: 1px solid var(--color-light-border); padding-bottom: 1rem; }
  .project-picker { margin: 0; }
  .project-picker select { min-height: 44px; color: var(--color-text); background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); padding: .35rem .7rem; font: inherit; cursor: pointer; }
  .project-picker select:hover { border-color: var(--color-primary); }
  /* The repo dropdown (#88): the trigger is the page heading and the switcher in one.
     No border, no background, no padding — just the mono scope label and a chevron. */
  .repo-dropdown { position: relative; margin: 0; min-width: 0; }
  .repo-trigger { display: inline-flex; align-items: center; gap: .4rem; max-width: 100%; border: 0; background: none; padding: 0; color: var(--color-text); font: inherit; cursor: pointer; }
  .repo-label { min-width: 0; font-family: ${MONO_FONT}; font-weight: 600; font-size: 17px; letter-spacing: -0.01em; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Hover turns the label teal; the chevron rotates 180° over 180ms when the menu opens. */
  .repo-trigger:hover .repo-label { color: var(--color-primary); }
  .repo-chevron { flex: none; font-size: 13px; color: var(--color-text-light-2); transition: transform 180ms; }
  .repo-trigger[aria-expanded="true"] .repo-chevron { transform: rotate(180deg); }
  /* The trigger has no border to hang a ring on, so give it (and each option) an explicit one. */
  .repo-trigger:focus-visible, .repo-option:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  /* A popover listbox: 8px below the trigger, left-aligned, above the cards (z 5) but
     below the issue sheet (z 10), which covers/closes it. 260px wide for a long owner/name. */
  .repo-menu { position: absolute; top: calc(100% + 8px); left: 0; z-index: 5; min-width: 260px; margin: 0; padding: 5px; list-style: none; display: flex; flex-direction: column; gap: 1px; background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); box-shadow: 0 14px 40px #0009; }
  .repo-menu[hidden] { display: none; }
  .repo-option { display: flex; align-items: center; gap: .5rem; padding: 8px 10px; border-radius: var(--border-radius); cursor: pointer; }
  /* Selected and hovered read the same fill — hovering the selected row is a no-op. No checkmark. */
  .repo-option:hover, .repo-option.selected { background: var(--color-chip-hover); }
  .repo-optlabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ${MONO_FONT}; font-size: 12.5px; color: var(--color-text-light); }
  .repo-option.selected .repo-optlabel { color: var(--color-text); }
  .repo-note { flex: none; font-size: 11px; color: var(--color-dim); white-space: nowrap; }
  /* The 6px status dot: the repo's run-state colour, or the teal accent for All repos
     (the aggregate has no run state of its own). Generated once from stateColor (§3). */
  .repo-dot { width: 6px; height: 6px; background: var(--color-dim); }
  .repo-dot.all { background: var(--color-primary); }
  ${["running", "parked", "failed", "completed", "idle"].map((s) => `.repo-dot.${s} { background: ${stateColor(s)}; }`).join(" ")}
  /* The mockup's density is desktop-tuned; touch rows grow to the 44px minimum, and the
     label steps to 15px on a phone. */
  @media (pointer: coarse) { .repo-option { min-height: 44px; } }
  @media (max-width: 640px) { .repo-label { font-size: 15px; } }
  .live-bar { display: inline-flex; align-items: center; gap: .75rem; color: var(--color-text-light-2); font-size: .85rem; }
  .live-indicator { display: inline-flex; align-items: center; color: var(--color-green); }
  /* The green live dots (this one on the live-bar, and the event-log header's) track the
     live *stream*: they pulse whenever live, regardless of running count (§5 — the green
     dots are the stream channel, distinct from the blue .dot.running that tracks work). */
  .live-indicator::before { content: ""; width: .55rem; height: .55rem; border-radius: 999px; flex: none; background: currentColor; animation: chip-pulse 1.6s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .live-indicator::before { animation: none; } }`;

/**
 * The issue-detail sheet's CSS — one definition included by both pages' `<style>`
 * (previously hand-synced, #76). Covers `.issue-detail-*`, `.meta-*`, `.turn-*`,
 * `.reply-*`, `.sheet-actions`, and the `.prune-*` panel. The `.dot` status
 * colours and the campaign-only `.prune-fallback` noscript styling stay with each
 * page, since those differ between the two.
 */
export const ISSUE_DETAIL_SHEET_STYLES = `  .prune-panel { display: flex; align-items: center; gap: .5rem; }
  /* A flex display beats the UA [hidden] rule, so the prune panel needs it back explicitly. */
  .prune-panel[hidden] { display: none; }
  /* One button base across the sheet's moves (#307): Reply and Prune share the sheet-btn shape.
     Reply is additive, so it keeps the plain teal product-accent — a control, never a state (§1). */
  .sheet-btn { min-height: 44px; padding: .5rem 1rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: var(--color-on-accent); font: inherit; font-weight: 700; line-height: 1; cursor: pointer; }
  /* Prune discards work, so it is a risky action (#328, Appendix A): its enabled button wears the
     risky-action coral over the shared teal — colour is never the only channel, the confirm step
     is the load-bearing guard. */
  .prune-start { background: var(--color-red); }
  /* The prune flow's confirm/cancel stay their own affordances: the destructive confirm in
     the risky-action coral, cancel a neutral out. */
  .prune-confirm-btn, .prune-cancel { padding: .35rem .7rem; border: 1px solid var(--color-red); border-radius: 999px; background: rgb(247 146 135 / 12%); color: var(--color-red); font: inherit; line-height: 1; cursor: pointer; }
  .prune-cancel { border-color: var(--color-secondary); background: none; color: var(--color-text-light-2); }
  .prune-confirm { display: flex; align-items: center; gap: .5rem; margin: 0; }
  /* A flex display beats the UA [hidden] rule, so the confirm form needs it back
     explicitly — otherwise Confirm/Cancel show by default, four buttons at once. */
  .prune-confirm[hidden] { display: none; }
  .prune-confirm-text { color: var(--color-red); }
  .prune-note { color: var(--color-blue); font-size: .85rem; }
  .prune-explainer { color: var(--color-text-light-2); font-size: .85rem; }
  .issue-detail { position: fixed; inset: 0; z-index: 10; display: none; align-items: center; justify-content: center; padding: 1rem; background: #0009; }
  .issue-detail.show { display: flex; }
  .issue-detail[hidden] { display: none; }
  /* A stateful card: the issue's state reads on the 2px top edge only (§2), derived
     from stateColor; the other three edges stay the neutral 1px. */
  .issue-detail-sheet { display: flex; flex-direction: column; width: min(640px, 100%); max-height: 85vh; overflow: hidden; background: var(--color-card); border: 1px solid var(--color-secondary); border-top: 2px solid var(--color-dim); border-radius: var(--border-radius-medium); box-shadow: 0 18px 48px #0009; }
  ${["running", "parked", "failed", "completed", "unstarted"].map((s) => `.issue-detail-sheet.${s} { border-top-color: ${stateColor(s)}; }`).join(" ")}
  .issue-detail-header { position: sticky; top: 0; display: flex; align-items: flex-start; gap: .75rem; padding: 1rem 1.15rem; background: var(--color-box-header); border-bottom: 1px solid var(--color-light-border); }
  .issue-detail-head-main { flex: 1; min-width: 0; }
  .issue-detail-status { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; color: var(--color-text-light-2); }
  .issue-detail-title { margin: .35rem 0 .15rem; font-size: 1.15rem; letter-spacing: -0.01em; color: var(--color-text); }
  .issue-detail-context { margin: 0; font-size: .82rem; color: var(--color-text-light-2); }
  .issue-detail-close { flex: none; background: none; border: 0; color: var(--color-text-light-2); font-size: 1.4rem; line-height: 1; cursor: pointer; padding: .1rem .4rem; border-radius: var(--border-radius); }
  .issue-detail-close:hover { color: var(--color-text); background: var(--color-secondary); }
  .issue-detail-meta { display: flex; gap: .75rem; padding: .9rem 1.15rem; border-bottom: 1px solid var(--color-light-border); }
  .meta-tile { flex: 1; display: flex; flex-direction: column; gap: .2rem; padding: .6rem .75rem; background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); }
  /* A flex display beats the UA [hidden] rule, so a tile with no value to show (the
     worktree tile on a run with no preserved worktree) needs its collapse back. */
  .meta-tile[hidden] { display: none; }
  .meta-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-light-2); }
  .meta-value { font-size: 1.25rem; font-weight: 600; color: var(--color-text); }
  /* A worktree path is long and not a headline number, so it reads as small wrapping monospace. */
  .meta-tile-path { flex: 2; min-width: 0; }
  .meta-value-path { font-size: .82rem; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  /* The turn log is its own labeled section, distinct from the meta tiles above it
     (#92): a small uppercase section label, matching the meta-tile label treatment. */
  .turn-log-heading { margin: 0; padding: .9rem 1.15rem .1rem; font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-light-2); }
  .turn-log { list-style: none; margin: 0; padding: .5rem 1.15rem 1.15rem; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
  .turn-entry { display: flex; gap: .6rem; padding: .55rem 0; border-bottom: 1px solid var(--color-light-border); }
  .turn-entry:last-child { border-bottom: 0; }
  .turn-num { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
  ${["completed", "parked", "failed", "running", "unstarted"].map((s) => `.turn-num.${s} { color: ${stateColor(s)}; }`).join(" ")}
  .turn-summary { color: var(--color-text-light); }
  .turn-empty { color: var(--color-text-light-2); padding: .55rem 0; }
  /* Parked-reply block + the actions row pin to the sheet foot so Redrive/Prune stay
     reachable one-handed while the turn log scrolls above. */
  /* The reply block is the human-action queue inside the sheet, so it carries the
     3px amber left edge (§2); it only ever shows for a parked issue. */
  .issue-detail-reply { flex: none; padding: .9rem 1.15rem; border-top: 1px solid var(--color-light-border); border-left: 3px solid var(--color-yellow); background: var(--color-box-header); }
  .reply-heading { margin: 0 0 .5rem; font-size: .95rem; color: var(--color-text-light); }
  /* The hoisted facts (#307): the issue title and how long it has waited, sat above the box
     so the key context reads without scrolling back up to the sheet header. */
  .reply-context { margin: 0 0 .5rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
  .reply-title { color: var(--color-text); font-weight: 600; min-width: 0; }
  .reply-elapsed { color: var(--color-text-light-2); font-size: .85rem; white-space: nowrap; }
  .reply-question { margin: 0 0 .6rem; color: var(--color-text-light); white-space: pre-wrap; max-height: 30vh; overflow-y: auto; }
  /* Options stack one per line as full-width bordered rows (POC), not inline pills:
     the A/B/C letter sits in a fixed left margin, the label fills the rest. */
  .reply-options { display: flex; flex-direction: column; gap: .4rem; margin-bottom: .6rem; }
  .reply-option { display: flex; align-items: center; gap: .6rem; width: 100%; min-height: 44px; text-align: left; padding: .4rem .7rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; cursor: pointer; }
  .reply-option:hover { border-color: var(--color-primary); background: var(--color-primary-alpha-20); }
  .reply-option-letter { flex: none; width: 1.4em; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--color-text-light-2); }
  .reply-option-label { flex: 1; min-width: 0; }
  .issue-detail-reply textarea { min-height: 5rem; margin: 0; }
  .sheet-actions { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .9rem 1.15rem; border-top: 1px solid var(--color-light-border); }
  /* A flex display beats the UA [hidden] rule, so these need it back explicitly. */
  .sheet-actions[hidden], .reply-options[hidden] { display: none; }
  @media (max-width: 640px) { .issue-detail-sheet { width: 100%; max-height: 88vh; border-radius: var(--border-radius-medium) var(--border-radius-medium) 0 0; padding-bottom: env(safe-area-inset-bottom); } .issue-detail { align-items: flex-end; padding: 0; } }`;

/**
 * The issue-detail sheet's client script — one definition included by both pages
 * (previously hand-synced, #76). It wires the sheet itself: the element refs,
 * `openIssue`/`renderDetail`/`renderMoves`, `closeSheet`, the foot's Reply/Redrive/Prune
 * visibility, and the prune preview→confirm flow. Each page adds its own trigger
 * wiring around this (the campaign page's issue chips + parked cards; the
 * landing's parked-queue rows), which is what calls `openIssue`.
 */
export const ISSUE_DETAIL_SHEET_SCRIPT = `  const issueDetail = document.getElementById("issue-detail");
  const detailSheet = issueDetail.querySelector(".issue-detail-sheet");
  const detailNum = issueDetail.querySelector(".issue-detail-num");
  const detailStatusDot = issueDetail.querySelector(".issue-detail-status .dot");
  const detailStatusLabel = issueDetail.querySelector(".issue-detail-statuslabel");
  const detailTitle = issueDetail.querySelector(".issue-detail-title");
  const detailContext = issueDetail.querySelector(".issue-detail-context");
  const detailTurns = document.getElementById("issue-detail-turns");
  const detailWorktree = document.getElementById("issue-detail-worktree");
  const detailWorktreeTile = document.getElementById("issue-detail-worktree-tile");
  const detailTurnLog = document.getElementById("issue-detail-turnlog");
  const detailReply = document.getElementById("issue-detail-reply");
  const replyHeading = document.getElementById("reply-heading");
  const replyTitle = document.getElementById("reply-title");
  const replyElapsed = document.getElementById("reply-elapsed");
  const replySend = document.getElementById("reply-send");
  const replyQuestion = document.getElementById("reply-question");
  const replyOptions = document.getElementById("reply-options");
  const replyText = document.getElementById("reply-text");
  const replyForm = document.getElementById("reply-form");
  const sheetActions = document.querySelector(".sheet-actions");
  // The single moves rule (dashboard-visual-state.ts, #307), single-sourced into the
  // browser via .toString() so the node test and this script run the same function.
  ${issueMoves.toString()}
  // The one park-reason → word mapping (dashboard-visual-state.ts), single-sourced the same
  // way so the sheet spells a reason exactly as the status line and the parked card do (#317).
  ${reasonWord.toString()}
  // The fix-forward instruction each redrive-only park reads in the sheet notice (design
  // §11, user-guide park reasons): a conflict/red-base/crash is fixed forward on the base
  // and redriven, never answered per-issue.
  const FIX_FORWARD = {
    conflict: "This green branch conflicts with the base at merge. Resolve the conflict on the base, then redrive.",
    "red-base": "Every issue passed alone; the merged base fails together. Fix forward on the base, then redrive.",
    crash: "The run died with no verdict. Redrive to pick the campaign back up.",
  };
  // The foot (reply + actions) shows only while it holds a live control — a reply to
  // send or a prune to offer — so a plain issue's sheet grows no empty bar.
  const updateFoot = () => {
    const prune = document.getElementById("prune-panel");
    const pruneShown = Boolean(prune && !prune.hidden);
    sheetActions.hidden = replySend.hidden && !pruneShown;
    // A standalone Prune — the only move (a running/unstarted issue), not beside a reply and
    // not yet in its confirm step — gets a plain-words explainer of what a prune does; when a
    // reply sits alongside, it gives the context instead.
    const explainer = document.getElementById("prune-explainer");
    const start = document.getElementById("prune-start");
    if (explainer) explainer.hidden = !pruneShown || !replySend.hidden || (start ? start.hidden : true);
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
  // Reassigned by the prune block when prune is enabled; a no-op otherwise.
  let onOpenIssue = () => {};
  // The single #reply-text box is reused for every issue, so a draft typed for one issue
  // would otherwise sit in the box when the sheet binds another — and post to that other
  // issue's taskId (#349). Track which issue the box is bound to (project + number) and
  // empty it on an actual switch; closing and reopening the same issue keeps the draft.
  let boundIssueKey = null;
  // The issue-level moves a state allows (design §11, #307, #325), gated through the one
  // issueMoves rule:
  // - reply (question/stall): the hoisted title + elapsed, the full question, the offered
  //   options as buttons that fill the field (never submit), and the free-text box; Reply
  //   posts it through /answer to answer-and-continue the parked task.
  // - a redrive-only park (conflict/red-base/crash): the same block shows a fix-forward
  //   notice instead of the box; the redrive itself is the whole-campaign control on the page.
  // - prune gates its own control; a completed or archived issue offers none.
  const renderMoves = (d) => {
    const moves = issueMoves({ status: d.status, reason: d.reason, archived: d.archived });
    // The reply block shows the answer UI for a question/stall, or a fix-forward notice for
    // a conflict/red-base/crash park; every other state hides it.
    const notice = !moves.reply && d.status === "parked" && !d.archived ? (FIX_FORWARD[d.reason] || "") : "";
    detailReply.hidden = !(moves.reply || notice);
    replySend.hidden = !moves.reply;
    if (moves.reply || notice) {
      // The hoisted facts above the box: the issue title and how long it has waited.
      replyTitle.textContent = d.title || ("Issue #" + d.issueNumber);
      replyElapsed.textContent = fmtElapsed(d.elapsedMs);
    }
    if (moves.reply) {
      replyHeading.textContent = "PARKED — NEEDS YOUR ANSWER";
      replyForm.hidden = false;
      replyForm.querySelector('input[name="taskId"]').value = d.issueNumber;
      replyForm.querySelector('input[name="project"]').value = d.project;
      const question = d.parked && d.parked.question;
      replyQuestion.textContent = question || "";
      replyQuestion.hidden = !question;
      const options = (d.parked && d.parked.options) || [];
      // Each option is a full-width row (POC): its A/B/C letter in a left margin,
      // then the label. An "A:"/"B)"-style marker in the option text is pulled into
      // the margin; an option with no marker falls back to a positional letter.
      // Clicking still fills the field with the full original option (unchanged).
      replyOptions.replaceChildren(...options.map((option, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "reply-option";
        const marker = option.match(/^([A-Za-z])[.):]\\s+/);
        const letter = document.createElement("span");
        letter.className = "reply-option-letter";
        letter.textContent = marker ? marker[1].toUpperCase() : String.fromCharCode(65 + i);
        const label = document.createElement("span");
        label.className = "reply-option-label";
        label.textContent = marker ? option.slice(marker[0].length) : option;
        button.append(letter, label);
        button.addEventListener("click", () => { replyText.value = option; replyText.focus(); });
        return button;
      }));
      replyOptions.hidden = !options.length;
    } else if (notice) {
      replyHeading.textContent = "PARKED — FIX FORWARD";
      replyForm.hidden = true;
      replyQuestion.textContent = notice;
      replyQuestion.hidden = false;
      replyOptions.replaceChildren();
      replyOptions.hidden = true;
    }
    // Prune visibility is authoritative from the rule now (keyed off the fetched state),
    // not the server's data-prunable hint — so a running/failed issue can prune too.
    onOpenIssue(moves.prune, d.project, d.issueNumber);
    updateFoot();
  };
  const renderDetail = (d) => {
    renderMoves(d);
    detailNum.textContent = "#" + d.issueNumber;
    // The sheet's top edge reads the issue's state (§2), the dot its full-strength colour.
    detailSheet.className = "issue-detail-sheet " + d.status;
    detailStatusDot.className = "dot " + d.status;
    // State and reason (design §11): the reason rides beside the state as its word, so a
    // parked{red-base} sheet reads "parked · red base" — the reason a word, never the raw enum.
    detailStatusLabel.textContent = d.status + (d.reason ? " · " + reasonWord(d.reason) : "");
    detailTitle.textContent = d.title || ("Issue #" + d.issueNumber);
    detailContext.textContent = [d.project, d.campaignName].filter(Boolean).join(" · ");
    // Turns carry their working duration (POC: "11 turns · 26m"), the one duration
    // signal — the separate ELAPSED tile was the same span shown twice (#92). The
    // count pluralizes, so a single turn reads "1 turn", never "1 turns".
    detailTurns.textContent = d.turns + " turn" + (d.turns === 1 ? "" : "s") + " · " + fmtElapsed(d.elapsedMs);
    // The worktree tile is the agent's real per-task identity (ADR/#55 dropped the
    // fabricated agent id); show it only when the reconstruction carried a path.
    detailWorktree.textContent = d.worktree || "";
    detailWorktreeTile.hidden = !d.worktree;
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
  const openIssue = async (project, issue, prunable, run) => {
    // Clear the reply draft only when the box binds a different issue, so text written for
    // one issue can never post as another's answer (#349).
    const issueKey = project + "#" + issue;
    if (boundIssueKey !== issueKey) replyText.value = "";
    boundIssueKey = issueKey;
    issueDetail.hidden = false;
    issueDetail.classList.add("show");
    detailNum.textContent = "#" + issue;
    detailSheet.className = "issue-detail-sheet";
    detailStatusDot.className = "dot";
    detailStatusLabel.textContent = "";
    detailTitle.textContent = "Loading…";
    detailContext.textContent = project;
    detailTurns.textContent = "…";
    detailWorktreeTile.hidden = true;
    detailTurnLog.textContent = "";
    // Hide the move controls until the fetched detail decides them through issueMoves; the
    // passed prunable is only the loading-state hint for the prune panel.
    detailReply.hidden = true;
    replySend.hidden = true;
    onOpenIssue(prunable, project, issue);
    updateFoot();
    try {
      // An archived chip carries its run token so the sheet reads that run's own log.
      const res = await fetch("/api/issue?project=" + encodeURIComponent(project) + "&issue=" + encodeURIComponent(issue) + (run ? "&run=" + encodeURIComponent(run) : ""));
      if (!res.ok) throw new Error(String(res.status));
      renderDetail(await res.json());
    } catch {
      detailTitle.textContent = "Couldn't load issue #" + issue;
      detailContext.textContent = project;
    }
  };
  const prunePanel = document.getElementById("prune-panel");
  if (prunePanel) {
    const pruneStart = document.getElementById("prune-start");
    const pruneConfirm = document.getElementById("prune-confirm");
    const pruneConfirmText = pruneConfirm.querySelector(".prune-confirm-text");
    const pruneTaskId = pruneConfirm.querySelector('input[name="taskId"]');
    const pruneProject = pruneConfirm.querySelector('input[name="project"]');
    let pruneTarget = null;
    let pruneProj = null;
    const resetPrune = () => {
      pruneConfirm.hidden = true;
      pruneStart.hidden = false;
      updateFoot();
    };
    // The prune affordance reveals inside the sheet for a prunable issue, keyed off
    // the issue the sheet just opened (ADR 0005); a non-prunable issue hides it.
    onOpenIssue = (prunable, project, issue) => {
      prunePanel.hidden = !prunable;
      if (prunable) {
        pruneTarget = issue;
        pruneProj = project;
        resetPrune();
      }
    };
    pruneStart.addEventListener("click", async () => {
      try {
        const res = await fetch("/prune?preview&taskId=" + encodeURIComponent(pruneTarget) + "&project=" + encodeURIComponent(pruneProj));
        if (!res.ok) throw new Error(String(res.status));
        // The structured closure (E2): the dependents that would leave (dropped)
        // and the banked work kept (keptBanked). Name each so a confirm discloses
        // the exact closure and never implies merged/mergeable work is discarded.
        const { target, dropped, keptBanked } = await res.json();
        const drops = (dropped || []).filter((id) => id !== target);
        const kept = keptBanked || [];
        pruneConfirmText.textContent =
          "Prune #" + target +
          (drops.length ? " — also drops " + drops.map((id) => "#" + id).join(", ") : " — no dependents") +
          (kept.length ? ". Keeps banked (merged or mergeable) " + kept.map((id) => "#" + id).join(", ") : "");
        pruneTaskId.value = target;
        pruneProject.value = pruneProj;
      } catch {
        pruneConfirmText.textContent = "Couldn't preview this prune — is a campaign still running?";
        pruneTaskId.value = "";
      }
      pruneStart.hidden = true;
      pruneConfirm.hidden = false;
      updateFoot();
    });
    document.getElementById("prune-cancel").addEventListener("click", resetPrune);
    pruneConfirm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!pruneTaskId.value) return;
      await fetch("/prune", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ taskId: pruneTaskId.value, project: pruneProject.value, confirm: "1" }),
      });
      prunePanel.hidden = true;
      document.getElementById("prune-note").textContent = "pruning… #" + pruneTaskId.value + " will drop from the plan on the next refresh";
    });
  }`;

/**
 * The repo dropdown's client script (#88) — one definition included by both pages so
 * the trigger + listbox behave identically. It toggles the menu off the trigger,
 * moves a roving focus through the options with ↑↓/Home/End, traps Tab inside the open
 * menu and restores focus to the trigger on Escape/close, and switches scope by
 * navigating (`/?project=…`, or `/` for the aggregate) — a re-select of the current
 * scope is a no-op that just closes. Click-outside is scoped to the dropdown's own
 * subtree, so clicking another control never leaves the menu open. No-op when the page
 * renders no dropdown (a single-project view with no repo list).
 */
export const REPO_DROPDOWN_SCRIPT = `  const repoRoot = document.querySelector("[data-repo-dropdown]");
  if (repoRoot) {
    const repoTrigger = repoRoot.querySelector(".repo-trigger");
    const repoMenu = repoRoot.querySelector(".repo-menu");
    const repoOptions = [...repoMenu.querySelectorAll(".repo-option")];
    const repoSelected = Math.max(0, repoOptions.findIndex((o) => o.getAttribute("aria-selected") === "true"));
    let repoActive = repoSelected;
    const repoIsOpen = () => repoTrigger.getAttribute("aria-expanded") === "true";
    const repoFocus = (i) => { repoActive = (i + repoOptions.length) % repoOptions.length; repoOptions[repoActive].focus(); };
    const repoOpen = () => { repoTrigger.setAttribute("aria-expanded", "true"); repoMenu.hidden = false; repoFocus(repoSelected); };
    // Escape/close restores focus to the trigger; a click-outside close passes restore=false
    // so focus stays where the click landed.
    const repoClose = (restore) => { repoTrigger.setAttribute("aria-expanded", "false"); repoMenu.hidden = true; if (restore !== false) repoTrigger.focus(); };
    // Switching scope is a navigation — the page is server-rendered per repo, so the load
    // resets everything (the open issue sheet, any expanded closed-waves) for free.
    // Re-selecting the current scope changes nothing, so it just closes the menu.
    const repoChoose = (option) => {
      if (option.getAttribute("aria-selected") === "true") { repoClose(); return; }
      const project = option.dataset.project;
      location.href = project ? "/?project=" + encodeURIComponent(project) : "/";
    };
    // The button's native activation already handles Enter/Space (a click), which
    // toggles the menu — so the trigger only adds ↑↓ to open, avoiding a Space
    // keydown-open then keyup-click that would immediately close it.
    repoTrigger.addEventListener("click", () => (repoIsOpen() ? repoClose() : repoOpen()));
    repoTrigger.addEventListener("keydown", (event) => {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !repoIsOpen()) { event.preventDefault(); repoOpen(); }
    });
    repoMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); repoClose(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); repoFocus(repoActive + 1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); repoFocus(repoActive - 1); }
      else if (event.key === "Home") { event.preventDefault(); repoFocus(0); }
      else if (event.key === "End") { event.preventDefault(); repoFocus(repoOptions.length - 1); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); repoChoose(repoOptions[repoActive]); }
      else if (event.key === "Tab") { event.preventDefault(); repoFocus(repoActive + (event.shiftKey ? -1 : 1)); }
    });
    for (const option of repoOptions) option.addEventListener("click", () => repoChoose(option));
    document.addEventListener("click", (event) => { if (repoIsOpen() && !repoRoot.contains(event.target)) repoClose(false); });
  }`;

/**
 * The archived-runs list's client script (#98, #256): expand/collapse rows (one open at a
 * time, the open row tinted), mirror the open row into the URL (`?run=…`) so the view is
 * shareable without a navigation, and a substring filter (the shared feed/host-log contract,
 * `archiveRowMatches`) that hides the rows whose visible summary text doesn't match. An
 * archived run's expanded body is its wave-card grid only (#222) — there is no run-level
 * log pane, so this script has no run-level log to fetch or render. No-op when the page has
 * no archived list.
 */
export const ARCHIVE_LIST_SCRIPT = `  const archiveList = document.querySelector(".archive-list");
  if (archiveList) {
    ${archiveRowMatches.toString()}
    ${archiveRunHref.toString()}
    const archiveRows = [...archiveList.querySelectorAll("li[data-run]")];
    // Mirror the open run into the URL (#98), or clear run= when none is open (#333) — the
    // reducer owns the shape (deep link vs bare project URL, hash preserved). Open writes the
    // run; close writes null.
    const syncUrl = (run) => { try { history.replaceState(null, "", archiveRunHref(archiveList.dataset.project, run, location.hash)); } catch (e) {} };
    const closeRow = (row) => {
      row.classList.remove("open");
      row.querySelector(".lv-row").setAttribute("aria-expanded", "false");
      row.querySelector(".archive-body").hidden = true;
      syncUrl(null);
    };
    const openRow = (row) => {
      // INVARIANT: close the previously-open row *before* recording this one. closeRow clears
      // run= from the URL, so the syncUrl below must run last — otherwise opening B while A is
      // open would leave the URL bare instead of naming B (#333).
      for (const other of archiveRows) if (other !== row && other.classList.contains("open")) closeRow(other);
      row.classList.add("open");
      row.querySelector(".lv-row").setAttribute("aria-expanded", "true");
      row.querySelector(".archive-body").hidden = false;
      syncUrl(row.dataset.run);
    };
    for (const row of archiveRows) {
      row.querySelector(".lv-row").addEventListener("click", () => { if (row.classList.contains("open")) closeRow(row); else openRow(row); });
    }
    // The shared log-view filter (#256): a case-insensitive substring over each row's visible
    // summary text (the .lv-row head — run name + disposition), hiding the rows that miss.
    const filterEl = archiveList.closest(".archived-runs").querySelector("[data-archive-filter]");
    if (filterEl) filterEl.addEventListener("input", () => {
      for (const row of archiveRows) row.hidden = !archiveRowMatches(row.querySelector(".lv-row").textContent, filterEl.value);
    });
  }`;

/**
 * The live log tailing pane's styles (#124). The shell colours come straight from
 * the shared palette (§1, no local hexes): the `--color-card` card, the `--color-body`
 * body, the `--color-secondary` hairline. The body is a fixed 236px scroll region (not
 * resizable) rendering the shared `.lv-row` component (humanized-only, #221). The header dot
 * reads teal while live and dim otherwise, but does not animate: §11/Appendix A reserve motion
 * for the running dot and the live indicator alone, so the stream dot is a static colour, not a
 * third pulse (#317). Play/pause is a 26×26 CSS-drawn icon flipped by `data-following`.
 */
export const LIVE_TAIL_STYLES = `  .live-tail { background: var(--color-card); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); overflow: hidden; margin: 1rem 0; }
  .live-tail[hidden] { display: none; }
  .tail-head { display: flex; align-items: center; gap: .5rem; padding: 10px 13px; }
  .tail-dot { width: .6rem; height: .6rem; background: var(--color-dim); }
  .tail-dot[data-state="live"] { background: var(--color-primary); }
  .tail-title { display: inline-flex; align-items: center; gap: .4rem; border: 0; background: none; padding: 0; color: var(--color-text); font: inherit; font-weight: 600; cursor: pointer; }
  .tail-caret::before { content: "▾"; color: var(--color-text-light-2); display: inline-block; transition: transform 150ms; }
  .tail-title[aria-expanded="false"] .tail-caret::before { transform: rotate(-90deg); }
  /* A non-disclosing pane title (the event-log feed heads its own pane but has no collapse):
     the same header type, minus the button affordance. */
  .tail-title-static { cursor: default; }
  .tail-summary { color: var(--color-text-light-2); font-size: .85rem; white-space: nowrap; }
  .tail-gap { flex: 1; }
  .tail-controls { display: inline-flex; align-items: center; gap: .4rem; }
  .tail-controls[hidden] { display: none; }
  .tail-issue-dd { position: relative; }
  .tail-issue-trigger { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--color-secondary); border-radius: 999px; background: var(--color-chip); color: var(--color-text); font: inherit; font-size: .8rem; padding: .25rem .6rem; cursor: pointer; }
  .tail-issue-trigger:hover { border-color: var(--color-primary); }
  .tail-issue-caret { color: var(--color-text-light-2); font-size: .7rem; }
  .tail-issue-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 5; list-style: none; margin: 0; padding: .25rem; min-width: 9rem; background: var(--color-box-header); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); box-shadow: 0 8px 22px #0006; }
  .tail-issue-menu[hidden] { display: none; }
  .tail-issue-option { display: flex; align-items: center; gap: .4rem; padding: .3rem .5rem; border-radius: 6px; cursor: pointer; font-size: .8rem; color: var(--color-text); }
  .tail-issue-option:hover { background: var(--color-card-hover); }
  .dot.all { background: var(--color-primary); }
  .tail-filter { width: 9rem; max-width: 32vw; padding: .3rem .5rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; font-size: .8rem; }
  /* The chrome icon buttons (#216, mockup 1a): square glyph tiles — ⤓ download JSON, ▮▮ pause
     (▶ when paused). The download carries the ⤓ glyph as its text; the pause draws ▮▮/▶ from
     its follow state so the existing follow/pause JS drives the glyph with no change. */
  .lv-ico { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: none; border: 1px solid var(--color-secondary); border-radius: 7px; background: var(--color-chip); color: var(--color-text-light); font: inherit; font-size: .9rem; line-height: 1; cursor: pointer; padding: 0; }
  .lv-ico:hover { background: var(--color-card-hover); color: var(--color-text); }
  .lv-pause[data-following="true"] { border-color: var(--color-blue-40); }
  .lv-pause[data-following="true"]::before { content: "▮▮"; letter-spacing: -.12em; }
  .lv-pause[data-following="false"]::before { content: "▶"; }
  .tail-body { height: 236px; overflow-y: auto; overflow-x: hidden; background: var(--color-body); font-family: ${MONO_FONT}; font-size: .78rem; line-height: 1.5; }
  .tail-body[hidden] { display: none; }
  /* The shared log-view row (#216, mockup 1a/2b): the three-tier grid time · dot · message,
     painting the least→most emphasis ramp (#221). Left to right is least to most important — the
     time is the most muted (dim), the actor is distinct-but-subdued (a mono handle at mid
     brightness), and the message itself is the brightest, most readable element; the dim verb sits
     ahead of it, code tokens read mono, and the strong key term is the brightest of all. The dot
     reads the event's own state via the shared palette (§1, generated from stateColor). */
  .lv-row { display: grid; grid-template-columns: auto auto 1fr; align-items: baseline; gap: .5rem; padding: .1rem .6rem; }
  .lv-row:hover { background: var(--color-card); }
  .lv-t { color: var(--color-dim); font-variant-numeric: tabular-nums; }
  .lv-dot { width: .6rem; height: .6rem; align-self: center; background: var(--color-dim); }
  ${Object.entries(LOG_DOT_STATE_COLOR).map(([s, token]) => `.lv-dot.${s} { background: ${stateColor(token)}; }`).join(" ")}
  .lv-msg { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--color-text); }
  .lv-lead { font-family: ${MONO_FONT}; color: var(--color-text-light-2); font-weight: 600; margin-right: .4rem; }
  .lv-verb { color: var(--color-text-light-2); margin-right: .35rem; }
  .lv-msg code { font-family: ${MONO_FONT}; font-size: .95em; color: var(--color-text-light); }
  .lv-msg strong { color: var(--color-text); font-weight: 700; }
  /* Multiline collapse (#217): a bare, dim chevron ends a collapsed row's first line and
     brightens on hover; clicking it unfolds the .lv-overflow block — the raw remainder, mono
     and copy-pasteable — in the message column (grid-column 3) beneath the first line. */
  .lv-chev { margin-left: .35rem; color: var(--color-text-light-2); cursor: pointer; user-select: none; }
  .lv-chev:hover { color: var(--color-text); }
  .lv-overflow { grid-column: 3; margin-top: .15rem; white-space: pre-wrap; word-break: break-word; font-family: ${MONO_FONT}; font-size: .95em; color: var(--color-text-light); }
  .lv-overflow[hidden] { display: none; }
  .tail-empty { color: var(--color-text-light-2); padding: .5rem .6rem; }
  .tail-backlog { display: block; width: 100%; border: 0; background: var(--color-blue); color: var(--color-body); font: inherit; font-size: .78rem; font-weight: 700; padding: .35rem; cursor: pointer; text-align: center; }
  .tail-backlog[hidden] { display: none; }
  .tail-footer { color: var(--color-text-light-2); font-size: .75rem; padding: .4rem 13px; border-top: 1px solid var(--color-light-border); }
  .tail-footer[hidden] { display: none; }
  /* On a phone the .tail-head row can't fit title + summary + agent dropdown + filter, so the
     title wraps and the filter is clipped (#336). The summary ("2 agents") duplicates the agent
     dropdown, so drop it under 640px to reclaim the width — every pane sharing .tail-head inherits. */
  @media (max-width: 640px) { .tail-summary { display: none; } }`;

/**
 * The live-tail pane's client script (#124), inlined into the repo page after its shared
 * `EventSource` so it can subscribe to the named `tail` frames the SSE pushes. Everything
 * pure is single-sourced from `dashboard-render.ts` via `.toString()` — `highlightJsonLine`
 * (the archived-raw tokeniser, reused verbatim), `tailFresh` (snapshot dedup by per-file
 * index), `tailAppend` (following-buffer cap / paused growth) and `tailView` (the
 * follow/pause/filter view-model) — so the node tests exercise the very functions shipped.
 *
 * The DOM glue holds the mutable state (`open`, `live`, `mark`, `issue`, `query`, `buffer`,
 * `seen`, `agents`), consumes each `tail` frame for its own project, and re-renders the body.
 * The pane lives outside `#live-region`, so a soft-refresh never disturbs it and this wiring
 * runs once. `tail` is a named SSE event, so it never fires the page's `onmessage`; the tail
 * follows its own pause.
 */
export const LIVE_TAIL_SCRIPT = `  const tailEl = document.querySelector("[data-live-tail]");
  if (tailEl && typeof events !== "undefined") {
    const __name = (fn) => fn;
    ${splitOverflow.toString()}
    ${humanizedRow.toString()}
    ${tailFresh.toString()}
    ${tailAppend.toString()}
    ${followView.toString()}
    ${tailView.toString()}
    ${paneActivity.toString()}
    ${tailCollapseIntent.toString()}
    const FOLLOW_CAP = 260, RENDER_CAP = 160;
    const project = tailEl.dataset.project;
    let agents = []; try { agents = JSON.parse(tailEl.dataset.agents || "[]"); } catch (e) {}
    // The pane holds its space and rests collapsed with no agents (#330), so \`open\` starts from
    // the server-seeded state (agents present ⇒ open). \`manualCollapse\` is the one extra bit: set
    // only by the toggle handler, it marks a collapse the operator owns so an agent returning does
    // not override it — an *automatic* (no-agents) collapse re-opens, a manual one persists.
    let open = agents.length > 0, live = open, manualCollapse = false, mark = 0, issue = "", query = "", buffer = [], seen = {};
    const q = (sel) => tailEl.querySelector(sel);
    const dotEl = q("[data-tail-dot]"), toggle = q("[data-tail-toggle]"), summaryEl = q("[data-tail-summary]");
    const controls = q("[data-tail-controls]"), body = q("[data-tail-body]"), footer = q("[data-tail-footer]");
    const backlogEl = q("[data-tail-backlog]"), playBtn = q("[data-tail-play]"), filterEl = q("[data-tail-filter]");
    const issueDd = q("[data-tail-issue-dd]"), issueTrigger = q("[data-tail-issue-trigger]"), issueMenu = q("[data-tail-issue-menu]");
    const issueLabel = q("[data-tail-issue-label]"), issueDot = q("[data-tail-issue-dot]");
    const saveBtn = q("[data-tail-save]");
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    function renderMenu() {
      issueMenu.textContent = "";
      const rows = [{ issue: "", status: "all", label: "all agents" }].concat(agents.map((a) => ({ issue: a.issue, status: a.status, label: "#" + a.issue })));
      for (const r of rows) {
        const li = mk("li", "tail-issue-option"); li.setAttribute("role", "option"); li.dataset.issue = r.issue;
        li.append(mk("span", "dot " + r.status), mk("span", null, r.label));
        li.addEventListener("click", () => { issue = r.issue; issueLabel.textContent = r.label; issueDot.className = "dot " + r.status; issueMenu.hidden = true; issueTrigger.setAttribute("aria-expanded", "false"); render(); });
        issueMenu.append(li);
      }
      // If the selected agent finished (dropped from the running set), fall back to all agents.
      if (issue && !agents.some((a) => a.issue === issue)) { issue = ""; issueLabel.textContent = "all agents"; issueDot.className = "dot all"; }
    }
    // With no agents the pane rests collapsed and reads exactly "no agents running" — never
    // "0 agents", and the " · paused" suffix (the operator's own follow-pause) is suppressed,
    // matching the string the server seeds (#330).
    function renderSummary() { summaryEl.textContent = agents.length === 0 ? "no agents running" : agents.length + " agent" + (agents.length === 1 ? "" : "s") + (open ? "" : " · paused"); }
    // Apply the open/closed axis to the DOM and the tail's own follow coupling — the shared body
    // of the toggle handler and the automatic collapse/expand. Opening resumes following, closing
    // pauses it (the tail's own state, not the campaign's).
    function applyOpen(next) {
      open = next; toggle.setAttribute("aria-expanded", String(open));
      controls.hidden = !open; body.hidden = !open; footer.hidden = !open;
      live = open; mark = buffer.length; if (!open) backlogEl.hidden = true;
    }
    function render() {
      const view = tailView({ buffer, mark, live, issue, query, cap: RENDER_CAP });
      body.textContent = "";
      if (view.rows.length) {
        for (const r of view.rows) {
          // Humanized-only (#221): the shared .lv-row component — time · dot · actor-leads-message,
          // the dot coloured by the event's own state (the server-attached parts); an eventless
          // line falls back to a one-span raw dump.
          const h = r.humanized || { time: "", actor: "", verb: "", spans: [{ text: r.raw, kind: "plain" }], dot: "neutral" };
          body.append(humanizedRow(h, document));
        }
      } else {
        body.append(mk("div", "tail-empty", issue || query.trim() ? "no lines match that filter" : ""));
      }
      footer.textContent = view.visible + " of " + view.total + " lines · " + (view.following ? "following" : "paused");
      if (view.backlog > 0) { backlogEl.hidden = false; backlogEl.textContent = "↑ " + view.backlog + " new line" + (view.backlog === 1 ? "" : "s"); } else { backlogEl.hidden = true; }
      playBtn.dataset.following = String(live); playBtn.setAttribute("aria-label", live ? "Pause" : "Play");
      dotEl.dataset.state = open && live ? "live" : "idle";
      // Newest-on-top (#195): following pins the newest line to the top, not the bottom.
      if (live) body.scrollTop = 0;
    }
    function ingest(tail) {
      agents = (tail && tail.agents) || [];
      // The pane stays in the layout (#330): instead of removing it, fold or unfold it. An
      // automatic collapse (no agents) re-opens on the next agent and resumes following; a
      // collapse the operator performed with the toggle persists (see tailCollapseIntent).
      const intent = tailCollapseIntent({ agents: agents.length, open, manualCollapse });
      if (intent.open !== open) applyOpen(intent.open);
      renderMenu(); renderSummary();
      const res = tailFresh((tail && tail.lines) || [], seen); seen = res.seen;
      // Grow the buffer past the cap only while explicitly paused with the pane open (a backlog
      // to reveal); following or collapsed keeps it bounded — reopening jumps to live anyway.
      if (res.fresh.length) buffer = tailAppend(buffer, res.fresh, live || !open, FOLLOW_CAP);
      // A visible append (pane open + following, with new lines) is a live-surface update:
      // signal the live-bar to reset its "last activity Ns ago" clock (#198). Buffered frames
      // (collapsed, or the tail's own follow paused) present nothing new and stay silent.
      if (paneActivity({ appended: res.fresh.length, open, following: live })) window.dispatchEvent(new CustomEvent("vetinari:activity"));
      render();
    }
    events.addEventListener("tail", (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m && m.project === project) ingest(m.tail); });
    toggle.addEventListener("click", () => {
      applyOpen(!open);
      // Record whose choice this collapse is: a manual fold sticks (an agent returning must not
      // override it), a manual expand clears the flag so the pane auto-follows agents again (#330).
      manualCollapse = !open;
      renderSummary(); render();
    });
    playBtn.addEventListener("click", () => { live = !live; mark = buffer.length; render(); });
    backlogEl.addEventListener("click", () => { live = true; mark = buffer.length; render(); });
    filterEl.addEventListener("input", () => { query = filterEl.value; render(); });
    issueTrigger.addEventListener("click", (e) => { e.stopPropagation(); const willOpen = issueMenu.hidden; issueMenu.hidden = !willOpen; issueTrigger.setAttribute("aria-expanded", String(willOpen)); });
    document.addEventListener("click", (e) => { if (!issueDd.contains(e.target)) { issueMenu.hidden = true; issueTrigger.setAttribute("aria-expanded", "false"); } });
    saveBtn.addEventListener("click", () => {
      // The currently visible (filtered) lines — uncapped by the render window — as a .jsonl download.
      const view = tailView({ buffer, mark, live, issue, query, cap: Math.max(buffer.length, 1) });
      const blob = new Blob([view.rows.map((r) => r.raw).join("\\n")], { type: "application/x-ndjson" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tail-" + project + ".jsonl"; a.click(); URL.revokeObjectURL(a.href);
    });
    renderMenu(); renderSummary(); render();
  }`;

/**
 * The host-log surface's styles (#180): the gear + attention badge and the log
 * pane it toggles. Colours come straight from the shared palette (§1, no local hexes) —
 * the `--color-box-body` panel, the `--color-secondary` hairline, and the badge in the
 * failure red (the one alert colour). The gear rides the end of the top-right live-bar,
 * after the freshness readout (#201); the pane is an absolutely-positioned popover beneath it on
 * desktop (right-aligned to the gear), and a bottom sheet on a phone. Each line renders the
 * shared `.lv-row` component (humanized-only, #221).
 */
export const HOST_LOG_STYLES = `  .host-log { position: relative; display: inline-flex; align-items: center; }
  .host-log-gear { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border: 1px solid var(--color-secondary); border-radius: 999px; background: var(--color-box-header); color: var(--color-text-light-2); font-size: 1.05rem; line-height: 1; cursor: pointer; }
  .host-log-gear:hover { border-color: var(--color-primary); color: var(--color-text); }
  .host-log-gear[aria-expanded="true"] { border-color: var(--color-primary); color: var(--color-primary); }
  /* The attention badge: a small failure-red pip at the gear's corner, hidden until a
     notable host event (isNotableHostEvent) newer than the last open is in the window. */
  .host-log-badge { position: absolute; top: -3px; right: -3px; min-width: 15px; height: 15px; padding: 0 3px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--color-failure); color: #fff; font-size: 10px; font-weight: 700; line-height: 1; }
  .host-log-badge[hidden] { display: none; }
  .host-log-panel { position: absolute; top: calc(100% + 8px); right: 0; z-index: 8; width: min(620px, 92vw); max-height: 70vh; display: flex; flex-direction: column; background: var(--color-box-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); box-shadow: 0 18px 48px #0009; overflow: hidden; }
  .host-log-panel[hidden] { display: none; }
  .host-log-head { display: flex; align-items: center; gap: .5rem; padding: .65rem .9rem; border-bottom: 1px solid var(--color-light-border); }
  .host-log-title { font-family: ${MONO_FONT}; font-size: .8rem; color: var(--color-text-light-2); }
  .host-log-gap { flex: 1; }
  .host-log-close { background: none; border: 0; color: var(--color-text-light-2); font-size: 1.3rem; line-height: 1; cursor: pointer; padding: 0 .3rem; }
  .host-log-close:hover { color: var(--color-text); }
  .host-log-settings { padding: .6rem .9rem; border-bottom: 1px solid var(--color-light-border); }
  .festive-toggle { display: inline-flex; align-items: center; gap: .5rem; color: var(--color-text-light); font-size: .82rem; cursor: pointer; }
  .festive-toggle input { cursor: pointer; }
  .host-log-filter { flex: 1; padding: .4rem .6rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; font-size: .8rem; }
  /* The shared log-view control row (#203, humanized-only per #221): the filter and the Download
     JSON control share one line — the filter flexes to fill it (#233), the button reuses the live
     tail's .lv-ico beside it. The row's top margin is the single gutter below the settings toggle. */
  .host-log-controls { display: flex; align-items: center; gap: .5rem; margin: .5rem .9rem 0; }
  .host-log-lines { flex: 1; min-height: 0; overflow-y: auto; padding: .6rem .9rem; font-family: ${MONO_FONT}; font-size: .78rem; line-height: 1.5; }
  .host-log-empty { color: var(--color-text-light-2); padding: .5rem 0; }
  .host-log-more { display: block; width: 100%; padding: .5rem 0; margin-top: .4rem; text-align: left; background: none; border: 0; color: var(--color-primary); font: inherit; cursor: pointer; }
  .host-log-more:hover { color: var(--color-text); }
  .host-log-footer { color: var(--color-text-light-2); font-size: .75rem; padding: .5rem .9rem; border-top: 1px solid var(--color-light-border); }
  @media (max-width: 640px) {
    .host-log-panel { position: fixed; top: auto; bottom: 0; left: 0; right: 0; width: 100%; max-height: 80vh; border-radius: var(--border-radius-medium) var(--border-radius-medium) 0 0; }
  }`;

/**
 * The host-log surface's client script (#180), inlined into the landing shell after its
 * shared `EventSource` so it can subscribe to the named `host` SSE frames. Everything pure
 * is single-sourced from `dashboard-render.ts` via `.toString()` — `highlightJsonLine` (the
 * raw tokeniser), `cappedRawRows` (the filter + render cap) and `isNotableHostEvent` (the
 * badge predicate) — so the node tests exercise the very functions the browser runs.
 *
 * The gear is the show/hide; opening the pane marks the window's notable events seen (a
 * client-side last-viewed timestamp), clearing the badge until a newer notable event lands.
 * The initial window is the no-daemon `GET /api/host-log` read (newest-first already); each
 * `host` frame carries the rows appended since connect, folded into the newest-first buffer
 * and re-evaluated for the badge. A missing `host.jsonl` reads empty — a clean "no host log
 * yet" and no badge.
 */
export const HOST_LOG_SCRIPT = `  const hostLogRoot = document.querySelector("[data-host-log]");
  if (hostLogRoot && typeof events !== "undefined") {
    const __name = (fn) => fn;
    ${splitOverflow.toString()}
    ${humanizedRow.toString()}
    ${cappedRawRows.toString()}
    ${isNotableHostEvent.toString()}
    ${humanizeHostLine.toString()}
    ${paneActivity.toString()}
    const HOST_CAP = 500, HOST_WINDOW = 500;
    const gear = hostLogRoot.querySelector("[data-host-log-gear]");
    const badge = hostLogRoot.querySelector("[data-host-log-badge]");
    const panel = hostLogRoot.querySelector("[data-host-log-panel]");
    const closeBtn = hostLogRoot.querySelector("[data-host-log-close]");
    const filterEl = hostLogRoot.querySelector("[data-host-log-filter]");
    const linesEl = hostLogRoot.querySelector("[data-host-log-lines]");
    const footer = hostLogRoot.querySelector("[data-host-log-footer]");
    const saveBtn = hostLogRoot.querySelector("[data-host-log-save]");
    let lines = [], lastSeen = "", expanded = 0;
    // The newest notable event's timestamp in the current window (isNotableHostEvent), or ""
    // when the window holds none. ISO timestamps sort lexicographically, so a string compare
    // orders them; a row that doesn't parse as JSON is skipped, never notable.
    const newestNotableTs = () => {
      let max = "";
      for (const raw of lines) {
        let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
        if (isNotableHostEvent(ev) && ev && typeof ev.ts === "string" && ev.ts > max) max = ev.ts;
      }
      return max;
    };
    // The gear badges when the window holds a notable event newer than the operator's last open.
    const updateBadge = () => { const n = newestNotableTs(); badge.hidden = !(n && n > lastSeen); };
    const draw = () => {
      const needle = filterEl.value.trim().toLowerCase();
      const { rows, total, hidden } = cappedRawRows(lines, needle, HOST_CAP, expanded);
      linesEl.textContent = "";
      for (const { line } of rows) {
        // Humanized-only (#221): the shared .lv-row component — time · dot · actor-leads-message,
        // the dot coloured by the host event's own state (failures red); an unknown kind renders a
        // readable generic summary, never a raw JSON dump.
        linesEl.append(humanizedRow(humanizeHostLine(line), document));
      }
      if (!rows.length) { const e = document.createElement("div"); e.className = "host-log-empty"; e.textContent = lines.length ? (needle ? "No lines match “" + filterEl.value.trim() + "”." : "No host log lines.") : "No host log yet."; linesEl.append(e); }
      if (hidden > 0) { const more = document.createElement("button"); more.type = "button"; more.className = "host-log-more"; more.textContent = "Show " + hidden + " more line" + (hidden === 1 ? "" : "s"); more.addEventListener("click", () => { expanded += HOST_CAP; draw(); }); linesEl.append(more); }
      footer.textContent = lines.length ? ("showing " + rows.length + " of " + total + " lines") : "";
    };
    const openPanel = () => {
      panel.hidden = false; gear.setAttribute("aria-expanded", "true");
      // Opening marks the current notable events seen, so the badge clears until a newer one lands.
      lastSeen = newestNotableTs() || lastSeen; updateBadge();
      expanded = 0; draw(); filterEl.focus();
    };
    const closePanel = () => { panel.hidden = true; gear.setAttribute("aria-expanded", "false"); };
    gear.addEventListener("click", () => (panel.hidden ? openPanel() : closePanel()));
    closeBtn.addEventListener("click", closePanel);
    // "Festive Wave Names" (#193): wave labels are server-rendered, so the toggle can't
    // flip them in the client — it writes the festiveWaveNames cookie (=1 on / =0 off, a
    // year TTL) the server reads when rendering labels, then reloads so the labels re-render.
    // The checkbox reflects the current cookie on load so its state persists across reloads.
    const festiveToggle = hostLogRoot.querySelector("[data-festive-toggle]");
    if (festiveToggle) {
      festiveToggle.checked = /(?:^|;\\s*)festiveWaveNames=1/.test(document.cookie);
      festiveToggle.addEventListener("change", () => {
        document.cookie = "festiveWaveNames=" + (festiveToggle.checked ? "1" : "0") + "; path=/; max-age=31536000";
        location.reload();
      });
    }
    filterEl.addEventListener("input", () => { expanded = 0; draw(); });
    // Download JSON (#203): the currently-filtered raw NDJSON — uncapped by the render window —
    // as a .jsonl download, so the raw bytes stay faithful regardless of the humanized view.
    if (saveBtn) saveBtn.addEventListener("click", () => {
      const needle = filterEl.value.trim().toLowerCase();
      const matching = needle ? lines.filter((l) => l.toLowerCase().indexOf(needle) !== -1) : lines;
      const blob = new Blob([matching.join("\\n")], { type: "application/x-ndjson" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "host-log.jsonl"; a.click(); URL.revokeObjectURL(a.href);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
    // Fold newly-appended host rows (the server sends them in file order, oldest→newest) into
    // the newest-first buffer, bounded to a recent window; redraw if the pane is open and
    // re-evaluate the badge either way (the gear signals even while the pane is closed).
    const ingest = (appended) => {
      if (!appended || !appended.length) return;
      lines = appended.slice().reverse().concat(lines);
      if (lines.length > HOST_WINDOW) lines = lines.slice(0, HOST_WINDOW);
      if (!panel.hidden) draw();
      updateBadge();
      // A visible append (the panel open) is a live-surface update: signal the live-bar to
      // reset its "last activity Ns ago" clock (#198). The host-log always shows newest-first, so
      // there is no follow to pause — visibility is just the panel; a closed panel stays
      // silent (the badge still signals).
      if (paneActivity({ appended: appended.length, open: !panel.hidden, following: true })) window.dispatchEvent(new CustomEvent("vetinari:activity"));
    };
    events.addEventListener("host", (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } ingest((m && m.lines) || []); });
    // Re-read the bounded window from the no-daemon host-log read (readHostLog), newest-first
    // already. \`replace\` swaps the whole buffer — the connect heal (#352), safe because the pane
    // has no follow/pause state and the badge counts from this same buffer, so it self-corrects.
    // Otherwise the fetched rows land *behind* any a live frame already delivered so a frame
    // racing the fetch isn't clobbered (the fetch rows are the older backlog). A generation token
    // means the newest backfill wins if a connect ring races the wiring fetch on a fresh load, so
    // the load never double-counts the window.
    let backfillGen = 0;
    const backfill = (replace) => {
      const gen = ++backfillGen;
      fetch("/api/host-log").then((r) => (r.ok ? r.json() : { lines: [] })).then((d) => {
        if (gen !== backfillGen) return;
        const win = (d && d.lines) || [];
        lines = replace ? win : lines.concat(win);
        if (lines.length > HOST_WINDOW) lines = lines.slice(0, HOST_WINDOW);
        if (!panel.hidden) draw();
        updateBadge();
      }).catch(() => {});
    };
    // #331's connect ring is the only unnamed frame (project === null); named append frames never
    // fire "message". Every connection — first load and every EventSource reconnect after a blip —
    // re-reads the window and replaces the buffer, healing lines written while the stream was down
    // and the render→connect gap in one rule (#352). No renderer changes: both assign onmessage as
    // a property, so this added listener coexists with the grid's connect refresh.
    events.addEventListener("message", (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m && m.project === null) backfill(true); });
    // The wiring-time backfill fills the pane immediately, before the connect ring's extra round
    // trip lands; it appends behind live rows rather than replacing, so a load-time race holds.
    backfill(false);
  }`;

/**
 * The summary-line graft input's client behaviour (option 1a, #202). The input lives
 * inside `#live-region`, which is swapped whole on every soft-refresh, so this is a
 * function `wireLiveRegion` re-runs (a `graftWired` flag makes a re-bind on the same
 * node idempotent). At rest the button is greyed; typing wakes it (the teal
 * `data-graft-active`) and clears any error; blur validates the batch against the
 * project's own dry-run closure (the retained `GET /graft?preview`) so a bad id greys
 * the button before anything is sent; submit POSTs `/graft` directly — a clean batch
 * confirms on the wave (the new card arrives via the live refresh), while a whole-batch
 * rejection (422) surfaces its per-id verdicts inline and keeps the typed ids for
 * correction. `graftVerdicts` renders those verdicts in graft's own words — the same the
 * route's rejection page uses.
 */
export const GRAFT_SCRIPT = `  function graftVerdicts(closure) {
    const reason = { unknown: "not found", closed: "closed on GitHub", "already-in-campaign": "already in the campaign" };
    return closure.ids.map((id) => {
      const bad = (closure.rejected || []).find((r) => r.id === id);
      return "#" + id + " — " + (bad ? reason[bad.reason] : "would graft");
    }).join("  ·  ");
  }
  function wireGraft() {
    const form = document.querySelector("[data-graft]");
    if (!form || form.dataset.graftWired) return;
    form.dataset.graftWired = "1";
    const ids = form.querySelector("[data-graft-ids]");
    const submit = form.querySelector("[data-graft-submit]");
    const errBox = form.querySelector("[data-graft-error]");
    const project = form.querySelector("input[name=project]").value;
    const typed = () => ids.value.trim();
    const clearErr = () => { errBox.hidden = true; errBox.textContent = ""; };
    const showErr = (text) => { errBox.textContent = text; errBox.hidden = false; };
    let invalid = false;
    // Empty → greyed and disabled; any ids → teal-active and enabled (unless a blur
    // validation already flagged a bad id).
    const sync = () => {
      const has = typed().length > 0;
      form.toggleAttribute("data-graft-active", has);
      submit.disabled = !has || invalid;
    };
    ids.addEventListener("input", () => { invalid = false; clearErr(); sync(); });
    // Validate on blur — a rejected batch greys the button and names the offenders
    // inline; nothing is sent, so there is no state to undo.
    ids.addEventListener("blur", async () => {
      if (!typed()) return;
      try {
        const res = await fetch("/graft?preview&ids=" + encodeURIComponent(typed()) + "&project=" + encodeURIComponent(project));
        if (!res.ok) return;
        const closure = await res.json();
        if (closure.rejected && closure.rejected.length) { invalid = true; showErr(graftVerdicts(closure)); }
      } catch {}
      sync();
    });
    // The POST shells graft for seconds; while it is in flight the control must read as
    // working, not as an at-rest disabled graft that was never accepted (#327). Entering
    // flight sets aria-busy on the form (a non-visual signal, not colour/text-only) and
    // relabels the button grafting… held disabled — distinct from the at-rest disabled
    // state. clearFlight undoes it; sync() then sets the disabled state from the ids.
    let busy = false;
    const enterFlight = () => { form.setAttribute("aria-busy", "true"); submit.textContent = "grafting…"; submit.disabled = true; };
    const clearFlight = () => { form.removeAttribute("aria-busy"); submit.textContent = "graft"; };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // A submit while a graft is already in flight is a no-op — no second graft is shelled
      // against the same ids (the button is held disabled too, this guards the Enter path).
      if (busy || !typed()) return;
      busy = true;
      clearErr();
      enterFlight();
      try {
        const res = await fetch("/graft", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ids: typed(), project }),
        });
        if (res.status === 422) {
          // Whole-batch rejection — lift the per-id verdicts the route rendered and show
          // them inline; keep the typed ids so the operator can correct or drop them.
          const doc = new DOMParser().parseFromString(await res.text(), "text/html");
          const list = doc.querySelector("[data-graft-verdicts]");
          invalid = true;
          showErr(list ? [...list.querySelectorAll("li")].map((li) => li.textContent).join("  ·  ") : "Nothing grafted — fix these ids.");
          return;
        }
        // Success — the graft confirms on the wave; clear the input back to rest.
        ids.value = ""; invalid = false;
      } catch {
        showErr("Couldn't reach graft — is a campaign still running?");
      } finally {
        // Clears the in-flight state on every exit path (success, 422, thrown/network error).
        // Tolerates its own nodes being detached by a mid-flight soft-refresh — setAttribute/
        // textContent/toggleAttribute on a detached node never throw, so no stuck grafting… state.
        busy = false;
        clearFlight();
        sync();
      }
    });
    sync();
    // Carry the outgoing control's operator state across the soft-refresh swap (#329): the
    // graftCarry reducer (dashboard-visual-state.ts) already decided — from the node that was
    // replaced — what to restore; this applies it to the freshly-wired node. pendingGraftCarry
    // is the page-script hand-off softRefresh set immediately before the swap; null on the
    // first wire and every non-refresh re-bind, so an empty at-rest form is left untouched.
    if (pendingGraftCarry) {
      const carry = pendingGraftCarry;
      pendingGraftCarry = null;
      if (carry.ids) ids.value = carry.ids;
      invalid = carry.invalid;
      if (carry.error) showErr(carry.error);
      // sync() sets the active/disabled state from the restored ids + invalid flag; a carried
      // in-flight graft then re-enters the busy look, which holds the button disabled over it.
      sync();
      if (carry.busy) { busy = true; enterFlight(); }
    }
  }`;

/**
 * The Redrive control's client script (design §11, #325): the greyed-until-safe button, when
 * enabled, opens a native `<dialog>` confirming exactly what the redrive will do; only Confirm
 * (a submit inside the `/redrive` POST form) sends it. Cancel — the dialog's default, `autofocus`
 * and closed by Escape/backdrop for free — closes without POSTing. Lives inside `#live-region`
 * (its enabled/disabled state tracks the live fold), so `wireRedrive` re-binds the fresh nodes
 * on every soft-refresh; a disabled button (no dialog rendered) is a no-op. Guarded against a
 * double bind so a re-run over the same node adds no second listener.
 */
export const REDRIVE_SCRIPT = `  function wireRedrive() {
    const open = document.querySelector("[data-redrive-open]");
    const dialog = document.querySelector("[data-redrive-dialog]");
    if (!open || !dialog || open.disabled || open.dataset.redriveWired) return;
    open.dataset.redriveWired = "1";
    open.addEventListener("click", () => { if (typeof dialog.showModal === "function") dialog.showModal(); });
    const cancel = dialog.querySelector("[data-redrive-cancel]");
    if (cancel) cancel.addEventListener("click", () => dialog.close());
  }`;
