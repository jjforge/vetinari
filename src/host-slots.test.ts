import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, deregisterProject, fairShare, readHostBudget, readLeases, registerProject, releaseSlot } from "./host-slots.ts";

const freshDir = () => mkdtempSync(join(tmpdir(), "sctdd-slots-"));
const alive = () => true;

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

test("a lone project acquires up to the budget, then is denied — held is recorded", () => {
  const dir = freshDir();
  registerProject(dir, "solo", 1, { pid: 100, isAlive: alive });
  // QUEUE_SLOTS is high (10) so only the host budget (3) bites.
  assert.equal(acquireSlot(dir, 3, "solo", 1, 10, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, 10, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, 10, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, 10, { pid: 100, isAlive: alive }), false);

  const leases = readLeases(dir);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].project, "solo");
  assert.equal(leases[0].held, 3);
});

test("a busy project drains to its fair share as a new project becomes active — no preemption", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  const B = { pid: 2, isAlive: alive };
  // A runs alone and fills the whole budget of 4.
  registerProject(dir, "A", 1, A);
  for (let i = 0; i < 4; i++) assert.equal(acquireSlot(dir, 4, "A", 1, 10, A), true);

  // B arrives. The host is full, so neither can take a slot yet — A is never
  // preempted; it only stops re-acquiring above its now-smaller share.
  registerProject(dir, "B", 1, B);
  assert.equal(acquireSlot(dir, 4, "A", 1, 10, A), false);
  assert.equal(acquireSlot(dir, 4, "B", 1, 10, B), false);

  // As A's containers finish, B fills in first-come until each holds its share (2).
  releaseSlot(dir, A);
  assert.equal(acquireSlot(dir, 4, "B", 1, 10, B), true);
  releaseSlot(dir, A);
  assert.equal(acquireSlot(dir, 4, "B", 1, 10, B), true);

  // Steady state: 2 each, and neither can climb past its share.
  assert.equal(acquireSlot(dir, 4, "A", 1, 10, A), false);
  assert.equal(acquireSlot(dir, 4, "B", 1, 10, B), false);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { A: 2, B: 2 });
});

test("a crashed run's leases are reclaimed on contention — the budget is never wedged", () => {
  const dir = freshDir();
  // A fills the whole budget of 2, then its process dies.
  registerProject(dir, "A", 1, { pid: 1, isAlive: alive });
  assert.equal(acquireSlot(dir, 2, "A", 1, 10, { pid: 1, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 2, "A", 1, 10, { pid: 1, isAlive: alive }), true);

  // B arrives and sees pid 1 as dead: A's slots are reclaimed, so B is not wedged.
  const bIsAlive = (pid: number) => pid !== 1;
  registerProject(dir, "B", 1, { pid: 2, isAlive: bIsAlive });
  assert.equal(acquireSlot(dir, 2, "B", 1, 10, { pid: 2, isAlive: bIsAlive }), true);

  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { B: 1 });
});

test("over-subscribed, only the heaviest projects seat a slot; the rest are denied", () => {
  const dir = freshDir();
  const a = { pid: 1, isAlive: alive };
  const b = { pid: 2, isAlive: alive };
  const c = { pid: 3, isAlive: alive };
  registerProject(dir, "a", 3, a);
  registerProject(dir, "b", 2, b);
  registerProject(dir, "c", 1, c);
  // Budget 2, three active projects: a and b get their floor, c waits.
  assert.equal(acquireSlot(dir, 2, "a", 3, 10, a), true);
  assert.equal(acquireSlot(dir, 2, "b", 2, 10, b), true);
  assert.equal(acquireSlot(dir, 2, "c", 1, 10, c), false);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { a: 1, b: 1, c: 0 });
});

test("readHostBudget: with no env and no file the host budget is disabled (undefined)", () => {
  const dir = freshDir();
  const saved = process.env.SANDCASTLE_HOST_SLOTS;
  delete process.env.SANDCASTLE_HOST_SLOTS;
  try {
    assert.equal(readHostBudget(dir), undefined);
  } finally {
    if (saved !== undefined) process.env.SANDCASTLE_HOST_SLOTS = saved;
  }
});

test("readHostBudget: reads the host-slots file, and the env overrides it", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "host-slots"), "6\n");
  const saved = process.env.SANDCASTLE_HOST_SLOTS;
  delete process.env.SANDCASTLE_HOST_SLOTS;
  try {
    assert.equal(readHostBudget(dir), 6);
    process.env.SANDCASTLE_HOST_SLOTS = "9";
    assert.equal(readHostBudget(dir), 9);
  } finally {
    if (saved === undefined) delete process.env.SANDCASTLE_HOST_SLOTS;
    else process.env.SANDCASTLE_HOST_SLOTS = saved;
  }
});

test("deregister removes a run's lease entirely, returning its slots to the budget", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, A);
  assert.equal(acquireSlot(dir, 2, "A", 1, 10, A), true);
  deregisterProject(dir, A);
  assert.deepEqual(readLeases(dir), []);
});
