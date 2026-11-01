// Tests for the POST /prune confirm leg (dashboard-route-prune.ts). After #365 the route
// shells `prune <id>` through the awaiting `runChild` seam, capped at the shared dashboard
// child cap, and reads the child's outcome: a clean exit redirects, a failed child 502s
// with its last stderr line, and a child still running at the cap 202s without being killed.
import test from "node:test";
import assert from "node:assert/strict";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handlePrune, handlePrunePreview } from "./dashboard-route-prune.ts";
import { childDeps, postReq, resSpy, seedProject } from "./test-support.ts";

const confirm = "taskId=401&project=beta&confirm=1";

test("POST /prune confirm awaits `prune <id>` in the project's root, capped at the dashboard child cap, and 303s on a clean exit", async () => {
  const { configDir, projectRoot } = seedProject();
  const bundle = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  const handled = await handlePrune(postReq("/prune", confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(handled, true);
  assert.deepEqual(bundle.calls, [{ projectRoot, args: ["prune", "401"], timeoutMs: 60_000 }]);
  assert.equal(res.statusCode, 303);
  assert.equal((res.headers as { location: string }).location, "/?project=beta");
});

test("POST /prune confirm on a failed child 502s with the child's last non-empty stderr line", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, {
    code: 1,
    stdout: "",
    stderr: "some noise\nprune: #401 is not in the running campaign.\n\n",
    timedOut: false,
  });
  const res = resSpy();
  await handlePrune(postReq("/prune", confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "prune: #401 is not in the running campaign.");
});

test("POST /prune confirm on a failed child with no stderr 502s with a fixed sentence naming the issue", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: 1, stdout: "", stderr: "\n", timedOut: false });
  const res = resSpy();
  await handlePrune(postReq("/prune", confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "Couldn't prune #401 for beta — is a campaign still running?");
});

test("POST /prune confirm on a child still running at the cap 202s (child left running) with a lands-later note", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: null, stdout: "", stderr: "", timedOut: true });
  const res = resSpy();
  await handlePrune(postReq("/prune", confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, "pruning… #401 will drop from the plan when it lands");
});

// A taskId that is not an issue token would land in the child's argv as an option (`--config
// <path>` imports a module), so every prune leg refuses it before any spawn seam runs (#524).
const tripwireDeps = (configDir: string) => {
  const spawned: string[] = [];
  const deps: DashboardDeps = {
    configDir,
    prunePreview: async () => (spawned.push("prunePreview"), null),
    pruneClosure: async () => (spawned.push("pruneClosure"), null),
    graftClosure: async () => (spawned.push("graftClosure"), null),
    runChild: async () => (spawned.push("runChild"), { code: 0, stdout: "", stderr: "", timedOut: false }),
    graftTimeoutMs: 60_000,
  };
  return { deps, spawned };
};

test("GET /prune?preview with a taskId that is not an issue token is a 400 and shells nothing (#524)", async () => {
  const { configDir } = seedProject();
  const { deps, spawned } = tripwireDeps(configDir);
  const res = resSpy();
  const url = new URL("http://x/prune?preview&taskId=--config&project=beta");
  await handlePrunePreview({ method: "GET", url: url.pathname + url.search, headers: {} } as never, res as never, url, deps);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(spawned, []);
});

test("POST /prune (preview and confirm legs) with a taskId that is not an issue token is a 400 and shells nothing (#524)", async () => {
  for (const body of ["taskId=--config&project=beta", "taskId=--config&project=beta&confirm=1"]) {
    const { configDir } = seedProject();
    const { deps, spawned } = tripwireDeps(configDir);
    const res = resSpy();
    await handlePrune(postReq("/prune", body) as never, res as never, new URL("http://x/prune"), deps);
    assert.equal(res.statusCode, 400, body);
    assert.deepEqual(spawned, [], body);
  }
});

test("POST /prune confirm passes a `#`-prefixed issue id through to the child unchanged (#524)", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  await handlePrune(
    postReq("/prune", "taskId=%2312&project=beta&confirm=1") as never,
    resSpy() as never,
    new URL("http://x/prune"),
    bundle.deps,
  );
  assert.deepEqual(
    bundle.calls.map((c) => c.args),
    [["prune", "#12"]],
  );
});
