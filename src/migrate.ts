/**
 * Move a project from the old single-`.sandcastle/` layout onto the committed
 * `sandcastle/` + excluded `.sandcastle.local/` split (ADR 0001).
 *
 * Split into a pure planner and an apply step, mirroring `carve` (a pure planner
 * over plain data) and `archive` (filesystem work that reports what it did):
 * `computeLayoutMigration` turns a described on-disk state into a plan — the set
 * of moves, the `.gitignore` edit, and warnings — touching nothing;
 * `applyLayoutMigration` performs that plan against a real directory.
 *
 * Scope guard: E1's migration is the LAYOUT MOVE only. Folding host-only
 * orchestrator secrets and rewriting the systemd unit ride with the gateway
 * epic (E3, #14); the plan warns about them rather than attempting them.
 */

const CANONICAL_DIR = "sandcastle";
const LOCAL_DIR = ".sandcastle.local";
const OLD_DIR = ".sandcastle";

/** The deferred-scope warning: the parts E1's migrate deliberately leaves alone. */
export const DEFERRED_WARNING =
  "Host-only orchestrator secrets and the systemd-unit rewrite are NOT migrated here — " +
  "they are deferred to the gateway epic (E3, #14). Handle them there.";

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
}

export interface LayoutMigrationPlan {
  moves: Move[];
  /** The full new `.gitignore` content to write, or undefined when unchanged. */
  gitignore?: string;
  /** Human-facing warnings (deferred scope, etc.). */
  warnings: string[];
  /** Destinations that already exist — the migration is refused while non-empty. */
  conflicts: string[];
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
  const warnings = moves.length ? [DEFERRED_WARNING] : [];

  return { moves, gitignore, warnings, conflicts };
}
