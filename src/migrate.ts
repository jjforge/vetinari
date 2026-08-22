/**
 * Move a project from the old single-`.sandcastle/` layout onto the committed
 * `sandcastle/` + excluded `.sandcastle.local/` split (ADR 0001).
 *
 * Split into a pure planner and an apply step, mirroring `carve` (a pure planner
 * over plain data) and `archive` (filesystem work that reports what it did):
 * `computeLayoutMigration` turns a described on-disk state into a plan — the
 * moves, the `.gitignore` edit, the gateway-config fold, and the systemd-unit
 * rewrite — touching nothing; `applyLayoutMigration` performs that plan against a
 * real directory.
 *
 * The plan covers the whole migration: the LAYOUT MOVE (config → `sandcastle/`,
 * old `.sandcastle/` state → `.sandcastle.local/`, `.gitignore`) plus the
 * gateway-coupled parts E1 deferred to E3 (#14) — folding a project's host-only
 * `orchestrator.env` (Telegram token, `GIT_CONFIG_GLOBAL`) up into the gateway's
 * host-level config, and rewriting the systemd unit from a per-project `dispatch`
 * poller into the host-level gateway service. Every part is idempotent and
 * non-clobbering: a re-run changes nothing, and a value that would be overwritten
 * is refused as a conflict rather than clobbered.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConfigPath } from "./config.ts";
import { gatewayConfigDir } from "./registry.ts";

const CANONICAL_DIR = "sandcastle";
const LOCAL_DIR = ".sandcastle.local";
const OLD_DIR = ".sandcastle";

/** The gateway's host-level env file, folded from each project's `orchestrator.env`. */
const GATEWAY_ENV_FILE = "gateway.env";

/** A single filesystem move, both paths relative to the project root. */
export interface Move {
  from: string;
  to: string;
}

/** A description of the relevant on-disk state, produced by the CLI at the edge. */
export interface LayoutScan {
  /**
   * The deprecated config location that exists, relative to the root (e.g.
   * ".sandcastle/config.mts" or "sandcastle-tdd.config.mts"). Undefined when the
   * config is already canonical or absent.
   */
  legacyConfig?: string;
  /** Top-level entry names directly under `.sandcastle/` (empty if none). */
  oldState?: string[];
  /** Current `.gitignore` content, or undefined when there is no `.gitignore`. */
  gitignore?: string;
  /**
   * Relative paths that already exist on disk. A move whose destination is here
   * is a conflict — refused rather than allowed to clobber.
   */
  existing?: string[];
  /**
   * The project's host-only `orchestrator.env` content (the old `.sandcastle/`
   * poller env — Telegram token, `GIT_CONFIG_GLOBAL`), or undefined when absent.
   * Its keys are folded up into the gateway's host-level config (E3, #14).
   */
  orchestratorEnv?: string;
  /** The gateway's host-level config directory — where `orchestrator.env` folds to. */
  gatewayConfigDir?: string;
  /** Current gateway host-env content, for a non-clobbering, idempotent fold. */
  gatewayEnv?: string;
  /** Absolute path of the systemd unit to rewrite, or undefined when there is none. */
  systemdUnitPath?: string;
  /** Current systemd unit content, so an already-gateway unit is left untouched. */
  systemdUnit?: string;
}

/** The gateway host-env fold: where it writes, the merged content, and the keys added. */
export interface HostConfigFold {
  path: string;
  content: string;
  folded: string[];
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
   * The `orchestrator.env` → gateway host-config fold, or undefined when there is
   * nothing to fold (no `orchestrator.env`, or every key is already present).
   */
  hostConfig?: HostConfigFold;
  /**
   * The systemd-unit rewrite into the host-level gateway service, or undefined when
   * there is no unit or it is already the gateway unit.
   */
  unit?: UnitRewrite;
}

/** Destination for a config move: `sandcastle/config` keeps the source extension. */
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
 * Read the simple `KEY=VALUE` assignments an env file carries into ordered pairs
 * (optional `export`, optional quotes, `#` comments skipped). Not a full shell —
 * just enough to fold an `orchestrator.env` up into the gateway config. Order is
 * preserved so the folded output is deterministic.
 */
function parseEnvPairs(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pairs.push([m[1], value]);
  }
  return pairs;
}

/**
 * Fold the project's `orchestrator.env` up into the gateway's host-level env,
 * merging by key: a key not yet in the gateway env is added; a key already there
 * with the SAME value is a no-op (so re-running migrate changes nothing); a key
 * there with a DIFFERENT value is a conflict — refused rather than clobbered, so a
 * second project's secret never silently overwrites the first's. Returns the merged
 * fold (undefined when nothing is added) and the conflicting keys.
 */
function computeHostConfigFold(scan: LayoutScan): { fold?: HostConfigFold; conflicts: string[] } {
  const conflicts: string[] = [];
  if (!scan.orchestratorEnv || !scan.gatewayConfigDir) return { conflicts };

  const path = join(scan.gatewayConfigDir, GATEWAY_ENV_FILE);
  const current = scan.gatewayEnv ?? "";
  const existing = new Map(parseEnvPairs(current));

  const folded: string[] = [];
  const additions: string[] = [];
  for (const [key, value] of parseEnvPairs(scan.orchestratorEnv)) {
    if (existing.has(key)) {
      if (existing.get(key) !== value) conflicts.push(`${GATEWAY_ENV_FILE}:${key}`);
      continue;
    }
    // Guard against the same key appearing twice in the source env.
    if (folded.includes(key)) continue;
    folded.push(key);
    additions.push(`${key}=${value}`);
  }

  if (!additions.length) return { conflicts };
  let content = current;
  if (content.length && !content.endsWith("\n")) content += "\n";
  content += additions.map((a) => `${a}\n`).join("");
  return { fold: { path, content, folded }, conflicts };
}

/**
 * The host-level gateway systemd unit: no `WorkingDirectory` (it fronts every
 * project, not one), sourcing the folded host-level env, and `exec`ing the shared
 * install's `gateway` command (ADR 0003) in place of the retired per-project
 * `dispatch` poller. Deterministic in its one input — the gateway env path — so
 * feeding a rewritten unit back in yields the same text (an idempotent rewrite).
 */
function gatewayUnit(gatewayEnvPath: string): string {
  return [
    "[Unit]",
    "Description=sandcastle-tdd gateway (host Telegram router)",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=/usr/bin/env bash -lc 'set -a; source ${gatewayEnvPath}; set +a; exec sandcastle-tdd gateway'`,
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
  if (scan.systemdUnit === undefined || !scan.systemdUnitPath || !scan.gatewayConfigDir) return undefined;
  const content = gatewayUnit(join(scan.gatewayConfigDir, GATEWAY_ENV_FILE));
  if (scan.systemdUnit === content) return undefined;
  return { path: scan.systemdUnitPath, content };
}

export function computeLayoutMigration(scan: LayoutScan): LayoutMigrationPlan {
  const existing = new Set(scan.existing ?? []);
  const moves: Move[] = [];
  const conflicts: string[] = [];
  const addMove = (from: string, to: string) => (existing.has(to) ? conflicts.push(to) : moves.push({ from, to }));

  // Config → committed `sandcastle/`. When it lived inside `.sandcastle/`, it is
  // pulled out here so the state sweep below does not also move it.
  let configBasename: string | undefined;
  if (scan.legacyConfig) {
    if (scan.legacyConfig.startsWith(`${OLD_DIR}/`)) configBasename = scan.legacyConfig.slice(OLD_DIR.length + 1);
    addMove(scan.legacyConfig, configDest(scan.legacyConfig));
  }

  // Everything else under `.sandcastle/` (state + secrets) → excluded `.sandcastle.local/`.
  for (const entry of scan.oldState ?? []) {
    if (entry === configBasename) continue;
    addMove(`${OLD_DIR}/${entry}`, `${LOCAL_DIR}/${entry}`);
  }

  const gitignore = planGitignore(scan.gitignore);

  const { fold, conflicts: foldConflicts } = computeHostConfigFold(scan);
  conflicts.push(...foldConflicts);
  const unit = computeUnitRewrite(scan);

  return { moves, gitignore, warnings: [], conflicts, hostConfig: fold, unit };
}

export interface ApplyResult {
  moved: Move[];
  gitignoreUpdated: boolean;
  /** The gateway host-env fold was written. */
  hostConfigWritten: boolean;
  /** The systemd unit was rewritten into the gateway service. */
  unitRewritten: boolean;
}

/**
 * Perform a plan against `baseDir`: the moves, the `.gitignore` edit, the
 * `orchestrator.env` → gateway host-config fold, and the systemd-unit rewrite.
 * Refuses the WHOLE migration if the plan carries conflicts, so a clobber never
 * happens and the tree is never left half-migrated. Each move re-checks its
 * destination against the live disk before renaming — a last guard against a stale
 * scan. The host-config and unit writes use the absolute host paths the plan
 * carries (outside `baseDir`), creating their parent directories as needed.
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

  const writeHost = (target: { path: string; content: string } | undefined) => {
    if (!target) return false;
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, target.content);
    return true;
  };
  const hostConfigWritten = writeHost(plan.hostConfig);
  const unitRewritten = writeHost(plan.unit);

  return { moved: plan.moves, gitignoreUpdated, hostConfigWritten, unitRewritten };
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
 * Where the host-level dispatch systemd unit lives. `SANDCASTLE_SYSTEMD_UNIT`
 * overrides it (the seam tests point at a tmp file); otherwise it follows the
 * systemd user-unit convention, `$XDG_CONFIG_HOME/systemd/user` or
 * `~/.config/systemd/user`, mirroring the README's install path.
 */
export function systemdUnitPath(): string {
  const override = process.env.SANDCASTLE_SYSTEMD_UNIT;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "systemd", "user", "sandcastle-dispatch.service");
}

/**
 * Probe `baseDir` into a `LayoutScan` — the filesystem read that lives at the
 * edge so the planner stays pure. The legacy config location comes from the same
 * resolver `loadConfig` uses, so migrate and resolution never disagree on what
 * counts as a deprecated config. `existing` lists everything already under the
 * two destination dirs, so any would-be clobber surfaces as a conflict.
 *
 * The gateway-coupled inputs are host-level, not under `baseDir`: the project's
 * old `.sandcastle/orchestrator.env` (the fold source), the gateway config dir
 * and its current `gateway.env` (for a non-clobbering fold), and the systemd unit
 * (for the rewrite). All read here so the planner stays a pure function of them.
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
    gitignore: readOrUndef(resolve(baseDir, ".gitignore")),
    existing: [
      ...listDir(CANONICAL_DIR).map((e) => `${CANONICAL_DIR}/${e}`),
      ...listDir(LOCAL_DIR).map((e) => `${LOCAL_DIR}/${e}`),
    ],
    orchestratorEnv: readOrUndef(resolve(baseDir, OLD_DIR, "orchestrator.env")),
    gatewayConfigDir: gwDir,
    gatewayEnv: readOrUndef(join(gwDir, GATEWAY_ENV_FILE)),
    systemdUnitPath: unitPath,
    systemdUnit: readOrUndef(unitPath),
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
    !plan.moves.length && plan.gitignore === undefined && !plan.conflicts.length && !plan.hostConfig && !plan.unit;
  if (changesNothing) {
    return "Nothing to do — this project is already on the sandcastle/ + .sandcastle.local/ layout.";
  }

  if (plan.moves.length) {
    lines.push(`Moves (${plan.moves.length}):`);
    for (const m of plan.moves) lines.push(`  ${m.from} → ${m.to}`);
  }
  if (plan.gitignore !== undefined) lines.push("Update .gitignore to exclude .sandcastle.local/ (and keep .sandcastle/ ignored).");
  if (plan.hostConfig) {
    lines.push(`Fold orchestrator.env into the gateway host config (${plan.hostConfig.path}):`);
    for (const k of plan.hostConfig.folded) lines.push(`  + ${k}`);
  }
  if (plan.unit) lines.push(`Rewrite the systemd unit into the host-level gateway service (${plan.unit.path}).`);
  for (const w of plan.warnings) lines.push(`⚠ ${w}`);

  return lines.join("\n");
}
