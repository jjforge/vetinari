import { spawn } from "node:child_process";
import type { StructuredGraftClosure } from "./graft.ts";

/**
 * Preview a graft by shelling the project's own `graft <ids…> --dry-run` via the
 * shared install in its root (ADR 0003): it computes the placement against that
 * project's real campaign + `blockedBy` graph and prints it, changing nothing.
 * Returns the printed placement, or null when the child fails. The additive mirror
 * of `shellPrunePreview` — the same dumb-router routing the aggregated dashboard
 * uses. `graft` is variadic, so this carries a *set* of ids, not a single target.
 */
export function shellGraftPreview(projectRoot: string, taskIds: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "graft", ...taskIds, "--dry-run"], {
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
 * The graft closure the inline panel discloses before a graft — the requested ids,
 * where each lands, the resulting waves, and any whole-batch rejection naming the
 * offenders. It is exactly the `StructuredGraftClosure` the CLI's dry-run emits, so
 * the panel names each id's fate without re-deriving anything the project's own
 * install already computed.
 */
export type GraftClosure = StructuredGraftClosure;

const CLOSURE_PREFIX = "graft-closure ";

/**
 * Pull the structured closure out of the project's own `graft <ids…> --dry-run`
 * output: it prints a machine-readable `graft-closure {json}` line alongside the
 * human prose, so this just finds that line and parses it — no coupling to the
 * prose's wording. Returns null when the line is absent (an install predating the
 * closure) or unparseable, which the route surfaces as a 502. Pure so it is
 * unit-tested at the seam; the live shell (`shellGraftClosure`) is the only caller.
 */
export function parseGraftClosure(previewText: string): GraftClosure | null {
  const line = previewText.split("\n").find((l) => l.startsWith(CLOSURE_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(CLOSURE_PREFIX.length)) as GraftClosure;
  } catch {
    return null;
  }
}

/**
 * The default `graftClosure`: shell the selected project's own `graft <ids…>
 * --dry-run` (the same dumb-router routing `shellGraftPreview` uses) and parse the
 * structured closure out of it. Returns null when the child fails (e.g. no campaign
 * running) or emits no closure line, which the route surfaces as a 502 for the
 * panel to report.
 */
export async function shellGraftClosure(projectRoot: string, taskIds: string[]): Promise<GraftClosure | null> {
  const previewText = await shellGraftPreview(projectRoot, taskIds);
  return previewText == null ? null : parseGraftClosure(previewText);
}
