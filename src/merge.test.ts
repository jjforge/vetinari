import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { applyTidy, collectWaveChangelog, computeTidy, integrateGreens, scanTidy, type TidySnapshot } from "./merge.ts";
import { setLogFile } from "./log.ts";
import { readEventLog } from "./event-log.ts";

/** A fresh git repo with a CHANGELOG.md committed, standing in for a campaign base. */
function repoWithChangelog(changelog: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-merge-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  return dir;
}

const headSubject = (dir: string) => execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
const headSha = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("collectWaveChangelog folds the wave's fragments into CHANGELOG.md and commits once", () => {
  const dir = repoWithChangelog("# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const fragDir = join(dir, "changelog.d");
  mkdirSync(fragDir);
  writeFileSync(join(fragDir, "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  writeFileSync(join(fragDir, "7.md"), "section: Bug fixes\n- [user] fix from 7 (#7).\n");
  // Post-merge state: the fragments arrived committed on merged branches.
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "merge agent branches"]);

  const result = collectWaveChangelog(1, dir);

  assert.equal(result.committed, true);
  assert.deepEqual(result.collected.sort(), ["42.md", "7.md"]);
  // A single collect commit, named by wave (1-based).
  assert.equal(headSubject(dir), "campaign: collect changelog (wave 2)");
  const written = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(written.includes("- [user] feature from 42 (#42)."));
  assert.ok(written.includes("- [user] fix from 7 (#7)."));
  assert.ok(written.includes("### Older — August 1, 2026"));
  // The consumed fragments are gone from the tree and the deletion is committed.
  assert.equal(existsSync(join(fragDir, "42.md")), false);
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
});

/**
 * A fresh repo on `main` whose seed touches `f.txt`, standing in for a campaign base.
 * Two agent branches both edit `f.txt` off the seed, so the second to merge conflicts.
 */
function repoWithConflictingGreens(): { dir: string; git: (args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-integ-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "f.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  // green A: edits f.txt off the seed — merges clean, it is the first green.
  git(["checkout", "-q", "-b", "agent/A"]);
  writeFileSync(join(dir, "f.txt"), "A\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "A"]);
  // green B: edits the same line off the seed — conflicts once A is on the base.
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "agent/B"]);
  writeFileSync(join(dir, "f.txt"), "B\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "B"]);
  git(["checkout", "-q", "main"]);
  return { dir, git };
}

test("integrateGreens quarantines a conflicting green, keeps the earlier green merged, and continues", async () => {
  const { dir, git } = repoWithConflictingGreens();
  const cfg = { branchPrefix: "agent/", baseBranch: "main" } as ResolvedConfig;
  const prevCwd = process.cwd();
  process.chdir(dir);
  setLogFile(join(dir, "orchestrator.jsonl"));
  try {
    const result = await integrateGreens(cfg, ["A", "B"], {
      gate: async () => ({ green: true, report: "" }),
    });

    // A stayed merged; only B was held — the wave neither rolled back nor parked.
    assert.deepEqual(result.merged, ["A"]);
    assert.deepEqual(result.quarantined, ["B"]);
    assert.equal(result.parked, undefined);
    // No `reset --hard` to the wave start: A's change is on the base (not "base").
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "A\n");
    // B's branch is preserved (resumable); A's merged branch is reclaimed.
    assert.equal(git(["branch", "--list", "agent/B"]).length > 0, true);
    assert.equal(git(["branch", "--list", "agent/A"]), "");
  } finally {
    process.chdir(prevCwd);
  }

  // The conflict was recorded as a `quarantined` event naming B and its branch.
  const q = readEventLog({ logFile: join(dir, "orchestrator.jsonl") }).filter((e) => e.event === "quarantined");
  assert.equal(q.length, 1);
  assert.deepEqual({ taskId: (q[0] as any).taskId, branch: (q[0] as any).branch }, { taskId: "B", branch: "agent/B" });
});

/**
 * A fresh repo on `main` whose seed touches `a.txt`/`b.txt`. Two agent branches edit
 * one file each off the seed, so both merge into the base clean — the setup for the
 * emergent failure where every green passes alone but the combined base gates red.
 */
function repoWithCleanGreens(): { dir: string; git: (args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-park-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  writeFileSync(join(dir, "b.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  git(["checkout", "-q", "-b", "agent/A"]);
  writeFileSync(join(dir, "a.txt"), "A\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "A"]);
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "agent/B"]);
  writeFileSync(join(dir, "b.txt"), "B\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "B"]);
  git(["checkout", "-q", "main"]);
  return { dir, git };
}

test("integrateGreens wave-parks a red merged base: leaves the greens merged, does not reset, preserves branches", async () => {
  const { dir, git } = repoWithCleanGreens();
  const cfg = { branchPrefix: "agent/", baseBranch: "main" } as ResolvedConfig;
  const prevCwd = process.cwd();
  process.chdir(dir);
  setLogFile(join(dir, "orchestrator.jsonl"));
  const preSha = git(["rev-parse", "HEAD"]);
  try {
    const result = await integrateGreens(cfg, ["A", "B"], {
      gate: async () => ({ green: false, report: "line1\nline2\nGATE FAILED here" }),
    });

    // AC1: both greens stay merged on the base — no rollback, no reset to the wave start.
    assert.deepEqual(result.merged, ["A", "B"]);
    assert.deepEqual(result.quarantined, []);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A\n");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "B\n");
    assert.notEqual(headSha(dir), preSha); // HEAD advanced past the wave start — merges are real

    // AC2: the emergent, unattributable failure surfaces as a resumable park, not a halt.
    assert.ok(result.parked);
    assert.equal(result.parked!.reason, "gate-red");
    assert.ok(result.parked!.detail.includes("GATE FAILED here"));

    // Branches are preserved so a human can fix forward or carve a suspect and resume.
    assert.equal(git(["branch", "--list", "agent/A"]).length > 0, true);
    assert.equal(git(["branch", "--list", "agent/B"]).length > 0, true);
  } finally {
    process.chdir(prevCwd);
  }

  // AC2: a `wave-parked` event records the greens left merged and the tail of the gate report.
  const parked = readEventLog({ logFile: join(dir, "orchestrator.jsonl") }).filter((e) => e.event === "wave-parked");
  assert.equal(parked.length, 1);
  assert.deepEqual((parked[0] as any).merged, ["A", "B"]);
  assert.ok((parked[0] as any).detail.includes("GATE FAILED here"));
});

test("integrateGreens skips the merged-base gate when every green conflicts", async () => {
  const { dir } = repoWithConflictingGreens();
  const cfg = { branchPrefix: "agent/", baseBranch: "main" } as ResolvedConfig;
  const prevCwd = process.cwd();
  process.chdir(dir);
  setLogFile(join(dir, "orchestrator.jsonl"));
  let gateRan = false;
  try {
    // Put B's conflicting change on the base first so A also conflicts.
    execFileSync("git", ["-C", dir, "merge", "--no-ff", "agent/B", "-m", "pre"], { encoding: "utf8" });
    const result = await integrateGreens(cfg, ["A"], {
      gate: async () => {
        gateRan = true;
        return { green: true, report: "" };
      },
    });
    assert.deepEqual(result.merged, []);
    assert.deepEqual(result.quarantined, ["A"]);
    assert.equal(result.parked, undefined);
    assert.equal(gateRan, false); // nothing merged → nothing to gate
  } finally {
    process.chdir(prevCwd);
  }
});

const emptySnapshot = (): TidySnapshot => ({ branches: [], fragments: [], parked: [], quarantined: [], waveParked: [] });

test("computeTidy deletes a reachable branch and folds its fragment, keeps an unmerged one", () => {
  const plan = computeTidy({
    ...emptySnapshot(),
    branches: [
      { id: "42", reachable: true }, // merged by hand → GC
      { id: "43", reachable: false }, // still has unmerged work → never touch
    ],
    fragments: ["42", "43"],
  });

  assert.deepEqual(plan.deleteBranches, ["42"]);
  assert.deepEqual(plan.fold, ["42"]);
  assert.deepEqual(plan.clearParked, []);
  // The unmerged branch and its fragment are left alone.
  assert.deepEqual(
    plan.keep.map((k) => k.id),
    ["43"],
  );
  assert.equal(plan.keep[0].reason, "unmerged");
});

test("computeTidy never touches a quarantined, parked, or wave-parked branch even when reachable", () => {
  const plan = computeTidy({
    ...emptySnapshot(),
    branches: [
      { id: "q", reachable: true },
      { id: "p", reachable: true },
      { id: "w", reachable: true },
      { id: "ok", reachable: true },
    ],
    fragments: ["q", "p", "w", "ok"],
    parked: ["p"],
    quarantined: ["q"],
    waveParked: ["w"],
  });

  // Only the unprotected merged branch is GC'd; the three protected ones are kept.
  assert.deepEqual(plan.deleteBranches, ["ok"]);
  assert.deepEqual(plan.fold, ["ok"]);
  const reasons = Object.fromEntries(plan.keep.map((k) => [k.id, k.reason]));
  assert.deepEqual(reasons, { q: "quarantined", p: "parked", w: "wave-parked" });
});

test("computeTidy folds an orphaned fragment whose branch is already gone", () => {
  const plan = computeTidy({ ...emptySnapshot(), branches: [], fragments: ["99"] });
  // No branch named agent/99 → the work merged and its branch was cleaned; fold the leftover.
  assert.deepEqual(plan.fold, ["99"]);
  assert.deepEqual(plan.deleteBranches, []);
});

test("computeTidy warns on a merged issue with no changelog fragment, and does not invent one", () => {
  const plan = computeTidy({ ...emptySnapshot(), branches: [{ id: "50", reachable: true }], fragments: [] });
  assert.deepEqual(plan.deleteBranches, ["50"]);
  assert.deepEqual(plan.fold, []);
  assert.deepEqual(plan.warnNoChangelog, ["50"]); // warned, never invented
});

test("computeTidy clears a stale parked record once its issue is merged, but keeps the branch that run", () => {
  const plan = computeTidy({
    ...emptySnapshot(),
    branches: [{ id: "p", reachable: true }],
    parked: ["p"],
  });
  // The record is stale (issue merged); clear it. The branch stays this run — a
  // parked branch is never touched — so a later run GCs it once unprotected.
  assert.deepEqual(plan.clearParked, ["p"]);
  assert.deepEqual(plan.deleteBranches, []);
  assert.equal(plan.keep[0].reason, "parked");
});

test("computeTidy leaves a genuinely parked issue (present, unmerged) fully alone", () => {
  const plan = computeTidy({
    ...emptySnapshot(),
    branches: [{ id: "p", reachable: false }],
    parked: ["p"],
    fragments: ["p"],
  });
  assert.deepEqual(plan.clearParked, []); // still in flight
  assert.deepEqual(plan.deleteBranches, []);
  assert.deepEqual(plan.fold, []);
});

test("scanTidy reads reachability, fragments, and parked records; applyTidy folds, GCs, and clears", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-tidy-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);

  // agent/42: a by-hand-merged issue — its change + changelog fragment reached main.
  git(["checkout", "-q", "-b", "agent/42"]);
  writeFileSync(join(dir, "a.txt"), "42\n");
  mkdirSync(join(dir, "changelog.d"));
  writeFileSync(join(dir, "changelog.d", "42.md"), "section: New features\n- [user] feature from 42 (#42).\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "42"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "--no-ff", "-q", "agent/42", "-m", "by-hand merge 42"]);

  // agent/43: still-in-flight work off the seed — an unmerged commit, never touched.
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "agent/43"]);
  writeFileSync(join(dir, "b.txt"), "43\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "43"]);
  git(["checkout", "-q", "main"]);

  // A stale parked record for #50 — a human fixed it forward and deleted its branch
  // by hand, so the record is orphaned (no `agent/50` head remains).
  const parkedDir = join(dir, "parked");
  mkdirSync(parkedDir);
  writeFileSync(join(parkedDir, "50.json"), JSON.stringify({ taskId: "50", branch: "agent/50", reason: "blocked", parkedAt: "x", question: "?" }));

  const target = {
    project: "demo",
    root: dir,
    baseBranch: "main",
    branchPrefix: "agent/",
    parkedDir,
    logFile: join(dir, "orchestrator.jsonl"),
    fragmentsDir: join(dir, "changelog.d"),
    changelogPath: join(dir, "CHANGELOG.md"),
  };

  const snap = scanTidy(target);
  assert.deepEqual(
    snap.branches.sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: "42", reachable: true }, { id: "43", reachable: false }],
  );
  assert.deepEqual(snap.fragments, ["42"]);
  assert.deepEqual(snap.parked, ["50"]);

  const plan = computeTidy(snap);
  assert.deepEqual(plan.deleteBranches, ["42"]);
  assert.deepEqual(plan.fold, ["42"]);
  assert.deepEqual(plan.clearParked, ["50"]); // branch already gone → record is stale
  assert.deepEqual(
    plan.keep.map((k) => k.id),
    ["43"],
  );

  applyTidy(target, plan);

  // #42 folded into CHANGELOG.md and its fragment deleted.
  const written = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(written.includes("- [user] feature from 42 (#42)."));
  assert.equal(existsSync(join(dir, "changelog.d", "42.md")), false);
  // agent/42 GC'd, agent/43 preserved.
  assert.equal(git(["branch", "--list", "agent/42"]), "");
  assert.ok(git(["branch", "--list", "agent/43"]).length > 0);
  // The stale parked record is cleared.
  assert.equal(existsSync(join(parkedDir, "50.json")), false);
});

test("scanTidy reads wave-parked issues from the event log so their reachable branches are protected", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-tidy-wp-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "seed.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);

  // A wave-parked wave: its greens #70/#71 are MERGED on the base (reachable) but the
  // combined gate is red, so the wave is paused — their branches must be preserved.
  for (const id of ["70", "71"]) {
    git(["checkout", "-q", "-b", `agent/${id}`]);
    writeFileSync(join(dir, `${id}.txt`), `${id}\n`);
    git(["add", "-A"]);
    git(["commit", "-qm", id]);
    git(["checkout", "-q", "main"]);
    git(["merge", "--no-ff", "-q", `agent/${id}`, "-m", `merge ${id}`]);
  }
  // #72 is an unrelated by-hand-merged branch — GC fodder.
  git(["checkout", "-q", "-b", "agent/72"]);
  writeFileSync(join(dir, "72.txt"), "72\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "72"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "--no-ff", "-q", "agent/72", "-m", "merge 72"]);

  const logFile = join(dir, "orchestrator.jsonl");
  writeFileSync(
    logFile,
    [
      JSON.stringify({ event: "campaign-start", batches: [["70", "71"]] }),
      JSON.stringify({ event: "campaign-batch", index: 0 }),
      JSON.stringify({ event: "wave-parked", merged: ["70", "71"], detail: "gate red" }),
    ].join("\n") + "\n",
  );

  const target = {
    project: "demo",
    root: dir,
    baseBranch: "main",
    branchPrefix: "agent/",
    parkedDir: join(dir, "parked"),
    logFile,
    fragmentsDir: join(dir, "changelog.d"),
    changelogPath: join(dir, "CHANGELOG.md"),
  };

  const snap = scanTidy(target);
  assert.deepEqual(snap.waveParked.sort(), ["70", "71"]);

  const plan = computeTidy(snap);
  // Only the unrelated #72 is GC'd; the wave-parked greens are kept despite being reachable.
  assert.deepEqual(plan.deleteBranches, ["72"]);
  const kept = Object.fromEntries(plan.keep.map((k) => [k.id, k.reason]));
  assert.deepEqual(kept, { "70": "wave-parked", "71": "wave-parked" });
});

test("collectWaveChangelog makes no commit when the wave left no fragments", () => {
  const dir = repoWithChangelog("# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  const before = headSha(dir);

  const result = collectWaveChangelog(0, dir);

  assert.equal(result.committed, false);
  assert.deepEqual(result.collected, []);
  assert.equal(headSha(dir), before); // HEAD untouched — nothing to collect
});
