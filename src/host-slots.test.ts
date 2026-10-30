import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSlot,
  deregisterProject,
  fairShare,
  LiveCampaignRefusal,
  machineDefaultCeiling,
  liveCampaignPid,
  projectHasLiveCampaign,
  readLeases,
  registerProject,
  releaseSlot,
  resolveHostCeiling,
  slotsDir,
  withHostSlot,
  type HostBudget,
} from "./host-slots.ts";
import { Refusal } from "./refusal.ts";

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

test("a project is capped at what it wants; the surplus flows to a project still short of its want", () => {
  // Ceiling 8, equal weight, one wanting 1 and one wanting 7. Weight alone would
  // split 4/4, reserving three idle slots against work vetinari does not have;
  // demand-aware max-min gives vetinari its 1 and jjforge the whole 7 it wants.
  const weights = { vetinari: 2, jjforge: 2 };
  const wants = { vetinari: 1, jjforge: 7 };
  assert.equal(fairShare(8, weights, "vetinari", wants), 1);
  assert.equal(fairShare(8, weights, "jjforge", wants), 7);
});

test("under genuine contention the weighted floor holds — both wanting the whole ceiling split it by weight", () => {
  // Ceiling 8, equal weight, both wanting all eight: neither is want-capped, so the
  // surplus never moves and the demand-aware split is the plain weighted 4/4.
  const weights = { a: 2, b: 2 };
  const wants = { a: 8, b: 8 };
  assert.equal(fairShare(8, weights, "a", wants), 4);
  assert.equal(fairShare(8, weights, "b", wants), 4);
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
  registerProject(dir, "solo", 1, "campaign", 3, { pid: 100, isAlive: alive });
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
  registerProject(dir, "A", 1, "campaign", 4, A);
  for (let i = 0; i < 4; i++) assert.equal(acquireSlot(dir, 4, "A", 1, A), true);

  // B arrives. The host is full, so neither can take a slot yet — A is never
  // preempted; it only stops re-acquiring above its now-smaller share.
  registerProject(dir, "B", 1, "campaign", 4, B);
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

test("a one-ticket wave reserves no idle slots: a busy project fills the host up to what it wants (max-min share)", () => {
  const dir = freshDir();
  const V = { pid: 1, isAlive: alive };
  const J = { pid: 2, isAlive: alive };
  // vetinari's wave is a single ticket: it holds one slot and wants no more.
  registerProject(dir, "vetinari", 2, "campaign", 1, V);
  assert.equal(acquireSlot(dir, 8, "vetinari", 2, V), true);
  // jjforge wants seven. Weight alone would cap it at four, idling three host slots
  // while its tickets are refused; demand-aware share lets it take the whole seven.
  registerProject(dir, "jjforge", 2, "campaign", 7, J);
  for (let i = 0; i < 7; i++) assert.equal(acquireSlot(dir, 8, "jjforge", 2, J), true, `slot ${i}`);
  // Host full at eight (vetinari 1 + jjforge 7); the next acquire is refused.
  assert.equal(acquireSlot(dir, 8, "jjforge", 2, J), false);
  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { vetinari: 1, jjforge: 7 });
});

test("a crashed run's leases are reclaimed on contention — the budget is never wedged", () => {
  const dir = freshDir();
  // A fills the whole budget of 2, then its process dies.
  registerProject(dir, "A", 1, "campaign", 2, { pid: 1, isAlive: alive });
  assert.equal(acquireSlot(dir, 2, "A", 1, { pid: 1, isAlive: alive }), true);
  assert.equal(acquireSlot(dir, 2, "A", 1, { pid: 1, isAlive: alive }), true);

  // B arrives and sees pid 1 as dead: A's slots are reclaimed, so B is not wedged.
  const bIsAlive = (pid: number) => pid !== 1;
  registerProject(dir, "B", 1, "campaign", 2, { pid: 2, isAlive: bIsAlive });
  assert.equal(acquireSlot(dir, 2, "B", 1, { pid: 2, isAlive: bIsAlive }), true);

  const held = Object.fromEntries(readLeases(dir).map((l) => [l.project, l.held]));
  assert.deepEqual(held, { B: 1 });
});

test("over-subscribed, only the heaviest projects seat a slot; the rest are denied", () => {
  const dir = freshDir();
  const a = { pid: 1, isAlive: alive };
  const b = { pid: 2, isAlive: alive };
  const c = { pid: 3, isAlive: alive };
  registerProject(dir, "a", 3, "campaign", 2, a);
  registerProject(dir, "b", 2, "campaign", 2, b);
  registerProject(dir, "c", 1, "campaign", 2, c);
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
  registerProject(dir, "alpha", 1, "campaign", 1, { pid: 500, isAlive });
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
  registerProject(dir, "solo", 1, "run", 1, { pid: 700, isAlive: alive });
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
  registerProject(dir, "solo", 1, "run", 1, one);
  registerProject(dir, "solo", 1, "run", 1, two);
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
    const warnings: string[] = [];
    assert.equal(
      resolveHostCeiling(dir, (m) => warnings.push(m)),
      machineDefaultCeiling(cpus().length),
    );
    assert.deepEqual(warnings, []);
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
    const warnings: string[] = [];
    assert.equal(
      resolveHostCeiling(dir, (m) => warnings.push(m)),
      6,
    );
    process.env.MAX_CONCURRENT_CONTAINERS = "9";
    assert.equal(
      resolveHostCeiling(dir, (m) => warnings.push(m)),
      9,
    );
    assert.deepEqual(warnings, []);
  } finally {
    if (saved === undefined) delete process.env.MAX_CONCURRENT_CONTAINERS;
    else process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("resolveHostCeiling: a non-numeric or non-positive setting falls back to the machine default", () => {
  const dir = freshDir();
  const saved = process.env.MAX_CONCURRENT_CONTAINERS;
  try {
    for (const bad of ["abc", "0", "-2"]) {
      const warnings: string[] = [];
      process.env.MAX_CONCURRENT_CONTAINERS = bad;
      assert.equal(
        resolveHostCeiling(dir, (m) => warnings.push(m)),
        machineDefaultCeiling(cpus().length),
      );
      assert.deepEqual(warnings, [`[vetinari] MAX_CONCURRENT_CONTAINERS="${bad}" is not a positive integer — ignoring it`]);
    }
    // A bad env still falls through to a valid file, warning only about the env.
    writeFileSync(join(dir, "max-concurrent-containers"), "6\n");
    const warnings: string[] = [];
    process.env.MAX_CONCURRENT_CONTAINERS = "abc";
    assert.equal(
      resolveHostCeiling(dir, (m) => warnings.push(m)),
      6,
    );
    assert.deepEqual(warnings, ['[vetinari] MAX_CONCURRENT_CONTAINERS="abc" is not a positive integer — ignoring it']);
  } finally {
    if (saved === undefined) delete process.env.MAX_CONCURRENT_CONTAINERS;
    else process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("resolveHostCeiling: a non-positive-integer max-concurrent-containers file warns with its path and falls back to the machine default", () => {
  const dir = freshDir();
  const file = join(dir, "max-concurrent-containers");
  writeFileSync(file, "nope\n");
  const saved = process.env.MAX_CONCURRENT_CONTAINERS;
  delete process.env.MAX_CONCURRENT_CONTAINERS;
  try {
    const warnings: string[] = [];
    assert.equal(
      resolveHostCeiling(dir, (m) => warnings.push(m)),
      machineDefaultCeiling(cpus().length),
    );
    assert.deepEqual(warnings, [`[vetinari] ${file}: "nope" is not a positive integer — ignoring it`]);
  } finally {
    if (saved !== undefined) process.env.MAX_CONCURRENT_CONTAINERS = saved;
  }
});

test("deregister removes a run's lease entirely, returning its slots to the budget", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", 2, A);
  assert.equal(acquireSlot(dir, 2, "A", 1, A), true);
  deregisterProject(dir, A);
  assert.deepEqual(readLeases(dir), []);
});

test("withHostSlot registers and holds one slot for the life of fn, then releases and deregisters (design §3 step 1, §8)", async () => {
  const dir = freshDir();
  const opts = { pid: 42, isAlive: alive };
  let leaseDuring: { held: number; kind: string } | undefined;
  let campaignDuring = true;
  const out = await withHostSlot(
    budget(dir, 4),
    "solo",
    async () => {
      const l = readLeases(dir).find((l) => l.pid === 42);
      leaseDuring = l && { held: l.held, kind: l.kind };
      // A standalone run holds a slot, but its lease is `kind: "run"` — never a live campaign.
      campaignDuring = projectHasLiveCampaign(dir, "solo", { isAlive: alive });
      return "green";
    },
    opts,
  );
  assert.equal(out, "green", "it returns fn's value");
  assert.deepEqual(leaseDuring, { held: 1, kind: "run" }, "it holds one slot as a run lease during the run");
  assert.equal(campaignDuring, false, "a standalone run is not a live campaign");
  assert.deepEqual(readLeases(dir), [], "the lease is gone once the run finishes — released and deregistered");
});

test("withHostSlot releases and deregisters even when fn throws", async () => {
  const dir = freshDir();
  await assert.rejects(
    withHostSlot(
      budget(dir, 4),
      "solo",
      async () => {
        throw new Error("boom");
      },
      { pid: 42, isAlive: alive },
    ),
    /boom/,
  );
  assert.deepEqual(readLeases(dir), [], "a throw still returns the slot and the lease");
});

test("withHostSlot waits first-come when the ceiling is full, then proceeds once a slot frees (§8)", async () => {
  const dir = freshDir();
  // Another project already fills the single-slot ceiling.
  const other = { pid: 7, isAlive: alive };
  registerProject(dir, "other", 1, "campaign", 1, other);
  assert.equal(acquireSlot(dir, 1, "other", 1, other), true);

  let waits = 0;
  const wait = async () => {
    // Free the contended slot on the first spin so the wait resolves.
    if (waits++ === 0) releaseSlot(dir, other);
  };
  let ran = false;
  await withHostSlot(
    budget(dir, 1),
    "mine",
    async () => {
      ran = true;
    },
    { pid: 42, isAlive: alive, wait },
  );
  assert.equal(ran, true, "fn runs once the ceiling frees");
  assert.ok(waits >= 1, "it waited rather than exceeding the ceiling");
});

test("liveCampaignPid returns the live campaign's pid for the project — the `vetinari stop` target", () => {
  const dir = freshDir();
  const dead = new Set<number>();
  const isAlive = (pid: number) => !dead.has(pid);

  assert.equal(liveCampaignPid(dir, "alpha", { isAlive }), undefined);

  // A campaign between waves holds its lease at zero demand (#424) — still a live campaign.
  registerProject(dir, "alpha", 1, "campaign", 0, { pid: 500, isAlive });
  assert.equal(projectHasLiveCampaign(dir, "alpha", { isAlive }), true);
  assert.equal(liveCampaignPid(dir, "alpha", { isAlive }), 500);

  // Another project's campaign and a standalone run are not this project's campaign.
  registerProject(dir, "beta", 1, "campaign", 1, { pid: 600, isAlive });
  registerProject(dir, "gamma", 1, "run", 1, { pid: 700, isAlive });
  assert.equal(liveCampaignPid(dir, "gamma", { isAlive }), undefined);
  assert.equal(liveCampaignPid(dir, "alpha", { isAlive }), 500);

  // The campaign died: its lease lingers but its pid is gone.
  dead.add(500);
  assert.equal(liveCampaignPid(dir, "alpha", { isAlive }), undefined);
});

// A lock-free reader (`readLeases`) must never see a truncated lease, so every lease
// write replaces the file by rename — a new inode — rather than rewriting it in place.
const leaseInode = (dir: string, pid: number) => statSync(join(slotsDir(dir), `${pid}.json`)).ino;
const strayTemps = (dir: string) => readdirSync(slotsDir(dir)).filter((n) => n.endsWith(".tmp"));

test("re-registering replaces the lease file atomically rather than rewriting it in place", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", 2, A);
  const before = leaseInode(dir, 1);
  registerProject(dir, "A", 1, "campaign", 5, A);
  assert.notEqual(leaseInode(dir, 1), before);
  assert.deepEqual(readLeases(dir), [{ project: "A", weight: 1, held: 0, want: 5, pid: 1, kind: "campaign" }]);
  assert.deepEqual(strayTemps(dir), []);
});

test("a successful acquire replaces the lease file atomically rather than rewriting it in place", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", 2, A);
  const before = leaseInode(dir, 1);
  assert.equal(acquireSlot(dir, 2, "A", 1, A), true);
  assert.notEqual(leaseInode(dir, 1), before);
  assert.deepEqual(readLeases(dir), [{ project: "A", weight: 1, held: 1, want: 2, pid: 1, kind: "campaign" }]);
  assert.deepEqual(strayTemps(dir), []);
});

test("releasing a slot replaces the lease file atomically rather than rewriting it in place", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", 2, A);
  assert.equal(acquireSlot(dir, 2, "A", 1, A), true);
  const before = leaseInode(dir, 1);
  releaseSlot(dir, A);
  assert.notEqual(leaseInode(dir, 1), before);
  assert.deepEqual(readLeases(dir), [{ project: "A", weight: 1, held: 0, want: 2, pid: 1, kind: "campaign" }]);
  assert.deepEqual(strayTemps(dir), []);
});

test("a temp file stranded by a crashed lease write is not read as a lease", () => {
  const dir = freshDir();
  const A = { pid: 1, isAlive: alive };
  registerProject(dir, "A", 1, "campaign", 2, A);
  writeFileSync(
    join(slotsDir(dir), "2.json.99.tmp"),
    JSON.stringify({ project: "B", weight: 1, held: 0, want: 1, pid: 2, kind: "campaign" }),
  );
  assert.deepEqual(
    readLeases(dir).map((l) => l.pid),
    [1],
  );
});

test("a second live campaign for one project is refused at lease time and writes nothing — the authoritative single-campaign guard", () => {
  const dir = freshDir();
  registerProject(dir, "P", 1, "campaign", 0, { pid: 1, isAlive: alive });

  assert.throws(
    () => registerProject(dir, "P", 1, "campaign", 0, { pid: 2, isAlive: alive }),
    (e: unknown) =>
      e instanceof LiveCampaignRefusal && e instanceof Refusal && e.message === "a campaign is already running for P — campaign refused.",
  );
  assert.deepEqual(
    readLeases(dir).map((l) => l.pid),
    [1],
  );
});

test("the campaign lease guard refuses only a different live campaign for the same project", () => {
  const dir = freshDir();
  const dead = new Set<number>();
  const isAlive = (pid: number) => !dead.has(pid);

  // The holder's own per-wave demand refresh re-registers its lease and updates `want`.
  registerProject(dir, "P", 1, "campaign", 0, { pid: 1, isAlive });
  registerProject(dir, "P", 1, "campaign", 3, { pid: 1, isAlive });
  assert.equal(readLeases(dir).find((l) => l.pid === 1)!.want, 3);

  // A live campaign for another project, and any `run` registration, are not blocked.
  registerProject(dir, "Q", 1, "campaign", 0, { pid: 2, isAlive });
  registerProject(dir, "P", 1, "run", 1, { pid: 3, isAlive });

  // The holder dies: its lingering lease does not block a new campaign for P.
  dead.add(1);
  registerProject(dir, "P", 1, "campaign", 0, { pid: 4, isAlive });
  assert.equal(liveCampaignPid(dir, "P", { isAlive }), 4);
});

test("a live standalone run's lease does not block a campaign registration for its project", () => {
  const dir = freshDir();
  registerProject(dir, "P", 1, "run", 1, { pid: 1, isAlive: alive });
  registerProject(dir, "P", 1, "campaign", 0, { pid: 2, isAlive: alive });
  assert.equal(liveCampaignPid(dir, "P", { isAlive: alive }), 2);
});
