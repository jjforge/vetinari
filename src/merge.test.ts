import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { collectWaveChangelog, integrateGreens } from "./merge.ts";
import { setLogFile } from "./log.ts";
import { readEventLog } from "./event-log.ts";

/** A fresh git repo with a CHANGELOG.md committed, standing in for a campaign base. */
function repoWithChangelog(changelog: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-merge-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  return dir;
}

const headSubject = (dir: string) => execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
const headSha = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("collectWaveChangelog folds the wave's fragments into CHANGELOG.md and commits once", () => {
  const dir = repoWithChangelog("# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  writeFileSync(join(fragDir, "7.md"), "section: Bug fixes\n- [user] fix from 7 (#7).\n");
  // Post-merge state: the fragments arrived committed on merged branches.
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "merge agent branches"]);

  const result = collectWaveChangelog(1, dir);

  assert.equal(result.committed, true);
  assert.deepEqual(result.collected.sort(), ["42.md", "7.md"]);
  // A single collect commit, named by wave (1-based).
  assert.equal(headSubject(dir), "campaign: collect changelog (wave 2)");
  const written = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(written.includes("- [user] feature from 42 (#42)."));
  assert.ok(written.includes("- [user] fix from 7 (#7)."));
  assert.ok(written.includes("### Older — August 1, 2026"));
  // The consumed fragments are gone from the tree and the deletion is committed.
  assert.equal(existsSync(join(fragDir, "42.md")), false);
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
});

/**
 * A fresh repo on `main` whose seed touches `f.txt`, standing in for a campaign base.
 * Two agent branches both edit `f.txt` off the seed, so the second to merge conflicts.
 */
function repoWithConflictingGreens(): { dir: string; git: (args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-integ-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "f.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  // green A: edits f.txt off the seed — merges clean, it is the first green.
  git(["checkout", "-q", "-b", "agent/A"]);
  writeFileSync(join(dir, "f.txt"), "A\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "A"]);
  // green B: edits the same line off the seed — conflicts once A is on the base.
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "agent/B"]);
  writeFileSync(join(dir, "f.txt"), "B\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "B"]);
  git(["checkout", "-q", "main"]);
  return { dir, git };
}

test("integrateGreens quarantines a conflicting green, keeps the earlier green merged, and continues", async () => {
  const { dir, git } = repoWithConflictingGreens();
  const cfg = { branchPrefix: "agent/", baseBranch: "main" } as ResolvedConfig;
  const prevCwd = process.cwd();
  process.chdir(dir);
  setLogFile(join(dir, "orchestrator.jsonl"));
  try {
    const result = await integrateGreens(cfg, ["A", "B"], {
      gate: async () => ({ green: true, report: "" }),
    });

    // A stayed merged; only B was held — the wave neither rolled back nor halted.
    assert.deepEqual(result.merged, ["A"]);
    assert.deepEqual(result.quarantined, ["B"]);
    assert.equal(result.halt, undefined);
    // No `reset --hard` to the wave start: A's change is on the base (not "base").
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "A\n");
    // B's branch is preserved (resumable); A's merged branch is reclaimed.
    assert.equal(git(["branch", "--list", "agent/B"]).length > 0, true);
    assert.equal(git(["branch", "--list", "agent/A"]), "");
  } finally {
    process.chdir(prevCwd);
  }

  // The conflict was recorded as a `quarantined` event naming B and its branch.
  const q = readEventLog({ logFile: join(dir, "orchestrator.jsonl") }).filter((e) => e.event === "quarantined");
  assert.equal(q.length, 1);
  assert.deepEqual({ taskId: (q[0] as any).taskId, branch: (q[0] as any).branch }, { taskId: "B", branch: "agent/B" });
});

test("integrateGreens skips the merged-base gate when every green conflicts", async () => {
  const { dir } = repoWithConflictingGreens();
  const cfg = { branchPrefix: "agent/", baseBranch: "main" } as ResolvedConfig;
  const prevCwd = process.cwd();
  process.chdir(dir);
  setLogFile(join(dir, "orchestrator.jsonl"));
  let gateRan = false;
  try {
    // Put B's conflicting change on the base first so A also conflicts.
    execFileSync("git", ["-C", dir, "merge", "--no-ff", "agent/B", "-m", "pre"], { encoding: "utf8" });
    const result = await integrateGreens(cfg, ["A"], {
      gate: async () => {
        gateRan = true;
        return { green: true, report: "" };
      },
    });
    assert.deepEqual(result.merged, []);
    assert.deepEqual(result.quarantined, ["A"]);
    assert.equal(result.halt, undefined);
    assert.equal(gateRan, false); // nothing merged → nothing to gate
  } finally {
    process.chdir(prevCwd);
  }
});

test("collectWaveChangelog makes no commit when the wave left no fragments", () => {
  const dir = repoWithChangelog("# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const before = headSha(dir);

  const result = collectWaveChangelog(0, dir);

  assert.equal(result.committed, false);
  assert.deepEqual(result.collected, []);
  assert.equal(headSha(dir), before); // HEAD untouched — nothing to collect
});
