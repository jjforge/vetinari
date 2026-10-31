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

/**
 * Run `fn` with `over` applied to `process.env` (`undefined` deletes the key), then restore every
 * named key exactly as it was — even if `fn` throws or its promise rejects. A sync `fn` stays sync:
 * its value comes back directly with the env already restored; a thenable restores on settle.
 */
export function withEnv<T>(over: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(over);
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const apply = (vals: Record<string, string | undefined>) => {
    for (const k of keys) {
      if (vals[k] === undefined) delete process.env[k];
      else process.env[k] = vals[k];
    }
  };
  apply(over);
  let result: T;
  try {
    result = fn();
  } catch (e) {
    apply(prev);
    throw e;
  }
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    return Promise.resolve(result).finally(() => apply(prev)) as T;
  }
  apply(prev);
  return result;
}
