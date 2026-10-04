/**
 * `vetinari install` — put the CLI on PATH for every project on this host by writing
 * a `vetinari` wrapper script into a PATH directory (default `~/.local/bin`). The
 * shell-side counterpart to `gateway install`: it reuses the same launch resolution
 * (`currentLaunchSelf`) — the tsx loader args and this checkout's `src/cli.mts` — but
 * takes `node` from the operator's PATH instead of pinning it, since an interactive
 * shell has a PATH where systemd does not. So a node upgrade needs no rerun; only a
 * moved checkout does. No `npx`, so it works from a project with no `node_modules`.
 *
 * Pure planner (`renderWrapper`, `planPathInstall`, `describePathInstall`) + edge IO
 * (`resolvedWrapper`, `applyPathInstall`), like init/migrate.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { currentLaunchSelf, type LaunchSelf } from "./migrate.ts";

/** Line 2 of every wrapper `vetinari install` writes — how a rerun recognizes its own file. */
export const WRAPPER_MARKER = "# vetinari-install-wrapper: written by `vetinari install` — re-run it to rewrite this file";

/** An argument POSIX sh reads literally unquoted — a clean path stays as it is. */
const SH_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote `arg` unless it is already shell-safe (`'` written as `'\''`). Pure. */
function shQuoteArg(arg: string): string {
  if (SH_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The wrapper script for `launch`: `#!/bin/sh`, the marker, then one `exec node
 * <execArgv…> <argv1> "$@"`. `node` is the bare word (the operator's PATH picks the
 * version); `launch.execPath` is deliberately not used. Pure.
 */
export function renderWrapper(launch: LaunchSelf): string {
  const argv = [...launch.execArgv, launch.argv1].map(shQuoteArg);
  return ["#!/bin/sh", WRAPPER_MARKER, `exec node ${argv.join(" ")} "$@"`, ""].join("\n");
}

/**
 * The wrapper for THIS install: `launch` (default: how this process was started) with
 * `argv1` resolved through any symlink — so installing via `npx vetinari install`, whose
 * `argv1` sits in npm's npx cache, still points at the real `src/cli.mts` and survives
 * a cache clear. Reads the filesystem; the edge behind `renderWrapper`.
 */
export function resolvedWrapper(launch: LaunchSelf = currentLaunchSelf()): string {
  return renderWrapper({ ...launch, argv1: realpathSync(launch.argv1) });
}

/**
 * What `vetinari install` does to `<dir>/vetinari`: `write` (nothing there), `rewrite`
 * (a wrapper it wrote before — always rewritten, so a rerun after moving the checkout
 * repoints it), `overwrite` (a foreign file, under `--force`), or `refuse` (a foreign
 * file without it).
 */
export type PathInstallAction = "write" | "rewrite" | "overwrite" | "refuse";

export interface PathInstallPlan {
  target: string;
  content: string;
  action: PathInstallAction;
  /** The refusal message, set only when `action` is `refuse`. */
  refusal?: string;
  /** Whether `dir` is one of the `PATH` entries — the wrapper is installed either way. */
  onPath: boolean;
  /** When off PATH: the line to add to the shell profile (`fish_add_path` under fish). */
  profileLine?: string;
}

export interface PathInstallInput {
  /** The absolute directory the wrapper goes in. */
  dir: string;
  /** The wrapper text to write (`resolvedWrapper()`). */
  content: string;
  /** The current contents of `<dir>/vetinari`, if it exists. */
  existing?: string;
  force: boolean;
  env: { PATH?: string; SHELL?: string };
}

const wrapperPath = (dir: string): string => join(dir, "vetinari");

/** Plan an install of `content` as `<dir>/vetinari`. Pure. */
export function planPathInstall(input: PathInstallInput): PathInstallPlan {
  const { dir, content, existing, env } = input;
  const target = wrapperPath(dir);
  // resolve() normalizes a trailing slash away, so `/x/bin/` matches `/x/bin`.
  const onPath = (env.PATH ?? "").split(":").some((entry) => entry !== "" && resolve(entry) === resolve(dir));
  const profileLine = onPath ? undefined : env.SHELL?.endsWith("fish") ? `fish_add_path ${dir}` : `export PATH="${dir}:$PATH"`;
  const base = { target, content, onPath, profileLine };
  if (existing === undefined) return { ...base, action: "write" };
  if (existing.includes(WRAPPER_MARKER)) return { ...base, action: "rewrite" };
  if (input.force) return { ...base, action: "overwrite" };
  return {
    ...base,
    action: "refuse",
    refusal: `${target} already exists and was not written by \`vetinari install\` — refusing to replace it. Re-run with --force to overwrite it.`,
  };
}

/**
 * What the operator sees, after a write or a dry run (gateway install's shape): the
 * target, the wrapper, what happened, then — when the dir is off PATH — the profile
 * line that puts it on. Pure.
 */
export function describePathInstall(plan: PathInstallPlan, opts: { dryRun: boolean }): string {
  const lines = [`vetinari install → ${plan.target}`, "", plan.content];
  if (opts.dryRun) lines.push("(dry run — nothing was written)");
  else
    lines.push(
      `Wrote ${plan.target}. Re-run \`vetinari install\` after moving this checkout — a node upgrade needs no rerun, since the wrapper takes node from PATH.`,
    );
  if (plan.profileLine)
    lines.push("", `${dirname(plan.target)} is not on your PATH — add this line to your shell profile:`, `  ${plan.profileLine}`);
  return lines.join("\n");
}

/** The current contents of `<dir>/vetinari`, or undefined when there is none. Edge IO. */
export function readExistingWrapper(dir: string): string | undefined {
  const target = wrapperPath(dir);
  return existsSync(target) ? readFileSync(target, "utf8") : undefined;
}

/** Write the planned wrapper: create the dir, write the file, make it 0755. Edge IO. */
export function applyPathInstall(plan: PathInstallPlan): void {
  mkdirSync(dirname(plan.target), { recursive: true });
  writeFileSync(plan.target, plan.content);
  // chmod after the write: a replaced file keeps its old mode, and umask trims a new one.
  chmodSync(plan.target, 0o755);
}
