import { spawn } from "node:child_process";
import type { StructuredCarveClosure } from "./carve.ts";

/**
 * Preview a carve by shelling the project's own `carve <issue> --dry-run` via the
 * shared install in its root (ADR 0003): it computes the closure against that
 * project's real `blockedBy` graph and prints it, changing nothing. Returns the
 * printed closure, or null when the child fails. Mirrors the Telegram gateway's
 * `carvePreview` — the same dumb-router routing the aggregated dashboard uses.
 */
export function shellCarvePreview(projectRoot: string, taskId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "carve", taskId, "--dry-run"], {
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
 * The carve closure the inline panel discloses before a carve — the target, the
 * dependents that would leave, the banked (merged/mergeable) work kept, and the
 * remaining waves. It is exactly the `StructuredCarveClosure` the CLI's dry-run
 * emits (E2), so the panel names each member and its fate without re-deriving
 * anything the project's own install already computed.
 */
export type CarveClosure = StructuredCarveClosure;

const CLOSURE_PREFIX = "carve-closure ";

/**
 * Pull the structured closure out of the project's own `carve <issue> --dry-run`
 * output: it prints a machine-readable `carve-closure {json}` line (E2) alongside
 * the human prose, so this just finds that line and parses it — no coupling to
 * the prose's wording. Returns null when the line is absent (an install predating
 * E2) or unparseable, which the route surfaces as a 502. Pure so it is unit-tested
 * at the seam; the live shell (`shellCarveClosure`) is the only caller.
 */
export function parseCarveClosure(previewText: string): CarveClosure | null {
  const line = previewText.split("\n").find((l) => l.startsWith(CLOSURE_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(CLOSURE_PREFIX.length)) as CarveClosure;
  } catch {
    return null;
  }
}

/**
 * The default `carveClosure`: shell the selected project's own `carve --dry-run`
 * (the same dumb-router routing `shellCarvePreview` uses) and parse the structured
 * closure out of it. Returns null when the child fails (e.g. no campaign running)
 * or emits no closure line, which the route surfaces as a 502 for the panel to
 * report.
 */
export async function shellCarveClosure(projectRoot: string, taskId: string): Promise<CarveClosure | null> {
  const previewText = await shellCarvePreview(projectRoot, taskId);
  return previewText == null ? null : parseCarveClosure(previewText);
}
