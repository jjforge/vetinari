import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCollect, collectFragments, foldFragments, formatMilestoneDate, parseFragment } from "./changelog.ts";

test("parseFragment reads a single section and its bullets", () => {
  const frag = ["section: Bug fixes", "- [user] a prune of a merged target dropped its dependents (#42)."].join("\n");
  assert.deepEqual(parseFragment(frag), [
    { section: "Bug fixes", bullets: ["- [user] a prune of a merged target dropped its dependents (#42)."] },
  ]);
});

test("parseFragment keeps a bullet's wrapped continuation lines attached", () => {
  const frag = [
    "section: New features",
    "- [user] `vetinari changelog collect` (#123) — fold per-task fragments into",
    "  CHANGELOG.md at merge time.",
  ].join("\n");
  assert.deepEqual(parseFragment(frag), [
    {
      section: "New features",
      bullets: ["- [user] `vetinari changelog collect` (#123) — fold per-task fragments into", "  CHANGELOG.md at merge time."],
    },
  ]);
});

test("parseFragment splits multiple section blocks in one fragment", () => {
  const frag = ["section: New features", "- [user] a (#1).", "", "section: Documentation", "- [internal] b (#1)."].join("\n");
  assert.deepEqual(parseFragment(frag), [
    { section: "New features", bullets: ["- [user] a (#1)."] },
    { section: "Documentation", bullets: ["- [internal] b (#1)."] },
  ]);
});

test("parseFragment tolerates blank lines and trailing whitespace around a column-0 section header", () => {
  const frag = ["", "section:   Improvements  ", "- [user] tidier output (#7).", ""].join("\n");
  assert.deepEqual(parseFragment(frag), [{ section: "Improvements", bullets: ["- [user] tidier output (#7)."] }]);
});

test("parseFragment ignores a section: line with leading whitespace — a README's indented example is not a fragment", () => {
  const readme = [
    "# changelog.d",
    "",
    "Each task writes one fragment here, in this format:",
    "",
    "    section: Bug fixes",
    "    - [user] What changed, and what it means for whoever it reaches (#123).",
    "",
    "Fold by hand with `npx vetinari changelog collect`.",
  ].join("\n");
  assert.deepEqual(parseFragment(readme), []);
});

test("parseFragment on a fragment with no section header yields nothing", () => {
  assert.deepEqual(parseFragment("- [user] an orphan bullet (#1)."), []);
});

const CHANGELOG = `# Changelog

**Reading this file.** Every change is logged.

### An earlier theme — August 20, 2026

**New features:**
- [user] the old feature (#100)

**Bug fixes:**
- [user] the old fix (#101)
`;

test("collectFragments starts a new milestone at the top when the top milestone is not dated today", () => {
  const out = collectFragments(
    CHANGELOG,
    [{ section: "New features", bullets: ["- [user] a shiny thing (#2)."] }],
    "August 26, 2026",
    "A brand new theme",
  );
  const lines = out.split("\n");
  // The new milestone leads, dated today, with the given title.
  assert.equal(lines[4], "### A brand new theme — August 26, 2026");
  assert.equal(lines[6], "**New features:**");
  assert.equal(lines[7], "- [user] a shiny thing (#2).");
  // The earlier milestone is preserved verbatim below it.
  assert.ok(out.includes("### An earlier theme — August 20, 2026"));
  assert.ok(out.includes("- [user] the old feature (#100)"));
  assert.ok(out.includes("- [user] the old fix (#101)"));
  // The preamble survives at the top.
  assert.ok(out.startsWith("# Changelog\n\n**Reading this file.**"));
});

test("collectFragments folds into today's top milestone, one block per label, canonical order", () => {
  const today = `# Changelog

### Today's work — August 26, 2026

**New features:**
- [user] first feature (#1)

**Bug fixes:**
- [user] first fix (#2)
`;
  const out = collectFragments(
    today,
    [
      { section: "Bug fixes", bullets: ["- [user] second fix (#3)."] },
      { section: "Improvements", bullets: ["- [user] a refinement (#4)."] },
    ],
    "August 26, 2026",
    "ignored because the top milestone already matches today",
  );
  // Only one milestone heading — we folded into the existing one, not a new one.
  assert.equal(out.match(/^### /gm)?.length, 1);
  // One block per label: both bug fixes live under a single **Bug fixes:** block.
  assert.equal(out.match(/\*\*Bug fixes:\*\*/g)?.length, 1);
  assert.ok(out.includes("- [user] first fix (#2)\n- [user] second fix (#3)."));
  // Improvements is inserted in canonical order — after New features, before Bug fixes.
  assert.ok(out.indexOf("**New features:**") < out.indexOf("**Improvements:**"));
  assert.ok(out.indexOf("**Improvements:**") < out.indexOf("**Bug fixes:**"));
});

test("collectFragments keeps a consuming project's extra section labels in their documented order", () => {
  // The fold RE-RENDERS the milestone it folds into, so every label the sibling
  // jjforge project uses must be known here: an unknown one is appended after the
  // known set, which would move Documentation above Security and silently reorder a
  // milestone the fragment never mentioned. A repeated-label lint cannot catch that,
  // so this is the only guard.
  const today = `# Changelog

### Today's work — August 26, 2026

**Security:**
- [ops] a hardening (#1)

**Documentation:**
- [internal] a doc (#2)
`;
  const out = collectFragments(
    today,
    [{ section: "Testing", bullets: ["- [internal] a test (#3)."] }],
    "August 26, 2026",
    "ignored — the top milestone is today's",
  );
  // Security stays above Documentation, and the new Testing block lands between them.
  assert.ok(out.indexOf("**Security:**") < out.indexOf("**Testing:**"));
  assert.ok(out.indexOf("**Testing:**") < out.indexOf("**Documentation:**"));
});

test("collectFragments folds two same-day collects into one block per label, not a second header", () => {
  // Two collects in one day: the second must fold into the first's milestone, not
  // add a second **Bug fixes:** block — one block per label per milestone.
  const once = collectFragments(
    "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n",
    [{ section: "Bug fixes", bullets: ["- [user] fix one (#2)."] }],
    "August 26, 2026",
    "Wave collection",
  );
  const twice = collectFragments(
    once,
    [{ section: "Bug fixes", bullets: ["- [user] fix two (#3)."] }],
    "August 26, 2026",
    "Wave collection",
  );
  assert.equal(twice.match(/\*\*Bug fixes:\*\*/g)?.length, 2); // one per milestone, not two in one
  // Both of today's fixes live under today's single block.
  assert.ok(twice.includes("- [user] fix one (#2).\n- [user] fix two (#3)."));
});

test("formatMilestoneDate renders a UTC date as the milestone's Month DD, YYYY", () => {
  assert.equal(formatMilestoneDate(new Date("2026-08-26T09:30:00Z")), "August 26, 2026");
  assert.equal(formatMilestoneDate(new Date("2026-01-05T23:59:59Z")), "January 5, 2026");
});

test("applyCollect folds changelog.d fragments into CHANGELOG.md and deletes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  writeFileSync(join(fragDir, "7.md"), "section: Bug fixes\n- [user] fix from 7 (#7).\n");

  const result = applyCollect({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Wave collection" });

  assert.deepEqual(result.collected.sort(), ["42.md", "7.md"]);
  const written = readFileSync(changelog, "utf8");
  assert.ok(written.includes("### Wave collection — August 26, 2026"));
  assert.ok(written.includes("- [user] feature from 42 (#42)."));
  assert.ok(written.includes("- [user] fix from 7 (#7)."));
  assert.ok(written.includes("### Older — August 1, 2026")); // untouched below
  // Consumed fragments are gone; the dir remains.
  assert.equal(existsSync(join(fragDir, "42.md")), false);
  assert.equal(existsSync(join(fragDir, "7.md")), false);
  assert.equal(existsSync(fragDir), true);
});

test("foldFragments folds only the named fragments, leaving the rest on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-fold-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  writeFileSync(join(fragDir, "7.md"), "section: Bug fixes\n- [user] fix from 7 (#7).\n");

  const result = foldFragments({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Collected changes" }, [
    "42.md",
  ]);

  assert.deepEqual(result.collected, ["42.md"]);
  const written = readFileSync(changelog, "utf8");
  assert.ok(written.includes("- [user] feature from 42 (#42).")); // 42 folded
  assert.ok(!written.includes("fix from 7")); // 7 left untouched
  // Only the named fragment is consumed; 7.md stays for its own resolution.
  assert.equal(existsSync(join(fragDir, "42.md")), false);
  assert.equal(existsSync(join(fragDir, "7.md")), true);
});

test("foldFragments is a no-op when the named set is empty or unmatched", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-fold-none-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  const before = readFileSync(changelog, "utf8");

  const result = foldFragments({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Collected changes" }, [
    "999.md",
  ]);

  assert.deepEqual(result.collected, []);
  assert.equal(readFileSync(changelog, "utf8"), before); // untouched
  assert.equal(existsSync(join(fragDir, "42.md")), true); // unnamed fragment stays
});

test("applyCollect folds when the project has a CHANGELOG.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-present-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");

  const result = applyCollect({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Wave collection" });

  assert.deepEqual(result.collected, ["42.md"]);
  assert.equal(result.skipped, undefined);
  assert.ok(readFileSync(changelog, "utf8").includes("- [user] feature from 42 (#42)."));
  assert.equal(existsSync(join(fragDir, "42.md")), false); // consumed
});

test("applyCollect leaves fragments in place when the project has no CHANGELOG.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-absent-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md"); // never created
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");

  const result = applyCollect({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Wave collection" });

  assert.deepEqual(result.collected, []);
  assert.equal(result.skipped, "no-changelog");
  assert.equal(existsSync(changelog), false); // not created
  assert.equal(existsSync(join(fragDir, "42.md")), true); // fragment left in place
});

test("applyCollect is a no-op when there are no fragments", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-none-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const before = readFileSync(changelog, "utf8");

  const result = applyCollect({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Wave collection" });

  assert.deepEqual(result.collected, []);
  assert.equal(readFileSync(changelog, "utf8"), before); // untouched
});

test("applyCollect folds only real fragments, leaves every other file byte-for-byte, and names the near-misses", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-mixed-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  const readme = [
    "# changelog.d",
    "",
    "One fragment per task, in this format:",
    "",
    "    section: Bug fixes",
    "    - [user] What changed (#123).",
    "",
    "Fold by hand with `npx vetinari changelog collect`.",
    "",
  ].join("\n");
  const headerless = "- [internal] headerless bullet (#90).\n";
  const headerOnly = "section: Bug fixes\n\n";
  writeFileSync(join(fragDir, "README.md"), readme);
  writeFileSync(join(fragDir, "90.md"), headerless);
  writeFileSync(join(fragDir, "91.md"), headerOnly);

  const result = applyCollect({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Wave collection" });

  assert.deepEqual(result.collected, ["42.md"]);
  assert.equal(existsSync(join(fragDir, "42.md")), false);
  assert.equal(readFileSync(join(fragDir, "README.md"), "utf8"), readme);
  assert.equal(readFileSync(join(fragDir, "90.md"), "utf8"), headerless);
  assert.equal(readFileSync(join(fragDir, "91.md"), "utf8"), headerOnly);
  assert.equal(
    readFileSync(changelog, "utf8"),
    "# Changelog\n\n### Wave collection — August 26, 2026\n\n**New features:**\n- [user] feature from 42 (#42).\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n",
  );
  assert.deepEqual(result.nearMisses, [
    { name: "90.md", reason: "bullets but no section: header" },
    { name: "91.md", reason: "section: header but no bullets" },
  ]);
});

test("foldFragments never deletes a named file that contributed no bullets, and names it when it is a near-miss", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-fold-nearmiss-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "90.md"), "- [internal] headerless bullet (#90).\n");
  writeFileSync(join(fragDir, "91.md"), "Just some prose, no fragment here.\n");
  const before = readFileSync(changelog, "utf8");

  const result = foldFragments({ fragmentsDir: fragDir, changelogPath: changelog, today: "August 26, 2026", title: "Collected changes" }, [
    "90.md",
    "91.md",
  ]);

  assert.deepEqual(result.collected, []);
  assert.deepEqual(result.nearMisses, [{ name: "90.md", reason: "bullets but no section: header" }]);
  assert.equal(readFileSync(changelog, "utf8"), before); // nothing folded
  assert.equal(existsSync(join(fragDir, "90.md")), true);
  assert.equal(existsSync(join(fragDir, "91.md")), true);
});

// Spawn the real CLI so `changelog collect`'s printed output is exercised end to end.
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

test("changelog collect prints the near-miss line alongside its usual output", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-cli-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  writeFileSync(join(fragDir, "91.md"), "section: Bug fixes\n");

  const run = spawnSync(TSX, [CLI, "changelog", "collect"], { cwd: dir, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "collected 1 fragment(s) into CHANGELOG.md: 42.md",
    "changelog.d: left in place, not folded — 91.md (section: header but no bullets)",
  ]);
});

test("changelog collect prints no near-miss line when there are none", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-collect-cli-clean-"));
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(fragDir, "README.md"), "Fragments go here.\n");

  const run = spawnSync(TSX, [CLI, "changelog", "collect"], { cwd: dir, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "nothing to collect — changelog.d/ has no fragments.\n");
});
