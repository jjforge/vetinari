import test from "node:test";
import assert from "node:assert/strict";
import { fairShare } from "./host-slots.ts";

test("a project running alone gets the whole budget", () => {
  assert.equal(fairShare(8, { solo: 1 }, "solo"), 8);
});

test("when active projects outnumber the budget, floors go to the heaviest and the rest get zero", () => {
  // budget 2, three projects: only the two heaviest seat their floor of one.
  const weights = { a: 3, b: 2, c: 1 };
  assert.equal(fairShare(2, weights, "a"), 1);
  assert.equal(fairShare(2, weights, "b"), 1);
  assert.equal(fairShare(2, weights, "c"), 0);
});

test("a heavier weight takes a larger cut of the remainder", () => {
  // budget 10, a:3 b:1 → floor 1 each (2 used), remainder 8 split 3:1 → a +6, b +2.
  const weights = { a: 3, b: 1 };
  assert.equal(fairShare(10, weights, "a"), 7);
  assert.equal(fairShare(10, weights, "b"), 3);
});

test("equal-weight projects each get a floor of one plus an even cut of the remainder", () => {
  // budget 6, three equal projects: floor 1 each (3 used), remainder 3 split
  // evenly → each gets 2, and the shares sum to exactly the budget.
  const weights = { a: 1, b: 1, c: 1 };
  assert.equal(fairShare(6, weights, "a"), 2);
  assert.equal(fairShare(6, weights, "b"), 2);
  assert.equal(fairShare(6, weights, "c"), 2);
});
