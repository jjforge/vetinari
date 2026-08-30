/**
 * Install / uninstall the Vetinari status line into a project's committed
 * `.claude/settings.json`, wrapping — never replacing — whatever status line was
 * already configured.
 *
 * Sibling of `init`/`migrate`: a pure planner (`computeInstall`/`computeUninstall`)
 * that transforms a parsed settings object, with the filesystem read/write kept at
 * the CLI edge. The wrapping trick is self-contained in the installed command
 * string: a previously-configured status line is base64-encoded into a
 * `--base-b64` suffix, so `vetinari statusline` runs it for line 1 and prints the
 * 🏰 campaign line underneath (see `composeStatusLine`). Uninstall decodes that
 * suffix to restore the original command exactly, or drops `statusLine` entirely
 * when there was nothing to restore.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** The Claude Code `statusLine` block (only the fields we touch). */
export interface StatusLineBlock {
  type?: string;
  command?: string;
  refreshInterval?: number;
}

/** The slice of `.claude/settings.json` we read and write; other keys pass through. */
export interface Settings {
  statusLine?: StatusLineBlock;
  [key: string]: unknown;
}

/** The default command a fresh install points at, per the README. */
export const DEFAULT_RUN_COMMAND = "npx vetinari statusline";

/** The flag that carries the wrapped base command, base64-encoded, in the installed command. */
const BASE_FLAG = "--base-b64";

/** A command is one of ours when it invokes `vetinari … statusline` in any form. */
const VETINARI_STATUSLINE = /\bvetinari\b.*\bstatusline\b/;

/**
 * The command string to write into `statusLine.command`: the vetinari invocation,
 * plus the previously-configured status line encoded as a `--base-b64` suffix when
 * there is one to wrap. Pure.
 */
export function buildInstalledCommand(runCommand: string, base?: string): string {
  if (!base) return runCommand;
  return `${runCommand} ${BASE_FLAG} ${Buffer.from(base, "utf8").toString("base64")}`;
}

/**
 * Split an installed command back into its vetinari invocation and the wrapped
 * base command, or `null` when the command is not a vetinari status line at all
 * (so the planner leaves a user's unrelated custom line untouched). Pure.
 */
export function parseInstalledCommand(command: string): { runCommand: string; base?: string } | null {
  if (!VETINARI_STATUSLINE.test(command)) return null;
  const idx = command.indexOf(`${BASE_FLAG} `);
  if (idx < 0) return { runCommand: command.trim(), base: undefined };
  const runCommand = command.slice(0, idx).trim();
  const b64 = command.slice(idx + BASE_FLAG.length + 1).trim();
  return { runCommand, base: Buffer.from(b64, "base64").toString("utf8") };
}

/** Polling keeps the line live during a run — Claude Code has no event for a log change. */
const DEFAULT_REFRESH_INTERVAL = 5;

/**
 * Plan the install against a parsed `settings` object. When a non-vetinari status
 * line is already configured it is preserved as the wrapped base (line 1); when
 * ours is already installed the plan is a no-op that reports the still-wrapped base.
 * Returns a fresh settings object — the input is never mutated. Pure.
 */
export function computeInstall(settings: Settings, opts: { runCommand: string; inheritedBase?: string; shadowedByLocal?: boolean }): { settings: Settings; base?: string; alreadyInstalled: boolean; shadowedByLocal: boolean } {
  // A statusLine in the higher-precedence `.claude/settings.local.json` owns the
  // rendered block wholesale, so any write here would be inert. Skip it rather
  // than leave a shadowed entry that has no effect (see docs/operations.md).
  if (opts.shadowedByLocal) {
    return { settings, alreadyInstalled: false, shadowedByLocal: true };
  }

  const current = settings.statusLine;
  const alreadyOurs = current?.command ? parseInstalledCommand(current.command) : null;

  // Already installed → keep it exactly as-is (never re-wrap our own command).
  if (alreadyOurs) {
    return { settings, base: alreadyOurs.base, alreadyInstalled: true, shadowedByLocal: false };
  }

  // The status line to wrap as line 1: the project's own if it has one, else the
  // one it inherits from a lower-precedence layer (user settings) — which the
  // project write would otherwise silently shadow, dropping its colours. Ours
  // never becomes its own base.
  const inherited = opts.inheritedBase && !parseInstalledCommand(opts.inheritedBase) ? opts.inheritedBase : undefined;
  const base = current?.command || inherited || undefined;
  const refreshInterval = current?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
  const statusLine: StatusLineBlock = { type: "command", command: buildInstalledCommand(opts.runCommand, base), refreshInterval };
  return { settings: { ...settings, statusLine }, base, alreadyInstalled: false, shadowedByLocal: false };
}

/**
 * Plan the uninstall against a parsed `settings` object. When ours is installed it
 * is peeled back to the wrapped base command (restoring the user's own line), or
 * `statusLine` is dropped entirely when there was nothing under it. A status line
 * that is not ours is left untouched. Returns a fresh settings object — the input
 * is never mutated. Pure.
 */
export function computeUninstall(settings: Settings, opts: { inheritedBase?: string; shadowedByLocal?: boolean } = {}): { settings: Settings; restored?: string; wasInstalled: boolean; shadowedByLocal: boolean } {
  // Symmetric to install: while `.claude/settings.local.json` owns a statusLine it
  // renders that block, so removing ours here would not be visible. Report the
  // shadow and change nothing.
  if (opts.shadowedByLocal) return { settings, wasInstalled: false, shadowedByLocal: true };

  const ours = settings.statusLine?.command ? parseInstalledCommand(settings.statusLine.command) : null;
  if (!ours) return { settings, wasInstalled: false, shadowedByLocal: false };

  const { statusLine, ...rest } = settings;
  // Drop the project statusLine entirely when there was nothing under it, or when
  // what we wrapped was the inherited (user-level) line — writing it back into the
  // project would shadow that very layer with a redundant copy; dropping restores
  // the original inheritance instead. Otherwise restore the project's own line.
  if (ours.base === undefined || ours.base === opts.inheritedBase) return { settings: rest, wasInstalled: true, shadowedByLocal: false };

  const restored: StatusLineBlock = { ...statusLine, type: "command", command: ours.base };
  return { settings: { ...rest, statusLine: restored }, restored: ours.base, wasInstalled: true, shadowedByLocal: false };
}

/**
 * Combine a wrapped base status line (line 1, verbatim — it may itself be several
 * lines) with the 🏰 campaign line under it. When the base produced nothing (empty
 * or absent) vetinari's own context line stands in for line 1 instead, so a run
 * without a wrapped line still gets a full bar. Empty parts are dropped. Pure and
 * the single source of the wrapping rule `runStatusLine` applies. Pure.
 */
export function composeStatusLine(baseOutput: string | undefined, ownContextLine: string, campaignLine: string): string {
  const top = baseOutput?.trim() ? baseOutput.replace(/\n+$/, "") : ownContextLine;
  return [top, campaignLine].filter(Boolean).join("\n");
}

/** Human-facing summary of an install plan, for both the report and a dry run. Pure. */
export function describeInstall(result: { base?: string; alreadyInstalled: boolean; shadowedByLocal?: boolean }, path: string): string {
  if (result.shadowedByLocal) {
    return `A statusLine in ${LOCAL_SETTINGS_REL} takes precedence over ${path}, so a project-level install would be shadowed and never render. Skipped — nothing was written. Remove the statusLine from ${LOCAL_SETTINGS_REL} (or add the 🏰 line there yourself), since ${LOCAL_SETTINGS_REL} is the layer Claude Code renders.`;
  }
  if (result.alreadyInstalled) {
    return `The Vetinari status line is already installed in ${path}${result.base ? ` (wrapping your existing status line).` : "."}`;
  }
  if (result.base) {
    return `Installed the Vetinari status line into ${path}, wrapping your existing status line (kept as line 1, with the 🏰 campaign line under it).`;
  }
  return `Installed the Vetinari status line into ${path}.`;
}

/** Human-facing summary of an uninstall plan, for both the report and a dry run. Pure. */
export function describeUninstall(result: { restored?: string; wasInstalled: boolean; shadowedByLocal?: boolean }, path: string): string {
  if (result.shadowedByLocal) {
    return `A statusLine in ${LOCAL_SETTINGS_REL} takes precedence over ${path}, so nothing in ${path} is rendered to uninstall. Edit ${LOCAL_SETTINGS_REL} directly to change the line Claude Code shows.`;
  }
  if (!result.wasInstalled) return `No Vetinari status line to uninstall in ${path} — nothing changed.`;
  if (result.restored) return `Uninstalled the Vetinari status line from ${path}, restoring your previous status line.`;
  return `Uninstalled the Vetinari status line from ${path}.`;
}

/**
 * Read and parse `.claude/settings.json` under `baseDir` — the edge IO kept out of
 * the pure planner. A missing file is an empty settings object; a malformed file
 * throws (we must not silently discard a user's settings by overwriting them).
 */
export function readSettings(baseDir: string): Settings {
  const path = settingsPath(baseDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  return JSON.parse(text) as Settings;
}

/** Write `settings` back to `.claude/settings.json` under `baseDir` (pretty, trailing newline). */
export function writeSettings(baseDir: string, settings: Settings): void {
  const path = settingsPath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/** The committed project-level settings file, relative to the project root. */
export const SETTINGS_REL = ".claude/settings.json";
const settingsPath = (baseDir: string) => resolve(baseDir, SETTINGS_REL);

/** The uncommitted local settings file — higher precedence than `SETTINGS_REL`. */
export const LOCAL_SETTINGS_REL = ".claude/settings.local.json";

/**
 * Whether `.claude/settings.local.json` under `baseDir` owns a `statusLine`. Claude
 * Code renders the whole `statusLine` block from the highest-precedence layer, so a
 * `statusLine` here shadows any write to `SETTINGS_REL` — install/uninstall use this
 * to warn instead of writing an inert entry. Best effort: false when the file is
 * missing, has no `statusLine`, or fails to parse (a malformed local file must not
 * block wiring the committed layer).
 */
export function localStatusLineShadows(baseDir: string): boolean {
  try {
    const text = readFileSync(resolve(baseDir, LOCAL_SETTINGS_REL), "utf8");
    if (!text.trim()) return false;
    return (JSON.parse(text) as Settings).statusLine !== undefined;
  } catch {
    return false;
  }
}

/**
 * The `statusLine.command` a project inherits from the user's `~/.claude/settings.json`
 * — the line Claude Code renders when the project has none of its own, and the one a
 * project-level install would otherwise shadow. Returned so install can wrap it as
 * line 1 (keeping its colours). Best effort: undefined when there is no user settings
 * file, no status line in it, or it fails to parse.
 */
export function readInheritedStatusLine(): string | undefined {
  try {
    const text = readFileSync(resolve(homedir(), SETTINGS_REL), "utf8");
    const parsed = JSON.parse(text) as Settings;
    const command = parsed.statusLine?.command;
    return typeof command === "string" && command.trim() ? command : undefined;
  } catch {
    return undefined;
  }
}
