import { spawn } from "node:child_process";
import type { StructuredPruneClosure } from "./prune.ts";

/**
 * Preview a prune by shelling the project's own `prune <issue> --dry-run` via the
 * shared install in its root (ADR 0003): it computes the closure against that
 * project's real `blockedBy` graph and prints it, changing nothing. Returns the
 * printed closure, or null when the child fails. Mirrors the Telegram gateway's
 * `prunePreview` — the same dumb-router routing the aggregated dashboard uses.
 */
export function shellPrunePreview(projectRoot: string, taskId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "prune", taskId, "--dry-run"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() || null : null));
  });
}

/**
 * The prune closure the inline panel discloses before a prune — the target, the
 * dependents that would leave, the banked (merged/mergeable) work kept, and the
 * remaining waves. It is exactly the `StructuredPruneClosure` the CLI's dry-run
 * emits (E2), so the panel names each member and its fate without re-deriving
 * anything the project's own install already computed.
 */
export type PruneClosure = StructuredPruneClosure;

const CLOSURE_PREFIX = "prune-closure ";

/**
 * Pull the structured closure out of the project's own `prune <issue> --dry-run`
 * output: it prints a machine-readable `prune-closure {json}` line (E2) alongside
 * the human prose, so this just finds that line and parses it — no coupling to
 * the prose's wording. Returns null when the line is absent (an install predating
 * E2) or unparseable, which the route surfaces as a 502. Pure so it is unit-tested
 * at the seam; the live shell (`shellPruneClosure`) is the only caller.
 */
export function parsePruneClosure(previewText: string): PruneClosure | null {
  const line = previewText.split("\n").find((l) => l.startsWith(CLOSURE_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(CLOSURE_PREFIX.length)) as PruneClosure;
  } catch {
    return null;
  }
}

/**
 * The default `pruneClosure`: shell the selected project's own `prune --dry-run`
 * (the same dumb-router routing `shellPrunePreview` uses) and parse the structured
 * closure out of it. Returns null when the child fails (e.g. no campaign running)
 * or emits no closure line, which the route surfaces as a 502 for the panel to
 * report.
 */
export async function shellPruneClosure(projectRoot: string, taskId: string): Promise<PruneClosure | null> {
  const previewText = await shellPrunePreview(projectRoot, taskId);
  return previewText == null ? null : parsePruneClosure(previewText);
}
