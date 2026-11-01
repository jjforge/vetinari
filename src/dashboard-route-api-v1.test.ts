// Contract tests for the external read API under /api/v1/ (dashboard-route-api-v1.ts, ADR 0027):
// every shape is pinned against a literal of the exact JSON, so a dashboard-model change that would
// reach an outside consumer fails here first. See docs/api.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFileOf, type CampaignStatus } from "./dashboard-model.ts";
import { event } from "./event-log.ts";
import { register } from "./registry.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { resSpy } from "./test-support.ts";
import {
  apiV1Campaign,
  apiV1CampaignState,
  apiV1ProjectSummary,
  handleApiV1Campaign,
  handleApiV1Projects,
} from "./dashboard-route-api-v1.ts";

// Round-trip through JSON so an `undefined` field can't pass for an absent or `null` one.
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// A campaign carrying every v1-relevant case and every dashboard-only field the mapper must drop.
const fixture: CampaignStatus = {
  project: "gamma",
  name: "the spring run",
  festiveOffset: 3,
  inFlight: ["11", "12"],
  stopPending: true,
  baseGates: { count: 2, seconds: 40 },
  waves: [
    {
      index: 0,
      status: "parked",
      reason: "red-base",
      closed: false,
      timeSplit: { total: 6, agent: 3, integration: 2, postMerge: 1 },
      issues: [
        { issueNumber: "1", status: "completed", membership: "member", name: "first issue", detail: "merged" },
        { issueNumber: "2", status: "completed" },
      ],
    },
    {
      index: 1,
      status: "parked",
      closed: false,
      issues: [
        { issueNumber: "11", status: "running", membership: "member", phase: { label: "testing", steady: false }, pendingGreen: true },
        { issueNumber: "12", status: "parked", reason: "question", membership: "member", detail: "Parked: question" },
        { issueNumber: "13", status: "unstarted", membership: "grafted" },
        { issueNumber: "14", status: "unstarted", membership: "pruned" },
      ],
    },
    {
      index: 2,
      status: "unstarted",
      closed: false,
      pruned: true,
      issues: [{ issueNumber: "21", status: "unstarted", membership: "pruned" }],
    },
  ],
  parked: [
    {
      issueNumber: "12",
      reason: "question",
      parkedAt: "2026-10-31T12:00:00.000Z",
      answeredAt: "2026-10-31T13:00:00.000Z",
      branch: "agent/12",
      description: "Which port should it bind?",
      options: ["8080", "8765"],
    },
  ],
};

test("the v1 campaign mapper copies out only the contract fields, in the orchestrator vocabulary", () => {
  assert.deepStrictEqual(asJson(apiV1Campaign(fixture, { repo: "jjforge/gamma" })), {
    project: "gamma",
    repo: "jjforge/gamma",
    name: "the spring run",
    status: "parked",
    waves: [
      {
        index: 0,
        status: "parked",
        reason: "red-base",
        members: [
          { issue: "1", status: "completed", reason: null, membership: "member" },
          { issue: "2", status: "completed", reason: null, membership: "member" },
        ],
      },
      {
        index: 1,
        status: "parked",
        reason: null,
        members: [
          { issue: "11", status: "running", reason: null, membership: "member" },
          { issue: "12", status: "parked", reason: "question", membership: "member" },
          { issue: "13", status: "unstarted", reason: null, membership: "grafted" },
          { issue: "14", status: "unstarted", reason: null, membership: "pruned" },
        ],
      },
    ],
    parked: [{ issue: "12", reason: "question", parkedAt: "2026-10-31T12:00:00.000Z", question: "Which port should it bind?" }],
  });
});

test("the v1 project summary counts each live member by status, leaving pruned members uncounted", () => {
  const running: CampaignStatus = {
    project: "gamma",
    name: "the spring run",
    parked: [],
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "1", status: "completed" },
          { issueNumber: "2", status: "running", membership: "member" },
          { issueNumber: "3", status: "running", membership: "grafted" },
          { issueNumber: "4", status: "failed", membership: "pruned" },
        ],
      },
      { index: 1, status: "unstarted", issues: [{ issueNumber: "5", status: "unstarted" }] },
      { index: 2, status: "unstarted", pruned: true, issues: [{ issueNumber: "6", status: "unstarted", membership: "pruned" }] },
    ],
  };
  assert.deepStrictEqual(asJson(apiV1ProjectSummary(running, { repo: "jjforge/gamma" })), {
    project: "gamma",
    repo: "jjforge/gamma",
    campaign: { name: "the spring run", status: "running", issues: { unstarted: 1, running: 2, parked: 0, completed: 1, failed: 0 } },
  });
});

test("the v1 project summary of a project with no campaign is unstarted with zero counts and nulls for the absent fields", () => {
  assert.deepStrictEqual(asJson(apiV1ProjectSummary({ project: "delta", waves: [], parked: [] }, {})), {
    project: "delta",
    repo: null,
    campaign: { name: null, status: "unstarted", issues: { unstarted: 0, running: 0, parked: 0, completed: 0, failed: 0 } },
  });
});

test("the v1 project summary of a park that outlived its log reads parked", () => {
  const parkedOnly: CampaignStatus = {
    project: "delta",
    waves: [],
    parked: [
      { issueNumber: "9", reason: "stalled", parkedAt: "2026-10-31T12:00:00.000Z", branch: "agent/9", description: "", options: [] },
    ],
  };
  assert.deepStrictEqual(asJson(apiV1ProjectSummary(parkedOnly, {})), {
    project: "delta",
    repo: null,
    campaign: { name: null, status: "parked", issues: { unstarted: 0, running: 0, parked: 0, completed: 0, failed: 0 } },
  });
});

test("the v1 campaign status: a failed fold stays failed over a park, a park reads parked over running, completed stays completed", () => {
  const park = [
    { issueNumber: "9", reason: "question", parkedAt: "2026-10-31T12:00:00.000Z", branch: "agent/9", description: "?", options: [] },
  ];
  const wave = (status: "failed" | "running" | "completed") => ({ index: 0, status, issues: [] });
  assert.equal(apiV1CampaignState({ waves: [wave("failed")], parked: park }), "failed");
  assert.equal(apiV1CampaignState({ waves: [wave("running")], parked: park }), "parked");
  assert.equal(apiV1CampaignState({ waves: [wave("completed")], parked: [] }), "completed");
});

// A config dir with `gamma` registered (repo `jjforge/gamma`) over a seeded live log — a campaign of
// two waves whose first member parked on a question — and `ghost`, registered over a base location
// that was never created.
const seedRegistry = () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-api-v1-"));
  const base = join(configDir, "base");
  register(configDir, { project: "gamma", projectRoot: join(configDir, "root"), baseLocation: base, repo: "jjforge/gamma" });
  register(configDir, { project: "ghost", projectRoot: join(configDir, "ghost-root"), baseLocation: join(configDir, "gone") });
  mkdirSync(join(base, "logs"), { recursive: true });
  const events = [
    event("campaign-start", { ts: "2026-10-31T10:00:00.000Z", waves: [["1"], ["2"]], name: "the spring run", slots: 1 }),
    event("wave-start", { ts: "2026-10-31T10:01:00.000Z", index: 0, tasks: ["1"] }),
    event("spawn", { ts: "2026-10-31T10:02:00.000Z", taskId: "1" }),
    event("parked", { ts: "2026-10-31T10:03:00.000Z", taskId: "1", reason: "question" }),
  ];
  writeFileSync(logFileOf(base), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return configDir;
};

const depsFor = (configDir: string): DashboardDeps => ({
  configDir,
  prunePreview: async () => null,
  pruneClosure: async () => null,
  graftClosure: async () => null,
  runChild: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  graftTimeoutMs: 60_000,
});

// Call a handler with a GET (or the given method) for `path`, returning whether it handled it and the response spy.
const call = async (handler: typeof handleApiV1Projects, configDir: string, path: string, method = "GET") => {
  const res = resSpy();
  const handled = await handler({ method, url: path, headers: {} } as never, res as never, new URL(`http://x${path}`), depsFor(configDir));
  return { handled, res };
};

const expectedGammaCampaign = {
  project: "gamma",
  repo: "jjforge/gamma",
  name: "the spring run",
  status: "parked",
  waves: [
    { index: 0, status: "parked", reason: null, members: [{ issue: "1", status: "parked", reason: "question", membership: "member" }] },
    { index: 1, status: "unstarted", reason: null, members: [{ issue: "2", status: "unstarted", reason: null, membership: "member" }] },
  ],
  parked: [],
};

test("GET /api/v1/projects answers JSON with one summary per project whose base location exists", async () => {
  const { handled, res } = await call(handleApiV1Projects, seedRegistry(), "/api/v1/projects");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.headers, { "content-type": "application/json" });
  assert.deepStrictEqual(JSON.parse(res.body ?? ""), {
    projects: [
      {
        project: "gamma",
        repo: "jjforge/gamma",
        campaign: { name: "the spring run", status: "parked", issues: { unstarted: 1, running: 0, parked: 1, completed: 0, failed: 0 } },
      },
    ],
  });
});

test("GET /api/v1/campaign?project=<name> answers JSON with that project's campaign", async () => {
  const { handled, res } = await call(handleApiV1Campaign, seedRegistry(), "/api/v1/campaign?project=gamma");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.headers, { "content-type": "application/json" });
  assert.deepStrictEqual(JSON.parse(res.body ?? ""), expectedGammaCampaign);
});

test("GET /api/v1/campaign answers 404 for a missing project, an unknown one, or one whose base location is gone", async () => {
  const configDir = seedRegistry();
  for (const path of [
    "/api/v1/campaign",
    "/api/v1/campaign?project=nobody",
    "/api/v1/campaign?project=ghost",
    "/api/v1/campaign?project=../base",
  ]) {
    const { handled, res } = await call(handleApiV1Campaign, configDir, path);
    assert.equal(handled, true, path);
    assert.equal(res.statusCode, 404, path);
    assert.equal(res.body, "not found", path);
  }
});

test("a POST to a v1 JSON route is not handled", async () => {
  const configDir = seedRegistry();
  assert.equal((await call(handleApiV1Projects, configDir, "/api/v1/projects", "POST")).handled, false);
  assert.equal((await call(handleApiV1Campaign, configDir, "/api/v1/campaign?project=gamma", "POST")).handled, false);
});
