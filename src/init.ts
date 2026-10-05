/**
 * Scaffold a NEW project onto the committed `vetinari/` + excluded
 * `.vetinari.local/` layout (ADR 0001, ADR 0003).
 *
 * Sibling of `migrate` and built on the same planner+apply shape: `migrate` moves
 * an existing project off the old layout, `init` stands a greenfield one up.
 * `computeInit` turns a described target directory into a plan — the files/dirs to
 * create and the `.gitignore` edit — touching nothing; `applyInit` performs that
 * plan against a real directory. vetinari is a shared machine install, so
 * `init` lays down files only: it installs and vendors nothing.
 *
 * Idempotent and non-clobbering: re-running yields an empty plan and a "nothing to
 * do" report, and an existing `vetinari/` config is never overwritten — the
 * committed scaffold (config, Dockerfile, tsconfig) is refused with a clear message
 * while the still-missing pieces (the `vetinari/tsconfig.json` an older project
 * predates, the excluded dir, the `.gitignore` entry) are filled in without
 * disturbing what already exists.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Refusal } from "./refusal.ts";
import { dirname, resolve } from "node:path";
import { AGENT_PROVIDERS, DEFAULT_PROVIDER, ownerRepoFromRemote, type AgentProviderName } from "./config.ts";

const CANONICAL_DIR = "vetinari";
/** The excluded machine-local base location init lays down and knows by its own constant
 *  (init runs before the strict config load, so it cannot read `cfg.stateDir`). */
export const LOCAL_DIR = ".vetinari.local";
const CONFIG_DEST = `${CANONICAL_DIR}/config.mts`;
const DOCKERFILE_DEST = `${CANONICAL_DIR}/Dockerfile`;
const TSCONFIG_DEST = `${CANONICAL_DIR}/tsconfig.json`;

/** A file to write: its path relative to the project root and its full content. */
export interface FileCreate {
  path: string;
  content: string;
}

/**
 * A description of the relevant on-disk state, produced by the CLI at the edge so
 * the planner stays pure. Carries the template contents (read from the install)
 * that the committed scaffold is made of.
 */
export interface InitScan {
  /** Whether a canonical `vetinari/` config already exists (→ scaffold refused). */
  hasConfig: boolean;
  /** Whether the committed `vetinari/tsconfig.json` already exists. */
  hasTsconfig: boolean;
  /** Whether the excluded `.vetinari.local/` dir already exists. */
  hasLocalDir: boolean;
  /** Current `.gitignore` content, or undefined when there is no `.gitignore`. */
  gitignore?: string;
  /** Whether the project's `origin` is a github.com remote (→ the githubTracker config). */
  githubOrigin: boolean;
  /** The `defineConfig` skeleton to write when `origin` is not on GitHub, shipped with the install. */
  configTemplate: string;
  /** The config that spreads `...githubTracker()`, written when `origin` is on GitHub. */
  githubConfigTemplate: string;
  /** The Dockerfile template to write, shipped with the install. */
  dockerfileTemplate: string;
  /** The committed tsconfig that extends `.vetinari.local/tsconfig.json`, shipped with the install. */
  tsconfigTemplate: string;
}

export interface InitPlan {
  /** Committed scaffold files to write (the config skeleton, the Dockerfile and the tsconfig). */
  creates: FileCreate[];
  /** Directories to create (the excluded `.vetinari.local/`). */
  dirs: string[];
  /** The full new `.gitignore` content to write, or undefined when unchanged. */
  gitignore?: string;
  /**
   * True when a `vetinari/` config already existed, so the committed scaffold
   * (config + Dockerfile) was withheld rather than overwritten. A missing
   * `vetinari/tsconfig.json` — the one committed file an existing project may
   * predate — and the machine-local pieces are still filled in.
   */
  refused: boolean;
  /** Whether the config written is the githubTracker one (origin on github.com) rather than the skeleton. */
  githubConfig: boolean;
}

/**
 * Ensure `.gitignore` excludes the machine-local dir. Returns the full new content,
 * or undefined when the entry is already present (matched with or without a
 * trailing slash, so a re-run adds nothing).
 */
function planGitignore(current: string | undefined): string | undefined {
  const lines = (current ?? "").split("\n");
  const has = lines.some((l) => l.trim().replace(/\/$/, "") === LOCAL_DIR);
  if (has) return undefined;

  let out = current ?? "";
  if (out.length && !out.endsWith("\n")) out += "\n";
  return `${out}${LOCAL_DIR}/\n`;
}

/**
 * Pure planner: from a described target directory, return what `init` would create
 * and the `.gitignore` edit. Writes nothing. When a config already exists the
 * committed scaffold is withheld (`refused`) so it is never overwritten, while a
 * missing tsconfig and the machine-local pieces are planned so a partial layout is
 * topped up.
 */
export function computeInit(scan: InitScan): InitPlan {
  const creates: FileCreate[] = [];
  const dirs: string[] = [];
  const refused = scan.hasConfig;

  if (!refused) {
    creates.push({ path: CONFIG_DEST, content: scan.githubOrigin ? scan.githubConfigTemplate : scan.configTemplate });
    creates.push({ path: DOCKERFILE_DEST, content: scan.dockerfileTemplate });
  }
  if (!scan.hasTsconfig) creates.push({ path: TSCONFIG_DEST, content: scan.tsconfigTemplate });
  if (!scan.hasLocalDir) dirs.push(LOCAL_DIR);

  const gitignore = planGitignore(scan.gitignore);

  return { creates, dirs, gitignore, refused, githubConfig: scan.githubOrigin };
}

/**
 * A human-facing summary of a plan, printed for both `--dry-run` (the plan) and a
 * real run (what it did). An empty plan reads as "nothing to do"; a plan that laid
 * down the committed scaffold ends with the maintainer's next steps. Pure.
 */
export function describeInit(plan: InitPlan, provider: AgentProviderName = DEFAULT_PROVIDER): string {
  const nothing = !plan.creates.length && !plan.dirs.length && plan.gitignore === undefined;
  if (nothing) {
    return "Nothing to do — this project is already initialized onto the vetinari/ + .vetinari.local/ layout.";
  }

  const lines: string[] = [];
  if (plan.refused) {
    lines.push(`Left ${CONFIG_DEST} untouched — it already exists (init never overwrites an existing config).`);
    lines.push("Filling in the still-missing pieces:");
  } else {
    lines.push("Scaffolding this project onto the vetinari/ + .vetinari.local/ layout:");
  }

  const configWhy = plan.githubConfig
    ? " — the githubTracker() config, because origin is a github.com remote"
    : " — the skeleton with TODO stubs, because origin is missing or not a github.com remote";
  for (const c of plan.creates) lines.push(`  + ${c.path}${c.path === CONFIG_DEST ? configWhy : ""}`);
  for (const d of plan.dirs) lines.push(`  + ${d}/ (excluded machine-local dir)`);
  if (plan.gitignore !== undefined) lines.push(`  ~ .gitignore — exclude ${LOCAL_DIR}/`);

  // Next steps only apply when the committed scaffold was actually laid down.
  if (!plan.refused) {
    // The credential keys the selected provider's preflight accepts (any one satisfies), read
    // from AGENT_PROVIDERS so this never drifts from the provider table (§13.1). A greenfield
    // scaffold has no `agent` in its config yet, so it defaults to the default provider; the
    // template comment naming `agent` tells a project picking another provider what to set.
    const keys = AGENT_PROVIDERS[provider].credentialKeys.join(" or ");
    lines.push("");
    lines.push("Next steps:");
    lines.push(`  1. Add your toolchain to ${DOCKERFILE_DEST} and your gates to ${CONFIG_DEST}.`);
    lines.push(
      `  2. Put your agent credential in ${LOCAL_DIR}/.env as ${keys} — the key(s) the \`${provider}\` provider reads (set \`agent\` in ${CONFIG_DEST} to pick another). The container reads it there, and the first real \`run\` is the first thing that needs it.`,
    );
    lines.push(
      `  3. Wire this project's Telegram bot connection with \`vetinari tg-connect\` — it collects the bot token and chat into ${LOCAL_DIR}/host.env (host-side, never the container gate) so parked questions are announced. Optional; skip it to run without notifications.`,
    );
    lines.push("  4. Build the image, then run `vetinari baseline` to prove every gate green.");
  }

  return lines.join("\n");
}

export interface ApplyInitResult {
  /** Relative paths of the scaffold files written. */
  created: string[];
  /** Relative paths of the directories created. */
  dirsCreated: string[];
  /** Whether `.gitignore` was written. */
  gitignoreUpdated: boolean;
}

/**
 * Perform a plan against `baseDir`: write the committed scaffold files, create the
 * excluded dir, and write the `.gitignore` edit. Each scaffold write re-checks its
 * destination against the live disk first and refuses rather than clobber — a last
 * guard against a stale scan (the planner already withholds a write whose target
 * existed at scan time). Directory creation is `recursive`, so re-creating an
 * existing excluded dir is a no-op.
 */
export function applyInit(baseDir: string, plan: InitPlan): ApplyInitResult {
  const created: string[] = [];
  for (const { path, content } of plan.creates) {
    const dest = resolve(baseDir, path);
    if (existsSync(dest)) throw new Refusal(`init refused: ${path} already exists — not overwriting it. Nothing was changed to it.`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    created.push(path);
  }

  const dirsCreated: string[] = [];
  for (const d of plan.dirs) {
    mkdirSync(resolve(baseDir, d), { recursive: true });
    dirsCreated.push(d);
  }

  const gitignoreUpdated = plan.gitignore !== undefined;
  if (gitignoreUpdated) writeFileSync(resolve(baseDir, ".gitignore"), plan.gitignore!);

  return { created, dirsCreated, gitignoreUpdated };
}

/** Read a file, or undefined when it is absent — the edge's "optional input" idiom. */
const readOrUndef = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Absolute path to a template shipped with the install (sibling of `src/`). */
const templatePath = (name: string) => new URL(`../templates/${name}`, import.meta.url).pathname;

/**
 * Whether a remote URL points at an `owner/name` on github.com itself — the SSH
 * (`git@github.com:`) or HTTPS (`https://github.com/`) form, host matched exactly. An
 * SSH host alias (`github.com-work`) or a GitHub Enterprise host does not count:
 * `ownerRepoFromRemote` parses any host, so this host check is init's own. Pure.
 */
export function isGithubComRemote(url: string): boolean {
  const u = url.trim();
  return (u.startsWith("git@github.com:") || u.startsWith("https://github.com/")) && ownerRepoFromRemote(u) !== undefined;
}

/** The project's `origin` URL, or undefined when it is not a git repo or has no `origin`. */
const originUrl = (baseDir: string): string | undefined => {
  try {
    return execFileSync("git", ["-C", baseDir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
};

/**
 * Probe `baseDir` into an `InitScan` — the filesystem read that lives at the edge
 * so the planner stays pure. A canonical `vetinari/config.{mts,ts}` counts as an
 * existing config (the refusal trigger); the deprecated locations do not, since
 * init is for a greenfield project (a legacy layout is `migrate`'s job). The
 * config templates (the skeleton and the githubTracker one), Dockerfile and tsconfig
 * are read from the shared install, and `origin` is checked for a github.com remote.
 */
export function scanInit(baseDir: string): InitScan {
  return {
    hasConfig: existsSync(resolve(baseDir, CONFIG_DEST)) || existsSync(resolve(baseDir, `${CANONICAL_DIR}/config.ts`)),
    hasTsconfig: existsSync(resolve(baseDir, TSCONFIG_DEST)),
    hasLocalDir: existsSync(resolve(baseDir, LOCAL_DIR)),
    gitignore: readOrUndef(resolve(baseDir, ".gitignore")),
    githubOrigin: isGithubComRemote(originUrl(baseDir) ?? ""),
    configTemplate: readFileSync(templatePath("config.mts"), "utf8"),
    githubConfigTemplate: readFileSync(templatePath("config.github.mts"), "utf8"),
    dockerfileTemplate: readFileSync(templatePath("Dockerfile"), "utf8"),
    tsconfigTemplate: readFileSync(templatePath("tsconfig.json"), "utf8"),
  };
}
