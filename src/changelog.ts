/**
 * The changelog fragment mechanism (issue #123): campaign agents stop editing the
 * shared `CHANGELOG.md` — a file every co-wave ticket would touch, so
 * `integrateGreens` conflicts on it and halts the campaign — and instead each
 * writes a per-task fragment under `changelog.d/`. The orchestrator folds a wave's
 * fragments into `CHANGELOG.md` in one commit at merge time (the
 * towncrier/changesets pattern), so co-wave tickets stay file-disjoint.
 *
 * `parseFragment` and `collectFragments` are the pure core — the fold is the
 * primary test seam. The CLI edge (`vetinari changelog collect`) reads
 * `changelog.d/*.md`, applies the fold, writes `CHANGELOG.md`, and deletes the
 * consumed fragments.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where campaign agents write their per-task fragments (committed, not gitignored). */
export const FRAGMENT_DIR = "changelog.d";

/** The bullets of one section of a fragment: its bold section label + raw bullet lines. */
export interface FragmentSection {
  /** The section label, e.g. `Bug fixes` — one of the labels in docs/changelog-conventions.md. */
  section: string;
  /** The bullet lines verbatim (a `- ` line plus any wrapped continuation lines). */
  bullets: string[];
}

/** Matches a fragment's `section: <label>` header line (leading/trailing space tolerated). */
const SECTION_HEADER = /^\s*section:\s*(.+?)\s*$/i;

/**
 * Parse one fragment file's text into its section blocks. A fragment is a sequence
 * of `section: <label>` headers, each followed by the bullet lines that belong to
 * it (bullets and their wrapped continuation lines are kept verbatim). Blank lines
 * separate blocks and are dropped; a fragment with no `section:` header yields
 * nothing (an orphan bullet has no home).
 */
export function parseFragment(text: string): FragmentSection[] {
  const sections: FragmentSection[] = [];
  let current: FragmentSection | undefined;
  for (const line of text.split("\n")) {
    const header = line.match(SECTION_HEADER);
    if (header) {
      current = { section: header[1], bullets: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue; // bullets before any section header have no home
    if (line.trim() === "") continue; // blank lines separate blocks
    current.bullets.push(line);
  }
  return sections;
}

/**
 * The bold section labels, in the order docs/changelog-conventions.md fixes them.
 * A milestone renders its sections in this order; a fragment naming a label outside
 * this set is still folded (appended after the known ones) rather than dropped.
 */
export const SECTION_ORDER = ["Breaking changes", "New features", "Improvements", "Bug fixes", "Documentation"];

/** A whole-line bold section label, `**New features:**` → `New features`. */
const LABEL_LINE = /^\*\*(.+):\*\*$/;

/** The date part of a milestone heading `### <title> — <date>`, or "" if it has none. */
function milestoneDate(headingLine: string): string {
  const at = headingLine.lastIndexOf(" — ");
  return at < 0 ? "" : headingLine.slice(at + " — ".length).trim();
}

/**
 * Parse a milestone body (the lines under its `### ` heading) into its sections,
 * keyed by label and preserving first-seen order. Blank separators are dropped;
 * each label's bullet lines are kept verbatim (bullets and their wrapped
 * continuations), so a re-render reproduces them.
 */
function parseMilestoneSections(body: string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of body) {
    const label = line.match(LABEL_LINE);
    if (label) {
      current = sections.get(label[1]) ?? [];
      sections.set(label[1], current);
      continue;
    }
    if (!current) continue; // blank lines / stray preamble before the first label
    if (line.trim() === "") continue;
    current.push(line);
  }
  return sections;
}

/** Merge fragment sections into a milestone's section map, one block per label. */
function mergeSections(into: Map<string, string[]>, additions: FragmentSection[]): void {
  for (const { section, bullets } of additions) {
    const existing = into.get(section) ?? [];
    existing.push(...bullets);
    into.set(section, existing);
  }
}

/** Render a milestone's sections in canonical order under its heading line. */
function renderMilestone(headingLine: string, sections: Map<string, string[]>): string {
  const known = SECTION_ORDER.filter((l) => sections.has(l));
  const extra = [...sections.keys()].filter((l) => !SECTION_ORDER.includes(l));
  const blocks = [...known, ...extra].map((label) => [`**${label}:**`, ...sections.get(label)!].join("\n"));
  return [headingLine, "", blocks.join("\n\n")].join("\n");
}

/** Split a changelog into its header (before the first milestone) and its milestone blocks. */
function splitMilestones(text: string): { header: string; milestones: { heading: string; body: string[] }[] } {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("### "));
  if (first < 0) return { header: text.replace(/\s+$/, ""), milestones: [] };
  const header = lines.slice(0, first).join("\n").replace(/\s+$/, "");
  const milestones: { heading: string; body: string[] }[] = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith("### ")) milestones.push({ heading: line, body: [] });
    else milestones[milestones.length - 1].body.push(line);
  }
  return { header, milestones };
}

/**
 * Fold fragment sections into `changelogText` under the current dated milestone
 * (issue #123). If the top milestone is already dated `today`, the fragments merge
 * into it — one block per label, sections in canonical order — so per-wave
 * collection accumulates into a single milestone for the day. Otherwise a new
 * milestone titled `title` and dated `today` is inserted at the top. Existing
 * milestones below the target are preserved verbatim, and each label renders as a
 * single block per milestone (never two blocks of one label).
 */
export function collectFragments(changelogText: string, sections: FragmentSection[], today: string, title: string): string {
  if (!sections.length) return changelogText;
  const { header, milestones } = splitMilestones(changelogText);

  let rendered: string[];
  if (milestones.length && milestoneDate(milestones[0].heading) === today) {
    const merged = parseMilestoneSections(milestones[0].body);
    mergeSections(merged, sections);
    rendered = [renderMilestone(milestones[0].heading, merged), ...milestones.slice(1).map(rawMilestone)];
  } else {
    const fresh = new Map<string, string[]>();
    mergeSections(fresh, sections);
    rendered = [renderMilestone(`### ${title} — ${today}`, fresh), ...milestones.map(rawMilestone)];
  }

  return [header, ...rendered].join("\n\n") + "\n";
}

/** Preserve an untouched milestone's exact text (heading + body, trailing blanks trimmed). */
const rawMilestone = (m: { heading: string; body: string[] }): string => [m.heading, ...m.body].join("\n").replace(/\s+$/, "");

/**
 * Render a date as a milestone heading's `Month DD, YYYY` (e.g. `August 26, 2026`),
 * in UTC so the milestone the collector writes is stable regardless of the host's
 * timezone. The CLI edge passes `new Date()` through this to get `today`.
 */
export function formatMilestoneDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** One fragment file: its basename and the sections parsed from its text. */
export interface Fragment {
  /** The file's basename, e.g. `123.md` — reported and deleted after a collect. */
  name: string;
  /** The section blocks parsed from the file. */
  sections: FragmentSection[];
}

/**
 * Read and parse every `*.md` fragment under `dir` (the edge read that keeps the
 * fold pure). A missing dir yields nothing; files are returned in sorted name
 * order so a collect is deterministic.
 */
export function scanFragments(dir: string): Fragment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name, sections: parseFragment(readFileSync(join(dir, name), "utf8")) }));
}

export interface CollectOptions {
  /** The `changelog.d/` directory holding this wave's fragments. */
  fragmentsDir: string;
  /** The `CHANGELOG.md` to fold them into. */
  changelogPath: string;
  /** Today's milestone date, from `formatMilestoneDate`. */
  today: string;
  /** The title for a new milestone (used only when the top one is not dated today). */
  title: string;
}

/**
 * Fold a NAMED subset of the directory's fragments into `CHANGELOG.md`, write it,
 * and delete only those consumed. `names` are fragment basenames (`147.md`); a name
 * that matches no fragment is skipped. This is the selective core `tidy` folds
 * with — it reconciles only the fragments whose issue is provably merged and leaves
 * the rest (a still-parked issue's fragment) on disk. A no-op (empty
 * `collected`, changelog untouched) when nothing named matches.
 */
export function foldFragments(opts: CollectOptions, names: string[]): { collected: string[] } {
  const wanted = new Set(names);
  const fragments = scanFragments(opts.fragmentsDir).filter((f) => wanted.has(f.name));
  if (!fragments.length) return { collected: [] };

  const sections = fragments.flatMap((f) => f.sections);
  const updated = collectFragments(readFileSync(opts.changelogPath, "utf8"), sections, opts.today, opts.title);
  writeFileSync(opts.changelogPath, updated);
  for (const f of fragments) unlinkSync(join(opts.fragmentsDir, f.name));
  return { collected: fragments.map((f) => f.name) };
}

/**
 * The CLI edge of `vetinari changelog collect`: read the wave's fragments, fold
 * them into `CHANGELOG.md`, write it, and delete the consumed fragments. A no-op
 * (empty `collected`, changelog untouched) when there are no fragments. Returns the
 * basenames it consumed. Folds every fragment present, unlike `foldFragments`'s
 * selective reconcile.
 *
 * The fold runs only when the project keeps a `CHANGELOG.md` (design §12): a project
 * with no changelog is opting out, so its fragments are left in place and `skipped`
 * is set to `no-changelog` for the caller to log — rather than materialising a
 * changelog no one asked for (or crashing on the missing read).
 */
export function applyCollect(opts: CollectOptions): { collected: string[]; skipped?: "no-changelog" } {
  const names = scanFragments(opts.fragmentsDir).map((f) => f.name);
  if (names.length && !existsSync(opts.changelogPath)) return { collected: [], skipped: "no-changelog" };
  return foldFragments(opts, names);
}
