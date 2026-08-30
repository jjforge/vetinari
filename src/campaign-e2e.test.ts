import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { clearParked, listParked } from "./state.ts";
import { BLOCKED, DONE, defaultLoopDeps, runLoop, type LoopDeps } from "./loop.ts";
import { campaign, type CampaignDeps, type RunSpawner } from "./modes.ts";
import { collectWaveChangelog, currentBranch, integrateGreens } from "./merge.ts";
import { runGates } from "./gate.ts";
import type { HostBudget } from "./host-slots.ts";
import { makeLocalSandbox, type LocalAgentScript } from "./sandbox-local.ts";

// ── End-to-end campaign through the local sandbox (design §3–§7, §13.4) ────────
//
// A real multi-wave campaign against a REAL temp-dir repo with a fake in-memory
// tracker and a scripted agent, driven through the local sandbox (ADR 0018) so no
// container or provider key is needed. Only the container boundary is faked in the
// two sanctioned ways (below); integrateGreens, the merged-base gate command, the
// real git merges/conflicts, collectWaveChangelog, currentBranch, the on-disk event
// log/parked dir and the commitsAhead/filesInCommit reads all run for real.
//
// This pins the §15 divergences §13.4 calls the core's open hole: an answered
// question rejoins its campaign, a failed issue holds its wave, and a redrive lands
// a green-but-unmerged member without re-running it.
//
// Note on vocabulary: the design's §13.2 rename (`campaign-batch`→`wave-start`,
// `quarantined`→`parked{conflict}`, the `campaign-*` stop markers) has landed;
// the events asserted here are that current §2.1 vocabulary.

/** A fresh repo on `base` seeding README.md + a CHANGELOG.md the folder folds into. */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-e2e-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=base", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  return dir;
}

/** Strip a leading `#` so a tracker id matches an `agent/<id>` branch suffix. */
const norm = (id: string) => id.replace(/^#/, "");

/**
 * An in-memory tracker (the acceptance's fake `fetchTask`/`blockedBy`/`listByLabel`):
 * a mutable id→body map so an "answer" is delivered the way the non-resumable path
 * delivers it — appended to the issue body a fresh run re-reads (design §3 step 9).
 */
interface FakeTracker {
  fetchTask: (id: string) => string;
  blockedBy: (id: string) => string[];
  listByLabel: (label: string) => string[];
  /** Append an answer to an issue body — what a human's `answer` posts as a comment. */
  answer: (id: string, text: string) => void;
}
const fakeTracker = (blocks: Record<string, string[]> = {}): FakeTracker => {
  const bodies = new Map<string, string>();
  const body = (id: string) => bodies.get(norm(id)) ?? `task ${norm(id)}`;
  return {
    fetchTask: (id) => body(id),
    blockedBy: (id) => blocks[norm(id)] ?? [],
    listByLabel: () => [...bodies.keys()],
    answer: (id, text) => bodies.set(norm(id), `${body(id)}\nANSWER: ${text}`),
  };
};

// A cfg over a real temp-dir repo: real on-disk log/parked dir/outbox, real gates,
// resumable (claude) agent. The sandbox factory is the only per-test injection.
const repoCfg = (dir: string, tracker: FakeTracker, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = join(dir, ".vetinari.local");
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return {
    project: "e2e",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    maxTurns: 4,
    idleTimeoutSeconds: 600,
    gates: [{ cmd: "test -f README.md" }],
    agent: { provider: "claude" },
    promptFile: "/prompts/tdd.md",
    log: loggerForRun({ logFile }),
    fetchTask: async (id: string) => tracker.fetchTask(id),
    blockedBy: (id: string) => tracker.blockedBy(id),
    listByLabel: (label: string) => tracker.listByLabel(label),
    ...overrides,
  } as unknown as ResolvedConfig;
};

// runLoop over a given agent-script, keeping the REAL commitsAhead/filesInCommit —
// only the container boundary (the sandbox factory) is faked.
const loopDepsFor = (script: LocalAgentScript): LoopDeps => ({
  ...defaultLoopDeps,
  makeSandbox: (cfg, taskId) => makeLocalSandbox(cfg, taskId, script),
});

// runLoop/campaign echo banners; silence the console so a test reads its result off
// disk, and run inside the temp repo so the host-repo git reads resolve there.
const inRepo = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const prevCwd = process.cwd();
  const realLog = console.log;
  const realErr = console.error;
  process.chdir(dir);
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    console.log = realLog;
    console.error = realErr;
  }
};

const gitOut = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/**
 * The container boundary, faked in the two sanctioned ways and NOTHING else (ADR 0018):
 *   1. spawnRun → an in-process runLoop over the local sandbox (a child `run` would spawn
 *      a container). A thrown/unrecoverable turn surfaces as exit 1 — a `failed` member —
 *      exactly as a crashed child `run` process would (design §3 step 9 / §5).
 *   2. the merged-base gate's sandbox → the local sandbox (prod's gateMergedBase spins a
 *      container here); it still runs the REAL runGates(all:true) against the merged base.
 * integrateGreens, collectWaveChangelog and currentBranch are the production effects.
 * `spawns` records every id spawnRun drives, so a redrive can prove it re-ran nothing.
 */
const localCampaignDeps = (
  cfg: ResolvedConfig,
  dir: string,
  scriptFor: (id: string) => LocalAgentScript,
  spawns: string[] = [],
): CampaignDeps => {
  const spawnRun: RunSpawner = async (taskId) => {
    spawns.push(taskId);
    try {
      const outcome = await runLoop(cfg, taskId, undefined, loopDepsFor(scriptFor(taskId)));
      return outcome === "green" ? 0 : 2;
    } catch {
      return 1; // an unrecoverable turn → the child `run` would exit non-zero → a failed member
    }
  };
  const mergedBaseGate = async (c: ResolvedConfig) => {
    const sbx = await makeLocalSandbox(c, "campaign-integrate", () => ({ signal: DONE }));
    try {
      return await runGates(c, sbx, { all: true });
    } finally {
      await sbx.close();
      execFileSync("git", ["-C", dir, "branch", "-D", `${c.branchPrefix}campaign-integrate`], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "worktree", "prune"], { stdio: "ignore" });
    }
  };
  return {
    spawnRun,
    integrate: (c, greens) => integrateGreens(c, greens, { gate: mergedBaseGate }),
    collectChangelog: collectWaveChangelog,
    currentBranch,
    grace: async () => {},
  };
};

// An issue's agent writes a disjoint impl file and commits on agent/<id> — file-disjoint,
// so co-wave greens merge clean.
const implScript = (id: string): LocalAgentScript => (turn) => {
  turn.write(`impl-${id}.txt`, `impl for ${id}\n`);
  turn.commit(`implement ${id}`);
  return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
};

// An issue whose turn hits an unrecoverable error — a crashed run. Its child `run` would
// exit non-zero; here the thrown turn surfaces as exit 1 through spawnRun (design §3 step 9).
const failingScript = (): LocalAgentScript => () => {
  throw new Error("unrecoverable agent turn");
};

// An issue that parks with a question until its issue body carries an ANSWER, then
// implements green — the non-resumable park→answer path (answer delivered by re-read).
const answerGatedScript = (id: string): LocalAgentScript => (turn) => {
  const task = (turn.opts.promptArgs?.TASK as string) ?? "";
  if (!task.includes("ANSWER:"))
    return { signal: BLOCKED, stdout: `<question><summary>which approach for ${id}?</summary></question>` };
  return implScript(id)(turn);
};

// Seed `conflict.txt` so two branches that both rewrite it collide at merge.
function seedConflictRepo(): string {
  const dir = seedRepo();
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed conflict.txt"]);
  return dir;
}

// Each issue rewrites the shared file to its own content — file-conflicting, so the loser
// cannot merge onto a base already carrying the winner.
const conflictScript = (id: string): LocalAgentScript => (turn) => {
  turn.write("conflict.txt", `resolved by ${id}\n`);
  turn.commit(`rewrite conflict.txt in ${id}`);
  return { signal: DONE, stdout: `<turn-summary>rewrote conflict.txt in ${id}</turn-summary>` };
};

const host = (dir: string): HostBudget => ({ configDir: join(dir, "host"), ceiling: 2, weight: 1 });

test("scenario 5: a merge conflict quarantines that member (its work preserved) while the rest of the wave merges (ADR 0013)", async () => {
  const dir = seedConflictRepo();
  const tracker = fakeTracker(); // no blockers → the conflict strands nothing, so the wave still closes
  const cfg = repoCfg(dir, tracker);
  const host2 = host(dir);

  const ok = await inRepo(dir, () => campaign(cfg, [["101", "102"]], host2, "conflict", {}, localCampaignDeps(cfg, dir, conflictScript)));
  // With nothing stranded, the wave closes and the campaign finishes.
  assert.equal(ok, true, "a conflict that strands nothing runs the wave to done");

  const events = readEventLog(cfg);

  // Both went green on their own gate; the conflict is only at merge.
  const greens = events.filter((e: any) => e.event === "green").map((e: any) => e.branch).sort();
  assert.deepEqual(greens, ["agent/101", "agent/102"]);

  // 101 merged first and stays merged; 102 is the attributed loser — quarantined, its
  // branch (work) preserved and resumable.
  assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
  const q = events.find((e: any) => e.event === "parked" && e.reason === "conflict");
  assert.ok(q, "expected a parked{conflict} event for the losing member");
  assert.equal((q as any).taskId, "102");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the conflicted member's work is preserved");

  // The wave closed carrying the quarantine, and the campaign finished.
  const done = events.find((e: any) => e.event === "wave-done");
  assert.ok(done, "the wave closed");
  assert.deepEqual((done as any).merged, ["101"], "the rest of the wave merged");
  assert.deepEqual((done as any).quarantined, ["102"], "the conflicted member is recorded as quarantined");
  assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
});

test("scenario 4: a redrive integrates a green-but-unmerged member — landed without re-running it (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges; 102 parks → the wave parks and exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "redrive", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(parkedOk, false);

    // The answer produces a GREEN 102 that is not yet integrated: a standalone run (what
    // `answer` does) re-enters agent/102, greens, logs `green`, and clears the record — but
    // does NOT merge. So the redrive re-enters a wave with a green-but-unmerged member.
    tracker.answer("102", "use approach B");
    const answered = await runLoop(cfg, "102", undefined, loopDepsFor(scriptFor("102")));
    assert.equal(answered, "green", "the answered member ran to green");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "102 is green but its branch is unmerged");

    // Redrive with a recording spawner: 102 is already green, so it is INTEGRATED without
    // being re-run. 101 is already banked and is likewise not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, true, "the redrive landed the banked greens and finished");
    assert.deepEqual(spawns, [], "no member of the reconciled wave was re-run");

    // 102's green work is now merged onto the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    const integrated = events.filter((e: any) => e.event === "campaign-integrated");
    assert.ok(integrated.some((e: any) => e.merged.includes("102")), "102 was integrated on the redrive");
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});

test("scenario 1: two all-green waves merge in order, the base is gated between them, and the campaign finishes done", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);

  const ok = await inRepo(dir, () => campaign(cfg, [["101"], ["102"]], host(dir), "two-waves", {}, localCampaignDeps(cfg, dir, implScript)));
  assert.equal(ok, true, "both waves ran green and the campaign completed");

  const events = readEventLog(cfg);

  // Both waves ran, in order.
  const batches = events.filter((e: any) => e.event === "wave-start").map((e: any) => e.tasks);
  assert.deepEqual(batches, [["101"], ["102"]], "the two waves ran in order");

  // Each wave integrated its green, in order — integrateGreens logs one per wave.
  const integrated = events.filter((e: any) => e.event === "campaign-integrated").map((e: any) => e.merged);
  assert.deepEqual(integrated, [["101"], ["102"]], "each wave merged its green, in order");

  // The base is gated BETWEEN waves: the merged-base gate (a gate-result with no taskId)
  // ran for each wave's integration and passed both times.
  const baseGates = events.filter((e: any) => e.event === "gate-result" && !e.taskId);
  assert.equal(baseGates.length, 2, "the merged base was gated once per wave");
  assert.ok(baseGates.every((r: any) => r.exitCode === 0), "each merged-base gate passed");

  // The merges are real and cumulative: both impl files are on the base, wave 1 having
  // been cut from a base that already carried wave 0's work.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
  assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
});

test("scenario 3: a failed member drains its wave — the sibling merges — then holds the wave: no next wave starts and the campaign stops failed (design §5)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  // 101 implements green; 102's turn crashes (a failed member). 201 is a later wave.
  const scriptFor = (id: string) => (id === "102" ? failingScript() : implScript(id));

  const ok = await inRepo(dir, () => campaign(cfg, [["101", "102"], ["201"]], host(dir), "fail", {}, localCampaignDeps(cfg, dir, scriptFor)));
  assert.equal(ok, false, "a failed member stops the campaign non-zero");

  const events = readEventLog(cfg);

  // Only wave 0 ran — the failure held the wave and no succeeding wave started.
  const batches = events.filter((e: any) => e.event === "wave-start").map((e: any) => e.index);
  assert.deepEqual(batches, [0], "only wave 0 ran — no succeeding wave started");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/201"]), "", "the succeeding wave's issue never ran");

  // The sibling still merged — a failure never aborts or un-merges a sibling.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");

  // The campaign stopped as failed: one `campaign-failed` stop marker naming the wave and member.
  const failed = events.filter((e) => e.event === "campaign-failed") as any[];
  assert.equal(failed.length, 1, "exactly one campaign-failed stop marker");
  assert.equal(failed[0].index, 0, "the stop marker names the wave that failed");
  assert.ok(String(failed[0].detail).includes("102"), "the stop marker's detail names the failed member");
  // The failed member is carried by its own `failed` event (design §2.1).
  const failedMember = events.find((e) => e.event === "failed") as any;
  assert.ok(failedMember, "the failed member has its own failed event");
  assert.equal(failedMember.taskId, "102");
  // The sibling green stayed merged on the base — a `merged` event names it.
  const mergedMembers = events.filter((e) => e.event === "merged").map((e: any) => e.taskId);
  assert.deepEqual(mergedMembers, ["101"], "the green stayed merged on the base");
  // The wave holds, it does not close.
  assert.equal(events.some((e) => e.event === "wave-done"), false, "the failed wave is not logged done");
  assert.equal(events.some((e) => e.event === "campaign-done"), false);
});

test("scenario 2: a question park drains its wave, campaign parks and exits; an answer rejoins the member, which re-runs green and merges, and the campaign continues to done (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  // 101 implements green; 102 parks until answered.
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges under Gate 2; 102 parks → the wave parks and exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "rejoin", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(parkedOk, false, "the parked wave stops the campaign");

    // The sibling merged (drain, don't abort): 101's impl is on the base, its branch GC'd.
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
    // 102's parked record survives so it stays answerable, and its branch (created when it
    // parked) is preserved — the re-run must re-enter it, not fail trying to recreate it.
    assert.ok(listParked(cfg).some((r) => r.taskId === "102"), "102 stayed parked and answerable");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the parked member's branch is preserved");
  });

  // The human answers 102: the answer lands on the issue body and clears the parked record.
  tracker.answer("102", "use approach A");
  clearParked(cfg, "102");

  await inRepo(dir, async () => {
    // Redrive: 102 (record gone) re-runs — re-entering its existing agent/102 branch —
    // reads the answer, greens, and merges; 101 (already banked) is not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, true, "the answered member rejoined and the campaign finished");
    assert.deepEqual(spawns, ["102"], "only the answered member re-ran; the banked sibling did not");

    // 102's work is now on the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});
