// Shared home for test fixtures, built up in stages; only the git seeders live here so far.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh repo on `base` whose seed commits `README.md` + a `CHANGELOG.md`. */
export function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-test-repo-"));
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

/** Seed `conflict.txt` on the base so two branches that both rewrite it collide at merge. */
export function seedConflictRepo(): string {
  const dir = seedRepo();
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed conflict.txt"]);
  return dir;
}

/** Run `git -C dir …` and return its trimmed stdout. */
export const gitOut = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
