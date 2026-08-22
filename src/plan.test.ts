import test from "node:test";
import assert from "node:assert/strict";
import { describePlan, layerWaves, waveArgs } from "./plan.ts";

// A fake OPEN-blocked-by resolver from a plain edge map: id -> its open blockers.
// (Closed blockers never reach the resolver — they are filtered at the edge — so
// anything listed here is, by contract, an open prerequisite still in flight.)
const openBlockedByFrom = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];

test("layerWaves orders the set by its in-set blockedBy graph", async () => {
  // 701 is blocked by 640; 640 is blocked by 611; 623 is free.
  const plan = await layerWaves(
    ["611", "623", "640", "701"],
    openBlockedByFrom({ "701": ["640"], "640": ["611"] }),
  );

  assert.deepEqual(plan.waves, [
    ["611", "623"], // wave 0: nothing open in the set blocks them
    ["640"], // wave 1: after 611
    ["701"], // wave 2: after 640
  ]);
  assert.deepEqual(plan.unreachable, []);
});

test("layerWaves puts a ticket whose blockers are all closed on the frontier", async () => {
  // 640's blocker already merged, so the resolver returns no open blocker for it:
  // it belongs in wave 0 next to the unblocked 611, not held back.
  const plan = await layerWaves(
    ["611", "640"],
    openBlockedByFrom({ "640": [] }),
  );

  assert.deepEqual(plan.waves, [["611", "640"]]);
  assert.deepEqual(plan.unreachable, []);
});

test("layerWaves drops a ticket held by an open blocker outside the set, and reports why", async () => {
  // 701's open blocker 555 is not in the selected set, so 701 cannot run here.
  const plan = await layerWaves(
    ["611", "701"],
    openBlockedByFrom({ "701": ["555"] }),
  );

  assert.deepEqual(plan.waves, [["611"]]);
  assert.deepEqual(plan.unreachable, [{ id: "701", external: ["555"], via: [] }]);
});

test("layerWaves carries unreachability down the dependent chain", async () => {
  // 701 is unreachable (open out-of-set blocker 555); 712 is blocked by 701, so
  // it cannot run either — it is dropped as a dependent, not silently scheduled.
  const plan = await layerWaves(
    ["611", "701", "712"],
    openBlockedByFrom({ "701": ["555"], "712": ["701"] }),
  );

  assert.deepEqual(plan.waves, [["611"]]);
  assert.deepEqual(plan.unreachable, [
    { id: "701", external: ["555"], via: [] },
    { id: "712", external: [], via: ["701"] },
  ]);
});

test("waveArgs emits the bare quoted wave args, ready to paste after `campaign`", async () => {
  const plan = await layerWaves(
    ["611", "623", "640", "701"],
    openBlockedByFrom({ "701": ["640"], "640": ["611"] }),
  );

  assert.equal(waveArgs(plan), '"611 623" "640" "701"');
});

test("describePlan explains each ticket's wave and lists what was dropped", async () => {
  const plan = await layerWaves(
    ["611", "640", "701", "712"],
    openBlockedByFrom({ "640": ["611"], "701": ["555"], "712": ["701"] }),
  );
  const report = describePlan(plan);

  // Each scheduled ticket names its wave and why it is there.
  assert.match(report, /wave 0.*#611/);
  assert.match(report, /wave 1.*#640.*611/); // after its in-set blocker
  // Dropped tickets are reported with their reason, never silently omitted.
  assert.match(report, /#701.*555.*outside/i); // held by an out-of-set open blocker
  assert.match(report, /#712.*701/); // dropped as a dependent of 701
  // A dropped ticket is never presented as scheduled.
  assert.doesNotMatch(report, /wave \d+\s+#701/);
});
