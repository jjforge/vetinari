import { cappedRawRows, followView, highlightJsonLine, isNotableHostEvent, tailAppend, tailFresh, tailView } from "./dashboard-render.ts";
import { paneActivity } from "./dashboard-visual-state.ts";
import { humanizeHostLine, LOG_DOT_STATE_COLOR } from "./log-view.ts";

/**
 * The dashboard's inert browser payloads — the CSS and client-side JavaScript
 * shipped verbatim to the browser and never executed in Node, lifted out of
 * `dashboard-render.ts` (#112) so `render` is a clean view-model → HTML seam.
 * The state→colour derivation (`stateColor`, `STATE_DOT_CSS`, …) lives here too:
 * the style payloads interpolate it at module-load time, so it is co-located with
 * them. `highlightJsonLine`/`cappedRawRows` stay in `dashboard-render.ts` as the
 * tested server-side source and are shipped into `ARCHIVE_LIST_SCRIPT` via
 * `.toString()` — the one back-reference this module makes.
 */
/**
 * The dashboard's single colour source (`docs/dashboard-color-rules.md`, #83): one
 * `:root` palette emitted verbatim into every surface's `<style>` — the all-repos
 * landing, the repo/campaign page, and the issue-detail sheet they share. No
 * surface defines a colour locally, so a token can never be "defined in one root,
 * missing in the other" (the #78 class of bug). Every colour that carries meaning
 * is one of the six ADR-0007 states or the prune action (§1); the teal
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
    /* Prune action — a control, never a state; a different red from failure (§1) */
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
  // A quarantined issue and a wave-parked wave are both attention-class held states
  // (ADR 0013), so they read in the same amber as an issue `parked` (§1).
  quarantined: "yellow",
  "wave-parked": "yellow",
  // An interrupted archived run's in-flight wave/issue (#152): it stopped without
  // finishing, a caution the same amber reads on the run-level state dot.
  interrupted: "yellow",
  failure: "failure",
  completed: "green",
  pruned: "pruned",
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
 * `running` alone (§5): a running dot pulses to signal active work, reduced-motion aware;
 * nothing else animates. A
 * `.running.idle` dot (a zero-count "0 running" tally chip) keeps the blue but no pulse —
 * motion means work in flight, and an idle tally has none.
 */
export const STATE_DOT_CSS =
  `.dot { width: .75rem; height: .75rem; border-radius: 999px; display: inline-block; } ` +
  ["running", "parked", "failure", "completed", "unstarted", "pruned", "queued", "quarantined", "interrupted"].map((s) => `.dot.${s} { background: ${stateColor(s)}; }`).join(" ") +
  ` @keyframes chip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } } .dot.running { animation: chip-pulse 1.4s ease-in-out infinite; } .dot.running.idle { animation: none; } @media (prefers-reduced-motion: reduce) { .dot.running { animation: none; } }`;

/**
 * A wave-member row carries its own status at 40% alpha on a left edge (§4) — muted
 * so a wave of a dozen rows does not vibrate, while each row's full-strength dot
 * still lets you count states at a glance. Generated once from `stateBorderColor`;
 * each member row carries a matching status class. Tally counts (not states) are
 * deliberately left out — they keep a neutral edge (§7).
 */
export const STATE_CHIP_BORDER_CSS = ["running", "parked", "failure", "completed", "unstarted", "pruned", "quarantined", "interrupted"].map((s) => `.wave-member.${s} { border-color: ${stateBorderColor(s)}; }`).join(" ");

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
  .repo-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--color-dim); }
  .repo-dot.all { background: var(--color-primary); }
  ${["running", "parked", "failure", "completed", "idle"].map((s) => `.repo-dot.${s} { background: ${stateColor(s)}; }`).join(" ")}
  /* The mockup's density is desktop-tuned; touch rows grow to the 44px minimum, and the
     label steps to 15px on a phone. */
  @media (pointer: coarse) { .repo-option { min-height: 44px; } }
  @media (max-width: 640px) { .repo-label { font-size: 15px; } }
  .live-bar { display: inline-flex; align-items: center; gap: .75rem; color: var(--color-text-light-2); font-size: .85rem; }
  .live-indicator { display: inline-flex; align-items: center; color: var(--color-green); }
  /* The green live dots (this one on the live-bar, and the event-log header's) track the
     live *stream*: they pulse whenever live, regardless of running count (§5 — the green
     dots are the stream channel, distinct from the blue .dot.running that tracks work). */
  .live-indicator::before { content: ""; width: .55rem; height: .55rem; border-radius: 999px; background: currentColor; animation: chip-pulse 1.6s ease-in-out infinite; }
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
  .prune-start, .prune-confirm-btn, .prune-cancel { padding: .35rem .7rem; border: 1px solid var(--color-red); border-radius: 999px; background: rgb(247 146 135 / 12%); color: var(--color-red); font: inherit; line-height: 1; cursor: pointer; }
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
  ${["running", "parked", "failure", "completed", "unstarted", "pruned", "quarantined", "interrupted"].map((s) => `.issue-detail-sheet.${s} { border-top-color: ${stateColor(s)}; }`).join(" ")}
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
  ${["completed", "parked", "failure", "running", "unstarted", "pruned", "quarantined"].map((s) => `.turn-num.${s} { color: ${stateColor(s)}; }`).join(" ")}
  .turn-summary { color: var(--color-text-light); }
  .turn-empty { color: var(--color-text-light-2); padding: .55rem 0; }
  /* Parked-reply block + the actions row pin to the sheet foot so Resume/Prune stay
     reachable one-handed while the turn log scrolls above. */
  /* The reply block is the human-action queue inside the sheet, so it carries the
     3px amber left edge (§2); it only ever shows for a parked issue. */
  .issue-detail-reply { flex: none; padding: .9rem 1.15rem; border-top: 1px solid var(--color-light-border); border-left: 3px solid var(--color-yellow); background: var(--color-box-header); }
  .reply-heading { margin: 0 0 .5rem; font-size: .95rem; color: var(--color-text-light); }
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
  .reply-resume { min-height: 44px; padding: .5rem 1rem; border: 0; border-radius: var(--border-radius); background: var(--color-primary); color: #04110f; font: inherit; font-weight: 700; cursor: pointer; }
  @media (max-width: 640px) { .issue-detail-sheet { width: 100%; max-height: 88vh; border-radius: var(--border-radius-medium) var(--border-radius-medium) 0 0; padding-bottom: env(safe-area-inset-bottom); } .issue-detail { align-items: flex-end; padding: 0; } }`;

/**
 * The issue-detail sheet's client script — one definition included by both pages
 * (previously hand-synced, #76). It wires the sheet itself: the element refs,
 * `openIssue`/`renderDetail`/`renderReply`, `closeSheet`, the foot's Resume/Prune
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
  const replyResume = document.getElementById("reply-resume");
  const replyQuestion = document.getElementById("reply-question");
  const replyOptions = document.getElementById("reply-options");
  const replyText = document.getElementById("reply-text");
  const replyForm = document.getElementById("reply-form");
  const sheetActions = document.querySelector(".sheet-actions");
  // The foot (reply + actions) shows only while it holds a live control — a parked
  // reply to send or a prune to offer — so a plain issue's sheet grows no empty bar.
  const updateFoot = () => {
    const prune = document.getElementById("prune-panel");
    const pruneShown = Boolean(prune && !prune.hidden);
    sheetActions.hidden = replyResume.hidden && !pruneShown;
    // A standalone Prune — offered, not beside a parked issue's Resume, and not yet
    // in its confirm step — gets a plain-words explainer of what a prune does; a
    // parked issue's Resume gives the context instead, so the explainer stays hidden.
    const explainer = document.getElementById("prune-explainer");
    const start = document.getElementById("prune-start");
    if (explainer) explainer.hidden = !pruneShown || !replyResume.hidden || (start ? start.hidden : true);
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
  // A parked issue's reply block: the full question, the offered options as buttons
  // that fill the field (never submit), and the free-text field itself; Resume posts
  // it through /answer to resume the parked task. Options are best-effort — absent,
  // only the free-text field shows. Any other status hides the whole block.
  const renderReply = (d) => {
    // An archived issue is read-only: it never offers a reply/resume, even if its
    // reconstructed status is parked (an interrupted run's unanswered question).
    const parked = d.status === "parked" && !d.archived;
    detailReply.hidden = !parked;
    replyResume.hidden = !parked;
    if (parked) {
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
    }
    updateFoot();
  };
  const renderDetail = (d) => {
    renderReply(d);
    detailNum.textContent = "#" + d.issueNumber;
    // The sheet's top edge reads the issue's state (§2), the dot its full-strength colour.
    detailSheet.className = "issue-detail-sheet " + d.status;
    detailStatusDot.className = "dot " + d.status;
    detailStatusLabel.textContent = d.status;
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
    // Hide the reply block until the fetched status confirms the issue is parked.
    detailReply.hidden = true;
    replyResume.hidden = true;
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
 * The archived-runs list's client script (#98): expand/collapse rows (one open at a
 * time, the open row tinted), switch a row between campaign and raw-log mode without
 * collapsing, reveal older rows past the cap, and render the raw log — fetched once
 * from `GET /archive/log`, one JSONL line per row with a `#L<n>` line-number anchor
 * (which the browser adds to the URL natively, so a line is shareable), JSON syntax
 * colouring, a substring filter, and a `showing <shown> of <total> lines` footer.
 * The render is capped (`RAW_CAP`) with a "show more" control so a many-thousand-line
 * log keeps a bounded DOM rather than OOM-crashing a constrained tab (#127). The open
 * row + mode are mirrored into the URL (`?run=…&mode=…`) so the view is shareable
 * without a navigation. No-op when the page has no archived list.
 *
 * `highlightJsonLine` is shipped verbatim from its tested server-side source via
 * `.toString()`; the one-line `__name` shim satisfies the `keepNames` wrapper esbuild
 * leaves on the transpiled function, so there is a single source of truth for the
 * colouring rather than a hand-mirrored copy that could drift.
 */
export const ARCHIVE_LIST_SCRIPT = `  const archiveList = document.querySelector(".archive-list");
  if (archiveList) {
    const __name = (fn) => fn;
    const RAW_CAP = 500;
    ${highlightJsonLine.toString()}
    ${cappedRawRows.toString()}
    // The Humanized ⇄ Raw display mode (#203): humanized by default, remembered client-side so a
    // Raw preference sticks across reloads. The humanized parts are computed server-side (the
    // run-level kinds narrate through describeEvent, not shippable) and ride each line down.
    const MODE_KEY = "vetinari:archive-raw-mode";
    let rawMode = "humanized"; try { const m = localStorage.getItem(MODE_KEY); if (m === "raw" || m === "humanized") rawMode = m; } catch (e) {}
    const syncRawModeBtns = () => { for (const b of archiveList.querySelectorAll("[data-archive-raw-mode] [data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === rawMode)); };
    const archiveRows = [...archiveList.querySelectorAll(".archive-row")];
    const rowMode = (row) => { const p = row.querySelector('.archive-mode[aria-pressed="true"]'); return p ? p.dataset.mode : "campaign"; };
    const syncUrl = (row) => { try { history.replaceState(null, "", "?project=" + encodeURIComponent(archiveList.dataset.project) + "&run=" + encodeURIComponent(row.dataset.run) + (rowMode(row) === "raw" ? "&mode=raw" : "") + location.hash); } catch (e) {} };
    // A deep-linked line past the current cap isn't in the DOM, so raise the pane's
    // cap enough to include it before scrolling (or leave the pane untouched if the
    // target is already rendered / the hash points at nothing here).
    const scrollToLine = (pane) => {
      if (!/^#L\\d+$/.test(location.hash)) return;
      const id = location.hash.slice(1);
      if (pane && !document.getElementById(id)) {
        const n = Number(id.slice(1));
        if (n > RAW_CAP + (pane._expanded || 0)) { pane._expanded = n - RAW_CAP; drawRaw(pane); }
      }
      const t = document.getElementById(id);
      if (t) t.scrollIntoView({ block: "center" });
    };
    // Fetch a row's log once, then (re)draw its filtered line rows. Redraw is cheap
    // and keeps only the open row's L-ids in the DOM, so a shared #L anchor is unambiguous.
    // The render is capped at RAW_CAP (+ any "show more" expansion) so a many-thousand-line
    // log can't build an unbounded DOM and OOM-crash a memory-constrained tab (#127).
    const drawRaw = (pane) => {
      const linesEl = pane.querySelector(".archive-raw-lines");
      const footer = pane.querySelector(".archive-raw-footer");
      const filter = pane.querySelector(".archive-raw-filter");
      const needle = filter.value.trim().toLowerCase();
      const { rows, total, hidden } = cappedRawRows(pane._lines || [], needle, RAW_CAP, pane._expanded || 0);
      linesEl.textContent = "";
      for (const { line, n } of rows) {
        if (rawMode === "raw") {
          // Raw: the highlighted NDJSON with its #L<n> line-number gutter (unchanged, #127).
          const el = document.createElement("div");
          el.className = "archive-raw-line"; el.id = "L" + n;
          const a = document.createElement("a");
          a.className = "archive-lineno"; a.href = "#L" + n; a.textContent = String(n);
          const code = document.createElement("code");
          code.className = "archive-raw-code"; code.innerHTML = highlightJsonLine(line);
          el.append(a, code); linesEl.append(el);
        } else {
          // Humanized (default): time · actor · what happened, the dot coloured by the event's
          // own state — the parts the server attached per line; an eventless line falls back to a
          // raw dump. Keeps the #L<n> id so a deep-link still scrolls regardless of mode.
          const h = (pane._humanized && pane._humanized[n - 1]) || { time: "", actor: "", message: line, dot: "neutral" };
          const el = document.createElement("div"); el.className = "log-hrow"; el.id = "L" + n;
          const dot = document.createElement("span"); dot.className = "log-dot " + h.dot; el.append(dot);
          const t = document.createElement("span"); t.className = "log-time"; t.textContent = h.time; el.append(t);
          const ac = document.createElement("span"); ac.className = "log-actor"; ac.textContent = h.actor; el.append(ac);
          const msg = document.createElement("span"); msg.className = "log-msg"; msg.textContent = h.message; el.append(msg);
          linesEl.append(el);
        }
      }
      if (!rows.length) { const e = document.createElement("div"); e.className = "archive-raw-empty"; e.textContent = needle ? "No lines match “" + filter.value.trim() + "”." : "This log has no lines."; linesEl.append(e); }
      if (hidden > 0) { const more = document.createElement("button"); more.type = "button"; more.className = "archive-raw-more"; more.textContent = "Show " + hidden + " more line" + (hidden === 1 ? "" : "s"); more.addEventListener("click", () => { pane._expanded = (pane._expanded || 0) + RAW_CAP; drawRaw(pane); }); linesEl.append(more); }
      footer.textContent = "showing " + rows.length + " of " + total + " lines";
    };
    // The Humanized ⇄ Raw toggle and Download JSON, wired once per pane. The toggle flips the
    // shared display mode, persists it, re-syncs every row's buttons, and redraws this pane;
    // Download JSON emits the currently-filtered raw NDJSON (uncapped) so the bytes stay faithful.
    const wireRawControls = (pane) => {
      const modeEl = pane.querySelector("[data-archive-raw-mode]");
      if (modeEl) for (const btn of modeEl.querySelectorAll("[data-mode]")) btn.addEventListener("click", () => { rawMode = btn.dataset.mode; try { localStorage.setItem(MODE_KEY, rawMode); } catch (e) {} syncRawModeBtns(); drawRaw(pane); });
      const saveBtn = pane.querySelector("[data-archive-raw-save]");
      if (saveBtn) saveBtn.addEventListener("click", () => {
        const needle = pane.querySelector(".archive-raw-filter").value.trim().toLowerCase();
        const matching = needle ? (pane._lines || []).filter((l) => l.toLowerCase().indexOf(needle) !== -1) : (pane._lines || []);
        const blob = new Blob([matching.join("\\n")], { type: "application/x-ndjson" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "orchestrator-" + pane.dataset.run + ".jsonl"; a.click(); URL.revokeObjectURL(a.href);
      });
    };
    const loadRaw = (row) => {
      const pane = row.querySelector(".archive-raw");
      const filter = pane.querySelector(".archive-raw-filter");
      if (!pane._wired) { pane._wired = true; filter.addEventListener("input", () => drawRaw(pane)); wireRawControls(pane); }
      if (pane._lines) { drawRaw(pane); scrollToLine(pane); return; }
      fetch("/archive/log?project=" + encodeURIComponent(pane.dataset.project) + "&run=" + encodeURIComponent(pane.dataset.run))
        .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
        .then((data) => { const ls = (data && data.lines) || []; pane._lines = ls.map((l) => l.raw); pane._humanized = ls.map((l) => l.humanized); drawRaw(pane); scrollToLine(pane); })
        .catch(() => { const linesEl = pane.querySelector(".archive-raw-lines"); linesEl.textContent = ""; const e = document.createElement("div"); e.className = "archive-raw-empty"; e.textContent = "Couldn’t load this log."; linesEl.append(e); pane.querySelector(".archive-raw-footer").textContent = ""; });
    };
    const setMode = (row, mode) => {
      for (const btn of row.querySelectorAll(".archive-mode")) { const on = btn.dataset.mode === mode; btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); }
      for (const pane of row.querySelectorAll(".archive-pane")) pane.hidden = pane.dataset.pane !== mode;
      if (mode === "raw") loadRaw(row);
    };
    const closeRow = (row) => {
      row.classList.remove("open");
      row.querySelector(".archive-toggle").setAttribute("aria-expanded", "false");
      row.querySelector(".archive-body").hidden = true;
      // Drop the raw lines so a closed row leaves no duplicate L-ids behind (its text is cached).
      const linesEl = row.querySelector(".archive-raw-lines");
      if (linesEl) linesEl.textContent = "";
    };
    const openRow = (row, mode) => {
      for (const other of archiveRows) if (other !== row && other.classList.contains("open")) closeRow(other);
      row.classList.add("open");
      row.querySelector(".archive-toggle").setAttribute("aria-expanded", "true");
      row.querySelector(".archive-body").hidden = false;
      setMode(row, mode);
      syncUrl(row);
    };
    for (const row of archiveRows) {
      row.querySelector(".archive-toggle").addEventListener("click", () => { if (row.classList.contains("open")) closeRow(row); else openRow(row, rowMode(row)); });
      for (const btn of row.querySelectorAll(".archive-mode")) btn.addEventListener("click", () => { if (!row.classList.contains("open")) openRow(row, btn.dataset.mode); else { setMode(row, btn.dataset.mode); syncUrl(row); } });
    }
    // Seed every row's mode buttons from the remembered mode (the markup seeds humanized pressed).
    syncRawModeBtns();
    const showOlder = archiveList.querySelector(".archive-show-older");
    if (showOlder) showOlder.addEventListener("click", () => { for (const row of archiveRows) row.hidden = false; showOlder.closest(".archive-older-row").hidden = true; });
    // Honour a server-opened row (a ?run= deep-link): reveal it if it is past the cap,
    // then render its starting mode (raw fetches; #L hash scrolls once the log lands).
    const opened = archiveRows.find((r) => r.classList.contains("open"));
    if (opened) { if (opened.hidden) { for (const r of archiveRows) r.hidden = false; const older = archiveList.querySelector(".archive-older-row"); if (older) older.hidden = true; } setMode(opened, rowMode(opened)); }
  }`;

/**
 * The live raw-log tailing pane's styles (#124). The shell colours come straight from
 * the shared palette (§1, no local hexes): the `--color-card` card, the `--color-body`
 * body, the `--color-secondary` hairline. The body is a fixed 236px scroll region (not
 * resizable) of 10.5px system-mono lines wrapped never scrolled. Each line's gutter reads
 * its issue's status colour (generated from `stateColor`, §3); the JSON tokens reuse the
 * archived-raw span classes but this pane's own palette (keys blue, string values the teal
 * accent, numbers/bool/null amber), scoped to `.tail-code` so it never restyles the archive
 * viewer. The header dot pulses teal only while the pane is open and following (§5,
 * reduced-motion aware). Play/pause is a 26×26 CSS-drawn icon flipped by `data-following`.
 */
export const LIVE_TAIL_STYLES = `  .live-tail { background: var(--color-card); border: 1px solid var(--color-secondary); border-radius: var(--border-radius-medium); overflow: hidden; margin: 1rem 0; }
  .live-tail[hidden] { display: none; }
  .tail-head { display: flex; align-items: center; gap: .5rem; padding: 10px 13px; }
  .tail-dot { width: .6rem; height: .6rem; border-radius: 999px; background: var(--color-dim); flex: none; }
  .tail-dot[data-state="live"] { background: var(--color-primary); animation: chip-pulse 2.4s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .tail-dot[data-state="live"] { animation: none; } }
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
  .tail-play { position: relative; width: 26px; height: 26px; flex: none; border: 1px solid var(--color-secondary); border-radius: 7px; background: var(--color-chip); cursor: pointer; padding: 0; }
  .tail-play[data-following="true"] { border-color: var(--color-blue-40); }
  .tail-play[data-following="true"]::before, .tail-play[data-following="true"]::after { content: ""; position: absolute; top: 7px; width: 3px; height: 12px; background: var(--color-text-light); }
  .tail-play[data-following="true"]::before { left: 8px; }
  .tail-play[data-following="true"]::after { right: 8px; }
  .tail-play[data-following="false"]::before { content: ""; position: absolute; top: 6px; left: 9px; border-style: solid; border-width: 7px 0 7px 11px; border-color: transparent transparent transparent var(--color-text-light); }
  .tail-save, .tail-clear { border: 1px solid var(--color-secondary); border-radius: var(--border-radius); background: var(--color-chip); color: var(--color-text-light); font: inherit; font-size: .78rem; padding: .3rem .55rem; cursor: pointer; }
  .tail-save:hover, .tail-clear:hover { background: var(--color-card-hover); }
  .tail-body { height: 236px; overflow-y: auto; overflow-x: hidden; background: var(--color-body); font-family: ${MONO_FONT}; font-size: 10.5px; line-height: 1.5; }
  .tail-body[hidden] { display: none; }
  .tail-line { display: grid; grid-template-columns: 44px 1fr; gap: .6rem; padding: .05rem .6rem .05rem 0; }
  .tail-line:hover { background: var(--color-card); }
  .tail-gutter { text-align: right; color: var(--color-dim); font-variant-numeric: tabular-nums; }
  ${["running", "parked", "failure", "completed", "unstarted", "pruned", "quarantined", "interrupted"].map((s) => `.tail-gutter.${s} { color: ${stateColor(s)}; }`).join(" ")}
  .tail-code { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--color-text-light); }
  .tail-code .jkey { color: var(--color-blue); }
  .tail-code .jstr { color: var(--color-primary); }
  .tail-code .jnum, .tail-code .jbool, .tail-code .jnull { color: var(--color-yellow); }
  /* The Humanized ⇄ Raw segmented toggle (#203): a two-button pill, the pressed side accented. */
  .tail-mode { display: inline-flex; border: 1px solid var(--color-secondary); border-radius: 999px; overflow: hidden; }
  .tail-mode-btn { border: 0; background: var(--color-chip); color: var(--color-text-light-2); font: inherit; font-size: .78rem; padding: .28rem .6rem; cursor: pointer; }
  .tail-mode-btn:hover { color: var(--color-text); }
  .tail-mode-btn[aria-pressed="true"] { background: var(--color-blue); color: var(--color-body); font-weight: 700; }
  /* A humanized row (#203): a state dot, the HH:MM:SS time, the #issue actor, then the message.
     The dot reads the event's own state via the shared palette (§1, generated from stateColor). */
  .log-hrow { display: grid; grid-template-columns: auto auto auto 1fr; align-items: baseline; gap: .5rem; padding: .1rem .6rem; }
  .log-hrow:hover { background: var(--color-card); }
  .log-dot { width: .6rem; height: .6rem; border-radius: 999px; align-self: center; flex: none; background: var(--color-dim); }
  ${Object.entries(LOG_DOT_STATE_COLOR).map(([s, token]) => `.log-dot.${s} { background: ${stateColor(token)}; }`).join(" ")}
  .log-time { color: var(--color-dim); font-variant-numeric: tabular-nums; }
  .log-actor { color: var(--color-text-light-2); font-weight: 600; }
  .log-msg { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--color-text-light); }
  .tail-empty { color: var(--color-text-light-2); padding: .5rem .6rem; }
  .tail-backlog { display: block; width: 100%; border: 0; background: var(--color-blue); color: var(--color-body); font: inherit; font-size: .78rem; font-weight: 700; padding: .35rem; cursor: pointer; text-align: center; }
  .tail-backlog[hidden] { display: none; }
  .tail-footer { color: var(--color-text-light-2); font-size: .75rem; padding: .4rem 13px; border-top: 1px solid var(--color-light-border); }
  .tail-footer[hidden] { display: none; }`;

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
    ${highlightJsonLine.toString()}
    ${tailFresh.toString()}
    ${tailAppend.toString()}
    ${followView.toString()}
    ${tailView.toString()}
    ${paneActivity.toString()}
    const FOLLOW_CAP = 260, RENDER_CAP = 160;
    const project = tailEl.dataset.project;
    let agents = []; try { agents = JSON.parse(tailEl.dataset.agents || "[]"); } catch (e) {}
    // The Humanized ⇄ Raw display mode (#203): humanized by default, remembered per view in
    // localStorage so a Raw preference sticks across refreshes and per repo.
    const MODE_KEY = "vetinari:tail-mode:" + project;
    let mode = "humanized"; try { const m = localStorage.getItem(MODE_KEY); if (m === "raw" || m === "humanized") mode = m; } catch (e) {}
    let open = true, live = true, mark = 0, issue = "", query = "", buffer = [], seen = {};
    const statusOf = (id) => (agents.find((a) => a.issue === id) || {}).status || "running";
    const q = (sel) => tailEl.querySelector(sel);
    const dotEl = q("[data-tail-dot]"), toggle = q("[data-tail-toggle]"), summaryEl = q("[data-tail-summary]");
    const controls = q("[data-tail-controls]"), body = q("[data-tail-body]"), footer = q("[data-tail-footer]");
    const backlogEl = q("[data-tail-backlog]"), playBtn = q("[data-tail-play]"), filterEl = q("[data-tail-filter]");
    const issueDd = q("[data-tail-issue-dd]"), issueTrigger = q("[data-tail-issue-trigger]"), issueMenu = q("[data-tail-issue-menu]");
    const issueLabel = q("[data-tail-issue-label]"), issueDot = q("[data-tail-issue-dot]");
    const saveBtn = q("[data-tail-save]"), clearBtn = q("[data-tail-clear]"), modeEl = q("[data-tail-mode]");
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
    function renderSummary() { summaryEl.textContent = agents.length + " agent" + (agents.length === 1 ? "" : "s") + (open ? "" : " · paused"); }
    function render() {
      const view = tailView({ buffer, mark, live, issue, query, cap: RENDER_CAP });
      body.textContent = "";
      if (view.rows.length) {
        for (const r of view.rows) {
          if (mode === "raw") {
            // Raw: the highlighted NDJSON, gutter coloured by the issue's status (unchanged, #195).
            const line = mk("div", "tail-line");
            line.append(mk("span", "tail-gutter " + statusOf(r.issue), "#" + r.issue));
            const code = mk("code", "tail-code"); code.innerHTML = highlightJsonLine(r.raw); line.append(code);
            body.append(line);
          } else {
            // Humanized (default): time · actor · what happened, the dot coloured by the event's
            // own state (the server-attached parts); an eventless line falls back to a raw dump.
            const h = r.humanized || { time: "", actor: "", message: r.raw, dot: "neutral" };
            const line = mk("div", "log-hrow");
            line.append(mk("span", "log-dot " + h.dot));
            line.append(mk("span", "log-time", h.time));
            line.append(mk("span", "log-actor", h.actor));
            line.append(mk("span", "log-msg", h.message));
            body.append(line);
          }
        }
      } else {
        body.append(mk("div", "tail-empty", issue || query.trim() ? "no lines match that filter" : ""));
      }
      footer.textContent = view.visible + " of " + view.total + " lines · " + (view.following ? "following" : "paused");
      if (view.backlog > 0) { backlogEl.hidden = false; backlogEl.textContent = "↑ " + view.backlog + " new line" + (view.backlog === 1 ? "" : "s"); } else { backlogEl.hidden = true; }
      playBtn.dataset.following = String(live); playBtn.setAttribute("aria-label", live ? "Pause" : "Resume");
      dotEl.dataset.state = open && live ? "live" : "idle";
      // Newest-on-top (#195): following pins the newest line to the top, not the bottom.
      if (live) body.scrollTop = 0;
    }
    function ingest(tail) {
      agents = (tail && tail.agents) || [];
      tailEl.hidden = agents.length === 0;
      renderMenu(); renderSummary();
      const res = tailFresh((tail && tail.lines) || [], seen); seen = res.seen;
      // Grow the buffer past the cap only while explicitly paused with the pane open (a backlog
      // to reveal); following or collapsed keeps it bounded — reopening jumps to live anyway.
      if (res.fresh.length) buffer = tailAppend(buffer, res.fresh, live || !open, FOLLOW_CAP);
      // A visible append (pane open + following, with new lines) is a live-surface update:
      // signal the live-bar to reset its "updated Ns ago" clock (#198). Buffered frames
      // (collapsed, or the tail's own follow paused) present nothing new and stay silent.
      if (paneActivity({ appended: res.fresh.length, open, following: live })) window.dispatchEvent(new CustomEvent("vetinari:activity"));
      render();
    }
    events.addEventListener("tail", (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m && m.project === project) ingest(m.tail); });
    toggle.addEventListener("click", () => {
      open = !open; toggle.setAttribute("aria-expanded", String(open)); controls.hidden = !open; body.hidden = !open; footer.hidden = !open;
      // Opening starts following; closing pauses (the tail's own state, not the campaign's).
      live = open; mark = buffer.length; if (!open) backlogEl.hidden = true;
      renderSummary(); render();
    });
    playBtn.addEventListener("click", () => { live = !live; mark = buffer.length; render(); });
    backlogEl.addEventListener("click", () => { live = true; mark = buffer.length; render(); });
    filterEl.addEventListener("input", () => { query = filterEl.value; render(); });
    // The Humanized ⇄ Raw toggle (#203): flip the body's line format, persist the choice, and
    // re-render. Seed the pressed state from the remembered mode so the buttons match on load.
    const syncModeBtns = () => { if (modeEl) for (const b of modeEl.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); };
    if (modeEl) for (const btn of modeEl.querySelectorAll("[data-mode]")) btn.addEventListener("click", () => { mode = btn.dataset.mode; try { localStorage.setItem(MODE_KEY, mode); } catch (e) {} syncModeBtns(); render(); });
    syncModeBtns();
    issueTrigger.addEventListener("click", (e) => { e.stopPropagation(); const willOpen = issueMenu.hidden; issueMenu.hidden = !willOpen; issueTrigger.setAttribute("aria-expanded", String(willOpen)); });
    document.addEventListener("click", (e) => { if (!issueDd.contains(e.target)) { issueMenu.hidden = true; issueTrigger.setAttribute("aria-expanded", "false"); } });
    saveBtn.addEventListener("click", () => {
      // The currently visible (filtered) lines — uncapped by the render window — as a .jsonl download.
      const view = tailView({ buffer, mark, live, issue, query, cap: Math.max(buffer.length, 1) });
      const blob = new Blob([view.rows.map((r) => r.raw).join("\\n")], { type: "application/x-ndjson" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tail-" + project + ".jsonl"; a.click(); URL.revokeObjectURL(a.href);
    });
    // Clear drops only this repo's buffered lines; the seen-high-water map is kept so the
    // server's still-held window isn't re-imported next frame (the clear sticks until new lines arrive).
    clearBtn.addEventListener("click", () => { buffer = []; mark = 0; render(); });
    renderMenu(); renderSummary(); render();
  }`;

/**
 * The host-log surface's styles (#180): the gear + attention badge and the raw-JSONL
 * pane it toggles. Colours come straight from the shared palette (§1, no local hexes) —
 * the `--color-box-body` panel, the `--color-secondary` hairline, and the badge in the
 * failure red (the one alert colour). The gear rides the end of the top-right live-bar,
 * after the freshness readout (#201); the pane is an absolutely-positioned popover beneath it on
 * desktop (right-aligned to the gear), and a bottom sheet on a phone. The JSON tokens
 * reuse the archived-raw span classes but scope their palette to `.host-log-code` so
 * they never restyle the archive viewer or the live tail.
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
  .host-log-filter { margin: .7rem .9rem 0; padding: .4rem .6rem; color: var(--color-text); background: var(--color-body); border: 1px solid var(--color-secondary); border-radius: var(--border-radius); font: inherit; font-size: .8rem; }
  /* The shared log-view controls row (#203): the Humanized ⇄ Raw toggle and Download JSON,
     laid out with the filter above them; the buttons reuse the live tail's .tail-mode / .tail-save. */
  .host-log-controls { display: flex; align-items: center; gap: .5rem; margin: .5rem .9rem 0; }
  .host-log-lines { flex: 1; min-height: 0; overflow-y: auto; padding: .6rem .9rem; font-family: ${MONO_FONT}; font-size: .78rem; line-height: 1.5; }
  .host-log-line { padding: .05rem 0; }
  .host-log-code { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--color-text-light); }
  .host-log-code .jkey { color: var(--color-blue); }
  .host-log-code .jstr { color: var(--color-green); }
  .host-log-code .jnum, .host-log-code .jbool, .host-log-code .jnull { color: var(--color-yellow); }
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
    ${highlightJsonLine.toString()}
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
    const modeEl = hostLogRoot.querySelector("[data-host-log-mode]");
    const saveBtn = hostLogRoot.querySelector("[data-host-log-save]");
    // The Humanized ⇄ Raw display mode (#203): humanized by default, remembered client-side so a
    // Raw preference sticks across reloads. Humanized runs the shipped humanizeHostLine per line.
    const MODE_KEY = "vetinari:host-log-mode";
    let mode = "humanized"; try { const m = localStorage.getItem(MODE_KEY); if (m === "raw" || m === "humanized") mode = m; } catch (e) {}
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
        if (mode === "raw") {
          // Raw: the highlighted NDJSON, one mono line (unchanged, #180).
          const row = document.createElement("div"); row.className = "host-log-line";
          const code = document.createElement("code"); code.className = "host-log-code"; code.innerHTML = highlightJsonLine(line);
          row.append(code); linesEl.append(row);
        } else {
          // Humanized (default): time · actor · what happened, the dot coloured by the host
          // event's own state (failures red); an unknown kind falls back to a raw dump.
          const h = humanizeHostLine(line);
          const row = document.createElement("div"); row.className = "log-hrow";
          const dot = document.createElement("span"); dot.className = "log-dot " + h.dot; row.append(dot);
          const t = document.createElement("span"); t.className = "log-time"; t.textContent = h.time; row.append(t);
          const a = document.createElement("span"); a.className = "log-actor"; a.textContent = h.actor; row.append(a);
          const m = document.createElement("span"); m.className = "log-msg"; m.textContent = h.message; row.append(m);
          linesEl.append(row);
        }
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
    // The Humanized ⇄ Raw toggle (#203): flip the body format, persist the choice, redraw. Seed
    // the pressed state from the remembered mode so the buttons match on load.
    const syncModeBtns = () => { if (modeEl) for (const b of modeEl.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); };
    if (modeEl) for (const btn of modeEl.querySelectorAll("[data-mode]")) btn.addEventListener("click", () => { mode = btn.dataset.mode; try { localStorage.setItem(MODE_KEY, mode); } catch (e) {} syncModeBtns(); draw(); });
    syncModeBtns();
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
      // reset its "updated Ns ago" clock (#198). The host-log always shows newest-first, so
      // there is no follow to pause — visibility is just the panel; a closed panel stays
      // silent (the badge still signals).
      if (paneActivity({ appended: appended.length, open: !panel.hidden, following: true })) window.dispatchEvent(new CustomEvent("vetinari:activity"));
    };
    events.addEventListener("host", (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } ingest((m && m.lines) || []); });
    // The initial window is the no-daemon host-log read (readHostLog), newest-first already.
    // Append it behind any rows a live frame already delivered so a frame racing this fetch
    // isn't clobbered; the fetch rows are the older backlog, so newest-first order holds.
    fetch("/api/host-log").then((r) => (r.ok ? r.json() : { lines: [] })).then((d) => {
      lines = lines.concat((d && d.lines) || []);
      if (lines.length > HOST_WINDOW) lines = lines.slice(0, HOST_WINDOW);
      if (!panel.hidden) draw();
      updateBadge();
    }).catch(() => {});
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
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!typed()) return;
      clearErr();
      submit.disabled = true;
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
          sync();
          return;
        }
        // Success — the graft confirms on the wave; clear the input back to rest.
        ids.value = ""; invalid = false; sync();
      } catch {
        showErr("Couldn't reach graft — is a campaign still running?");
        sync();
      }
    });
    sync();
  }`;
