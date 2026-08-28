import * as sandcastle from "@ai-hero/sandcastle";
import type {
  AgentProvider,
  ClaudeCodeOptions,
  CodexOptions,
  LoggingOption,
  PiOptions,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { mkdirSync } from "node:fs";
import {
  AGENT_ENV_VAR,
  parseAgentOverride,
  resolveAgentSelection,
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
  cfg.log.log("sandbox", { taskId, branch, mounts: mounts.map((m) => m.hostPath) });

  return sandcastle.createSandbox({
    branch,
    // Route sandcastle's own gitignored artifacts (worktrees/, .env, patches/,
    // default logs/) into the project's state dir instead of a stray
    // `.sandcastle/`, so all ephemeral state lives under one place (default
    // `.vetinari.local/`). Relative to the host repo (cwd), like the orchestrator's.
    stateDir: cfg.stateDir,
    sandbox: docker({ imageName: cfg.image, mounts }),
    hooks: cfg.setup?.length
      ? { sandbox: { onSandboxReady: cfg.setup.map((command) => ({ command, timeoutMs: cfg.setupTimeoutMs ?? 300_000 })) } }
      : undefined,
  });
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
export const agentFor = (cfg: ResolvedConfig) => {
  const sel = resolveAgentSelection(cfg.agent, parseAgentOverride(process.env[AGENT_ENV_VAR]));
  switch (sel.provider) {
    case "claude":
      return sandcastle.claudeCode(sel.model, { effort: sel.effort as ClaudeCodeOptions["effort"] });
    case "pi":
      return sandcastle.pi(sel.model, { thinking: sel.effort as PiOptions["thinking"] });
    case "codex":
      return sandcastle.codex(sel.model, { effort: sel.effort as CodexOptions["effort"] });
  }
};
