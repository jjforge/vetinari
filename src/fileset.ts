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
 * holds under several paths is genuinely ambiguous: it is kept as a **bare key**,
 * spelled `*\/<name>` ("this name in any directory", still confident), which collides
 * with any file of that name. A key that resolved to one path stays an unmarked path —
 * a repo-root file included, though it has no `/`. `Creates:` cites name files not yet
 * in the tree, so their *directory* is resolved instead, by the same longest-suffix
 * match against the tree's directories: `a/index.ts` with `src/a` in the tree keys to
 * `src/a/index.ts`, so it collides with a `Touches:` of that file but not with an
 * `index.ts` created in another directory. A directory the tree lacks keeps the cited
 * path; one matching several tree directories, or a bare cite, keys to a bare key.
 *
 * A **rooted cite** — one starting with `./` — skips suffix matching: it names one path
 * from the repository root and matches only that exact path, so a root file whose name
 * recurs deeper (`./README.md`) can still be pinned. A bare `README.md` stays ambiguous.
 */
import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { gitRead } from "./git-read.ts";
import { Refusal } from "./refusal.ts";

/** The prefix that spells a **bare key**: `*\/<name>`, "this name in any directory". */
export const BARE_KEY_MARKER = "*/";

/** The bare key for a file `name`: the name marked as standing for any directory. */
const bareKey = (name: string): string => `${BARE_KEY_MARKER}${name}`;

export interface FileSet {
  /**
   * the fileKeys this ticket will touch: each `Touches:` cite resolved to its real
   * repo-relative path, each `Creates:` cite to its resolved directory plus its
   * basename (or the cited path, under a directory the tree lacks), or a bare key
   * `*\/<name>` ({@link BARE_KEY_MARKER}) when the cite was bare or ambiguous — never the
   * raw cited path. An unmarked key is an exact path, even with no `/`.
   */
  files: string[];
  /**
   * false when the resolver could not pin the file-set down — the ticket cites
   * nothing, or cites what the tree lacks. `campaign-plan` never plans around a
   * `confident: false` ticket silently; it halts and asks the requestor.
   */
  confident: boolean;
  /**
   * the fileKeys {@link waiveFileSet} removed from `files` as **waived files** — set only
   * by that wrapper, so the plan can name what it waived. Absent from a bare resolver.
   */
  waived?: string[];
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
    // An unbackticked token also drops a trailing sentence period (`See docs/x.md.`),
    // which the bare branch takes in; a backticked token is exactly what was fenced (#653).
    const raw = (m[1] ?? m[2].replace(/\.+$/, "")).trim().replace(LINE_SUFFIX_RE, "");
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
 * A basename -> repo-relative paths index of the tree: the files git tracks or would
 * track (`git ls-files` — tracked plus untracked-not-ignored), so a gitignored cache
 * such as `.vetinari.local/` never yields a cite match. Outside a git work tree, or when
 * the git call fails, the directory is walked instead, skipping `.git`, `node_modules`
 * and `.vetinari.local`. Keeping the basename as the index (not the comparison key) is
 * what lets a cite resolve to its real path while a bare filename still finds the file
 * it names.
 */
function treePathIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const rel of gitTreeFiles(root) ?? walkTreeFiles(root)) {
    const name = posix.basename(rel);
    (index.get(name) ?? index.set(name, []).get(name)!).push(rel);
  }
  return index;
}

/**
 * The root-relative files `git ls-files` lists at `root`, or null when `root` is not in
 * a git work tree (or git fails). `-z` keeps non-ASCII paths unquoted. `--stage` prefixes
 * each tracked entry with `<mode> <sha> <stage>\t`, which marks a submodule's gitlink
 * (mode 160000); untracked entries come bare. Not cite targets: a gitlink, a trailing-`/`
 * entry (an untracked nested repository), and anything under a `.vetinari.local`
 * directory, even when the project does not gitignore it.
 */
function gitTreeFiles(root: string): string[] | null {
  try {
    const out = gitRead(["ls-files", "-z", "--stage", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A set, not a list: mid-merge, the index lists a conflicted path once per stage
    // (up to three times), and a repeated path would read as ambiguous (#653).
    const files = new Set<string>();
    for (const entry of out.split("\0")) {
      const staged = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s.exec(entry);
      const path = staged ? staged[2] : entry;
      if (path === "" || path.endsWith("/") || staged?.[1] === "160000") continue;
      if (path.split("/").includes(".vetinari.local")) continue;
      files.add(path);
    }
    return [...files];
  } catch {
    return null;
  }
}

/** The root-relative files under `root`, walked, skipping `.git`/`node_modules`/`.vetinari.local`. */
function walkTreeFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".vetinari.local") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return files;
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
 * The path a **rooted cite** names from the repository root — the cite after its leading
 * `./` — or null when the cite is not rooted. A rooted cite matches only that exact path:
 * no suffix matching, no basename fallback, so a root file can be pinned even when its
 * name recurs deeper in the tree.
 */
function rootedCitePath(cite: string): string | null {
  return cite.startsWith("./") ? cite.slice(2) : null;
}

/**
 * Resolve one cited path against the tree index to its fileKey, by **longest suffix
 * match** on path segments:
 *   - the tree holds exactly one file with the cite's basename -> that real path;
 *   - several share the basename but the cite's trailing segments pin exactly one ->
 *     that path (`a/b/c/foo.md` picks the `…/b/c/foo.md` of two `foo.md`s);
 *   - several remain and the cite cannot narrow to one -> the bare key `*\/<name>`,
 *     which collides with any file of that name;
 *   - no file carries the basename at all -> null (absent — forbids confidence).
 * A rooted cite (`./README.md`) skips all of that: it resolves to its exact path from the
 * root when the tree holds it, and to null otherwise.
 */
function resolveCite(cite: string, index: Map<string, string[]>): string | null {
  const matches = citeMatches(cite, index);
  if (matches === null) return null;
  // One match resolves; more than one is ambiguous and degrades to a bare key.
  return matches.length === 1 ? matches[0] : bareKey(posix.basename(matches[0]));
}

/**
 * The tree paths one cited path may name: those carrying its basename that match the
 * longest trailing run of its segments (one when the cite pins a path, several when it
 * is ambiguous), or null when no file carries the basename at all. A rooted cite names
 * only its exact path, or null when the tree lacks it.
 */
function citeMatches(cite: string, index: Map<string, string[]>): string[] | null {
  const rooted = rootedCitePath(cite);
  if (rooted !== null) return index.get(posix.basename(rooted))?.includes(rooted) ? [rooted] : null;
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
 * directories:
 *   - a rooted cite (`./a/foo.ts`) -> its exact path from the root (`a/foo.ts`), with no
 *     suffix matching, whether or not the directory exists;
 *   - a bare cite (no directory) -> the bare key `*\/<name>`;
 *   - exactly one tree directory matches -> that directory + the basename, a full path
 *     (`a/foo.ts` with `src/a` in the tree -> `src/a/foo.ts`);
 *   - several match at the longest suffix reached -> the bare key, ambiguous as an
 *     ambiguous `Touches:` cite is;
 *   - none matches (a new directory) -> the cited path as written.
 * Never null: a new file is legitimately absent, so it never forbids confidence.
 */
function resolveCreatesCite(cite: string, dirIndex: Map<string, string[]>): string {
  const rooted = rootedCitePath(cite);
  if (rooted !== null) return rooted;
  const segments = cite.split("/").filter(Boolean);
  const base = segments[segments.length - 1];
  if (segments.length === 1) return bareKey(base);
  const dirSegments = segments.slice(0, -1);
  const matches = longestSuffixMatches(dirSegments, dirIndex.get(dirSegments[dirSegments.length - 1]) ?? []);
  if (matches.length === 0) return cite;
  return matches.length === 1 ? `${matches[0]}/${base}` : bareKey(base);
}

/**
 * The package directories a `Creates:` cite may land in, read from the **raw** cite: a
 * bare cite (no `/`) names no directory -> null; a rooted cite -> the exact directory of
 * its path (`./x.go` -> `.`, `./a/x.go` -> `a`), unmatched; otherwise its directory
 * resolved by longest suffix match against the tree's directories -> every match at the
 * longest suffix reached, or the cited directory as written when none matches (a new
 * package).
 */
function createsCiteDirs(cite: string, dirIndex: Map<string, string[]>): string[] | null {
  if (!cite.includes("/")) return null;
  const rooted = rootedCitePath(cite);
  if (rooted !== null) return [posix.dirname(rooted)];
  const dirSegments = cite.split("/").filter(Boolean).slice(0, -1);
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
 *     the cited directory when the tree lacks it (a new package);
 *   - a rooted cite (`./pkg/a.go`, `Touches:` or `Creates:`) -> the exact directory of
 *     its path from the root, no suffix matching (`./x.go` -> `.`);
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

/**
 * Wrap a `fileSet` resolver so the project's **waived files** (`waivedFiles` in config)
 * never reach a collision check: a fileKey exactly equal to an entry (no globs, no
 * basename matching) is moved from `files` to `waived`, and `confident` is the
 * resolver's own verdict. The one helper every fileKey-resolution site applies —
 * `campaign`, `campaign --dry-run` and `graft` — so they agree by construction.
 *
 * An entry that is a directory in the tree at `root` (the tree the shipped resolvers
 * walk, the cwd by default) is refused here, not at config load: under
 * `packageScopedFileSet` a fileKey is a package directory, which must never be
 * waivable. An entry the tree lacks matches no key and is silently ignored. With no
 * entries the resolver is returned unwrapped.
 */
export const waiveFileSet = (resolve: FileSetOf, waivedFiles: readonly string[] = [], root: string = process.cwd()): FileSetOf => {
  if (!waivedFiles.length) return resolve;
  for (const entry of waivedFiles) {
    if (statSync(join(root, entry), { throwIfNoEntry: false })?.isDirectory())
      throw new Refusal(`waivedFiles: "${entry}" is a directory — only single files can be waived (directories and globs cannot).`);
  }
  const waivable = new Set(waivedFiles);
  return async (ticket: string): Promise<FileSet> => {
    const { files, confident } = await resolve(ticket);
    return { files: files.filter((k) => !waivable.has(k)), confident, waived: files.filter((k) => waivable.has(k)) };
  };
};
