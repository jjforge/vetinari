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
// `quarantined`→`parked{conflict}`, the `campaign-*` stop markers) is a future
// consolidation; the events asserted here are the ones the code emits TODAY.

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

// An issue that parks with a question until its issue body carries an ANSWER, then
// implements green — the non-resumable park→answer path (answer delivered by re-read).
const answerGatedScript = (id: string): LocalAgentScript => (turn) => {
  const task = (turn.opts.promptArgs?.TASK as string) ?? "";
  if (!task.includes("ANSWER:"))
    return { signal: BLOCKED, stdout: `<question><summary>which approach for ${id}?</summary></question>` };
  return implScript(id)(turn);
};

const host = (dir: string): HostBudget => ({ configDir: join(dir, "host"), ceiling: 2, weight: 1 });

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
