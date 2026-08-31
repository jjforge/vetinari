import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, deregisterProject, fairShare, machineDefaultCeiling, projectHasLiveCampaign, readLeases, registerProject, releaseSlot, resolveHostCeiling, withHostSlot, type HostBudget } from "./host-slots.ts";

const freshDir = () => mkdtempSync(join(tmpdir(), "vetinari-slots-"));
const alive = () => true;
const budget = (configDir: string, ceiling: number, weight = 1): HostBudget => ({ configDir, ceiling, weight });

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
  registerProject(dir, "solo", 1, "campaign", { pid: 100, isAlive: alive });
  // Alone, the project fills the whole ceiling (3) — only the host ceiling bites.
  assert.equal(acquireSlot(dir, 3, "solo", 1, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, { pid: 100, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 3, "solo", 1, { pid: 100, isAlive: alive }), false);

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
  registerProject(dir, "A", 1, "campaign", A);
  for (let i = 0; i < 4; i++) assert.equal(acquireSlot(dir, 4, "A", 1, A), true);

  // B arrives. The host is full, so neither can take a slot yet — A is never
  // preempted; it only stops re-acquiring above its now-smaller share.
  registerProject(dir, "B", 1, "campaign", B);
  assert.equal(acquireSlot(dir, 4, "A", 1, A), false);
  assert.equal(acquireSlot(dir, 4, "B", 1, B), false);

  // As A's containers finish, B fills in first-come until each holds its share (2).
  releaseSlot(dir, A);
  assert.equal(acquireSlot(dir, 4, "B", 1, B), true);
  releaseSlot(dir, A);
  assert.equal(acquireSlot(dir, 4, "B", 1, B), true);

  // Steady state: 2 each, and neither can climb past its share.
  assert.equal(acquireSlot(dir, 4, "A", 1, A), false);
  assert.equal(acquireSlot(dir, 4, "B", 1, B), false);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { A: 2, B: 2 });
});

test("a crashed run's leases are reclaimed on contention — the budget is never wedged", () => {
  const dir = freshDir();
  // A fills the whole budget of 2, then its process dies.
  registerProject(dir, "A", 1, "campaign", { pid: 1, isAlive: alive });
  assert.equal(acquireSlot(dir, 2, "A", 1, { pid: 1, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 2, "A", 1, { pid: 1, isAlive: alive }), true);

  // B arrives and sees pid 1 as dead: A's slots are reclaimed, so B is not wedged.
  const bIsAlive = (pid: number) => pid !== 1;
  registerProject(dir, "B", 1, "campaign", { pid: 2, isAlive: bIsAlive });
  assert.equal(acquireSlot(dir, 2, "B", 1, { pid: 2, isAlive: bIsAlive }), true);

  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { B: 1 });
});

test("over-subscribed, only the heaviest projects seat a slot; the rest are denied", () => {
  const dir = freshDir();
  const a = { pid: 1, isAlive: alive };
  const b = { pid: 2, isAlive: alive };
  const c = { pid: 3, isAlive: alive };
  registerProject(dir, "a", 3, "campaign", a);
  registerProject(dir, "b", 2, "campaign", b);
  registerProject(dir, "c", 1, "campaign", c);
  // Budget 2, three active projects: a and b get their floor, c waits.
  assert.equal(acquireSlot(dir, 2, "a", 3, a), true);
  assert.equal(acquireSlot(dir, 2, "b", 2, b), true);
  assert.equal(acquireSlot(dir, 2, "c", 1, c), false);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { a: 1, b: 1, c: 0 });
});

test("projectHasLiveCampaign reads a live campaign lease — the campaign-liveness guard / crash probe (design §7, §8)", () => {
  const dir = freshDir();
  const dead = new Set<number>();
  const isAlive = (pid: number) => !dead.has(pid);

  // No lease at all — the project holds no campaign, so it is not live.
  assert.equal(projectHasLiveCampaign(dir, "alpha", { isAlive }), false);

  // A registered campaign holds a lease the moment it registers (even at held zero, waiting
  // first-come), so it reads live while its process is up.
  registerProject(dir, "alpha", 1, "campaign", { pid: 500, isAlive });
  assert.equal(projectHasLiveCampaign(dir, "alpha", { isAlive }), true);
  // The probe is per-project — a sibling project's live campaign says nothing about this one.
  assert.equal(projectHasLiveCampaign(dir, "beta", { isAlive }), false);

  // The campaign dies: its lease lingers on disk (nothing deregistered it) but its pid is gone,
  // so it is no longer live — the signal a live read reconciles to a crash.
  dead.add(500);
  assert.equal(projectHasLiveCampaign(dir, "alpha", { isAlive }), false);
});

test("projectHasLiveCampaign ignores a standalone run's lease — a run is not a live campaign (design §5 step 3, §8)", () => {
  const dir = freshDir();
  // A standalone `run` registers its lease as `kind: "run"`; it holds a slot, but it is not
  // a campaign, so a second run/answer/redrive for the project must not be refused as one.
  registerProject(dir, "solo", 1, "run", { pid: 700, isAlive: alive });
  assert.equal(acquireSlot(dir, 4, "solo", 1, { pid: 700, isAlive: alive }), true);
  assert.equal(projectHasLiveCampaign(dir, "solo", { isAlive: alive }), false);
  // The run lease is real on disk and holds a slot — it just does not read as a campaign.
  const lease = readLeases(dir).find((l) => l.pid === 700)!;
  assert.equal(lease.kind, "run");
  assert.equal(lease.held, 1);
});

test("two standalone runs for different issues share one project's ceiling concurrently, neither a live campaign (design §8)", () => {
  const dir = freshDir();
  // Two `run` processes for the same project (different issues) each keyed by their own pid.
  const one = { pid: 71, isAlive: alive };
  const two = { pid: 72, isAlive: alive };
  registerProject(dir, "solo", 1, "run", one);
  registerProject(dir, "solo", 1, "run", two);
  // Alone in the project, both fit under the fair share (the whole ceiling) — they run concurrently.
  assert.equal(acquireSlot(dir, 4, "solo", 1, one), true);
  assert.equal(acquireSlot(dir, 4, "solo", 1, two), true);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.pid, l.held]));
  assert.deepEqual(held, { 71: 1, 72: 1 });
  // Neither standalone run is a live campaign, so a third run/answer/redrive is not refused.
  assert.equal(projectHasLiveCampaign(dir, "solo", { isAlive: alive }), false);
});

test("a legacy lease with no kind reads as campaign, and is rewritten with an explicit kind on next acquire", () => {
  const dir = freshDir();
  // Simulate a lease written before the kind field existed.
  mkdirSync(join(dir, "slots"), { recursive: true });
  writeFileSync(join(dir, "slots", "800.json"), JSON.stringify({ project: "legacy", weight: 1, held: 0, pid: 800 }));

  // Read conservatively as a campaign, so the guard never silently stops seeing it.
  assert.equal(readLeases(dir)[0].kind, "campaign");
  assert.equal(projectHasLiveCampaign(dir, "legacy", { isAlive: alive }), true);

  // The next acquire rewrites the record with its (campaign) kind stamped explicitly.
  assert.equal(acquireSlot(dir, 4, "legacy", 1, { pid: 800, isAlive: alive }), true);
  const raw = JSON.parse(readFileSync(join(dir, "slots", "800.json"), "utf8"));
  assert.equal(raw.kind, "campaign");
  assert.equal(raw.held, 1);
});

test("machineDefaultCeiling derives a bounded ceiling from the CPU count, never below one", () => {
  // Leaves one core for the host/orchestrator so a lone project never swamps the machine.
  assert.equal(machineDefaultCeiling(8), 7);
  assert.equal(machineDefaultCeiling(2), 1);
  // Degenerate CPU counts still seat at least one container.
  assert.equal(machineDefaultCeiling(1), 1);
  assert.equal(machineDefaultCeiling(0), 1);
});

test("resolveHostCeiling: with no env and no file it falls back to the machine-derived default", () => {
  const dir = freshDir();
  const saved = process.env.MAX_CONCURRENT_CONTAINERS;
  delete process.env.MAX_CONCURRENT_CONTAINERS;
  try {
    assert.equal(resolveHostCeiling(dir), machineDefaultCeiling(cpus().length));
  } finally {
    if (saved !== undefined) process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("resolveHostCeiling: reads the max-concurrent-containers file, and the env overrides it", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "max-concurrent-containers"), "6\n");
  const saved = process.env.MAX_CONCURRENT_CONTAINERS;
  delete process.env.MAX_CONCURRENT_CONTAINERS;
  try {
    assert.equal(resolveHostCeiling(dir), 6);
    process.env.MAX_CONCURRENT_CONTAINERS = "9";
    assert.equal(resolveHostCeiling(dir), 9);
  } finally {
    if (saved === undefined) delete process.env.MAX_CONCURRENT_CONTAINERS;
    else process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("resolveHostCeiling: a non-numeric or non-positive setting falls back to the machine default", () => {
  const dir = freshDir();
  const saved = process.env.MAX_CONCURRENT_CONTAINERS;
  try {
    process.env.MAX_CONCURRENT_CONTAINERS = "nonsense";
    assert.equal(resolveHostCeiling(dir), machineDefaultCeiling(cpus().length));
    process.env.MAX_CONCURRENT_CONTAINERS = "0";
    assert.equal(resolveHostCeiling(dir), machineDefaultCeiling(cpus().length));
  } finally {
    if (saved === undefined) delete process.env.MAX_CONCURRENT_CONTAINERS;
    else process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("deregister removes a run's lease entirely, returning its slots to the budget", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", A);
  assert.equal(acquireSlot(dir, 2, "A", 1, A), true);
  deregisterProject(dir, A);
  assert.deepEqual(readLeases(dir), []);
});

test("withHostSlot registers and holds one slot for the life of fn, then releases and deregisters (design §3 step 1, §8)", async () => {
  const dir = freshDir();
  const opts = { pid: 42, isAlive: alive };
  let leaseDuring: { held: number; kind: string } | undefined;
  let campaignDuring = true;
  const out = await withHostSlot(budget(dir, 4), "solo", async () => {
    const l = readLeases(dir).find((l) => l.pid === 42);
    leaseDuring = l && { held: l.held, kind: l.kind };
    // A standalone run holds a slot, but its lease is `kind: "run"` — never a live campaign.
    campaignDuring = projectHasLiveCampaign(dir, "solo", { isAlive: alive });
    return "green";
  }, opts);
  assert.equal(out, "green", "it returns fn's value");
  assert.deepEqual(leaseDuring, { held: 1, kind: "run" }, "it holds one slot as a run lease during the run");
  assert.equal(campaignDuring, false, "a standalone run is not a live campaign");
  assert.deepEqual(readLeases(dir), [], "the lease is gone once the run finishes — released and deregistered");
});

test("withHostSlot releases and deregisters even when fn throws", async () => {
  const dir = freshDir();
  await assert.rejects(
    withHostSlot(budget(dir, 4), "solo", async () => {
      throw new Error("boom");
    }, { pid: 42, isAlive: alive }),
    /boom/,
  );
  assert.deepEqual(readLeases(dir), [], "a throw still returns the slot and the lease");
});

test("withHostSlot waits first-come when the ceiling is full, then proceeds once a slot frees (§8)", async () => {
  const dir = freshDir();
  // Another project already fills the single-slot ceiling.
  const other = { pid: 7, isAlive: alive };
  registerProject(dir, "other", 1, "campaign", other);
  assert.equal(acquireSlot(dir, 1, "other", 1, other), true);

  let waits = 0;
  const wait = async () => {
    // Free the contended slot on the first spin so the wait resolves.
    if (waits++ === 0) releaseSlot(dir, other);
  };
  let ran = false;
  await withHostSlot(budget(dir, 1), "mine", async () => {
    ran = true;
  }, { pid: 42, isAlive: alive, wait });
  assert.equal(ran, true, "fn runs once the ceiling frees");
  assert.ok(waits >= 1, "it waited rather than exceeding the ceiling");
});
