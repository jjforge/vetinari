// Tests for the POST /graft route (dashboard-route-graft.ts). After #367 the route
// shells the REAL `graft <ids…> --json` through the awaiting `runChild` seam (no
// pre-validation dry-run) and reads the child's outcome to decide the response: a clean
// exit redirects, a rejection (a `graft-closure` line on a non-zero exit) 422s with the
// per-id verdicts, a broken child 502s with its last stderr line, and a child still
// running at the cap 202s without being killed.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "./registry.ts";
import type { ChildResult } from "./dashboard-child.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handleGraft } from "./dashboard-route-graft.ts";

let counter = 0;

const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/graft", headers: {} });

const resSpy = () => {
  const res: { statusCode?: number; headers?: unknown; body?: string; writeHead(s: number, h?: unknown): typeof res; end(b?: string): void } = {
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(b) {
      res.body = b;
    },
  };
  return res;
};

// A config dir with one registered project — the route only needs the pointer to route
// the child to the project's own root (ADR 0002); it reads no event log itself.
const seed = () => {
  const configDir = join(tmpdir(), `vetinari-graft-route-${Date.now()}-${counter++}`);
  const project = "beta";
  register(configDir, { project, projectRoot: join(configDir, "beta-root"), baseLocation: join(configDir, "state-beta") });
  return { configDir, project, projectRoot: join(configDir, "beta-root") };
};

// Deps whose runChild returns a canned outcome and records how it was called. graftClosure
// is a tripwire — the POST path must not spawn a dry-run child (acceptance: grafts once).
const depsFor = (configDir: string, outcome: ChildResult) => {
  const calls: { projectRoot: string; args: string[]; timeoutMs: number }[] = [];
  let graftClosureCalls = 0;
  let spawns = 0;
  const deps: DashboardDeps = {
    configDir,
    spawn: () => (spawns++, undefined),
    prunePreview: async () => null,
    pruneClosure: async () => null,
    graftClosure: async () => (graftClosureCalls++, null),
    runChild: async (projectRoot, args, opts) => {
      calls.push({ projectRoot, args, timeoutMs: opts.timeoutMs });
      return outcome;
    },
    graftTimeoutMs: 60_000,
  };
  return { deps, calls, get graftClosureCalls() { return graftClosureCalls; }, get spawns() { return spawns; } };
};

const graftClosureLine = (closure: unknown) => `graft rejected — nothing added (already in the campaign: #202).\ngraft-closure ${JSON.stringify(closure)}`;

test("POST /graft with missing ids or project is a 400", async () => {
  const { configDir } = seed();
  const { deps } = depsFor(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("project=beta") as never, res as never, new URL("http://x/graft"), deps);
  assert.equal(res.statusCode, 400);
});

test("POST /graft with an unknown project is a 404", async () => {
  const { configDir } = seed();
  const { deps } = depsFor(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("ids=640&project=ghost") as never, res as never, new URL("http://x/graft"), deps);
  assert.equal(res.statusCode, 404);
});

test("POST /graft shells the real `graft <ids…> --json` once, awaits it, and 303s on a clean exit", async () => {
  const { configDir, projectRoot } = seed();
  const bundle = depsFor(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  const handled = await handleGraft(postReq("ids=640 655&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(handled, true);
  // Awaited a single real graft (not a dry-run) in the project's own root, with the cap.
  assert.deepEqual(bundle.calls, [{ projectRoot, args: ["graft", "640", "655", "--json"], timeoutMs: 60_000 }]);
  assert.equal(bundle.graftClosureCalls, 0, "no pre-validation dry-run child on the POST path");
  assert.equal(bundle.spawns, 0, "the fire-and-forget spawn is not used");
  // The response means recorded-in-the-log: redirect to the board where the wave appears.
  assert.equal(res.statusCode, 303);
  assert.equal((res.headers as { location: string }).location, "/?project=beta");
});

test("POST /graft on a rejected batch (non-zero exit with a closure line) 422s with the per-id verdicts and keeps the ids", async () => {
  const { configDir } = seed();
  const closure = { project: "beta", ids: ["640", "202"], placement: [], remaining: [["201"]], rejected: [{ id: "202", reason: "already-in-campaign" }] };
  const bundle = depsFor(configDir, { code: 1, stdout: graftClosureLine(closure), stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("ids=640 202&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 422);
  assert.match(res.body ?? "", /Nothing grafted/i);
  assert.match(res.body ?? "", /#640 — would graft/);
  assert.match(res.body ?? "", /#202 — already in the campaign/);
  assert.match(res.body ?? "", /data-graft-ids="640 202"/);
});

test("POST /graft on a broken child (non-zero exit, no closure line) 502s with the child's last non-empty stderr line", async () => {
  const { configDir } = seed();
  const bundle = depsFor(configDir, {
    code: 1,
    stdout: "",
    stderr: "some noise\ngraft adds to an open campaign, but the latest one is settled — every member merged.\n\n",
    timedOut: false,
  });
  const res = resSpy();
  await handleGraft(postReq("ids=640&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 502);
  // The child's own last line — its language — reaches the operator, not a generic message.
  assert.equal(res.body, "graft adds to an open campaign, but the latest one is settled — every member merged.");
});

test("POST /graft on a child still running at the cap 202s (child left running) and the note says the wave lands later", async () => {
  const { configDir } = seed();
  const bundle = depsFor(configDir, { code: null, stdout: "", stderr: "", timedOut: true });
  const res = resSpy();
  await handleGraft(postReq("ids=640&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 202);
  assert.match(res.body ?? "", /wave will appear when it lands/i);
});
