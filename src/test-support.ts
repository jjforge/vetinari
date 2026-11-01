// Shared home for test fixtures, built up in stages: the git seeders, the env-restoring `withEnv`,
// and the dashboard route-test fixtures.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { register } from "./registry.ts";
import type { ChildResult } from "./dashboard-child.ts";
import type { DashboardDeps } from "./dashboard-http.ts";

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

/**
 * A POST request to `url` whose body is the given form-encoded string — a readable stream so
 * `readBody` can drain it, carrying the method and pathname a route handler matches on.
 */
export const postReq = (url: string, body: string) => Object.assign(Readable.from([body]), { method: "POST", url, headers: {} });

/** A response spy capturing the status line, headers, every streamed chunk, and the body it ends with. */
export const resSpy = () => {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    chunks,
    statusCode: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: undefined as string | undefined,
    writeHead(statusCode: number, headers?: Record<string, string>) {
      res.statusCode = statusCode;
      res.headers = headers;
      return res;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      res.body = body;
      res.writableEnded = true;
    },
  };
  return res;
};

/**
 * A fresh config dir with one registered project, `beta`, rooted at `<configDir>/root` with its
 * state at `<configDir>/base` — a route only needs the pointer to reach the project (ADR 0002).
 */
export const seedProject = () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-test-route-"));
  const project = "beta";
  const projectRoot = join(configDir, "root");
  register(configDir, { project, projectRoot, baseLocation: join(configDir, "base") });
  return { configDir, project, projectRoot };
};

/**
 * Deps for a route that shells a CLI child: `runChild` returns the canned `outcome` and records
 * how it was called. `graftClosure` counts its calls, so a test can assert no dry-run was spawned.
 */
export const childDeps = (configDir: string, outcome: ChildResult) => {
  const calls: { projectRoot: string; args: string[]; timeoutMs: number }[] = [];
  let graftClosureCalls = 0;
  const deps: DashboardDeps = {
    configDir,
    prunePreview: async () => null,
    pruneClosure: async () => null,
    graftClosure: async () => (graftClosureCalls++, null),
    runChild: async (projectRoot, args, opts) => {
      calls.push({ projectRoot, args, timeoutMs: opts.timeoutMs });
      return outcome;
    },
    graftTimeoutMs: 60_000,
  };
  return {
    deps,
    calls,
    get graftClosureCalls() {
      return graftClosureCalls;
    },
  };
};
