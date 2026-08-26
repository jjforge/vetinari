/**
 * The file-set resolver seam and its shipped default.
 *
 * `campaign-plan` keeps co-wave tickets file-disjoint so a wave never collides as
 * a merge conflict at integration. Which files a ticket will touch is a project
 * concern, so it is a config seam — `fileSet(ticket) -> { files, confident }`,
 * beside `blockedBy`/`fetchTask` — and vetinari ships a generic default.
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

/**
 * The explicit file-set marker LINES a ticket may carry, e.g.
 * `Touches (existing files): \`a.ts\`, b/c.ts` or `Creates (new files): \`d.ts\``.
 * Each is anchored at the start of a line (`m` flag) so an inline mention of the
 * phrase in prose — "reads the `Touches:` marker" — is not mistaken for the marker
 * itself. A leading list bullet and surrounding bold markers are tolerated; group 1
 * is the tail after the colon, from which the cites are read.
 *
 * `TOUCHES_RE` names files the ticket edits — validated against the tree, since a
 * cited-but-absent existing file is a stale/typo'd note. `CREATES_RE` names files
 * the ticket creates — counted for wave-disjointness but NOT validated, since a new
 * file is legitimately absent from the tree.
 */
const TOUCHES_RE = /^[ \t]*(?:[-*+]\s+)?\**(?:Touches|Files)\b[^:\n]*:(.*)$/gim;
const CREATES_RE = /^[ \t]*(?:[-*+]\s+)?\**Creates\b[^:\n]*:(.*)$/gim;

/**
 * The cites on a body's marker line for the given marker regex, or null when the
 * body carries no such marker line. When several qualify, the LAST wins — a later,
 * corrected marker line supersedes an earlier one. An empty result (`[]`) means a
 * marker line is present but cites nothing; the caller keeps that distinct from "no
 * marker line" (null).
 */
function markerCites(body: string, marker: RegExp): string[] | null {
  let tail: string | null = null;
  for (const m of body.matchAll(marker)) tail = m[1];
  return tail === null ? null : citedBasenames(tail);
}

/**
 * The ticket text the resolver should scan, given whatever `fetchTask` returned.
 * A GitHub `fetchTask` yields `{ title, body, comments, labels }` JSON; the file-set
 * lives in the author's own title+body, so comments are dropped — a stray
 * filename-shaped token in any comment must not poison confidence (the original
 * whole-body scan counted them). Non-JSON (or JSON without a body/title) passes
 * through unchanged, so a plain-string tracker still works. Kept beside the
 * resolver so "what feeds the file-set scan" is one concern; the resolver itself
 * stays pure over the string this returns.
 */
export function ticketProse(task: string): string {
  try {
    const parsed = JSON.parse(task) as { title?: unknown; body?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      (typeof parsed.body === "string" || typeof parsed.title === "string")
    ) {
      return [parsed.title, parsed.body]
        .filter((s): s is string => typeof s === "string")
        .join("\n\n");
    }
  } catch {
    // not JSON — fall through and scan the raw text
  }
  return task;
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
 * The shipped generic `fileSet` resolver, normalizing each cite to its basename
 * and validating against the tree at `root` (the cwd by default — the tree the
 * campaign will actually run on, snapshotted once when the resolver is built).
 *
 * Two signals, in order:
 *   - **Marker lines (primary).** When the ticket carries an explicit
 *     `Touches:` / `Files:` or `Creates:` marker line, only *their* cites count.
 *     This is what lets a ticket that names its real files alongside incidental
 *     non-file prose — an env file, a config name, a spec link — still resolve
 *     confidently: the prose is off the marker line, so it is ignored. `Touches:`
 *     cites are validated against the tree; `Creates:` cites (files the ticket will
 *     create) are counted for disjointness but exempt from that check — a new file
 *     is legitimately absent, so its absence must not read as a typo.
 *   - **Whole-body scan (fallback).** With no marker line of either kind, every
 *     cited path in the text is taken (the original behaviour). This stays
 *     all-or-nothing, so an incidental token in an unmarked body still forbids
 *     confidence — add a marker line to pin such a ticket down.
 *
 * `confident` is false when nothing is cited, or when a `Touches:`/`Files:` cite (or,
 * in the fallback, any cite) is absent from the tree — a stale or wrong note the
 * planner must not guess past (this contract is deliberately strict; leniency would
 * silently drop a moved/mistyped real file and schedule a colliding wave). A
 * `Creates:` cite never forces `confident: false`. Exported alongside
 * `githubBlockedBy` as a ready implementation a project can use or wrap.
 */
export const defaultFileSet =
  (root: string = process.cwd()): ((ticket: string) => FileSet) =>
  (ticket: string): FileSet => {
    const present = treeBasenames(root);
    const touches = markerCites(ticket, TOUCHES_RE);
    const creates = markerCites(ticket, CREATES_RE);

    // No marker line of either kind — fall back to the all-or-nothing whole-body scan.
    if (touches === null && creates === null) {
      const cited = citedBasenames(ticket);
      const files = cited.filter((name) => present.has(name));
      return {
        files,
        confident: cited.length > 0 && files.length === cited.length,
      };
    }

    // `Touches:` cites are validated against the tree (strict); `Creates:` cites are
    // counted for disjointness but never validated. A missing existing-file cite
    // forbids confidence; a missing created-file cite does not.
    const touchesCites = touches ?? [];
    const validTouches = touchesCites.filter((name) => present.has(name));
    const files = [...new Set([...validTouches, ...(creates ?? [])])];
    const confident =
      files.length > 0 && validTouches.length === touchesCites.length;
    return { files, confident };
  };
