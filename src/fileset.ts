/**
 * The file-set resolver seam and its shipped default.
 *
 * `campaign-plan` keeps co-wave tickets file-disjoint so a wave never collides as
 * a merge conflict at integration. Which files a ticket will touch is a project
 * concern, so it is a config seam — `fileSet(ticket) -> { files, confident }`,
 * beside `blockedBy`/`fetchTask` — and vetinari ships a generic default.
 *
 * `files` carries the comparison keys the partition collides on — **fileKeys**.
 * The basename is an index into the tree, not the key itself: each `Touches:` cite
 * is resolved by longest-suffix match against the tree to its real repo-relative
 * path, so two distinct files at `a/b/c/foo.md` and `a/c/foo.md` no longer read as a
 * collision, while a bare `fileset.ts` and a path `src/fileset.ts` still resolve to
 * the one path and collide (user story 6, the authoring promise). A cite the tree
 * holds under several paths is genuinely ambiguous: it is kept as a bare basename
 * (still confident) and collides with any file of that name — today's semantics for
 * that one cite. `Creates:` cites name files not yet in the tree, so there is no
 * index to resolve them against; they stay bare basenames and collide by basename.
 */
import { readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export interface FileSet {
  /**
   * the fileKeys this ticket will touch: each `Touches:` cite resolved to its real
   * repo-relative path (or kept as a bare basename when the cite was ambiguous or
   * names a `Creates:` file), never the raw cited path.
   */
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
/**
 * A trailing `:<line>` or `:<line>:<col>` on a cite — the `path:line` form editors
 * and review tools produce, and what `file_path:line` conventions encourage (#388).
 * A colon is not legal in a basename on the platforms vetinari targets, so — like the
 * escaped-backtick strip — removing it is unambiguous and cannot corrupt a real name.
 */
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

/** The cited paths in a body, cleaned but not reduced (deduped by path, in order). */
function citedPaths(body: string): string[] {
  const seen = new Set<string>();
  // Authoring tools sometimes fence the marker's cites in backslash-escaped backticks
  // (`\`src/foo.ts\``), which render as plain backticks but leave a stray `\` the
  // tokenizer would otherwise capture into the basename (#249). Paths never contain
  // a backslash, so stripping the escape is unambiguous and recovers the real path.
  const normalized = body.replace(/\\`/g, "`");
  for (const m of normalized.matchAll(CITE_RE)) {
    // Strip a trailing `:line[:col]` before anything else, so a line-numbered cite
    // is path-shaped and resolves to the real file rather than an unmatchable
    // `host-slots.ts:329` the tree never contains (#388).
    const raw = (m[1] ?? m[2]).trim().replace(LINE_SUFFIX_RE, "");
    // A backtick token counts only if it is path-shaped, not just any word.
    if (!raw.includes("/") && !FILENAME_RE.test(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** The cited paths in a body, each reduced to its basename (deduped, in order). Used
 *  for `Creates:` cites, which name files not yet in the tree and so cannot resolve to
 *  a real path — they stay basenames and collide by basename, as they always have. */
function citedBasenames(body: string): string[] {
  return [...new Set(citedPaths(body).map((raw) => basename(raw)))];
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
 * The tail of a body's marker line for the given marker regex, or null when the body
 * carries no such marker line. When several qualify, the LAST wins — a later,
 * corrected marker line supersedes an earlier one.
 */
function markerTail(body: string, marker: RegExp): string | null {
  let tail: string | null = null;
  for (const m of body.matchAll(marker)) tail = m[1];
  return tail;
}

/**
 * The cited paths on a body's marker line (cleaned, not reduced), or null when the
 * body carries no such marker line. An empty result (`[]`) means a marker line is
 * present but cites nothing; the caller keeps that distinct from "no marker line"
 * (null). Used for `Touches:`, whose cites are resolved against the tree.
 */
function markerPaths(body: string, marker: RegExp): string[] | null {
  const tail = markerTail(body, marker);
  return tail === null ? null : citedPaths(tail);
}

/**
 * The cited basenames on a body's marker line, or null when the body carries no such
 * marker line. Used for `Creates:`, whose cites name files not yet in the tree and so
 * compare by basename.
 */
function markerCites(body: string, marker: RegExp): string[] | null {
  const tail = markerTail(body, marker);
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

/**
 * A basename -> repo-relative paths index of the tree, skipping `.git`/`node_modules`.
 * Keeping the basename as the index (not the comparison key) is what lets a cite
 * resolve to its real path while a bare filename still finds the file it names.
 */
function treePathIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        (index.get(entry.name) ?? index.set(entry.name, []).get(entry.name)!).push(rel);
      }
    }
  };
  walk(root);
  return index;
}

/** True when repo-relative `path` ends with the given trailing path `segments`. */
function endsWithSegments(path: string, segments: string[]): boolean {
  const parts = path.split("/");
  if (segments.length > parts.length) return false;
  const tail = parts.slice(parts.length - segments.length);
  return segments.every((s, i) => s === tail[i]);
}

/**
 * Resolve one cited path against the tree index to its fileKey, by **longest suffix
 * match** on path segments:
 *   - the tree holds exactly one file with the cite's basename -> that real path;
 *   - several share the basename but the cite's trailing segments pin exactly one ->
 *     that path (`a/b/c/foo.md` picks the `…/b/c/foo.md` of two `foo.md`s);
 *   - several remain and the cite cannot narrow to one -> the bare basename, kept as
 *     an ambiguous fileKey that collides with any file of that name;
 *   - no file carries the basename at all -> null (absent — forbids confidence).
 */
function resolveCite(cite: string, index: Map<string, string[]>): string | null {
  const segments = cite.split("/").filter(Boolean);
  const base = segments[segments.length - 1];
  const candidates = index.get(base);
  if (!candidates || candidates.length === 0) return null;
  // Longest suffix first: the most-specific match wins. As the suffix shortens the
  // match set only grows, so the first non-empty length decides — one match resolves,
  // more than one is ambiguous and degrades to the bare basename.
  for (let len = segments.length; len >= 1; len--) {
    const matches = candidates.filter((p) => endsWithSegments(p, segments.slice(segments.length - len)));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return base;
  }
  return base;
}

/**
 * The shipped generic `fileSet` resolver, resolving each cite against the tree at
 * `root` (the cwd by default — the tree the campaign will actually run on,
 * snapshotted once on first use and reused for every later ticket, so one plan
 * validates against one tree).
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
  let index: Map<string, string[]> | undefined;
  return (ticket: string): FileSet => {
    const tree = (index ??= treePathIndex(root));
    const touches = markerPaths(ticket, TOUCHES_RE);
    const creates = markerCites(ticket, CREATES_RE);

    // No marker line of either kind — fall back to the all-or-nothing whole-body scan.
    if (touches === null && creates === null) {
      const cited = citedPaths(ticket);
      const resolved = cited.map((c) => resolveCite(c, tree));
      const files = [...new Set(resolved.filter((k): k is string => k !== null))];
      return {
        files,
        confident: cited.length > 0 && resolved.every((k) => k !== null),
      };
    }

    // `Touches:` cites are resolved against the tree (strict — a cite matching no tree
    // path forbids confidence); `Creates:` cites name files not yet in the tree, so
    // they stay bare basenames, counted for disjointness but never validated.
    const touchesCites = touches ?? [];
    const resolved = touchesCites.map((c) => resolveCite(c, tree));
    const validTouches = resolved.filter((k): k is string => k !== null);
    const files = [...new Set([...validTouches, ...(creates ?? [])])];
    const confident =
      files.length > 0 && validTouches.length === touchesCites.length;
    return { files, confident };
  };
};
