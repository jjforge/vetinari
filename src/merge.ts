import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GateSpec, ResolvedConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox, removeCopilotDir } from "./sandbox.ts";
import { applyCollect, foldFragments, formatMilestoneDate, FRAGMENT_DIR, type FragmentNearMiss } from "./changelog.ts";
import { clearParked, clearParkedIn, listParkedIn, writeParkedRecord } from "./state.ts";
import { PARK_RECOVERY, recoverySentence } from "./park-recovery.ts";
import { readEventLog } from "./event-log.ts";
import { reduceCampaign } from "./campaign-fold.ts";
import type { PointerDrop } from "./registry.ts";
import { normalize } from "./issue-id.ts";
import { gitRead } from "./git-read.ts";

/** Run a read-only git command in the host project root, throwing its stderr on a non-zero exit. */
const git = (args: string[]) => gitRead(args).trim();

type GitTryResult = { code: number; stdout: string; stderr: string };
const gitTryFailure = (e: any): GitTryResult => ({
  code: e.status ?? 1,
  stdout: String(e.stdout ?? ""),
  stderr: String(e.stderr ?? e.message ?? ""),
});

/**
 * Run git without throwing — the caller decides what a non-zero exit means. Uncapped:
 * it serves the writes (merge, branch -D, worktree prune/remove), and killing one
 * mid-write can leave the index locked. Read-only calls use `gitTryRead`.
 */
function gitTry(args: string[]): GitTryResult {
  try {
    return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e: any) {
    return gitTryFailure(e);
  }
}

/** `gitTry` for a read-only git call, capped by `GIT_READ_LIMITS` — a timeout returns a non-zero `code`. */
function gitTryRead(args: string[]): GitTryResult {
  try {
    return { code: 0, stdout: gitRead(args, { stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e: any) {
    return gitTryFailure(e);
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
  if (gitTryRead(["rev-parse", "--verify", "--quiet", branch]).code !== 0) return true;
  return gitTryRead(["merge-base", "--is-ancestor", branch, "HEAD"]).code === 0;
}

/**
 * Does `taskId`'s agent branch carry any commit beyond the base — banked work a crash left
 * behind? True only when the ref exists and `baseBranch..branch` is non-empty. Lets a redrive
 * tell a crashed member with committed work (resume its session, design §7) from one that never
 * got started (treat as unstarted → a fresh run). A missing ref or a git failure reads false, so
 * an unverifiable branch degrades to a fresh run rather than a resume onto nothing.
 */
export function branchHasCommits(cfg: { baseBranch: string; branchPrefix: string }, taskId: string): boolean {
  const branch = `${cfg.branchPrefix}${taskId}`;
  const r = gitTryRead(["rev-list", "--count", `${cfg.baseBranch}..${branch}`]);
  return r.code === 0 && Number(r.stdout.trim()) > 0;
}

/**
 * The abbreviated sha of the campaign merge commit that landed `taskId` on the base — a commit
 * reachable from `cfg.baseBranch` (the ref, not HEAD) whose subject is exactly
 * `campaign: merge <branchPrefix><taskId>` — or undefined when there is none. The green path
 * reclaims the agent branch after merging, so the merge subject, not the branch, is what still
 * proves the issue merged; a fresh campaign's planner skips such an issue (design §4). The match
 * is exact (`agent/40` never matches `agent/405`), and a git failure reads undefined, so an
 * unreadable repo skips nothing.
 */
export function findMergeCommit(cfg: { baseBranch: string; branchPrefix: string }, taskId: string): string | undefined {
  const subject = `campaign: merge ${cfg.branchPrefix}${taskId}`;
  const r = gitTryRead(["log", cfg.baseBranch, "--fixed-strings", `--grep=${subject}`, "--format=%h %s", "--"]);
  if (r.code !== 0) return undefined;
  for (const line of r.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && line.slice(space + 1) === subject) return line.slice(0, space);
  }
  return undefined;
}

/**
 * A green whose merge collided with the base — `git merge` stopped with unmerged paths, or the
 * merge went through but a `perMerge` gate went red on it and the merge was undone (design §6).
 * `integrateGreens` reports it and parks nothing; the campaign re-admits it for one retry by its own
 * agent, and only a second collision parks it (`parkMergeConflict`).
 */
export interface MergeConflict {
  taskId: string;
  /** the paths git left unmerged — what the retry's prompt names. Empty for a failed check. */
  paths: string[];
  /** the base commit the retry merges into its branch: HEAD once this pass's merges have landed. */
  base: string;
  /** the tail of the merge output (or of the failed check's output), the `detail` a park would carry. */
  detail: string;
  /** set when a per-merge check failed rather than the merge: that gate's label, or its `cmd`. */
  gate?: string;
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
   * Greens whose merge collided with the base (design §6). A conflict is attributable — git
   * blames one branch — so only that merge is aborted, its branch, worktree and agent session
   * are left intact, and the wave neither rolls back nor halts. Nothing is parked here: the
   * campaign retries each one once with its own agent and parks only a second collision.
   */
  conflicts: MergeConflict[];
  /**
   * Greens whose merge failed with no unmerged paths — a dirty tree, a held `index.lock`, any
   * other merge failure (design §6). Not a conflict, so never retried or parked: each is logged
   * `failed` with the merge output and its wave resolves as for any failed member. Optional so a
   * test stub may omit it (absent reads as none).
   */
  mergeFailed?: string[];
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
 * Park a green whose retried merge collided again (design §6): an integrator park with reason
 * `conflict`, its green still banked and its branch/worktree/session preserved. The durable parked
 * record is written beside the event (design §2.5, "written by whatever parks") so the card stays
 * off idle and the gateway can announce/redrive it after the run's log is archived — the event
 * alone vanishes with the log. `conflict` redrives, never resumes by reply, so the record carries
 * no session; `question` names the move.
 */
export function parkMergeConflict(cfg: ResolvedConfig, conflict: MergeConflict): void {
  const branch = `${cfg.branchPrefix}${conflict.taskId}`;
  writeParkedRecord(cfg, {
    taskId: conflict.taskId,
    reason: "conflict",
    detail: conflict.detail,
    branch,
    question: conflict.gate
      ? `Merge of ${branch} fails ${conflict.gate} — fix it on the base, then \`vetinari redrive\`.`
      : `Merge conflict on ${branch}. ${recoverySentence(PARK_RECOVERY.conflict, conflict.taskId)}`,
  });
  cfg.log.log("parked", { taskId: conflict.taskId, reason: "conflict", detail: conflict.detail });
}

/**
 * The merged-base gate and the per-merge check, injected so `integrateGreens`'s merge/conflict
 * control flow is unit-testable without a Docker sandbox. The defaults run the real gates.
 */
export interface IntegrateDeps {
  gate: (cfg: ResolvedConfig, index?: number) => Promise<{ green: boolean; report: string }>;
  /**
   * Run the `perMerge` gates (`flagged`) on the base just after one member's merge, `failed`
   * naming the red one. Optional so a test that flags no gate may omit it; absent falls back to
   * the real check.
   */
  perMergeGate?: (cfg: ResolvedConfig, flagged: GateSpec[]) => Promise<{ green: boolean; report: string; failed?: GateSpec }>;
}
const defaultIntegrateDeps: IntegrateDeps = { gate: gateMergedBase, perMergeGate: gatePerMerge };

/**
 * Merge each green task's branch into the checked-out base, then prove the COMBINED
 * result with the full gate — the each-green-but-together-red case a per-task gate
 * cannot see. Integration is non-atomic (ADR 0013): the two failures are handled by
 * whether blame is attributable.
 *
 * A **merge conflict** (git stops with unmerged paths) is attributable to one branch, so
 * `git merge --abort`s only that merge — never `reset --hard` to the wave start, which
 * would un-merge the greens already banked — and continues integrating the rest of the
 * wave. It parks nothing: the collision is returned in `conflicts` with its unmerged paths
 * and the base commit, and the campaign re-admits the issue for one retry by its own agent
 * (a `re-admit` event, then a second pass through here), parking it `conflict` only if
 * that retry collides again (`parkMergeConflict`, design §6).
 *
 * A merge that fails with **no unmerged paths** (a dirty tree, a held `index.lock`) is not
 * a conflict the agent could resolve: any merge in progress is aborted, the member is
 * logged `failed` with the merge output and returned in `mergeFailed`, and its wave
 * resolves as for any failed member. It is never retried or parked.
 *
 * The **per-merge check**: when a gate is flagged `perMerge`, each merge that succeeds is
 * checked by running the flagged gates on the base (`deps.perMergeGate`). A red check undoes
 * that merge only — `git reset --keep` to the commit recorded just before it, which is the
 * newest commit then, so it never resets past the member being integrated and keeps the
 * operator's unrelated local edits — and the member is returned in `conflicts` with no paths,
 * the failing `gate` and its output tail, for the same one retry as a conflict. `merged` is
 * logged only after a green check. A green already on the base gets no check and no undo (its
 * merge may no longer be the newest commit); with a flagged gate it forces the merged-base gate.
 *
 * A **red merged base** has no single culprit, so it is NOT rolled back either: the
 * greens stay merged, the branches are left intact, and the result carries `parked` so
 * the caller wave-parks — a resumable pause for a human to fix forward or prune a
 * suspect (never a machine-guessed culprit).
 *
 * Every member logged `merged` (fresh or already on the base) has its parked record cleared,
 * whatever its reason — merged is terminal, even if the merged base then gates red (a
 * `red-base` park writes no per-issue record), design §2.5.
 *
 * Assumes the main working tree is already on `cfg.baseBranch` (campaign ensures it) so
 * a merge advances HEAD in place and the next wave cuts from it.
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
  const collided: Omit<MergeConflict, "base">[] = [];
  const mergeFailed: string[] = [];
  const flagged = cfg.gates?.filter((g) => g.perMerge) ?? [];
  const perMergeGate = deps.perMergeGate ?? gatePerMerge;
  for (const taskId of greens) {
    const branch = `${cfg.branchPrefix}${taskId}`;
    // Redrive idempotency + hand-merge recognition (design §7): a green already banked on the
    // base — its branch gone, or every commit already an ancestor of HEAD — is never merged a
    // second time. But it IS recognised as landed: `merged` is logged so the reducer marks it
    // completed and clears any conflict hold (a human who hand-merges a conflict-parked green
    // onto the base, then redrives, must close the wave). It rides `alreadyMerged`, not `merged`
    // — no second merge commit — so the caller can count it as "skipped as already merged".
    // The row is marked `alreadyMerged` so the reducer can tell this re-log from a real merge
    // still awaiting its base gate (`ungatedMerge`, design §7).
    if (branchAlreadyMerged(branch)) {
      cfg.log.log("merged", { taskId, branch, alreadyMerged: true });
      clearParked(cfg, taskId);
      alreadyMerged.push(taskId);
      continue;
    }
    const preMerge = git(["rev-parse", "HEAD"]);
    const r = gitTry(["merge", "--no-ff", branch, "-m", `campaign: merge ${branch}`]);
    if (r.code !== 0) {
      // Attributable failure (design §6): abort ONLY this merge — a `reset --hard` to the wave
      // start here would discard the greens already merged this wave — and carry on with the rest.
      // The unmerged paths are read BEFORE the abort, which clears them: they are what tells a real
      // conflict (the agent can resolve it) from any other failed merge (it cannot).
      const detail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-12).join("\n");
      const paths = gitTryRead(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
      if (gitTryRead(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0) gitTry(["merge", "--abort"]);
      if (paths.length) {
        collided.push({ taskId, paths, detail });
      } else {
        cfg.log.log("failed", { taskId, detail });
        mergeFailed.push(taskId);
      }
      continue;
    }
    if (flagged.length) {
      const check = await perMergeGate(cfg, flagged);
      if (!check.green) {
        // Attributable to this member: undo ONLY its merge — the newest commit, so this never
        // resets past it. `--keep`, never `--hard`: integration runs in the operator's checkout,
        // and `--keep` keeps unrelated local edits (refusing rather than clobbering them).
        const undo = gitTry(["reset", "--keep", preMerge]);
        if (undo.code !== 0) throw new Error(`could not undo the merge of ${branch}: ${undo.stderr.trim()}`);
        const failed = check.failed ?? flagged[0];
        collided.push({ taskId, paths: [], gate: failed.label ?? failed.cmd, detail: check.report.split("\n").slice(-40).join("\n") });
        continue;
      }
    }
    cfg.log.log("merged", { taskId, branch });
    clearParked(cfg, taskId);
    merged.push(taskId);
  }

  // The base a collided green's retry merges: HEAD with every merge this pass made already on it.
  const base = collided.length ? git(["rev-parse", "HEAD"]) : "";
  const conflicts = collided.map((c) => ({ ...c, base }));

  // Gate the merged base when something new merged, OR when re-entering a red-base-parked
  // wave (`regate`, design §7) where nothing new merges but the base must be re-proven: a
  // fix-forward may have turned it green, or it may still be red and re-park. With a `perMerge`
  // gate, an already-merged green forces it too: a crash may have left its merge on the base
  // unchecked, and that merge is never undone (it may no longer be the newest commit).
  if (merged.length || opts.regate || (flagged.length && alreadyMerged.length)) {
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
      return { merged, alreadyMerged, conflicts, mergeFailed, parked: { reason: "red-base", detail } };
    }
  }

  // Only once the combined result is green: drop the merged branches and let git
  // reclaim their (already-removed) worktree entries. Collided and parked/non-green branches
  // are never touched here — they stay resumable. Every landed green's Copilot directory
  // (ADR 0024) goes with it: its session has nothing left to resume.
  for (const taskId of merged) gitTry(["branch", "-D", `${cfg.branchPrefix}${taskId}`]);
  for (const taskId of [...merged, ...alreadyMerged]) removeCopilotDir(cfg.stateDir, taskId);
  gitTry(["worktree", "prune"]);
  cfg.log.log("campaign-integrated", { merged, headSha: git(["rev-parse", "HEAD"]) });
  return { merged, alreadyMerged, conflicts, mergeFailed };
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
 *
 * `nearMisses` names the `changelog.d/` files that looked like fragments but folded
 * nothing (left in place, never committed); the campaign loop prints them.
 */
export function collectWaveChangelog(
  waveIndex: number,
  log: Logger,
  root: string = process.cwd(),
): { collected: string[]; committed: boolean; nearMisses?: FragmentNearMiss[] } {
  const { collected, skipped, nearMisses } = applyCollect({
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
    log.log("campaign-changelog-empty", { wave: waveIndex, nearMisses });
    return { collected, committed: false, nearMisses };
  }
  // Stage only what the fold touched — never `git add -A`, which would sweep any
  // unrelated edit in the operator's checkout into this commit (issue #364). The
  // CHANGELOG.md fold is always staged; an unstaged edit the operator had made to
  // CHANGELOG.md itself is swept in too, because the fold rewrites that file.
  execFileSync("git", ["-C", root, "add", "--", "CHANGELOG.md"], { encoding: "utf8" });
  // Stage each collected fragment's deletion by explicit path. A fragment that was
  // never committed (untracked) has nothing to stage once deleted — `git add` of a
  // deleted untracked path exits 128 — so tolerate the failure rather than abort.
  // Only a fragment HEAD has has a deletion to commit: one staged but never committed
  // drops out of the index on the add and is unknown to `git commit -- <path>` (#473).
  const staged = ["CHANGELOG.md"];
  for (const name of collected) {
    const path = join(FRAGMENT_DIR, name);
    gitTry(["-C", root, "add", "-A", "--", path]);
    if (gitTryRead(["-C", root, "cat-file", "-e", `HEAD:${path}`]).code === 0) staged.push(path);
  }
  // Commit only those paths: a bare `git commit` would also take anything the operator
  // had already staged (#459). With a pathspec, their index entries are left staged.
  execFileSync("git", ["-C", root, "commit", "-m", `campaign: collect changelog (wave ${waveIndex + 1})`, "--", ...staged], {
    encoding: "utf8",
  });
  log.log("campaign-changelog-collected", { wave: waveIndex, collected, nearMisses });
  return { collected, committed: true, nearMisses };
}

/**
 * Run the `perMerge` gates against the base just after one member's merge — the per-merge check.
 * Like `gateMergedBase` it gates a throwaway sandbox cut from HEAD, but it logs no `base-gate`:
 * that event stays the full gate against a wave's merged base. Its `gate-result` rows carry
 * `perMerge: true`, so the merged-base gate total skips them (report.ts).
 */
async function gatePerMerge(cfg: ResolvedConfig, flagged: GateSpec[]): Promise<{ green: boolean; report: string; failed?: GateSpec }> {
  const sbx = await makeSandbox(cfg, "campaign-integrate");
  try {
    return await runGates({ ...cfg, gates: flagged }, sbx, { all: true, perMerge: true });
  } finally {
    await sbx.close();
    gitTry(["branch", "-D", `${cfg.branchPrefix}campaign-integrate`]);
    gitTry(["worktree", "prune"]);
  }
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
  const present = new Set(snap.branches.map((b) => normalize(b.id)));
  const reachable = new Map(snap.branches.map((b) => [normalize(b.id), b.reachable]));
  const conflictParked = new Set(snap.conflictParked.map(normalize));
  const campaignParked = new Set(snap.campaignParked.map(normalize));
  const parked = new Set(snap.parked.map(normalize));
  const fragments = snap.fragments.map(normalize);
  const fragmentSet = new Set(fragments);
  const protectedId = new Set([...conflictParked, ...campaignParked, ...parked]);

  // Merged = the work is on the base: its branch is a reachable ancestor, or the
  // branch is already gone (cleaned by hand) yet an artifact for it still lingers.
  const isMerged = (id: string) => !present.has(id) || reachable.get(id) === true;

  const deleteBranches = snap.branches.map((b) => normalize(b.id)).filter((id) => reachable.get(id) === true && !protectedId.has(id));

  const fold = fragments.filter((id) => isMerged(id) && !protectedId.has(id));
  const clearParked = [...parked].filter(isMerged);
  const warnNoChangelog = deleteBranches.filter((id) => !fragmentSet.has(id));

  const deleteSet = new Set(deleteBranches);
  const keep = snap.branches
    .map((b) => normalize(b.id))
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
  /** absolute path to the project's `.vetinari.local/`, where each issue's Copilot directory lives. */
  stateDir: string;
  /** absolute path to the project's orchestrator event log. */
  logFile: string;
  /** absolute path to the project's `changelog.d/` fragment directory. */
  fragmentsDir: string;
  /** absolute path to the project's `CHANGELOG.md`. */
  changelogPath: string;
}

/** Every `agent/<id>` head present, paired with whether it is fully merged into the base. */
function scanBranches(root: string, baseBranch: string, branchPrefix: string): TidyBranch[] {
  const listed = gitTryRead(["-C", root, "for-each-ref", "--format=%(refname:short)", `refs/heads/${branchPrefix}*`]);
  return listed.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((branch) => ({
      id: branch.slice(branchPrefix.length),
      // `merge-base --is-ancestor <branch> <base>` exits 0 iff every commit on the
      // branch is already in the base — the provable-reachability rule (ADR 0013).
      reachable: gitTryRead(["-C", root, "merge-base", "--is-ancestor", branch, baseBranch]).code === 0,
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
 * `changelog collect`. Returns the near-miss fragments the fold left in place.
 */
export function applyTidy(target: TidyTarget, plan: TidyPlan): FragmentNearMiss[] {
  let nearMisses: FragmentNearMiss[] = [];
  if (plan.fold.length) {
    ({ nearMisses } = foldFragments(
      {
        fragmentsDir: target.fragmentsDir,
        changelogPath: target.changelogPath,
        today: formatMilestoneDate(new Date()),
        title: "Collected changes",
      },
      plan.fold.map((id) => `${id}.md`),
    ));
  }

  purgeBranches(target, plan.deleteBranches);

  clearParkedIn(target.parkedDir, plan.clearParked);
  return nearMisses;
}

/** The git edge a branch/worktree true-drop acts in — the fields `purgeBranches` needs. */
export interface PurgeTarget {
  /** the project's main checkout (git runs with `-C root`). */
  root: string;
  /** the branch the unmerged-commit count is measured against. */
  baseBranch: string;
  /** agent branches are `${branchPrefix}${taskId}`. */
  branchPrefix: string;
  /** absolute path to the project's `.vetinari.local/`, where each issue's Copilot directory lives. */
  stateDir: string;
}

/** What dropping one agent branch destroys — disclosed before `--purge` acts. */
export interface BranchPurge {
  /** the task id whose branch this is. */
  id: string;
  /** the `${branchPrefix}${id}` branch name. */
  branch: string;
  /** commits on the branch not reachable from the base — the unmerged work being dropped. */
  unmergedCommits: number;
  /** the worktree path checked out on the branch, or absent when none is. */
  worktree?: string;
}

/**
 * Disclose, touching nothing, what purging each id's agent branch would destroy: the
 * branch, the count of its commits not reachable from `baseBranch` (the unmerged work),
 * and the worktree path checked out on it (if any). A branch that does not exist still
 * discloses cleanly (zero unmerged commits, no worktree) so a caller sees a no-op, not a
 * gap — the read-only preview `prune --purge --dry-run` prints as its safety net.
 */
export function describeBranchPurge(target: PurgeTarget, ids: string[]): BranchPurge[] {
  return ids.map((id) => {
    const branch = `${target.branchPrefix}${id}`;
    const r = gitTryRead(["-C", target.root, "rev-list", "--count", `${target.baseBranch}..${branch}`]);
    return {
      id,
      branch,
      unmergedCommits: r.code === 0 ? Number(r.stdout.trim()) : 0,
      worktree: worktreePathFor(target.root, branch),
    };
  });
}

/**
 * Delete each id's `${branchPrefix}${id}` branch and its worktree, then prune — the
 * true-drop `tidy` runs on provably-merged branches (`applyTidy`) and `prune --purge`
 * runs on the branches an operator deliberately drops unmerged. Each id's Copilot directory
 * (ADR 0024) goes too. A missing branch, worktree or directory is a clean no-op, never an error.
 */
export function purgeBranches(target: Pick<PurgeTarget, "root" | "branchPrefix" | "stateDir">, ids: string[]): void {
  for (const id of ids) {
    const branch = `${target.branchPrefix}${id}`;
    removeWorktreeFor(target.root, branch);
    gitTry(["-C", target.root, "branch", "-D", branch]);
    removeCopilotDir(target.stateDir, id);
  }
  if (ids.length) gitTry(["-C", target.root, "worktree", "prune"]);
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
    ...drops.map((d) => `  registry: drop duplicate pointer '${d.drop}' — projectRoot ${d.projectRoot} also held by '${d.kept}'`),
  ].join("\n");
}

/** The path of the worktree checked out on `branch`, or undefined when none is. */
function worktreePathFor(root: string, branch: string): string | undefined {
  const porcelain = gitTryRead(["-C", root, "worktree", "list", "--porcelain"]).stdout;
  // Blocks are separated by blank lines: `worktree <path>` … `branch refs/heads/<name>`.
  for (const block of porcelain.split("\n\n")) {
    const p = block.match(/^worktree (.+)$/m)?.[1];
    const b = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (p && b === branch) return p;
  }
  return undefined;
}

/** Remove a live worktree checked out on `branch`, so its branch ref can then be deleted. */
function removeWorktreeFor(root: string, branch: string): void {
  const path = worktreePathFor(root, branch);
  if (path) gitTry(["-C", root, "worktree", "remove", "--force", path]);
}
