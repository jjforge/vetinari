// Tests for the dashboard assets — the shared palette, the state/counter colour
// derivations, and the CSS/script constants (dashboard-assets.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_PALETTE_CSS, stateColor, stateBorderColor, counterColor, TOP_BAR_STYLES, ISSUE_DETAIL_SHEET_STYLES, ISSUE_DETAIL_SHEET_SCRIPT, HOST_LOG_STYLES, HOST_LOG_SCRIPT, LIVE_TAIL_STYLES, REDRIVE_SCRIPT, GRAFT_SCRIPT } from "./dashboard-assets.ts";
import type { GraftRejection } from "./plan.ts";
import { cappedRawRows, isNotableHostEvent, renderLandingShell } from "./status.ts";

test("graftVerdicts maps every graft rejection reason — no key renders undefined (#374)", () => {
  // The reason map lives in browser JS, where an unmapped key renders `undefined` to
  // the operator. This list is typed as the whole `GraftRejection` union, so adding a
  // reason without a rendering fails to compile here rather than shipping `undefined`.
  const reasons: GraftRejection["reason"][] = [
    "malformed",
    "unknown",
    "closed",
    "already-in-campaign",
  ];
  const map = GRAFT_SCRIPT.match(/const reason = \{[^}]*\}/)?.[0] ?? "";
  for (const r of reasons)
    assert.ok(map.includes(r), `graftVerdicts must map the "${r}" reason`);
  // The internal token names what is true of the input; the rendering says what the
  // operator must do.
  assert.match(map, /malformed: "not an issue id"/);
});

test("the card/chip colour rules are landed as a normative doc that pins the palette (#83)", () => {
  // The colour rules live as appendix A of the design doc (#304 folded the standalone
  // dashboard-color-rules.md into it): the palette, the edge rule and the precedence.
  const doc = readFileSync(
    join(import.meta.dirname, "..", "docs", "design.md"),
    "utf8",
  );
  // The appendix is the reference: it carries the palette at the exact hexes the code uses.
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
    assert.ok(doc.includes(hex), `the design appendix pins ${hex}`);
  }
  // And it states the roll-up precedence (§2.4's `failed > parked` order — the risky
  // action red never means a state) and the teal-is-not-a-state rule.
  assert.match(doc, /failed > parked > running > completed > unstarted/);
  assert.match(doc, /never a state/);
  // The action colour is named after the property (risk), not one verb: the palette row is
  // `risky action`, generalised from prune to every risky control (redrive too) (#328).
  assert.match(doc, /risky action/);
  assert.doesNotMatch(doc, /prune action/);
  // The membership rule that decides who wears it: discards-or-re-runs is risky, additive is
  // the plain accent (so graft stays teal).
  assert.match(doc, /discards or re-runs work/);
});

test("the dashboard palette is one shared source defining every state token at its spec hex (#83)", () => {
  // §1: the six ADR-0007 states plus the risky action, each at its exact hex.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-blue: #6cb6ff/); // running
  assert.match(DASHBOARD_PALETTE_CSS, /--color-yellow: #c8a24e/); // parked
  assert.match(DASHBOARD_PALETTE_CSS, /--color-failure: #f85149/); // failure — distinct red
  assert.match(DASHBOARD_PALETTE_CSS, /--color-dim: #5f6b78/); // unstarted / idle grey
  assert.match(DASHBOARD_PALETTE_CSS, /--color-green: #3fb984/); // completed
  assert.match(DASHBOARD_PALETTE_CSS, /--color-pruned: #a371f7/); // pruned
  assert.match(DASHBOARD_PALETTE_CSS, /--color-red: #f79287/); // risky action — a control, never a state
  // The risky action and the failure state are deliberately different reds.
  assert.notEqual("#f85149", "#f79287");
  // The teal product accent is present but is not a state colour.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-primary: #3fb9b0/);
});

test("no dashboard surface hand-authors a colour hex — every hex ties back to the one shared palette (Appendix A, #317)", () => {
  // Colour is always derived from the palette, never authored per element: the shared
  // `:root` palette is the sole home of raw hex, so every 6-digit hex in any dashboard
  // source must be one the palette defines. A page that hand-authors its own colour
  // (the old aggregated prune/graft pages) fails here.
  const hexes = (s: string) => s.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  const authorized = new Set(hexes(DASHBOARD_PALETTE_CSS));
  const srcDir = import.meta.dirname;
  const files = readdirSync(srcDir).filter((f) => f.startsWith("dashboard-") && f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 5, "found the dashboard source files to scan");
  for (const file of files) {
    for (const hex of hexes(readFileSync(join(srcDir, file), "utf8"))) {
      assert.ok(authorized.has(hex), `${file} authors ${hex}, a colour outside the shared palette (Appendix A)`);
    }
  }
});

test("only the running dot and the live indicator animate — nothing else pulses (design §11, Appendix A, #317)", () => {
  // §11: "Nothing animates except the running dot and the live indicator." The colour-bearing
  // animation is `chip-pulse`; it may ride exactly two selectors — the running dot (work in
  // flight) and the live indicator (the stream) — so a third pulsing element (the live-tail /
  // feed stream dot) is a violation. Scan every dashboard source for `animation: chip-pulse`.
  const srcDir = import.meta.dirname;
  const files = readdirSync(srcDir).filter((f) => f.startsWith("dashboard-") && f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const pulsing: string[] = [];
  for (const file of files) {
    const src = readFileSync(join(srcDir, file), "utf8");
    // The selector immediately before each non-`none` chip-pulse declaration.
    for (const m of src.matchAll(/((?:[.#][\w-]+)+(?:\[[^\]]*\])?(?:::[\w-]+)?) \{[^}]*animation: chip-pulse/g)) pulsing.push(m[1]);
  }
  assert.deepEqual(new Set(pulsing), new Set([".dot.running", ".live-indicator::before"]));
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
      ["running", "parked", "failed", "completed", "unstarted"]
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

test("the sheet's Prune wears the risky-action coral while Reply keeps the plain accent (#328)", () => {
  // Prune discards work, so it is a risky action (Appendix A): its enabled button reads the
  // risky-action coral over the shared sheet-btn teal. Reply is additive, so it keeps the plain
  // teal accent — the shared .sheet-btn base — with no coral override.
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.sheet-btn \{[^}]*background: var\(--color-primary\)/);
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.prune-start \{[^}]*background: var\(--color-red\)/);
  // The confirm button stays the coral it already acts (unchanged).
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.prune-confirm-btn[^{]*\{[^}]*var\(--color-red\)/);
});

test("the issue sheet prints the park reason as a word beside the state, single-sourcing reasonWord (#317)", () => {
  // The sheet single-sources the one `reasonWord` mapping into the browser via .toString()
  // and prints it beside the state, so a parked{red-base} sheet reads "parked · red base"
  // rather than the raw enum — the same word the status line and the parked card spell.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /function reasonWord/);
  // A non-running issue still reads its state word (+ reason); the phase only replaces it for
  // a running one (asserted separately below).
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /detailStatusLabel\.textContent = phase \? phase\.label : d\.status \+ \(d\.reason \? " · " \+ reasonWord\(d\.reason\) : ""\)/,
  );
});

test("the issue sheet shows a live running issue's phase in place of the word, controlling the pulse (#359)", () => {
  // A running issue's phase replaces the state word; a steady phase stills the dot via the
  // shared `.dot.running.idle` rule (no new colour). An archived (read-only) sheet shows none.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /const phase = d\.status === "running" && !d\.archived \? d\.phase : null/,
  );
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /detailStatusDot\.className = "dot " \+ d\.status \+ \(phase && phase\.steady \? " idle" : ""\)/,
  );
});

test("stateColor is the single state→colour derivation, failure distinct from the risky action (#83)", () => {
  // §3: every state derives its colour here, never a per-instance hex.
  assert.equal(stateColor("running"), "var(--color-blue)");
  assert.equal(stateColor("parked"), "var(--color-yellow)");
  assert.equal(stateColor("completed"), "var(--color-green)");
  assert.equal(stateColor("pruned"), "var(--color-pruned)");
  // unstarted (and its landing display aliases) are the dim grey, not the muted one.
  assert.equal(stateColor("unstarted"), "var(--color-dim)");
  assert.equal(stateColor("queued"), "var(--color-dim)");
  assert.equal(stateColor("idle"), "var(--color-dim)");
  // failure has its own token, distinct from the risky action's --color-red (§1).
  assert.equal(stateColor("failure"), "var(--color-failure)");
  assert.notEqual(stateColor("failure"), "var(--color-red)");
});

test("stateBorderColor is the single derivation for the muted 40%-alpha chip borders (§4, #83)", () => {
  // §4: a wave-member row borders its lifecycle at 40% alpha — the same token as stateColor,
  // suffixed `-40`. The retired held/interrupted overlays are gone (ADR 0019); pruned
  // keeps its own token as a membership badge colour.
  assert.equal(stateBorderColor("running"), "var(--color-blue-40)");
  assert.equal(stateBorderColor("parked"), "var(--color-yellow-40)");
  assert.equal(stateBorderColor("failure"), "var(--color-failure-40)");
  assert.equal(stateBorderColor("completed"), "var(--color-green-40)");
  assert.equal(stateBorderColor("pruned"), "var(--color-pruned-40)");
  assert.equal(stateBorderColor("unstarted"), "var(--color-dim-40)");
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

test("under 640px the shared .tail-head drops the .tail-summary so the title stays one line and the filter isn't clipped (#336)", () => {
  // Option (c): the summary ("2 agents") duplicates the agent dropdown, so on a phone we hide it
  // to reclaim the row's width — pinned alongside the three existing 640px rules. CSS-only; every
  // pane sharing .tail-head (live tail, archived runs, landing event-log feed) inherits it.
  assert.match(
    LIVE_TAIL_STYLES,
    /@media \(max-width: 640px\) \{ \.tail-summary \{ display: none; \} \}/,
  );
});

test("REDRIVE_SCRIPT opens the confirm dialog on click and closes it on Cancel — only enabled, no double-bind (#325)", () => {
  // The greyed-until-safe Redrive control (design §11): enabled, its button opens the native
  // <dialog> (Cancel the default); Cancel closes without POSTing. It is a no-op when disabled.
  assert.match(REDRIVE_SCRIPT, /function wireRedrive\(\)/);
  // Only wires an enabled control — a disabled button (no dialog) is left inert.
  assert.match(REDRIVE_SCRIPT, /open\.disabled/);
  // Opening shows the modal dialog; only Confirm (a submit in the /redrive form) sends it.
  assert.match(REDRIVE_SCRIPT, /open\.addEventListener\("click", \(\) => \{ if \(typeof dialog\.showModal === "function"\) dialog\.showModal\(\); \}\)/);
  // Cancel closes the dialog (no POST); Escape/backdrop close it natively.
  assert.match(REDRIVE_SCRIPT, /cancel\.addEventListener\("click", \(\) => dialog\.close\(\)\)/);
  // Guarded against a re-bind so re-running over the same node (a soft-refresh) adds no second listener.
  assert.match(REDRIVE_SCRIPT, /open\.dataset\.redriveWired/);
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

test("HOST_LOG_SCRIPT heals the buffer on the connect ring: re-fetch + replace, once per connection (#352)", () => {
  // #331's ring is the only unnamed frame (project === null); named append frames never fire
  // "message", so the pane binds its own listener beside the "host" one — neither renderer changes.
  assert.match(HOST_LOG_SCRIPT, /events\.addEventListener\("message"/);
  // The connect handler guards on the ring's project === null and re-reads the window, replacing
  // the buffer so lines written while the stream was down (or between render and connect) heal in.
  assert.match(HOST_LOG_SCRIPT, /m\.project === null/);
  // The heal goes through the existing no-daemon /api/host-log read — no new frame type, no dedupe.
  assert.match(HOST_LOG_SCRIPT, /const backfill = \(replace\) =>/);
  assert.match(HOST_LOG_SCRIPT, /backfill\(true\)/); // connect: replace the buffer
  assert.match(HOST_LOG_SCRIPT, /backfill\(false\)/); // wiring-time: append behind live rows
  // On replace the buffer is swapped, not concatenated (a concat would double a legitimately
  // repeated line); on the wiring path the fetched rows stay behind any racing live frame.
  assert.match(HOST_LOG_SCRIPT, /lines = replace \? win : lines\.concat\(win\)/);
  // A generation token means the newest backfill wins if a connect ring races the wiring fetch on
  // a fresh load, so the load never double-counts the window.
  assert.match(HOST_LOG_SCRIPT, /if \(gen !== backfillGen\) return;/);
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

test("openIssue clears the reply draft only when the sheet binds a different issue, so one issue's text can't post as another's answer (#349)", () => {
  // The sheet reuses one static #reply-text box for every issue. Binding a new issue
  // rebinds the hidden taskId, so a stale draft would post to the wrong issue — the box
  // must empty on an actual issue switch. The bound issue is keyed by project + number.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /const issueKey = project \+ "#" \+ issue/);
  // The clear is conditional on the key changing — closing and reopening the SAME issue
  // keeps the draft; only a switch to a different issue empties the box.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /if \(boundIssueKey !== issueKey\) replyText\.value = ""/,
  );
  // closeSheet stays a pure dismiss (class + hidden) — clearing there would drop a draft
  // when the operator closes to check something and reopens the same issue.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /const closeSheet = \(\) => \{ issueDetail\.classList\.remove\("show"\); issueDetail\.hidden = true; \};/,
  );
});
