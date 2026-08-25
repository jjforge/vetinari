import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { mkdirSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";

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
  log("sandbox", { taskId, branch, mounts: mounts.map((m) => m.hostPath) });

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

export const agentFor = (cfg: ResolvedConfig) =>
  sandcastle.claudeCode(cfg.agent?.model ?? "claude-opus-4-8", { effort: cfg.agent?.effort ?? "high" });
