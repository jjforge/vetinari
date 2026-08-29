import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from "./sandbox.ts";

/**
 * The local (no-container) `Sandbox` adapter (ADR 0018) — the second adapter behind
 * the `Sandbox` seam that turns it into a real one. Where the production `makeSandbox`
 * spins a docker container with a per-branch worktree, this runs the *real* gates and
 * *real* git against a temp-dir worktree, and delegates the one thing that cannot be
 * real without an LLM — the agent turn — to a test-supplied agent-script.
 *
 * It exists to span the seams the unit tests each cut: driven through `runLoop` /
 * `campaign` with only the container boundary faked, everything downstream of the
 * agent turn (the gate and its exit codes, the merge/quarantine path, the merged-base
 * gate, the on-disk event log) is exercised, not stubbed.
 */

/** Run git in `dir`, returning trimmed stdout (throws its stderr on a non-zero exit). */
const gitIn = (dir: string, args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/**
 * The real checkout handed to an agent-script for one turn: the worktree it operates
 * on, the branch it commits to, and convenience helpers to write files and commit. A
 * script produces the turn's real commits (the sandbox detects them by diffing HEAD)
 * and returns a completion signal — the same contract the loop reads back off a real
 * `run`.
 */
export interface LocalAgentTurn {
  /** the task id (the `agent/<id>` branch's suffix). */
  taskId: string;
  /** the `agent/<taskId>` branch this turn commits to. */
  branch: string;
  /** absolute path to this task's worktree, checked out on `branch`. */
  cwd: string;
  /** this turn's run options (resumeSession / prompt / promptArgs), so a script can vary by turn. */
  opts: SandboxRunOptions;
  /** run a git command inside the worktree, returning trimmed stdout. */
  git(args: string[]): string;
  /** write a file (path relative to the worktree), creating parent dirs. */
  write(relPath: string, contents: string): void;
  /** stage everything and commit on the branch, returning the new sha. */
  commit(message: string): string;
}

/** What one agent-script turn returns: the completion signal, and optional stdout the loop parses. */
export interface LocalAgentResult {
  /** the completion signal this turn ends on — `DONE` / `BLOCKED` (loop.ts). */
  signal: string;
  /** optional stdout carrying the `<turn-summary>` / `<question>` tags the loop reads. */
  stdout?: string;
}

/** The agent turn, faked: given the real checkout, produce this turn's commits and a signal. */
export type LocalAgentScript = (turn: LocalAgentTurn) => LocalAgentResult | Promise<LocalAgentResult>;

/**
 * A no-container `Sandbox` over a temp-dir worktree cut from `cfg.baseBranch` (ADR 0018).
 * `run` delegates the turn to `script`; `exec` runs the command for real inside the
 * worktree (so `git diff --name-only` and each gate command execute against real state);
 * `close` removes the worktree, leaving the branch (and its commits) for integration.
 *
 * The host repo is the process cwd — the same place `integrateGreens` /
 * `collectWaveChangelog` / `commitsAhead` operate — so the whole pipeline sees one repo.
 */
export async function makeLocalSandbox(
  cfg: ResolvedConfig,
  taskId: string,
  script: LocalAgentScript,
): Promise<Sandbox> {
  const repoRoot = process.cwd();
  const branch = `${cfg.branchPrefix}${taskId}`;
  const worktreeDir = resolve(repoRoot, cfg.stateDir, "worktrees", taskId);
  mkdirSync(dirname(worktreeDir), { recursive: true });
  // A fresh worktree on a new branch cut from the base — the prod sandbox's one
  // container per task, on its own branch and worktree.
  gitIn(repoRoot, ["worktree", "add", "-b", branch, worktreeDir, cfg.baseBranch]);

  let turn = -1;
  return {
    branch,
    async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
      turn++;
      const before = gitIn(worktreeDir, ["rev-parse", "HEAD"]);
      const result = await script({
        taskId,
        branch,
        cwd: worktreeDir,
        opts,
        git: (args) => gitIn(worktreeDir, args),
        write: (relPath, contents) => {
          const abs = join(worktreeDir, relPath);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, contents);
        },
        commit: (message) => {
          gitIn(worktreeDir, ["add", "-A"]);
          gitIn(worktreeDir, ["commit", "-qm", message]);
          return gitIn(worktreeDir, ["rev-parse", "HEAD"]);
        },
      });
      const after = gitIn(worktreeDir, ["rev-parse", "HEAD"]);
      // The commits this turn landed, oldest-first — what the loop logs and gates on.
      const commits =
        after === before
          ? []
          : gitIn(worktreeDir, ["rev-list", "--reverse", `${before}..HEAD`])
              .split("\n")
              .filter(Boolean)
              .map((sha) => ({ sha }));
      return {
        iterations: [{ sessionId: `local-${taskId}-${turn}` }],
        completionSignal: result.signal,
        commits,
        stdout: result.stdout ?? "",
      };
    },
    async exec(cmd: string) {
      // Run the command for real inside the worktree — a non-zero exit is RETURNED as
      // the exit code, never thrown, exactly as the prod sandbox's `exec` does (so a
      // red gate reads red, not as a pass).
      try {
        const stdout = execSync(cmd, { cwd: worktreeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (e: any) {
        return {
          stdout: String(e.stdout ?? ""),
          stderr: String(e.stderr ?? e.message ?? ""),
          exitCode: typeof e.status === "number" ? e.status : 1,
        };
      }
    },
    async close() {
      // Drop the worktree so the branch is no longer checked out (integration can then
      // merge and GC it); the branch and its commits stay in the shared repo.
      gitIn(repoRoot, ["worktree", "remove", "--force", worktreeDir]);
      return undefined;
    },
  };
}
