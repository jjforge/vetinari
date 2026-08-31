// Tests for the dashboard's shared presentation primitives — the escaping, top bar,
// host-log and pure log/tail view-model reducers in dashboard-render.ts, plus the
// cross-surface invariants both pages must hold (via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DASHBOARD_PALETTE_CSS, stateColor, stateBorderColor, STATE_DOT_CSS, STATE_CHIP_BORDER_CSS, TOP_BAR_STYLES, ISSUE_DETAIL_SHEET_STYLES, REPO_DROPDOWN_SCRIPT, HOST_LOG_STYLES } from "./dashboard-assets.ts";
import { archiveRowMatches, archiveRunHref, cappedRawRows, event, formatStatusText, highlightJsonLine, isNotableHostEvent, renderHostLog, renderLandingShell, renderStatusPage, renderTopBar, tailFresh } from "./status.ts";

// The set of palette tokens defined by a `:root { … }` block, and the set of
// `var(--token)` references anywhere in a page — the two must agree, or a surface
// references a colour that never resolves (the #78 class of bug).
const definedTokens = (css: string) =>
  new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));

const referencedTokens = (html: string) =>
  new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

// A running-wave campaign page with one issue chip and a parked card — enough
// surface to assert the §4/§6 chip and card rules against.
const chipCampaign = () =>
  renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "1", status: "running" }],
        },
      ],
      parked: [
        {
          issueNumber: "2",
          reason: "question",
          parkedAt: "2025-06-15T09:00:00.000Z",
          branch: "agent/2",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { prune: true },
  );

test("both the landing and the campaign page emit the one shared palette, and every colour they reference resolves (#78, #83)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { prune: true },
  );
  // The palette is included verbatim by both surfaces — one source, not a per-renderer copy.
  assert.ok(
    landing.includes(DASHBOARD_PALETTE_CSS),
    "landing includes the shared palette",
  );
  assert.ok(
    campaign.includes(DASHBOARD_PALETTE_CSS),
    "campaign page includes the shared palette",
  );
  // Every colour token either page references is actually defined — so `--color-pruned`
  // (and every other token) resolves identically on `/` and `/?project=…`, not merely
  // referenced (the blind spot #78's original rule-string test had).
  const defined = definedTokens(DASHBOARD_PALETTE_CSS);
  for (const page of [landing, campaign]) {
    for (const token of referencedTokens(page)) {
      assert.ok(
        defined.has(token),
        `${token} is referenced but never defined in the shared palette`,
      );
    }
  }
  // The concrete #78 repro: pruned is referenced on the campaign page (the pruned membership
  // badge + the wave-pruned tally, ADR 0019) and resolves.
  assert.ok(
    referencedTokens(campaign).has("--color-pruned"),
    "campaign references --color-pruned",
  );
  assert.ok(defined.has("--color-pruned"), "--color-pruned resolves");
});
test("cards fill card-grey and chips fill the darker panel with a 40%-alpha state border (§4, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = chipCampaign();
  // The two fills are distinct: cards #10151b, chips the darker #0b0e12 (chips sit on cards).
  assert.match(DASHBOARD_PALETTE_CSS, /--color-card: #10151b/);
  assert.match(DASHBOARD_PALETTE_CSS, /--color-chip: #0b0e12/);
  // Landing project cards and campaign wave cards take the card fill.
  assert.match(landing, /\.card \{[^}]*background: var\(--color-card\)/);
  assert.match(campaign, /\.wave \{[^}]*background: var\(--color-card\)/);
  // The state pill and closed-wave chip take the darker panel fill — never a coloured fill (§4).
  assert.match(
    campaign,
    /\.wave-status, \.completed-wave-chip \{[^}]*background: var\(--color-chip\)/,
  );
  // A member row carries its status class and borders that status at 40% alpha (§4). The
  // border colour for each state is `stateBorderColor` (asserted by value there); one structural
  // check confirms the campaign page splices the shared STATE_CHIP_BORDER_CSS that reducer builds.
  assert.match(campaign, /class="wave-member running"/);
  assert.ok(
    campaign.includes(STATE_CHIP_BORDER_CSS),
    "campaign splices the shared wave-member border rules",
  );
  assert.ok(
    STATE_CHIP_BORDER_CSS.includes(
      ["running", "parked", "failed", "completed", "unstarted"]
        .map((s) => `.wave-member.${s} { border-color: ${stateBorderColor(s)}; }`)
        .join(" "),
    ),
    "the shared border rules are generated from stateBorderColor",
  );
});
test("cards and chips lift only their fill on hover, never recolouring their edge; teal never colours an edge (§6, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = chipCampaign();
  // Card / member row / parked-row hover lifts the fill only — the coloured edge is unchanged.
  assert.match(
    landing,
    /\.card:hover \{ background: var\(--color-card-hover\); \}/,
  );
  assert.match(
    campaign,
    /\.wave-member:hover[^{]*\{ background: var\(--color-chip-hover\); \}/,
  );
  assert.match(
    landing,
    /\.parked-row:hover \{ background: var\(--color-card-hover\); \}/,
  );
  assert.match(
    campaign,
    /\.parked-card:hover \{ background: var\(--color-card-hover\); \}/,
  );
  // No card/row hover recolours a border — the accent must not creep onto an edge.
  assert.doesNotMatch(landing, /\.card:hover \{[^}]*border-color/);
  assert.doesNotMatch(campaign, /\.wave-member:hover[^}]*border-color/);
  assert.doesNotMatch(landing, /\.parked-row:hover[^}]*border-color/);
  // §2: a card carries state colour on exactly one edge — never a coloured bottom or right.
  for (const page of [landing, campaign]) {
    assert.doesNotMatch(
      page,
      /border-(bottom|right)-color: var\(--color-(blue|yellow|green|failure|pruned|dim)\)/,
    );
  }
});
test("motion is a running/stream channel only: green live dots always pulse while live (§5, #100)", () => {
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ]) {
    // The green live dots pulse whenever live — they track the stream, so there is no
    // per-element running-gate or live-state rule on the live-indicator any more.
    assert.match(html, /\.live-indicator::before \{[^}]*animation: chip-pulse/);
    assert.doesNotMatch(html, /data-running/);
    assert.doesNotMatch(html, /\.live-indicator\[data-live-state="paused"\]/);
    assert.doesNotMatch(html, /\.live-bar:not\(\[data-running/);
    // With the page-level pause gone (#210), nothing freezes the pulse per-page: there is
    // no root [data-paused] flag and the live dots pulse for as long as the page is open.
    assert.doesNotMatch(html, /\[data-paused="true"\]/);
    // The only colour-bearing animation anywhere is chip-pulse — nothing else animates (§5).
    assert.deepEqual(
      [...new Set([...html.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]))],
      ["chip-pulse"],
    );
  }
});
test("both pages share one set of status-dot rules, scoped to .dot so a state never tints a whole card or row (#81, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "1", status: "unstarted", membership: "pruned" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // The dot rules are one generated source, included verbatim by both surfaces.
  assert.ok(
    landing.includes(STATE_DOT_CSS),
    "landing includes the shared dot rules",
  );
  assert.ok(
    campaign.includes(STATE_DOT_CSS),
    "campaign page includes the shared dot rules",
  );
  // Every lifecycle colour is scoped to `.dot`, and each dot's colour is `stateColor` (asserted
  // by value there): the shared rules are generated from it, so one check proves the wiring for
  // the whole family. The dot reads the lifecycle only (ADR 0019) — the retired held/
  // interrupted overlays are gone, and pruned is a membership badge, not a dot state.
  assert.ok(
    STATE_DOT_CSS.includes(
      ["running", "parked", "failed", "completed", "unstarted", "queued"]
        .map((s) => `.dot.${s} { background: ${stateColor(s)}; }`)
        .join(" "),
    ),
    "the shared dot rules are generated from stateColor",
  );
  // The campaign page no longer emits the bare `.completed {…}` / `.pruned {…}` rules that
  // leaked colour onto struck-through list rows and other elements sharing the class name (#81).
  // A bare status-class rule sits at a selector boundary (start of a line, after
  // whitespace) — the shared dot rules are all `.dot.<state>`, never bare. So none of
  // these leak-prone bare rules should appear on the campaign page any more.
  assert.doesNotMatch(campaign, /\n\s*\.pruned \{ background/);
  assert.doesNotMatch(campaign, /\n\s*\.completed \{ background/);
  assert.doesNotMatch(campaign, /\n\s*\.parked \{ background/);
});
test("failure renders in its own red on every surface, never the risky action's red (#83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { prune: true },
  );
  // The failed state derives --color-failure from stateColor, distinct from the risky action's own
  // --color-red (the value distinction is asserted in the stateColor test). Here we confirm each
  // surface splices that failed colour in — the feed dot (the log-view's `failure` dot-state), the
  // card edge, the run-state pill, and the turn number — never re-pinning the token.
  const failed = stateColor("failed");
  assert.notEqual(failed, "var(--color-red)");
  assert.ok(landing.includes(`.lv-dot.failure { background: ${stateColor("failure")}; }`));
  assert.ok(landing.includes(`.card.failed { border-top-color: ${failed}; }`));
  assert.ok(
    landing.includes(`.run-state.failed { border-color: ${failed}; color: ${failed}; }`),
  );
  assert.ok(
    ISSUE_DETAIL_SHEET_STYLES.includes(`.turn-num.failed { color: ${failed}; }`),
  );
  // The prune confirm/cancel keep --color-red — a control's own red, never the failure state.
  // (Prune is a risky action, so its enabled button wears the risky-action coral too, #328; the
  // red here marks the destructive confirm step.)
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.prune-confirm-btn[^{]*\{[^}]*var\(--color-red\)/,
  );
  assert.ok(campaign.includes(`.turn-num.failed { color: ${failed}; }`));
});
test("renderHostLog renders a gear entry point, a hidden badge, and a hidden host-log pane with a filter (#180)", () => {
  const html = renderHostLog();
  // A gear button is the entry point, collapsed by default.
  assert.match(html, /data-host-log-gear[^>]*aria-expanded="false"/);
  // Its attention badge starts hidden — a routine-only log shows no badge.
  assert.match(html, /data-host-log-badge[^>]*hidden/);
  // The pane itself is hidden until the gear is clicked (not an always-visible section).
  assert.match(html, /data-host-log-panel[^>]*hidden/);
  // The one control is a substring filter over the raw lines.
  assert.match(html, /data-host-log-filter/);
  // A lines container the client fills from /api/host-log and the SSE host frames.
  assert.match(html, /data-host-log-lines/);
  // The gear also carries the "Festive Wave Names" settings toggle (#193): an
  // unchecked-by-default checkbox the client syncs to the festiveWaveNames cookie.
  assert.match(html, /data-festive-toggle/);
  assert.match(html, /Festive [Ww]ave [Nn]ames/);
});
test("renderHostLog seats the filter input and Download JSON on one control row (#233)", () => {
  const html = renderHostLog();
  // The filter now lives inside the .host-log-controls flex row, ahead of the
  // Download JSON button — the two share a single line instead of stacking.
  assert.match(
    html,
    /<div class="host-log-controls"><input type="text" class="host-log-filter" data-host-log-filter[^>]*\/><button type="button" class="lv-ico" data-host-log-save/,
  );
  // The redundant spacer span that used to push the lone button right is gone —
  // the flexing filter now fills the row.
  assert.doesNotMatch(html, /host-log-controls"><span class="host-log-gap"/);
  // The filter flexes to fill the row and drops its own block margin, leaving
  // the single gutter that .host-log-controls' top margin provides.
  const filterRule = HOST_LOG_STYLES.match(/\.host-log-filter \{[^}]*\}/);
  assert.ok(filterRule, "HOST_LOG_STYLES carries a .host-log-filter rule");
  assert.match(filterRule[0], /flex: 1/);
  assert.doesNotMatch(filterRule[0], /margin/);
});
test("renderHostLog is humanized-only: no Humanized/Raw toggle, keeps a Download JSON control (#221)", () => {
  const html = renderHostLog();
  // #221: the host-log pane always renders humanized — the Humanized/Raw toggle is gone entirely.
  assert.doesNotMatch(html, /data-host-log-mode/);
  assert.doesNotMatch(html, />Humanized</);
  assert.doesNotMatch(html, />Raw</);
  // Download JSON stays and still emits the raw NDJSON, mirroring the live tail's ⤓ .lv-ico icon.
  assert.match(html, /class="lv-ico" data-host-log-save[^>]*aria-label="Download JSON"[^>]*>⤓</);
});
test("renderLandingShell seats the host-log gear at the end of the top-right live-bar, after the readout (#201)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The gear rides the end of the live-bar, immediately after the "last activity Ns ago" readout:
  // the bar reads live dot → "last activity Ns ago" → gear. Its pane travels with it (popover).
  assert.match(
    html,
    /<span class="updated" data-updated>[^<]*<\/span><section class="host-log" data-host-log>/,
  );
  // The gear no longer floats as a detached section under the top bar — the host-log
  // opens only from within the live-bar.
  assert.doesNotMatch(html, /<\/div>\s*<section class="host-log"/);
  // The gear now rides the campaign page's live-bar too, in the very same seat — after the
  // "last activity Ns ago" readout — so settings are one click away on every page (#215).
  const campaign = renderStatusPage({ project: "demo", waves: [], parked: [] });
  assert.match(
    campaign,
    /<span class="updated" data-updated>[^<]*<\/span><section class="host-log" data-host-log>/,
  );
});
test("the settings gear rides the live-bar header on both the landing and the campaign page (#215)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage({ project: "demo", waves: [], parked: [] });
  // One shared header component on both pages: the gear, its pane, and the pane's full
  // contents — the host-log options and the Festive Wave Names toggle — reachable from either.
  for (const [label, html] of [
    ["landing", landing],
    ["campaign", campaign],
  ] as const) {
    assert.match(html, /data-host-log-gear/, label + " seats the settings gear");
    assert.match(html, /data-host-log-panel/, label + " carries the settings pane");
    assert.match(html, /data-festive-toggle/, label + " carries the festive toggle");
    // The pane's client wiring fills its rows from the shared host-log endpoint.
    assert.match(html, /\/api\/host-log/, label + " wires the host-log endpoint");
  }
});
test("archiveRowMatches filters an archived-run row case-insensitively over its visible summary text (#256)", () => {
  const text = "Feb 1, 2026 · 22:22:36 comms + dashboard complete · 3 issues";
  // An empty / whitespace query matches everything (the filter is cleared) —
  // the same contract as the feed/host-log filter.
  assert.equal(archiveRowMatches(text, ""), true);
  assert.equal(archiveRowMatches(text, "   "), true);
  // The run name matches, case-insensitively…
  assert.equal(archiveRowMatches(text, "DASHBOARD"), true);
  // …as does the disposition.
  assert.equal(archiveRowMatches(text, "complete"), true);
  // A miss on the row's visible text hides the row.
  assert.equal(archiveRowMatches(text, "interrupted"), false);
});
test("archiveRunHref carries the open run as a deep link, and clears run= when none is open (#333)", () => {
  // An open run is written into the URL — this is the deep link the server honours so a
  // reload or share opens that run.
  assert.equal(
    archiveRunHref("vetinari", "2026-08-30T06-57-20-736Z", ""),
    "?project=vetinari&run=2026-08-30T06-57-20-736Z",
  );
  // No open run (a null/empty run) yields the bare project URL — closing the open row clears
  // run= so a reload renders the list collapsed.
  assert.equal(archiveRunHref("vetinari", null, ""), "?project=vetinari");
  assert.equal(archiveRunHref("vetinari", "", ""), "?project=vetinari");
  // The location hash survives both the open and the close rewrite.
  assert.equal(
    archiveRunHref("vetinari", "2026-08-30T06-57-20-736Z", "#waves"),
    "?project=vetinari&run=2026-08-30T06-57-20-736Z#waves",
  );
  assert.equal(archiveRunHref("vetinari", null, "#waves"), "?project=vetinari#waves");
  // The project and run are URL-encoded.
  assert.equal(
    archiveRunHref("a b", "r/1", ""),
    "?project=a%20b&run=r%2F1",
  );
});
test("no status/category word is ever a bare top-level CSS class, so a component base can't inherit a modifier's layout (#91)", () => {
  // The convention (ADR 0007's status vocabulary): a status word (ADR 0007's
  // running/parked/failure/completed/unstarted/pruned, plus the landing's queued/idle
  // aliases and a wave's closed) and a comms category (success/attention/progress) only
  // ever appear *scoped* — `.dot.running`, `.card.parked`, `.lv-dot.failure` — never as a
  // bare `.running {`/`.progress {` rule. A bare one is a component base (the `.progress`
  // bar, #85) that any element carrying the same word as a modifier would then inherit.
  const words = [
    "running",
    "parked",
    "failure",
    "completed",
    "unstarted",
    "pruned",
    "queued",
    "idle",
    "closed",
    "success",
    "attention",
    "progress",
  ];
  const pages = {
    landing: renderLandingShell(["alpha"]),
    campaign: renderStatusPage(
      {
        project: "beta",
        waves: [
          {
            index: 0,
            status: "running",
            issues: [{ issueNumber: "1", status: "unstarted", membership: "pruned" }],
          },
        ],
        parked: [],
      },
      { prune: true },
    ),
  };
  for (const [name, html] of Object.entries(pages)) {
    for (const word of words) {
      // A bare rule is `.word {` at a selector boundary — not preceded by a word char or
      // hyphen, so scoped compounds (`.dot.running`, `.progress-fill.running`) don't match.
      assert.doesNotMatch(
        html,
        new RegExp(String.raw`(?<![-\w])\.${word}\s*\{`),
        `${name} emits a bare .${word} { rule — scope it (.dot/.feed-kind/component-prefix)`,
      );
    }
  }
});
test("the updated readout ages 'last activity Ns ago' from the last activity, on both pages (§5, #210, #337)", () => {
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ]) {
    // The "last activity Ns ago" readout is `freezeIntent`'s `updatedText` (dashboard-visual-state.ts,
    // asserted directly there: live⇒"last activity Ns ago", null⇒"—"),
    // single-sourced into both pages and written onto the readout. With the page-level pause
    // gone (#210) there is no "Paused" branch — the clock always ages.
    assert.match(html, /function freezeIntent/);
    assert.match(
      html,
      /updatedEl\.textContent = freezeIntent\(\{ lastUpdate, now: Date\.now\(\) \}\)\.updatedText/,
    );
    // No page-level pause machinery survives (#210): no pause button, no paused state.
    assert.doesNotMatch(html, /id="pause"/);
    assert.doesNotMatch(html, /let paused/);
  }
});
test("both pages wire the repo dropdown's keyboard, scope-switch, and scoped click-outside behavior (#88)", () => {
  const landing = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
  ]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      projects: [
        { project: "alpha", runState: "idle" },
        { project: "beta", runState: "running" },
      ],
      selected: "beta",
    },
  );
  // One shared script, emitted by both pages so they can't drift.
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(REPO_DROPDOWN_SCRIPT),
      "every page includes the shared repo-dropdown script",
    );

  const js = REPO_DROPDOWN_SCRIPT;
  // Trigger toggles the menu (aria-expanded + hidden).
  assert.match(
    js,
    /repoTrigger\.addEventListener\("click", \(\) => \(repoIsOpen\(\) \? repoClose\(\) : repoOpen\(\)\)\)/,
  );
  assert.match(
    js,
    /setAttribute\("aria-expanded", "true"\); repoMenu\.hidden = false;/,
  );
  // Choosing a different scope navigates (the switch); the current scope is a no-op that just closes.
  assert.match(
    js,
    /if \(option\.getAttribute\("aria-selected"\) === "true"\) \{ repoClose\(\); return; \}/,
  );
  assert.match(
    js,
    /location\.href = project \? "\/\?project=" \+ encodeURIComponent\(project\) : "\/";/,
  );
  // Keyboard: Enter/Space/↑↓ open+move, Enter selects, Escape closes and restores focus to the trigger, Tab is trapped.
  assert.match(js, /event\.key === "Escape".*repoClose\(\);/);
  assert.match(js, /event\.key === "ArrowDown".*repoFocus\(repoActive \+ 1\)/);
  assert.match(js, /event\.key === "ArrowUp".*repoFocus\(repoActive - 1\)/);
  assert.match(
    js,
    /event\.key === "Tab".*repoFocus\(repoActive \+ \(event\.shiftKey \? -1 : 1\)\)/,
  );
  assert.match(js, /if \(restore !== false\) repoTrigger\.focus\(\);/);
  // Click-outside closes, scoped to the dropdown's own subtree — not "any non-button".
  assert.match(
    js,
    /if \(repoIsOpen\(\) && !repoRoot\.contains\(event\.target\)\) repoClose\(false\);/,
  );
});
test("formatStatusText summarizes waves, issue chips (with names), and the parked section", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [
          {
            issueNumber: "436",
            status: "completed",
            name: "Fix login redirect",
          },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "640", status: "running", name: "Add prune-out" },
          { issueNumber: "655", status: "parked" },
        ],
      },
    ],
    parked: [
      {
        issueNumber: "655",
        reason: "question",
        parkedAt: "now",
        branch: "agent/655",
        description: "?",
        options: [],
      },
    ],
  });

  assert.match(text, /jjforge — status/);
  assert.match(text, /Wave 1\/2 ✅ completed/);
  assert.match(text, /✅ #436 Fix login redirect/);
  assert.match(text, /Wave 2\/2 ▶️ running/);
  assert.match(text, /🔄 #640 Add prune-out/);
  // No name available → chip is just the status + number.
  assert.match(text, /⏸ #655$/m);
  assert.match(text, /1 awaiting your reply/);
  assert.match(text, /#655 — question/);
});
test("formatStatusText labels a held wave and its merge-conflict-held issue as parked (ADR 0019)", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "parked",
        issues: [
          { issueNumber: "611", status: "completed", name: "Fix parser" },
          { issueNumber: "640", status: "parked", reason: "conflict", name: "Add prune-out" },
        ],
      },
    ],
    parked: [],
  });

  // The held wave reads the one `parked` word at every level (ADR 0019) — the specific
  // reason lives in the detail, not a distinct wave word.
  assert.match(text, /Wave 1\/1 ⏸ parked/);
  // The merge-conflict-held issue reads the parked emoji + word, no retired status word.
  assert.match(text, /⏸ #640 Add prune-out/);
});
test("formatStatusText reports when nothing is running", () => {
  const text = formatStatusText({ project: "demo", waves: [], parked: [] });
  assert.match(text, /demo — status/);
  assert.match(text, /No active run/);
});
test("formatStatusText omits the parked section when nothing is parked", () => {
  const text = formatStatusText({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "1", status: "running" }],
      },
    ],
    parked: [],
  });
  assert.doesNotMatch(text, /awaiting your reply/);
});
test("both pages render one shared top-bar control: a dot-only live indicator, no pause (#81, #210)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { projects: ["alpha", "beta"], selected: "beta" },
  );

  // The live-bar's controls are one shared definition, emitted verbatim by every page so
  // the two can no longer drift (the "Live"-word vs LIVE divergence). The host view seats
  // its settings gear at the end of the bar (#201, renderTopBar's trailing slot), so the
  // shared, drift-proof span runs from the bar open through the readout; anything after it
  // is a per-page trailing control.
  const liveBarControls = renderTopBar("").match(
    /<div class="live-bar".*<span class="updated" data-updated>[^<]*<\/span>/s,
  )?.[0];
  assert.ok(liveBarControls, "renderTopBar emits the shared live-bar controls");
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(liveBarControls),
      "every page includes the shared live-bar controls",
    );

  // The indicator is a dot only — no visible "Live" word; its state is an accessible label
  // instead. The page-level pause is gone (#210), so no page renders a pause button.
  for (const page of [landing, campaign]) {
    assert.doesNotMatch(page, /<span class="live-indicator"[^>]*>Live<\/span>/);
    assert.doesNotMatch(page, /id="pause"/);
    assert.doesNotMatch(page, /class="pause"/);
    assert.match(
      page,
      /<span class="live-indicator" data-live-state="live" aria-label="Live"><\/span>/,
    );
  }

  // The pause icon CSS is gone with the button (#210): no `.pause` rules remain.
  assert.doesNotMatch(TOP_BAR_STYLES, /\.pause/);
  assert.doesNotMatch(TOP_BAR_STYLES, /data-paused/);
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(TOP_BAR_STYLES),
      "every page includes the shared top-bar styles",
    );
});
test("highlightJsonLine colours JSON keys, strings, numbers and literals distinctly, escaping content", () => {
  const html = highlightJsonLine(
    '{"event":"green","turn":3,"ok":true,"x":null}',
  );
  // A key (string followed by a colon) reads distinct from a plain string value;
  // the quote characters are HTML-escaped in the source.
  assert.match(html, /<span class="jkey">&quot;event&quot;<\/span>:/);
  assert.match(html, /<span class="jstr">&quot;green&quot;<\/span>/);
  assert.match(html, /<span class="jnum">3<\/span>/);
  assert.match(html, /<span class="jbool">true<\/span>/);
  assert.match(html, /<span class="jnull">null<\/span>/);
  // HTML inside string content is escaped, never injected as live markup.
  const esc = highlightJsonLine('{"t":"<b>&x</b>"}');
  assert.match(
    esc,
    /<span class="jstr">&quot;&lt;b&gt;&amp;x&lt;\/b&gt;&quot;<\/span>/,
  );
  assert.doesNotMatch(esc, /<b>/);
});
test("cappedRawRows caps the rendered rows and reports the hidden remainder, keeping 1-based line numbers", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `{"n":${i}}`);
  const { rows, total, hidden } = cappedRawRows(lines, "", 500, 0);
  assert.equal(rows.length, 500, "renders only the cap");
  assert.equal(total, 1200, "total counts every line");
  assert.equal(hidden, 700, "hidden is the un-rendered remainder");
  // Line numbers are the original 1-based indices, in order.
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].line, '{"n":0}');
  assert.equal(rows[499].n, 500);
});
test("cappedRawRows filters before the cap and lets expandedCount reveal more", () => {
  // Every 10th line matches "gate"; the rest don't.
  const lines = Array.from({ length: 1200 }, (_, i) =>
    i % 10 === 0 ? `{"event":"gate","i":${i}}` : `{"event":"turn","i":${i}}`,
  );
  // Filter narrows to 120 matches — fewer than the cap, so all show, nothing hidden.
  const filtered = cappedRawRows(lines, "gate", 500, 0);
  assert.equal(filtered.total, 120, "total is the filtered match count");
  assert.equal(filtered.rows.length, 120, "all matches render under the cap");
  assert.equal(filtered.hidden, 0);
  assert.equal(filtered.rows[0].n, 1, "first match keeps its original index");
  assert.equal(filtered.rows[1].n, 11);
  // Expanding raises the render count by the expanded amount.
  const expanded = cappedRawRows(lines, "", 500, 300);
  assert.equal(expanded.rows.length, 800, "cap + expandedCount rows render");
  assert.equal(expanded.hidden, 400);
});
test("isNotableHostEvent flags a fail/error kind or a row carrying error/ok:false, and passes routine rows", () => {
  // A kind matching /fail|error/i is notable — an SSE watch failure, a registry read error.
  assert.equal(isNotableHostEvent({ ts: "t", event: "dashboard-events-watch-failed" }), true);
  assert.equal(isNotableHostEvent({ ts: "t", event: "registry-read-error" }), true);
  // Case-insensitive on the kind.
  assert.equal(isNotableHostEvent({ ts: "t", event: "TelegramSendFailure" }), true);
  // A row carrying an `error` field is notable even when its kind reads routine.
  assert.equal(isNotableHostEvent({ ts: "t", event: "telegram-send", error: "429 Too Many Requests" }), true);
  // An `ok: false` field is notable; `ok: true` is not, on its own.
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", ok: false }), true);
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", ok: true }), false);
  // A routine host event with no error signal is not notable.
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", project: "acme" }), false);
});

// A tail row as `tailFresh` reads it — only `issue` and `n` matter to the dedup (#353).
const tln = (issue: string, n: number) => ({ issue, status: "running", ts: "", n, raw: `{"issue":"${issue}","n":${n}}` });

// #353: an issue's `activity-<issue>.jsonl` is recreated on redrive/prune-respawn/rollover, so its
// per-file index restarts at 0. The whole new stream then sits below the high-water mark; without a
// restart rule `tailFresh` filters it all as already-seen and the pane goes permanently silent.
test("tailFresh treats a restarted stream (max index below the mark) as new and re-bases the mark", () => {
  // Issue 1 has streamed up to n=5; the mark records it.
  const grown = tailFresh([tln("1", 4), tln("1", 5)], { "1": 3 });
  assert.deepEqual(grown.seen, { "1": 5 });
  // Its file is recreated and restarts at 0 — every line is below the mark of 5.
  const restarted = tailFresh([tln("1", 0), tln("1", 1), tln("1", 2)], grown.seen);
  assert.deepEqual(
    restarted.fresh.map((r) => [r.issue, r.n]),
    [["1", 0], ["1", 1], ["1", 2]],
    "the restarted stream's lines are delivered, not suppressed",
  );
  assert.deepEqual(restarted.seen, { "1": 2 }, "the mark is re-based on the new stream");
});

// Forward-only growth still dedupes: the restart rule keys off the snapshot's *max* index, so a
// growing file (max at or above the mark) is untouched (#353).
test("tailFresh still dedupes a growing file — only lines past the mark are fresh", () => {
  const res = tailFresh([tln("1", 3), tln("1", 4), tln("1", 5)], { "1": 4 });
  assert.deepEqual(res.fresh.map((r) => r.n), [5], "only the line past the mark is fresh");
  assert.deepEqual(res.seen, { "1": 5 });
});

// The sliding snapshot window (cap 500) re-sends old lines *below* the mark during normal growth;
// those must stay suppressed — a restart is the max index dropping, not any single low line (#353).
test("tailFresh re-sends a window below the mark without duplicating, and stays quiet with no new line", () => {
  // Window re-sends n=3..5 (all at/below the mark of 5) — nothing new, no rows delivered.
  const resent = tailFresh([tln("1", 3), tln("1", 4), tln("1", 5)], { "1": 5 });
  assert.deepEqual(resent.fresh, [], "a re-sent window below the mark produces no duplicate rows");
  assert.deepEqual(resent.seen, { "1": 5 }, "the mark is unchanged");
  // Same window plus one genuinely new line — only that line is fresh.
  const advanced = tailFresh([tln("1", 3), tln("1", 4), tln("1", 5), tln("1", 6)], { "1": 5 });
  assert.deepEqual(advanced.fresh.map((r) => r.n), [6]);
});

// Per-issue isolation: one issue restarting must not reset another issue's mark (#353).
test("tailFresh isolates a restart to its own issue", () => {
  // Issue 1 restarts (max 1 < mark 5); issue 2 keeps growing (max 8 > mark 7) in the same snapshot.
  const res = tailFresh([tln("1", 0), tln("1", 1), tln("2", 8)], { "1": 5, "2": 7 });
  assert.deepEqual(
    res.fresh.map((r) => [r.issue, r.n]),
    [["1", 0], ["1", 1], ["2", 8]],
    "issue 1's restart is delivered and issue 2's forward line is delivered once",
  );
  assert.deepEqual(res.seen, { "1": 1, "2": 8 }, "issue 2's mark advances normally, unaffected by issue 1's restart");
});
