import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { answerParked, listParked } from "./state.ts";
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
      const outcome = await runLoop(cfg, taskId, undefined, undefined, loopDepsFor(scriptFor(taskId)));
      // Mirror the real child `run`'s exit code (cli-dispatch's `exitCodeFor`): 0 green, 2
      // parked, 1 failed — the loop now returns `failed` for a thrown turn rather than
      // rethrowing (design §3 step 9), so the child exits 1 without spawnRun's catch.
      return outcome === "green" ? 0 : outcome === "failed" ? 1 : 2;
    } catch {
      return 1; // a still-thrown turn → the child `run` would exit non-zero → a failed member
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
    // Forward `index` and `opts` (the redrive re-gate flag) so integration behaves exactly as it
    // does in production; only the gate's sandbox is swapped for the local one.
    integrate: (c, greens, _deps, index, opts) => integrateGreens(c, greens, { gate: mergedBaseGate }, index, opts),
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

// An issue that parks with a question until the human's answer reaches it, then implements
// green. The answer arrives one of two ways, both of which this recognises: a resumable provider
// resumes the parked session with an answer prompt (`turn.opts.prompt`), and a non-resumable one
// re-reads the issue body the answer was appended to (`ANSWER:` in the TASK — design §3 step 9).
const answerGatedScript = (id: string): LocalAgentScript => (turn) => {
  const task = (turn.opts.promptArgs?.TASK as string) ?? "";
  const resumePrompt = (turn.opts.prompt as string) ?? "";
  const answered = task.includes("ANSWER:") || resumePrompt.includes("Answer from the human");
  if (!answered)
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

test("scenario 5: a merge conflict with no dependents holds the wave — the campaign parks; a branch-side resolve then a redrive lands it (design §5 step 5, §7)", async () => {
  const dir = seedConflictRepo();
  const tracker = fakeTracker(); // no blockers → the conflict strands nothing
  const cfg = repoCfg(dir, tracker);

  await inRepo(dir, async () => {
    // 101 merges first; 102 conflicts at merge → quarantined. A conflict-parked green is
    // unresolved work awaiting a human, so — even with nothing stranded — it holds the wave and
    // the campaign parks (it no longer slips through to done, #310).
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "conflict", {}, localCampaignDeps(cfg, dir, conflictScript));
    assert.equal(parkedOk, "parked", "a conflict park holds the wave");

    const events = readEventLog(cfg);
    // 101 merged and stays; 102 is the attributed loser — quarantined, its branch preserved.
    assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
    const q = events.find((e: any) => e.event === "parked" && e.reason === "conflict");
    assert.equal((q as any)?.taskId, "102");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the conflicted member's work is preserved");
    // The wave never closed and the campaign did not finish — the stop marker carries reason conflict.
    assert.equal(events.some((e) => e.event === "wave-done"), false, "the held wave is not closed");
    assert.equal(events.some((e) => e.event === "campaign-done"), false);
    const parked = events.filter((e) => e.event === "campaign-parked") as any[];
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, "conflict", "the wave's reason is conflict");
  });

  // The human resolves the conflict on the branch: merge the base into agent/102 and settle
  // conflict.txt, so agent/102 now merges onto the base clean.
  const wt = mkdtempSync(join(tmpdir(), "vetinari-resolve-"));
  execFileSync("git", ["-C", dir, "worktree", "add", "--force", wt, "agent/102"], { stdio: "ignore" });
  try {
    execFileSync("git", ["-C", wt, "merge", "base"], { stdio: "ignore" }); // conflicts — exits non-zero, resolved next
  } catch {
    // expected: the merge stops on the conflict.txt conflict, which we resolve by hand below.
  }
  writeFileSync(join(wt, "conflict.txt"), "resolved by 101 and 102\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-qm", "resolve conflict.txt on agent/102"]);
  execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt], { stdio: "ignore" });

  await inRepo(dir, async () => {
    // Redrive re-enters the held wave and INTEGRATES the now-mergeable 102 without re-running it;
    // 101 is already banked. The wave closes and the campaign finishes.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, conflictScript, spawns));
    assert.equal(doneOk, "done", "the redrive landed the resolved conflict and finished");
    assert.deepEqual(spawns, [], "no member of the reconciled wave was re-run");

    // 102's resolved work is on the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101 and 102");
    const events = readEventLog(cfg);
    assert.ok(events.some((e) => e.event === "merged" && (e as any).taskId === "102"), "102 was merged on the redrive");
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});

// Two branches each green alone but red together (both present) — an emergent red base. The
// merged-base gate passes when at most one of a.txt/b.txt is present.
const abScript = (id: string): LocalAgentScript => (turn) => {
  const file = id === "101" ? "a.txt" : "b.txt";
  turn.write(file, `${id}\n`);
  turn.commit(`add ${file} in ${id}`);
  return { signal: DONE, stdout: `<turn-summary>added ${file}</turn-summary>` };
};

test("scenario 6: a red base parks the wave; a fix-forward then a redrive RE-GATES the base even though nothing new merges (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  // Green alone (only one of a.txt/b.txt present on each branch), red on the merged base (both).
  const cfg = repoCfg(dir, tracker, { gates: [{ cmd: "[ ! -f a.txt ] || [ ! -f b.txt ]" }] });

  await inRepo(dir, async () => {
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "red-base", {}, localCampaignDeps(cfg, dir, abScript));
    assert.equal(parkedOk, "parked", "the emergent red base parks the wave");
    const events = readEventLog(cfg);
    const parked = events.filter((e) => e.event === "campaign-parked") as any[];
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, "red-base", "the wave's reason is red-base");
    // Both greens are merged on the base (never rolled back), the base sitting red.
    assert.equal(gitOut(dir, ["show", "base:a.txt"]), "101");
    assert.equal(gitOut(dir, ["show", "base:b.txt"]), "102");
    assert.equal(events.some((e) => e.event === "wave-done"), false);
  });

  // Fix forward on the base: drop b.txt so the base gate goes green again.
  execFileSync("git", ["-C", dir, "rm", "-q", "b.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "fix forward: drop b.txt"]);

  await inRepo(dir, async () => {
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, abScript, spawns));
    assert.equal(doneOk, "done", "the redrive re-gated the fixed base green and finished");
    assert.deepEqual(spawns, [], "nothing was re-run — the fix lived on the base, not a member branch");

    const events = readEventLog(cfg);
    // The base was re-gated on re-entry even though nothing new merged (design §7): the
    // merged-base gate (a gate-result with no taskId) ran after the redrive and passed, the wave
    // closed, and the campaign completed. `landed` on the redrive event is 0 — nothing freshly
    // merged — yet the gate still ran.
    const redrive = events.find((e) => e.event === "redrive") as any;
    assert.ok(redrive, "a redrive event was logged");
    assert.equal(redrive.landed, 0, "nothing freshly merged on the re-entry");
    // The re-entry runs a second wave-start; the merged-base gate (gate-result, no taskId) fires
    // during that wave's integration even though nothing new merged.
    const secondWaveStart = events.map((e) => e.event).lastIndexOf("wave-start");
    const gatesAfterRedrive = events
      .slice(secondWaveStart)
      .filter((e) => e.event === "gate-result" && !(e as any).taskId) as any[];
    assert.ok(gatesAfterRedrive.length > 0, "the merged base was re-gated after the redrive");
    assert.ok(gatesAfterRedrive.every((g) => g.exitCode === 0), "the re-gated base passed");
    assert.ok(events.some((e) => e.event === "wave-done"), "the re-gated wave closed");
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});

test("scenario 4: a redrive integrates a green-but-unmerged member — landed without re-running it (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges; 102 parks → the wave parks and exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "redrive", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(parkedOk, "parked");

    // The answer produces a GREEN 102 that is not yet integrated: a standalone run (what
    // `answer` does) re-enters agent/102, greens, logs `green`, and clears the record — but
    // does NOT merge. So the redrive re-enters a wave with a green-but-unmerged member.
    tracker.answer("102", "use approach B");
    const answered = await runLoop(cfg, "102", undefined, undefined, loopDepsFor(scriptFor("102")));
    assert.equal(answered, "green", "the answered member ran to green");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "102 is green but its branch is unmerged");

    // Redrive with a recording spawner: 102 is already green, so it is INTEGRATED without
    // being re-run. 101 is already banked and is likewise not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, "done", "the redrive landed the banked greens and finished");
    assert.deepEqual(spawns, [], "no member of the reconciled wave was re-run");

    // 102's green work is now merged onto the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    const integrated = events.filter((e: any) => e.event === "campaign-integrated");
    assert.ok(integrated.some((e: any) => e.merged.includes("102")), "102 was integrated on the redrive");
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});

test("scenario 2b: an answer delivered mid-wave (the grace window) re-admits the member into the SAME wave with the answer, and the campaign finishes without a redrive (design §5 step 3)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker, { parkGraceSeconds: 30 });
  // 101 implements green; 102 parks until answered.
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    const deps: CampaignDeps = {
      ...localCampaignDeps(cfg, dir, scriptFor),
      // The human's answer lands inside the grace window: DELIVERED into 102's parked record.
      // The live campaign re-admits it into this same wave — the re-run resumes the session with
      // the answer, greens, and merges alongside 101, so the wave never parks.
      grace: async (c, ids) => {
        for (const id of ids) answerParked(c, id, "use approach A");
      },
    };
    const ok = await campaign(cfg, [["101", "102"]], host(dir), "rejoin-in-wave", {}, deps);
    assert.equal(ok, "done", "the in-window answer let the member rejoin and the wave finish");

    // Both greens are on the base — 102 merged in the same wave it parked in, no separate redrive.
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    assert.ok(events.some((e) => e.event === "grace-wait"), "the wave held open for the answer");
    assert.ok(events.some((e) => e.event === "wave-done"), "the wave closed with both members merged");
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign finished");
    assert.equal(events.some((e) => e.event === "campaign-parked"), false, "the answered member never parked the wave");
    assert.equal(listParked(cfg).some((r) => r.taskId === "102"), false, "the answered record was consumed by the re-run");
  });
});

test("scenario 1: two all-green waves merge in order, the base is gated between them, and the campaign finishes done", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);

  const ok = await inRepo(dir, () => campaign(cfg, [["101"], ["102"]], host(dir), "two-waves", {}, localCampaignDeps(cfg, dir, implScript)));
  assert.equal(ok, "done", "both waves ran green and the campaign completed");

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
  assert.equal(ok, "failed", "a failed member stops the campaign non-zero");

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
    assert.equal(parkedOk, "parked", "the parked wave stops the campaign");

    // The sibling merged (drain, don't abort): 101's impl is on the base, its branch GC'd.
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
    // 102's parked record survives so it stays answerable, and its branch (created when it
    // parked) is preserved — the re-run must re-enter it, not fail trying to recreate it.
    assert.ok(listParked(cfg).some((r) => r.taskId === "102"), "102 stayed parked and answerable");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the parked member's branch is preserved");
  });

  // The human answers 102: the answer is DELIVERED into the parked record (design §5 step 3),
  // not run — the record and its session id are kept so the redrive can resume it.
  answerParked(cfg, "102", "use approach A");

  await inRepo(dir, async () => {
    // Redrive: 102's answered record re-runs — re-entering its existing agent/102 branch,
    // resuming the session with the answer — greens, merges, and clears the record; 101
    // (already banked) is not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, "done", "the answered member rejoined and the campaign finished");
    assert.deepEqual(spawns, ["102"], "only the answered member re-ran; the banked sibling did not");
    assert.equal(listParked(cfg).some((r) => r.taskId === "102"), false, "the answered record was consumed by the re-run");

    // 102's work is now on the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    assert.ok(events.some((e) => e.event === "campaign-done"), "the campaign advanced to done");
  });
});
