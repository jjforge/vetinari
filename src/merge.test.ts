import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWaveChangelog } from "./merge.ts";

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

test("collectWaveChangelog makes no commit when the wave left no fragments", () => {
  const dir = repoWithChangelog("# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const before = headSha(dir);

  const result = collectWaveChangelog(0, dir);

  assert.equal(result.committed, false);
  assert.deepEqual(result.collected, []);
  assert.equal(headSha(dir), before); // HEAD untouched — nothing to collect
});
