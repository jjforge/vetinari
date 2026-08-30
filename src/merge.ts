import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";
import { applyCollect, foldFragments, formatMilestoneDate, FRAGMENT_DIR } from "./changelog.ts";
import { listParkedIn, writeParkedRecord } from "./state.ts";
import { readEventLog } from "./event-log.ts";
import { reduceCampaign } from "./dashboard-model.ts";
import type { PointerDrop } from "./registry.ts";

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

/**
 * Is `branch` already banked on the checked-out base? True when the ref is gone
 * (merged and reclaimed in a prior run) or when every commit on it is already an
 * ancestor of HEAD — the same provable-reachability rule `tidy` uses (ADR 0013).
 * Lets `integrateGreens` skip banked greens on a redrive re-entry (design §7).
 */
function branchAlreadyMerged(branch: string): boolean {
  if (gitTry(["rev-parse", "--verify", "--quiet", branch]).code !== 0) return true;
  return gitTry(["merge-base", "--is-ancestor", branch, "HEAD"]).code === 0;
}

export interface IntegrateResult {
  merged: string[];
  /**
   * Greens recognised as already on the base (`branchAlreadyMerged`) — a redrive re-entry's
   * banked greens, or a green a human hand-merged onto the base (design §7). Each is logged
   * `merged` (so the reducer marks it completed and clears any conflict hold) but is kept OUT
   * of `merged`: no second merge commit is made. This is the redrive's "skipped as already
   * merged" set the caller counts. Optional so a test stub that never re-enters a wave may
   * omit it (absent reads as none).
   */
  alreadyMerged?: string[];
  /**
   * Greens a merge conflict pulled from this wave's integration (ADR 0013). A conflict
   * is attributable — git blames one branch — so only that merge is aborted; the issue
   * is parked with reason `conflict`, its branch, worktree, and agent session left intact
   * so it is resumable, and the wave neither rolls back nor halts.
   */
  conflictParked: string[];
  /**
   * Set when the merged base gated red — the emergent, unattributable failure (each
   * green passed alone, together they are red). No branch is to blame, so the wave is
   * NOT rolled back: the greens stay merged on the base and the campaign wave-parks
   * (a resumable pause) for a human to fix forward and resume, or prune a suspect
   * (ADR 0013). `detail` is the tail of the gate report.
   */
  parked?: { reason: "red-base"; detail: string };
}

/**
 * The merged-base gate, injected so `integrateGreens`'s merge/conflict control flow
 * is unit-testable without a Docker sandbox. The default runs the real gate.
 */
export interface IntegrateDeps {
  gate: (cfg: ResolvedConfig, index?: number) => Promise<{ green: boolean; report: string }>;
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
 * already banked — parks the issue with reason `conflict` (branch/worktree/session
 * preserved, resumable) and continues integrating the rest of the wave.
 *
 * A **red merged base** has no single culprit, so it is NOT rolled back either: the
 * greens stay merged, the branches are left intact, and the result carries `parked` so
 * the caller wave-parks — a resumable pause for a human to fix forward or prune a
 * suspect (never a machine-guessed culprit).
 *
 * Assumes the main working tree is already on `cfg.baseBranch` (campaign ensures it) so
 * a merge advances HEAD in place and the next batch cuts from it.
 */
export async function integrateGreens(
  cfg: ResolvedConfig,
  greens: string[],
  deps: IntegrateDeps = defaultIntegrateDeps,
  index?: number,
  opts: { regate?: boolean } = {},
): Promise<IntegrateResult> {
  const merged: string[] = [];
  const alreadyMerged: string[] = [];
  const conflictParked: string[] = [];
  for (const taskId of greens) {
    const branch = `${cfg.branchPrefix}${taskId}`;
    // Redrive idempotency + hand-merge recognition (design §7): a green already banked on the
    // base — its branch gone, or every commit already an ancestor of HEAD — is never merged a
    // second time. But it IS recognised as landed: `merged` is logged so the reducer marks it
    // completed and clears any conflict hold (a human who hand-merges a conflict-parked green
    // onto the base, then redrives, must close the wave). It rides `alreadyMerged`, not `merged`
    // — no second merge commit — so the caller can count it as "skipped as already merged".
    if (branchAlreadyMerged(branch)) {
      cfg.log.log("merged", { taskId, branch });
      alreadyMerged.push(taskId);
      continue;
    }
    const r = gitTry(["merge", "--no-ff", branch, "-m", `campaign: merge ${branch}`]);
    if (r.code !== 0) {
      // Attributable failure (ADR 0013): abort ONLY this merge — a `reset --hard` to
      // the wave start here would discard the greens already merged this wave —
      // park the issue with its work preserved, and carry on with the rest.
      const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
      gitTry(["merge", "--abort"]);
      // A merge conflict is an integrator park with reason `conflict` (design §2.3): the
      // issue's green stays banked, its branch/worktree/session preserved and resumable.
      // Write the durable parked record beside the event (design §2.5, "written by whatever
      // parks") so the card stays off idle and the gateway can announce/redrive it after the
      // run's log is archived — the event alone vanishes with the log. `conflict` redrives,
      // never resumes by reply, so the record carries no session; `question` names the move.
      writeParkedRecord(cfg, { taskId, reason: "conflict", detail, branch, question: `Merge conflict on ${branch} — resolve it on the base, then redrive.` });
      cfg.log.log("parked", { taskId, reason: "conflict", detail });
      conflictParked.push(taskId);
      continue;
    }
    cfg.log.log("merged", { taskId, branch });
    merged.push(taskId);
  }

  // Gate the merged base when something new merged, OR when re-entering a red-base-parked
  // wave (`regate`, design §7) where nothing new merges but the base must be re-proven: a
  // fix-forward may have turned it green, or it may still be red and re-park.
  if (merged.length || opts.regate) {
    const { green, report } = await deps.gate(cfg, index);
    if (!green) {
      // Emergent, unattributable failure (ADR 0013): every green passed alone, the
      // combined base is red, so no branch is to blame. Do NOT `reset --hard` to the
      // wave start — that would un-merge the greens — and do NOT drop the merged branches:
      // leave everything merged on the base and wave-park. The caller pauses the
      // campaign for a human to fix forward and resume, or prune a suspect. The base
      // sits red but is never pushed and nothing builds on it while paused.
      // The combined base gated red with no attributable culprit (design §2.3): the greens
      // stay merged and the campaign parks. The `base-gate` above already recorded the red
      // result; the caller logs the `campaign-parked` stop marker with the wave index.
      const detail = report.split("\n").slice(-40).join("\n");
      return { merged, alreadyMerged, conflictParked, parked: { reason: "red-base", detail } };
    }
  }

  // Only once the combined result is green: drop the merged branches and let git
  // reclaim their (already-removed) worktree entries. Conflict-parked and parked/non-green
  // branches are never touched here — they stay resumable.
  for (const taskId of merged) gitTry(["branch", "-D", `${cfg.branchPrefix}${taskId}`]);
  gitTry(["worktree", "prune"]);
  cfg.log.log("campaign-integrated", { merged, headSha: git(["rev-parse", "HEAD"]) });
  return { merged, alreadyMerged, conflictParked };
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
 * throwaway repo. `log` is the run's injected logger — this is a host helper, not a
 * `cfg` holder, so the logger is threaded in explicitly.
 *
 * The fold runs only when the project keeps a `CHANGELOG.md` (design §12). A project
 * with none is opting out: its fragments are left on the base and one line is logged,
 * rather than a changelog being materialised no one asked for.
 */
export function collectWaveChangelog(waveIndex: number, log: Logger, root: string = process.cwd()): { collected: string[]; committed: boolean } {
  const { collected, skipped } = applyCollect({
    fragmentsDir: join(root, FRAGMENT_DIR),
    changelogPath: join(root, "CHANGELOG.md"),
    today: formatMilestoneDate(new Date()),
    title: "Collected changes",
  });
  if (skipped === "no-changelog") {
    log.log("campaign-changelog-skipped", { wave: waveIndex, reason: "no-changelog" });
    return { collected, committed: false };
  }
  if (!collected.length) {
    log.log("campaign-changelog-empty", { wave: waveIndex });
    return { collected, committed: false };
  }
  // `-A` stages both the CHANGELOG.md fold and the fragment deletions.
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "commit", "-m", `campaign: collect changelog (wave ${waveIndex + 1})`], { encoding: "utf8" });
  log.log("campaign-changelog-collected", { wave: waveIndex, collected });
  return { collected, committed: true };
}

/**
 * Run every gate against the merged base. A throwaway sandbox cuts its branch
 * from HEAD (now carrying all the merges), so `all: true` verifies the combined
 * tree the same way `baseline` verifies a fresh one.
 */
async function gateMergedBase(cfg: ResolvedConfig, index?: number): Promise<{ green: boolean; report: string }> {
  const sbx = await makeSandbox(cfg, "campaign-integrate");
  try {
    const result = await runGates(cfg, sbx, { all: true });
    cfg.log.log("base-gate", {
      ...(index !== undefined ? { index } : {}),
      green: result.green,
      ...(result.green ? {} : { detail: result.report.split("\n").slice(-40).join("\n") }),
    });
    return result;
  } finally {
    await sbx.close();
    gitTry(["branch", "-D", `${cfg.branchPrefix}campaign-integrate`]);
    gitTry(["worktree", "prune"]);
  }
}

// ── tidy: reconcile drift that human-in-the-loop resolution leaks (ADR 0013) ──
//
// A manual fix-forward or by-hand merge is where the inline cleanup never runs:
// changelog fragments for merged issues never fold, agent branches/worktrees never
// GC, and parked records for now-resolved issues linger. `tidy` reconciles that,
// dry-run by default. Its one load-bearing rule is that a branch dies only when it
// is PROVABLY reachable from the base — never a branch with unmerged work, and never
// a conflict-parked / parked / campaign-parked issue (whose work must stay resumable).

/** Strip a leading `#` so a logged/parked id (`#42`) matches a branch suffix (`42`). */
const normalizeTidyId = (id: string) => id.replace(/^#/, "").trim();

/** One agent branch present in the repo, with whether it is fully merged into the base. */
export interface TidyBranch {
  /** the task id — the `agent/<id>` branch's suffix after the prefix. */
  id: string;
  /** true when every commit on `agent/<id>` is already an ancestor of the base branch. */
  reachable: boolean;
}

/**
 * The reconcilable on-disk/tracker state of one project, gathered at the edge so
 * `computeTidy` stays a pure decision. `parked`/`conflictParked`/`campaignParked` are the
 * three states whose work must be preserved (ADR 0013).
 */
export interface TidySnapshot {
  /** the `agent/<id>` branches present, each with its reachability from the base. */
  branches: TidyBranch[];
  /** the issue ids that still have a `changelog.d/<id>.md` fragment on disk. */
  fragments: string[];
  /** issue ids with a live parked record. */
  parked: string[];
  /** issue ids a merge conflict parked out of integration (event log). */
  conflictParked: string[];
  /** issue ids whose wave a red merged base parked the campaign on (event log). */
  campaignParked: string[];
}

/** What `tidy` would fold, delete, and clear — the plan a dry-run prints and `--apply` acts on. */
export interface TidyPlan {
  /** issue ids whose orphaned fragment folds into `CHANGELOG.md` (merged, unprotected). */
  fold: string[];
  /** issue ids whose provably-merged, unprotected `agent/<id>` branch + worktree GC. */
  deleteBranches: string[];
  /** parked issue ids whose record is now stale (the issue merged) and is cleared. */
  clearParked: string[];
  /** merged issue ids being GC'd that carry no changelog fragment — warned, never invented. */
  warnNoChangelog: string[];
  /** present branches left untouched, each with why (unmerged / parked(conflict) / parked / campaign-parked). */
  keep: { id: string; reason: "unmerged" | "parked(conflict)" | "parked" | "campaign-parked" }[];
}

/**
 * Decide what to reconcile from a snapshot — pure, no I/O (the acceptance-critical
 * seam). A branch is deleted ONLY when provably reachable from the base and not one
 * of the preserved states; a fragment folds only when its issue is merged (branch
 * reachable, or already gone) and unprotected; a parked record is cleared once its
 * issue is merged, though its branch is still left for that run (a parked branch is
 * never touched — a later run GCs it once the record is gone).
 */
export function computeTidy(snap: TidySnapshot): TidyPlan {
  const present = new Set(snap.branches.map((b) => normalizeTidyId(b.id)));
  const reachable = new Map(snap.branches.map((b) => [normalizeTidyId(b.id), b.reachable]));
  const conflictParked = new Set(snap.conflictParked.map(normalizeTidyId));
  const campaignParked = new Set(snap.campaignParked.map(normalizeTidyId));
  const parked = new Set(snap.parked.map(normalizeTidyId));
  const fragments = snap.fragments.map(normalizeTidyId);
  const fragmentSet = new Set(fragments);
  const protectedId = new Set([...conflictParked, ...campaignParked, ...parked]);

  // Merged = the work is on the base: its branch is a reachable ancestor, or the
  // branch is already gone (cleaned by hand) yet an artifact for it still lingers.
  const isMerged = (id: string) => !present.has(id) || reachable.get(id) === true;

  const deleteBranches = snap.branches
    .map((b) => normalizeTidyId(b.id))
    .filter((id) => reachable.get(id) === true && !protectedId.has(id));

  const fold = fragments.filter((id) => isMerged(id) && !protectedId.has(id));
  const clearParked = [...parked].filter(isMerged);
  const warnNoChangelog = deleteBranches.filter((id) => !fragmentSet.has(id));

  const deleteSet = new Set(deleteBranches);
  const keep = snap.branches
    .map((b) => normalizeTidyId(b.id))
    .filter((id) => !deleteSet.has(id))
    .map((id) => ({
      id,
      reason: conflictParked.has(id)
        ? ("parked(conflict)" as const)
        : campaignParked.has(id)
          ? ("campaign-parked" as const)
          : parked.has(id)
            ? ("parked" as const)
            : ("unmerged" as const),
    }));

  return { fold, deleteBranches, clearParked, warnNoChangelog, keep };
}

/** One project to reconcile — its root and the paths `scanTidy`/`applyTidy` read and write. */
export interface TidyTarget {
  /** the project name, for the report header. */
  project: string;
  /** the repo root git runs against (cwd for a single project, the pointer's root under `--all`). */
  root: string;
  /** the branch reachability is proven against. */
  baseBranch: string;
  /** the `agent/` prefix agent branches carry. */
  branchPrefix: string;
  /** absolute path to the project's parked-records directory. */
  parkedDir: string;
  /** absolute path to the project's orchestrator event log. */
  logFile: string;
  /** absolute path to the project's `changelog.d/` fragment directory. */
  fragmentsDir: string;
  /** absolute path to the project's `CHANGELOG.md`. */
  changelogPath: string;
}

/** Every `agent/<id>` head present, paired with whether it is fully merged into the base. */
function scanBranches(root: string, baseBranch: string, branchPrefix: string): TidyBranch[] {
  const listed = gitTry(["-C", root, "for-each-ref", "--format=%(refname:short)", `refs/heads/${branchPrefix}*`]);
  return listed.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((branch) => ({
      id: branch.slice(branchPrefix.length),
      // `merge-base --is-ancestor <branch> <base>` exits 0 iff every commit on the
      // branch is already in the base — the provable-reachability rule (ADR 0013).
      reachable: gitTry(["-C", root, "merge-base", "--is-ancestor", branch, baseBranch]).code === 0,
    }));
}

/** Gather a project's reconcilable state — the edge that keeps `computeTidy` pure. */
export function scanTidy(target: TidyTarget): TidySnapshot {
  const reduced = reduceCampaign(readEventLog({ logFile: target.logFile }));
  const campaignParked = reduced.parkedWave >= 0 ? (reduced.waves[reduced.parkedWave] ?? []) : [];
  return {
    branches: scanBranches(target.root, target.baseBranch, target.branchPrefix),
    fragments: existsSync(target.fragmentsDir)
      ? readdirSync(target.fragmentsDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.slice(0, -".md".length))
      : [],
    parked: listParkedIn(target.parkedDir).map((r) => r.taskId),
    conflictParked: [...reduced.conflictParked],
    campaignParked,
  };
}

/** Whether a plan would change anything at all — the "nothing to do" gate. */
export const tidyIsEmpty = (plan: TidyPlan): boolean =>
  !plan.fold.length && !plan.deleteBranches.length && !plan.clearParked.length && !plan.warnNoChangelog.length;

/** Render a plan as the human-readable report a dry-run prints and `--apply` echoes. */
export function describeTidy(project: string, plan: TidyPlan): string {
  if (tidyIsEmpty(plan) && !plan.keep.length) return `tidy ${project}: nothing to reconcile`;
  const lines = [`tidy ${project}:`];
  if (plan.fold.length) lines.push(`  fold changelog fragments: ${plan.fold.map((i) => `#${i}`).join(", ")}`);
  if (plan.deleteBranches.length)
    lines.push(`  delete merged branches (+ prune worktrees): ${plan.deleteBranches.map((i) => `agent/${i}`).join(", ")}`);
  if (plan.clearParked.length) lines.push(`  clear stale parked records: ${plan.clearParked.map((i) => `#${i}`).join(", ")}`);
  for (const id of plan.warnNoChangelog) lines.push(`  ⚠ #${id} merged with no changelog fragment — cannot invent one`);
  for (const k of plan.keep) lines.push(`  keep agent/${k.id} (${k.reason})`);
  return lines.join("\n");
}

/**
 * Enact a plan against a real project: fold the chosen fragments into `CHANGELOG.md`,
 * GC each provably-merged branch (removing its worktree first, then pruning), and
 * clear the stale parked records. Only ever called on `--apply`; the changelog fold
 * and fragment deletions are left uncommitted for the human to review, mirroring
 * `changelog collect`.
 */
export function applyTidy(target: TidyTarget, plan: TidyPlan): void {
  if (plan.fold.length) {
    foldFragments(
      {
        fragmentsDir: target.fragmentsDir,
        changelogPath: target.changelogPath,
        today: formatMilestoneDate(new Date()),
        title: "Collected changes",
      },
      plan.fold.map((id) => `${id}.md`),
    );
  }

  for (const id of plan.deleteBranches) {
    const branch = `${target.branchPrefix}${id}`;
    removeWorktreeFor(target.root, branch);
    gitTry(["-C", target.root, "branch", "-D", branch]);
  }
  if (plan.deleteBranches.length) gitTry(["-C", target.root, "worktree", "prune"]);

  for (const id of plan.clearParked) rmSync(join(target.parkedDir, `${id}.json`), { force: true });
}

/**
 * Render the registry dedup drops (issue #164) as the host-level section `tidy`
 * folds into its summary — one line per duplicate `projectRoot` pointer being
 * dropped, naming the canonical pointer kept in its place. Empty when there is
 * nothing to drop, so the caller can skip printing a section for it.
 */
export function describeRegistryDedup(drops: PointerDrop[]): string {
  if (!drops.length) return "";
  return [
    "tidy registry:",
    ...drops.map(
      (d) => `  registry: drop duplicate pointer '${d.drop}' — projectRoot ${d.projectRoot} also held by '${d.kept}'`,
    ),
  ].join("\n");
}

/** Remove a live worktree checked out on `branch`, so its branch ref can then be deleted. */
function removeWorktreeFor(root: string, branch: string): void {
  const porcelain = gitTry(["-C", root, "worktree", "list", "--porcelain"]).stdout;
  // Blocks are separated by blank lines: `worktree <path>` … `branch refs/heads/<name>`.
  let path: string | undefined;
  for (const block of porcelain.split("\n\n")) {
    const p = block.match(/^worktree (.+)$/m)?.[1];
    const b = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (p && b === branch) {
      path = p;
      break;
    }
  }
  if (path) gitTry(["-C", root, "worktree", "remove", "--force", path]);
}
