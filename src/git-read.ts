import { execFileSync, type StdioOptions } from "node:child_process";

/**
 * The cap on every read-only git call: a read that stalls past `timeout` ms is
 * killed and throws, and `maxBuffer` lifts Node's 1 MB default so a large read is
 * not truncated into an error. Mutating git calls (merge, commit, add, worktree
 * add/remove/prune, branch -D) stay uncapped — killing one mid-write can leave the
 * index locked.
 */
export const GIT_READ_LIMITS = { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 };

/**
 * Run a read-only git command under `GIT_READ_LIMITS` and return its stdout,
 * untrimmed. Throws exactly as `execFileSync` does — on a non-zero exit, or on a
 * timeout — so each caller's existing failure handling covers a stalled read too.
 * `limits` is the test seam for the timeout.
 */
export function gitRead(
  args: string[],
  opts: { cwd?: string; stdio?: StdioOptions; limits?: { timeout: number; maxBuffer: number } } = {},
): string {
  const { cwd, stdio, limits = GIT_READ_LIMITS } = opts;
  return execFileSync("git", args, { encoding: "utf8", cwd, stdio, ...limits });
}
