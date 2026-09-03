import { runChild } from "./dashboard-child.ts";
import type { StructuredGraftClosure } from "./graft.ts";

/** The cap on how long the preview waits for the project's own dry-run child. The
 *  preview is a read-only disclosure, so a hang surfaces as a 502 the client tolerates
 *  (it leaves the button enabled), never a stuck request. */
const GRAFT_PREVIEW_TIMEOUT_MS = 60_000;

/**
 * Preview a graft by shelling the project's own `graft <ids…> --dry-run` via the
 * shared install in its root (ADR 0003): it computes the placement against that
 * project's real campaign + `blockedBy` graph and prints it, changing nothing.
 * Returns the printed placement, or null when the child fails. The additive mirror
 * of `shellPrunePreview` — the same dumb-router routing the aggregated dashboard
 * uses. `graft` is variadic, so this carries a *set* of ids, not a single target.
 */
export async function shellGraftPreview(projectRoot: string, taskIds: string[], opts: { json?: boolean } = {}): Promise<string | null> {
  // The human-prose preview shells without `--json`; the structured-closure path
  // (`shellGraftClosure`) passes `--json` so the child also emits the machine
  // `graft-closure {json}` line to parse. No JSON reaches stdout otherwise (§11).
  // The spawn-collect is `runChild`'s now — this is the same dry-run shell the POST
  // path used to duplicate, so it folds into the one seam (a timeout, or a non-zero
  // exit, reads as null: nothing to preview).
  const args = ["graft", ...taskIds, "--dry-run", ...(opts.json ? ["--json"] : [])];
  const { code, stdout, timedOut } = await runChild(projectRoot, args, { timeoutMs: GRAFT_PREVIEW_TIMEOUT_MS });
  return !timedOut && code === 0 ? stdout.trim() || null : null;
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
  const previewText = await shellGraftPreview(projectRoot, taskIds, { json: true });
  return previewText == null ? null : parseGraftClosure(previewText);
}
