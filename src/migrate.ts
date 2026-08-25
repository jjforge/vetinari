/**
 * Move a project from the old single-`.sandcastle/` layout onto the committed
 * `vetinari/` + excluded `.vetinari.local/` split (ADR 0001).
 *
 * Split into a pure planner and an apply step, mirroring `carve` (a pure planner
 * over plain data) and `archive` (filesystem work that reports what it did):
 * `computeLayoutMigration` turns a described on-disk state into a plan — the
 * moves, the `.gitignore` edit, the deletion of a stale `gateway.env`, and the
 * systemd-unit rewrite — touching nothing; `applyLayoutMigration` performs that
 * plan against a real directory.
 *
 * The plan covers the whole migration: the LAYOUT MOVE (config → `vetinari/`,
 * old `.sandcastle/` state → `.vetinari.local/`, `.gitignore`) plus the
 * gateway-coupled parts — deleting any stale host-level `gateway.env` (the gateway
 * holds no secrets of its own; it reads each project's credentials live from the
 * base location, ADR 0002) and rewriting the systemd unit from a per-project
 * `dispatch` poller into the host-level gateway service. Every part is idempotent:
 * a re-run changes nothing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConfigPath } from "./config.ts";
import { gatewayConfigDir } from "./registry.ts";

const CANONICAL_DIR = "vetinari";
const LOCAL_DIR = ".vetinari.local";
const OLD_DIR = ".sandcastle";

/** The gateway's retired host-level env file — deleted by migrate, never recreated. */
const GATEWAY_ENV_FILE = "gateway.env";

/** The host-side secrets file's former name and its current one (ADR 0011). */
const OLD_SECRETS_FILE = "orchestrator.env";
const SECRETS_FILE = "host.env";

/** The container gate — the one file sandcastle injects into agent containers. */
const CONTAINER_ENV_FILE = ".env";

/**
 * Key prefix for secrets that belong only host-side (the Telegram bot token, chat,
 * thread). Sandcastle injects EVERY key of `.env` into the agent container, so any
 * of these left there rides into every container — the leak this migration closes
 * (ADR 0011; the container-boundary invariant of `src/telegram.ts`).
 */
const HOST_ONLY_ENV_PREFIX = "VETINARI_TELEGRAM_";

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
   * renamed `orchestrator.env` → `host.env` (ADR 0011).
   */
  localState?: string[];
  /** Current `.gitignore` content, or undefined when there is no `.gitignore`. */
  gitignore?: string;
  /**
   * Relative paths that already exist on disk. A move whose destination is here
   * is a conflict — refused rather than allowed to clobber.
   */
  existing?: string[];
  /** The gateway's host-level config directory — where a stale `gateway.env` may live. */
  gatewayConfigDir?: string;
  /** Current `gateway.env` content, or undefined when absent — a present one is deleted. */
  gatewayEnv?: string;
  /** Absolute path of the systemd unit to rewrite, or undefined when there is none. */
  systemdUnitPath?: string;
  /** Current systemd unit content, so an already-gateway unit is left untouched. */
  systemdUnit?: string;
  /**
   * Current container-gate `.env` content (from `.vetinari.local/` if present, else
   * the legacy `.sandcastle/`), or undefined when absent. Host-side secrets found
   * here are stripped so they stop riding into every agent container (ADR 0011).
   */
  containerEnv?: string;
}

/** The stripped rewrite of the container-gate `.env`: where it writes, its new content, and the keys removed. */
export interface EnvRewrite {
  path: string;
  content: string;
  stripped: string[];
}

/** The systemd-unit rewrite: where it writes and the new host-level gateway unit. */
export interface UnitRewrite {
  path: string;
  content: string;
}

export interface LayoutMigrationPlan {
  moves: Move[];
  /** The full new `.gitignore` content to write, or undefined when unchanged. */
  gitignore?: string;
  /** Human-facing warnings (deferred scope, etc.). */
  warnings: string[];
  /** Destinations that already exist — the migration is refused while non-empty. */
  conflicts: string[];
  /**
   * Absolute path of a stale `gateway.env` to delete, or undefined when none
   * exists. The gateway holds no secrets of its own (ADR 0002), so a `gateway.env`
   * left by the retired fold holds nothing legitimate and is removed.
   */
  gatewayEnvDelete?: string;
  /**
   * The systemd-unit rewrite into the host-level gateway service, or undefined when
   * there is no unit or it is already the gateway unit.
   */
  unit?: UnitRewrite;
  /**
   * The container-gate `.env` rewritten with its host-side secrets stripped, or
   * undefined when the `.env` is absent or already carries none.
   */
  envRewrite?: EnvRewrite;
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

/**
 * The host-level gateway systemd unit: no `WorkingDirectory` (it fronts every
 * project, not one), and `exec`ing the shared install's `gateway` command (ADR
 * 0003) in place of the retired per-project `dispatch` poller. It sources no
 * env file — the gateway holds no secrets of its own (ADR 0002); it reads each
 * project's credentials live from that project's base location. Constant, so
 * feeding a rewritten unit back in yields the same text (an idempotent rewrite).
 */
function gatewayUnit(): string {
  return [
    "[Unit]",
    "Description=vetinari gateway (host Telegram router)",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "ExecStart=/usr/bin/env bash -lc 'exec vetinari gateway'",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Rewrite the systemd unit from a per-project `dispatch` poller into the
 * host-level gateway service. Returns undefined when there is no unit to rewrite
 * or it is already the gateway unit (so a re-run changes nothing).
 */
function computeUnitRewrite(scan: LayoutScan): UnitRewrite | undefined {
  if (scan.systemdUnit === undefined || !scan.systemdUnitPath) return undefined;
  const content = gatewayUnit();
  if (scan.systemdUnit === content) return undefined;
  return { path: scan.systemdUnitPath, content };
}

/**
 * Strip every `VETINARI_TELEGRAM_*` assignment from a container-gate `.env`,
 * leaving every other line (the agent's own token, blanks, comments) verbatim.
 * Returns undefined when the `.env` is absent or carries none, so a re-run — where
 * the leak is already closed — plans nothing.
 */
function computeEnvRewrite(containerEnv: string | undefined): EnvRewrite | undefined {
  if (containerEnv === undefined) return undefined;
  const stripped: string[] = [];
  const kept = containerEnv.split("\n").filter((raw) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw.trim());
    if (m && m[1].startsWith(HOST_ONLY_ENV_PREFIX)) {
      stripped.push(m[1]);
      return false;
    }
    return true;
  });
  if (!stripped.length) return undefined;
  return { path: `${LOCAL_DIR}/${CONTAINER_ENV_FILE}`, content: kept.join("\n"), stripped };
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
  // The host-side secrets file lands under its new name in the same move (ADR 0011).
  for (const entry of scan.oldState ?? []) {
    if (entry === configBasename) continue;
    const destName = entry === OLD_SECRETS_FILE ? SECRETS_FILE : entry;
    addMove(`${OLD_DIR}/${entry}`, `${LOCAL_DIR}/${destName}`);
  }

  // A project already on the new layout still carries the old secrets-file name;
  // rename it in place `orchestrator.env` → `host.env` (ADR 0011).
  if ((scan.localState ?? []).includes(OLD_SECRETS_FILE)) {
    addMove(`${LOCAL_DIR}/${OLD_SECRETS_FILE}`, `${LOCAL_DIR}/${SECRETS_FILE}`);
  }

  const gitignore = planGitignore(scan.gitignore);

  const gatewayEnvDelete =
    scan.gatewayConfigDir && scan.gatewayEnv !== undefined ? join(scan.gatewayConfigDir, GATEWAY_ENV_FILE) : undefined;
  const unit = computeUnitRewrite(scan);
  const envRewrite = computeEnvRewrite(scan.containerEnv);

  const warnings: string[] = [];
  if (envRewrite) {
    warnings.push(
      `Stripped host-side secret(s) ${envRewrite.stripped.join(", ")} from the container gate .env — ` +
        `they belong only in host.env, never in a container. Rotate any bot token that was exposed there.`,
    );
  }

  return { moves, gitignore, warnings, conflicts, gatewayEnvDelete, unit, envRewrite };
}

export interface ApplyResult {
  moved: Move[];
  gitignoreUpdated: boolean;
  /** A stale gateway.env was deleted. */
  gatewayEnvDeleted: boolean;
  /** The systemd unit was rewritten into the gateway service. */
  unitRewritten: boolean;
  /** The container-gate `.env` was rewritten with its host-side secrets stripped. */
  envRewritten: boolean;
}

/**
 * Perform a plan against `baseDir`: the moves, the `.gitignore` edit, the deletion
 * of a stale `gateway.env`, and the systemd-unit rewrite. Refuses the WHOLE
 * migration if the plan carries conflicts, so a clobber never happens and the tree
 * is never left half-migrated. Each move re-checks its destination against the live
 * disk before renaming — a last guard against a stale scan. The gateway.env deletion
 * and unit write use the absolute host paths the plan carries (outside `baseDir`),
 * creating the unit's parent directory as needed.
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

  let gatewayEnvDeleted = false;
  if (plan.gatewayEnvDelete) {
    rmSync(plan.gatewayEnvDelete, { force: true });
    gatewayEnvDeleted = true;
  }

  let unitRewritten = false;
  if (plan.unit) {
    mkdirSync(dirname(plan.unit.path), { recursive: true });
    writeFileSync(plan.unit.path, plan.unit.content);
    unitRewritten = true;
  }

  // After the moves — so a legacy `.env` has already landed at its destination —
  // overwrite the container gate with its host-side secrets stripped out.
  let envRewritten = false;
  if (plan.envRewrite) {
    const dest = resolve(baseDir, plan.envRewrite.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, plan.envRewrite.content);
    envRewritten = true;
  }

  return { moved: plan.moves, gitignoreUpdated, gatewayEnvDeleted, unitRewritten, envRewritten };
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
 * Where the host-level dispatch systemd unit lives. `VETINARI_SYSTEMD_UNIT`
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

/**
 * Probe `baseDir` into a `LayoutScan` — the filesystem read that lives at the
 * edge so the planner stays pure. The legacy config location comes from the same
 * resolver `loadConfig` uses, so migrate and resolution never disagree on what
 * counts as a deprecated config. `existing` lists everything already under the
 * two destination dirs, so any would-be clobber surfaces as a conflict.
 *
 * The gateway-coupled inputs are host-level, not under `baseDir`: the gateway
 * config dir and its current `gateway.env` (so a stale one is deleted), and the
 * systemd unit (for the rewrite). All read here so the planner stays a pure
 * function of them.
 */
export function scanLayout(baseDir: string): LayoutScan {
  const listDir = (rel: string): string[] => {
    try {
      return readdirSync(resolve(baseDir, rel));
    } catch {
      return [];
    }
  };
  const gwDir = gatewayConfigDir();
  const unitPath = systemdUnitPath();
  return {
    legacyConfig: resolveConfigPath(baseDir)?.deprecatedFrom,
    oldState: listDir(OLD_DIR),
    localState: listDir(LOCAL_DIR),
    gitignore: readOrUndef(resolve(baseDir, ".gitignore")),
    existing: [
      ...listDir(CANONICAL_DIR).map((e) => `${CANONICAL_DIR}/${e}`),
      ...listDir(LOCAL_DIR).map((e) => `${LOCAL_DIR}/${e}`),
    ],
    gatewayConfigDir: gwDir,
    gatewayEnv: readOrUndef(join(gwDir, GATEWAY_ENV_FILE)),
    systemdUnitPath: unitPath,
    systemdUnit: readOrUndef(unitPath),
    // The container gate wherever it currently lives — already-migrated dir first,
    // else the legacy one it is about to move out of.
    containerEnv:
      readOrUndef(resolve(baseDir, `${LOCAL_DIR}/${CONTAINER_ENV_FILE}`)) ??
      readOrUndef(resolve(baseDir, `${OLD_DIR}/${CONTAINER_ENV_FILE}`)),
  };
}

/**
 * A human-facing summary of a plan: the moves, the `.gitignore` edit, warnings,
 * and — when the plan is refused — the conflicting destinations. Pure, so the
 * CLI prints the same text for both `--dry-run` (the plan) and a real run (what
 * it did). An empty plan reads as "nothing to do".
 */
export function describeMigration(plan: LayoutMigrationPlan): string {
  const lines: string[] = [];

  if (plan.conflicts.length) {
    lines.push(`migrate REFUSED — ${plan.conflicts.length} destination(s) already exist:`);
    for (const c of plan.conflicts) lines.push(`  ✗ ${c}`);
    lines.push("Move or remove them, then re-run. Nothing will be changed until they are gone.");
  }

  const changesNothing =
    !plan.moves.length &&
    plan.gitignore === undefined &&
    !plan.conflicts.length &&
    !plan.gatewayEnvDelete &&
    !plan.unit &&
    !plan.envRewrite;
  if (changesNothing) {
    return "Nothing to do — this project is already on the vetinari/ + .vetinari.local/ layout.";
  }

  if (plan.moves.length) {
    lines.push(`Moves (${plan.moves.length}):`);
    for (const m of plan.moves) lines.push(`  ${m.from} → ${m.to}`);
  }
  if (plan.gitignore !== undefined) lines.push("Update .gitignore to exclude .vetinari.local/ (and keep .sandcastle/ ignored).");
  if (plan.gatewayEnvDelete) lines.push(`Delete the stale gateway.env — the gateway holds no secrets of its own (${plan.gatewayEnvDelete}).`);
  if (plan.unit) lines.push(`Rewrite the systemd unit into the host-level gateway service (${plan.unit.path}).`);
  if (plan.envRewrite) lines.push(`Strip host-side secret(s) from the container gate .env: ${plan.envRewrite.stripped.join(", ")}.`);
  for (const w of plan.warnings) lines.push(`⚠ ${w}`);

  return lines.join("\n");
}
