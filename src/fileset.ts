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
 * that one cite. `Creates:` cites name files not yet in the tree, so their
 * *directory* is resolved instead, by the same longest-suffix match against the
 * tree's directories: `a/index.ts` with `src/a` in the tree keys to `src/a/index.ts`,
 * so it collides with a `Touches:` of that file but not with an `index.ts` created in
 * another directory. A directory the tree lacks keeps the cited path; one matching
 * several tree directories, or a bare cite, keeps the bare basename.
 */
import { readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export interface FileSet {
  /**
   * the fileKeys this ticket will touch: each `Touches:` cite resolved to its real
   * repo-relative path, each `Creates:` cite to its resolved directory plus its
   * basename (or the cited path, under a directory the tree lacks), or a bare
   * basename when the cite was bare or ambiguous — never the raw cited path.
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
 * slash-separated path. On a marker line every backticked token is a cite — the
 * marker already says "these are files", so an extensionless `Makefile` or a dotfile
 * `.gitignore` counts (#477). Off a marker line (the whole-body fallback), prose in
 * backticks (e.g. `campaign`) is rejected below unless it is path-shaped, so ordinary
 * words do not become cites.
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

/**
 * The cited paths in a body, cleaned but not reduced (deduped by path, in order).
 * `onMarkerLine` takes every backticked token as a cite; without it a token counts
 * only if it is path-shaped (a `/`, or a name with an extension).
 */
function citedPaths(body: string, onMarkerLine = false): string[] {
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
    if (!raw) continue;
    // Off a marker line, a backtick token counts only if it is path-shaped, not just any word.
    if (!onMarkerLine && !raw.includes("/") && !FILENAME_RE.test(raw)) continue;
    seen.add(raw);
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
 * the ticket creates — counted for wave-disjointness (keyed through its directory,
 * see {@link resolveCreatesCite}) but NOT validated, since a new file is legitimately
 * absent from the tree.
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
 * (null). Used for both markers: `Touches:` cites resolve against the tree's files,
 * `Creates:` cites against its directories.
 */
function markerPaths(body: string, marker: RegExp): string[] | null {
  const tail = markerTail(body, marker);
  return tail === null ? null : citedPaths(tail, true);
}

/**
 * True when ANY anchored `Touches:`/`Files:`/`Creates:` marker line in `text` yields at
 * least one cite — not only the last of each kind, which is what the resolver reads.
 * So a cited line followed by a cite-less `Touches: none` still counts: the body is
 * authoritative, the comments are dropped, and the closing line leaves the ticket with
 * no files and not confident (#483). Reuses the parser the resolver reads with. Every
 * backticked token on a marker line is a cite, so a line citing only a non-file word
 * (e.g. `campaign`) IS a marker: it shadows any marker the ticket carries in a comment,
 * and the ticket resolves not confident — the author's explicit declaration cites a
 * non-file, which should halt the planner, not be quietly overridden (#477). An
 * anchored line with no cite at all (no backticked token, no slash path) is not a
 * marker here, so text whose marker lines all cite nothing has none and the comments'
 * marker lines are read. (Escaped backticks are normalized away before tokenizing, so
 * they parse to a real cite — see #249.)
 */
function hasMarkerLine(text: string): boolean {
  const cites = (marker: RegExp): boolean => {
    for (const m of text.matchAll(marker)) if (citedPaths(m[1], true).length > 0) return true;
    return false;
  };
  return cites(TOUCHES_RE) || cites(CREATES_RE);
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
    .map((c) => (c && typeof c === "object" ? (c as { body?: unknown }).body : undefined))
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
    if (parsed && typeof parsed === "object" && (typeof parsed.body === "string" || typeof parsed.title === "string")) {
      const prose = [parsed.title, parsed.body].filter((s): s is string => typeof s === "string").join("\n\n");
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
 * The `candidates` matching the longest trailing run of `segments` that any of them
 * match, or `[]` when none match even the last segment. As the suffix shortens the
 * match set only grows, so the first non-empty length decides.
 */
function longestSuffixMatches(segments: string[], candidates: string[]): string[] {
  for (let len = segments.length; len >= 1; len--) {
    const matches = candidates.filter((p) => endsWithSegments(p, segments.slice(segments.length - len)));
    if (matches.length > 0) return matches;
  }
  return [];
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
  const matches = citeMatches(cite, index);
  if (matches === null) return null;
  // One match resolves; more than one is ambiguous and degrades to the bare basename.
  return matches.length === 1 ? matches[0] : posix.basename(matches[0]);
}

/**
 * The tree paths one cited path may name: those carrying its basename that match the
 * longest trailing run of its segments (one when the cite pins a path, several when it
 * is ambiguous), or null when no file carries the basename at all.
 */
function citeMatches(cite: string, index: Map<string, string[]>): string[] | null {
  const segments = cite.split("/").filter(Boolean);
  const candidates = index.get(segments[segments.length - 1]);
  if (!candidates || candidates.length === 0) return null;
  // Longest suffix first: the most-specific match wins.
  return longestSuffixMatches(segments, candidates);
}

/**
 * A directory-basename -> repo-relative directory paths index of the tree, derived from
 * the file index: every indexed file's directory and each of its ancestors.
 */
function treeDirIndex(files: Map<string, string[]>): Map<string, string[]> {
  const dirs = new Set<string>();
  for (const paths of files.values()) for (const p of paths) for (let d = posix.dirname(p); d !== "."; d = posix.dirname(d)) dirs.add(d);
  const index = new Map<string, string[]>();
  for (const d of dirs) {
    const name = posix.basename(d);
    (index.get(name) ?? index.set(name, []).get(name)!).push(d);
  }
  return index;
}

/**
 * Resolve one `Creates:` cite to its fileKey. The file does not exist yet, so its
 * *directory* is resolved instead, by longest suffix match against the tree's
 * directories (a leading `./` dropped first):
 *   - a bare cite (no directory) -> the bare basename;
 *   - exactly one tree directory matches -> that directory + the basename, a full path
 *     (`a/foo.ts` with `src/a` in the tree -> `src/a/foo.ts`);
 *   - several match at the longest suffix reached -> the bare basename, ambiguous as an
 *     ambiguous `Touches:` cite is;
 *   - none matches (a new directory) -> the cited path as written.
 * Never null: a new file is legitimately absent, so it never forbids confidence.
 */
function resolveCreatesCite(cite: string, dirIndex: Map<string, string[]>): string {
  const path = cite.replace(/^(?:\.\/)+/, "");
  const segments = path.split("/").filter(Boolean);
  const base = segments[segments.length - 1];
  if (segments.length === 1) return base;
  const dirSegments = segments.slice(0, -1);
  const matches = longestSuffixMatches(dirSegments, dirIndex.get(dirSegments[dirSegments.length - 1]) ?? []);
  if (matches.length === 0) return path;
  return matches.length === 1 ? `${matches[0]}/${base}` : base;
}

/**
 * The package directories a `Creates:` cite may land in, read from the **raw** cite: a
 * bare cite (no `/`) names no directory -> null; `./x.go` -> `.`; otherwise its directory
 * (a leading `./` dropped) resolved by longest suffix match against the tree's
 * directories -> every match at the longest suffix reached, or the cited directory as
 * written when none matches (a new package).
 */
function createsCiteDirs(cite: string, dirIndex: Map<string, string[]>): string[] | null {
  if (!cite.includes("/")) return null;
  const dirSegments = cite
    .replace(/^(?:\.\/)+/, "")
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
  if (dirSegments.length === 0) return ["."];
  const matches = longestSuffixMatches(dirSegments, dirIndex.get(dirSegments[dirSegments.length - 1]) ?? []);
  return matches.length > 0 ? matches : [dirSegments.join("/")];
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
export const defaultFileSet = (root: string = process.cwd()): ((ticket: string) => FileSet) => {
  // Snapshot the tree lazily, on the first ticket resolved — not at construction.
  // `campaign-plan` builds a resolver even for a single-issue selection it then
  // resolves nothing against (§356), so a resolver that is never invoked must
  // never walk the tree; and every ticket in one plan shares this one snapshot.
  let index: Map<string, string[]> | undefined;
  let dirIndex: Map<string, string[]> | undefined;
  return (ticket: string): FileSet => {
    const tree = (index ??= treePathIndex(root));
    const { touches, creates } = ticketCites(ticket);

    // `Touches:` cites are resolved against the tree (strict — a cite matching no tree
    // path forbids confidence); `Creates:` cites name files not yet in the tree, so
    // their directory is resolved against the tree's directories instead — counted for
    // disjointness but never validated.
    const resolved = touches.map((c) => resolveCite(c, tree));
    const validTouches = resolved.filter((k): k is string => k !== null);
    const created = creates.length ? creates.map((c) => resolveCreatesCite(c, (dirIndex ??= treeDirIndex(tree)))) : [];
    const files = [...new Set([...validTouches, ...created])];
    const confident = files.length > 0 && validTouches.length === touches.length;
    return { files, confident };
  };
};

/**
 * A ticket's cites, split by how they resolve: `touches` name files the tree must hold,
 * `creates` new files. With a marker line of either kind only the marker lines' cites
 * count; with none, every cite in the whole body is a `touches` cite (the all-or-nothing
 * fallback, so an incidental token in an unmarked body still forbids confidence).
 */
function ticketCites(ticket: string): { touches: string[]; creates: string[] } {
  const touches = markerPaths(ticket, TOUCHES_RE);
  const creates = markerPaths(ticket, CREATES_RE);
  if (touches === null && creates === null) return { touches: citedPaths(ticket), creates: [] };
  return { touches: touches ?? [], creates: creates ?? [] };
}

/**
 * A `fileSet` resolver for package-scoped languages (Go and similar), where every file
 * in one directory shares a single package namespace. The planner keeps a wave's
 * members file-disjoint, but there two tickets touching *different* files in the *same*
 * package can each add the same package-level identifier: each goes green alone, and
 * merged they do not compile. So each fileKey here is a **package** — a directory — and
 * two tickets in one directory collide and land in separate waves:
 *   - a `Touches:` cite -> the directory of the path it resolves to, or of every path it
 *     may name when ambiguous (still matching at the longest suffix it reaches);
 *   - a `Creates:` cite with a directory -> that directory, resolved against the tree's
 *     directories by the same longest-suffix match (every match when several tie), or
 *     the cited directory when the tree lacks it (a new package); `./x.go` -> `.`;
 *   - a bare `Creates:` cite (`x.go`) -> no key, and the ticket is not confident: its
 *     package is unknowable, so the planner halts it as under-specified.
 * Otherwise `confident` is what {@link defaultFileSet} returns. Same lazy, once-per-plan
 * tree snapshot at `root` (the cwd by default).
 */
export const packageScopedFileSet = (root: string = process.cwd()): FileSetOf => {
  let index: Map<string, string[]> | undefined;
  let dirIndex: Map<string, string[]> | undefined;
  return (ticket: string): FileSet => {
    const tree = (index ??= treePathIndex(root));
    const { touches, creates } = ticketCites(ticket);
    const matched = touches.map((c) => citeMatches(c, tree));
    const valid = matched.filter((m): m is string[] => m !== null);
    const created = creates.map((c) => createsCiteDirs(c, (dirIndex ??= treeDirIndex(tree))));
    const placed = created.filter((d): d is string[] => d !== null);
    const files = [...new Set([...valid.flat().map((p) => posix.dirname(p)), ...placed.flat()])];
    // As defaultFileSet, plus: a bare `Creates:` cite (no package) forbids confidence.
    const confident = (valid.length > 0 || creates.length > 0) && valid.length === touches.length && placed.length === creates.length;
    return { files, confident };
  };
};
