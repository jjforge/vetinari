/**
 * The file-set resolver seam and its shipped default.
 *
 * `campaign-plan` keeps co-wave tickets file-disjoint so a wave never collides as
 * a merge conflict at integration. Which files a ticket will touch is a project
 * concern, so it is a config seam — `fileSet(ticket) -> { files, confident }`,
 * beside `blockedBy`/`fetchTask` — and sandcastle-tdd ships a generic default.
 *
 * Collisions are judged by basename (user story 6): the same file cited by
 * different paths across tickets must still be caught, so `files` is always a set
 * of basenames, never the cited path.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface FileSet {
  /** the basenames of the files this ticket will touch (never full paths). */
  files: string[];
  /**
   * false when the resolver could not pin the file-set down — the ticket cites
   * nothing, or cites what the tree lacks. `campaign-plan` never plans around a
   * `confident: false` ticket silently; it halts and asks the requestor.
   */
  confident: boolean;
}

/**
 * A ticket's file-set resolver. `ticket` is the ticket's text (its body): the
 * default reads cited paths from it, and a project's own resolver can key its
 * symbol/route -> file index off the same text. Pure over that text plus the tree
 * the resolver was built against, so it stays testable with no live tracker.
 */
export type FileSetOf = (ticket: string) => FileSet | Promise<FileSet>;

/**
 * A cited path in an issue body: either a backtick-wrapped token or a bare
 * slash-separated path. Prose in backticks (e.g. `campaign`) is rejected below
 * unless it also looks like a filename, so ordinary words do not become cites.
 */
const CITE_RE = /`([^`\n]+)`|((?:[\w.\-]+\/)+[\w.\-]+)/g;
/** A bare filename with an alphabetic extension, e.g. `stack_strip.tmpl`. */
const FILENAME_RE = /^[\w.\-]+\.[A-Za-z][\w-]*$/;

/** The cited paths in a body, each reduced to its basename (deduped, in order). */
function citedBasenames(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(CITE_RE)) {
    const raw = (m[1] ?? m[2]).trim();
    // A backtick token counts only if it is path-shaped, not just any word.
    if (!raw.includes("/") && !FILENAME_RE.test(raw)) continue;
    seen.add(basename(raw));
  }
  return [...seen];
}

/** Every basename present anywhere in the tree, skipping `.git`/`node_modules`. */
function treeBasenames(root: string): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else names.add(entry.name);
    }
  };
  walk(root);
  return names;
}

/**
 * The shipped generic `fileSet` resolver: parse a ticket body's cited paths,
 * normalize each to its basename, and validate against the tree at `root` (the
 * cwd by default — the tree the campaign will actually run on). The tree is
 * snapshotted once, when the resolver is built. `confident` is false when the
 * ticket cites nothing, or cites a basename the tree does not have — a stale or
 * missing note the planner must not guess past. Exported alongside
 * `githubBlockedBy` as a ready implementation a project can use or wrap.
 */
export const defaultFileSet =
  (root: string = process.cwd()): ((ticket: string) => FileSet) =>
  (ticket: string): FileSet => {
    const present = treeBasenames(root);
    const cited = citedBasenames(ticket);
    const files = cited.filter((name) => present.has(name));
    const confident = cited.length > 0 && files.length === cited.length;
    return { files, confident };
  };
