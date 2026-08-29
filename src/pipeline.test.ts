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
import { DONE, defaultLoopDeps, runLoop, type LoopDeps } from "./loop.ts";
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
