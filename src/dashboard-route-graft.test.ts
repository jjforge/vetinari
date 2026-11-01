// Tests for the POST /graft route (dashboard-route-graft.ts). After #367 the route
// shells the REAL `graft <ids…> --json` through the awaiting `runChild` seam (no
// pre-validation dry-run) and reads the child's outcome to decide the response: a clean
// exit redirects, a rejection (a `graft-closure` line on a non-zero exit) 422s with the
// per-id verdicts, a broken child 502s with its last stderr line, and a child still
// running at the cap 202s without being killed.
import test from "node:test";
import assert from "node:assert/strict";
import { handleGraft } from "./dashboard-route-graft.ts";
import { childDeps, postReq, resSpy, seedProject } from "./test-support.ts";

const graftClosureLine = (closure: unknown) =>
  `graft rejected — nothing added (already in the campaign: #202).\ngraft-closure ${JSON.stringify(closure)}`;

test("POST /graft with missing ids or project is a 400", async () => {
  const { configDir } = seedProject();
  const { deps } = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("/graft", "project=beta") as never, res as never, new URL("http://x/graft"), deps);
  assert.equal(res.statusCode, 400);
});

test("POST /graft with an unknown project is a 404", async () => {
  const { configDir } = seedProject();
  const { deps } = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("/graft", "ids=640&project=ghost") as never, res as never, new URL("http://x/graft"), deps);
  assert.equal(res.statusCode, 404);
});

test("POST /graft shells the real `graft <ids…> --json` once, awaits it, and 303s on a clean exit", async () => {
  const { configDir, projectRoot } = seedProject();
  const bundle = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  const handled = await handleGraft(
    postReq("/graft", "ids=640 655&project=beta") as never,
    res as never,
    new URL("http://x/graft"),
    bundle.deps,
  );
  assert.equal(handled, true);
  // Awaited a single real graft (not a dry-run) in the project's own root, with the cap.
  assert.deepEqual(bundle.calls, [{ projectRoot, args: ["graft", "640", "655", "--json"], timeoutMs: 60_000 }]);
  assert.equal(bundle.graftClosureCalls, 0, "no pre-validation dry-run child on the POST path");
  // The response means recorded-in-the-log: redirect to the board where the wave appears.
  assert.equal(res.statusCode, 303);
  assert.equal((res.headers as { location: string }).location, "/?project=beta");
});

test("POST /graft on a rejected batch (non-zero exit with a closure line) 422s with the per-id verdicts and keeps the ids", async () => {
  const { configDir } = seedProject();
  const closure = {
    project: "beta",
    ids: ["640", "202"],
    placement: [],
    remaining: [["201"]],
    rejected: [{ id: "202", reason: "already-in-campaign" }],
  };
  const bundle = childDeps(configDir, { code: 1, stdout: graftClosureLine(closure), stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("/graft", "ids=640 202&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 422);
  assert.match(res.body ?? "", /Nothing grafted/i);
  assert.match(res.body ?? "", /#640 — would graft/);
  assert.match(res.body ?? "", /#202 — already in the campaign/);
  assert.match(res.body ?? "", /data-graft-ids="640 202"/);
});

test("POST /graft on a broken child (non-zero exit, no closure line) 502s with the child's last non-empty stderr line", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, {
    code: 1,
    stdout: "",
    stderr: "some noise\ngraft adds to an open campaign, but the latest one is settled — every member merged.\n\n",
    timedOut: false,
  });
  const res = resSpy();
  await handleGraft(postReq("/graft", "ids=640&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 502);
  // The child's own last line — its language — reaches the operator, not a generic message.
  assert.equal(res.body, "graft adds to an open campaign, but the latest one is settled — every member merged.");
});

test("POST /graft on a child still running at the cap 202s (child left running) and the note says the wave lands later", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: null, stdout: "", stderr: "", timedOut: true });
  const res = resSpy();
  await handleGraft(postReq("/graft", "ids=640&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.equal(res.statusCode, 202);
  assert.match(res.body ?? "", /wave will appear when it lands/i);
});

test("POST /graft with any id that is not an issue token is a 400 and shells nothing (#524)", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(
    postReq("/graft", "ids=1,--config,/tmp/x.mjs&project=beta") as never,
    res as never,
    new URL("http://x/graft"),
    bundle.deps,
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(bundle.calls, [], "no graft child is run for a bad id");
  assert.equal(bundle.graftClosureCalls, 0);
});

test("POST /graft passes `#`-prefixed issue ids through to the child unchanged (#524)", async () => {
  const { configDir } = seedProject();
  const bundle = childDeps(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  await handleGraft(postReq("/graft", "ids=%2312,13&project=beta") as never, res as never, new URL("http://x/graft"), bundle.deps);
  assert.deepEqual(
    bundle.calls.map((c) => c.args),
    [["graft", "#12", "13", "--json"]],
  );
});
