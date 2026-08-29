// Tests for the dashboard assets — the shared palette, the state/counter colour
// derivations, and the CSS/script constants (dashboard-assets.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_PALETTE_CSS, stateColor, stateBorderColor, counterColor, TOP_BAR_STYLES, ISSUE_DETAIL_SHEET_STYLES, ISSUE_DETAIL_SHEET_SCRIPT, HOST_LOG_STYLES, HOST_LOG_SCRIPT } from "./dashboard-assets.ts";
import { cappedRawRows, isNotableHostEvent, renderLandingShell } from "./status.ts";

test("the card/chip colour rules are landed as a normative doc that pins the palette (#83)", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "..", "docs", "dashboard-color-rules.md"),
    "utf8",
  );
  // The doc is the reference: it carries the §1 palette at the exact hexes the code uses.
  for (const hex of [
    "#6cb6ff",
    "#c8a24e",
    "#f85149",
    "#5f6b78",
    "#3fb984",
    "#a371f7",
    "#f79287",
    "#10151b",
    "#0b0e12",
  ]) {
    assert.ok(doc.includes(hex), `the colour-rules doc pins ${hex}`);
  }
  // And it states the derivation precedence and the teal-is-not-a-state rule.
  assert.match(doc, /parked > failure > running > unstarted > completed/);
  assert.match(
    doc,
    /never appear on a status chip or a card edge|never a state/,
  );
});

test("the dashboard palette is one shared source defining every state token at its spec hex (#83)", () => {
  // §1: the six ADR-0007 states plus the prune action, each at its exact hex.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-blue: #6cb6ff/); // running
  assert.match(DASHBOARD_PALETTE_CSS, /--color-yellow: #c8a24e/); // parked
  assert.match(DASHBOARD_PALETTE_CSS, /--color-failure: #f85149/); // failure — distinct red
  assert.match(DASHBOARD_PALETTE_CSS, /--color-dim: #5f6b78/); // unstarted / idle grey
  assert.match(DASHBOARD_PALETTE_CSS, /--color-green: #3fb984/); // completed
  assert.match(DASHBOARD_PALETTE_CSS, /--color-pruned: #a371f7/); // pruned
  assert.match(DASHBOARD_PALETTE_CSS, /--color-red: #f79287/); // prune action — a control, never a state
  // The prune action and the failure state are deliberately different reds.
  assert.notEqual("#f85149", "#f79287");
  // The teal product accent is present but is not a state colour.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-primary: #3fb9b0/);
});

test("the issue-detail sheet carries the issue's state on its top edge only (§2, #83)", () => {
  // The sheet is a stateful card, so its state reads on a 2px top border, derived
  // from stateColor — the other three edges stay the neutral 1px.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-sheet \{[^}]*border-top: 2px solid/,
  );
  // The per-state top-edge colour is `stateColor` (asserted by value there); one structural
  // check confirms the shared sheet CSS splices those rules in, proven once not per state.
  assert.ok(
    ISSUE_DETAIL_SHEET_STYLES.includes(
      ["running", "parked", "failure", "completed", "unstarted", "pruned", "quarantined", "interrupted"]
        .map((s) => `.issue-detail-sheet.${s} { border-top-color: ${stateColor(s)}; }`)
        .join(" "),
    ),
    "the shared sheet CSS splices the stateColor-derived top edges",
  );
  // The sheet's state class is set from the fetched issue status when the detail renders,
  // and reset while a fresh issue is loading.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /"issue-detail-sheet " \+ d\.status/);
  // The parked-question / reply block is part of the human-action queue, so it carries
  // the 3px amber left edge (§2) — the block only shows for a parked issue.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-reply \{[^}]*border-left: 3px solid var\(--color-yellow\)/,
  );
});

test("stateColor is the single state→colour derivation, failure distinct from the prune action (#83)", () => {
  // §3: every state derives its colour here, never a per-instance hex.
  assert.equal(stateColor("running"), "var(--color-blue)");
  assert.equal(stateColor("parked"), "var(--color-yellow)");
  assert.equal(stateColor("completed"), "var(--color-green)");
  assert.equal(stateColor("pruned"), "var(--color-pruned)");
  // unstarted (and its landing display aliases) are the dim grey, not the muted one.
  assert.equal(stateColor("unstarted"), "var(--color-dim)");
  assert.equal(stateColor("queued"), "var(--color-dim)");
  assert.equal(stateColor("idle"), "var(--color-dim)");
  // failure has its own token, distinct from the prune action's --color-red (§1).
  assert.equal(stateColor("failure"), "var(--color-failure)");
  assert.notEqual(stateColor("failure"), "var(--color-red)");
});

test("stateBorderColor is the single derivation for the muted 40%-alpha chip borders (§4, #83)", () => {
  // §4: a wave-member row borders its status at 40% alpha — the same token as stateColor,
  // suffixed `-40`. quarantined/interrupted read amber like parked (ADR 0013, #152).
  assert.equal(stateBorderColor("running"), "var(--color-blue-40)");
  assert.equal(stateBorderColor("parked"), "var(--color-yellow-40)");
  assert.equal(stateBorderColor("failure"), "var(--color-failure-40)");
  assert.equal(stateBorderColor("completed"), "var(--color-green-40)");
  assert.equal(stateBorderColor("pruned"), "var(--color-pruned-40)");
  assert.equal(stateBorderColor("unstarted"), "var(--color-dim-40)");
  assert.equal(stateBorderColor("quarantined"), "var(--color-yellow-40)");
  assert.equal(stateBorderColor("interrupted"), "var(--color-yellow-40)");
});

test("counterColor is the single derivation for the landing counter-value colours (#80)", () => {
  // The three coloured counters read their status colour; queued (and any other kind)
  // stays the neutral dim, matching the render's no-rule-for-queued.
  assert.equal(counterColor("working"), "var(--color-blue)");
  assert.equal(counterColor("parked"), "var(--color-yellow)");
  assert.equal(counterColor("mergedToday"), "var(--color-green)");
  assert.equal(counterColor("queued"), "var(--color-dim)");
});

test("the repo dropdown's CSS matches the spec: mono heading, borderless trigger, popover menu, touch rows", () => {
  // The CSS is shared by both pages via TOP_BAR_STYLES, so assert it there once.
  const css = TOP_BAR_STYLES;
  // Trigger: no border, no background, no padding — just text + chevron.
  assert.match(
    css,
    /\.repo-trigger \{[^}]*border: 0;[^}]*background: none;[^}]*padding: 0;/,
  );
  // Label: system-monospace stack (no web font), 600, 17px, tight tracking, truncates, never wraps.
  assert.match(
    css,
    /\.repo-label \{[^}]*font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;[^}]*font-weight: 600;[^}]*font-size: 17px;[^}]*letter-spacing: -0.01em;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
  );
  // No IBM Plex Mono (the POC face) is added or referenced anywhere.
  assert.doesNotMatch(css, /Plex Mono/i);
  // Hover turns the label teal; the chevron is 13px, muted, and rotates 180° over 180ms when open.
  assert.match(
    css,
    /\.repo-trigger:hover \.repo-label \{ color: var\(--color-primary\); \}/,
  );
  assert.match(
    css,
    /\.repo-chevron \{[^}]*font-size: 13px;[^}]*color: var\(--color-text-light-2\);[^}]*transition: transform 180ms;/,
  );
  assert.match(
    css,
    /\.repo-trigger\[aria-expanded="true"\] \.repo-chevron \{ transform: rotate\(180deg\); \}/,
  );
  // A visible focus ring — the trigger has no border to hang one on.
  assert.match(
    css,
    /\.repo-trigger:focus-visible, \.repo-option:focus-visible \{ outline: 2px solid var\(--color-primary\);/,
  );
  // The menu is a popover: 8px below the trigger, 260px min, layered above cards (z 5)
  // but below the issue sheet (z 10), on the box surface with the spec border/radius/shadow.
  assert.match(
    css,
    /\.repo-menu \{[^}]*top: calc\(100% \+ 8px\);[^}]*z-index: 5;[^}]*min-width: 260px;[^}]*background: var\(--color-box-body\);[^}]*border: 1px solid var\(--color-secondary\);[^}]*border-radius: var\(--border-radius-medium\);[^}]*box-shadow: 0 14px 40px #0009;/,
  );
  // Never z-index 30, and never above the sheet's z-index 10 (the sheet must cover the menu).
  assert.doesNotMatch(css, /\.repo-menu \{[^}]*z-index: 30/);
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.issue-detail \{[^}]*z-index: 10/);
  // Rows: flex, selected and hovered share the fill; the note is muted, the label mono.
  assert.match(css, /\.repo-option \{[^}]*display: flex;/);
  assert.match(
    css,
    /\.repo-option:hover, \.repo-option\.selected \{ background: var\(--color-chip-hover\); \}/,
  );
  assert.match(
    css,
    /\.repo-note \{[^}]*font-size: 11px;[^}]*color: var\(--color-dim\);/,
  );
  // Touch rows are ≥44px; the label steps to 15px on a phone.
  assert.match(
    css,
    /@media \(pointer: coarse\) \{ \.repo-option \{ min-height: 44px; \} \}/,
  );
  assert.match(
    css,
    /@media \(max-width: 640px\) \{ \.repo-label \{ font-size: 15px; \} \}/,
  );
});

test("HOST_LOG_SCRIPT wires the host-log pane: gear show/hide, badge off isNotableHostEvent, filter, live host frames (#180)", () => {
  const html = renderLandingShell(["alpha"]);
  // The landing embeds the host-log script and its styles.
  assert.ok(html.includes(HOST_LOG_SCRIPT), "landing includes HOST_LOG_SCRIPT");
  assert.ok(html.includes(HOST_LOG_STYLES), "landing includes HOST_LOG_STYLES");
  // Ships the shared, tested pure helpers via .toString(), not a hand-mirrored copy.
  assert.match(HOST_LOG_SCRIPT, /function isNotableHostEvent/);
  assert.match(HOST_LOG_SCRIPT, /function cappedRawRows/);
  // The gear is the show/hide of an otherwise-hidden pane.
  assert.match(HOST_LOG_SCRIPT, /gear\.addEventListener\("click", \(\) => \(panel\.hidden \? openPanel\(\) : closePanel\(\)\)\);/);
  // The badge keys off isNotableHostEvent and a last-viewed timestamp; opening marks the
  // window's notable events seen so the badge clears until a newer one lands.
  assert.match(HOST_LOG_SCRIPT, /if \(isNotableHostEvent\(ev\)/);
  assert.match(HOST_LOG_SCRIPT, /badge\.hidden = !\(n && n > lastSeen\)/);
  assert.match(HOST_LOG_SCRIPT, /lastSeen = newestNotableTs\(\) \|\| lastSeen/);
  // Renders newest-first through the shared cap and narrows by a substring filter.
  assert.match(HOST_LOG_SCRIPT, /cappedRawRows\(lines, needle, HOST_CAP, expanded\)/);
  assert.match(HOST_LOG_SCRIPT, /filterEl\.addEventListener\("input"/);
  // Live: the initial window is the no-daemon fetch; new rows arrive on the named host frame.
  assert.match(HOST_LOG_SCRIPT, /fetch\("\/api\/host-log"\)/);
  assert.match(HOST_LOG_SCRIPT, /events\.addEventListener\("host"/);
  // A missing host log reads a clean empty state, not a blank pane.
  assert.match(HOST_LOG_SCRIPT, /No host log yet/);
});

test("HOST_LOG_SCRIPT renders humanized-only rows, keeping the raw NDJSON Download JSON control (#221)", () => {
  // Ships the host humanizer via .toString() (not a hand-mirrored copy).
  assert.match(HOST_LOG_SCRIPT, /function humanizeHostLine/);
  // Every row renders through the shared .lv-row component from humanizeHostLine's parts — there
  // is no raw display mode and no per-view mode memory.
  assert.match(HOST_LOG_SCRIPT, /humanizedRow\(humanizeHostLine\(line\), document\)/);
  assert.match(HOST_LOG_SCRIPT, /function humanizedRow/);
  // The multiline-collapse split (#217) ships alongside, since humanizedRow calls it client-side.
  assert.match(HOST_LOG_SCRIPT, /function splitOverflow/);
  // #221: no Humanized/Raw toggle and no remembered mode.
  assert.doesNotMatch(HOST_LOG_SCRIPT, /data-host-log-mode/);
  assert.doesNotMatch(HOST_LOG_SCRIPT, /host-log-mode/);
  // Download JSON stays — the currently-filtered raw NDJSON as a .jsonl blob.
  assert.match(HOST_LOG_SCRIPT, /data-host-log-save/);
  assert.match(HOST_LOG_SCRIPT, /new Blob\(/);
  assert.match(HOST_LOG_SCRIPT, /\.jsonl/);
});

test("HOST_LOG_SCRIPT wires the Festive Wave Names toggle to the cookie + reload (#193)", () => {
  // The toggle reflects the current cookie on load, so its state persists across reloads.
  assert.match(HOST_LOG_SCRIPT, /data-festive-toggle/);
  assert.match(HOST_LOG_SCRIPT, /festiveWaveNames=1/);
  // Flipping it sets the festiveWaveNames cookie (=1 on / =0 off) and reloads so the
  // server re-renders the labels — a pure-client localStorage flip can't move a
  // server-rendered string.
  assert.match(HOST_LOG_SCRIPT, /document\.cookie = /);
  assert.match(HOST_LOG_SCRIPT, /location\.reload\(\)/);
});
