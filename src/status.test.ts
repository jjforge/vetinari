import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { appendedEvents, buildAllStatus, buildFeed, buildLanding, buildStatus, buildStatusWithIssueNames, campaignRunning, DASHBOARD_PALETTE_CSS, describeEvent, extractParkedDetails, formatFeedEvent, formatStatusText, ISSUE_DETAIL_SHEET_SCRIPT, ISSUE_DETAIL_SHEET_STYLES, issueDetailSheetMarkup, lastEventText, listArchivedRuns, parkedReplyFor, parseCarveClosure, reconstructIssueDetail, reduceCampaign, renderLandingShell, renderStatusPage, selectStatus, serveAllStatus, stateColor, summarizeRun } from "./status.ts";
import type { CampaignStatus } from "./status.ts";
import type { AddressInfo } from "node:net";
import { register, type ProjectPointer } from "./registry.ts";

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

const writeJsonl = (path: string, events: unknown[]) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const pointerFor = (project: string, dir: string): ProjectPointer => ({ project, projectRoot: join(dir, "root"), baseLocation: dir });

const seedState = (dir: string, events: unknown[]) => {
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);
};

test("buildLanding builds a per-project card for a live campaign", () => {
  const base = join(tmpdir(), `sctdd-landing-card-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    { ts: "2025-01-02T08:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"], ["301"]], name: "gateway work" },
    { ts: "2025-01-02T08:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-02T08:02:00.000Z", event: "green", taskId: "101" },
    { ts: "2025-01-02T08:03:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-02T08:04:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
    { ts: "2025-01-02T08:05:00.000Z", event: "queue-start", taskIds: ["201"] },
    { ts: "2025-01-02T08:06:00.000Z", event: "turn", taskId: "201", turn: 2, summary: "Writing the failing test" },
  ]);

  const { projects } = buildLanding([pointerFor("demo", dir)], new Date("2025-01-02T12:00:00.000Z"));
  assert.equal(projects.length, 1);
  const card = projects[0];
  assert.equal(card.project, "demo");
  assert.equal(card.runState, "running");
  assert.equal(card.campaignName, "gateway work");
  // Wave 1 is closed and banked; wave 2 is the one in flight — "2 of 3".
  assert.deepEqual(card.wave, { current: 2, total: 3 });
  // One of three issues has merged.
  assert.equal(card.percentMerged, 33);
  // 201 is in the running wave; 301 is a future-wave issue still queued; 101 is banked.
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 1 });
  // The last operator-facing line is the agent's own turn summary (ADR 0009).
  assert.equal(card.lastEvent, "Writing the failing test");
});

test("buildLanding's card counts the live plan, not carved chips", () => {
  const base = join(tmpdir(), `sctdd-landing-carved-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    { ts: "2025-01-02T08:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"], ["301"]], name: "gateway work" },
    { ts: "2025-01-02T08:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-02T08:02:00.000Z", event: "green", taskId: "101" },
    { ts: "2025-01-02T08:03:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-02T08:04:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
    { ts: "2025-01-02T08:05:00.000Z", event: "queue-start", taskIds: ["201"] },
    // The future, unstarted wave 301 is carved out — a display ghost, not live work.
    { ts: "2025-01-02T08:06:00.000Z", event: "carve", target: "301", removed: ["301"] },
  ]);

  const [card] = buildLanding([pointerFor("demo", dir)], new Date("2025-01-02T12:00:00.000Z")).projects;

  // Two live waves remain (101 closed, 201 running); the carved-out 301 wave and its
  // chip do not inflate the count, the "queued" tally, or drag down percent merged.
  assert.deepEqual(card.wave, { current: 2, total: 2 });
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 0 });
  assert.equal(card.percentMerged, 50);
  assert.equal(card.runState, "running");
});

test("buildLanding sums the counters, reads an idle project's last campaign, and skips a stale one", () => {
  const base = join(tmpdir(), `sctdd-landing-agg-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    { ts: "2025-06-15T08:00:00.000Z", event: "campaign-start", batches: [["101", "102"], ["201"], ["301"]] },
    { ts: "2025-06-14T09:00:00.000Z", event: "green", taskId: "102" },
    { ts: "2025-06-15T09:00:00.000Z", event: "green", taskId: "101" },
    { ts: "2025-06-15T09:05:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101", "102"], held: [] },
    { ts: "2025-06-15T09:06:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
    { ts: "2025-06-15T09:07:00.000Z", event: "queue-start", taskIds: ["201"] },
  ]);
  // Beta has no live run, only an archived campaign — it must read idle with that campaign.
  seedState(betaDir, []);
  mkdirSync(join(betaDir, "logs", "archive"), { recursive: true });
  writeJsonl(join(betaDir, "logs", "archive", "orchestrator-2025-06-10T00-00-00.jsonl"), [
    { ts: "2025-06-10T00:00:00.000Z", event: "campaign-start", batches: [["501"]], name: "old work" },
    { ts: "2025-06-10T00:05:00.000Z", event: "campaign-batch-done", index: 0, merged: ["501"], held: [] },
    { ts: "2025-06-10T00:06:00.000Z", event: "campaign-done", batches: 1 },
  ]);

  const { counters, projects } = buildLanding(
    [pointerFor("alpha", alphaDir), pointerFor("beta", betaDir), pointerFor("ghost", join(base, "gone"))],
    new Date("2025-06-15T12:00:00.000Z"),
  );

  // The stale registration is skipped, never fatal.
  assert.deepEqual(projects.map((p) => p.project), ["alpha", "beta"]);
  // Counters sum across live projects; merged-today counts only 101 (102 merged yesterday).
  assert.deepEqual(counters, { working: 1, parked: 0, queued: 1, mergedToday: 1 });

  const beta = projects[1];
  assert.equal(beta.runState, "idle");
  assert.equal(beta.campaignName, "old work");
  assert.equal(beta.wave, null);
  assert.match(beta.lastEvent, /^Last run: campaign · 1 issue · complete$/);
});

test("an idle project's merged % and merged-today read its latest archived run, not the cleared live log (#70)", () => {
  const base = join(tmpdir(), `sctdd-landing-idle-archive-${Date.now()}`);
  const dir = join(base, "beta");
  // Idle: the run finished, so its live log is empty and its work is in the archive.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // A completed run that merged both its issues today.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"), [
    { ts: "2026-06-15T09:00:00.000Z", event: "campaign-start", batches: [["501"], ["502"]], name: "shipped" },
    { ts: "2026-06-15T09:05:00.000Z", event: "campaign-batch-done", index: 0, merged: ["501"] },
    { ts: "2026-06-15T09:10:00.000Z", event: "campaign-batch-done", index: 1, merged: ["502"] },
    { ts: "2026-06-15T09:11:00.000Z", event: "campaign-done", batches: 2 },
  ]);

  const { counters, projects } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
  const [card] = projects;
  assert.equal(card.runState, "idle");
  // Both issues merged, so the idle card reads 100% — not the hardcoded 0%.
  assert.equal(card.percentMerged, 100);
  // And both merges count toward "merged today", read from the archived run.
  assert.equal(counters.mergedToday, 2);
});

test("an idle project whose latest archived run merged on an earlier day counts 0 toward merged-today (#70)", () => {
  const base = join(tmpdir(), `sctdd-landing-idle-archive-old-${Date.now()}`);
  const dir = join(base, "beta");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-10T00-00-00-000Z.jsonl"), [
    { ts: "2026-06-10T09:00:00.000Z", event: "campaign-start", batches: [["501"]], name: "older" },
    { ts: "2026-06-10T09:05:00.000Z", event: "campaign-batch-done", index: 0, merged: ["501"] },
    { ts: "2026-06-10T09:06:00.000Z", event: "campaign-done", batches: 1 },
  ]);

  const { counters, projects } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
  // Fully merged run → 100% on the card, but merged five days ago → nothing today.
  assert.equal(projects[0].percentMerged, 100);
  assert.equal(counters.mergedToday, 0);
});

test("buildFeed merges every project's narratable events into one newest-first, repo-prefixed feed", () => {
  const base = join(tmpdir(), `sctdd-feed-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    { ts: "2025-03-01T08:00:00.000Z", event: "campaign-start", batches: [["101"]], name: "alpha work" },
    // Machine noise carries no narration and must not surface as a feed row.
    { ts: "2025-03-01T08:00:30.000Z", event: "sandbox", taskId: "101" },
    { ts: "2025-03-01T08:02:00.000Z", event: "green", taskId: "101" },
  ]);
  seedState(betaDir, [{ ts: "2025-03-01T08:01:00.000Z", event: "parked", taskId: "201", reason: "needs a choice" }]);

  const feed = buildFeed([pointerFor("alpha", alphaDir), pointerFor("beta", betaDir), pointerFor("ghost", join(base, "gone"))]);

  // Newest-first across projects; the stale registration and the machine-noise event are both absent.
  assert.deepEqual(
    feed.map((f) => f.text),
    ["alpha — #101 merged", "beta — #201 parked: needs a choice", "alpha — Campaign “alpha work” started"],
  );
  // Each row carries the time and the event kind alongside the sentence.
  assert.equal(feed[0].ts, "2025-03-01T08:02:00.000Z");
  assert.equal(feed[0].kind, "green");
  assert.equal(feed[0].project, "alpha");
});

test("buildLanding collects every parked question across repos, oldest first", () => {
  const base = join(tmpdir(), `sctdd-landing-parked-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [{ ts: "2025-06-15T08:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  seedState(betaDir, [{ ts: "2025-06-15T08:00:00.000Z", event: "campaign-start", batches: [["301"]] }]);
  // Alpha's question was parked more recently than beta's — beta must sort first.
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({ taskId: "101", parkedAt: "2025-06-15T09:00:00.000Z", reason: "blocked", branch: "agent/101", question: "Should the counter live-update?\n\nOptions:\n- A\n- B" }),
  );
  writeFileSync(
    join(betaDir, "parked", "301.json"),
    JSON.stringify({ taskId: "301", parkedAt: "2025-06-14T09:00:00.000Z", reason: "blocked", branch: "agent/301", question: "Which colour for the badge?" }),
  );

  const { parked } = buildLanding([pointerFor("alpha", alphaDir), pointerFor("beta", betaDir)], new Date("2025-06-15T12:00:00.000Z"));

  // Oldest-first across repos: beta (yesterday) before alpha (this morning).
  assert.deepEqual(
    parked.map((p) => ({ project: p.project, issueNumber: p.issueNumber, parkedAt: p.parkedAt })),
    [
      { project: "beta", issueNumber: "301", parkedAt: "2025-06-14T09:00:00.000Z" },
      { project: "alpha", issueNumber: "101", parkedAt: "2025-06-15T09:00:00.000Z" },
    ],
  );
  // The full question travels with the row.
  assert.equal(parked[0].question, "Which colour for the badge?");
  assert.equal(parked[1].question, "Should the counter live-update?");
});

test("buildAllStatus builds one status per live project and skips a stale one", () => {
  const base = join(tmpdir(), `sctdd-all-status-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "queue-done", outcomes: { "101": "green" } },
  ]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"]] }]);

  const statuses = buildAllStatus([
    pointerFor("alpha", alphaDir),
    pointerFor("beta", betaDir),
    // A stale registration whose base location was moved/deleted — must be skipped, not throw.
    pointerFor("ghost", join(base, "gone")),
  ]);

  assert.deepEqual(statuses.map((s) => s.project), ["alpha", "beta"]);
  assert.deepEqual(
    statuses[0].waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      ["101", "completed"],
      ["102", "unstarted"],
    ],
  );
  assert.deepEqual(statuses[1].waves[0].issues.map((i) => i.issueNumber), ["201"]);
});

test("serveAllStatus serves the aggregated site, selecting the project from the query param", async () => {
  const configDir = join(tmpdir(), `sctdd-serve-all-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    // A bare open lands on the all-repos shell; its dropdown lists both projects with All repos current.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);

    const beta = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    assert.match(beta, /<option value="beta" selected>/);
    // Beta's own campaign (issue 201) renders in the body, not alpha's issue 101.
    assert.match(beta, /#201 <small>/);
    assert.doesNotMatch(beta, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

// The set of palette tokens defined by a `:root { … }` block, and the set of
// `var(--token)` references anywhere in a page — the two must agree, or a surface
// references a colour that never resolves (the #78 class of bug).
const definedTokens = (css: string) => new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
const referencedTokens = (html: string) => new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

test("the dashboard palette is one shared source defining every state token at its spec hex (#83)", () => {
  // §1: the six ADR-0007 states plus the carve action, each at its exact hex.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-blue: #6cb6ff/); // running
  assert.match(DASHBOARD_PALETTE_CSS, /--color-yellow: #c8a24e/); // parked
  assert.match(DASHBOARD_PALETTE_CSS, /--color-failure: #f85149/); // failure — distinct red
  assert.match(DASHBOARD_PALETTE_CSS, /--color-dim: #5f6b78/); // unstarted / idle grey
  assert.match(DASHBOARD_PALETTE_CSS, /--color-green: #3fb984/); // completed
  assert.match(DASHBOARD_PALETTE_CSS, /--color-carved: #a371f7/); // carved
  assert.match(DASHBOARD_PALETTE_CSS, /--color-red: #f79287/); // carve action — a control, never a state
  // The carve action and the failure state are deliberately different reds.
  assert.notEqual("#f85149", "#f79287");
  // The teal product accent is present but is not a state colour.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-primary: #3fb9b0/);
});

test("both the landing and the campaign page emit the one shared palette, and every colour they reference resolves (#78, #83)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage({ project: "beta", waves: [], parked: [] }, { carve: true });
  // The palette is included verbatim by both surfaces — one source, not a per-renderer copy.
  assert.ok(landing.includes(DASHBOARD_PALETTE_CSS), "landing includes the shared palette");
  assert.ok(campaign.includes(DASHBOARD_PALETTE_CSS), "campaign page includes the shared palette");
  // Every colour token either page references is actually defined — so `--color-carved`
  // (and every other token) resolves identically on `/` and `/?project=…`, not merely
  // referenced (the blind spot #78's original rule-string test had).
  const defined = definedTokens(DASHBOARD_PALETTE_CSS);
  for (const page of [landing, campaign]) {
    for (const token of referencedTokens(page)) {
      assert.ok(defined.has(token), `${token} is referenced but never defined in the shared palette`);
    }
  }
  // The concrete #78 repro: carved is referenced on the landing (feed, dots, turn log) and resolves.
  assert.ok(referencedTokens(landing).has("--color-carved"), "landing references --color-carved");
  assert.ok(defined.has("--color-carved"), "--color-carved resolves");
});

test("renderLandingShell mounts the cross-project feed under the cards and hides it on mobile", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The feed container sits after the cards and is client-rendered off /api/feed.
  assert.match(html, /id="feed"/);
  assert.match(html, /\/api\/feed/);
  assert.ok(html.indexOf('id="cards"') < html.indexOf('id="feed"'), "the feed renders after the cards");
  // The feed is cut on a phone.
  assert.match(html, /@media \(max-width: 640px\)[^}]*\{[\s\S]*\.feed \{ display: none; \}/);
});

test("renderLandingShell parked counter expands a cross-repo parked queue in place", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The parked counter is an interactive toggle, unlike the other three counters —
  // a button controlling the queue panel, inert (disabled) until the client learns
  // there is at least one parked question.
  assert.match(html, /<button[^>]*class="counter counter-toggle"[^>]*data-counter="parked"[^>]*disabled[^>]*aria-controls="parked-queue"/);
  // The queue panel sits between the counters and the cards, so expanding it pushes
  // the cards down while keeping them visible; it starts hidden.
  assert.match(html, /<section id="parked-queue"[^>]*hidden/);
  assert.ok(html.indexOf('id="parked-queue"') < html.indexOf('id="cards"'), "parked queue renders above the cards");
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
  assert.match(html, /id="carve-panel"/);
  // openIssue is defined here, and a parked row opens it in place — the click is
  // intercepted so the row never does the full navigation to the campaign page.
  assert.match(html, /const openIssue = async \(project, issue, carvable\)/);
  assert.match(html, /row\.addEventListener\("click", \(event\) => \{ event\.preventDefault\(\); openIssue\(p\.project, p\.issueNumber, true\); \}\)/);
  // The sheet's collapse rules are present so a flex display can't defeat [hidden].
  assert.match(html, /\.issue-detail\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.carve-panel\[hidden\] \{ display: none; \}/);
  // The status dot colours are scoped to .dot so they don't tint the run-state pills.
  assert.match(html, /\.dot\.parked \{ background: var\(--color-yellow\); \}/);
});

test("the issue-detail sheet markup, CSS, and script are defined once and shared by both pages (#76)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  // The campaign page renders the sheet with its carve panel when carve is on and
  // without it otherwise; the landing always hosts the carve-enabled sheet.
  const campaignCarve = renderStatusPage({ project: "beta", waves: [], parked: [] }, { carve: true });
  const campaignPlain = renderStatusPage({ project: "beta", waves: [], parked: [] });

  // Markup: one helper, rendered verbatim by both pages. The landing and the
  // carve-enabled campaign page share the carve-panel variant; a plain campaign
  // page shares the no-carve variant.
  assert.ok(landing.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignCarve.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPlain.includes(issueDetailSheetMarkup(false)));
  // The no-carve variant has no carve panel; the carve variant does.
  assert.ok(!issueDetailSheetMarkup(false).includes("carve-panel"));
  assert.ok(issueDetailSheetMarkup(true).includes('id="carve-panel"'));

  // CSS: one definition of the sheet styles, included by both pages verbatim.
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".issue-detail-sheet {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".turn-log {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".sheet-actions {"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_STYLES));
  assert.ok(campaignCarve.includes(ISSUE_DETAIL_SHEET_STYLES));

  // Script: one definition of the sheet behaviour (openIssue/renderDetail/
  // renderReply/closeSheet/carve wiring), included by both pages verbatim.
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("const openIssue = async (project, issue, carvable)"));
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("const closeSheet = () =>"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_SCRIPT));
  assert.ok(campaignCarve.includes(ISSUE_DETAIL_SHEET_SCRIPT));

  // The hand-sync note is gone now that the sheet has a single source.
  assert.ok(!landing.includes("#76"));
  assert.ok(!landing.includes("kept in sync"));
});

test("renderLandingShell colours each activity event kind by category (#78)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each feed row's kind carries a category class so it reads in its colour.
  assert.match(html, /"feed-kind " \+ feedKindClass\(e\.kind\)/);
  // The classifier maps the orchestrator's event kinds to comms categories.
  assert.match(html, /const feedKindClass = /);
  assert.match(html, /\.feed-kind\.success \{ color: var\(--color-green\); \}/);
  assert.match(html, /\.feed-kind\.attention \{ color: var\(--color-yellow\); \}/);
  assert.match(html, /\.feed-kind\.progress \{ color: var\(--color-blue\); \}/);
  assert.match(html, /\.feed-kind\.failure \{ color: var\(--color-red\); \}/);
  assert.match(html, /\.feed-kind\.carved \{ color: var\(--color-carved\); \}/);
});

test("renderLandingShell colours each project card's highlight by run state (#75)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card element carries its run-state class...
  assert.match(html, /el\("a", "card " \+ p\.runState\)/);
  // ...and per-state border-top-color rules tint the highlight to match the pill.
  assert.match(html, /\.card\.parked \{ border-top-color: var\(--color-yellow\); \}/);
  assert.match(html, /\.card\.running \{ border-top-color: var\(--color-blue\); \}/);
  assert.match(html, /\.card\.idle \{ border-top-color: var\(--color-text-light-2\); \}/);
});

test("renderLandingShell draws each card a run-state-coloured progress bar sized by percent merged (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card renders a progress track with a fill sized to percentMerged and classed by run state,
  // sitting beneath the wave/percent meta line.
  assert.match(html, /el\("div", "progress-fill " \+ p\.runState\)/);
  assert.match(html, /\.style\.width = p\.percentMerged \+ "%"/);
  // The fill is coloured by run state: running blue, parked yellow, completed green; idle stays grey.
  assert.match(html, /\.progress-fill\.running \{ background: var\(--color-blue\); \}/);
  assert.match(html, /\.progress-fill\.parked \{ background: var\(--color-yellow\); \}/);
  assert.match(html, /\.progress-fill\.completed \{ background: var\(--color-green\); \}/);
});

test("renderLandingShell renders the card tally as status-dot chips, not plain text (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The tally builds one pill chip per bucket, each with a status dot scoped to .dot.
  assert.match(html, /el\("span", "tally-chip"\)/);
  assert.match(html, /el\("span", "dot " \+ /);
  // The chip treatment matches the campaign page's chips — a bordered pill.
  assert.match(html, /\.tally-chip \{[^}]*border-radius: 999px/);
  // The queued dot is neutral grey; running/parked reuse the shared .dot colours.
  assert.match(html, /\.dot\.queued \{ background: var\(--color-text-light-2\); \}/);
  // The old plain-text tally string is gone.
  assert.doesNotMatch(html, /" running · " \+ p\.tally\.parked/);
});

test("renderLandingShell colours the counter values and highlights the parked counter when it has questions (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter value reads in its status colour: working blue, parked yellow, merged-today green; queued stays neutral.
  assert.match(html, /\[data-counter="working"\] \.counter-value \{ color: var\(--color-blue\); \}/);
  assert.match(html, /\[data-counter="parked"\] \.counter-value \{ color: var\(--color-yellow\); \}/);
  assert.match(html, /\[data-counter="mergedToday"\] \.counter-value \{ color: var\(--color-green\); \}/);
  // The parked counter carries a gold border only while it is actionable — enabled, i.e. parked > 0.
  assert.match(html, /\.counter-toggle\[data-counter="parked"\]:not\(:disabled\) \{[^}]*border-color: var\(--color-yellow\)/);
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
  assert.match(html, /issues closed/);
});

test("renderLandingShell wires live SSE updates, an updated-ago readout, and a buffered pause", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // Subscribes to the one-way SSE stream and re-reads the landing as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // A live/paused indicator and an "updated Ns ago" readout live in the toolbar header.
  assert.match(html, /data-live-state/);
  assert.match(html, /data-updated/);
  // A pause control that freezes presentation while still collecting, flushing on resume.
  assert.match(html, /id="pause"/);
  // Pause must not tear the stream down — it is a client-side presentation freeze (ADR 0008).
  assert.match(html, /paused/);
});

test("serveAllStatus GET / serves the all-repos landing shell, not a server-rendered campaign", async () => {
  const configDir = join(tmpdir(), `sctdd-landing-shell-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const root = await res.text();
    // The dropdown switches All repos ↔ a project; All repos is the landing selection.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);
    // The shell is client-rendered: it fetches the landing model and mounts the cards client-side.
    assert.match(root, /\/api\/landing/);
    assert.match(root, /id="cards"/);
    // The old server-rendered campaign body is retired from the landing — no issue chips here.
    assert.doesNotMatch(root, /#101 <small>/);
    assert.doesNotMatch(root, /#201 <small>/);

    // Selecting a project opens that project's campaign view (server-rendered for now).
    const alpha = await (await fetch(`http://127.0.0.1:${port}/?project=alpha`)).text();
    assert.match(alpha, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/landing serves the all-repos landing model as JSON", async () => {
  const configDir = join(tmpdir(), `sctdd-landing-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]], name: "alpha work" },
    { ts: "2025-01-01T00:01:00.000Z", event: "queue-start", taskIds: ["101"] },
  ]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["301"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/landing`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const landing = await res.json();
    // One card per registered project, read live off the registry, with the counters summed.
    assert.deepEqual(landing.projects.map((p: { project: string }) => p.project), ["alpha", "beta"]);
    assert.equal(landing.projects[0].campaignName, "alpha work");
    assert.equal(landing.projects[0].runState, "running");
    assert.deepEqual(Object.keys(landing.counters).sort(), ["mergedToday", "parked", "queued", "working"]);
    // Alpha's issue 101 is running; alpha's 201 and beta's 301 are still queued — summed.
    assert.equal(landing.counters.working, 1);
    assert.equal(landing.counters.queued, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/feed serves the cross-project event feed as JSON", async () => {
  const configDir = join(tmpdir(), `sctdd-feed-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    { ts: "2025-04-01T08:00:00.000Z", event: "campaign-start", batches: [["101"]], name: "alpha work" },
    { ts: "2025-04-01T08:02:00.000Z", event: "green", taskId: "101" },
  ]);
  seedState(betaDir, [{ ts: "2025-04-01T08:01:00.000Z", event: "parked", taskId: "201", reason: "needs a choice" }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/feed`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const feed = await res.json();
    // The feed merges both projects newest-first, each row repo-prefixed.
    assert.deepEqual(
      feed.map((f: { text: string }) => f.text),
      ["alpha — #101 merged", "beta — #201 parked: needs a choice", "alpha — Campaign “alpha work” started"],
    );
    assert.equal(feed[0].kind, "green");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue serves one issue's reconstructed detail as JSON", async () => {
  const configDir = join(tmpdir(), `sctdd-issue-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    { ts: "2025-05-01T08:00:00.000Z", event: "campaign-start", batches: [["101"]], titles: { "101": "Wire the parser" }, name: "parser work" },
    { ts: "2025-05-01T08:01:00.000Z", event: "turn", taskId: "101", turn: 0, summary: "Sketched the grammar and a red test." },
    { ts: "2025-05-01T08:06:00.000Z", event: "parked", taskId: "101", reason: "needs a decision" },
  ]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const detail = await res.json();
    assert.equal(detail.project, "alpha");
    assert.equal(detail.issueNumber, "101");
    assert.equal(detail.status, "parked");
    assert.equal(detail.title, "Wire the parser");
    assert.equal(detail.campaignName, "parser work");
    assert.equal(detail.turns, 1);
    assert.equal(detail.elapsedMs, 5 * 60 * 1000);
    assert.deepEqual(
      detail.turnLog.map((t: { turn: number; summary: string }) => [t.turn, t.summary]),
      [[0, "Sketched the grammar and a red test."]],
    );
    // An unknown project is a 404, never a path joined from request input.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/issue?project=ghost&issue=101`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue carries the parked question and options for a parked issue", async () => {
  const configDir = join(tmpdir(), `sctdd-issue-parked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    { ts: "2025-05-01T08:00:00.000Z", event: "campaign-start", batches: [["101"]], titles: { "101": "Wire the parser" } },
    { ts: "2025-05-01T08:01:00.000Z", event: "turn", taskId: "101", turn: 0, summary: "Sketched the grammar." },
    { ts: "2025-05-01T08:06:00.000Z", event: "parked", taskId: "101", reason: "needs a decision" },
  ]);
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({ taskId: "101", parkedAt: "now", reason: "blocked", branch: "agent/101", sessionId: "s", question: "Which parser?\n\nOptions:\n- Recursive descent\n- Parser combinator" }),
  );
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)).json();
    assert.equal(detail.status, "parked");
    // The sheet's reply block reads the question (its Options tail split off) and the parsed options.
    assert.deepEqual(detail.parked, { question: "Which parser?", options: ["Recursive descent", "Parser combinator"] });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue omits parked reply data for a non-parked issue", async () => {
  const configDir = join(tmpdir(), `sctdd-issue-unparked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    { ts: "2025-05-01T08:00:00.000Z", event: "campaign-start", batches: [["101"]] },
    { ts: "2025-05-01T08:02:00.000Z", event: "green", taskId: "101", branch: "agent/101" },
  ]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)).json();
    assert.equal(detail.status, "completed");
    assert.equal(detail.parked, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/events streams a project's log appends as SSE frames", async () => {
  const configDir = join(tmpdir(), `sctdd-sse-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // Read from the stream until a full SSE data frame (blank-line terminated) arrives, or time out.
  const nextFrame = async (): Promise<string> => {
    let buf = "";
    while (!buf.includes("\n\n")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE frame")), 4000)),
      ]);
      if (chunk.done) throw new Error("stream closed before a frame arrived");
      buf += decoder.decode(chunk.value, { stream: true });
    }
    return buf;
  };
  try {
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // The opening handshake frame flushes headers and, crucially, means the watcher is now armed.
    await nextFrame();
    // A fresh append to alpha's live log is pushed as a data frame carrying the project and the new event.
    appendFileSync(join(alphaDir, "logs", "orchestrator.jsonl"), JSON.stringify({ event: "turn", taskId: "101" }) + "\n");
    let frame = "";
    let payload: { project?: string; events?: { event: string }[] } = {};
    // fs.watch can coalesce or emit a bare change with no new bytes; keep reading data frames until one carries the append.
    for (let i = 0; i < 5 && !payload.events?.length; i++) {
      frame = await nextFrame();
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("");
      payload = data ? JSON.parse(data) : {};
    }
    assert.equal(payload.project, "alpha");
    assert.deepEqual((payload.events ?? []).map((e) => e.event), ["turn"]);
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus renders a single registered project as a one-entry dropdown with campaign, wave and parked intact", async () => {
  const configDir = join(tmpdir(), `sctdd-serve-solo-${Date.now()}`);
  const soloDir = join(configDir, "state-solo");
  seedState(soloDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  // A parked issue in the active campaign — the single-project view keeps its parked card.
  writeFileSync(
    join(soloDir, "parked", "101.json"),
    JSON.stringify({ taskId: "101", parkedAt: "now", reason: "blocked", branch: "agent/101", sessionId: "s", question: "Need a choice." }),
  );
  register(configDir, { project: "solo", projectRoot: join(configDir, "solo-root"), baseLocation: soloDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    // A no-gateway, single-project user opens that project's campaign view (ADR 0006).
    const solo = await (await fetch(`http://127.0.0.1:${port}/?project=solo`)).text();
    assert.match(solo, /<select name="project"/);
    assert.match(solo, /<option value="solo" selected>/);
    // Its own campaign wave and parked card render intact; the reply happens in the
    // sheet, whose /answer form is present.
    assert.match(solo, /#101 <small>/);
    assert.match(solo, /Parked · <span class="parked-count">1<\/span>/);
    assert.match(solo, /<a class="parked-card"[^>]*data-issue="101" data-project="solo"/);
    assert.match(solo, /<form method="post" action="\/answer" id="reply-form">/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /carve on confirm shells carve in the selected project's root", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-confirm-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["301"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"], ["401"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const spawned: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (_cmd, args, options) => spawned.push({ args, cwd: options.cwd }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskId: "401", project: "beta", confirm: "1" }).toString(),
    });
    // Redirects back to the selected project's dashboard, like the answer control.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Executes the no-plan carve (ticket B) against the SELECTED project's own root
    // — so the shared install loads beta's config and gates, not alpha's.
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(-2), ["carve", "401"]);
    assert.equal(spawned[0].cwd, join(configDir, "beta-root"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /carve?preview returns the selected project's structured closure as JSON", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-json-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["301"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"], ["401"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const closures: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  // The structured closure (E2) the confirmation renders: the target and dropped
  // dependents that would leave, the banked work kept, and the remaining waves.
  const structured = { target: "201", dropped: ["201", "401"], keptBanked: ["301"], remaining: [] as string[][] };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the closure to the selected project's own install,
    // which computes it against that project's real blockedBy graph.
    carveClosure: (projectRoot, taskId) => {
      closures.push({ projectRoot, taskId });
      return Promise.resolve(structured);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve?preview&taskId=201&project=beta`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    // The endpoint returns the full structured closure the panel discloses —
    // dropped, kept-banked, and remaining all reach the client verbatim.
    assert.deepEqual(await res.json(), structured);
    // The closure came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(closures, [{ projectRoot: join(configDir, "beta-root"), taskId: "201" }]);
    // A preview computes nothing destructive — no carve is spawned.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /carve?preview validates params and the project", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-json-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"]] }]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    carveClosure: () => Promise.resolve({ target: "201", dropped: ["201"], keptBanked: [], remaining: [] }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing taskId/project → 400.
    assert.equal((await fetch(`http://127.0.0.1:${port}/carve?preview&project=beta`)).status, 400);
    // Unknown project → 404.
    assert.equal((await fetch(`http://127.0.0.1:${port}/carve?preview&taskId=201&project=ghost`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /carve previews the selected project's closure without executing", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-preview-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["301"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"], ["401"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const previews: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the preview to the selected project's own install,
    // which computes the closure against that project's real blockedBy graph.
    carvePreview: (projectRoot, taskId) => {
      previews.push({ projectRoot, taskId });
      return Promise.resolve(`carve #201 → dropping #201, #401\nremaining campaign: (nothing left to run)`);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskId: "201", project: "beta" }).toString(),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // The preview came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(previews, [{ projectRoot: join(configDir, "beta-root"), taskId: "201" }]);
    // It shows the shelled closure and a confirm affordance carrying the project.
    assert.match(html, /#401/);
    assert.match(html, /<form method="post" action="\/carve"[\s\S]*?name="confirm"/);
    assert.match(html, /name="project" value="beta"/);
    assert.match(html, /name="taskId" value="201"/);
    // Nothing has been carved yet — preview executes nothing.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus flags the selected project's carvable chips with its project", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-control-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A running campaign whose future wave (401) is still carvable.
  seedState(betaDir, [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"], ["401"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["201"] },
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    // The unstarted future-wave chip is flagged carvable and carries beta, so the
    // panel's Carve routes preview and confirm to beta's own install.
    assert.match(html, /class="chip"[^>]*data-issue="401"[^>]*data-project="beta"[^>]*data-carvable="1"/);
    // No inline carve control on the chip itself.
    assert.doesNotMatch(html, /✂️/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus lists a project's archived runs and renders one read-only when a run is selected", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-archive-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run still in flight.
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"]] }]);
  // Two archived runs plus a malformed one that must be skipped.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    { event: "campaign-start", batches: [["101"], ["102"]] },
    { event: "campaign-done", batches: 2 },
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    { event: "campaign-start", batches: [["111"]] },
    { event: "campaign-halt", taskId: "111", reason: "gate failed" },
  ]);
  writeFileSync(join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"), "garbage\n{");
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    // The archived-runs list shows both good runs, newest-first, with summaries;
    // the live run (201) still renders at the top.
    assert.match(root, /#201 <small>/);
    assert.match(root, /<section class="archived-runs">/);
    // Unnamed runs → the timestamp token is the primary label, the summary secondary.
    assert.match(root, /run=2026-02-01T00-00-00-000Z"[^>]*>2026-02-01T00-00-00-000Z<\/a> <span class="run-summary">campaign · 1 issue · halted<\/span>/);
    assert.match(root, /run=2026-01-01T00-00-00-000Z"[^>]*>2026-01-01T00-00-00-000Z<\/a> <span class="run-summary">campaign · 2 issues · complete<\/span>/);
    assert.ok(root.indexOf("2026-02-01") < root.indexOf("2026-01-01"), "newest-first");
    // The malformed run is skipped, never listed.
    assert.doesNotMatch(root, /2026-03-01/);
    // No run selected → no archived-run body yet.
    assert.doesNotMatch(root, /class="archived-run"/);

    // Selecting a run renders it read-only below the live run, additively.
    const withRun = await (await fetch(`http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z`)).text();
    assert.match(withRun, /#201 <small>/); // live run still on top
    assert.match(withRun, /<section class="archived-run"><h2>Archived run 2026-01-01T00-00-00-000Z<\/h2>/);
    assert.match(withRun, /#101 <small>/); // the archived run's own issues
    // Read-only: the archived run's chips carry no carve data and there is no
    // answer form for it.
    assert.doesNotMatch(withRun, /data-issue="101"/);

    // A run not present in the archive listing is rejected — no traversal, no body.
    const bogus = await fetch(`http://127.0.0.1:${port}/?project=beta&run=..%2F..%2Forchestrator`);
    assert.equal(bogus.status, 200);
    assert.doesNotMatch(await bogus.text(), /class="archived-run"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus reconstructs a carved issue in a selected archived run, read-only", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-archive-carved-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run over an unrelated issue, so the only carved chip on the page is the
  // archived run's.
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["900"]] }]);
  // An archived run that carved an unstarted dependent (201) out of its plan: 101
  // banked, 201 dropped by the carve, then the campaign finished.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    { ts: "2026-04-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]], name: "spring cleanup" },
    { ts: "2026-04-01T00:01:00.000Z", event: "green", taskId: "101", branch: "agent/101" },
    { ts: "2026-04-01T00:02:00.000Z", event: "carve", target: "201", removed: ["201"] },
    { ts: "2026-04-01T00:03:00.000Z", event: "campaign-done", batches: 2 },
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/?project=beta&run=2026-04-01T00-00-00-000Z`)).text();
    // The archived run renders read-only under its --name, in the wave/chip treatment.
    assert.match(html, /<section class="archived-run"><h2>Archived run spring cleanup /);
    // The carved-out 201 is reconstructed as a carved chip in the wave it left, so an
    // operator can see what the run was carved down to (ADR 0007).
    assert.match(html, /<span class="dot carved"><\/span>#201 <small>carved<\/small>/);
    // Read-only: the archived carved chip carries no carve/open data — it is inert.
    assert.doesNotMatch(html, /data-issue="201"/);
    assert.doesNotMatch(html, /data-carvable="1"[^>]*>[^<]*<span class="dot carved">/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /archive/log serves a listed run's raw JSONL as text/plain, and 404s an unlisted run", async () => {
  const configDir = join(tmpdir(), `sctdd-archive-log-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [{ event: "campaign-start", batches: [["201"]] }]);
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const raw = [{ event: "campaign-start", batches: [["101"], ["102"]] }, { event: "campaign-done", batches: 2 }].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), raw);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    // A listed run returns its log verbatim, as plain text.
    const ok = await fetch(`http://127.0.0.1:${port}/archive/log?project=beta&run=2026-01-01T00-00-00-000Z`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await ok.text(), raw);

    // A run not in the listing is a 404, never a path to traverse.
    const missing = await fetch(`http://127.0.0.1:${port}/archive/log?project=beta&run=2026-09-09T00-00-00-000Z`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`http://127.0.0.1:${port}/archive/log?project=beta&run=..%2F..%2Forchestrator`);
    assert.equal(traversal.status, 404);

    // Params are required, and an unknown project 404s.
    assert.equal((await fetch(`http://127.0.0.1:${port}/archive/log?run=2026-01-01T00-00-00-000Z`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/archive/log?project=nope&run=2026-01-01T00-00-00-000Z`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("selectStatus picks the requested project, defaulting to the first otherwise", () => {
  const statuses: CampaignStatus[] = [
    { project: "alpha", waves: [], parked: [] },
    { project: "beta", waves: [], parked: [] },
  ];

  assert.equal(selectStatus(statuses, "beta").project, "beta");
  assert.equal(selectStatus(statuses, undefined).project, "alpha");
  // An unknown or stale selection falls back to the first, never undefined.
  assert.equal(selectStatus(statuses, "ghost").project, "alpha");
});

test("describeEvent narrates the operator-facing events in plain words", () => {
  assert.equal(describeEvent({ event: "campaign-start", name: "gateway work" }), "Campaign “gateway work” started");
  assert.equal(describeEvent({ event: "campaign-start" }), "Campaign started");
  assert.equal(describeEvent({ event: "campaign-batch", index: 1 }), "Wave 2 started");
  assert.equal(describeEvent({ event: "campaign-batch-done", index: 0, merged: ["101", "102"] }), "Wave 1 merged #101, #102");
  assert.equal(describeEvent({ event: "campaign-batch-done", index: 2, merged: [] }), "Wave 3 merged nothing");
  assert.equal(describeEvent({ event: "campaign-done" }), "Campaign complete");
  assert.equal(describeEvent({ event: "campaign-halt", reason: "merge conflict" }), "Campaign halted: merge conflict");
  assert.equal(describeEvent({ event: "green", taskId: "#101" }), "#101 merged");
  assert.equal(describeEvent({ event: "parked", taskId: "202", reason: "needs a choice" }), "#202 parked: needs a choice");
  assert.equal(describeEvent({ event: "carve", removed: ["303", "304"] }), "Carved #303, #304");
  // A turn renders its agent-authored summary verbatim (ADR 0009), falling back when absent.
  assert.equal(describeEvent({ event: "turn", taskId: "101", turn: 3, summary: "Added a failing test for the counter" }), "Added a failing test for the counter");
  assert.equal(describeEvent({ event: "turn", taskId: "101", turn: 3 }), "#101 — turn 3");
});

test("formatFeedEvent prefixes an event's plain-words sentence with its repo, and drops machine noise", () => {
  // A narratable event reads as one repo-prefixed sentence.
  assert.equal(formatFeedEvent("alpha", { event: "green", taskId: "101" }), "alpha — #101 merged");
  assert.equal(formatFeedEvent("beta", { event: "turn", taskId: "201", turn: 2, summary: "Wrote a failing test" }), "beta — Wrote a failing test");
  // An event describeEvent can't narrate (machine noise) yields no feed line.
  assert.equal(formatFeedEvent("alpha", { event: "sandbox", taskId: "102" }), "");
});

test("lastEventText picks the most recent operator-facing event, ignoring machine noise", () => {
  const events = [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "green", taskId: "101" },
    // Machine noise after the meaningful event must not become the "last event".
    { ts: "2025-01-01T00:02:00.000Z", event: "sandbox", taskId: "102", branch: "agent/102" },
    { ts: "2025-01-01T00:03:00.000Z", event: "gate", cmds: ["npm test"] },
  ];
  assert.equal(lastEventText(events), "#101 merged");
  assert.equal(lastEventText([]), "No activity yet");
});

test("reduceCampaign reconstructs a fresh campaign's waves with no wave running yet", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"], ["201"]] },
  ]);

  assert.deepEqual(reduced.waves, [["101", "102"], ["201"]]);
  // Nothing has started: no wave is current and none is closed.
  assert.equal(reduced.currentWave, -1);
  assert.deepEqual([...reduced.closedWaves], []);
  // No queue-start/green/etc. yet, so no issue has a reconstructed outcome.
  assert.deepEqual([...reduced.outcomes.entries()], []);
});

test("reduceCampaign reads an optional campaign name off the campaign-start event", () => {
  // A named run carries its name on the start event; an unnamed one leaves it undefined.
  assert.equal(
    reduceCampaign([{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]], name: "gateway work" }]).name,
    "gateway work",
  );
  assert.equal(reduceCampaign([{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]).name, undefined);
  // The latest campaign-start wins, name and all.
  assert.equal(
    reduceCampaign([
      { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["1"]], name: "first" },
      { ts: "2025-01-01T00:10:00.000Z", event: "campaign-start", batches: [["101"]], name: "second" },
    ]).name,
    "second",
  );
});

test("reduceCampaign reports one completed wave closed and the next wave current mid-campaign", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
  ]);

  assert.deepEqual(reduced.waves, [["101"], ["201"]]);
  // Wave 0 closed and banked its merged issue; wave 1 is now the running one.
  assert.deepEqual([...reduced.closedWaves], [0]);
  assert.equal(reduced.currentWave, 1);
  assert.equal(reduced.outcomes.get("101"), "completed");
});

test("reduceCampaign records when each issue merged, from batch-done, green and queue-done", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201", "202"]] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-02T09:00:00.000Z", event: "green", taskId: "201" },
    { ts: "2025-01-02T10:00:00.000Z", event: "queue-done", outcomes: { "202": "green", "201": "green" } },
  ]);

  // A merge stamp is recorded from every path an issue reaches "completed" by — the
  // batch merge, a bare green, and a queue-done green — so merged-today can count them.
  assert.equal(reduced.mergedAt.get("101"), "2025-01-01T00:02:00.000Z");
  assert.equal(reduced.mergedAt.get("201"), "2025-01-02T09:00:00.000Z");
  assert.equal(reduced.mergedAt.get("202"), "2025-01-02T10:00:00.000Z");
});

test("reduceCampaign marks a halted issue as a failure", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-halt", taskId: "101", reason: "gate failed" },
  ]);

  assert.equal(reduced.outcomes.get("101"), "failure");
  assert.equal(reduced.details.get("101"), "Campaign halted: gate failed");
  // A halt does not close the wave — it stays the current one.
  assert.deepEqual([...reduced.closedWaves], []);
  assert.equal(reduced.currentWave, 0);
});

test("campaignRunning is true for a started campaign that has not finished or halted", () => {
  assert.equal(
    campaignRunning([
      { event: "campaign-start", batches: [["101"], ["201"]] },
      { event: "campaign-batch", index: 0, tasks: ["101"] },
    ]),
    true,
  );
});

test("campaignRunning is false with no campaign, and once it completes or halts", () => {
  assert.equal(campaignRunning([{ event: "queue-start", taskIds: ["101"] }]), false, "queue-only run is not a campaign");
  assert.equal(
    campaignRunning([
      { event: "campaign-start", batches: [["101"]] },
      { event: "campaign-done", batches: 1 },
    ]),
    false,
    "a completed campaign is not running",
  );
  assert.equal(
    campaignRunning([
      { event: "campaign-start", batches: [["101"]] },
      { event: "campaign-halt", taskId: "101", reason: "gate failed" },
    ]),
    false,
    "a halted campaign is not running",
  );
});

test("campaignRunning tracks the latest campaign only", () => {
  // An earlier campaign finished; a fresh one started after it is what counts.
  assert.equal(
    campaignRunning([
      { event: "campaign-start", batches: [["1"]] },
      { event: "campaign-done", batches: 1 },
      { event: "campaign-start", batches: [["101"], ["201"]] },
    ]),
    true,
  );
});

test("reduceCampaign folds a carve event, pruning unfinished issues from future waves", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201", "202"], ["301"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201", "202"] },
    { ts: "2025-01-01T00:03:30.000Z", event: "queue-start", taskIds: ["201", "202"], slots: 3 },
    // 202 carved mid-wave: it is running, so it stays; its unstarted dependent 301 goes.
    { ts: "2025-01-01T00:04:00.000Z", event: "carve", target: "202", removed: ["202", "301"] },
  ]);

  // 101 (merged) and 202 (in-flight) stay; only the future, unstarted 301 is pruned.
  assert.deepEqual(reduced.waves, [["101"], ["201", "202"]]);
  // The in-flight wave is still current; wave 0 is still closed at its original index.
  assert.deepEqual([...reduced.closedWaves], [0]);
  assert.equal(reduced.currentWave, 1);
});

test("reduceCampaign's carve fold clears an emptied future wave and reindexes", () => {
  const reduced = reduceCampaign([
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"], ["301"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    // Between waves: 201 not yet started, so carving it empties and drops its wave.
    { ts: "2025-01-01T00:03:00.000Z", event: "carve", target: "201", removed: ["201"] },
  ]);

  assert.deepEqual(reduced.waves, [["101"], ["301"]]);
  assert.deepEqual([...reduced.closedWaves], [0]);
});

test("reconstructIssueDetail folds an issue's turn log, count, elapsed and status from the log", () => {
  const detail = reconstructIssueDetail(
    [
      { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]], titles: { "101": "Do the thing" }, name: "gateway work" },
      { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
      { ts: "2025-01-01T00:02:00.000Z", event: "turn", taskId: "101", turn: 0, signal: undefined, summary: "Wrote a failing test for the parser." },
      { ts: "2025-01-01T00:07:00.000Z", event: "turn", taskId: "101", turn: 1, signal: "done", summary: "Made it green and tidied up." },
      { ts: "2025-01-01T00:12:00.000Z", event: "green", taskId: "101", branch: "agent/101" },
    ],
    "101",
  );

  assert.equal(detail.issueNumber, "101");
  assert.equal(detail.status, "completed");
  assert.equal(detail.title, "Do the thing");
  assert.equal(detail.campaignName, "gateway work");
  assert.equal(detail.turns, 2);
  // Working span: first turn (00:02) to the green (00:12) — the plan-only campaign-start is excluded.
  assert.equal(detail.elapsedMs, 10 * 60 * 1000);
  // Newest first, each carrying the agent's own summary verbatim (ADR 0009).
  assert.deepEqual(
    detail.turnLog.map((t) => [t.turn, t.summary]),
    [
      [1, "Made it green and tidied up."],
      [0, "Wrote a failing test for the parser."],
    ],
  );
});

test("buildStatus shows campaign waves with issue chips and statuses", () => {
  const dir = join(tmpdir(), `sctdd-status-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-done", outcomes: { "101": "green", "102": "parked" } },
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({ taskId: "102", parkedAt: "now", reason: "blocked", branch: "agent/102", sessionId: "s", question: "Need a choice.\n\nOptions:\n- A: do the simple thing\n- B: do the robust thing" }),
  );

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.project, "demo");
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status])),
    [
      [
        ["101", "completed"],
        ["102", "parked"],
      ],
      [["201", "unstarted"]],
    ],
  );
  assert.equal(status.parked[0].issueNumber, "102");
  assert.deepEqual(status.parked[0].options, ["A: do the simple thing", "B: do the robust thing"]);
});

test("buildStatus surfaces the campaign name from the start event", () => {
  const dir = join(tmpdir(), `sctdd-status-name-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]], name: "gateway work" },
  ]);

  assert.equal(buildStatus(cfgFor(dir)).name, "gateway work");
});

test("buildStatus fills issue names from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `sctdd-status-log-titles-${Date.now()}`);
  seedState(dir, [
    {
      ts: "2025-01-01T00:00:00.000Z",
      event: "campaign-start",
      batches: [["101", "102"]],
      titles: { "101": "Add login flow", "102": "Rotate logs" },
    },
  ]);

  // cfgFor's fetchTask echoes the id — so a name here can only have come from the
  // log, never a live lookup (the dumb-router dashboard has no real fetchTask).
  const status = buildStatus(cfgFor(dir));

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, "Rotate logs");
});

test("buildStatus fills issue names from a queue-only run's queue-start titles", () => {
  const dir = join(tmpdir(), `sctdd-status-queue-titles-${Date.now()}`);
  seedState(dir, [
    // No campaign frame — a bare queue run frames its taskIds as a single wave,
    // and carries their titles on queue-start.
    { ts: "2025-01-01T00:00:00.000Z", event: "queue-start", taskIds: ["301", "302"], slots: 2, titles: { "301": "Fix parser", "302": "Tune cache" } },
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.waves[0].issues[0].name, "Fix parser");
  assert.equal(status.waves[0].issues[1].name, "Tune cache");
});

test("buildStatus leaves issue names unset when the log carries no titles", () => {
  const dir = join(tmpdir(), `sctdd-status-no-titles-${Date.now()}`);
  seedState(dir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);

  assert.equal(buildStatus(cfgFor(dir)).waves[0].issues[0].name, undefined);
});

test("buildStatus marks completed waves as closed", () => {
  const dir = join(tmpdir(), `sctdd-status-closed-wave-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves.map((w) => [w.index, w.status]),
    [
      [0, "closed"],
      [1, "running"],
    ],
  );
});

test("buildStatus renders a carved issue as a carved chip in the wave it left", () => {
  const dir = join(tmpdir(), `sctdd-status-carved-${Date.now()}`);
  seedState(dir, [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]], titles: { "101": "seed the db", "201": "add the report" } },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    // 201 is a future, unstarted wave: carving it drops it from the running plan…
    { ts: "2025-01-01T00:03:00.000Z", event: "carve", target: "201", removed: ["201"] },
  ]);

  const status = buildStatus(cfgFor(dir));

  // …but it still renders as a carved chip in the wave it left (ADR 0007), so a
  // browsing operator sees what was carved out — it is not silently gone.
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status])),
    [[["101", "completed"]], [["201", "carved"]]],
  );
  // The carved issue keeps its title on the chip.
  assert.equal(status.waves[1].issues[0].name, "add the report");
});

test("buildStatus marks active wave issues as running before they finish", () => {
  const dir = join(tmpdir(), `sctdd-status-running-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-start", taskIds: ["101", "102"], slots: 2 },
    { ts: "2025-01-01T00:03:00.000Z", event: "green", taskId: "101" },
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      ["101", "completed"],
      ["102", "running"],
    ],
  );
});

test("buildStatus does not show parked interaction cards for closed wave issues", () => {
  const dir = join(tmpdir(), `sctdd-status-closed-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: [], held: ["101"] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
  ]);
  for (const taskId of ["101", "201"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({ taskId, parkedAt: "now", reason: "blocked", branch: `agent/${taskId}`, sessionId: "s", question: "Need a choice." }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(status.parked.map((p) => p.issueNumber), ["201"]);
});

test("buildStatus only shows parked cards for issues in the active campaign", () => {
  const dir = join(tmpdir(), `sctdd-status-filter-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["243"]] }]);
  for (const taskId of ["243", "999"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({ taskId, parkedAt: "now", reason: "blocked", branch: `agent/${taskId}`, sessionId: "s", question: "Need a choice." }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(status.parked.map((p) => p.issueNumber), ["243"]);
});

test("buildStatus adds rough activity details for issue hover", () => {
  const dir = join(tmpdir(), `sctdd-status-activity-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102", "103"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "queue-start", taskIds: ["101", "102", "103"], slots: 3 },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-spawn", taskId: "101", running: 1, left: 2 },
    { ts: "2025-01-01T00:03:00.000Z", event: "turn", taskId: "101", turn: 2, signal: "<promise>COMPLETE</promise>" },
    { ts: "2025-01-01T00:04:00.000Z", event: "green", taskId: "102", branch: "agent/102" },
    { ts: "2025-01-01T00:05:00.000Z", event: "parked", taskId: "103", reason: "blocked" },
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.detail]),
    [
      ["101", "Agent turn 2 finished; waiting for verification/resume"],
      ["102", "Completed on agent/102"],
      ["103", "Parked: blocked"],
    ],
  );
});

test("buildStatusWithIssueNames adds issue names from fetchTask when available", async () => {
  const dir = join(tmpdir(), `sctdd-status-issue-names-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] }]);

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    fetchTask: async (id: string) => (id === "101" ? JSON.stringify({ title: "Add login flow" }) : "no structured title"),
  });

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, undefined);
});

test("wave labels read from tmp-log issue titles, resolved through buildStatusWithIssueNames", async () => {
  const dir = join(tmpdir(), `sctdd-status-wave-names-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102", "103"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102", "103"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101", "102", "103"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
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

  // Many-issue wave (closed): lead title + "+N" on its collapsed chip, with a merged tally.
  assert.match(html, /<span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+2 <span class="completed-wave-tally">3\/3<\/span><\/summary>/);
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(html, /<section class="wave running"><div class="wave-head"><h2>Wave 2 — cache eviction <span class="wave-status running">running<\/span>/);
});

test("wave labels and chip hovers render from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `sctdd-render-log-titles-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    {
      ts: "2025-01-01T00:00:00.000Z",
      event: "campaign-start",
      batches: [["101", "102", "103"], ["201"]],
      titles: { "101": "config resolution", "102": "retry policy", "103": "log rotation", "201": "cache eviction" },
    },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102", "103"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101", "102", "103"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
  ]);

  // buildStatus over cfgFor's id-echoing fetchTask: the only source of titles is
  // the log, exactly as the dumb-router dashboard reads them (ADR 0002).
  const html = renderStatusPage(buildStatus(cfgFor(dir)));

  // Many-issue wave (closed): lead title + "+N" on its collapsed chip, with a merged tally.
  assert.match(html, /<span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+2 <span class="completed-wave-tally">3\/3<\/span><\/summary>/);
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(html, /<section class="wave running"><div class="wave-head"><h2>Wave 2 — cache eviction <span class="wave-status running">running<\/span>/);
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

  // Each open wave card's head carries its merged/total on the right — one of two
  // done in the running wave, none in the unstarted one.
  assert.match(html, /<span class="wave-status running">running<\/span><\/h2><span class="wave-tally">1\/2<\/span>/);
  assert.match(html, /<span class="wave-status unstarted">unstarted<\/span><\/h2><span class="wave-tally">0\/2<\/span>/);
});

test("renderStatusPage lists the issue titles under each open wave", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "wire up the parser" },
          { issueNumber: "202", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });

  // Under the open wave's chips, each issue's title is listed (its number alone
  // when it has no resolved title yet).
  assert.match(html, /<ul class="wave-issues"><li[^>]*>#201 wire up the parser<\/li><li[^>]*>#202<\/li><\/ul>/);
});

test("renderStatusPage colours a carved chip and pulses a running one", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "live one" },
          { issueNumber: "202", status: "carved", name: "carved one" },
        ],
      },
    ],
    parked: [],
  });

  // A carved chip carries the carved status dot + label…
  assert.match(html, /<span class="dot carved"><\/span>#202 <small>carved<\/small>/);
  // …and the wave it left gains a carved tally in its header, so the carve reads
  // at a glance without counting struck-through chips (one of two issues carved).
  assert.match(html, /<span class="wave-carved">1 carved<\/span>/);
  // …in a distinct carved colour defined in the stylesheet (ADR 0007's sixth state).
  assert.match(html, /--color-carved:/);
  assert.match(html, /\.carved \{ background: var\(--color-carved\); \}/);
  // A running chip pulses — a keyframed animation on its dot, reduced-motion aware.
  assert.match(html, /@keyframes chip-pulse/);
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
  assert.match(html, /prefers-reduced-motion/);
});

test("renderStatusPage's carve panel discloses kept-banked work and carries a standalone explainer", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "401", status: "unstarted" }] }], parked: [] },
    { carve: true },
  );
  // The confirmation is built from the structured closure the endpoint returns:
  // it names the dropped dependents and, separately, states the banked (merged or
  // mergeable) work that is kept — so a confirm never implies banked work leaves.
  assert.match(html, /also drops/);
  assert.match(html, /Keeps banked \(merged or mergeable\)/);
  // A standalone Carve (no Resume beside it) carries a plain-words explainer of
  // what a carve does, keyed to show only when the issue is carvable and unparked.
  assert.match(html, /id="carve-explainer"/);
  assert.match(html, /everything blocked by it/);
});

test("renderStatusPage renders a project dropdown and the selected project's body", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] }],
      parked: [{ issueNumber: "201", reason: "blocked", parkedAt: "now", branch: "agent/201", description: "Need a choice.", options: [] }],
    },
    { projects: ["alpha", "beta", "gamma"], selected: "beta" },
  );

  // A dropdown of every registered project, auto-submitting the selection back as a GET param.
  assert.match(html, /<form[^>]*method="get"[^>]*action="\/"[^>]*class="project-picker"/);
  assert.match(html, /<select name="project" onchange="this\.form\.submit\(\)">/);
  // The single dropdown also switches back to the all-repos landing (submits an empty project).
  assert.match(html, /<option value="">All repos<\/option>/);
  assert.match(html, /<option value="alpha">alpha<\/option>/);
  assert.match(html, /<option value="beta" selected>beta<\/option>/);
  assert.match(html, /<option value="gamma">gamma<\/option>/);
  // The selected project's own body still renders exactly as the single-project view.
  assert.match(html, /<section class="wave running"><div class="wave-head"><h2>Wave 1 <span class="wave-status running">running<\/span>/);
  // The parked card carries the project so the sheet routes its reply/carve to it.
  assert.match(html, /<a class="parked-card"[^>]*data-project="beta"/);
});

test("renderStatusPage lists archived runs and renders a selected one read-only below the live run", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      // A live run with a still-carvable (unstarted) chip: proves the live view keeps carve.
      waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "201", status: "unstarted" }] }],
      parked: [],
    },
    {
      carve: true,
      selected: "beta",
      archivedRuns: [
        { run: "2026-02-01T00-00-00-000Z", summary: "campaign · 2 issues · complete" },
        { run: "2026-01-01T00-00-00-000Z", summary: "queue · 1 issue · halted" },
      ],
      archivedRun: "2026-02-01T00-00-00-000Z",
      archived: {
        project: "beta",
        waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] }],
        parked: [],
      },
    },
  );

  // An archived-runs list, newest-first, each a link carrying project + run token.
  // These runs are unnamed, so the primary label falls back to the timestamp token,
  // with the mode·issues·outcome summary as a secondary label beside it.
  assert.match(html, /<section class="archived-runs"><h2>Archived runs<\/h2>/);
  assert.match(html, /<a href="\/\?project=beta&amp;run=2026-02-01T00-00-00-000Z"[^>]*>2026-02-01T00-00-00-000Z<\/a> <span class="run-summary">campaign · 2 issues · complete<\/span>/);
  assert.match(html, /<a href="\/\?project=beta&amp;run=2026-01-01T00-00-00-000Z"[^>]*>2026-01-01T00-00-00-000Z<\/a> <span class="run-summary">queue · 1 issue · halted<\/span>/);
  assert.ok(
    html.indexOf(">campaign · 2 issues · complete<") < html.indexOf(">queue · 1 issue · halted<"),
    "archived runs list newest-first",
  );

  // Each run also links to its raw event log.
  assert.match(html, /<a href="\/archive\/log\?project=beta&amp;run=2026-02-01T00-00-00-000Z">raw log<\/a>/);
  assert.match(html, /<a href="\/archive\/log\?project=beta&amp;run=2026-01-01T00-00-00-000Z">raw log<\/a>/);

  // The selected run's own wave/issue view renders in its own section.
  assert.match(html, /<section class="archived-run">/);
  assert.match(html, /#301 <small>/);

  // The live run still carries carve (its unstarted 201 chip is carvable)…
  assert.match(html, /data-issue="201"[^>]*data-carvable="1"/);
  // …but the archived render is read-only: its 301 chip gets no carve data at all.
  assert.doesNotMatch(html, /data-issue="301"/);
});

test("renderStatusPage shows the run name in the live header, and names vs timestamps in the archive", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      name: "gateway work",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] }],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        // A named run: its name is the primary label, the summary stays secondary.
        { run: "2026-02-01T00-00-00-000Z", summary: "campaign · 2 issues · complete", name: "comms + dashboard" },
        // An unnamed run: it falls back to its timestamp token as the primary label.
        { run: "2026-01-01T00-00-00-000Z", summary: "queue · 1 issue · halted" },
      ],
      archivedRun: "2026-02-01T00-00-00-000Z",
      archived: {
        project: "beta",
        name: "comms + dashboard",
        waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] }],
        parked: [],
      },
    },
  );

  // The campaign meta line shows the campaign's name with its issue/wave counts.
  assert.match(html, /<p class="campaign-meta"><span class="campaign-name">gateway work<\/span> · 1 issue · 1 wave<\/p>/);

  // Named run: the link text is the NAME, and the mode·issues·outcome summary is a secondary label.
  assert.match(html, /run=2026-02-01T00-00-00-000Z"[^>]*>comms \+ dashboard<\/a>/);
  assert.match(html, /<span class="run-summary">campaign · 2 issues · complete<\/span>/);
  // Unnamed run: the link text falls back to the timestamp token.
  assert.match(html, /run=2026-01-01T00-00-00-000Z"[^>]*>2026-01-01T00-00-00-000Z<\/a>/);
  assert.match(html, /<span class="run-summary">queue · 1 issue · halted<\/span>/);

  // The archived-run view carries the run's name beside its token.
  assert.match(html, /<section class="archived-run"><h2>Archived run[^<]*comms \+ dashboard/);
});

test("renderStatusPage omits the campaign name from the meta line for an unnamed run", () => {
  const html = renderStatusPage({ project: "beta", waves: [{ index: 0, status: "running", issues: [] }], parked: [] });
  assert.doesNotMatch(html, /class="run-name"/);
  assert.doesNotMatch(html, /class="campaign-name"/);
  // The counts still render — an unnamed campaign is still a campaign.
  assert.match(html, /<p class="campaign-meta">0 issues · 1 wave<\/p>/);
});

test("renderStatusPage renders no archived-runs section when a project has none", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] }, { selected: "demo" });
  assert.doesNotMatch(html, /class="archived-runs"/);
  assert.doesNotMatch(html, /class="archived-run"/);
});

test("renderStatusPage omits the project dropdown when no project list is given", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /class="project-picker"/);
  assert.doesNotMatch(html, /<select name="project"/);
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
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running", name: "Add login flow", detail: "Agent turn 2 finished; waiting for verification/resume" }] }], parked: [] });

  // The chip keeps its hover title and now carries the ids the sheet fetches with.
  assert.match(html, /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/);
  assert.match(html, /class="chip"[^>]*data-issue="101"[^>]*data-project="demo"/);
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /el\.addEventListener\("click"/);
});

test("renderStatusPage opens the issue-detail sheet from a chip, fetching /api/issue", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running", name: "Add login flow" }] }], parked: [] });

  // A dismissible sheet, hidden until an issue is opened.
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="issue-detail-close"/);
  // A sticky header (number, status, title, repo · campaign), meta tiles, and the turn log.
  assert.match(html, /class="issue-detail-header"/);
  assert.match(html, /\.issue-detail-header \{[^}]*position: sticky;/);
  assert.match(html, /class="issue-detail-title"/);
  assert.match(html, /class="issue-detail-context"/);
  assert.match(html, /id="issue-detail-turns"/);
  assert.match(html, /id="issue-detail-elapsed"/);
  assert.match(html, /id="issue-detail-turnlog"/);
  // Chips open the sheet, which fetches the reconstructed detail.
  assert.match(html, /openIssue\(/);
  assert.match(html, /fetch\("\/api\/issue\?project="/);
  // Dismissible, and reveal keys off a `show` class over the hidden default.
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  assert.match(html, /getElementById\("issue-detail-close"\)\.addEventListener\("click"/);
});

test("renderStatusPage renders the turn log newest-first with each turn number in its status colour", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Each turn's number carries the issue's status class, so it reads in the status colour.
  assert.match(html, /"turn-num " \+ .*\bstatus\b/);
  // The turn log region is an ordered list the script fills from the fetched turnLog.
  assert.match(html, /id="issue-detail-turnlog"/);
  assert.match(html, /turnLog/);
  // The status dot palette is shared, so a turn number reuses the same status colours.
  assert.match(html, /\.turn-num\.completed \{ color: var\(--color-green\); \}/);
});

test("renderStatusPage makes the issue-detail sheet a full-width bottom sheet on mobile", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Desktop: a centred sheet. Mobile: pinned full-width to the bottom.
  assert.match(html, /@media \(max-width: [^)]+\) \{[^}]*\.issue-detail-sheet \{[^}]*width: 100%;/);
  assert.match(html, /\.issue-detail-sheet/);
});

test("renderStatusPage hosts the carve affordance and inline confirm in the tap-detail panel", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] }], parked: [] },
    { carve: true },
  );

  // The panel — not the chip — carries a Carve button and a hidden inline confirm.
  assert.match(html, /<button type="button" id="carve-start" class="carve-start">Carve<\/button>/);
  assert.match(html, /<form method="post" action="\/carve" id="carve-confirm"[^>]*hidden>/);
  assert.match(html, /<span class="carve-confirm-text"><\/span>/);
  // The confirm POSTs the existing /carve with confirm=1, carrying taskId+project.
  assert.match(html, /id="carve-confirm"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?name="confirm" value="1"/);
  assert.match(html, /<button type="submit" class="carve-confirm-btn">Confirm<\/button>/);
  assert.match(html, /<button type="button" id="carve-cancel" class="carve-cancel">Cancel<\/button>/);
  // The script keys off the carve data: it fetches the JSON preview, discloses the
  // removed list, POSTs the confirm, then shows a transient "carving…".
  assert.match(html, /\/carve\?preview/);
  assert.match(html, /carve-confirm-text/);
  assert.match(html, /data-carvable/);
  assert.match(html, /method: "POST"/);
  assert.match(html, /carving/);
});

test("renderStatusPage hosts a parked reply block with a Resume button in the tap-detail sheet", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The sheet carries a reply block, hidden until the opened issue is parked.
  assert.match(html, /<div id="issue-detail-reply" class="issue-detail-reply" hidden>/);
  assert.match(html, /id="reply-question"/);
  assert.match(html, /id="reply-options"/);
  // A free-text reply field posts through the existing /answer path, carrying taskId+project.
  assert.match(html, /<form method="post" action="\/answer" id="reply-form">/);
  assert.match(html, /id="reply-form"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?<textarea name="text"/);
  // Resume submits that form; it is associated by `form=` so it can sit outside the form, beside Carve.
  assert.match(html, /<button type="submit" form="reply-form" id="reply-resume" class="reply-resume" hidden>Resume<\/button>/);
});

test("renderStatusPage caps the reply textarea so it stays within the sheet/card (#73)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });
  // A width:100% textarea with padding still spilled past the right edge of the sheet
  // and the parked card; max-width:100% caps it against its padded content box so it
  // never overflows and introduces no horizontal scroll on the sheet.
  assert.match(html, /\btextarea \{[^}]*max-width: 100%/);
});

test("renderStatusPage places Resume beside Carve in one sheet-actions row, sized for touch", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] }, { carve: true });

  // Both controls live in the same actions row so they are reachable one-handed together.
  assert.match(html, /<div class="sheet-actions"><button type="submit" form="reply-form" id="reply-resume"[^>]*>Resume<\/button><div id="carve-panel"/);
  // A 44px tap target for the primary Resume action on a phone.
  assert.match(html, /\.reply-resume \{[^}]*min-height: 44px;/);
  // The actions row is a flex box, so it needs [hidden] restored explicitly or an
  // empty foot (no reply, no carve) would always show its border and padding.
  assert.match(html, /\.sheet-actions\[hidden\][^{]*\{ display: none; \}/);
  // The carve panel is likewise a flex box whose display would defeat the UA
  // [hidden] rule; restore its collapse rule so a non-carvable issue can hide it (#72).
  assert.match(html, /\.carve-panel\[hidden\][^{]*\{ display: none;? \}/);
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

test("renderStatusPage falls back to a no-JS carve form per carvable issue", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        { index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
        { index: 1, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }, { issueNumber: "302", status: "parked" }] },
      ],
      parked: [],
    },
    { carve: true },
  );

  // Progressive enhancement: a plain server-side form per carvable issue, inside
  // <noscript>, still reaches POST /carve → the preview page → confirm with no JS.
  assert.match(html, /<noscript>[\s\S]*<form method="post" action="\/carve"[\s\S]*?name="taskId" value="301"[\s\S]*?name="project" value="demo"[\s\S]*<\/noscript>/);
  assert.match(html, /<noscript>[\s\S]*name="taskId" value="302"[\s\S]*<\/noscript>/);
  // Never a fallback form for a running (in-flight) issue.
  assert.doesNotMatch(html, /name="taskId" value="201"/);
});

test("renderStatusPage omits the carve panel and no-JS fallback unless carve is opted in", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] }], parked: [] });

  assert.doesNotMatch(html, /id="carve-start"/);
  assert.doesNotMatch(html, /<noscript>/);
});

test("renderStatusPage leads with parked issues above the waves when any are parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running" }] }],
    parked: [{ issueNumber: "102", reason: "blocked", parkedAt: "now", branch: "agent/102", description: "Need a choice.", options: [] }],
  });

  assert.match(html, /<section class="parked-issues"><h2>Parked · <span class="parked-count">1<\/span><\/h2>/);
  // Parked section comes before the wave grid.
  assert.ok(html.indexOf('class="parked-issues"') < html.indexOf('class="waves-grid"'), "parked should render above the waves");
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
});

test("renderStatusPage opens the issue-detail sheet from a parked row too", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [{ issueNumber: "102", reason: "blocked", parkedAt: "now", branch: "agent/102", description: "Need a choice.", options: [] }],
  });

  // The whole parked card is a clickable question card carrying the ids the sheet
  // fetches with; its href is the no-JS fallback, and the same wiring opens the sheet
  // from a chip or a parked card (the anchor's default click is prevented).
  assert.match(html, /<a class="parked-card" href="\/\?project=demo" data-issue="102" data-project="demo"><div class="parked-card-title"><span class="parked-issue">#102<\/span> Need a choice\.<\/div>/);
  assert.match(html, /querySelectorAll\("\.chip\[data-issue\], \.parked-card\[data-issue\]"\)/);
  assert.match(html, /event\.preventDefault\(\); openIssue\(/);
});

test("renderStatusPage omits the parked section entirely when nothing is parked", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "running", issues: [] }], parked: [] });

  assert.doesNotMatch(html, /Parked issues/);
  assert.doesNotMatch(html, /Nothing parked/);
  assert.doesNotMatch(html, /class="parked-issues"/);
});

test("renderStatusPage collapses closed waves into expandable completed wave chips", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "101", status: "completed" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
    ],
    parked: [],
  });

  assert.match(html, /<div class="completed-waves"><div class="completed-wave-bar">/);
  assert.doesNotMatch(html, /Completed:/);
  assert.match(html, /<details class="completed-wave"><summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">1\/1<\/span><\/summary>/);
  assert.match(html, /\.completed-wave-chip \.check \{ color: var\(--color-green\);/);
  // Expanded summary is block-level (no inline line-box leading) and spaced from its chips.
  assert.match(html, /\.completed-wave\[open\] > \.completed-wave-chip \{ display: flex; width: max-content; margin-bottom: \.6rem; \}/);
  // Chip rows must not stretch: the first wrapped line was rendering taller in Safari.
  assert.match(html, /\.completed-wave-bar, \.chips \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/);
  assert.match(html, /<section class="wave running"><div class="wave-head"><h2>Wave 2 <span class="wave-status running">running<\/span><\/h2><span class="wave-tally">0\/1<\/span><\/div>/);
});

test("renderStatusPage labels a single-issue wave with that issue's resolved title, keeping the index", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 1, status: "running", issues: [{ issueNumber: "201", status: "running", name: "config resolution" }] }],
    parked: [],
  });

  assert.match(html, /<section class="wave running"><div class="wave-head"><h2>Wave 2 — config resolution <span class="wave-status running">running<\/span>/);
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
  assert.match(html, /<h2>Wave 2 — config resolution \+3 <span class="wave-status running">running<\/span>/);
});

test("renderStatusPage labels a closed wave's collapsed chip with its issue titles", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          { issueNumber: "101", status: "completed", name: "config resolution" },
          { issueNumber: "102", status: "completed", name: "retry policy" },
        ],
      },
      { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
    ],
    parked: [],
  });

  assert.match(html, /<summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+1 <span class="completed-wave-tally">2\/2<\/span><\/summary>/);
});

test("renderStatusPage escapes a wave name derived from an issue title", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running", name: "fix <script> & things" }] }],
    parked: [],
  });

  assert.match(html, /<h2>Wave 1 — fix &lt;script&gt; &amp; things </);
});

test("renderStatusPage keeps the bare wave index when no issue title is resolved yet", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running" }] }],
    parked: [],
  });

  assert.match(html, /<h2>Wave 1 <span class="wave-status running">running<\/span>/);
});

test("renderStatusPage renders a campaign meta line of name · issues · waves, omitted with no campaign (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "101", status: "completed" }] },
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
  assert.match(html, /<p class="campaign-meta"><span class="campaign-name">gateway work<\/span> · 3 issues · 2 waves<\/p>/);

  // With no campaign at all (no waves), the meta line is omitted entirely.
  const empty = renderStatusPage({ project: "demo", waves: [], parked: [] });
  assert.doesNotMatch(empty, /class="campaign-meta"/);
});

test("renderStatusPage lays open waves out in a grid, accenting the running wave (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      { index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
      { index: 1, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] },
    ],
    parked: [],
  });
  // Open wave cards sit in a responsive grid.
  assert.match(html, /<div class="waves-grid"><section class="wave running">/);
  assert.match(html, /\.waves-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(20rem, 1fr\)\);/);
  // A running wave carries the status-coloured (blue) top accent; an unstarted one the neutral default.
  assert.match(html, /\.wave \{[^}]*border-top: 3px solid var\(--color-text-light-2\);/);
  assert.match(html, /\.wave\.running \{ border-top-color: var\(--color-blue\); \}/);
  assert.match(html, /<section class="wave unstarted">/);
});

test("renderStatusPage's parked card carries no inline reply form — the reply is in the sheet (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [{ issueNumber: "102", reason: "blocked", parkedAt: "2025-06-15T09:00:00.000Z", branch: "agent/102", description: "Need a choice.", options: ["A", "B"] }],
  });
  // The card is a single clickable anchor with a meta line — no <form>, no <textarea>,
  // no per-issue "Send response" button. The only /answer form on the page is the sheet's.
  const card = html.slice(html.indexOf('class="parked-card"'), html.indexOf("</a>", html.indexOf('class="parked-card"')));
  assert.doesNotMatch(card, /<form|<textarea|Send response/);
  assert.match(html, /waiting <span class="parked-waited" data-parked-at="2025-06-15T09:00:00.000Z">…<\/span> · blocked/);
  // Exactly one /answer form remains — the sheet's reply-form.
  assert.equal(html.match(/action="\/answer"/g)?.length, 1);
});

test("serveAllStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(String(serveAllStatus), /server\.listen\(opts\.port,\s*opts\.host,/);
});

test("formatStatusText summarizes waves, issue chips (with names), and the parked section", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "436", status: "completed", name: "Fix login redirect" }] },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "640", status: "running", name: "Add carve-out" },
          { issueNumber: "655", status: "parked" },
        ],
      },
    ],
    parked: [{ issueNumber: "655", reason: "blocked", parkedAt: "now", branch: "agent/655", description: "?", options: [] }],
  });

  assert.match(text, /jjforge — status/);
  assert.match(text, /Wave 1\/2 ✅ closed/);
  assert.match(text, /✅ #436 Fix login redirect/);
  assert.match(text, /Wave 2\/2 ▶️ running/);
  assert.match(text, /🔄 #640 Add carve-out/);
  // No name available → chip is just the status + number.
  assert.match(text, /⏸ #655$/m);
  assert.match(text, /1 awaiting your reply/);
  assert.match(text, /#655 — blocked/);
});

test("formatStatusText reports when nothing is running", () => {
  const text = formatStatusText({ project: "demo", waves: [], parked: [] });
  assert.match(text, /demo — status/);
  assert.match(text, /No active run/);
});

test("formatStatusText omits the parked section when nothing is parked", () => {
  const text = formatStatusText({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "1", status: "running" }] }],
    parked: [],
  });
  assert.doesNotMatch(text, /awaiting your reply/);
});

test("renderStatusPage renders the landing live-bar top-right, not the old refresh widget (#79)", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "closed", issues: [] }], parked: [] });

  // The live-bar replaces the fixed-interval Refresh widget: a live/paused indicator,
  // an "updated Ns ago" readout, and a Pause button — the same controls the landing has.
  assert.match(html, /<div class="live-bar"[^>]*><span class="live-indicator" data-live-state="live">Live<\/span><span class="updated" data-updated>[^<]*<\/span><button type="button" id="pause" class="pause">Pause<\/button><\/div>/);
  assert.match(html, /\.live-indicator\[data-live-state="paused"\] \{ color: var\(--color-yellow\); \}/);
  // The old interval widget is gone entirely.
  assert.doesNotMatch(html, /id="refresh-seconds"/);
  assert.doesNotMatch(html, /id="refresh-enabled"/);
  assert.doesNotMatch(html, /class="refresh"/);
  assert.doesNotMatch(html, /sandcastle-status-refresh/);
  // The h1 drops the " status" wording; with no dropdown it is just the project name.
  assert.match(html, /<div class="page-top"><h1>demo<\/h1><div class="live-bar"/);
  assert.match(html, /\.page-top \{ display: flex;/);
});

test("renderStatusPage updates live off /api/events, reloading on a ping unless composing (#79)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // One SSE stream drives a full-page reload as events land (the page is server-rendered).
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  assert.match(html, /location\.reload\(\)/);
  // Guarded: a reply being composed in any textarea freezes the reload so it is never lost.
  assert.match(html, /const isComposing = \(\) =>/);
  assert.match(html, /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/);
  assert.match(html, /if \(paused \|\| isComposing\(\)\) \{ buffered\+\+;/);
  // Pause is a presentation freeze that flushes on resume, exactly as the landing's is.
  assert.match(html, /pauseBtn\.addEventListener\("click"/);
  assert.match(html, /"updated " \+ Math\.round\(\(Date\.now\(\) - lastUpdate\) \/ 1000\) \+ "s ago"/);
});

test("renderStatusPage marks carvable chips with carve data and never puts a carve control on a chip", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "101", status: "completed" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
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
  }, { carve: true });

  // Each chip carries its issue and project; only a still-carvable one is flagged
  // carvable, so the tap-detail panel knows whether to offer a Carve button.
  assert.match(html, /class="chip"[^>]*data-issue="301"[^>]*data-project="demo"[^>]*data-carvable="1"/);
  assert.match(html, /class="chip"[^>]*data-issue="302"[^>]*data-project="demo"[^>]*data-carvable="1"/);
  // The completed (banked) and current-wave-in-flight (running) chips are not carvable.
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-carvable/);
  assert.doesNotMatch(html, /data-issue="201"[^>]*data-carvable/);
  // Carve moved off the chips entirely: no inline ✂️ and no per-chip carve form.
  assert.doesNotMatch(html, /✂️/);
  assert.doesNotMatch(html, /class="carve-form"/);
  assert.doesNotMatch(html, /class="chip-group"/);
  assert.doesNotMatch(html, /class="carve-btn"/);
});

test("renderStatusPage omits the carve control unless the page opts into it", () => {
  // The control is opt-in: both the standalone and the aggregated server pass
  // `carve: true`, but a bare render (e.g. the empty-registry page) shows none.
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "unstarted", issues: [{ issueNumber: "301", status: "unstarted" }] }],
    parked: [],
  });

  assert.doesNotMatch(html, /action="\/carve"/);
});

test("parseCarveClosure reads the structured closure line the dry-run prints", () => {
  // The dry-run prints a `carve-closure {json}` line (E2) carrying the exact
  // closure — target, the dependents that would leave, the banked work kept, and
  // the remaining waves — so the panel names each without re-parsing the prose.
  const structured = { target: "201", dropped: ["201", "401"], keptBanked: ["301"], remaining: [["501"]] };
  assert.deepEqual(
    parseCarveClosure(
      `carve #201 → dropping #201, #401 (keeping banked #301)\nremaining campaign: "501"\ncarve-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
  // No structured line (e.g. an install predating E2) → null, so the route can 502
  // rather than half-render a closure it cannot vouch for.
  assert.equal(parseCarveClosure("carve #201 → nothing to drop\nremaining campaign: (nothing left to run)"), null);
});

test("listArchivedRuns lists a project's archived runs newest-first with summaries, skipping a malformed file", () => {
  const dir = join(tmpdir(), `sctdd-archive-list-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    { event: "campaign-start", batches: [["101"]] },
    { event: "campaign-done", batches: 1 },
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    { event: "campaign-start", batches: [["201"], ["202"]] },
    { event: "campaign-done", batches: 2 },
  ]);
  // A malformed archive (no reconstructable run) is skipped, not fatal — even
  // though its timestamp is the newest.
  writeFileSync(join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"), "not json at all\n{broken");

  const runs = listArchivedRuns(dir);

  // Newest-first by timestamp token; the malformed newest file is dropped.
  assert.deepEqual(runs.map((r) => r.run), ["2026-02-01T00-00-00-000Z", "2026-01-01T00-00-00-000Z"]);
  assert.equal(runs[0].summary, "campaign · 2 issues · complete");
  assert.equal(runs[1].summary, "campaign · 1 issue · complete");
  // Neither archived run was named, so each carries no name (the list falls back to its token).
  assert.equal(runs[0].name, undefined);
  assert.equal(runs[1].name, undefined);
  // The file path is resolved from the listing, never joined from request input.
  assert.ok(runs[0].file.endsWith("orchestrator-2026-02-01T00-00-00-000Z.jsonl"));
});

test("listArchivedRuns carries a named run's --name for the list's primary label", () => {
  const dir = join(tmpdir(), `sctdd-archive-named-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    { event: "campaign-start", batches: [["101"]], name: "gateway + comms" },
    { event: "campaign-done", batches: 1 },
  ]);

  const runs = listArchivedRuns(dir);
  assert.equal(runs[0].name, "gateway + comms");
});

test("listArchivedRuns returns nothing when a project has no archive directory", () => {
  assert.deepEqual(listArchivedRuns(join(tmpdir(), `sctdd-archive-none-${Date.now()}`)), []);
});

test("summarizeRun folds an archived log into a one-line mode/issue-count/outcome summary", () => {
  // A finished campaign of two waves (three issues total) that completed.
  assert.equal(
    summarizeRun([
      { event: "campaign-start", batches: [["101", "102"], ["201"]] },
      { event: "campaign-done", batches: 2 },
    ]),
    "campaign · 3 issues · complete",
  );
  // A campaign that halted on a failing issue — one issue, halted, singular noun.
  assert.equal(
    summarizeRun([
      { event: "campaign-start", batches: [["101"]] },
      { event: "campaign-halt", taskId: "101", reason: "gate failed" },
    ]),
    "campaign · 1 issue · halted",
  );
  // A queue-only run (no campaign frame) reads as a queue of its task ids.
  assert.equal(
    summarizeRun([
      { event: "queue-start", taskIds: ["101", "102"] },
      { event: "queue-done", outcomes: { "101": "green", "102": "green" } },
    ]),
    "queue · 2 issues · complete",
  );
});

test("summarizeRun describes only the last run in a multi-run archive (#69)", () => {
  // An archive whose live log accumulated two campaigns before it was archived: an
  // earlier run halted on #61, then a fresh campaign ran the remainder to completion
  // (this is the shape of the real sandcastle-tdd archive that read as "halted").
  // The summary must reflect the terminal run — complete, four issues — not fold the
  // stale campaign-halt from the superseded earlier run into a false "halted", and
  // its count must be the last run's, not the whole file's.
  const events = [
    { event: "campaign-start", batches: [["56", "57"], ["61"]], name: "first" },
    { event: "campaign-halt", taskId: "61", reason: "merge conflict" },
    { event: "campaign-start", batches: [["63"], ["64"], ["65"], ["67"]], name: "second" },
    { event: "campaign-batch-done", index: 0, merged: ["63"] },
    { event: "campaign-batch-done", index: 1, merged: ["64"] },
    { event: "campaign-batch-done", index: 2, merged: ["65"] },
    { event: "campaign-batch-done", index: 3, merged: ["67"] },
    { event: "campaign-done", batches: 4 },
  ];
  assert.equal(summarizeRun(events), "campaign · 4 issues · complete");
});

test("summarizeRun still reports halted when the last run halted after an earlier one completed (#69)", () => {
  // The mirror case: an earlier run completed, then a fresh campaign halted. The
  // terminal run halted, so the summary must say halted — the scoping must not swing
  // the other way and hide a genuine halt behind an earlier clean run.
  const events = [
    { event: "campaign-start", batches: [["101"]], name: "first" },
    { event: "campaign-done", batches: 1 },
    { event: "campaign-start", batches: [["201"], ["202"]], name: "second" },
    { event: "campaign-halt", taskId: "201", reason: "gate failed" },
  ];
  assert.equal(summarizeRun(events), "campaign · 2 issues · halted");
});

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails("I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?");

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, ["Return raw JSON", "Render HTML server-side"]);
});

test("parkedReplyFor returns the matching record's question and parsed options for the issue-detail sheet", () => {
  const records = [
    { taskId: "#102", parkedAt: "now", reason: "blocked", branch: "agent/102", question: "Which store?\n\nOptions:\n- Postgres\n- SQLite" },
    { taskId: "201", parkedAt: "now", reason: "blocked", branch: "agent/201", question: "No options here." },
  ];

  // Matched by normalized issue number (the "#" prefix is irrelevant).
  assert.deepEqual(parkedReplyFor(records, "102"), { question: "Which store?", options: ["Postgres", "SQLite"] });
  // A record with no Options section yields the whole question and no options.
  assert.deepEqual(parkedReplyFor(records, "201"), { question: "No options here.", options: [] });
  // No record names the issue → undefined, so the sheet shows only the free-text field.
  assert.equal(parkedReplyFor(records, "999"), undefined);
});

test("appendedEvents returns the whole log and its end offset from a zero offset", () => {
  const log = JSON.stringify({ event: "campaign-start" }) + "\n" + JSON.stringify({ event: "queue-start" }) + "\n";
  const { events, offset } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "queue-start"],
  );
  assert.equal(offset, log.length);
});

test("appendedEvents returns only the events appended past a prior offset", () => {
  const first = JSON.stringify({ event: "campaign-start" }) + "\n";
  const appended = JSON.stringify({ event: "turn", taskId: "101" }) + "\n";
  const { offset } = appendedEvents(first, 0);
  const next = appendedEvents(first + appended, offset);
  assert.deepEqual(
    next.events.map((e) => e.event),
    ["turn"],
  );
  assert.equal(next.offset, first.length + appended.length);
});

test("appendedEvents leaves a partial trailing line unconsumed until it is complete", () => {
  const complete = JSON.stringify({ event: "campaign-start" }) + "\n";
  const partial = '{"event":"turn"';
  const mid = appendedEvents(complete + partial, 0);
  // Only the complete line is consumed; the offset stops before the partial line.
  assert.deepEqual(
    mid.events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(mid.offset, complete.length);
  // Once the line is finished, resuming from the same offset yields it whole.
  const done = appendedEvents(complete + partial + ',"taskId":"101"}\n', mid.offset);
  assert.deepEqual(
    done.events.map((e) => e.event),
    ["turn"],
  );
});

test("appendedEvents re-reads from the start when the log is shorter than the offset (rotated/truncated)", () => {
  const rotated = JSON.stringify({ event: "campaign-start" }) + "\n";
  const { events, offset } = appendedEvents(rotated, 9999);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(offset, rotated.length);
});

test("appendedEvents skips an unparseable line the way readEvents does", () => {
  const log = "not json\n" + JSON.stringify({ event: "queue-start" }) + "\n";
  const { events } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["queue-start"],
  );
});
