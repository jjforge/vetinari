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
  // Authoring tools sometimes fence the marker's cites in backslash-escaped backticks
  // (`\`src/foo.ts\``), which render as plain backticks but leave a stray `\` the
  // tokenizer would otherwise capture into the basename (#249). Basenames never contain
  // a backslash, so stripping the escape is unambiguous and recovers the real path.
  const normalized = body.replace(/\\`/g, "`");
  for (const m of normalized.matchAll(CITE_RE)) {
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
 * True when `text` carries an anchored `Touches:`/`Files:`/`Creates:` marker line
 * from which the resolver would extract at least one cite. Reuses the same parser
 * the resolver reads with, so "has a marker" here means exactly what the resolver
 * would act on — an anchored line present but whose cites do not parse (only non-path
 * prose, e.g. a bare `campaign` word) yields `[]`, not a real marker, so it does NOT
 * shadow a resolvable marker the ticket carries in a comment. (Escaped backticks are
 * normalized away before tokenizing, so they now parse to a real cite — see #249.)
 */
function hasMarkerLine(text: string): boolean {
  const touches = markerCites(text, TOUCHES_RE);
  const creates = markerCites(text, CREATES_RE);
  return Boolean(touches?.length) || Boolean(creates?.length);
}

/**
 * The anchored marker LINES a ticket's comments carry, folded into one synthetic
 * `Touches:` and/or `Creates:` line so the resolver reads the *union* of the cites
 * across every comment (a body/title marker, when present, wins outright and this is
 * never consulted — so there is no ordering to honour, only a union). Only cites on a
 * real marker line survive: a filename mentioned in ordinary comment prose is off the
 * marker line and stays ignored, preserving the reason comments were dropped wholesale
 * before. Returns "" when the comments carry no marker line at all.
 */
function commentMarkerLines(comments: unknown): string {
  if (!Array.isArray(comments)) return "";
  const text = comments
    .map((c) =>
      c && typeof c === "object" ? (c as { body?: unknown }).body : undefined,
    )
    .filter((b): b is string => typeof b === "string")
    .join("\n\n");

  const lines: string[] = [];
  const gather = (marker: RegExp): string[] => {
    const tails: string[] = [];
    for (const m of text.matchAll(marker)) tails.push(m[1]);
    return tails;
  };
  const touches = gather(TOUCHES_RE);
  if (touches.length) lines.push(`Touches:${touches.join(",")}`);
  const creates = gather(CREATES_RE);
  if (creates.length) lines.push(`Creates:${creates.join(",")}`);
  return lines.join("\n");
}

/**
 * The ticket text the resolver should scan, given whatever `fetchTask` returned.
 * A GitHub `fetchTask` yields `{ title, body, comments, labels }` JSON. The file-set
 * lives in the author's own title+body, so that is the authoritative source: when it
 * carries any marker line, comments are dropped entirely (a body/title marker wins,
 * and a stray filename-shaped token in a comment must not poison confidence). Only
 * when title+body carry NO marker line do we fall back to the anchored marker *lines*
 * found in the comments — our own convention puts the agent brief, marker and all, in
 * a comment — folding their cites in via {@link commentMarkerLines}. Comment *prose*
 * is still never scanned; only explicit marker lines are. Non-JSON (or JSON without a
 * body/title) passes through unchanged, so a plain-string tracker still works. Kept
 * beside the resolver so "what feeds the file-set scan" is one concern; the resolver
 * itself stays pure over the string this returns.
 */
export function ticketProse(task: string): string {
  try {
    const parsed = JSON.parse(task) as {
      title?: unknown;
      body?: unknown;
      comments?: unknown;
    };
    if (
      parsed &&
      typeof parsed === "object" &&
      (typeof parsed.body === "string" || typeof parsed.title === "string")
    ) {
      const prose = [parsed.title, parsed.body]
        .filter((s): s is string => typeof s === "string")
        .join("\n\n");
      if (hasMarkerLine(prose)) return prose;
      const fromComments = commentMarkerLines(parsed.comments);
      return fromComments ? `${prose}\n\n${fromComments}` : prose;
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
 * campaign will actually run on, snapshotted once on first use and reused for
 * every later ticket, so one plan validates against one tree).
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
export const defaultFileSet = (
  root: string = process.cwd(),
): ((ticket: string) => FileSet) => {
  // Snapshot the tree lazily, on the first ticket resolved — not at construction.
  // `campaign-plan` builds a resolver even for a single-issue selection it then
  // resolves nothing against (§356), so a resolver that is never invoked must
  // never walk the tree; and every ticket in one plan shares this one snapshot.
  let present: Set<string> | undefined;
  return (ticket: string): FileSet => {
    const tree = (present ??= treeBasenames(root));
    const touches = markerCites(ticket, TOUCHES_RE);
    const creates = markerCites(ticket, CREATES_RE);

    // No marker line of either kind — fall back to the all-or-nothing whole-body scan.
    if (touches === null && creates === null) {
      const cited = citedBasenames(ticket);
      const files = cited.filter((name) => tree.has(name));
      return {
        files,
        confident: cited.length > 0 && files.length === cited.length,
      };
    }

    // `Touches:` cites are validated against the tree (strict); `Creates:` cites are
    // counted for disjointness but never validated. A missing existing-file cite
    // forbids confidence; a missing created-file cite does not.
    const touchesCites = touches ?? [];
    const validTouches = touchesCites.filter((name) => tree.has(name));
    const files = [...new Set([...validTouches, ...(creates ?? [])])];
    const confident =
      files.length > 0 && validTouches.length === touchesCites.length;
    return { files, confident };
  };
};
