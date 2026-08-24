import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { FindingReporter } from "./findings.ts";
import type { FileSetOf } from "./fileset.ts";

/**
 * The five fixed message categories a piece of outbound communication carries,
 * used to route it. `question` is the only interactive one (it expects a reply).
 * Adding categories is out of scope.
 */
export type MessageCategory = "question" | "success" | "failure" | "progress" | "finding";

/**
 * A named Telegram connection a project routes categories to. `bot` names a bot
 * whose token is read by reference from `.vetinari.local/` — a destination
 * carries no secret. `thread` optionally targets a forum thread under the chat.
 */
export interface Destination {
  bot: string;
  chat: string;
  thread?: string;
}

/**
 * A project's routing rules. Each key is a bare `category` or a `category:event`,
 * plus a `*` wildcard default; each value names a destination (a key of the
 * config's `destinations`). `resolveDestination` reads this map.
 */
export type NotifyMap = Record<string, string>;

/**
 * Pure destination resolution for a message. An exact `category:event` entry wins
 * over a bare `category` entry, which wins over the `*` wildcard. Returns the
 * destination name, or `undefined` when the category is unmapped and there is no
 * wildcard — an explicit "no destination" the caller must handle, never a silent
 * drop.
 */
export function resolveDestination(notify: NotifyMap, category: MessageCategory, event?: string): string | undefined {
  if (event !== undefined) {
    const exact = notify[`${category}:${event}`];
    if (exact !== undefined) return exact;
  }
  const byCategory = notify[category];
  if (byCategory !== undefined) return byCategory;
  return notify["*"];
}

/**
 * The distinct destinations a `question` message could resolve to under a notify
 * map, across every possible event: every explicit `question`/`question:event`
 * target, plus the `*` wildcard when unlisted question events would fall to it
 * (i.e. there is no bare `question` entry to catch them). `question` is the only
 * interactive category — the gateway watches one place for the reply — so this
 * set must be a singleton; more than one is a fan-out the config load rejects.
 */
export function questionDestinations(notify: NotifyMap): Set<string> {
  const dests = new Set<string>();
  for (const [key, dest] of Object.entries(notify)) {
    if (key === "question" || key.startsWith("question:")) dests.add(dest);
  }
  if (notify["question"] === undefined && notify["*"] !== undefined) dests.add(notify["*"]);
  return dests;
}

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

export interface VetinariConfig {
  /** Name used in notifications, e.g. "jjforge". */
  project: string;
  /** Docker image carrying your toolchain AND the claude CLI. */
  image: string;
  /** Branch work is cut from, and what gate scoping diffs against. */
  baseBranch: string;
  /** Agent branches are `${branchPrefix}${taskId}`. Default "agent/". */
  branchPrefix?: string;
  /**
   * This project's weight in the host slot budget (ADR 0010): its cut of the
   * remainder when projects contend for the host's shared container ceiling.
   * Default 1; it only bites while more than one project is active, and only when
   * a host budget is set at all.
   */
  hostWeight?: number;
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
  /**
   * Named Telegram destinations this project routes categories to (name ->
   * `{bot, chat, thread?}`). A destination names a bot by reference — its token is
   * read from `.vetinari.local/`, never inlined here. The `notify` map's values
   * are keys of this map.
   */
  destinations?: Record<string, Destination>;
  /**
   * Routing rules: `category` or `category:event` -> destination name, plus a `*`
   * wildcard default. `resolveDestination` reads it; config load rejects a map that
   * would fan the interactive `question` category to more than one destination.
   */
  notify?: NotifyMap;
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
  /** Where logs and parked records live. Default ".vetinari.local". */
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
  Pick<VetinariConfig, "project" | "image" | "baseBranch" | "branchPrefix" | "hostWeight" | "gates" | "maxTurns" | "idleTimeoutSeconds" | "stateDir" | "fetchTask">
> &
  VetinariConfig & { promptFile: string; parkedDir: string; logFile: string };

export function defineConfig(c: VetinariConfig): VetinariConfig {
  return c;
}

/**
 * Config candidate locations, highest precedence first. The committed
 * `vetinari/` locations are canonical; the rest resolve only as deprecated
 * fallbacks so a live setup keeps working for one minor after the layout split.
 */
const CANDIDATES: readonly { rel: string; deprecated: boolean }[] = [
  { rel: "vetinari/config.mts", deprecated: false },
  { rel: "vetinari/config.ts", deprecated: false },
  { rel: ".sandcastle/config.mts", deprecated: true },
];

/** The canonical location a deprecation warning should point a project at. */
export const CANONICAL_CONFIG = "vetinari/config.mts";

export interface ResolvedConfigPath {
  /** Absolute path to the winning config candidate. */
  path: string;
  /**
   * The legacy candidate name this resolved from, when the winner is a
   * deprecated location. Undefined for the canonical `vetinari/` locations.
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
        `[vetinari] ${resolved.deprecatedFrom} is a deprecated config location and will stop working in a future minor. ` +
          `Move it to ${CANONICAL_CONFIG} (or run \`vetinari migrate\`).`,
      );
    }
  }
  const mod = await import(resolve(path));
  const c: VetinariConfig = mod.default ?? mod.config;
  if (!c) throw new Error(`${path} has no default export`);
  for (const required of ["project", "image", "baseBranch", "gates", "fetchTask"] as const) {
    if (c[required] == null) throw new Error(`${path}: missing required field "${required}"`);
  }
  if (!c.gates.length) throw new Error(`${path}: "gates" is empty — the orchestrator would verify nothing`);
  if (c.notify) {
    const qDests = questionDestinations(c.notify);
    if (qDests.size > 1) {
      throw new Error(
        `${path}: the notify map routes the interactive "question" category to more than one destination ` +
          `(${[...qDests].join(", ")}). question expects a reply, so the gateway watches a single destination for it — ` +
          `route "question" (and any "question:event") to exactly one place.`,
      );
    }
  }

  const stateDir = c.stateDir ?? ".vetinari.local";
  // hostEnv is applied to THIS process only; it is never handed to a sandbox.
  for (const [k, v] of Object.entries(c.hostEnv ?? {})) process.env[k] = v;

  return {
    branchPrefix: "agent/",
    hostWeight: 1,
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    ...c,
    stateDir,
    promptFile: c.promptFile ?? new URL("../prompts/tdd.md", import.meta.url).pathname,
    parkedDir: `${stateDir}/parked`,
    logFile: `${stateDir}/logs/orchestrator.jsonl`,
  } as ResolvedConfig;
}
