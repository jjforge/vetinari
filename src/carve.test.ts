import test from "node:test";
import assert from "node:assert/strict";
import { applyCarve, carveClosure, computeCarve, restrictBlockers } from "./carve.ts";

// A fake "blocked by" resolver from a plain edge map: id -> the ids that block it.
const blockedByFrom = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];

// A reduced campaign's outcomes as a plain map: id -> its current status.
const outcomesFrom = (o: Record<string, string>) => new Map(Object.entries(o));

test("computeCarve removes a linear dependent chain and keeps unrelated issues", async () => {
  const res = await computeCarve(
    [["611", "640"], ["623", "701"]],
    "640",
    blockedByFrom({ "701": ["640"] }), // 701 is blocked by 640
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, [["611"], ["623"]]);
});

test("computeCarve follows every branch and sub-chain of dependents", async () => {
  const res = await computeCarve(
    [["611", "640"], ["623", "701", "712", "720"], ["730"]],
    "640",
    blockedByFrom({ "701": ["640"], "712": ["701"], "720": ["701"], "730": ["720"], "623": ["611"] }),
  );

  assert.deepEqual(res.removed.sort(), ["640", "701", "712", "720", "730"]);
  // 611 and its own dependent 623 are unreachable to 640, so they stay.
  assert.deepEqual(res.remaining, [["611"], ["623"]]);
});

test("computeCarve removes a diamond dependent even when it has another, kept blocker", async () => {
  const res = await computeCarve(
    [["623", "640"], ["750"]],
    "640",
    blockedByFrom({ "750": ["640", "623"] }), // 750 needs BOTH; 623 is kept
  );

  assert.ok(res.removed.includes("750"), "750 depends on the carved 640 via one path, so it must go");
  assert.deepEqual(res.remaining, [["623"]]);
});

test("computeCarve removes only the target when nothing depends on it, dropping an emptied wave", async () => {
  const res = await computeCarve(
    [["611", "623"], ["640"]],
    "640",
    blockedByFrom({}),
  );

  assert.deepEqual(res.removed, ["640"]);
  assert.deepEqual(res.remaining, [["611", "623"]]); // the "640"-only wave is dropped
});

test("computeCarve normalizes leading # in the target, waves, and resolver output", async () => {
  const res = await computeCarve(
    [["#611", "#640"], ["#701"]],
    "#640",
    blockedByFrom({ "701": ["#640"] }),
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, [["611"]]);
});

test("computeCarve rejects a target that is not in the campaign", async () => {
  await assert.rejects(
    () => computeCarve([["611", "640"]], "999", blockedByFrom({})),
    /999.*not in the campaign/i,
  );
});

test("computeCarve ignores blockers that live outside the named campaign", async () => {
  // 701's blocker 555 is not part of this campaign; only the in-campaign edge to 640 matters.
  const res = await computeCarve(
    [["640", "701"]],
    "640",
    blockedByFrom({ "701": ["640", "555"] }),
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, []);
});

test("applyCarve keeps a merged member and drops an unstarted one", () => {
  // 640 already merged, 701 not yet started; both are in the removed closure.
  const res = applyCarve(
    { waves: [["611", "640"], ["701"]], outcomes: outcomesFrom({ "640": "completed" }) },
    ["640", "701"],
  );

  // Banked work stays; the unstarted dependent leaves the plan.
  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []);
  assert.deepEqual(res.remaining, [["611", "640"]]); // 701's wave emptied and dropped
});

test("applyCarve drops a parked member but preserves its record by default (resumable)", () => {
  // 701 is parked; carving it drops it from the plan but leaves its parked record
  // intact so its branch/worktree/session can be investigated and resumed (ADR 0013).
  const res = applyCarve(
    { waves: [["611"], ["701"]], outcomes: outcomesFrom({ "701": "parked" }) },
    ["701"],
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []); // preserved, not cleared
  assert.deepEqual(res.remaining, [["611"]]);
});

test("applyCarve with purge drops a parked member and clears its record (the true drop)", () => {
  // `--purge` is the rare true-drop: the parked record is cleared, reclaiming the work.
  const res = applyCarve(
    { waves: [["611"], ["701"]], outcomes: outcomesFrom({ "701": "parked" }) },
    ["701"],
    { purge: true },
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, ["701"]);
  assert.deepEqual(res.remaining, [["611"]]);
});

test("applyCarve keeps a green member so it still merges", () => {
  // 640 is green (mergeable) but in the closure — banked work is never discarded.
  const res = applyCarve(
    { waves: [["640", "701"]], outcomes: outcomesFrom({ "640": "completed", "701": "unstarted" }) },
    ["640", "701"],
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []);
  assert.deepEqual(res.remaining, [["640"]]);
});

test("applyCarve keeps a merged/green target but still drops its unfinished dependents", () => {
  // The target 640 already merged; its dependents 701 (parked) and 712 (unstarted)
  // are unfinished, so the deliberate subtree removal still drops them.
  const res = applyCarve(
    {
      waves: [["640"], ["701", "712"]],
      outcomes: outcomesFrom({ "640": "completed", "701": "parked" }),
    },
    ["640", "701", "712"],
  );

  assert.deepEqual(res.dropped, ["701", "712"]);
  assert.deepEqual(res.parkedToClear, []); // preserved by default
  assert.deepEqual(res.remaining, [["640"]]);
});

test("carveClosure names the target, dropped dependents, kept-banked work, and remaining waves", () => {
  // 640 already merged (banked), its dependent 701 unstarted: the closure is
  // {640, 701}, but only 701 leaves the plan — 640 stays banked.
  const removed = ["640", "701"];
  const applied = applyCarve(
    { waves: [["611", "640"], ["701"]], outcomes: outcomesFrom({ "640": "completed" }) },
    removed,
  );

  assert.deepEqual(carveClosure("640", removed, applied), {
    target: "640",
    dropped: ["701"],
    keptBanked: ["640"],
    remaining: [["611", "640"]],
  });
});

test("carveClosure normalizes a leading # target and keeps closure order for kept-banked", () => {
  // Nothing merged: every closure member is dropped, so kept-banked is empty.
  const removed = ["640", "701", "712"];
  const applied = applyCarve({ waves: [["640"], ["701", "712"]], outcomes: outcomesFrom({}) }, removed);

  assert.deepEqual(carveClosure("#640", removed, applied), {
    target: "640",
    dropped: ["640", "701", "712"],
    keptBanked: [],
    remaining: [],
  });
});

test("restrictBlockers keeps only the edges that stay inside the selected set", async () => {
  // 701 is blocked by 640 (in the set) and 555 (outside it); 611 has no blocker.
  const { inSet, external } = await restrictBlockers(
    ["611", "640", "701"],
    blockedByFrom({ "701": ["#640", "555"], "640": ["611"] }),
  );

  assert.deepEqual([...inSet.get("701")!], ["640"], "external blocker 555 is not an in-set edge");
  assert.deepEqual([...external.get("701")!], ["555"], "555 is recorded as external");
  assert.deepEqual([...inSet.get("640")!], ["611"]);
  assert.deepEqual([...inSet.get("611")!], []);
  assert.deepEqual([...external.get("640")!], []);
});
