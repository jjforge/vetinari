import { execFileSync } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";

/** Run git in the host project root, throwing its stderr on a non-zero exit. */
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Run git without throwing — the caller decides what a non-zero exit means. */
function gitTry(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? "") };
  }
}

export const currentBranch = () => git(["rev-parse", "--abbrev-ref", "HEAD"]);

export interface IntegrateResult {
  merged: string[];
  /** Set when the batch halted: a conflict on a branch, or a red merged-base gate. */
  halt?: { reason: "conflict" | "gate-red"; taskId?: string; detail: string };
}

/**
 * Merge each green task's branch into the checked-out base, then prove the
 * COMBINED result with the full gate — the each-green-but-together-red case a
 * per-task gate cannot see. Any conflict, or a red merged base, rolls the base
 * back to where it started and halts: the agent branches are left intact for a
 * human, exactly as an unanswered park is.
 *
 * Assumes the main working tree is already on `cfg.baseBranch` (campaign ensures
 * it) so a merge advances HEAD in place and the next batch cuts from it.
 */
export async function integrateGreens(cfg: ResolvedConfig, greens: string[]): Promise<IntegrateResult> {
  const preSha = git(["rev-parse", "HEAD"]);
  const rollback = () => {
    gitTry(["merge", "--abort"]);
    gitTry(["reset", "--hard", preSha]);
  };

  const merged: string[] = [];
  for (const taskId of greens) {
    const branch = `${cfg.branchPrefix}${taskId}`;
    const r = gitTry(["merge", "--no-ff", branch, "-m", `campaign: merge ${branch}`]);
    if (r.code !== 0) {
      const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
      log("campaign-merge-conflict", { taskId, branch, preSha });
      rollback();
      return { merged: [], halt: { reason: "conflict", taskId, detail } };
    }
    log("campaign-merged", { taskId, branch });
    merged.push(taskId);
  }

  if (merged.length) {
    const { green, report } = await gateMergedBase(cfg);
    if (!green) {
      log("campaign-merged-base-red", { merged, preSha });
      rollback();
      return { merged: [], halt: { reason: "gate-red", detail: report.split("\n").slice(-40).join("\n") } };
    }
  }

  // Only once the combined result is green: drop the merged branches and let git
  // reclaim their (already-removed) worktree entries. Parked/non-green branches
  // are never touched here — they stay answerable via dispatch.
  for (const taskId of merged) gitTry(["branch", "-D", `${cfg.branchPrefix}${taskId}`]);
  gitTry(["worktree", "prune"]);
  log("campaign-integrated", { merged, headSha: git(["rev-parse", "HEAD"]) });
  return { merged };
}

/**
 * Run every gate against the merged base. A throwaway sandbox cuts its branch
 * from HEAD (now carrying all the merges), so `all: true` verifies the combined
 * tree the same way `baseline` verifies a fresh one.
 */
async function gateMergedBase(cfg: ResolvedConfig): Promise<{ green: boolean; report: string }> {
  const sbx = await makeSandbox(cfg, "campaign-integrate");
  try {
    const result = await runGates(cfg, sbx, { all: true });
    log("campaign-merged-base-gate", { green: result.green });
    return result;
  } finally {
    await sbx.close();
    gitTry(["branch", "-D", `${cfg.branchPrefix}campaign-integrate`]);
    gitTry(["worktree", "prune"]);
  }
}
