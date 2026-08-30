/**
 * Move a project from the old single-`.sandcastle/` layout onto the committed
 * `vetinari/` + excluded `.vetinari.local/` split (ADR 0001).
 *
 * Split into a pure planner and an apply step, mirroring `prune` (a pure planner
 * over plain data) and `archive` (filesystem work that reports what it did):
 * `computeLayoutMigration` turns a described on-disk state into a plan — the moves
 * and the `.gitignore` edit — touching nothing; `applyLayoutMigration` performs
 * that plan against a real directory.
 *
 * The plan covers exactly the one-time layout move (design §9, §13.1): config →
 * `vetinari/`, old `.sandcastle/` state → `.vetinari.local/`, the `.gitignore`
 * edit, and the one host-side secrets-file rename `orchestrator.env` → `host.env`.
 * migrate deliberately carries no other rename shims — a rename is a breaking
 * change with a stated benefit, not something migrate absorbs forever. Every part
 * is idempotent: a re-run changes nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConfigPath } from "./config.ts";

const CANONICAL_DIR = "vetinari";
const LOCAL_DIR = ".vetinari.local";
const OLD_DIR = ".sandcastle";

/** The host-side secrets file's former name and its current one. */
const OLD_SECRETS_FILE = "orchestrator.env";
const SECRETS_FILE = "host.env";

/** A single filesystem move, both paths relative to the project root. */
export interface Move {
  from: string;
  to: string;
}

/** A description of the relevant on-disk state, produced by the CLI at the edge. */
export interface LayoutScan {
  /**
   * The deprecated config location that exists, relative to the root (e.g.
   * ".sandcastle/config.mts"). Undefined when the
   * config is already canonical or absent.
   */
  legacyConfig?: string;
  /** Top-level entry names directly under `.sandcastle/` (empty if none). */
  oldState?: string[];
  /**
   * Top-level entry names directly under `.vetinari.local/` (empty if none). A
   * project already on the new layout still needs its host-side secrets file
   * renamed `orchestrator.env` → `host.env`.
   */
  localState?: string[];
  /** Current `.gitignore` content, or undefined when there is no `.gitignore`. */
  gitignore?: string;
  /**
   * Relative paths that already exist on disk. A move whose destination is here
   * is a conflict — refused rather than allowed to clobber.
   */
  existing?: string[];
}

export interface LayoutMigrationPlan {
  moves: Move[];
  /** The full new `.gitignore` content to write, or undefined when unchanged. */
  gitignore?: string;
  /** Destinations that already exist — the migration is refused while non-empty. */
  conflicts: string[];
}

/** Destination for a config move: `vetinari/config` keeps the source extension. */
const configDest = (legacyConfig: string) => `${CANONICAL_DIR}/config${legacyConfig.endsWith(".mts") ? ".mts" : ".ts"}`;

/**
 * Ensure `.gitignore` ignores BOTH the new excluded dir and the old one (kept
 * ignored during the transition so a half-migrated tree cannot leak old state).
 * Returns the full new content, or undefined when nothing needs adding.
 */
function planGitignore(current: string | undefined): string | undefined {
  const lines = (current ?? "").split("\n");
  const has = (entry: string) => lines.some((l) => l.trim().replace(/\/$/, "") === entry);
  const additions: string[] = [];
  if (!has(LOCAL_DIR)) additions.push(`${LOCAL_DIR}/`);
  if (!has(OLD_DIR)) additions.push(`${OLD_DIR}/`);
  if (!additions.length) return undefined;

  let out = current ?? "";
  if (out.length && !out.endsWith("\n")) out += "\n";
  return out + additions.map((a) => `${a}\n`).join("");
}

export function computeLayoutMigration(scan: LayoutScan): LayoutMigrationPlan {
  const existing = new Set(scan.existing ?? []);
  const moves: Move[] = [];
  const conflicts: string[] = [];
  const addMove = (from: string, to: string) => (existing.has(to) ? conflicts.push(to) : moves.push({ from, to }));

  // Config → committed `vetinari/`. When it lived inside `.sandcastle/`, it is
  // pulled out here so the state sweep below does not also move it.
  let configBasename: string | undefined;
  if (scan.legacyConfig) {
    if (scan.legacyConfig.startsWith(`${OLD_DIR}/`)) configBasename = scan.legacyConfig.slice(OLD_DIR.length + 1);
    addMove(scan.legacyConfig, configDest(scan.legacyConfig));
  }

  // Everything else under `.sandcastle/` (state + secrets) → excluded `.vetinari.local/`.
  // The host-side secrets file lands under its new name in the same move.
  for (const entry of scan.oldState ?? []) {
    if (entry === configBasename) continue;
    const destName = entry === OLD_SECRETS_FILE ? SECRETS_FILE : entry;
    addMove(`${OLD_DIR}/${entry}`, `${LOCAL_DIR}/${destName}`);
  }

  // A project already on the new layout still carries the old secrets-file name;
  // rename it in place `orchestrator.env` → `host.env`.
  if ((scan.localState ?? []).includes(OLD_SECRETS_FILE)) {
    addMove(`${LOCAL_DIR}/${OLD_SECRETS_FILE}`, `${LOCAL_DIR}/${SECRETS_FILE}`);
  }

  const gitignore = planGitignore(scan.gitignore);

  return { moves, gitignore, conflicts };
}

export interface ApplyResult {
  moved: Move[];
  gitignoreUpdated: boolean;
}

/**
 * Perform a plan against `baseDir`: the moves and the `.gitignore` edit. Refuses
 * the WHOLE migration if the plan carries conflicts, so a clobber never happens
 * and the tree is never left half-migrated. Each move re-checks its destination
 * against the live disk before renaming — a last guard against a stale scan.
 */
export function applyLayoutMigration(baseDir: string, plan: LayoutMigrationPlan): ApplyResult {
  if (plan.conflicts.length) {
    throw new Error(
      `migrate refused: ${plan.conflicts.length} destination(s) already exist — ${plan.conflicts.join(", ")}. ` +
        `Move or remove them, then re-run. Nothing was changed.`,
    );
  }

  for (const { from, to } of plan.moves) {
    const dest = resolve(baseDir, to);
    if (existsSync(dest)) throw new Error(`migrate refused: destination ${to} already exists. Nothing was changed.`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(resolve(baseDir, from), dest);
  }

  const gitignoreUpdated = plan.gitignore !== undefined;
  if (gitignoreUpdated) writeFileSync(resolve(baseDir, ".gitignore"), plan.gitignore!);

  return { moved: plan.moves, gitignoreUpdated };
}

/** Read a file, or undefined when it is absent — the edge's "optional input" idiom. */
const readOrUndef = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Probe `baseDir` into a `LayoutScan` — the filesystem read that lives at the
 * edge so the planner stays pure. The legacy config location comes from the same
 * resolver `loadConfig` uses, so migrate and resolution never disagree on what
 * counts as a deprecated config. `existing` lists everything already under the
 * two destination dirs, so any would-be clobber surfaces as a conflict.
 */
export function scanLayout(baseDir: string): LayoutScan {
  const listDir = (rel: string): string[] => {
    try {
      return readdirSync(resolve(baseDir, rel));
    } catch {
      return [];
    }
  };
  const resolvedConfig = resolveConfigPath(baseDir);
  return {
    legacyConfig: resolvedConfig?.deprecatedFrom,
    oldState: listDir(OLD_DIR),
    localState: listDir(LOCAL_DIR),
    gitignore: readOrUndef(resolve(baseDir, ".gitignore")),
    existing: [
      ...listDir(CANONICAL_DIR).map((e) => `${CANONICAL_DIR}/${e}`),
      ...listDir(LOCAL_DIR).map((e) => `${LOCAL_DIR}/${e}`),
    ],
  };
}

/**
 * A human-facing summary of a plan: the moves, the `.gitignore` edit, and — when
 * the plan is refused — the conflicting destinations. Pure, so the CLI prints the
 * same text for both `--dry-run` (the plan) and a real run (what it did). An empty
 * plan reads as "nothing to do".
 */
export function describeMigration(plan: LayoutMigrationPlan): string {
  const lines: string[] = [];

  if (plan.conflicts.length) {
    lines.push(`migrate REFUSED — ${plan.conflicts.length} destination(s) already exist:`);
    for (const c of plan.conflicts) lines.push(`  ✗ ${c}`);
    lines.push("Move or remove them, then re-run. Nothing will be changed until they are gone.");
  }

  const changesNothing = !plan.moves.length && plan.gitignore === undefined && !plan.conflicts.length;
  if (changesNothing) {
    return "Nothing to do — this project is already on the vetinari/ + .vetinari.local/ layout.";
  }

  if (plan.moves.length) {
    lines.push(`Moves (${plan.moves.length}):`);
    for (const m of plan.moves) lines.push(`  ${m.from} → ${m.to}`);
  }
  if (plan.gitignore !== undefined) lines.push("Update .gitignore to exclude .vetinari.local/ (and keep .sandcastle/ ignored).");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gateway systemd-unit generation — used by `gateway install` (src/cli.mts) and
// `gateway <status|start|stop|restart>` (src/gateway-service.ts), NOT by migrate.
// It lives here for historical reasons; it is not a migration shim.
// ---------------------------------------------------------------------------

/**
 * How this CLI was launched: the absolute node binary, the loader flags it was
 * started with (the tsx `--require`/`--import` pair, in production), and the CLI
 * entrypoint. The three pieces `selfSpawn` (`src/modes.ts`) re-invokes with — kept
 * as data so the ExecStart resolver stays a pure function of them.
 */
export interface LaunchSelf {
  execPath: string;
  execArgv: string[];
  argv1: string;
}

/** An argument systemd's ExecStart splitter reads verbatim: no whitespace or quoting metacharacters. */
const SYSTEMD_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argument for a systemd `ExecStart` line. systemd splits the command on
 * whitespace, so a path carrying a space (a home dir with one) must be quoted or it
 * reads as two arguments; a clean path is returned untouched so the common line stays
 * literal. Inside double quotes systemd honours C-style escapes, so `\` and `"` are
 * backslash-escaped. Pure.
 */
export function systemdQuoteArg(arg: string): string {
  if (SYSTEMD_SAFE_ARG.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The fully-absolute, PATH-independent `ExecStart=` line that launches the gateway,
 * mirroring `selfSpawn`: the absolute node binary, its tsx-loader `execArgv`, this
 * CLI's entrypoint, then `gateway`. No shell, no `env`, no `npx`, no PATH lookup — so
 * it starts under systemd's clean environment where a `.bashrc`-hooked toolchain
 * manager's node bin never reaches PATH (the crash-loop this fixes). Pure in `launch`,
 * so the same host re-resolves the same line (an idempotent rewrite).
 */
export function resolveGatewayExecStart(launch: LaunchSelf): string {
  const argv = [launch.execPath, ...launch.execArgv, launch.argv1, "gateway"];
  return `ExecStart=${argv.map(systemdQuoteArg).join(" ")}`;
}

/**
 * The host-level gateway systemd unit: no `WorkingDirectory` (it fronts every
 * project, not one), launching the `gateway` command (ADR 0003) via the resolved
 * absolute `execStart`. It sources no env file — the gateway holds no secrets of its
 * own (ADR 0002); it reads each project's credentials live from that project's base
 * location. Deterministic in `execStart`, so feeding a rewritten unit back in yields
 * the same text.
 */
function gatewayUnit(execStart: string): string {
  return [
    "[Unit]",
    "Description=vetinari gateway (host Telegram router)",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    execStart,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Read how this process was launched — the edge IO behind the pure ExecStart resolver. */
export function currentLaunchSelf(): LaunchSelf {
  return { execPath: process.execPath, execArgv: process.execArgv, argv1: process.argv[1] };
}

/**
 * The resolved host-level gateway unit for THIS install: an absolute node +
 * tsx-loader + cli invocation, PATH-independent. Reads `process.*` at the edge; the
 * unit `gateway install` writes on this host.
 */
export function resolvedGatewayUnit(): string {
  return gatewayUnit(resolveGatewayExecStart(currentLaunchSelf()));
}

/** Write a resolved gateway unit to `path`, creating its parent dir — the `gateway install` edge IO. */
export function writeGatewayUnit(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Where the host-level gateway systemd unit lives. `VETINARI_SYSTEMD_UNIT`
 * overrides it (the seam tests point at a tmp file); otherwise it follows the
 * systemd user-unit convention, `$XDG_CONFIG_HOME/systemd/user` or
 * `~/.config/systemd/user`, mirroring the README's install path.
 */
export function systemdUnitPath(): string {
  const override = process.env.VETINARI_SYSTEMD_UNIT;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "systemd", "user", "vetinari-gateway.service");
}
