import test from "node:test";
import assert from "node:assert/strict";
import { computeCarve } from "./carve.ts";

// A fake "blocked by" resolver from a plain edge map: id -> the ids that block it.
const blockedByFrom = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];

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
