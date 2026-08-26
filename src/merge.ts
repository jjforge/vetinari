import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";
import { applyCollect, formatMilestoneDate, FRAGMENT_DIR } from "./changelog.ts";

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
  /**
   * Greens a merge conflict pulled from this wave's integration (ADR 0013). A conflict
   * is attributable — git blames one branch — so only that merge is aborted; the issue
   * is quarantined with its branch, worktree, and agent session left intact so it is
   * resumable, and the wave neither rolls back nor halts.
   */
  quarantined: string[];
  /** Set when the wave halted on a red merged base — the emergent, unattributable
   * failure (each green passed alone, together they are red) that still rolls the base
   * back to where the wave began. */
  halt?: { reason: "gate-red"; detail: string };
}

/**
 * The merged-base gate, injected so `integrateGreens`'s merge/quarantine control flow
 * is unit-testable without a Docker sandbox. The default runs the real gate.
 */
export interface IntegrateDeps {
  gate: (cfg: ResolvedConfig) => Promise<{ green: boolean; report: string }>;
}
const defaultIntegrateDeps: IntegrateDeps = { gate: gateMergedBase };

/**
 * Merge each green task's branch into the checked-out base, then prove the COMBINED
 * result with the full gate — the each-green-but-together-red case a per-task gate
 * cannot see. Integration is non-atomic (ADR 0013): the two failures are handled by
 * whether blame is attributable.
 *
 * A **merge conflict** is attributable to one branch, so `git merge --abort`s only that
 * merge — never `reset --hard` to the wave start, which would un-merge the greens
 * already banked — quarantines the issue (branch/worktree/session preserved, resumable)
 * and continues integrating the rest of the wave.
 *
 * A **red merged base** has no single culprit, so it still rolls the base back to where
 * the wave began and halts, leaving the agent branches intact for a human.
 *
 * Assumes the main working tree is already on `cfg.baseBranch` (campaign ensures it) so
 * a merge advances HEAD in place and the next batch cuts from it.
 */
export async function integrateGreens(
  cfg: ResolvedConfig,
  greens: string[],
  deps: IntegrateDeps = defaultIntegrateDeps,
): Promise<IntegrateResult> {
  const preSha = git(["rev-parse", "HEAD"]);

  const merged: string[] = [];
  const quarantined: string[] = [];
  for (const taskId of greens) {
    const branch = `${cfg.branchPrefix}${taskId}`;
    const r = gitTry(["merge", "--no-ff", branch, "-m", `campaign: merge ${branch}`]);
    if (r.code !== 0) {
      // Attributable failure (ADR 0013): abort ONLY this merge — a `reset --hard preSha`
      // here would discard the greens already merged this wave — quarantine the issue
      // with its work preserved, and carry on with the rest of the wave.
      const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
      gitTry(["merge", "--abort"]);
      log("quarantined", { taskId, branch, detail });
      quarantined.push(taskId);
      continue;
    }
    log("campaign-merged", { taskId, branch });
    merged.push(taskId);
  }

  if (merged.length) {
    const { green, report } = await deps.gate(cfg);
    if (!green) {
      log("campaign-merged-base-red", { merged, preSha });
      gitTry(["merge", "--abort"]);
      gitTry(["reset", "--hard", preSha]);
      return { merged: [], quarantined, halt: { reason: "gate-red", detail: report.split("\n").slice(-40).join("\n") } };
    }
  }

  // Only once the combined result is green: drop the merged branches and let git
  // reclaim their (already-removed) worktree entries. Quarantined and parked/non-green
  // branches are never touched here — they stay resumable.
  for (const taskId of merged) gitTry(["branch", "-D", `${cfg.branchPrefix}${taskId}`]);
  gitTry(["worktree", "prune"]);
  log("campaign-integrated", { merged, headSha: git(["rev-parse", "HEAD"]) });
  return { merged, quarantined };
}

/**
 * Fold this wave's changelog fragments into `CHANGELOG.md` and commit the result on
 * the base in one commit (issue #123). Campaign agents write `changelog.d/<task-id>.md`
 * instead of editing the shared changelog, so co-wave branches never conflict on it;
 * once a wave's greens are merged those fragments sit on the base, and this collects
 * them. Called on the green path only — a halted wave rolls back and its fragments
 * stay for the retry. A wave that produced no fragment makes no commit.
 *
 * `root` is the base tree (defaults to the process cwd, which `campaign` guarantees is
 * on `baseBranch`); passing it explicitly is what makes this unit-testable against a
 * throwaway repo.
 */
export function collectWaveChangelog(waveIndex: number, root: string = process.cwd()): { collected: string[]; committed: boolean } {
  const { collected } = applyCollect({
    fragmentsDir: join(root, FRAGMENT_DIR),
    changelogPath: join(root, "CHANGELOG.md"),
    today: formatMilestoneDate(new Date()),
    title: "Collected changes",
  });
  if (!collected.length) {
    log("campaign-changelog-empty", { wave: waveIndex });
    return { collected, committed: false };
  }
  // `-A` stages both the CHANGELOG.md fold and the fragment deletions.
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "commit", "-m", `campaign: collect changelog (wave ${waveIndex + 1})`], { encoding: "utf8" });
  log("campaign-changelog-collected", { wave: waveIndex, collected });
  return { collected, committed: true };
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
