import * as sandcastle from "@ai-hero/sandcastle";
import type {
  AgentProvider,
  ClaudeCodeOptions,
  CodexOptions,
  CopilotOptions,
  LoggingOption,
  OpenCodeOptions,
  PiOptions,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AGENT_ENV_VAR,
  parseAgentOverride,
  resolveAgentSelection,
  type AgentSelection,
  type ResolvedConfig,
} from "./config.ts";

/**
 * The token-usage snapshot the loop folds per iteration (a subset of sandcastle's
 * `IterationUsage`). Every field is optional here so a fake sandbox may omit the
 * ones a given test does not exercise.
 */
export interface SandboxUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** One agent iteration: its resumable session id and token usage — the fields the loop reads. */
export interface SandboxIteration {
  sessionId?: string;
  usage?: SandboxUsage;
}

/** The subset of a sandcastle run result the loop reads back after a turn. */
export interface SandboxRunResult {
  iterations: SandboxIteration[];
  completionSignal?: string;
  commits?: { sha: string }[];
  stdout?: string;
}

/** The subset of `sbx.run(...)` options the loop passes. */
export interface SandboxRunOptions {
  agent: AgentProvider;
  completionSignal: string[];
  idleTimeoutSeconds: number;
  logging: LoggingOption;
  maxIterations?: number;
  resumeSession?: string;
  prompt?: string;
  promptFile?: string;
  promptArgs?: Record<string, string>;
}

/**
 * The subset of sandcastle's `Sandbox` the loop and gate actually use, extracted so
 * `runLoop`'s `LoopDeps.makeSandbox` can hand back a fake (a scriptable `run`/`exec`)
 * in tests. The real `makeSandbox` return structurally satisfies this — it carries
 * the same `run`/`exec`/`branch`/`close` surface plus more.
 */
export interface Sandbox {
  run(opts: SandboxRunOptions): Promise<SandboxRunResult>;
  exec(cmd: string): Promise<{ stdout?: string; stderr?: string; exitCode: number }>;
  branch: string;
  close(): Promise<{ preservedWorktreePath?: string } | undefined>;
}

// The pinned sandcastle build's `CreateSandboxOptions` does not model `stateDir`
// yet; builds carrying ADR 0021 honor it and older builds ignore it at runtime, so
// we pass it for forward-compat. Teach the compiler about the optional field rather
// than casting the whole options object (which would drop all other type checks).
declare module "@ai-hero/sandcastle" {
  interface CreateSandboxOptions {
    /**
     * Host repo directory under which sandcastle writes its own gitignored
     * artifacts (worktrees/, .env, patches/, default logs/) instead of a stray
     * `.sandcastle/`. Honored by builds carrying ADR 0021; older builds ignore it.
     */
    readonly stateDir?: string;
  }
}

/**
 * One container per task, on its own branch and worktree.
 *
 * Re-creating with the same branch reuses the existing worktree, which is what
 * lets a parked task resume with its uncommitted work intact — and why git
 * refuses to run when something else already has that branch checked out
 * (a manual review worktree on an agent branch blocks its resume).
 */
export async function makeSandbox(cfg: ResolvedConfig, taskId: string) {
  const mounts = cfg.mounts ?? [];
  // Bind sources must pre-exist: docker creates a missing one as root-owned,
  // and the container's non-root agent user then cannot write it.
  for (const m of mounts) mkdirSync(m.hostPath, { recursive: true });

  const branch = `${cfg.branchPrefix}${taskId}`;
  // Preflight (design §3 step 1): git refuses a second worktree on a branch already
  // checked out, so name that path and refuse cleanly here — before any container starts —
  // rather than letting createSandbox surface a raw git error. sandcastle's own worktree
  // for a resumed branch lives under stateDir and is reused, so it is excluded.
  const foreign = foreignWorktreeFor(branch, cfg.stateDir);
  if (foreign)
    throw new Error(
      `${branch} is already checked out at ${foreign} — remove that worktree before running this issue (one run per issue).`,
    );

  cfg.log.log("sandbox", { taskId, branch, mounts: mounts.map((m) => m.hostPath) });

  return sandcastle.createSandbox(makeSandboxOptions(cfg, taskId));
}

/**
 * The `createSandbox` options for this run's container (design §3 step 2), split out so the
 * fork point and branch are checkable without a Docker daemon. A fresh `agent/<id>` is cut
 * from `cfg.baseBranch` — sandcastle ignores `baseBranch` when the branch already exists, so
 * a reused branch keeps its commits regardless of what HEAD is currently on.
 */
export function makeSandboxOptions(cfg: ResolvedConfig, taskId: string): sandcastle.CreateSandboxOptions {
  const mounts = cfg.mounts ?? [];
  return {
    branch: `${cfg.branchPrefix}${taskId}`,
    baseBranch: cfg.baseBranch,
    // Route sandcastle's own gitignored artifacts (worktrees/, .env, patches/,
    // default logs/) into the project's state dir instead of a stray
    // `.sandcastle/`, so all ephemeral state lives under one place (default
    // `.vetinari.local/`). Relative to the host repo (cwd), like the orchestrator's.
    stateDir: cfg.stateDir,
    sandbox: docker({ imageName: cfg.image, mounts }),
    hooks: cfg.setup?.length
      ? { sandbox: { onSandboxReady: cfg.setup.map((command) => ({ command, timeoutMs: cfg.setupTimeoutMs ?? 300_000 })) } }
      : undefined,
  };
}

/** True when `p` resolves to `root` or a path beneath it. */
const isUnder = (p: string, root: string): boolean => {
  const rp = resolve(p);
  return rp === root || rp.startsWith(root + sep);
};

/**
 * Scan `git worktree list --porcelain` output for a worktree holding `branch` that is NOT
 * under `stateRoot` — a foreign checkout (the host repo itself, or a manual review
 * worktree), the one case git refuses a second worktree for (design §3 step 1). sandcastle's
 * own worktrees live under `stateRoot` and are reused on resume, so they are excluded.
 * Returns the offending path, or undefined when the branch is free to check out. Pure — the
 * caller runs git and resolves `stateRoot`.
 */
export function parseForeignWorktree(porcelain: string, branch: string, stateRoot: string): string | undefined {
  const wanted = `branch refs/heads/${branch}`;
  const root = resolve(stateRoot);
  let path: string | undefined;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line === wanted && path && !isUnder(path, root)) return path;
  }
  return undefined;
}

/**
 * The path where `branch` is checked out in a foreign worktree, or undefined when it is free
 * (design §3 step 1). Runs git in `cwd` (the host repo); a git failure — e.g. not a repo —
 * yields undefined so `createSandbox` still surfaces the real error.
 */
export function foreignWorktreeFor(branch: string, stateDir: string, cwd: string = process.cwd()): string | undefined {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  } catch {
    return undefined;
  }
  return parseForeignWorktree(porcelain, branch, resolve(cwd, stateDir));
}

/**
 * Construct the sandcastle `AgentProvider` for this run (ADR 0016). The provider,
 * model and effort are resolved by `resolveAgentSelection` from the project default
 * (`cfg.agent`) with any CLI override read back from `VETINARI_AGENT` layered on top —
 * so a campaign/queue child `run` drives the same agent its parent was launched with,
 * not a silent claude. Then dispatch on the provider name to the matching resumable
 * factory, passing the (already-validated) effort in that provider's own vocabulary
 * (claude/codex `effort`, pi `--thinking`).
 */
/**
 * The resolved agent choice for this run — the project default (`cfg.agent`) with any
 * CLI override read back from `VETINARI_AGENT` layered on top. The loop reads `.resumable`
 * off this to decide whether to resume a session between turns or re-enter each turn fresh
 * (#212); `agentFor` reads it to build the provider.
 */
export const agentSelectionFor = (cfg: ResolvedConfig): AgentSelection =>
  resolveAgentSelection(cfg.agent, parseAgentOverride(process.env[AGENT_ENV_VAR]));

export const agentFor = (cfg: ResolvedConfig) => {
  const sel = agentSelectionFor(cfg);
  switch (sel.provider) {
    case "claude":
      return sandcastle.claudeCode(sel.model, { effort: sel.effort as ClaudeCodeOptions["effort"] });
    case "pi":
      return sandcastle.pi(sel.model, { thinking: sel.effort as PiOptions["thinking"] });
    case "codex":
      return sandcastle.codex(sel.model, { effort: sel.effort as CodexOptions["effort"] });
    case "copilot":
      return sandcastle.copilot(sel.model, { effort: sel.effort as CopilotOptions["effort"] });
    // Cursor's CLI exposes no effort dial, so `sel.effort` is absent — pass none.
    case "cursor":
      return sandcastle.cursor(sel.model);
    case "opencode":
      return sandcastle.opencode(sel.model, { variant: sel.effort as OpenCodeOptions["variant"] });
  }
};
