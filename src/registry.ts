import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "./log.ts";
import type { ResolvedConfig } from "./config.ts";
import type { TgConn } from "./telegram.ts";

/**
 * A registration is a POINTER only: which project, where its root is, and its
 * base location (the `.sandcastle.local/` path). No config or secrets are copied
 * into the registry — the gateway reads those live from the base location
 * (ADR 0002). Editing a project's `sandcastle/` config needs no re-register.
 */
export interface ProjectPointer {
  project: string;
  projectRoot: string;
  baseLocation: string;
}

/**
 * The gateway's host-level config directory — the one place the registry lives,
 * shared by every project on the machine (ADR 0003). `SANDCASTLE_GATEWAY_HOME`
 * overrides it (and is the seam tests point at a tmp dir); otherwise it follows
 * the XDG convention, `$XDG_CONFIG_HOME/sandcastle` or `~/.config/sandcastle`.
 */
export function gatewayConfigDir(): string {
  const override = process.env.SANDCASTLE_GATEWAY_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "sandcastle");
}

/**
 * Register (or refresh) the current project's pointer with the gateway. Called at
 * the start of a run so a project enrolls itself with no manual step; idempotent,
 * a re-run just refreshes the pointer. Best-effort: a registry write that fails
 * is logged, never fatal to the run.
 */
export function autoRegister(cfg: Pick<ResolvedConfig, "project" | "stateDir">, projectRoot: string = process.cwd()): void {
  try {
    register(gatewayConfigDir(), pointerFor(cfg, projectRoot));
  } catch (e) {
    log("registry-register-failed", { project: cfg.project, error: String(e) });
  }
}

/**
 * The pointer a project registers: its name, its root, and its base location —
 * the state dir resolved to an absolute path under the root. Pure, so the run
 * entry point can hand it straight to `register`.
 */
export function pointerFor(cfg: Pick<ResolvedConfig, "project" | "stateDir">, projectRoot: string): ProjectPointer {
  return { project: cfg.project, projectRoot, baseLocation: resolve(projectRoot, cfg.stateDir) };
}

/** One pointer file per project, keyed by project name — like `parked/`. */
const registryDir = (configDir: string) => join(configDir, "registry");
const pointerFile = (configDir: string, project: string) => join(registryDir(configDir), `${project}.json`);

/**
 * Upsert a project's pointer under the gateway's config directory. Idempotent: a
 * re-run just overwrites the same file, refreshing where the project's root and
 * base location live.
 */
export function register(configDir: string, pointer: ProjectPointer): void {
  mkdirSync(registryDir(configDir), { recursive: true });
  writeFileSync(pointerFile(configDir, pointer.project), JSON.stringify(pointer, null, 2));
}

/** Every registered pointer. The gateway's source of truth for "what projects exist". */
export function listProjects(configDir: string): ProjectPointer[] {
  const dir = registryDir(configDir);
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ProjectPointer);
}

/** A project read live from its base location: its pointer plus its resolved comms. */
export interface ReadProject {
  pointer: ProjectPointer;
  /** The project's Telegram connection, or undefined when it configures none. */
  conn?: TgConn;
}

/**
 * The secrets file inside a project's base location. Holds the orchestrator's
 * host-side env, including the Telegram bot token and chat — never copied into
 * the registry, always read live from here (ADR 0001/0002).
 */
const SECRETS_FILE = "orchestrator.env";

/**
 * Parse a shell env file (`KEY=VALUE`, optional `export`, optional quotes, `#`
 * comments) into a plain record. Not a full shell — just enough to read the
 * simple assignments an `orchestrator.env` carries.
 */
function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

// The Telegram env var names, mirroring telegram.ts's `tgEnvConn`. The token is
// the secret; it lives only in the base location, never in the registry.
const tgConnFromEnv = (env: Record<string, string>): TgConn | undefined => {
  const token = env.SANDCASTLE_TELEGRAM_BOT_TOKEN;
  const chat = env.SANDCASTLE_TELEGRAM_CHAT_ID;
  return token && chat ? { token, chat, thread: env.SANDCASTLE_TELEGRAM_THREAD_ID } : undefined;
};

/**
 * Load a project live from its base location: its Telegram connection and
 * secrets, read fresh every call so an edit to the project's config takes effect
 * with no re-register. A pointer whose base location has moved or been deleted is
 * skipped (logged, `undefined` returned) rather than throwing — one stale
 * registration must never take the gateway down (ADR 0002).
 */
export function readProject(pointer: ProjectPointer): ReadProject | undefined {
  if (!existsSync(pointer.baseLocation)) {
    log("registry-stale", { project: pointer.project, baseLocation: pointer.baseLocation });
    return undefined;
  }
  const secretsPath = join(pointer.baseLocation, SECRETS_FILE);
  const env = existsSync(secretsPath) ? parseEnvFile(readFileSync(secretsPath, "utf8")) : {};
  return { pointer, conn: tgConnFromEnv(env) };
}

/**
 * Every registered project that is still live, read from its base location.
 * Stale pointers (base location gone) are dropped, so a caller iterating the
 * registry gets only projects it can actually serve.
 */
export function readProjects(configDir: string): ReadProject[] {
  return listProjects(configDir)
    .map(readProject)
    .filter((r): r is ReadProject => r !== undefined);
}
