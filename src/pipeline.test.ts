import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { listParked } from "./state.ts";
import { readFileSync } from "node:fs";
import { DONE, defaultLoopDeps, runLoop, type LoopDeps } from "./loop.ts";
import { campaign, type CampaignDeps, type RunSpawner } from "./modes.ts";
import { collectWaveChangelog, currentBranch, integrateGreens } from "./merge.ts";
import { runGates } from "./gate.ts";
import { listOutbox } from "./state.ts";
import type { HostBudget } from "./host-slots.ts";
import { makeLocalSandbox, type LocalAgentScript } from "./sandbox-local.ts";

// ── The local-sandbox integration harness (ADR 0018) ─────────────────────────
//
// A real temp-dir git repo on `base`, with real gates that run for real inside a
// worktree via the local sandbox's `exec`. Only the container boundary is faked:
// the per-issue loop's `makeSandbox` (→ `makeLocalSandbox`). Everything downstream
// of the agent turn — the gate, its exit code, the on-disk event log/parked dir,
// the `commitsAhead`/`filesInCommit` git reads — runs against real state.

/** A fresh repo on `base` whose seed commits `README.md` + a `CHANGELOG.md`. */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-pipeline-"));
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

// A cfg over a real temp-dir repo: a real on-disk event log/parked dir/outbox under
// its stateDir driven by a real logger, real gates, resumable (claude) agent. Only
// the sandbox factory is injected per-test.
const repoCfg = (dir: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = join(dir, ".vetinari.local");
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return {
    project: "pipeline",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    maxTurns: 4,
    idleTimeoutSeconds: 600,
    gates: [{ cmd: "test -f marker.txt" }],
    agent: { provider: "claude" },
    promptFile: "/prompts/tdd.md",
    log: loggerForRun({ logFile }),
    fetchTask: async () => "task text",
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

test("a green agent turn commits on its branch and the real gate runs via the local sandbox's exec → runLoop green", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir);

  // The agent-script operates on the real checkout: writes the file the gate checks
  // for, makes a real commit on agent/T1, and returns DONE.
  const greenScript: LocalAgentScript = (turn) => {
    turn.write("marker.txt", "ok\n");
    turn.commit("add marker");
    return { signal: DONE, stdout: "<turn-summary>added the marker</turn-summary>" };
  };

  const outcome = await inRepo(dir, () => runLoop(cfg, "T1", undefined, loopDepsFor(greenScript)));

  assert.equal(outcome, "green");
  assert.equal(listParked(cfg).length, 0);

  // The commit is real: agent/T1 carries the marker the script committed.
  assert.equal(gitOut(dir, ["show", "agent/T1:marker.txt"]), "ok");

  // The green event names the branch and the real commit sha.
  const events = readEventLog(cfg);
  const green = events.find((e) => e.event === "green") as { branch: string; commits: string[] } | undefined;
  assert.ok(green, "expected a green event");
  assert.equal(green!.branch, "agent/T1");
  assert.equal(green!.commits.length, 1);

  // The gate ran for real via exec — a zero-exit gate-result is on the log.
  const gateResult = events.find((e) => e.event === "gate-result") as { exitCode: number } | undefined;
  assert.ok(gateResult, "expected a gate-result event");
  assert.equal(gateResult!.exitCode, 0);
});

test("a deliberately red gate yields a real non-zero exit via exec and parks — the gate genuinely runs, no stub reads it green", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir, { maxTurns: 2 });

  // The agent commits real work each turn but never writes the file the gate checks
  // for, so `test -f marker.txt` exits non-zero for real, turn after turn.
  let n = 0;
  const redScript: LocalAgentScript = (turn) => {
    n++;
    turn.write(`attempt-${n}.txt`, "still working\n");
    turn.commit(`attempt ${n}`);
    return { signal: DONE, stdout: "<turn-summary>tried again</turn-summary>" };
  };

  const outcome = await inRepo(dir, () => runLoop(cfg, "T2", undefined, loopDepsFor(redScript)));

  // A red gate parks (budget) — never a green over a red suite.
  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "budget");

  const events = readEventLog(cfg);
  assert.equal(events.some((e) => e.event === "green"), false);
  // The gate ran for real and its non-zero exit was seen — not a stubbed green read.
  const reds = events.filter((e) => e.event === "gate-result") as { exitCode: number }[];
  assert.ok(reds.length > 0, "expected gate-result events");
  assert.ok(reds.every((r) => r.exitCode !== 0), "every gate run went red for real");
});

// Each issue's agent-script writes a disjoint impl file + its own changelog fragment
// and commits on agent/<id> — file-disjoint, so both greens merge clean.
const implScript = (id: string): LocalAgentScript => (turn) => {
  turn.write(`impl-${id}.txt`, `impl for ${id}\n`);
  turn.write(`changelog.d/${id}.md`, `section: New features\n- [user] feature from ${id} (#${id}).\n`);
  turn.commit(`implement ${id}`);
  return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
};

/**
 * The container boundary, faked in the two sanctioned ways and NOTHING else (ADR 0018):
 *   1. spawnRun → an in-process runLoop over the local sandbox (a child `run` would spawn
 *      a container); it keeps the real commitsAhead/filesInCommit.
 *   2. the merged-base gate's sandbox → the local sandbox (prod's gateMergedBase spins a
 *      container here); it still runs the REAL runGates(all:true) against the merged base.
 * integrateGreens, collectWaveChangelog and currentBranch are the production effects,
 * unswapped.
 */
const localCampaignDeps = (cfg: ResolvedConfig, dir: string): CampaignDeps => {
  const spawnRun: RunSpawner = async (taskId) => {
    const outcome = await runLoop(cfg, taskId, undefined, loopDepsFor(implScript(taskId)));
    return outcome === "green" ? 0 : outcome === "parked" ? 2 : 1;
  };
  // The merged-base gate: real runGates over the merged base through the local sandbox
  // (only the container is faked). Cleans up its throwaway branch/worktree like prod's
  // gateMergedBase does.
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
  };
};

test("a campaign wave of two issues spans agent → gate → merge → advance through the local sandbox", async () => {
  const dir = seedRepo();
  // README.md exists on the base and every branch, so the gate is green for each green
  // alone and on the merged base — the red-gate path is pinned separately above.
  const cfg = repoCfg(dir, { gates: [{ cmd: "test -f README.md" }] });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () => campaign(cfg, [["101", "102"]], host, "span", {}, localCampaignDeps(cfg, dir)));

  assert.equal(ok, true);

  const events = readEventLog(cfg);

  // AC1: both issues ran on real agent/<id> branches carrying real commits, each gated green.
  const greens = events.filter((e) => e.event === "green") as { branch: string; commits: string[] }[];
  assert.deepEqual(greens.map((g) => g.branch).sort(), ["agent/101", "agent/102"]);
  assert.ok(greens.every((g) => g.commits.length === 1), "each green carries its real commit");

  // AC2: both greens merged through the real integrateGreens; the real merged-base gate ran…
  const merged = events.find((e: any) => e.event === "campaign-integrated") as { merged: string[] } | undefined;
  assert.ok(merged, "expected a campaign-integrated event from integrateGreens");
  assert.deepEqual(merged!.merged.sort(), ["101", "102"]);
  // …the merged-base gate is the gate-result with no taskId (all:true, no single issue).
  const baseGate = events.filter((e) => e.event === "gate-result" && !(e as any).taskId) as { exitCode: number }[];
  assert.ok(baseGate.length > 0, "expected a merged-base gate-result");
  assert.ok(baseGate.every((r) => r.exitCode === 0), "the merged base gated green");
  // …and the wave advanced to done.
  assert.ok(events.some((e) => e.event === "campaign-done"), "the wave advanced to campaign-done");

  // The merges are real: both impl files are on the base, the agent branches are GC'd.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "");

  // AC3: collectWaveChangelog ran for real — both wave fragments folded into CHANGELOG.md.
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes("- [user] feature from 101 (#101)."), "101's fragment folded");
  assert.ok(changelog.includes("- [user] feature from 102 (#102)."), "102's fragment folded");

  // The operator feed reports the merged wave and the completed campaign.
  const outbox = listOutbox(cfg);
  assert.ok(outbox.find((m) => m.event === "wave-merged"), "wave-merged went out");
  assert.ok(outbox.find((m) => m.event === "campaign-complete"), "campaign-complete went out");
});
