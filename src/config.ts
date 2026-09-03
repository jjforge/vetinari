import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { FindingReporter } from "./findings.ts";
import type { FileSetOf } from "./fileset.ts";
import { loggerForRun, type Logger } from "./log.ts";

/**
 * The four fixed categories a piece of outbound communication carries, used to
 * route it (design §2.6). A question is never an outbound record — it is a parked
 * record the gateway announces under the `question` routing key (§10), which is
 * why `question` is a `notify` key but not a category here. Adding categories is
 * out of scope.
 */
export type MessageCategory =
  "success" | "failure" | "progress" | "finding";

/**
 * A named Telegram target a project routes categories to. One bot per project
 * (design §10) — its token is read by reference from `.vetinari.local/host.env`,
 * so a destination names no bot and carries no secret; it only picks *where* on
 * that bot a message lands: `chat`, and optionally a forum `thread` under it.
 */
export interface Destination {
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
export function resolveDestination(
  notify: NotifyMap,
  category: MessageCategory,
  event?: string,
): string | undefined {
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
 * (i.e. there is no bare `question` entry to catch them). `question` is the
 * interactive routing key — the gateway watches one place for the reply and the
 * park announcement goes there (§10) — so this set must be a singleton; more than
 * one is a fan-out the config load rejects.
 */
export function questionDestinations(notify: NotifyMap): Set<string> {
  const dests = new Set<string>();
  for (const [key, dest] of Object.entries(notify)) {
    if (key === "question" || key.startsWith("question:")) dests.add(dest);
  }
  if (notify["question"] === undefined && notify["*"] !== undefined)
    dests.add(notify["*"]);
  return dests;
}

/**
 * A project's declared cut of the host container ceiling when projects contend
 * (ADR 0011): a named tier, not a raw number, so nobody has to reason about why a
 * given container count is running. `medium` is the default.
 */
export type ContainerShare = "high" | "medium" | "low";

/**
 * The internal fair-share weight each `containerShare` tier maps to — the ratio
 * roughly 7:2:1 (tunable here). Pure; feeds the existing `fairShare` computation
 * unchanged, so the tier is the only surface a project sees. `high` takes a larger
 * cut of the remainder, never all of it (the floor-of-one, no-starvation rule holds).
 */
export function containerShareWeight(share: ContainerShare): number {
  return share === "high" ? 7 : share === "medium" ? 2 : 1;
}

/**
 * The agent providers vetinari can drive (ADR 0016). The resumable ones (Claude
 * Code, pi, Codex) drive the loop by resuming a session each turn; the
 * non-resumable ones (copilot, cursor, opencode) carry no durable session, so the
 * loop drives them by re-entering each turn as a fresh run (ADR 0016 / #212).
 */
export type AgentProviderName = "claude" | "pi" | "codex" | "copilot" | "cursor" | "opencode";

/**
 * A project's default agent (ADR 0016). A single object, not per-provider blocks:
 * `provider` selects which resumable agent runs (omitted → claude), and
 * `model`/`effort` are passed through in that provider's OWN vocabulary — each has
 * a different effort enum, validated per-provider. Omitted `model`/`effort` fall to
 * that provider's defaults (a per-provider default model; effort `high`). A
 * `--agent`/`--model`/`--effort` CLI override on run/campaign wins over this.
 */
export interface AgentConfig {
  provider?: AgentProviderName;
  model?: string;
  effort?: string;
}

/**
 * Per-provider facts `agentFor` and the preflight read: the default model, the effort
 * vocabulary to validate against (empty = the provider exposes no effort dial, so an
 * effort passed to it is rejected rather than silently ignored), and the `.env`
 * credential keys (any one present satisfies the preflight).
 */
export const AGENT_PROVIDERS: Record<
  AgentProviderName,
  { defaultModel: string; efforts: readonly string[]; credentialKeys: readonly string[] }
> = {
  // claude: today's behavior, unchanged — opus by default, Claude's low..max effort scale.
  claude: {
    defaultModel: "claude-opus-4-8",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    credentialKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  },
  // pi drives Anthropic models; its effort maps to the CLI's --thinking (off..xhigh).
  pi: {
    defaultModel: "claude-sonnet-4-6",
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
    credentialKeys: ["ANTHROPIC_API_KEY"],
  },
  // codex → OpenAI; low..xhigh effort.
  codex: {
    defaultModel: "gpt-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    credentialKeys: ["OPENAI_API_KEY"],
  },
  // copilot → GitHub Copilot CLI; low..high effort. Experimental — non-resumable, driven by fresh re-runs (§12).
  copilot: {
    defaultModel: "claude-sonnet-4.5",
    efforts: ["low", "medium", "high"],
    credentialKeys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  },
  // cursor → Cursor CLI; no effort dial (empty). Experimental — non-resumable (§12).
  cursor: {
    defaultModel: "composer-2",
    efforts: [],
    credentialKeys: ["CURSOR_API_KEY"],
  },
  // opencode → OpenCode; effort maps to its `--variant` (minimal..max). Experimental — non-resumable (§12).
  opencode: {
    defaultModel: "opencode/big-pickle",
    efforts: ["minimal", "low", "high", "max"],
    credentialKeys: ["OPENCODE_API_KEY"],
  },
};

/** The provider a run defaults to when neither the config nor the CLI names one. */
export const DEFAULT_PROVIDER: AgentProviderName = "claude";
/** The effort a run defaults to when neither the config nor the CLI names one. */
export const DEFAULT_EFFORT = "high";

/**
 * The non-resumable sandcastle providers — the single source of truth for the
 * `resumable` flag. They carry no durable session, so the loop drives them by
 * re-entering each turn as a fresh run rather than resuming a session (#212).
 */
const NON_RESUMABLE_PROVIDERS: readonly AgentProviderName[] = ["copilot", "cursor", "opencode"];
const SUPPORTED_LIST = "claude, pi, codex, copilot, cursor, opencode";

/** Whether the loop can resume this provider's session between turns, or must re-enter each turn fresh. */
export const isResumableProvider = (provider: AgentProviderName): boolean =>
  !NON_RESUMABLE_PROVIDERS.includes(provider);

/**
 * The one line the non-resumable park→answer gap turns on (design §3, §12 / #212).
 * The experimental providers (copilot/cursor/opencode) keep no session across a park, so
 * an answer can only reach a fresh run through the issue text — which needs `postComment`.
 * Preflight prints it as a warning when the selected provider is non-resumable and
 * `postComment` is unset; `answer` fails fast with the SAME line rather than silently
 * re-running the whole task from scratch. Provider-only so both sites read identically.
 */
export const nonResumableAnswerWarning = (provider: AgentProviderName): string =>
  `agent provider "${provider}" is experimental and non-resumable: it keeps no session across a park, ` +
  `so a parked question can only be answered by posting the reply as an issue comment and re-entering a fresh run — ` +
  `configure \`postComment\` (e.g. githubIssueComment(repo)) or a park on ${provider} cannot be answered.`;

/**
 * The fully-resolved agent choice for one invocation, ready to hand to `agentFor`'s
 * dispatch. `effort` is absent for a provider with no effort dial (cursor). `resumable`
 * is the single fact the loop branches its per-turn re-entry on (#212).
 */
export interface AgentSelection {
  provider: AgentProviderName;
  model: string;
  effort?: string;
  resumable: boolean;
}

/**
 * Resolve the agent for an invocation (ADR 0016): a CLI `override` wins over the
 * project's `base` (`cfg.agent`) wins over per-provider defaults. `model`/`effort`
 * are only inherited from `base` when the effective provider matches the base's —
 * a claude model or a claude-only effort must not leak onto a `--agent codex` run —
 * otherwise the selected provider's defaults apply. The resolved effort is validated
 * against that provider's own vocabulary and fails fast (naming the valid set) rather
 * than silently downgrading. A provider with no effort dial rejects an effort passed
 * to it. An unknown provider is rejected here too.
 */
export function resolveAgentSelection(
  base: AgentConfig | undefined,
  override: { provider?: string; model?: string; effort?: string } = {},
): AgentSelection {
  const providerRaw = override.provider ?? base?.provider ?? DEFAULT_PROVIDER;
  if (!(providerRaw in AGENT_PROVIDERS))
    throw new Error(`unknown agent provider "${providerRaw}". Supported: ${SUPPORTED_LIST}.`);
  const provider = providerRaw as AgentProviderName;
  const spec = AGENT_PROVIDERS[provider];

  // The base's model/effort belong to the base's provider; only inherit them when the
  // effective provider is unchanged, else fall to the selected provider's defaults.
  const inheritsBase = provider === (base?.provider ?? DEFAULT_PROVIDER);
  const model = override.model ?? (inheritsBase ? base?.model : undefined) ?? spec.defaultModel;
  const requestedEffort = override.effort ?? (inheritsBase ? base?.effort : undefined);

  // A provider with no effort dial (cursor) carries no effort — and rejects one asked for
  // explicitly rather than silently dropping it. Otherwise the effort defaults and is validated.
  const supportsEffort = spec.efforts.length > 0;
  if (!supportsEffort && requestedEffort !== undefined)
    throw new Error(`agent provider "${provider}" takes no effort setting (its CLI exposes no reasoning-effort dial).`);
  const effort = supportsEffort ? (requestedEffort ?? DEFAULT_EFFORT) : undefined;
  if (effort !== undefined && !spec.efforts.includes(effort))
    throw new Error(
      `agent effort "${effort}" is not valid for provider "${provider}". Valid: ${spec.efforts.join(", ")}.`,
    );

  return { provider, model, effort, resumable: isResumableProvider(provider) };
}

/**
 * The env var a `run`/`campaign` invocation stamps its CLI agent override onto, so
 * campaign/queue CHILD `run`s (spawned via `childSpawnEnv`) drive the SAME agent as
 * the parent instead of silently falling back to the config default (ADR 0016).
 * `agentFor` reads it back and merges it over `cfg.agent`.
 */
export const AGENT_ENV_VAR = "VETINARI_AGENT";

/**
 * Pull the `--agent <name>` / `--model <m>` / `--effort <e>` override out of a
 * mode's args (both `--flag value` and `--flag=value` forms), returning the parsed
 * override and the remaining args in order. Only these three flags are consumed — a
 * mode's own flags and positionals pass through untouched, so run/campaign strip the
 * agent selection before their existing parsing runs (ADR 0016).
 */
export function parseAgentFlags(args: string[]): {
  override: { provider?: string; model?: string; effort?: string };
  rest: string[];
} {
  const override: { provider?: string; model?: string; effort?: string } = {};
  const rest: string[] = [];
  const flags: Record<string, "provider" | "model" | "effort"> = {
    "--agent": "provider",
    "--model": "model",
    "--effort": "effort",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const key = flags[name];
    if (!key) {
      rest.push(a);
      continue;
    }
    override[key] = eq >= 0 ? a.slice(eq + 1) : args[++i];
  }
  return { override, rest };
}

/** Encode a partial CLI agent override into the `VETINARI_AGENT` env string. */
export function encodeAgentOverride(over: {
  provider?: string;
  model?: string;
  effort?: string;
}): string {
  return JSON.stringify(over);
}

/** Read the `VETINARI_AGENT` env string back into a partial override; junk/unset → `{}`. */
export function parseAgentOverride(raw: string | undefined): {
  provider?: string;
  model?: string;
  effort?: string;
} {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * The preflight credential check (ADR 0016): the provider's `.env` credential keys
 * that are absent (or present-but-empty) in `envPath`, or `[]` when at least one is
 * satisfied. Reads only the simple `KEY=value` assignments a container `.env` carries.
 * A non-empty result is what the CLI fails fast on, before any container launches.
 */
export function missingCredentials(provider: AgentProviderName, envPath: string): string[] {
  const keys = AGENT_PROVIDERS[provider].credentialKeys;
  const env = existsSync(envPath) ? parseEnvAssignments(readFileSync(envPath, "utf8")) : {};
  const anyPresent = keys.some((k) => (env[k] ?? "").length > 0);
  return anyPresent ? [] : [...keys];
}

/** Minimal `KEY=value` reader for a container `.env` — presence detection only, no shell semantics. */
function parseEnvAssignments(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
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
  /** Docker image carrying your toolchain AND the agent CLI(s) — the reference image ships Claude Code, pi, and Codex (ADR 0016). */
  image: string;
  /** Branch work is cut from, and what gate scoping diffs against. */
  baseBranch: string;
  /** Agent branches are `${branchPrefix}${taskId}`. Default "agent/". */
  branchPrefix?: string;
  /**
   * This project's cut of the host container ceiling when projects contend
   * (ADR 0011): a named tier `high | medium | low`, default `medium`. It only
   * bites while more than one project is active; a project running alone fills
   * the whole ceiling regardless of its tier.
   */
  containerShare?: ContainerShare;
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
  /**
   * Fetch the task text for an id — an issue body, a spec file, anything. When the
   * text is JSON it should carry the issue's open/closed state (`state`, or
   * `closed`/`closedAt`) so `graft` can reject a closed target (ADR 0014); a resolver
   * that omits it reads as always-open. `githubFetchTask` fixes that field set for
   * `gh`-backed configs — prefer it over a hand-rolled `--json` list.
   */
  fetchTask: (id: string) => string | Promise<string>;
  /**
   * The ids of a given id's OPEN blockers (its prerequisites still in flight).
   * Closed blockers must be filtered here at the edge — an already-merged
   * prerequisite does not gate. Used by `prune` (removes an issue and everything
   * transitively blocked by it) and `campaign-plan` (layers a selected set into
   * dependency-ordered waves). Wire it to your tracker — `githubBlockedBy(repo)`
   * ships as a ready GitHub implementation.
   */
  blockedBy?: (id: string) => string[] | Promise<string[]>;
  /**
   * The open issue numbers (as strings) carrying a given tracker label. Lets
   * `campaign <label>` select its issue set from the tracker — a non-numeric
   * campaign token is a label, expanded through this seam to the open issues it
   * tags — instead of a hand-typed id list. Follows ADR 0004: the CLI calls
   * `listByLabel`; the repo string stays inside the resolver closure.
   * `githubIssuesByLabel(repo)` ships as a ready GitHub implementation. Absent,
   * a campaign can still select by explicit id, but a label token fails fast.
   */
  listByLabel?: (label: string) => string[] | Promise<string[]>;
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
   * Fires once per issue merged into the base with a GREEN merged-base gate — the
   * first hop of the merge→`pending-verify`→close lifecycle
   * (`docs/issue-conventions.md`). The core names no labels and stays
   * tracker-agnostic; the handler decides what "merged" means for the tracker.
   * `githubMarkPendingVerify(repo)` ships as a GitHub implementation that relabels
   * `ready-for-agent` → `pending-verify`. Best-effort: a failing or offline write
   * is logged and never fails or rolls back the campaign. Absent, nothing is
   * labeled (a no-op). Only merged (green) issues are passed — parked/pruned/failed
   * are never in the set.
   */
  onIssueMerged?: (id: string) => void | Promise<void>;
  /**
   * Post a comment on a tracker issue — the tracker-write seam the non-resumable
   * park→answer path uses (ADR 0004 / #212). A copilot/cursor/opencode provider
   * carries no session to resume, so `answer` posts the human's reply as an issue
   * comment and re-enters as a FRESH run whose `fetchTask` re-reads it; the answer
   * is delivered purely through "read the issue". Fail-loud: `answer` errors and
   * never starts the run if this is unconfigured or throws, so an answer is never
   * silently lost. `githubIssueComment(repo)` ships as a GitHub implementation
   * (the repo stays inside the closure). Resumable providers never call it.
   */
  postComment?: (issueRef: string, body: string) => void | Promise<void>;
  /**
   * Named Telegram destinations this project routes categories to (name ->
   * `{chat, thread?}`). One bot per project — its token is read from
   * `.vetinari.local/`, never inlined here — so a destination names no bot, only
   * where on that bot a message lands. The `notify` map's values are keys of this map.
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
  /**
   * The project's default agent provider + model/effort (ADR 0016). Omitted →
   * claude with its default model at effort `high` (today's behavior). A
   * `--agent`/`--model`/`--effort` override on run/campaign wins over this.
   */
  agent?: AgentConfig;
  /** Gate→resume cycles before parking with reason "budget". Default 6. */
  maxTurns?: number;
  /** Default 600. A stalled agent parks rather than dying unrecorded. */
  idleTimeoutSeconds?: number;
  /**
   * How long, in seconds, the campaign loop holds a drained wave open at its
   * boundary when a member parked as `question` or `stalled`, waiting for an
   * answer to land before declaring the wave parked (design §5). An answer
   * within the window re-admits the member (it re-runs and merges in the same
   * wave); `conflict`/`red-base` parks never wait. Default 0 — no grace, park
   * at once. The window is a latency optimization on the durable resume path
   * (ADR 0020), never a substitute for it.
   */
  parkGraceSeconds?: number;
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
  /**
   * "Festive Wave Names" — when true, the dashboard defaults to naming each wave
   * after a Discworld character (`Wave 2 · Granny Weatherwax`) instead of a bare
   * `Wave N` (#193). Default false. This is only the **default** the server falls
   * back to when the browser carries no `festiveWaveNames` cookie; the gear toggle
   * still lets an operator flip it per-browser, and that cookie wins.
   */
  festiveWaveNames?: boolean;
}

export type ResolvedConfig = Required<
  Pick<
    VetinariConfig,
    | "project"
    | "image"
    | "baseBranch"
    | "branchPrefix"
    | "containerShare"
    | "gates"
    | "maxTurns"
    | "idleTimeoutSeconds"
    | "parkGraceSeconds"
    | "stateDir"
    | "fetchTask"
  >
> &
  VetinariConfig & {
    promptFile: string;
    parkedDir: string;
    logFile: string;
    log: Logger;
  };

export function defineConfig(c: VetinariConfig): VetinariConfig {
  return c;
}

/**
 * A project's root, resolved from git and worktree-safely — the one main checkout,
 * not wherever the command was typed. The root is the parent of
 * `git rev-parse --git-common-dir`, NOT `--show-toplevel` and NOT `process.cwd()`:
 * an agent worktree lives at `<root>/<stateDir>/worktrees/<taskId>` and is its own
 * toplevel carrying a real `vetinari/config.mts`, so `--show-toplevel` typed there
 * would resolve the project to a sandbox dir that is deleted when it closes, while
 * `--git-common-dir` always points at the MAIN checkout's `.git`. A directory that
 * is not a git repository at all refuses, in one line naming it — only "not a repo"
 * refuses; a repo whose `origin` we cannot identify degrades (see `repoForProject`).
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(
      `not a git repository: ${cwd} — run this from inside your project's checkout.`,
    );
  }
  // `--git-common-dir` is relative (`.git`) in a main checkout and absolute in a
  // linked worktree; `resolve` handles both, then the parent is the project root.
  return dirname(resolve(cwd, commonDir));
}

/**
 * Parse a git remote URL to its `owner/name`, handling both the SSH
 * (`git@github.com:owner/name.git`) and HTTPS (`https://github.com/owner/name(.git)`)
 * forms, stripping a `.git` suffix and any trailing slash. Pure and testable — the
 * `git remote get-url` call is the impure edge (`repoForProject`), this is the parse.
 * Anything it can't recognize as a remote is `undefined`, so a caller falls back to
 * the bare project key rather than showing a broken label.
 */
export function ownerRepoFromRemote(url: string): string | undefined {
  const match = url.trim().match(/(?:git@[^:]+:|https?:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, owner, name] = match;
  return owner && name ? `${owner}/${name}` : undefined;
}

/**
 * A project's `owner/name`, read live from its checkout's `origin` remote — the
 * impure edge over the pure `ownerRepoFromRemote` parse, and a project's identity
 * (CONTEXT.md's Project). A root that is not a git repo, has no `origin`, or whose
 * URL doesn't parse yields `undefined` (the git call is silenced and never throws),
 * so every consumer falls back to the declared project name.
 */
export function repoForProject(projectRoot: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return ownerRepoFromRemote(url);
  } catch {
    return undefined;
  }
}

/**
 * Verify a project qualifier before any write (shared by `prune` and `graft`). The
 * qualifier is an assertion, never a dispatch: the CLI acts only on the project it is
 * run in. A qualifier naming a different project refuses; and a qualifier the identity
 * cannot be verified against — no derivable repo — refuses too, since silently ignoring
 * it is the one genuinely dangerous degrade. No qualifier means the bare form, which
 * works exactly as before (identity only degrades the display line, never refuses).
 *
 * It sits beside `repoForProject` — the project-identity value it checks a qualifier
 * against — because it is about *project identity*, not how an id is spelled.
 */
export function assertProjectQualifier(
  qualifier: string | undefined,
  project: string,
  repo: string | undefined,
): void {
  if (qualifier === undefined) return;
  if (qualifier !== project)
    throw new Error(
      `refusing: this project is "${project}", but the qualifier names "${qualifier}". ` +
        "The CLI acts only on the project it is run in — it never reaches across into another.",
    );
  if (repo === undefined)
    throw new Error(
      `refusing: cannot derive this project's repo to verify the "${qualifier}" qualifier. ` +
        "With no repo identity to check against, the qualifier cannot be honored — run it in the project's checkout, or drop the qualifier.",
    );
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
export function resolveConfigPath(
  baseDir: string,
): ResolvedConfigPath | undefined {
  for (const { rel, deprecated } of CANDIDATES) {
    const path = resolve(baseDir, rel);
    if (existsSync(path))
      return deprecated ? { path, deprecatedFrom: rel } : { path };
  }
  return undefined;
}

/** Load the consuming project's config from cwd (or an explicit path). */
export async function loadConfig(
  explicitPath?: string,
): Promise<ResolvedConfig> {
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
  for (const required of [
    "project",
    "image",
    "baseBranch",
    "gates",
    "fetchTask",
  ] as const) {
    if (c[required] == null)
      throw new Error(`${path}: missing required field "${required}"`);
  }
  if (!c.gates.length)
    throw new Error(
      `${path}: "gates" is empty — the orchestrator would verify nothing`,
    );
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

  const logFile = `${stateDir}/logs/orchestrator.jsonl`;
  return {
    branchPrefix: "agent/",
    containerShare: "medium",
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    parkGraceSeconds: 0,
    ...c,
    stateDir,
    promptFile:
      c.promptFile ?? new URL("../prompts/tdd.md", import.meta.url).pathname,
    parkedDir: `${stateDir}/parked`,
    logFile,
    log: loggerForRun({ logFile }),
  } as ResolvedConfig;
}
