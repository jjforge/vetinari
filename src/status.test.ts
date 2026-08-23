import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { buildAllStatus, buildLanding, buildStatus, buildStatusWithIssueNames, campaignRunning, describeEvent, extractParkedDetails, formatStatusText, lastEventText, listArchivedRuns, parseCarveClosure, reduceCampaign, renderLandingShell, renderStatusPage, selectStatus, serveAllStatus, summarizeRun } from "./status.ts";
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

test("serveAllStatus renders a single registered project as a one-entry dropdown with campaign, wave and parked intact", async () => {
  const configDir = join(tmpdir(), `sctdd-serve-solo-${Date.now()}`);
  const soloDir = join(configDir, "state-solo");
  seedState(soloDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"]] }]);
  // A parked issue in the active campaign — the single-project view keeps its answer card.
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
    // Its own campaign wave and parked answer card render intact.
    assert.match(solo, /#101 <small>/);
    assert.match(solo, /Parked issues/);
    assert.match(solo, /<form method="post" action="\/answer"/);
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

test("serveAllStatus GET /carve?preview returns the selected project's closure as JSON", async () => {
  const configDir = join(tmpdir(), `sctdd-agg-carve-json-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["301"]] }]);
  seedState(betaDir, [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["201"], ["401"]] }]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const closures: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the closure to the selected project's own install,
    // which computes it against that project's real blockedBy graph.
    carveClosure: (projectRoot, taskId) => {
      closures.push({ projectRoot, taskId });
      return Promise.resolve({ target: taskId, removed: [taskId, "401"] });
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve?preview&taskId=201&project=beta`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { target: "201", removed: ["201", "401"] });
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
    carveClosure: () => Promise.resolve({ target: "201", removed: ["201"] }),
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

  // Many-issue wave (closed): lead title + "+N" on its collapsed chip.
  assert.match(html, /<span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+2<\/summary>/);
  // Single-issue wave (open): just that issue's title.
  assert.match(html, /<section class="wave"><h2>Wave 2 — cache eviction <span class="wave-status running">running<\/span>/);
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

  // Many-issue wave (closed): lead title + "+N" on its collapsed chip.
  assert.match(html, /<span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+2<\/summary>/);
  // Single-issue wave (open): just that issue's title.
  assert.match(html, /<section class="wave"><h2>Wave 2 — cache eviction <span class="wave-status running">running<\/span>/);
  // Every chip carries its own title on hover — 201 has no status detail yet, so
  // its hover is exactly the resolved title.
  assert.match(html, /<button[^>]*title="cache eviction"[^>]*>/);
  // A chip whose issue also has a status detail carries the title alongside it.
  assert.match(html, /title="config resolution&#10;Merged into base"/);
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
  assert.match(html, /<section class="wave"><h2>Wave 1 <span class="wave-status running">running<\/span>/);
  // The answer control carries the project so the gateway can route the reply to it.
  assert.match(html, /<input type="hidden" name="project" value="beta" \/>/);
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

  // Live header shows the campaign's name.
  assert.match(html, /class="run-name">gateway work</);

  // Named run: the link text is the NAME, and the mode·issues·outcome summary is a secondary label.
  assert.match(html, /run=2026-02-01T00-00-00-000Z"[^>]*>comms \+ dashboard<\/a>/);
  assert.match(html, /<span class="run-summary">campaign · 2 issues · complete<\/span>/);
  // Unnamed run: the link text falls back to the timestamp token.
  assert.match(html, /run=2026-01-01T00-00-00-000Z"[^>]*>2026-01-01T00-00-00-000Z<\/a>/);
  assert.match(html, /<span class="run-summary">queue · 1 issue · halted<\/span>/);

  // The archived-run view carries the run's name beside its token.
  assert.match(html, /<section class="archived-run"><h2>Archived run[^<]*comms \+ dashboard/);
});

test("renderStatusPage omits the run-name header for an unnamed run", () => {
  const html = renderStatusPage({ project: "beta", waves: [{ index: 0, status: "running", issues: [] }], parked: [] });
  assert.doesNotMatch(html, /class="run-name"/);
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

  assert.match(html, /data-detail="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/);
  assert.match(html, /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/);
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /chip\.addEventListener\("click"/);
});

test("renderStatusPage pins the tapped-issue detail to a dismissible bottom bar", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Fixed to the bottom of the viewport and hidden until a chip is tapped.
  assert.match(html, /\.issue-detail \{ position: fixed;[^}]*bottom: 0;/);
  assert.match(html, /\.issue-detail \{[^}]*display: none;/);
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  // Text lives in its own span so the close button can sit beside it.
  assert.match(html, /<span class="issue-detail-text"><\/span><button type="button" id="issue-detail-close"/);
  assert.match(html, /showDetail\(issueDetailText\.textContent === text \? "" : text\)/);
  assert.match(html, /getElementById\("issue-detail-close"\)\.addEventListener\("click", \(\) => showDetail\(""\)\)/);
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

  assert.match(html, /<section class="parked-issues"><h2>Parked issues <span class="parked-count">1 awaiting you<\/span>/);
  // Parked section comes before the first wave section.
  assert.ok(html.indexOf('class="parked-issues"') < html.indexOf('class="wave"'), "parked should render above the waves");
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
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
  assert.match(html, /<details class="completed-wave"><summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1<\/summary>/);
  assert.match(html, /\.completed-wave-chip \.check \{ color: var\(--color-green\);/);
  // Expanded summary is block-level (no inline line-box leading) and spaced from its chips.
  assert.match(html, /\.completed-wave\[open\] > \.completed-wave-chip \{ display: flex; width: max-content; margin-bottom: \.6rem; \}/);
  // Chip rows must not stretch: the first wrapped line was rendering taller in Safari.
  assert.match(html, /\.completed-wave-bar, \.chips \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/);
  assert.match(html, /<section class="wave"><h2>Wave 2 <span class="wave-status running">running<\/span><\/h2>/);
});

test("renderStatusPage labels a single-issue wave with that issue's resolved title, keeping the index", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 1, status: "running", issues: [{ issueNumber: "201", status: "running", name: "config resolution" }] }],
    parked: [],
  });

  assert.match(html, /<section class="wave"><h2>Wave 2 — config resolution <span class="wave-status running">running<\/span>/);
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

  assert.match(html, /<summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1 — config resolution \+1<\/summary>/);
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

test("renderStatusPage includes a configurable refresh interval control", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "closed", issues: [] }], parked: [] });

  assert.match(html, /<summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1<\/summary>/);
  assert.match(html, /class="refresh" title="Auto-refresh the page every N seconds"/);
  assert.match(html, /<input id="refresh-enabled" type="checkbox" checked \/> <span>Refresh<\/span>/);
  assert.doesNotMatch(html, /Auto-refresh<\/span>|>every<|>s<\/span>/);
  // No pill/chip background around the control.
  assert.doesNotMatch(html, /\.refresh \{[^}]*border-radius: 999px/);
  assert.match(html, /id="refresh-seconds"/);
  assert.match(html, /max="999"/);
  assert.match(html, /\.refresh input\[type="number"\] \{ width: 3ch;/);
  assert.match(html, /<div class="page-top"><h1>demo status<\/h1><div class="refresh"/);
  assert.match(html, /\.page-top \{ display: flex;/);
  assert.doesNotMatch(html, /\.refresh \{ position: (?:sticky|fixed);/);
  assert.match(html, /\.running \{ background: var\(--color-blue\); \}/);
  assert.match(html, /localStorage\.getItem\("sandcastle-status-refresh-seconds"\) \?\? "45"/);
  assert.match(html, /isComposing\(\) \? scheduleRefresh\(\) : location\.reload\(\)/);
  assert.match(html, /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/);
});

test("renderStatusPage auto-refresh checkbox gates and persists the timer", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Checkbox toggles auto-refresh, defaults on unless previously disabled.
  assert.match(html, /refreshEnabled\.checked = localStorage\.getItem\("sandcastle-status-refresh-enabled"\) !== "false"/);
  assert.match(html, /localStorage\.setItem\("sandcastle-status-refresh-enabled", String\(refreshEnabled\.checked\)\)/);
  // Timer only arms when the box is checked; the interval field disables when off.
  assert.match(html, /refreshInput\.disabled = !refreshEnabled\.checked/);
  assert.match(html, /if \(refreshEnabled\.checked && Number\.isFinite\(seconds\) && seconds > 0\)/);
  assert.match(html, /refreshEnabled\.addEventListener\("change", scheduleRefresh\)/);
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

test("parseCarveClosure reads the target and closure from carve --dry-run text", () => {
  // A running-campaign dry-run names the target, its dropped dependents, and any
  // banked members kept — all three are closure members and belong in `removed`.
  assert.deepEqual(
    parseCarveClosure("201", "carve #201 → dropping #201, #401 (keeping banked #301)\nremaining campaign: (nothing left to run)"),
    { target: "201", removed: ["201", "401", "301"] },
  );
  // A target that drops nothing is just itself.
  assert.deepEqual(parseCarveClosure("#201", "carve #201 → nothing to drop\nremaining campaign: \"301\""), { target: "201", removed: ["201"] });
  // The "remaining campaign" line names what stays, so it never leaks in.
  assert.deepEqual(parseCarveClosure("640", "carve #640 → dropping #640, #655\nremaining campaign: \"701 702\""), {
    target: "640",
    removed: ["640", "655"],
  });
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

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails("I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?");

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, ["Return raw JSON", "Render HTML server-side"]);
});
