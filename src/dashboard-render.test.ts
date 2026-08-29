// Tests for the dashboard presentation layer — the render* markup functions and
// the structural invariants they must hold (dashboard-render.ts, via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { DASHBOARD_PALETTE_CSS, stateColor, stateBorderColor, counterColor, STATE_DOT_CSS, STATE_CHIP_BORDER_CSS, TOP_BAR_STYLES, ISSUE_DETAIL_SHEET_STYLES, ISSUE_DETAIL_SHEET_SCRIPT, REPO_DROPDOWN_SCRIPT, ARCHIVE_LIST_SCRIPT, LIVE_TAIL_STYLES, HOST_LOG_STYLES } from "./dashboard-assets.ts";
import { archiveRowMatches, buildStatus, buildStatusWithIssueNames, cappedRawRows, event, formatStatusText, highlightJsonLine, issueDetailSheetMarkup, isNotableHostEvent, renderHostLog, renderLandingShell, feedFresh, feedKindLabel, feedProjects, feedRowMatches, feedView, followView, renderStatusPage, renderTopBar, type CampaignStatus } from "./status.ts";

const cfgFor = (dir: string): ResolvedConfig =>
  ({
    project: "demo",
    image: "img",
    baseBranch: "main",
    branchPrefix: "agent/",
    gates: [{ cmd: "npm test" }],
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
    promptFile: "prompt.md",
    fetchTask: (id: string) => id,
  }) as ResolvedConfig;

const writeJsonl = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const seedState = (dir: string, events: unknown[]) => {
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);
};

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
          reason: "blocked",
          parkedAt: "2025-06-15T09:00:00.000Z",
          branch: "agent/2",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { prune: true },
  );

// A minimal reconstructed run status for an archived row's campaign pane — a
// single closed wave holding one completed issue chip.
const archStatus = (issue: string): CampaignStatus => ({
  project: "beta",
  waves: [
    {
      index: 0,
      status: "closed",
      issues: [{ issueNumber: issue, status: "completed" }],
    },
  ],
  parked: [],
});

test("renderLandingShell's card heading shows owner/name, but links and keys on the bare project", () => {
  const html = renderLandingShell(["alpha"]);
  // The card heading reads the card's owner/name, falling back to the bare key when absent.
  assert.match(html, /"card-project", p\.repo \?\? p\.project/);
  // Routing stays keyed on the bare project: the card href is the bare project key.
  assert.match(
    html,
    /card\.href = "\/\?project=" \+ encodeURIComponent\(p\.project\)/,
  );
});

test("renderLandingShell is single-column on mobile with 44px tap targets", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The cards collapse to one column on a phone.
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /\.cards \{ grid-template-columns: 1fr; \}/);
  // The two tappable controls — the project dropdown and each card — are at least 44px.
  assert.match(html, /\.project-picker select \{[^}]*min-height: 44px/);
  assert.match(html, /\.card \{[^}]*min-height: 44px/);
});

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
  // The concrete #78 repro: pruned is referenced on the landing (feed, dots, turn log) and resolves.
  assert.ok(
    referencedTokens(landing).has("--color-pruned"),
    "landing references --color-pruned",
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
      ["running", "parked", "failure", "completed", "unstarted", "pruned", "quarantined", "interrupted"]
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

test("green live dots pulse when live even with zero running — they track the stream, not work (§5, #100)", () => {
  // Regression guard for the misdirected first #100 attempt: it hung a running-gate on the
  // green dot so an idle campaign (0 running) stopped pulsing. The green dots must stay live.
  const idle = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "1", status: "completed" }] }],
    parked: [],
  });
  assert.doesNotMatch(idle, /data-running/);
  assert.match(idle, /\.live-indicator::before \{[^}]*animation: chip-pulse[^}]*infinite/);
});

test("an idle running tally renders a solid blue dot with no pulse; genuinely-running dots still pulse (§5, #100)", () => {
  const html = renderLandingShell(["alpha"]);
  // A card's blue running-dots track work: a "0 running" tally is idle, so its dot is
  // solid blue but must not pulse (the pulse means active work). The idle rule is the
  // pure `tallyDotClass` (dashboard-visual-state.ts) — asserted directly there
  // (count=0 ⇒ "running idle") — single-sourced into this page via `.toString()` and
  // called on the tally dot, so the browser runs the very function the node test pins.
  assert.match(html, /function tallyDotClass/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // Motion: a .dot.running pulses by default (its blue is the shared stateColor-derived dot
  // rule); an idle (zero-count) one is stilled, keeping the blue but dropping the motion.
  assert.match(html, /\.dot\.running\.idle \{ animation: none; \}/);
  // The base running dot still pulses — a wave member with real running work is unaffected.
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
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
          issues: [{ issueNumber: "1", status: "pruned" }],
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
  // Every status colour is scoped to `.dot`, and each dot's colour is `stateColor` (asserted
  // by value there): the shared rules are generated from it, so one check proves the wiring for
  // the whole family rather than re-pinning each state's background.
  assert.ok(
    STATE_DOT_CSS.includes(
      ["running", "parked", "failure", "completed", "unstarted", "pruned", "queued", "quarantined", "interrupted"]
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

test("status dots never shrink under flex fill pressure — one shared base gives .dot/.repo-dot/.tail-dot/.lv-dot flex:none (#234)", () => {
  const campaign = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "212", status: "running" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // A wave-member row is a flex container whose ellipsised title exerts fill pressure;
  // a status dot with the default flex:0 1 auto collapses horizontally by a title-length
  // dependent amount, rendering as a pill or bar instead of a circle (#234). The four
  // status dots share one base rule so the "small solid circle that never shrinks"
  // invariant — border-radius + flex:none — is written once, not four times.
  assert.match(
    campaign,
    /\.dot, \.repo-dot, \.tail-dot, \.lv-dot \{[^}]*flex: none[^}]*\}/,
  );
  assert.match(
    campaign,
    /\.dot, \.repo-dot, \.tail-dot, \.lv-dot \{[^}]*border-radius: 999px[^}]*\}/,
  );
});

test("renderStatusPage shows a Resume control only for a wave-parked campaign (#171)", () => {
  const waveParked = renderStatusPage(
    {
      project: "beta",
      waves: [
        { index: 0, status: "wave-parked", issues: [{ issueNumber: "201", status: "completed" }] },
        { index: 1, status: "unstarted", issues: [{ issueNumber: "401", status: "unstarted" }] },
      ],
      parked: [],
    },
    { prune: true },
  );
  // A wave-parked campaign offers a Resume action that POSTs to /resume carrying only
  // its project (resume is project-scoped — no taskId), mirroring the prune/answer forms.
  assert.match(waveParked, /<form method="post" action="\/resume"[^>]*>/);
  assert.match(waveParked, /name="project" value="beta"/);
  assert.match(waveParked, /Resume/);

  // A plain running campaign (no wave-parked wave) shows no Resume control at all.
  const running = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] }],
      parked: [],
    },
    { prune: true },
  );
  assert.doesNotMatch(running, /action="\/resume"/);
});

test("renderStatusPage puts a quiet graft input on the summary line, greyed at rest (#202, #168)", () => {
  const runningCampaign = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  // Mockup 1a: the graft affordance rides the campaign summary line (project · N issues ·
  // M waves), not a banner. A form POSTing to /graft carries the project and a quiet ids
  // input; the button is greyed/disabled at rest and only activates once ids are typed.
  const withGraft = renderStatusPage(runningCampaign, { prune: true, graft: true });
  // The input lives inside the summary line, not a standalone banner.
  assert.doesNotMatch(withGraft, /class="graft-banner"/);
  const summary = withGraft.slice(withGraft.indexOf('class="campaign-summary"'), withGraft.indexOf('class="waves-grid"'));
  assert.match(summary, /class="campaign-meta"/);
  assert.match(summary, /<form method="post" action="\/graft"[^>]*>/);
  assert.match(summary, /name="project" value="beta"/);
  assert.match(summary, /name="ids"[^>]*placeholder="graft issue ids"/);
  // The graft button is disabled at rest — it activates client-side once ids are entered.
  assert.match(summary, /class="graft-btn"[^>]*disabled/);

  // Without the graft page option, no graft control — the same gating prune rides.
  const withoutGraft = renderStatusPage(runningCampaign, { prune: true });
  assert.doesNotMatch(withoutGraft, /action="\/graft"/);
  assert.doesNotMatch(withoutGraft, /class="campaign-summary"/);
});

test("renderStatusPage disables the graft input with amber guidance when the campaign is finished (#202)", () => {
  // Every wave closed → the campaign has reached its final wave; nothing is live-or-
  // resumable to layer into (the graft engine refuses, ADR 0014). Rather than fail on
  // submit, 1a renders the input structurally disabled with amber guidance and a
  // start-campaign affordance.
  const finished = {
    project: "beta",
    waves: [
      { index: 0, status: "closed" as const, issues: [{ issueNumber: "101", status: "completed" as const }] },
      { index: 1, status: "closed" as const, issues: [{ issueNumber: "201", status: "completed" as const }] },
    ],
    parked: [],
  };
  const html = renderStatusPage(finished, { prune: true, graft: true });
  const summary = html.slice(html.indexOf('class="campaign-summary"'), html.indexOf('class="waves-grid"'));
  // The refusal replaces the active form — no live POST target, a disabled input/button.
  assert.match(summary, /graft-refused/);
  assert.doesNotMatch(summary, /<form method="post" action="\/graft"/);
  assert.match(summary, /class="graft-ids"[^>]*disabled/);
  // Amber guidance naming the structural reason, plus a start-campaign affordance.
  assert.match(summary, /final wave/i);
  assert.match(summary, /new campaign starts/i);
  assert.match(summary, /class="graft-refusal"/);
  assert.match(summary, /vetinari campaign/);
});

test("renderStatusPage marks a freshly-grafted wave with a static teal edge, not motion (#202, §5)", () => {
  const grafted = {
    project: "beta",
    waves: [
      { index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] },
      { index: 1, status: "unstarted" as const, issues: [{ issueNumber: "305", status: "grafted" as const }] },
    ],
    parked: [],
  };
  const html = renderStatusPage(grafted, { prune: true, graft: true });
  // A wave carrying a grafted issue is marked, and takes the teal product accent on its
  // edge so the new card reads at a glance when it arrives on the live refresh.
  assert.match(html, /class="wave unstarted has-grafted"/);
  assert.match(html, /\.wave\.has-grafted \{ border-top-color: var\(--color-primary\); \}/);
  // §5 reserves motion for the work/stream channels — the mockup's teal pulse is
  // translated to this static emphasis (CLAUDE.md rule 5). No new colour animation: the
  // only @keyframes on the page stays chip-pulse (the §5 invariant test #100 also pins).
  assert.deepEqual(
    [...new Set([...html.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]))],
    ["chip-pulse"],
  );
});

test("renderStatusPage mutes the graft input's placeholder so it reads as an example, not a value (#236)", () => {
  const running = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  const html = renderStatusPage(running, { prune: true, graft: true });
  // The `graft issue ids` placeholder is a hint, not entered content — it renders muted
  // (the dim token) so it reads as an example rather than a typed value, while real typed
  // ids keep the full text colour on `.graft-ids` itself.
  assert.match(html, /\.graft-ids::placeholder \{ color: var\(--color-dim\); \}/);
  assert.match(html, /\.graft-ids \{[^}]*color: var\(--color-text\);/);
});

test("renderStatusPage ships the graft input's client wiring, re-run on live refresh (#202)", () => {
  const running = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  const html = renderStatusPage(running, { prune: true, graft: true });
  // The graft input is inside #live-region (swapped on every soft-refresh), so its wiring
  // is a function re-run from wireLiveRegion, not a one-shot bind.
  assert.match(html, /function wireGraft\(\)/);
  assert.match(html, /wireGraft\(\);/);
  // It POSTs directly on submit and surfaces a 422 whole-batch rejection inline in the
  // error box (keeping the typed ids), rather than navigating away.
  assert.match(html, /fetch\("\/graft"/);
  assert.match(html, /422/);
  assert.match(html, /data-graft-error/);
  // It validates against the retained dry-run closure endpoint on blur.
  assert.match(html, /\/graft\?preview/);
});

test("renderStatusPage shows an informational quarantine affordance with no action of its own (#171)", () => {
  const quarantined = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [
            { issueNumber: "611", status: "completed" },
            { issueNumber: "640", status: "quarantined" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // A quarantined issue surfaces a "resolve the conflict, then resume" note...
  assert.match(quarantined, /class="quarantine-note"/);
  assert.match(quarantined, /resolve the conflict/i);
  // ...but the note is informational only — it introduces no action form/route of its own.
  const note = quarantined.slice(quarantined.indexOf('class="quarantine-note"'));
  const noteBlock = note.slice(0, note.indexOf("</section>"));
  assert.doesNotMatch(noteBlock, /<form/);

  // No quarantined issue → no note.
  const clean = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "611", status: "completed" }] }],
      parked: [],
    },
    { prune: true },
  );
  assert.doesNotMatch(clean, /class="quarantine-note"/);
});

test("failure renders in its own red on every surface, never the prune action's red (#83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { prune: true },
  );
  // failure derives --color-failure from stateColor, distinct from the prune action's own
  // --color-red (the value distinction is asserted in the stateColor test). Here we confirm each
  // surface splices that failure colour in — the feed dot, the card edge, the run-state pill, and
  // the turn number — never re-pinning the token, which comes from the reducer.
  const failure = stateColor("failure");
  assert.notEqual(failure, "var(--color-red)");
  assert.ok(landing.includes(`.lv-dot.failure { background: ${failure}; }`));
  assert.ok(landing.includes(`.card.failure { border-top-color: ${failure}; }`));
  assert.ok(
    landing.includes(`.run-state.failure { border-color: ${failure}; color: ${failure}; }`),
  );
  assert.ok(
    ISSUE_DETAIL_SHEET_STYLES.includes(`.turn-num.failure { color: ${failure}; }`),
  );
  // The prune controls keep --color-red — a control, never the failure state.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.prune-start[^{]*\{[^}]*var\(--color-red\)/,
  );
  assert.ok(campaign.includes(`.turn-num.failure { color: ${failure}; }`));
});

test("renderLandingShell mounts the cross-project feed under the cards on every width", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The feed container sits after the cards and is client-rendered off /api/feed.
  assert.match(html, /id="feed"/);
  assert.match(html, /\/api\/feed/);
  assert.ok(
    html.indexOf('id="cards"') < html.indexOf('id="feed"'),
    "the feed renders after the cards",
  );
  // The event log now shows on a phone too (#125): the mobile block no longer
  // hides `.feed`, so iOS Safari at an iPhone width renders it under the cards.
  const mobileBlock = html.match(
    /@media \(max-width: 640px\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(mobileBlock, "the landing has a ≤640px mobile media block");
  assert.doesNotMatch(mobileBlock[0], /\.feed \{ display: none; \}/);
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

test("renderLandingShell mounts the host-log gear + pane on the host view (#180)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The host-log surface lives on the all-repos landing/host view.
  assert.match(html, /data-host-log-gear/);
  assert.match(html, /data-host-log-panel/);
  // Its initial rows come from the no-daemon host-log reader endpoint.
  assert.match(html, /\/api\/host-log/);
});

test("renderLandingShell seats the host-log gear at the end of the top-right live-bar, after the readout (#201)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The gear rides the end of the live-bar, immediately after the "updated Ns ago" readout:
  // the bar reads live dot → "updated Ns ago" → gear. Its pane travels with it (popover).
  assert.match(
    html,
    /<span class="updated" data-updated>[^<]*<\/span><section class="host-log" data-host-log>/,
  );
  // The gear no longer floats as a detached section under the top bar — the host-log
  // opens only from within the live-bar.
  assert.doesNotMatch(html, /<\/div>\s*<section class="host-log"/);
  // The gear now rides the campaign page's live-bar too, in the very same seat — after the
  // "updated Ns ago" readout — so settings are one click away on every page (#215).
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

test("renderLandingShell parked counter expands a cross-repo parked queue in place", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The parked counter is an interactive toggle, unlike the other three counters —
  // a button controlling the queue panel, inert (disabled) until the client learns
  // there is at least one parked question.
  assert.match(
    html,
    /<button[^>]*class="counter counter-toggle"[^>]*data-counter="parked"[^>]*disabled[^>]*aria-controls="parked-queue"/,
  );
  // The queue panel sits between the counters and the cards, so expanding it pushes
  // the cards down while keeping them visible; it starts hidden.
  assert.match(html, /<section id="parked-queue"[^>]*hidden/);
  assert.ok(
    html.indexOf('id="parked-queue"') < html.indexOf('id="cards"'),
    "parked queue renders above the cards",
  );
  // The client renders one row per parked question, oldest first from data.parked,
  // each opening that repo's issue detail, showing repo, issue number, the full
  // question and how long it has waited.
  assert.match(html, /data\.parked/);
  assert.match(html, /\/\?project=/);
  assert.match(html, /fmtWaited/);
  // The counter is inert (disabled, no arrow/cursor) when there are no parked
  // questions, and becomes a working toggle when there are.
  assert.match(html, /\.counter-toggle:disabled/);
  assert.match(html, /aria-expanded/);
  // The parked rows collapse to a readable stack on a phone.
  assert.match(html, /\.parked-row/);
  // `.parked-queue { display: grid }` otherwise defeats the UA `[hidden]` rule, so
  // the collapse rule must be restored explicitly or clicking the counter flips the
  // caret but never hides the panel (#71).
  assert.match(html, /\.parked-queue\[hidden\] \{ display: none;? \}/);
});

test("renderLandingShell opens a parked-queue row's issue detail inline, not by navigating (#74)", () => {
  const html = renderLandingShell(["alpha"]);
  // The landing now hosts the issue-detail sheet (the same one the campaign page has).
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="reply-resume"/);
  assert.match(html, /id="prune-panel"/);
  // openIssue is defined here, and a parked row opens it in place — the click is
  // intercepted so the row never does the full navigation to the campaign page.
  assert.match(html, /const openIssue = async \(project, issue, prunable, run\)/);
  assert.match(
    html,
    /row\.addEventListener\("click", \(event\) => \{ event\.preventDefault\(\); openIssue\(p\.project, p\.issueNumber, true\); \}\)/,
  );
  // The sheet's collapse rules are present so a flex display can't defeat [hidden].
  assert.match(html, /\.issue-detail\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.prune-panel\[hidden\] \{ display: none; \}/);
  // The status dot colours are scoped to .dot (the shared stateColor-derived rules) so they
  // don't tint the run-state pills.
  assert.ok(html.includes(STATE_DOT_CSS));
});

test("the issue-detail sheet markup, CSS, and script are defined once and shared by both pages (#76)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  // The campaign page renders the sheet with its prune panel when prune is on and
  // without it otherwise; the landing always hosts the prune-enabled sheet.
  const campaignPrune = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { prune: true },
  );
  const campaignPlain = renderStatusPage({
    project: "beta",
    waves: [],
    parked: [],
  });

  // Markup: one helper, rendered verbatim by both pages. The landing and the
  // prune-enabled campaign page share the prune-panel variant; a plain campaign
  // page shares the no-prune variant.
  assert.ok(landing.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPrune.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPlain.includes(issueDetailSheetMarkup(false)));
  // The no-prune variant has no prune panel; the prune variant does.
  assert.ok(!issueDetailSheetMarkup(false).includes("prune-panel"));
  assert.ok(issueDetailSheetMarkup(true).includes('id="prune-panel"'));

  // CSS: one definition of the sheet styles, included by both pages verbatim.
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".issue-detail-sheet {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".turn-log {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".sheet-actions {"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_STYLES));
  assert.ok(campaignPrune.includes(ISSUE_DETAIL_SHEET_STYLES));

  // Script: one definition of the sheet behaviour (openIssue/renderDetail/
  // renderReply/closeSheet/prune wiring), included by both pages verbatim.
  assert.ok(
    ISSUE_DETAIL_SHEET_SCRIPT.includes(
      "const openIssue = async (project, issue, prunable, run)",
    ),
  );
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("const closeSheet = () =>"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_SCRIPT));
  assert.ok(campaignPrune.includes(ISSUE_DETAIL_SHEET_SCRIPT));

  // The hand-sync note is gone now that the sheet has a single source.
  assert.ok(!landing.includes("#76"));
  assert.ok(!landing.includes("kept in sync"));
});

test("renderLandingShell's feed renders humanized rows in the shared .lv-row component, dot by event state (#216)", () => {
  const html = renderLandingShell(["alpha"]);
  // The feed's humanized branch builds the shared .lv-row from each row's server-attached parts,
  // so the feed reads as the same component as the tail/host/archive — no bespoke .feed-kind label.
  assert.match(html, /humanizedRow\(e\.humanized, document\)/);
  assert.match(html, /function humanizedRow/);
  // The multiline-collapse split (#217) ships alongside, since humanizedRow calls it client-side.
  assert.match(html, /function splitOverflow/);
  assert.ok(!html.includes("feed-kind") && !html.includes("feedKindClass"), "the old per-kind .feed-kind label is gone");
  // The shared .lv-dot state palette (generated from LOG_DOT_STATE_COLOR) paints the row dots.
  assert.match(html, /\.lv-dot\.merged \{ background:/);
  assert.match(html, /\.lv-dot\.failure \{ background:/);
});

test("the shared .lv-row paints the 2b least→most emphasis ramp: time muted · actor mono+subdued · message prominent (#221)", () => {
  const html = renderLandingShell(["alpha"]);
  // Least important — the time reads in the most muted grey (--color-dim).
  assert.match(html, /\.lv-t \{[^}]*color: var\(--color-dim\)/);
  // Mid — the actor is distinct but subdued: a mono handle at mid brightness (--color-text-light-2).
  assert.match(html, /\.lv-lead \{[^}]*font-family: ui-monospace/);
  assert.match(html, /\.lv-lead \{[^}]*color: var\(--color-text-light-2\)/);
  // Most important — the message itself is the brightest, most readable element (--color-text).
  assert.match(html, /\.lv-msg \{[^}]*color: var\(--color-text\)/);
});

test("the shared .lv-row styles the multiline-collapse chevron and overflow block (#217)", () => {
  const html = renderLandingShell(["alpha"]);
  // The bare chevron is a dim, clickable affordance that brightens on hover (palette tokens, §1).
  assert.match(html, /\.lv-chev \{[^}]*cursor: pointer/);
  assert.match(html, /\.lv-chev:hover \{[^}]*color:/);
  // The overflow block sits in the message column (grid-column 3), mono/raw and copy-pasteable,
  // and is display:none until the chevron toggles its [hidden] off.
  assert.match(html, /\.lv-overflow \{[^}]*grid-column: 3/);
  assert.match(html, /\.lv-overflow\[hidden\] \{ display: none; \}/);
});

test("renderLandingShell's feed is a scrollable live-tail-style pane, not a show-older list (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The empty window reads the feed's own copy, not the live-only "No activity yet".
  assert.match(html, /No activity in the last 48 hours\./);
  assert.ok(!html.includes("No activity yet."), "the live-only empty state is gone from the feed");
  // The old cap-and-reveal model is gone: the feed now renders into a scroll pane bounded by the
  // shared follow/pause render cap, so there is no 20-row cap and no archive-show-older control.
  assert.ok(!html.includes("const FEED_CAP = 20;"), "the show-older cap is gone from the feed");
  assert.doesNotMatch(html, /"feed-rows"[^;]*archive-show-older/);
  assert.ok(!html.includes("older event"), "the show-older-events control is gone");
  // The feed body is its own scroll pane keeping prose typography (its rows differ from the
  // tail's mono raw lines), styled alongside the shared chrome rather than reusing .tail-body.
  assert.match(html, /\.feed-body \{[^}]*overflow-y: auto/);
});

test("renderLandingShell's feed adopts the live-tail pane chrome via shared CSS (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The event-log pane draws the live tail's shared chrome (container, header, control strip,
  // backlog, footer) from LIVE_TAIL_STYLES rather than a second ad-hoc restyle.
  assert.match(html, /\.live-tail \{/);
  assert.match(html, /\.tail-head \{/);
  assert.match(html, /\.tail-controls \{/);
  // The feed section is a .live-tail card carrying its own hook, with the shared header chrome.
  assert.match(html, /<section id="feed" class="live-tail feed" data-feed/);
  assert.match(html, /class="tail-head"[\s\S]*?data-feed-dot/);
  // The event-log title still reads "Event log · all repos"; the old "Recent activity" heading
  // and the old bespoke <h2> feed header are gone.
  assert.match(html, /Event log · all repos/);
  assert.ok(!html.includes("Recent activity"), "the old heading is gone");
  assert.doesNotMatch(html, /class="feed"[^>]*>\s*<h2/);
});

test("renderLandingShell's feed is humanized-only: no Humanized/Raw toggle, no raw tokeniser (#221)", () => {
  const html = renderLandingShell(["alpha"]);
  // #221: the feed always renders its narrated rows — the Humanized/Raw toggle is gone entirely,
  // and with it the per-view mode memory and the raw NDJSON tokeniser it used.
  assert.doesNotMatch(html, /data-feed-mode/);
  assert.doesNotMatch(html, /vetinari:feed-mode/);
  assert.doesNotMatch(html, /highlightJsonLine\(e\.raw\)/);
});

test("renderLandingShell's feed Download JSON emits the filtered underlying NDJSON (#203)", () => {
  const html = renderLandingShell(["alpha"]);
  // Download JSON emits the currently-filtered rows' raw event NDJSON (e.raw joined by newlines) as
  // a .jsonl blob — the raw bytes, uncapped by the render window — not the old narrated .txt export.
  assert.match(html, /download = "event-log\.jsonl"/);
  assert.match(html, /application\/x-ndjson/);
  assert.match(html, /\.map\(\(e\) => e\.raw\)/);
  assert.ok(!html.includes("event-log.txt"), "the old narrated-text export is gone");
});

test("renderLandingShell's feed carries the live-tail controls wired to the shared view-model (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The control strip: case-insensitive filter, follow/pause, download-visible (the mockup 1a
  // chrome drops the Clear control — the download preserves the data, #216).
  for (const hook of ["data-feed-filter", "data-feed-play", "data-feed-save", "data-feed-backlog"]) {
    assert.ok(html.includes(hook), `feed control ${hook} is present`);
  }
  // The client drives follow/pause/backlog through the shared, tested view-model and dedups the
  // re-fetched window through feedFresh — the same tested logic as the tail, not a parallel copy.
  assert.match(html, /function followView/);
  assert.match(html, /function feedFresh/);
  assert.match(html, /function feedRowMatches/);
  assert.match(html, /function tailAppend/);
  // Follow/pause reads through the shared view-model — now via feedView, which composes the
  // project + text predicate over followView (#220); the backlog points up (newest-on-top, #195).
  assert.match(html, /feedView\(\{ buffer: feedBuffer/);
  assert.match(html, /"↑ " \+ view\.backlog \+ " new event"/);
  // Filter drives feedRowMatches over the (kind, text) pair.
  assert.match(html, /feedRowMatches\(/);
  // Download JSON exports the visible rows' underlying NDJSON (the Raw-toggle counterpart, #203).
  assert.match(html, /download = "event-log/);
});

test("feedKindLabel folds an orchestrator event kind to the feed's clean lowercase label — the term the filter still matches on (#196)", () => {
  // The label is the clean namespace.verb remap; an unmapped kind falls through to its raw value.
  // The feed's humanized rows now render in the shared .lv-row (#216), so the label no longer
  // shows as a per-row chip — it survives only as the term feedRowMatches lets the filter match.
  assert.equal(feedKindLabel("green"), "issue.merged");
  assert.equal(feedKindLabel("prune"), "issue.pruned");
  assert.equal(feedKindLabel("some-unmapped-kind"), "some-unmapped-kind");
});

test("feedRowMatches filters a feed row case-insensitively over its kind label + narrated text (#196)", () => {
  const row = { kind: "green", text: "acme — #101 merged" };
  // An empty / whitespace query matches everything (the filter is cleared).
  assert.equal(feedRowMatches(row, ""), true);
  assert.equal(feedRowMatches(row, "   "), true);
  // The prose text matches, case-insensitively.
  assert.equal(feedRowMatches(row, "ACME"), true);
  assert.equal(feedRowMatches(row, "#101"), true);
  // The remapped kind label matches — the operator sees "issue.merged", not the raw "green".
  assert.equal(feedRowMatches(row, "issue.merged"), true);
  assert.equal(feedRowMatches(row, "merged"), true);
  // A miss on both label and text hides the row.
  assert.equal(feedRowMatches(row, "zzz"), false);
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

test("feedFresh dedups a re-fetched newest-first window, returning only genuinely new rows oldest-first (#196)", () => {
  // The server returns the whole window newest-first each fetch; the client accumulates.
  const fe = (ts: string, text: string) => ({ project: "acme", ts, kind: "green", text });
  const window1 = [fe("2026-08-28T00:00:02Z", "c"), fe("2026-08-28T00:00:01Z", "b"), fe("2026-08-28T00:00:00Z", "a")];
  const first = feedFresh(window1, {});
  // Fresh is oldest-first so it appends to the oldest→newest buffer in chronological order.
  assert.deepEqual(first.fresh.map((r) => r.text), ["a", "b", "c"]);

  // Next fetch re-sends the window plus one newer row; only the new row is fresh.
  const window2 = [fe("2026-08-28T00:00:03Z", "d"), ...window1];
  const second = feedFresh(window2, first.seen);
  assert.deepEqual(second.fresh.map((r) => r.text), ["d"]);

  // Two rows with the same ts but different text are distinct events, both fresh.
  const window3 = [fe("2026-08-28T00:00:03Z", "d2"), ...window2];
  const third = feedFresh(window3, second.seen);
  assert.deepEqual(third.fresh.map((r) => r.text), ["d2"]);
});

test("the feed drives the shared followView with its (kind, text) filter — same view-model as the tail (#196)", () => {
  // The feed client accumulates an oldest→newest buffer and drives followView with feedRowMatches,
  // exactly as the tail drives it with its own predicate. Rows shaped like feed entries.
  const fe = (ts: string, kind: string, text: string) => ({ project: "acme", ts, kind, text });
  const buffer = [fe("t0", "turn", "acme — #1 took a turn"), fe("t1", "green", "acme — #2 merged"), fe("t2", "parked", "acme — #3 parked")];

  // Following, no filter: newest-first, backlog zero, following true.
  const all = followView({ buffer, mark: 0, live: true, cap: 160, match: (e) => feedRowMatches(e, "") });
  assert.deepEqual(all.rows.map((r) => r.text), ["acme — #3 parked", "acme — #2 merged", "acme — #1 took a turn"]);
  assert.equal(all.backlog, 0);
  assert.equal(all.following, true);

  // The filter narrows to rows whose kind label or prose text matches — "merged" hits both the
  // remapped label (issue.merged) and the prose of the green row.
  const filtered = followView({ buffer, mark: 0, live: true, cap: 160, match: (e) => feedRowMatches(e, "merged") });
  assert.deepEqual(filtered.rows.map((r) => r.text), ["acme — #2 merged"]);

  // Paused at mark=2 freezes the first two; the parked row that arrived after counts as backlog.
  const paused = followView({ buffer, mark: 2, live: false, cap: 160, match: (e) => feedRowMatches(e, "") });
  assert.deepEqual(paused.rows.map((r) => r.text), ["acme — #2 merged", "acme — #1 took a turn"]);
  assert.equal(paused.backlog, 1);
  assert.equal(paused.following, false);
});

test("renderLandingShell's feed carries the project dropdown wired to the shared feedView, labelled by owner/name (#220)", () => {
  const html = renderLandingShell([{ project: "alpha", repo: "acme/alpha", runState: "idle" }]);
  // The controls strip gains a project dropdown beside the free-text filter, defaulting to "all repos".
  for (const hook of ["data-feed-project-dd", "data-feed-project-trigger", "data-feed-project-menu", "data-feed-project-label"]) {
    assert.ok(html.includes(hook), `feed project-dropdown hook ${hook} is present`);
  }
  assert.match(html, /data-feed-project-label[^>]*>all repos</);
  // The composed project+text filtering drives through the shared, tested feedView, and the option
  // set is derived from the buffer by the tested feedProjects — the same functions the node test runs.
  assert.match(html, /function feedView/);
  assert.match(html, /function feedProjects/);
  assert.match(html, /feedView\(\{ buffer: feedBuffer/);
  // The options are labelled by owner/name (the repo switcher's label), keyed on the project — so
  // the repo map for the registered projects is serialised into the page for the menu to read.
  assert.match(html, /acme\/alpha/);
});

test("feedView composes the project dropdown and the (kind, text) filter as AND over the shared followView (#220)", () => {
  // The event-log feed's body view-model, the sibling of tailView: it swaps the tail's issue
  // criterion for a project one and folds it, with the substring filter, into one match predicate
  // the shared followView applies to both the visible set and the backlog count.
  const fe = (project: string, ts: string, kind: string, text: string) => ({ project, ts, kind, text });
  const buffer = [
    fe("acme", "t0", "turn", "acme — #1 took a turn"),
    fe("beta", "t1", "green", "beta — #2 merged"),
    fe("acme", "t2", "green", "acme — #3 merged"),
  ];

  // Both cleared: everything, newest-first (the default all-repos, no-text state).
  const both = feedView({ buffer, mark: 0, live: true, project: "", query: "", cap: 160 });
  assert.deepEqual(both.rows.map((r) => r.text), ["acme — #3 merged", "beta — #2 merged", "acme — #1 took a turn"]);

  // Project only narrows to that project's rows; the text filter is widened (cleared).
  const byProject = feedView({ buffer, mark: 0, live: true, project: "acme", query: "", cap: 160 });
  assert.deepEqual(byProject.rows.map((r) => r.text), ["acme — #3 merged", "acme — #1 took a turn"]);

  // Text only narrows by substring across every project; the project is widened (cleared).
  const byText = feedView({ buffer, mark: 0, live: true, project: "", query: "merged", cap: 160 });
  assert.deepEqual(byText.rows.map((r) => r.text), ["acme — #3 merged", "beta — #2 merged"]);

  // Both set compose as AND — a chosen project AND the text substring.
  const both2 = feedView({ buffer, mark: 0, live: true, project: "acme", query: "merged", cap: 160 });
  assert.deepEqual(both2.rows.map((r) => r.text), ["acme — #3 merged"]);

  // The composed predicate reaches the backlog count too: paused at mark=2, the later acme green
  // is backlog only while it matches both criteria; a non-matching project would not count it.
  const paused = feedView({ buffer, mark: 2, live: false, project: "acme", query: "", cap: 160 });
  assert.equal(paused.backlog, 1);
  const pausedOther = feedView({ buffer, mark: 2, live: false, project: "beta", query: "", cap: 160 });
  assert.equal(pausedOther.backlog, 0);
});

test("feedProjects lists the distinct projects present in the buffer, sorted, updating as new projects arrive (#220)", () => {
  // The dropdown's options are sourced from the buffer (no dead options), mirroring how the live
  // tail's agent dropdown tracks running issues — so a project with nothing in the window is not
  // offered, and a new project's first event grows the list.
  const fe = (project: string, text: string) => ({ project, ts: "t", kind: "turn", text });
  assert.deepEqual(feedProjects([]), []);
  const buffer = [fe("beta", "b1"), fe("acme", "a1"), fe("beta", "b2")];
  // Distinct and sorted for a stable menu, regardless of arrival order or repeats.
  assert.deepEqual(feedProjects(buffer), ["acme", "beta"]);
  // A new project's event grows the option set.
  assert.deepEqual(feedProjects([...buffer, fe("gamma", "g1")]), ["acme", "beta", "gamma"]);
});

test("the card progress-bar selector is scoped so no bare `.progress {` rule can leak onto a status word (#85)", () => {
  const html = renderLandingShell(["alpha"]);
  // A bare `.progress {` rule (the card progress bar) would match any element carrying the
  // `progress` word as a modifier, applying height/background/overflow. Scope the bar's
  // selector so no bare `.progress {` exists.
  assert.doesNotMatch(html, /(?<![-\w])\.progress \{/);
});

test("no status/category word is ever a bare top-level CSS class, so a component base can't inherit a modifier's layout (#91)", () => {
  // The convention (docs/dashboard-color-rules.md §8): a status word (ADR 0007's
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
            issues: [{ issueNumber: "1", status: "pruned" }],
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

test("renderLandingShell colours each project card's highlight by run state (#75)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card element carries its run-state class...
  assert.match(html, /el\("a", "card " \+ p\.runState\)/);
  // ...and per-state border-top-color rules tint the highlight to match the pill. The colour
  // for each state is `stateColor` (asserted by value there); one structural check confirms the
  // rendered output carries those reducer-derived rules verbatim, proven once not per state.
  const cardEdgeCss = ["running", "parked", "failure", "completed", "idle"]
    .map((s) => `.card.${s} { border-top-color: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(cardEdgeCss), "landing carries the stateColor-derived card edges");
});

test("renderLandingShell draws each card a run-state-coloured progress bar sized by percent merged (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card renders a progress track with a fill sized to percentMerged and classed by run state,
  // sitting beneath the wave/percent meta line.
  assert.match(html, /el\("div", "progress-fill " \+ p\.runState\)/);
  assert.match(html, /\.style\.width = p\.percentMerged \+ "%"/);
  // The fill is coloured by run state (idle stays grey via the base rule). Each state's colour
  // is `stateColor` (asserted by value there); one structural check confirms the rendered output
  // carries those fill rules verbatim, proven once rather than re-pinned per state.
  const fillCss = ["running", "parked", "completed"]
    .map((s) => `.progress-fill.${s} { background: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(fillCss), "landing carries the stateColor-derived progress fills");
});

test("renderLandingShell renders the card tally as status-dot chips, not plain text (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The tally builds one pill chip per bucket, each with a status dot scoped to .dot,
  // whose class comes from the shared `tallyDotClass` reducer (dashboard-visual-state.ts).
  assert.match(html, /el\("span", "tally-chip"\)/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // The chip treatment matches the campaign page's chips — a bordered pill.
  assert.match(html, /\.tally-chip \{[^}]*border-radius: 999px/);
  // The tally dots reuse the shared stateColor-derived .dot colours (queued the dim unstarted
  // grey, running/parked their status colours) — asserted by value against stateColor.
  assert.ok(html.includes(STATE_DOT_CSS));
  // The old plain-text tally string is gone.
  assert.doesNotMatch(html, /" running · " \+ p\.tally\.parked/);
});

test("renderLandingShell colours the counter values and highlights the parked counter when it has questions (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter value reads in its status colour — working blue, parked amber, merged-today
  // green; queued stays neutral. The value→colour mapping is owned by `counterColor` (asserted
  // there); here one structural check confirms the rendered output carries that reducer's CSS.
  const counterValueCss = ["working", "parked", "mergedToday"]
    .map((k) => `[data-counter="${k}"] .counter-value { color: ${counterColor(k)}; }`)
    .join(" ");
  assert.ok(
    html.includes(counterValueCss),
    "landing carries the counterColor-derived counter-value rules",
  );
  // The parked counter carries a gold border only while it is actionable — enabled, i.e. parked > 0.
  assert.match(
    html,
    /\.counter-toggle\[data-counter="parked"\]:not\(:disabled\) \{[^}]*border-color: var\(--color-yellow\)/,
  );
});

test("renderLandingShell gives each counter a payload-derived sublabel (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter carries a sublabel element the client fills from the payload.
  assert.match(html, /data-counter-sub="working"/);
  assert.match(html, /data-counter-sub="parked"/);
  assert.match(html, /data-counter-sub="queued"/);
  assert.match(html, /data-counter-sub="mergedToday"/);
  // working counts repos with a running agent; parked reads the oldest parked question's wait;
  // queued and merged-today are fixed context lines.
  assert.match(html, /across " \+ /);
  assert.match(html, /oldest " \+ fmtWaited/);
  assert.match(html, /in later waves/);
  // The counter is titled "Merged today" (the metric); its sublabel states the
  // scope — the all-repos aggregate — matching the "across N repos" sibling (#104).
  assert.match(html, /All repos/);
  assert.doesNotMatch(html, /issues merged/);
  assert.doesNotMatch(html, /issues closed/);
});

test("renderLandingShell stacks each counter label on top of an inline value + sublabel row (#94)", () => {
  const html = renderLandingShell(["alpha"]);
  // POC layout: the uppercase label sits on top, then the value and sublabel share
  // one inline row (a .counter-line), rather than value → label → sublabel stacked.
  for (const key of ["working", "parked", "queued", "mergedToday"]) {
    const counter = html.match(
      new RegExp(`data-counter="${key}"[^>]*>(.*?)counter-sub`),
    );
    assert.ok(counter, `counter ${key} present`);
    const body = counter[1];
    // Label markup comes before the value markup for this counter.
    assert.ok(
      body.indexOf("counter-label") < body.indexOf("counter-value"),
      `counter ${key} renders label above value`,
    );
    // The value and sublabel are wrapped together in the inline row.
    assert.ok(
      body.includes("counter-line"),
      `counter ${key} wraps value + sub in an inline row`,
    );
  }
  // The inline row lays value + sublabel out on one baseline-aligned line.
  assert.match(
    html,
    /\.counter-line \{[^}]*display: flex[^}]*align-items: baseline/,
  );
});

test("the updated readout ages 'updated Ns ago' from the last refresh, on both pages (§5, #210)", () => {
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ]) {
    // The "updated Ns ago" readout is `freezeIntent`'s `updatedText` (dashboard-visual-state.ts,
    // asserted directly there: live⇒"updated Ns ago", null⇒"waiting for updates"),
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

test("renderLandingShell wires live SSE updates and an updated-ago readout, no page-level pause (#210)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // Subscribes to the one-way SSE stream and re-reads the landing as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // A live indicator and an "updated Ns ago" readout live in the toolbar header.
  assert.match(html, /data-live-state/);
  assert.match(html, /data-updated/);
  // The page-level pause is gone (#210): no pause button, no paused-state page-level freeze.
  assert.doesNotMatch(html, /id="pause"/);
  assert.doesNotMatch(html, /let paused = false/);
});

test("wave labels read from tmp-log issue titles, resolved through buildStatusWithIssueNames", async () => {
  const dir = join(tmpdir(), `vetinari-status-wave-names-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102", "103"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);
  const titles: Record<string, string> = {
    "101": "config resolution",
    "102": "retry policy",
    "103": "log rotation",
    "201": "cache eviction",
  };

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    // Unique project so the process-lifetime issue-name cache can't collide with
    // another test's "demo:101".
    project: "wave-names",
    fetchTask: async (id: string) => JSON.stringify({ title: titles[id] }),
  });
  const html = renderStatusPage(status);

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage names waves festively when the toggle is on (#193)", () => {
  const dir = join(tmpdir(), `vetinari-festive-render-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102"], ["201"]],
      titles: { "101": "config resolution", "102": "retry policy", "201": "cache eviction" },
      slots: 1,
      festiveOffset: 11, // pool[11] = Granny Weatherwax, pool[12] = Nanny Ogg
    }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("campaign-batch-done", { ts: "2025-01-01T00:02:00.000Z", index: 0, merged: ["101", "102"], held: [], clearedParked: [] }),
    event("campaign-batch", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["201"] }),
  ]);
  const status = buildStatus(cfgFor(dir));

  // Off (default) — labels are exactly today's `Wave N …`, no festive name.
  const plain = renderStatusPage(status);
  assert.match(plain, /<h2 class="wave-label">Wave 2 — cache eviction<\/h2>/);
  assert.match(plain, /Wave 1 <span class="completed-wave-tally">/);
  assert.doesNotMatch(plain, /Granny Weatherwax/);

  // On — cards and the closed-wave chip carry `index · name`; the closed card drops the
  // lead-title collapse (its member rows carry the titles).
  const festive = renderStatusPage(status, { festive: true });
  assert.match(festive, /<h2 class="wave-label">Wave 2 · Nanny Ogg<\/h2>/);
  assert.match(festive, /<h2 class="wave-label">Wave 1 · Granny Weatherwax<\/h2>/);
  assert.match(festive, /✓<\/span> Wave 1 · Granny Weatherwax <span class="completed-wave-tally">/);
});

test("renderStatusPage renders a nameless Wave N when festive is on but the run reserved no offset (#193)", () => {
  const dir = join(tmpdir(), `vetinari-festive-nooffset-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["201"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["201"] }),
  ]);
  const festive = renderStatusPage(buildStatus(cfgFor(dir)), { festive: true });
  assert.match(festive, /<h2 class="wave-label">Wave 1<\/h2>/);
});

test("wave labels and chip hovers render from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `vetinari-render-log-titles-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102", "103"], ["201"]],
      titles: {
        "101": "config resolution",
        "102": "retry policy",
        "103": "log rotation",
        "201": "cache eviction",
      },
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);

  // buildStatus over cfgFor's id-echoing fetchTask: the only source of titles is
  // the log, exactly as the dumb-router dashboard reads them (ADR 0002).
  const html = renderStatusPage(buildStatus(cfgFor(dir)));

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // Every chip carries its own title on hover — 201 has no status detail yet, so
  // its hover is exactly the resolved title.
  assert.match(html, /<button[^>]*title="cache eviction"[^>]*>/);
  // A chip whose issue also has a status detail carries the title alongside it.
  assert.match(html, /title="config resolution&#10;Merged into base"/);
});

test("renderStatusPage shows a merged/total tally on an open wave card", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "completed" },
          { issueNumber: "202", status: "running" },
        ],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [
          { issueNumber: "301", status: "unstarted" },
          { issueNumber: "302", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });

  // Each open wave card's head carries its merged/total — one of two done in the
  // running wave, none in the unstarted one — ahead of its state pill in the meta group.
  assert.match(
    html,
    /<span class="wave-tally">1\/2<\/span><span class="wave-status running">running<\/span>/,
  );
  assert.match(
    html,
    /<span class="wave-tally">0\/2<\/span><span class="wave-status unstarted">unstarted<\/span>/,
  );
});

test("renderStatusPage renders one stable wave-head row: label · merged/total · state · pruned, with the pill outside the label", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          {
            issueNumber: "201",
            status: "completed",
            name: "Guest checkout entry point",
          },
          { issueNumber: "202", status: "running" },
          { issueNumber: "203", status: "pruned" },
        ],
      },
    ],
    parked: [],
  });

  // The head is one row: the label in its own element (so a long label can't shove the
  // state pill onto its own line, the Wave 2 vs Wave 3 misalignment), then a meta group
  // ordering merged/total · state pill · pruned tally — the pruned count folded into the
  // row, not floating in the corner.
  assert.match(
    html,
    /<div class="wave-head"><h2 class="wave-label">Wave 2 — Guest checkout entry point \+2<\/h2><div class="wave-meta"><span class="wave-tally">1\/3<\/span><span class="wave-status running">running<\/span><span class="wave-pruned">1 pruned<\/span><\/div><\/div>/,
  );
  // The state pill is no longer nested inside the <h2> label.
  assert.doesNotMatch(
    html,
    /<span class="wave-status running">running<\/span><\/h2>/,
  );
});

test("renderStatusPage renders one interactive member row per issue, merging the old chip + title blocks", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [
            {
              issueNumber: "201",
              status: "running",
              name: "wire up the parser",
            },
            { issueNumber: "202", status: "unstarted" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // One member list, one interactive row per issue: status dot + #NNN + resolved
  // title + status word — no separate chip row and no separate title list.
  assert.match(
    html,
    /<ul class="wave-members"><li><button type="button" class="wave-member running"[^>]*><span class="dot running"><\/span>#201 <span class="wave-member-title">wire up the parser<\/span><small>running<\/small><\/button><\/li>/,
  );
  // An unresolved title falls back to just #NNN (no title span).
  assert.match(
    html,
    /<li><button type="button" class="wave-member unstarted"[^>]*><span class="dot unstarted"><\/span>#202 <small>unstarted<\/small><\/button><\/li>/,
  );
  // The row carries its issue+project so a tap opens the detail sheet, and is flagged
  // prunable when prunable (202 is an unstarted future-wave remainder).
  assert.match(
    html,
    /class="wave-member unstarted" title="[^"]*" data-issue="202" data-project="beta" data-prunable="1"/,
  );
  // The old dual blocks are retired — no chip row (`.chips`/`.chip`) and no title list.
  assert.doesNotMatch(html, /class="chips"/);
  assert.doesNotMatch(html, /class="wave-issues"/);
  assert.doesNotMatch(html, /class="chip /);
});

test("renderStatusPage colours a pruned chip and pulses a running one", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "live one" },
          { issueNumber: "202", status: "pruned", name: "pruned one" },
        ],
      },
    ],
    parked: [],
  });

  // A pruned member row carries the pruned status dot + title + status word, and its
  // `.wave-member.pruned` class reads struck-through…
  assert.match(
    html,
    /<button type="button" class="wave-member pruned"[^>]*><span class="dot pruned"><\/span>#202 <span class="wave-member-title">pruned one<\/span><small>pruned<\/small><\/button>/,
  );
  assert.match(
    html,
    /\.wave-member\.pruned \{ color: var\(--color-text-light-2\); text-decoration: line-through; \}/,
  );
  // …and the wave it left gains a pruned tally in its header, so the prune reads
  // at a glance without counting struck-through chips (one of two issues pruned).
  assert.match(html, /<span class="wave-pruned">1 pruned<\/span>/);
  // …in a distinct pruned colour defined in the stylesheet (ADR 0007's sixth state),
  // scoped to .dot so it tints only the dot, never the whole struck-through chip (#81). The
  // pruned dot's colour is stateColor("pruned") (asserted by value there), carried in the shared
  // dot rules the page splices in.
  assert.match(html, /--color-pruned:/);
  assert.ok(html.includes(STATE_DOT_CSS));
  // A running chip pulses — a keyframed animation on its dot, reduced-motion aware.
  assert.match(html, /@keyframes chip-pulse/);
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
  assert.match(html, /prefers-reduced-motion/);
});

test("renderStatusPage's prune panel discloses kept-banked work and carries a standalone explainer", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "401", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // The confirmation is built from the structured closure the endpoint returns:
  // it names the dropped dependents and, separately, states the banked (merged or
  // mergeable) work that is kept — so a confirm never implies banked work leaves.
  assert.match(html, /also drops/);
  assert.match(html, /Keeps banked \(merged or mergeable\)/);
  // A standalone Prune (no Resume beside it) carries a plain-words explainer of
  // what a prune does, keyed to show only when the issue is prunable and unparked.
  assert.match(html, /id="prune-explainer"/);
  assert.match(html, /everything blocked by it/);
});

test("renderStatusPage renders the repo dropdown (with a no-JS select fallback) and the selected project's body", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [
        {
          issueNumber: "201",
          reason: "blocked",
          parkedAt: "now",
          branch: "agent/201",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { projects: ["alpha", "beta", "gamma"], selected: "beta" },
  );

  // The primary control is the repo dropdown trigger stating the current scope.
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  assert.match(html, /<span class="repo-label">beta<\/span>/);
  // The native <select> lives on inside <noscript> as the no-JS switch (posts back to GET /).
  assert.match(
    html,
    /<noscript><form[^>]*method="get"[^>]*action="\/"[^>]*class="project-picker">/,
  );
  assert.match(
    html,
    /<select name="project" onchange="this\.form\.submit\(\)">/,
  );
  assert.match(html, /<option value="">All repos<\/option>/);
  assert.match(html, /<option value="beta" selected>beta<\/option>/);
  assert.match(html, /<option value="gamma">gamma<\/option>/);
  // The selected project's own body still renders exactly as the single-project view.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // The parked card carries the project so the sheet routes its reply/prune to it.
  assert.match(html, /<a class="parked-card"[^>]*data-project="beta"/);
});

test("renderStatusPage's repo dropdown states the current scope as the heading trigger, not a native select", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The trigger is the page heading and the switcher in one control: a button, not a
  // native <select>, carrying the full owner/name scope as its label plus a chevron.
  assert.match(html, /<div class="repo-dropdown" data-repo-dropdown>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger" id="repo-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="repo-menu">/,
  );
  assert.match(html, /<span class="repo-label">acme\/tidepool<\/span>/);
  assert.match(html, /<span class="repo-chevron" aria-hidden="true">▾<\/span>/);
  // The full owner/name is the label — never abbreviated to just the repo name.
  assert.doesNotMatch(html, /<span class="repo-label">tidepool<\/span>/);
});

test("the repo dropdown shows owner/name from repo while data-project stays the bare project key", () => {
  const html = renderStatusPage(
    {
      project: "vetinari",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        {
          project: "vetinari",
          runState: "running",
          repo: "jjforge/vetinari",
        },
        { project: "acme-checkout", runState: "idle" },
      ],
      selected: "vetinari",
    },
  );

  // The trigger heading reads the selected repo's owner/name, not its bare key.
  assert.match(
    html,
    /<span class="repo-label">jjforge\/vetinari<\/span>/,
  );
  // Its row shows owner/name too, but routing stays keyed on the bare project key.
  assert.match(
    html,
    /<li class="repo-option selected"[^>]*data-project="vetinari"[^>]*><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">jjforge\/vetinari<\/span>/,
  );
  // A project with no remote falls back to its bare key for the label.
  assert.match(
    html,
    /data-project="acme-checkout"[^>]*><span class="repo-dot idle"[^>]*><\/span><span class="repo-optlabel">acme-checkout<\/span>/,
  );
});

test("renderLandingShell's repo dropdown is the All-repos heading, replacing the h1 + native select", () => {
  const html = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate scope reads "All repos" as the trigger label — the heading itself.
  assert.match(html, /<span class="repo-label">All repos<\/span>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  // The old separate <h1>All repos</h1> title is gone — the trigger is the heading now.
  assert.doesNotMatch(html, /<h1>All repos<\/h1>/);
});

test("the repo dropdown menu rows carry a run-state dot, the owner/name label, and a note", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The menu is a listbox; each repo is an option with a dot in its run-state colour,
  // the full owner/name label, and its run state as the note.
  assert.match(
    html,
    /<ul class="repo-menu" id="repo-menu" role="listbox" aria-label="Switch repo" tabindex="-1" hidden>/,
  );
  assert.match(
    html,
    /<li class="repo-option" role="option" aria-selected="false" data-project="jjforge\/tidepool" tabindex="-1"><span class="repo-dot parked" aria-hidden="true"><\/span><span class="repo-optlabel">jjforge\/tidepool<\/span><span class="repo-note">parked<\/span><\/li>/,
  );
  // The current scope's row is filled (aria-selected + a .selected class), no checkmark.
  // The current scope's row is the fill (a .selected class + aria-selected), with no
  // checkmark glyph inside the row — the fill alone marks it.
  assert.match(
    html,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="acme\/tidepool" tabindex="-1"><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">acme\/tidepool<\/span><span class="repo-note">running<\/span><\/li>/,
  );
});

test("the repo dropdown's All-repos row uses the teal accent dot and the repo count as its note", () => {
  const landing = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate has no run state of its own: its dot is the teal accent (`all`), its
  // note the repo count, and on the landing it is the selected (current) scope.
  assert.match(
    landing,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="" tabindex="-1"><span class="repo-dot all" aria-hidden="true"><\/span><span class="repo-optlabel">All repos<\/span><span class="repo-note">2 repos<\/span><\/li>/,
  );
  // The teal accent is the product accent, so the `all` dot reads --color-primary.
  assert.match(
    landing,
    /\.repo-dot\.all \{ background: var\(--color-primary\); \}/,
  );
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

test("switching scope resets the view: it navigates (fresh sheet) and closed-wave state is per-repo", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "alpha", runState: "idle" },
        { project: "beta", runState: "running" },
      ],
      selected: "beta",
    },
  );
  // A scope switch is a navigation, so the target page loads fresh — the issue sheet
  // starts hidden and nothing is pre-opened.
  assert.match(
    REPO_DROPDOWN_SCRIPT,
    /location\.href = project \? "\/\?project=" \+ encodeURIComponent\(project\) : "\/";/,
  );
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  // Expanded closed-waves are persisted per-repo, so a different scope reads its own
  // (collapsed) set — wave labels aren't unique across repos, so this can't expand the wrong wave.
  assert.match(
    html,
    /const storeKey = "vetinari:closed-waves:" \+ waveBar\.dataset\.project;/,
  );
});

test("renderStatusPage renders archived runs as a collapsible list of wave cards, with no mode control or raw pane (#222)", () => {
  // Pin the timezone so the local-rendered when-clock is deterministic here (the
  // dedicated #102 test covers the divergent-tz case); UTC keeps `22:22:36`.
  const origTZ = process.env.TZ;
  process.env.TZ = "UTC";
  try {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T22-22-36-267Z",
          name: "comms + dashboard",
          startedAt: "2026-02-01T22:22:36.267Z",
          state: "complete",
          issues: 3,
          status: archStatus("101"),
        },
        {
          run: "2026-01-01T00-00-00-000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          state: "interrupted",
          issues: 1,
          status: archStatus("111"),
        },
      ],
    },
  );

  // The shared log-view chrome header (#256) — the .tail-head control bar the
  // live-tail/feed/host-log carry, an "Archived runs" static title and a filter
  // input — replaces the bespoke <h2>Archived runs</h2>.
  assert.doesNotMatch(html, /<h2>Archived runs<\/h2>/);
  assert.match(
    html,
    /<section class="archived-runs"><div class="tail-head"><span class="tail-title tail-title-static">Archived runs<\/span><span class="tail-gap"><\/span><span class="tail-controls"><input type="text" class="tail-filter" placeholder="filter runs…" aria-label="Filter archived runs" data-archive-filter \/><\/span><\/div>/,
  );
  assert.match(html, /<ul class="archive-list" data-project="beta">/);
  // No download/pause .lv-ico buttons on this static, non-downloadable surface (#256).
  const section = html.slice(
    html.indexOf('<section class="archived-runs">'),
    html.indexOf("</section>", html.indexOf('<section class="archived-runs">')),
  );
  assert.doesNotMatch(section, /lv-ico/);
  // A collapsed row renders through the shared `.lv-row` control (not bespoke
  // `.archive-*` chrome): the when-time in the dim `.lv-t` tier, a mapped `.lv-dot`
  // (complete → merged/green), the run name as the brightest `.lv-lead`, and the
  // disposition `state · N issues` as the dim `.lv-verb`.
  assert.match(html, /<li data-run="2026-02-01T22-22-36-267Z">/);
  assert.match(
    html,
    /<button type="button" class="lv-row" aria-expanded="false" aria-controls="archive-body-2026-02-01T22-22-36-267Z"><span class="lv-t">Feb 1, 2026 · 22:22:36<\/span><span class="lv-dot merged"><\/span><span class="lv-msg"><span class="lv-lead">comms \+ dashboard<\/span><span class="lv-verb">complete · 3 issues<\/span><\/span><\/button>/,
  );
  // An unnamed run falls back to its token as the label; issue count pluralizes;
  // interrupted maps to the parked (amber) dot.
  assert.match(
    html,
    /<span class="lv-dot parked"><\/span><span class="lv-msg"><span class="lv-lead">2026-01-01T00-00-00-000Z<\/span><span class="lv-verb">interrupted · 1 issue<\/span><\/span>/,
  );
  // The bespoke `.archive-*` chrome is gone.
  assert.doesNotMatch(html, /archive-name|archive-when|archive-state|archive-dot|archive-toggle|archive-chevron/);
  // No mode control at all — an archived run is a single expandable line (#222).
  assert.doesNotMatch(html, /class="archive-modes"/);
  assert.doesNotMatch(html, /class="archive-mode/);
  assert.doesNotMatch(html, /data-mode=/);
  // …and no run-level raw/log pane — the expanded body is the wave-card grid only.
  assert.doesNotMatch(html, /archive-raw/);
  assert.doesNotMatch(html, /data-pane=/);
  // The expanded body reuses the live wave renderer directly — the run's own chip renders.
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T22-22-36-267Z" hidden>[\s\S]*#101 <small>/,
  );
  // Bodies start collapsed (hidden) and rows render newest-first (order preserved).
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T22-22-36-267Z" hidden>/,
  );
  assert.ok(
    html.indexOf("2026-02-01T22-22-36-267Z") <
      html.indexOf("2026-01-01T00-00-00-000Z"),
    "newest-first",
  );
  // A short list has no show-older control.
  assert.doesNotMatch(html, /<button[^>]*class="archive-show-older"/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("renderStatusPage renders an archived run's when-time in the operator's LOCAL timezone, no UTC suffix (#102)", () => {
  // The gateway runs in the operator's timezone, so the displayed clock localizes.
  // PST is UTC−8 in February: `2026-02-01T22:22:36.267Z` reads `14:22:36` local,
  // and the hardcoded " UTC" suffix is gone (raw-log content, not this chrome, keeps UTC).
  const origTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const html = renderStatusPage(
      { project: "beta", waves: [], parked: [] },
      {
        selected: "beta",
        archivedRuns: [
          {
            run: "2026-02-01T22-22-36-267Z",
            name: "comms + dashboard",
            startedAt: "2026-02-01T22:22:36.267Z",
            state: "complete",
            issues: 1,
            status: archStatus("101"),
          },
        ],
      },
    );
    assert.match(
      html,
      /<span class="lv-t">Feb 1, 2026 · 14:22:36<\/span>/,
    );
    assert.doesNotMatch(html, /lv-t">[^<]*UTC/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("renderStatusPage shows an interrupted run as interrupted and still expands it to its partial waves", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      // A run cut short: wave 1 merged, wave 2 was in flight when it stopped.
      archivedRun: "2026-05-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-05-01T00-00-00-000Z",
          startedAt: "2026-05-01T00:00:00.000Z",
          state: "interrupted",
          issues: 2,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
              {
                // The route reconciles an interrupted run's in-flight wave to the
                // terminal `interrupted` — an archived run never reads as live (#152).
                index: 1,
                status: "interrupted",
                issues: [{ issueNumber: "201", status: "interrupted" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The row reads interrupted — the parked (amber) dot and the `.lv-verb` disposition…
  assert.match(
    html,
    /<span class="lv-dot parked"><\/span><span class="lv-msg"><span class="lv-lead">2026-05-01T00-00-00-000Z<\/span><span class="lv-verb">interrupted · 2 issues<\/span><\/span>/,
  );
  // …and, opened, its body still shows the partial waves it did run — the
  // in-flight wave/issue reconciled to the terminal `interrupted`, never `running`.
  // (The live campaign has no waves, so these chips are the archived run's own.)
  assert.match(html, /#101 <small>completed<\/small>/);
  assert.match(html, /#201 <small>interrupted<\/small>/);
  assert.doesNotMatch(html, /<small>running<\/small>/);
});

test("renderStatusPage opens the archived row named by archivedRun, showing its wave cards (#222)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // The named row opens: its `.lv-row` toggle expanded, its body shown.
  assert.match(
    html,
    /<li class="open" data-run="2026-02-01T00-00-00-000Z">/,
  );
  assert.match(
    html,
    /<button type="button" class="lv-row" aria-expanded="true" aria-controls="archive-body-2026-02-01T00-00-00-000Z"/,
  );
  // The body shows and holds the wave-card grid directly — no mode toggle, no raw pane.
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T00-00-00-000Z">[\s\S]*#101 <small>/,
  );
  assert.doesNotMatch(html, /archive-mode/);
  assert.doesNotMatch(html, /archive-raw/);
  assert.doesNotMatch(html, /data-pane=/);
});

test("renderStatusPage carries no raw-specific archive CSS on phone-width (#222)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // The raw-log pane and mode toggle are gone, so their ≤640px overrides are gone
  // with them — no leftover .archive-raw / .archive-modes / .archive-pane rules.
  assert.doesNotMatch(html, /\.archive-raw/);
  assert.doesNotMatch(html, /\.archive-modes/);
  assert.doesNotMatch(html, /\.archive-pane/);
  assert.doesNotMatch(html, /\.archive-mode/);
});

test("renderStatusPage ships the archived-list client wiring: expand/collapse (one open at a time) and the filter, and nothing raw/log (#222, #256)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );
  // The page embeds the archived-list script…
  assert.ok(html.includes(ARCHIVE_LIST_SCRIPT), "page includes ARCHIVE_LIST_SCRIPT");
  // …a row's shared `.lv-row` head toggles its body open/closed…
  assert.match(ARCHIVE_LIST_SCRIPT, /row\.querySelector\("\.lv-row"\)/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /\.archive-toggle/);
  // …one row open at a time (opening closes the others)…
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /for \(const other of archiveRows\) if \(other !== row && other\.classList\.contains\("open"\)\) closeRow\(other\);/,
  );
  // …and typing in the shared filter hides the non-matching li[data-run] rows over
  // their visible summary text (archiveRowMatches — the feed/host-log filter contract).
  assert.match(ARCHIVE_LIST_SCRIPT, /function archiveRowMatches/);
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /filterEl\.addEventListener\("input", \(\) => \{[\s\S]*row\.hidden = !archiveRowMatches\(row\.querySelector\("\.lv-row"\)\.textContent, filterEl\.value\);/,
  );
  // The dropped show-older cap leaves no show-older wiring behind.
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /showOlder|archive-show-older|archive-older-row/);
  // The raw/log surface is gone: no mode switch, no /archive/log fetch, no line-number
  // deep-links, no filter, no Download JSON, no cap machinery.
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /\/archive\/log/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /archive-raw/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /highlightJsonLine/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /cappedRawRows/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /humanizedRow/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /rawMode|MODE_KEY|localStorage/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /data-archive-raw-save|Download JSON/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /#L|mode=raw/);
});

test("renderStatusPage makes archived campaign chips open the issue sheet against the archived run, read-only", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );
  // The chip carries its issue, project and the run token, so the shared sheet reads
  // the archived run's own log (its turn log lives there, not in the live log).
  assert.match(
    html,
    /data-issue="101" data-project="beta" data-run="2026-02-01T00-00-00-000Z"/,
  );
  // Read-only: an archived chip is never prunable (a finished run has nothing to prune).
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-prunable/);
  // The shared sheet forwards a run token to /api/issue so it can read the archive.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /run \? "&run=" \+ encodeURIComponent\(run\) : ""/,
  );
});

test("renderStatusPage renders every archived run in the scrollable pane, no show-older cap (#256)", () => {
  const runs = Array.from({ length: 22 }, (_, i) => {
    const day = String(22 - i).padStart(2, "0");
    return {
      run: `2026-01-${day}T00-00-00-000Z`,
      startedAt: `2026-01-${day}T00:00:00.000Z`,
      state: "complete" as const,
      issues: 1,
      status: archStatus(String(100 + i)),
    };
  });
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { selected: "beta", archivedRuns: runs },
  );

  // Every row renders — a list longer than the old cap is not truncated…
  assert.equal(
    [...html.matchAll(/<li(?: class="open")? data-run=/g)].length,
    22,
  );
  // …none render hidden (the cap is gone; the pane scrolls instead)…
  assert.doesNotMatch(html, /<li data-run="[^"]*" hidden>/);
  // …and there is no show-older control or its row.
  assert.doesNotMatch(html, /archive-show-older/);
  assert.doesNotMatch(html, /archive-older-row/);
});

test("renderStatusPage omits the campaign name from the meta line for an unnamed run", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });
  assert.doesNotMatch(html, /class="run-name"/);
  assert.doesNotMatch(html, /class="campaign-name"/);
  // The counts still render — an unnamed campaign is still a campaign.
  assert.match(html, /<p class="campaign-meta">0 issues · 1 wave<\/p>/);
});

test("renderStatusPage renders no archived-runs section when a project has none", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { selected: "demo" },
  );
  assert.doesNotMatch(html, /class="archived-runs"/);
  assert.doesNotMatch(html, /class="archived-run"/);
});

test("renderStatusPage omits the project dropdown when no project list is given", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /class="repo-dropdown"/);
  assert.doesNotMatch(html, /class="project-picker"/);
  assert.doesNotMatch(html, /<select name="project"/);
  // A single-project view with no repo list falls back to a plain <h1> heading.
  assert.match(html, /<h1>demo<\/h1>/);
});

test("renderStatusPage uses the jjforge dark palette", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.match(html, /--color-body: #090c10/);
  assert.match(html, /--color-primary: #3fb9b0/);
  assert.match(html, /--color-box-header: #10151b/);
  assert.match(html, /--color-text: #e6edf3/);
  assert.match(html, /background: var\(--color-body\)/);
  assert.doesNotMatch(html, /radial-gradient/);
});

test("renderStatusPage does not render the color legend under the heading", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /Green completed · Yellow parked · Red failure/);
});

test("renderStatusPage makes issue chips tap-friendly for touch devices", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "Add login flow",
            detail: "Agent turn 2 finished; waiting for verification/resume",
          },
        ],
      },
    ],
    parked: [],
  });

  // The chip keeps its hover title and now carries the ids the sheet fetches with.
  assert.match(
    html,
    /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="101"[^>]*data-project="demo"/,
  );
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /el\.addEventListener\("click"/);
});

test("renderStatusPage opens the issue-detail sheet from a chip, fetching /api/issue", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "101", status: "running", name: "Add login flow" },
        ],
      },
    ],
    parked: [],
  });

  // A dismissible sheet, hidden until an issue is opened.
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="issue-detail-close"/);
  // A sticky header (number, status, title, repo · campaign), meta tiles, and the turn log.
  assert.match(html, /class="issue-detail-header"/);
  assert.match(html, /\.issue-detail-header \{[^}]*position: sticky;/);
  assert.match(html, /class="issue-detail-title"/);
  assert.match(html, /class="issue-detail-context"/);
  assert.match(html, /id="issue-detail-turns"/);
  assert.match(html, /id="issue-detail-turnlog"/);
  // Chips open the sheet, which fetches the reconstructed detail.
  assert.match(html, /openIssue\(/);
  assert.match(html, /fetch\("\/api\/issue\?project="/);
  // Dismissible, and reveal keys off a `show` class over the hidden default.
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  assert.match(
    html,
    /getElementById\("issue-detail-close"\)\.addEventListener\("click"/,
  );
});

test("renderStatusPage gives the sheet a WORKTREE tile and turns-with-duration meta (#90)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // A third meta tile carrying the agent's real worktree path — hidden until a
  // fetched detail carries one, so a run without a preserved worktree shows nothing.
  assert.match(
    html,
    /<div class="meta-tile[^"]*" id="issue-detail-worktree-tile" hidden>/,
  );
  assert.match(html, /<span class="meta-label">Worktree<\/span>/);
  assert.match(html, /id="issue-detail-worktree"/);
  // A meta-tile is a flex box, so its display would defeat the UA [hidden] rule;
  // restore the collapse so the worktree tile can hide when the path is absent.
  assert.match(html, /\.meta-tile\[hidden\][^{]*\{ display: none;? \}/);
  // The script reveals the tile only when the detail carries a worktree path…
  assert.match(html, /d\.worktree/);
  // …and presents turns with their working duration (N turns · Mm), not a bare count.
  assert.match(html, /" turn" \+ \(.*\? "" : "s"\) \+ " · "/);
});

test("renderStatusPage renders the turn log newest-first with each turn number in its status colour", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Each turn's number carries the issue's status class, so it reads in the status colour.
  assert.match(html, /"turn-num " \+ .*\bstatus\b/);
  // The turn log region is an ordered list the script fills from the fetched turnLog.
  assert.match(html, /id="issue-detail-turnlog"/);
  assert.match(html, /turnLog/);
  // The status dot palette is shared, so a turn number reuses the same status colours. Each
  // state's colour is `stateColor` (asserted by value there); one structural check confirms the
  // page splices those turn-num rules in, proven once rather than re-pinned per state.
  const turnNumCss = ["completed", "parked", "failure", "running", "unstarted", "pruned", "quarantined"]
    .map((s) => `.turn-num.${s} { color: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(turnNumCss), "the page splices the stateColor-derived turn-num rules");
});

test("renderStatusPage makes the issue-detail sheet a full-width bottom sheet on mobile", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Desktop: a centred sheet. Mobile: pinned full-width to the bottom.
  assert.match(
    html,
    /@media \(max-width: [^)]+\) \{[^}]*\.issue-detail-sheet \{[^}]*width: 100%;/,
  );
  assert.match(html, /\.issue-detail-sheet/);
});

test("renderStatusPage hosts the prune affordance and inline confirm in the tap-detail panel", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "301", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // The panel — not the chip — carries a Prune button and a hidden inline confirm.
  assert.match(
    html,
    /<button type="button" id="prune-start" class="prune-start">Prune<\/button>/,
  );
  assert.match(
    html,
    /<form method="post" action="\/prune" id="prune-confirm"[^>]*hidden>/,
  );
  assert.match(html, /<span class="prune-confirm-text"><\/span>/);
  // The confirm POSTs the existing /prune with confirm=1, carrying taskId+project.
  assert.match(
    html,
    /id="prune-confirm"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?name="confirm" value="1"/,
  );
  assert.match(
    html,
    /<button type="submit" class="prune-confirm-btn">Confirm<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" id="prune-cancel" class="prune-cancel">Cancel<\/button>/,
  );
  // The script keys off the prune data: it fetches the JSON preview, discloses the
  // removed list, POSTs the confirm, then shows a transient "pruning…".
  assert.match(html, /\/prune\?preview/);
  assert.match(html, /prune-confirm-text/);
  assert.match(html, /data-prunable/);
  assert.match(html, /method: "POST"/);
  assert.match(html, /pruning/);
});

test("renderStatusPage hosts a parked reply block with a Resume button in the tap-detail sheet", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The sheet carries a reply block, hidden until the opened issue is parked.
  assert.match(
    html,
    /<div id="issue-detail-reply" class="issue-detail-reply" hidden>/,
  );
  assert.match(html, /id="reply-question"/);
  assert.match(html, /id="reply-options"/);
  // A free-text reply field posts through the existing /answer path, carrying taskId+project.
  assert.match(html, /<form method="post" action="\/answer" id="reply-form">/);
  assert.match(
    html,
    /id="reply-form"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?<textarea name="text"/,
  );
  // Resume submits that form; it is associated by `form=` so it can sit outside the form, beside Prune.
  assert.match(
    html,
    /<button type="submit" form="reply-form" id="reply-resume" class="reply-resume" hidden>Resume<\/button>/,
  );
});

test("renderStatusPage caps the reply textarea so it stays within the sheet/card (#73)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });
  // A width:100% textarea with padding still spilled past the right edge of the sheet
  // and the parked card; max-width:100% caps it against its padded content box so it
  // never overflows and introduces no horizontal scroll on the sheet.
  assert.match(html, /\btextarea \{[^}]*max-width: 100%/);
});

test("renderStatusPage places Resume beside Prune in one sheet-actions row, sized for touch", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { prune: true },
  );

  // Both controls live in the same actions row so they are reachable one-handed together.
  assert.match(
    html,
    /<div class="sheet-actions"><button type="submit" form="reply-form" id="reply-resume"[^>]*>Resume<\/button><div id="prune-panel"/,
  );
  // A 44px tap target for the primary Resume action on a phone.
  assert.match(html, /\.reply-resume \{[^}]*min-height: 44px;/);
  // The actions row is a flex box, so it needs [hidden] restored explicitly or an
  // empty foot (no reply, no prune) would always show its border and padding.
  assert.match(html, /\.sheet-actions\[hidden\][^{]*\{ display: none; \}/);
  // The prune panel is likewise a flex box whose display would defeat the UA
  // [hidden] rule; restore its collapse rule so a non-prunable issue can hide it (#72).
  assert.match(html, /\.prune-panel\[hidden\][^{]*\{ display: none;? \}/);
  // …and the confirm form inside it: its own `display: flex` would defeat the UA
  // [hidden] rule too, so Confirm/Cancel showed by default beside Resume+Prune —
  // four buttons at once. Restore the collapse so they reveal only in the prune
  // step and the default action row is Resume + Prune alone (#90).
  assert.match(html, /\.prune-confirm\[hidden\][^{]*\{ display: none;? \}/);
});

test("renderStatusPage wires the parked reply block: shown when parked, options fill the field", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The reply block reveals only for a parked issue, carrying its ids for /answer.
  assert.match(html, /d\.status === "parked"/);
  assert.match(html, /d\.parked/);
  // Options render as buttons that fill the reply field without submitting it.
  assert.match(html, /"reply-option"/);
  assert.match(html, /replyText\.value = /);
});

test("renderStatusPage gives the parked block a directive heading and labels the turn log (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The parked block leads with a directive heading, not the flat "Reply & resume".
  assert.match(html, /class="reply-heading">PARKED — NEEDS YOUR ANSWER</);
  assert.doesNotMatch(html, /Reply &amp; resume/);
  // The turn log is its own labeled section ("Agent turns"), distinct from the meta tiles.
  assert.match(html, /class="turn-log-heading">Agent turns</);
});

test("renderStatusPage shows the duration once and pluralizes the turn count (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // TURNS now carries the working duration (N turns · Mm), so the separate ELAPSED
  // tile is redundant and gone — no tile, no script ref, no formatter output for it.
  assert.doesNotMatch(html, /id="issue-detail-elapsed"/);
  assert.doesNotMatch(html, /<span class="meta-label">Elapsed<\/span>/);
  assert.doesNotMatch(html, /detailElapsed/);
  // The count pluralizes: "1 turn", "N turns" — never the "1 turns" the POC flags.
  assert.match(html, /" turn" \+ \(.*=== 1 \? "" : "s"\)/);
  assert.match(html, /" · "/);
});

test("renderStatusPage renders reply options as full-width lettered rows (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The options stack one per line as full-width rows, not inline wrapping pills.
  assert.match(
    html,
    /\.reply-options \{[^}]*flex-direction: column;/,
  );
  // Each row is a flex row: a fixed letter margin on the left, the label filling the rest.
  assert.match(html, /\.reply-option \{[^}]*display: flex;/);
  assert.match(html, /\.reply-option-letter \{/);
  // An "A:"/"B)"-style marker in the option is pulled into the letter margin; an
  // option with no marker falls back to a positional A/B/C letter from the index.
  assert.match(html, /option\.match\(\/\^\(\[A-Za-z\]\)\[\.\):\]/);
  assert.match(html, /String\.fromCharCode\(65 \+ /);
  assert.match(html, /"reply-option-letter"/);
  assert.match(html, /"reply-option-label"/);
  // Clicking a row still fills the reply field with the full original option text.
  assert.match(html, /replyText\.value = option/);
});

test("renderStatusPage falls back to a no-JS prune form per prunable issue", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 1,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // Progressive enhancement: a plain server-side form per prunable issue, inside
  // <noscript>, still reaches POST /prune → the preview page → confirm with no JS.
  assert.match(
    html,
    /<noscript>[\s\S]*<form method="post" action="\/prune"[\s\S]*?name="taskId" value="301"[\s\S]*?name="project" value="demo"[\s\S]*<\/noscript>/,
  );
  assert.match(
    html,
    /<noscript>[\s\S]*name="taskId" value="302"[\s\S]*<\/noscript>/,
  );
  // Never a fallback form for a running (in-flight) issue.
  assert.doesNotMatch(html, /name="taskId" value="201"/);
});

test("renderStatusPage omits the prune panel and no-JS fallback unless prune is opted in", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /id="prune-start"/);
  assert.doesNotMatch(html, /<noscript>/);
});

test("renderStatusPage leads with parked issues above the waves when any are parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  assert.match(
    html,
    /<section class="parked-issues"><h2>Parked · <span class="parked-count">1<\/span><\/h2>/,
  );
  // Parked section comes before the wave grid.
  assert.ok(
    html.indexOf('class="parked-issues"') < html.indexOf('class="waves-grid"'),
    "parked should render above the waves",
  );
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
});

test("renderStatusPage opens the issue-detail sheet from a parked row too", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // The whole parked card is a clickable question card carrying the ids the sheet
  // fetches with; its href is the no-JS fallback, and the same wiring opens the sheet
  // from a member row or a parked card (the anchor's default click is prevented).
  assert.match(
    html,
    /<a class="parked-card" href="\/\?project=demo" data-issue="102" data-project="demo"><div class="parked-card-title"><span class="parked-issue">#102<\/span> Need a choice\.<\/div>/,
  );
  assert.match(
    html,
    /querySelectorAll\("\.wave-member\[data-issue\], \.parked-card\[data-issue\]"\)/,
  );
  assert.match(html, /event\.preventDefault\(\); openIssue\(/);
});

test("renderStatusPage omits the parked section entirely when nothing is parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });

  assert.doesNotMatch(html, /Parked issues/);
  assert.doesNotMatch(html, /Nothing parked/);
  assert.doesNotMatch(html, /class="parked-issues"/);
});

test("renderStatusPage orders the top of the page: Parked → campaign-meta → waves (#81)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // Top→bottom order per the design (#81): the Parked section leads, then the
  // campaign-meta line, then the waves — the meta line no longer sits above Parked.
  assert.ok(
    html.indexOf('class="parked-issues"') <
      html.indexOf('class="campaign-meta"'),
    "Parked should render above the campaign-meta line",
  );
  assert.ok(
    html.indexOf('class="campaign-meta"') < html.indexOf('class="waves-grid"'),
    "campaign-meta should render above the waves",
  );
});

test("renderStatusPage collapses closed waves into expandable completed wave chips", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<div class="completed-waves"><div class="completed-wave-bar" data-project="demo">/,
  );
  assert.doesNotMatch(html, /Completed:/);
  // The chip is a toggle button, not a native <details>/<summary>.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">1\/1<\/span><\/button>/,
  );
  assert.match(
    html,
    /\.completed-wave-chip \.check \{ color: var\(--color-green\);/,
  );
  // The closed-wave toggle bar must not stretch: the first wrapped line was rendering
  // taller in Safari.
  assert.match(
    html,
    /\.completed-wave-bar \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/,
  );
  // The open wave still renders its own card in the grid.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span><\/div><\/div>/,
  );
});

test("renderStatusPage labels a single-issue wave with that issue's resolved title, keeping the index", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — config resolution<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage labels a multi-issue wave with its lead issue's title + the extra count", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
          { issueNumber: "202", status: "unstarted", name: "retry policy" },
          { issueNumber: "203", status: "unstarted", name: "log rotation" },
          { issueNumber: "204", status: "unstarted", name: "cache eviction" },
        ],
      },
    ],
    parked: [],
  });

  // Lead title names the wave; the rest collapse to a "+N" (all four still carry
  // their own titles on their chips).
  assert.match(
    html,
    /<h2 class="wave-label">Wave 2 — config resolution \+3<\/h2><div class="wave-meta"><span class="wave-tally">0\/4<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage keeps a closed wave's chip compact and puts the issue titles on its card", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          {
            issueNumber: "101",
            status: "completed",
            name: "config resolution",
          },
          { issueNumber: "102", status: "completed", name: "retry policy" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The compact chip carries only "Wave N" + the merged tally — no lead title.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
  // The lead title + "+N" reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+1<\/h2><div class="wave-meta"><span class="wave-tally">2\/2<\/span><span class="wave-status closed">closed<\/span>/,
  );
});

test("renderStatusPage escapes a wave name derived from an issue title", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "fix <script> & things",
          },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1 — fix &lt;script&gt; &amp; things<\/h2>/,
  );
});

test("renderStatusPage keeps the bare wave index when no issue title is resolved yet", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage renders a campaign meta line of name · issues · waves, omitted with no campaign (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running" },
          { issueNumber: "202", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });
  // Three issues across two waves, under the named campaign.
  assert.match(
    html,
    /<p class="campaign-meta"><span class="campaign-name">gateway work<\/span> · 3 issues · 2 waves<\/p>/,
  );

  // With no campaign at all (no waves), the meta line is omitted entirely.
  const empty = renderStatusPage({ project: "demo", waves: [], parked: [] });
  assert.doesNotMatch(empty, /class="campaign-meta"/);
});

test("renderStatusPage lays open waves out in a grid, accenting the running wave (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });
  // Open wave cards sit in a responsive grid.
  assert.match(html, /<div class="waves-grid"><section class="wave running">/);
  assert.match(
    html,
    /\.waves-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(20rem, 1fr\)\);/,
  );
  // A running wave carries the status-coloured (blue) top accent; an unstarted one the dim default (§3).
  assert.match(html, /\.wave \{[^}]*border-top: 3px solid var\(--color-dim\);/);
  assert.match(
    html,
    /\.wave\.running \{ border-top-color: var\(--color-blue\); \}/,
  );
  assert.match(html, /<section class="wave unstarted">/);
});

test("renderStatusPage's parked card carries no inline reply form — the reply is in the sheet (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "2025-06-15T09:00:00.000Z",
        branch: "agent/102",
        description: "Need a choice.",
        options: ["A", "B"],
      },
    ],
  });
  // The card is a single clickable anchor with a meta line — no <form>, no <textarea>,
  // no per-issue "Send response" button. The only /answer form on the page is the sheet's.
  const card = html.slice(
    html.indexOf('class="parked-card"'),
    html.indexOf("</a>", html.indexOf('class="parked-card"')),
  );
  assert.doesNotMatch(card, /<form|<textarea|Send response/);
  assert.match(
    html,
    /waiting <span class="parked-waited" data-parked-at="2025-06-15T09:00:00.000Z">…<\/span> · blocked/,
  );
  // Exactly one /answer form remains — the sheet's reply-form.
  assert.equal(html.match(/action="\/answer"/g)?.length, 1);
});

test("formatStatusText summarizes waves, issue chips (with names), and the parked section", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "closed",
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
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/655",
        description: "?",
        options: [],
      },
    ],
  });

  assert.match(text, /jjforge — status/);
  assert.match(text, /Wave 1\/2 ✅ closed/);
  assert.match(text, /✅ #436 Fix login redirect/);
  assert.match(text, /Wave 2\/2 ▶️ running/);
  assert.match(text, /🔄 #640 Add prune-out/);
  // No name available → chip is just the status + number.
  assert.match(text, /⏸ #655$/m);
  assert.match(text, /1 awaiting your reply/);
  assert.match(text, /#655 — blocked/);
});

test("formatStatusText labels a wave-parked wave and a quarantined issue (ADR 0013)", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "wave-parked",
        issues: [
          { issueNumber: "611", status: "completed", name: "Fix parser" },
          { issueNumber: "640", status: "quarantined", name: "Add prune-out" },
        ],
      },
    ],
    parked: [],
  });

  // The held wave reads its own label, distinct from an issue parked.
  assert.match(text, /Wave 1\/1 ⏸ wave-parked/);
  // The quarantined issue carries its own emoji + status word.
  assert.match(text, /🚧 #640 Add prune-out/);
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

test("renderStatusPage renders the landing live-bar top-right, not the old refresh widget (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "closed", issues: [] }],
    parked: [],
  });

  // The live-bar replaces the fixed-interval Refresh widget: a dot-only live indicator and
  // an "updated Ns ago" readout — the same shared control the landing renders (#81). The
  // indicator shows no visible "Live" text (its state is an accessible label). The
  // page-level pause is gone (#210), so the bar carries no pause button; the settings gear
  // now rides the end of the bar after the readout (#215), so the readout no longer closes it.
  assert.match(
    html,
    /<div class="live-bar"[^>]*><span class="live-indicator" data-live-state="live" aria-label="Live"><\/span><span class="updated" data-updated>[^<]*<\/span>/,
  );
  assert.doesNotMatch(html, /id="pause"/);
  // The old interval widget is gone entirely.
  assert.doesNotMatch(html, /id="refresh-seconds"/);
  assert.doesNotMatch(html, /id="refresh-enabled"/);
  assert.doesNotMatch(html, /class="refresh"/);
  assert.doesNotMatch(html, /sandcastle-status-refresh/);
  // The h1 drops the " status" wording; with no dropdown it is just the project name.
  assert.match(
    html,
    /<div class="page-top"><h1>demo<\/h1><div class="live-bar"/,
  );
  assert.match(html, /\.page-top \{ display: flex;/);
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

test("renderStatusPage updates live off /api/events, soft-refreshing on a ping unless composing (#79, #131)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // One SSE stream drives updates as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // Soft-refresh, not a full reload (#131): a live tick re-fetches this page and swaps only
  // the #live-region, so the issue sheet, its open compose, and scroll survive — worst over
  // the tailnet, where a full reload blanked the page. The one deliberate reload on the page
  // is the settings gear's festive toggle (#193, #215 — server-rendered labels re-render only
  // on a reload); the live-event soft-refresh path itself never reloads.
  const softRefreshFn = html.match(/const softRefresh = async \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(softRefreshFn, "the soft-refresh function is present");
  assert.doesNotMatch(softRefreshFn[0], /location\.reload\(\)/);
  assert.match(html, /id="live-region"/);
  assert.match(html, /fetch\(location\.href/);
  assert.match(html, /DOMParser/);
  assert.match(html, /getElementById\("live-region"\)/);
  assert.match(html, /softRefresh\(\)/);
  // Guarded: a reply being composed in any textarea freezes the refresh so it is never lost.
  assert.match(html, /const isComposing = \(\) =>/);
  assert.match(
    html,
    /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/,
  );
  assert.match(html, /if \(isComposing\(\)\) return;/);
  // The page-level pause is gone (#210): no pause button, no paused/buffered state — a live
  // event always soft-refreshes unless composing.
  assert.doesNotMatch(html, /pauseBtn/);
  assert.doesNotMatch(html, /let paused/);
  // The "updated Ns ago" readout is `freezeIntent`'s `updatedText` (dashboard-visual-state.ts,
  // asserted directly there), single-sourced into this page and written onto the readout.
  assert.match(html, /function freezeIntent/);
  assert.match(
    html,
    /updatedEl\.textContent = freezeIntent\(\{ lastUpdate, now: Date\.now\(\) \}\)\.updatedText/,
  );
});

test("renderStatusPage marks prunable chips with prune data and never puts a prune control on a chip", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "101", status: "completed" }],
        },
        {
          index: 1,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 2,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // Each member row carries its issue and project; only a still-prunable one is flagged
  // prunable, so the tap-detail panel knows whether to offer a Prune button.
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="301"[^>]*data-project="demo"[^>]*data-prunable="1"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="302"[^>]*data-project="demo"[^>]*data-prunable="1"/,
  );
  // The completed (banked) and current-wave-in-flight (running) rows are not prunable.
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-prunable/);
  assert.doesNotMatch(html, /data-issue="201"[^>]*data-prunable/);
  // Prune moved off the rows entirely: no inline ✂️ and no per-row prune form.
  assert.doesNotMatch(html, /✂️/);
  assert.doesNotMatch(html, /class="prune-form"/);
  assert.doesNotMatch(html, /class="chip-group"/);
  assert.doesNotMatch(html, /class="prune-btn"/);
});

test("renderStatusPage omits the prune control unless the page opts into it", () => {
  // The control is opt-in: both the standalone and the aggregated server pass
  // `prune: true`, but a bare render (e.g. the empty-registry page) shows none.
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /action="\/prune"/);
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

test("renderStatusPage renders closed waves as a compact toggle row of chip buttons", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          { issueNumber: "101", status: "completed" },
          { issueNumber: "102", status: "completed" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave is a toggle button (no native <details>/<summary>), carrying the
  // compact "Wave N" label + its merged/total tally + a chevron affordance, wired to
  // its card via aria-controls and defaulting to collapsed (aria-expanded="false").
  assert.doesNotMatch(html, /<details class="completed-wave"/);
  assert.doesNotMatch(html, /<summary/);
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
});

test("renderStatusPage renders each expanded closed wave's full card in the grid before the open waves", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          { issueNumber: "101", status: "completed", name: "cart persists" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave gets the SAME wave-card treatment as an open wave — a CLOSED pill,
  // its merged/total, and the merged member list — living in the waves-grid under a
  // stable id, hidden until its chip toggles it open.
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — cart persists<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status closed">closed<\/span><\/div><\/div>/,
  );
  // The closed card renders inside the same grid, positioned before the open running wave.
  const grid = html.match(
    /<div class="waves-grid">([\s\S]*?)<\/div>\s*(?:<section class="archived|<div id="issue-detail"|<noscript|<script)/,
  );
  assert.ok(grid, "expected a waves-grid");
  assert.ok(
    grid[1].indexOf('id="closed-wave-0"') < grid[1].indexOf("Wave 2"),
    "closed card should precede the open wave",
  );
});

test("renderStatusPage gives the closed-wave chip a chevron and a green accent when expanded", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The chevron is CSS keyed off aria-expanded (collapsed › → expanded ⌄), and an
  // expanded chip takes a green accent border.
  assert.match(html, /\.completed-wave-chip::after \{[^}]*content: "›"/);
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\]::after \{[^}]*content: "⌄"/,
  );
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\] \{[^}]*border-color: var\(--color-green\)/,
  );
});

test("renderStatusPage persists the expanded closed-wave set across a live reload", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The toggle row carries its project so the client can key the persisted open-set
  // per repo, and the script reads/writes it through storage so a /api/events reload
  // does not silently collapse everything the user opened.
  assert.match(html, /<div class="completed-wave-bar" data-project="beta">/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /completed-wave-chip/);
});

test("renderStatusPage degrades the closed-wave toggle without JS", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // Without JS the cards can never be toggled open, so a <noscript> reveals every
  // closed card in the grid and hides the inert toggle bar — the content stays reachable.
  assert.match(
    html,
    /<noscript><style>[^<]*\.completed-wave-bar \{ display: none;[^<]*\.wave\.closed\[hidden\] \{ display: block;/,
  );
});

test("renderStatusPage renders an archived run's closed waves as full cards, not colliding toggle ids", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          // A finished run — every wave is closed.
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [
                  { issueNumber: "101", status: "completed", name: "old work" },
                ],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The live run's closed wave still uses the toggle (chip + hidden card, id closed-wave-0).
  assert.match(html, /aria-controls="closed-wave-0"/);
  // The archived row's campaign pane renders its closed wave as a full, always-expanded
  // card — no second toggle bar and no duplicated id="closed-wave-0" that would hijack
  // the live card.
  const bodyStart = html.indexOf('class="archive-body"');
  const body = html.slice(bodyStart, html.indexOf("</li>", bodyStart));
  assert.doesNotMatch(body, /completed-wave-bar/);
  assert.doesNotMatch(body, /id="closed-wave-0"/);
  assert.match(
    body,
    /<section class="wave closed"><div class="wave-head"><h2 class="wave-label">Wave 1 — old work<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Exactly one element carries the toggle id across the whole page (no duplicate ids).
  assert.equal(html.split('id="closed-wave-0"').length - 1, 1);
});
