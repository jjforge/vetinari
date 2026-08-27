import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hostLogger, type Logger } from "./log.ts";
import type { Destination, NotifyMap, ResolvedConfig } from "./config.ts";
import type { TgConn } from "./telegram.ts";

/**
 * A registration is a POINTER only: which project, where its root is, and its
 * base location (the `.vetinari.local/` path). No config or secrets are copied
 * into the registry — the gateway reads those live from the base location
 * (ADR 0002). Editing a project's `vetinari/` config needs no re-register.
 */
export interface ProjectPointer {
  project: string;
  projectRoot: string;
  baseLocation: string;
}

/**
 * The gateway's host-level config directory — the one place the registry lives,
 * shared by every project on the machine (ADR 0003). `VETINARI_GATEWAY_HOME`
 * overrides it (and is the seam tests point at a tmp dir); otherwise it follows
 * the XDG convention, `$XDG_CONFIG_HOME/vetinari` or `~/.config/vetinari`.
 */
export function gatewayConfigDir(): string {
  const override = process.env.VETINARI_GATEWAY_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "vetinari");
}

/**
 * Register (or refresh) the current project's pointer with the gateway. Called at
 * the start of a run so a project enrolls itself with no manual step; idempotent,
 * a re-run just refreshes the pointer. Best-effort: a registry write that fails
 * is logged, never fatal to the run.
 */
export function autoRegister(
  cfg: Pick<ResolvedConfig, "project" | "stateDir" | "notify" | "destinations">,
  projectRoot: string = process.cwd(),
  logger: Logger = hostLogger(),
): void {
  try {
    const pointer = pointerFor(cfg, projectRoot);
    register(gatewayConfigDir(), pointer);
    // Materialize the project's routing into its base location so the gateway —
    // which holds no project config (ADR 0002) — can route the outbox by it live.
    writeRouting(pointer.baseLocation, {
      notify: cfg.notify,
      destinations: cfg.destinations,
    });
  } catch (e) {
    logger.log("registry-register-failed", { project: cfg.project, error: String(e) });
  }
}

/**
 * The pointer a project registers: its name, its root, and its base location —
 * the state dir resolved to an absolute path under the root. Pure, so the run
 * entry point can hand it straight to `register`.
 */
export function pointerFor(
  cfg: Pick<ResolvedConfig, "project" | "stateDir">,
  projectRoot: string,
): ProjectPointer {
  return {
    project: cfg.project,
    projectRoot,
    baseLocation: resolve(projectRoot, cfg.stateDir),
  };
}

/** One pointer file per project, keyed by project name — like `parked/`. */
const registryDir = (configDir: string) => join(configDir, "registry");
const pointerFile = (configDir: string, project: string) =>
  join(registryDir(configDir), `${project}.json`);

/**
 * Upsert a project's pointer under the gateway's config directory. Idempotent: a
 * re-run just overwrites the same file, refreshing where the project's root and
 * base location live.
 */
export function register(configDir: string, pointer: ProjectPointer): void {
  mkdirSync(registryDir(configDir), { recursive: true });
  writeFileSync(
    pointerFile(configDir, pointer.project),
    JSON.stringify(pointer, null, 2),
  );
}

/**
 * Remove a single named pointer from the host registry — the explicit write-side
 * counterpart to `listProjects`/`autoRegister` (there is no automatic prune; that
 * is a separate design call). The dashboard reads the registry live, so a removed
 * pointer stops rendering. Returns whether a pointer was actually removed, so a
 * name that was never registered is a clean no-op (`false`), never a crash.
 */
export function removePointer(configDir: string, project: string): boolean {
  const file = pointerFile(configDir, project);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** Every registered pointer. The gateway's source of truth for "what projects exist". */
export function listProjects(configDir: string): ProjectPointer[] {
  const dir = registryDir(configDir);
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ProjectPointer,
    );
}

/** A project read live from its base location: its pointer plus its resolved comms. */
export interface ReadProject {
  pointer: ProjectPointer;
  /** The project's Telegram connection, or undefined when it configures none. */
  conn?: TgConn;
  /** The project's notify map, materialized into its base location; undefined when it configures none. */
  notify?: NotifyMap;
  /** The project's named destinations, materialized into its base location. */
  destinations?: Record<string, Destination>;
}

/**
 * The project's routing, materialized as plain JSON in its base location. The
 * committed `vetinari/` config owns it; the run copies it down here at
 * registration so the gateway can read it live without importing the project's
 * TS config (ADR 0002: a dumb router reads everything from the base location).
 */
const ROUTING_FILE = "routing.json";

interface Routing {
  notify?: NotifyMap;
  destinations?: Record<string, Destination>;
}

/** Write the project's routing into its base location for the gateway to read live. Idempotent — a re-run just refreshes it. */
export function writeRouting(baseLocation: string, routing: Routing): void {
  mkdirSync(baseLocation, { recursive: true });
  writeFileSync(
    join(baseLocation, ROUTING_FILE),
    JSON.stringify(routing, null, 2),
  );
}

/** Read a project's materialized routing, or an empty routing when it configured none. */
function readRouting(baseLocation: string, logger: Logger): Routing {
  const path = join(baseLocation, ROUTING_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Routing;
  } catch (e) {
    logger.log("registry-routing-unreadable", { baseLocation, error: String(e) });
    return {};
  }
}

/**
 * The host-side secrets file inside a project's base location. Holds the
 * Telegram bot token and chat — read by the orchestrator process and live by the
 * gateway, never crossing into a container (`.env` is the container gate) and
 * never copied into the registry (ADR 0011, 0002). Named by container-reach:
 * `host.env` stays host-side.
 */
const SECRETS_FILE = "host.env";

/** The absolute path to a base location's host-side secrets file. */
export const hostSecretsPath = (baseLocation: string): string =>
  join(baseLocation, SECRETS_FILE);

/**
 * Parse a shell env file (`KEY=VALUE`, optional `export`, optional quotes, `#`
 * comments) into a plain record. Not a full shell — just enough to read the
 * simple assignments a `host.env` carries.
 */
function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      // A quoted value keeps its contents verbatim (a literal '#' included);
      // anything after the closing quote (e.g. an inline comment) is dropped.
      const quote = value[0];
      const close = value.indexOf(quote, 1);
      value = close >= 0 ? value.slice(1, close) : value.slice(1);
    } else {
      // An unquoted value ends at an inline comment, matching shell `source`:
      // whitespace followed by '#' starts a comment (a bare '#' mid-token is literal).
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[m[1]] = value;
  }
  return env;
}

// The Telegram env var names, mirroring telegram.ts's `tgEnvConn`. The token is
// the secret; it lives only in the base location, never in the registry.
const tgConnFromEnv = (env: Record<string, string>): TgConn | undefined => {
  const token = env.VETINARI_TELEGRAM_BOT_TOKEN;
  const chat = env.VETINARI_TELEGRAM_CHAT_ID;
  return token && chat
    ? { token, chat, thread: env.VETINARI_TELEGRAM_THREAD_ID }
    : undefined;
};

/**
 * Read a base location's `host.env` into a Telegram connection — the single
 * reader of a project's live Telegram secrets, shared by the gateway
 * (`readProject`) and `tg-test` so both exercise the exact same path (no
 * divergence). `undefined` when the file or the required keys are absent. Reads
 * only the file, never `process.env`.
 */
export function tgConnForBaseLocation(
  baseLocation: string,
): TgConn | undefined {
  const secretsPath = hostSecretsPath(baseLocation);
  const env = existsSync(secretsPath)
    ? parseEnvFile(readFileSync(secretsPath, "utf8"))
    : {};
  return tgConnFromEnv(env);
}

/**
 * Load a project live from its base location: its Telegram connection and
 * secrets, read fresh every call so an edit to the project's config takes effect
 * with no re-register. A pointer whose base location has moved or been deleted is
 * skipped (logged, `undefined` returned) rather than throwing — one stale
 * registration must never take the gateway down (ADR 0002).
 */
export function readProject(pointer: ProjectPointer, logger: Logger = hostLogger()): ReadProject | undefined {
  if (!existsSync(pointer.baseLocation)) {
    logger.log("registry-stale", {
      project: pointer.project,
      baseLocation: pointer.baseLocation,
    });
    return undefined;
  }
  const { notify, destinations } = readRouting(pointer.baseLocation, logger);
  return {
    pointer,
    conn: tgConnForBaseLocation(pointer.baseLocation),
    notify,
    destinations,
  };
}

/**
 * Every registered project that is still live, read from its base location.
 * Stale pointers (base location gone) are dropped, so a caller iterating the
 * registry gets only projects it can actually serve.
 */
export function readProjects(configDir: string, logger: Logger = hostLogger()): ReadProject[] {
  return listProjects(configDir)
    .map((pointer) => readProject(pointer, logger))
    .filter((r): r is ReadProject => r !== undefined);
}
