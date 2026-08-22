import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { FindingReporter } from "./findings.ts";
import type { FileSetOf } from "./fileset.ts";

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
   * The ids of a given id's OPEN blockers (its prerequisites still in flight).
   * Closed blockers must be filtered here at the edge — an already-merged
   * prerequisite does not gate. Used by `carve` (removes an issue and everything
   * transitively blocked by it) and `campaign-plan` (layers a selected set into
   * dependency-ordered waves). Wire it to your tracker — `githubBlockedBy(repo)`
   * ships as a ready GitHub implementation.
   */
  blockedBy?: (id: string) => string[] | Promise<string[]>;
  /**
   * Which files a ticket will touch, by basename, so `campaign-plan` can keep
   * co-wave tickets file-disjoint (a wave that shares a file collides as a merge
   * conflict at integration). `ticket` is the ticket's text; return
   * `{ files, confident }` where `files` are basenames and `confident: false`
   * means the file-set could not be pinned down (the planner then halts rather
   * than guess). A config seam beside `blockedBy`/`fetchTask` — `defaultFileSet()`
   * ships as a generic cites-from-body implementation you can use or wrap.
   */
  fileSet?: FileSetOf;
  /**
   * When set, a green run ends with a "harvest" turn asking the agent for any
   * defect it noticed but did not fix — context that would otherwise vanish with
   * the container — and this files each one somewhere durable.
   * `githubFindingReporter(repo, { labels })` ships as a GitHub implementation.
   * Absent, no harvest turn runs and no findings are collected.
   */
  reportFinding?: FindingReporter;
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
  /** Where logs and parked records live. Default ".sandcastle.local". */
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

/**
 * Config candidate locations, highest precedence first. The committed
 * `sandcastle/` locations are canonical; the rest resolve only as deprecated
 * fallbacks so a live setup keeps working for one minor after the layout split.
 */
const CANDIDATES: readonly { rel: string; deprecated: boolean }[] = [
  { rel: "sandcastle/config.mts", deprecated: false },
  { rel: "sandcastle/config.ts", deprecated: false },
  { rel: "sandcastle-tdd.config.mts", deprecated: true },
  { rel: "sandcastle-tdd.config.ts", deprecated: true },
  { rel: ".sandcastle/config.mts", deprecated: true },
];

/** The canonical location a deprecation warning should point a project at. */
export const CANONICAL_CONFIG = "sandcastle/config.mts";

export interface ResolvedConfigPath {
  /** Absolute path to the winning config candidate. */
  path: string;
  /**
   * The legacy candidate name this resolved from, when the winner is a
   * deprecated location. Undefined for the canonical `sandcastle/` locations.
   */
  deprecatedFrom?: string;
}

/**
 * Pure candidate resolution: pick the highest-precedence config that exists
 * under `baseDir`, reporting a legacy origin when the winner is deprecated.
 * Existence checks only — no module import or execution.
 */
export function resolveConfigPath(baseDir: string): ResolvedConfigPath | undefined {
  for (const { rel, deprecated } of CANDIDATES) {
    const path = resolve(baseDir, rel);
    if (existsSync(path)) return deprecated ? { path, deprecatedFrom: rel } : { path };
  }
  return undefined;
}

/** Load the consuming project's config from cwd (or an explicit path). */
export async function loadConfig(explicitPath?: string): Promise<ResolvedConfig> {
  let path = explicitPath;
  if (!path) {
    const resolved = resolveConfigPath(process.cwd());
    if (!resolved) {
      throw new Error(
        `No config found. Create ${CANONICAL_CONFIG} in the project root (or pass --config <path>). ` +
          `See the README for a template.`,
      );
    }
    path = resolved.path;
    if (resolved.deprecatedFrom) {
      console.warn(
        `[sctdd] ${resolved.deprecatedFrom} is a deprecated config location and will stop working in a future minor. ` +
          `Move it to ${CANONICAL_CONFIG} (or run \`sandcastle migrate\`).`,
      );
    }
  }
  const mod = await import(resolve(path));
  const c: SandcastleTddConfig = mod.default ?? mod.config;
  if (!c) throw new Error(`${path} has no default export`);
  for (const required of ["project", "image", "baseBranch", "gates", "fetchTask"] as const) {
    if (c[required] == null) throw new Error(`${path}: missing required field "${required}"`);
  }
  if (!c.gates.length) throw new Error(`${path}: "gates" is empty — the orchestrator would verify nothing`);

  const stateDir = c.stateDir ?? ".sandcastle.local";
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
