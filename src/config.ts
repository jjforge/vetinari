import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface GateSpec {
  /** Shell command run INSIDE the sandbox. Non-zero exit is red. */
  cmd: string;
  /**
   * Run this gate only when the branch's changed files match. Omitted means
   * always. Use it to skip a gate whose cold compile dominates a turn — the
   * scoping is logged per run, never silent.
   */
  when?: RegExp;
  label?: string;
}

export interface MountSpec {
  /** Host path, relative to the project root or absolute. */
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

export interface SandcastleTddConfig {
  /** Name used in notifications, e.g. "jjforge". */
  project: string;
  /** Docker image carrying your toolchain AND the claude CLI. */
  image: string;
  /** Branch work is cut from, and what gate scoping diffs against. */
  baseBranch: string;
  /** Agent branches are `${branchPrefix}${taskId}`. Default "agent/". */
  branchPrefix?: string;
  /**
   * Verification the ORCHESTRATOR runs after every COMPLETE signal. The agent
   * never self-certifies; only a zero exit here returns green.
   */
  gates: GateSpec[];
  /** Commands run once per sandbox, before the agent starts. */
  setup?: string[];
  setupTimeoutMs?: number;
  /**
   * Host dirs shared into every sandbox. Correct for caches that are
   * concurrency-safe (Go's module/build caches, a package registry). NEVER
   * share a build-output dir: parallel sandboxes then serialize on its lock,
   * which is the contention containers exist to avoid.
   */
  mounts?: MountSpec[];
  /** Fetch the task text for an id — an issue body, a spec file, anything. */
  fetchTask: (id: string) => string | Promise<string>;
  /**
   * The ids that BLOCK a given id (its prerequisites). Only needed by the
   * `carve` command, which removes an issue and everything transitively blocked
   * by it from a campaign. Wire it to your tracker — `githubBlockedBy(repo)`
   * ships as a ready GitHub implementation.
   */
  blockedBy?: (id: string) => string[] | Promise<string[]>;
  /** Override the bundled TDD prompt. Must keep the signal contract. */
  promptFile?: string;
  agent?: {
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
  /** Gate→resume cycles before parking with reason "budget". Default 6. */
  maxTurns?: number;
  /** Default 600. A stalled agent parks rather than dying unrecorded. */
  idleTimeoutSeconds?: number;
  /** Where logs and parked records live. Default ".sandcastle". */
  stateDir?: string;
  /**
   * Env for the ORCHESTRATOR PROCESS ONLY. Use this for anything that must not
   * reach the container — notably GIT_CONFIG_GLOBAL, which sandcastle needs
   * host-side for its safe.directory writes but which, injected into a
   * container, overrides the HOME that a project's own git tests rely on.
   */
  hostEnv?: Record<string, string>;
  /** Probe `baseline` runs to prove the image has the toolchain. */
  toolchainProbe?: string;
}

export type ResolvedConfig = Required<
  Pick<SandcastleTddConfig, "project" | "image" | "baseBranch" | "branchPrefix" | "gates" | "maxTurns" | "idleTimeoutSeconds" | "stateDir" | "fetchTask">
> &
  SandcastleTddConfig & { promptFile: string; parkedDir: string; logFile: string };

export function defineConfig(c: SandcastleTddConfig): SandcastleTddConfig {
  return c;
}

const CANDIDATES = ["sandcastle-tdd.config.mts", "sandcastle-tdd.config.ts", ".sandcastle/config.mts"];

/** Load the consuming project's config from cwd (or an explicit path). */
export async function loadConfig(explicitPath?: string): Promise<ResolvedConfig> {
  const path = explicitPath ?? CANDIDATES.find((c) => existsSync(resolve(c)));
  if (!path) {
    throw new Error(
      `No config found. Create one of ${CANDIDATES.join(", ")} in the project root, or pass --config <path>. See the README for a template.`,
    );
  }
  const mod = await import(resolve(path));
  const c: SandcastleTddConfig = mod.default ?? mod.config;
  if (!c) throw new Error(`${path} has no default export`);
  for (const required of ["project", "image", "baseBranch", "gates", "fetchTask"] as const) {
    if (c[required] == null) throw new Error(`${path}: missing required field "${required}"`);
  }
  if (!c.gates.length) throw new Error(`${path}: "gates" is empty — the orchestrator would verify nothing`);

  const stateDir = c.stateDir ?? ".sandcastle";
  // hostEnv is applied to THIS process only; it is never handed to a sandbox.
  for (const [k, v] of Object.entries(c.hostEnv ?? {})) process.env[k] = v;

  return {
    branchPrefix: "agent/",
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    ...c,
    stateDir,
    promptFile: c.promptFile ?? new URL("../prompts/tdd.md", import.meta.url).pathname,
    parkedDir: `${stateDir}/parked`,
    logFile: `${stateDir}/logs/orchestrator.jsonl`,
  } as ResolvedConfig;
}
