import * as sandcastle from "@ai-hero/sandcastle";
import { Refusal } from "./refusal.ts";
import { gitRead } from "./git-read.ts";
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
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import {
  AGENT_ENV_VAR,
  parseAgentOverride,
  resolveAgentSelection,
  type AgentSelection,
  type MountSpec,
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
 *
 * `agentRun` marks the container an issue's agent runs in, as opposed to a gate or baseline
 * sandbox: only an agent run of a copilot provider mounts that issue's Copilot directory (ADR 0024).
 */
export async function makeSandbox(cfg: ResolvedConfig, taskId: string, { agentRun = false }: { agentRun?: boolean } = {}) {
  const agentTaskId = agentRun ? taskId : undefined;
  ensureMountSources(cfg, process.cwd(), agentTaskId);

  const branch = `${cfg.branchPrefix}${taskId}`;
  // Preflight (design §3 step 1): git refuses a second worktree on a branch already
  // checked out, so name that path and refuse cleanly here — before any container starts —
  // rather than letting createSandbox surface a raw git error. sandcastle's own worktree
  // for a resumed branch lives under stateDir and is reused, so it is excluded.
  const foreign = foreignWorktreeFor(branch, cfg.stateDir);
  if (foreign)
    throw new Refusal(
      `${branch} is already checked out at ${foreign} — remove that worktree before running this issue (one run per issue).`,
    );

  cfg.log.log("sandbox", { taskId, branch, mounts: sandboxMounts(cfg, process.cwd(), agentTaskId).map((m) => m.hostPath) });

  return sandcastle.createSandbox(makeSandboxOptions(cfg, taskId, agentTaskId));
}

/**
 * The `createSandbox` options for this run's container (design §3 step 2), split out so the
 * fork point and branch are checkable without a Docker daemon. A fresh `agent/<id>` is cut
 * from `cfg.baseBranch` — sandcastle ignores `baseBranch` when the branch already exists, so
 * a reused branch keeps its commits regardless of what HEAD is currently on.
 */
export function makeSandboxOptions(cfg: ResolvedConfig, taskId: string, agentTaskId?: string): sandcastle.CreateSandboxOptions {
  return {
    branch: `${cfg.branchPrefix}${taskId}`,
    baseBranch: cfg.baseBranch,
    // Route sandcastle's own gitignored artifacts (worktrees/, .env, patches/,
    // default logs/) into the project's state dir instead of a stray
    // `.sandcastle/`, so all ephemeral state lives under one place (default
    // `.vetinari.local/`). Relative to the host repo (cwd), like the orchestrator's.
    stateDir: cfg.stateDir,
    sandbox: sandboxProvider(cfg, sandboxMounts(cfg, process.cwd(), agentTaskId)),
    hooks: cfg.setup?.length
      ? { sandbox: { onSandboxReady: cfg.setup.map((command) => ({ command, timeoutMs: cfg.setupTimeoutMs ?? 300_000 })) } }
      : undefined,
  };
}

/** The configured `sandbox` factory's provider, or by default Docker on `cfg.image`. */
function sandboxProvider(cfg: ResolvedConfig, mounts: MountSpec[]): sandcastle.SandboxProvider {
  if (cfg.sandbox) return cfg.sandbox(cfg, { mounts });
  // loadConfig refuses a missing image without a factory; never fall through to sandcastle's default name.
  if (!cfg.image) throw new Refusal(`no "image" configured — the Docker sandbox needs one (or set "sandbox")`);
  return docker({ imageName: cfg.image, mounts });
}

/**
 * The bind mounts for this run's container: `cfg.mounts`, then the host worktrees dir
 * (`<stateDir>/worktrees`, where sandcastle creates every agent's worktree) read-only at its
 * own host path. sandcastle mounts the host `.git` read-write, and each `.git/worktrees/<name>/gitdir`
 * records a host path — without this mount none of them exist in the container, so a
 * `git worktree prune` there deletes every sibling's entry. Read-only keeps siblings untouchable.
 * Worktrees outside `<stateDir>/worktrees` are not mounted, so only `git worktree lock` protects them.
 *
 * `agentTaskId` names the issue whose agent the container runs (absent for a gate or baseline
 * sandbox); with a copilot provider its Copilot directory is mounted read-write as `~/.copilot`.
 */
export function sandboxMounts(cfg: ResolvedConfig, cwd: string = process.cwd(), agentTaskId?: string): MountSpec[] {
  const worktrees = resolve(cwd, cfg.stateDir, "worktrees");
  const copilot =
    agentTaskId !== undefined && agentSelectionFor(cfg).provider === "copilot"
      ? [{ hostPath: copilotDirFor(cfg.stateDir, agentTaskId, cwd), sandboxPath: `${SANDBOX_HOME}/.copilot` }]
      : [];
  return [...(cfg.mounts ?? []), { hostPath: worktrees, sandboxPath: worktrees, readonly: true }, ...copilot];
}

/**
 * Create every bind source in `sandboxMounts` that is missing. They must pre-exist: docker
 * creates a missing one as root-owned, which the container's non-root agent user then cannot
 * write — and `docker()` itself throws on a missing source before sandcastle's `create` would
 * make the worktrees dir on a first run.
 */
export function ensureMountSources(cfg: ResolvedConfig, cwd: string = process.cwd(), agentTaskId?: string): void {
  for (const m of sandboxMounts(cfg, cwd, agentTaskId)) mkdirSync(resolve(cwd, m.hostPath), { recursive: true });
}

/** The image's home dir — where sandcastle runs the agent and resolves a `~` in a `sandboxPath`. */
const SANDBOX_HOME = "/home/agent";

/**
 * The ancestors of a mount's `sandboxPath` strictly between `/home/agent` and the mount, nearest
 * the home first (`~` expanded as sandcastle does). Empty for a mount outside `/home/agent`: only
 * the agent's home must be agent-writable, and the worktrees mount's parents are root by design.
 */
export function mountParentPaths(sandboxPath: string): string[] {
  const p = posix.normalize(sandboxPath === "~" || sandboxPath.startsWith("~/") ? SANDBOX_HOME + sandboxPath.slice(1) : sandboxPath);
  if (!p.startsWith(SANDBOX_HOME + "/")) return [];
  const parents: string[] = [];
  for (let dir = posix.dirname(p); dir !== SANDBOX_HOME; dir = posix.dirname(dir)) parents.unshift(dir);
  return parents;
}

/** A mount whose parent the agent cannot write beside it — missing from the image, or not agent-owned there. */
export interface MountParentProblem {
  mount: string;
  parent: string;
}

/**
 * Every parent of a `/home/agent` mount that is missing from the image (absent from `owners`, the
 * uid owning each parent that exists) or not owned by `uid` (#512). Docker creates a missing parent
 * as root, so the agent then cannot write beside the mount — `go` cannot write `~/go/pkg/sumdb`
 * beside a mounted `~/go/pkg/mod`. `uid` is the host uid sandcastle runs the container as.
 */
export function mountParentProblems(mounts: MountSpec[], owners: Map<string, number>, uid: number): MountParentProblem[] {
  return mounts.flatMap((m) =>
    mountParentPaths(m.sandboxPath)
      .filter((parent) => owners.get(parent) !== uid)
      .map((parent) => ({ mount: m.sandboxPath, parent })),
  );
}

/** `stat -c '%u %n'` stdout → each listed path's owning uid. A path stat could not find is simply absent. */
export function parseStatOwners(stdout: string): Map<string, number> {
  const owners = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const m = /^(\d+) (.+)$/.exec(line);
    if (m) owners.set(m[2], Number(m[1]));
  }
  return owners;
}

/**
 * Look inside `image` for who owns each of `paths` — image metadata says nothing about its
 * filesystem — with one short-lived `stat` container (#512). `--entrypoint` because the shipped
 * Dockerfiles' ENTRYPOINT is `sleep infinity`. A missing path exits `stat` non-zero, so stdout is
 * read regardless; only docker's own failures (125 daemon/image, 126/127 no `stat`), a failed
 * spawn or a probe killed at `timeoutMs` (a hung daemon) yield undefined, so the caller proceeds
 * rather than refusing on a probe it could not run. `--pull never`: an image missing locally is a
 * 125, never a registry pull (or a same-named public image probed in its place).
 */
export function readMountParentOwners(
  image: string,
  paths: string[],
  docker = "docker",
  timeoutMs = 30_000,
): Map<string, number> | undefined {
  const r = spawnSync(docker, ["run", "--rm", "--pull", "never", "--entrypoint", "stat", image, "-c", "%u %n", ...paths], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    // A hard cap: SIGTERM only asks, and spawnSync waits for the child to exit.
    killSignal: "SIGKILL",
  });
  if (r.error || r.status === null || [125, 126, 127].includes(r.status)) return undefined;
  return parseStatOwners(r.stdout);
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
    porcelain = gitRead(["worktree", "list", "--porcelain"], { cwd });
  } catch {
    return undefined;
  }
  return parseForeignWorktree(porcelain, branch, resolve(cwd, stateDir));
}

/**
 * The resolved agent choice for this run — the project default (`cfg.agent`) with any
 * CLI override read back from `VETINARI_AGENT` layered on top. The loop reads `.resumable`
 * off this to decide whether to resume a session between turns or re-enter each turn fresh
 * (#212); `agentFor` reads it to build the provider.
 */
export const agentSelectionFor = (cfg: ResolvedConfig): AgentSelection =>
  resolveAgentSelection(cfg.agent, parseAgentOverride(process.env[AGENT_ENV_VAR]));

/**
 * A sandcastle `AgentProvider` that may also know the session id of the turn it last built —
 * Copilot does, since vetinari chooses it (`--session-id`). The loop reads it when an idle
 * timeout cuts a fresh turn off, as sandcastle's idle error carries no session id.
 */
export type TurnSessionAgent = AgentProvider & { turnSessionId?: () => string | undefined };

/**
 * Construct the sandcastle `AgentProvider` for this run (ADR 0016). The provider,
 * model and effort are resolved by `resolveAgentSelection` from the project default
 * (`cfg.agent`) with any CLI override read back from `VETINARI_AGENT` layered on top —
 * so a campaign/queue child `run` drives the same agent its parent was launched with,
 * not a silent claude. Then dispatch on the provider name to the matching resumable
 * factory, passing the (already-validated) effort in that provider's own vocabulary
 * (claude/codex `effort`, pi `--thinking`). `taskId` names the issue whose Copilot
 * directory a copilot provider resumes from (ADR 0024); the other providers ignore it.
 */
export const agentFor = (cfg: ResolvedConfig, taskId: string): TurnSessionAgent => {
  const sel = agentSelectionFor(cfg);
  switch (sel.provider) {
    case "claude":
      return sandcastle.claudeCode(sel.model, { effort: sel.effort as ClaudeCodeOptions["effort"] });
    case "pi":
      return sandcastle.pi(sel.model, { thinking: sel.effort as PiOptions["thinking"] });
    case "codex":
      return sandcastle.codex(sel.model, { effort: sel.effort as CodexOptions["effort"] });
    case "copilot":
      return resumableCopilot(
        sandcastle.copilot(sel.model, { effort: sel.effort as CopilotOptions["effort"] }),
        copilotDirFor(cfg.stateDir, taskId),
      );
    // Cursor's CLI exposes no effort dial, so `sel.effort` is absent — pass none.
    case "cursor":
      return sandcastle.cursor(sel.model);
    case "opencode":
      return sandcastle.opencode(sel.model, { variant: sel.effort as OpenCodeOptions["variant"] });
  }
};

/**
 * The issue's Copilot directory on the host — `.vetinari.local/copilot/<task-id>/` by default —
 * mounted as the agent container's `~/.copilot` (ADR 0024). Resolved against `cwd` as
 * `sandboxMounts` does, since the config's `stateDir` is relative by default.
 */
export const copilotDirFor = (stateDir: string, taskId: string, cwd: string = process.cwd()): string =>
  resolve(cwd, stateDir, "copilot", taskId);

/** Remove the issue's Copilot directory — once its branch is dropped (ADR 0024). A missing one is fine. */
export const removeCopilotDir = (stateDir: string, taskId: string): void =>
  rmSync(copilotDirFor(stateDir, taskId), { recursive: true, force: true });

/** Single-quote `s` for a POSIX shell, as sandcastle quotes its own command arguments. */
const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/**
 * sandcastle's `copilot()` made resumable (ADR 0024). A session is a whole directory tree under
 * `~/.copilot`, and that is the issue's Copilot directory mounted read-write, so the session
 * storage only looks there and transfers nothing. A fresh turn names its session with a fresh
 * `--session-id` uuid (create-or-resume, so never a reused one); a later turn `--resume`s it.
 * Copilot only reports its session id in its final `result` event, so the turn's id is also
 * announced on its first stream line: a turn cut off before that event still has a resumable id.
 */
const resumableCopilot = (base: AgentProvider, copilotDir: string): TurnSessionAgent => {
  const sessionDir = (id: string) => join(copilotDir, "session-state", id);
  // The id of the turn last built, kept for the whole turn (`unannounced` clears on the first
  // stream line): what an idle-stalled turn parks with, since sandcastle's idle error carries none.
  let turnId: string | undefined;
  let unannounced: string | undefined;
  return {
    ...base,
    captureSessions: true,
    sessionStorage: {
      captureToHost: async () => {},
      resumeIntoSandbox: async () => {},
      readHostSession: async () => undefined,
      existsOnHost: async (_cwd, id) => existsSync(sessionDir(id)),
      hostSessionFilePath: (_cwd, id) => sessionDir(id),
      findByIdOnHost: async (id) => ({
        path: existsSync(sessionDir(id)) ? sessionDir(id) : undefined,
        searchedRoot: join(copilotDir, "session-state"),
      }),
    },
    buildPrintCommand(opts) {
      const cmd = base.buildPrintCommand(opts);
      unannounced = turnId = opts.resumeSession ?? randomUUID();
      const flag = opts.resumeSession ? "--resume" : "--session-id";
      return { ...cmd, command: `${cmd.command} ${flag} ${shellQuote(unannounced)}` };
    },
    parseStreamLine(line) {
      const events = base.parseStreamLine(line);
      if (unannounced === undefined) return events;
      const sessionId = unannounced;
      unannounced = undefined;
      return [{ type: "session_id", sessionId }, ...events];
    },
    turnSessionId: () => turnId,
  };
};
