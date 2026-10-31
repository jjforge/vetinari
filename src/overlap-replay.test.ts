import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet, type FileSetOf } from "./fileset.ts";
import { overlapVerdict, renderOverlapReport, replayOverlap, type OverlapTracker } from "./overlap-replay.ts";

/** A scratch project: a git repo on `main` whose history the tests build merge by merge. */
function scratchProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "overlap-replay-project-"));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).trim();
  git(["-c", "init.defaultBranch=main", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  write(dir, files);
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  const logLines: object[] = [];
  return {
    dir,
    git,
    /** Commit `files` on `agent/<id>` cut from `from` (default: main), then merge it into main as
     *  the orchestrator does, committed at `at`. A conflicted merge takes the branch's side. */
    land(id: string, files: Record<string, string>, at: string, from = "main") {
      git(["checkout", "-q", "-b", `agent/${id}`, from]);
      write(dir, files);
      git(["commit", "-qam", `work on ${id}`]);
      git(["checkout", "-q", "main"]);
      const env = { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at };
      try {
        git(["merge", "--no-ff", "-q", "-m", `campaign: merge agent/${id}`, `agent/${id}`], env);
      } catch {
        git(["checkout", "--theirs", "--", "."]);
        git(["add", "-A"]);
        git(["commit", "-qm", `campaign: merge agent/${id}`], env);
      }
    },
    /** Append event rows to the project's live orchestrator log. */
    log(...rows: object[]) {
      logLines.push(...rows);
      mkdirSync(join(dir, ".vetinari.local", "logs"), { recursive: true });
      writeFileSync(join(dir, ".vetinari.local", "logs", "orchestrator.jsonl"), logLines.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
  };
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
}

/** A tracker stub: each issue's prose cites `Touches:` the given files; no blockers unless named. */
function tracker(touches: Record<string, string[]>, blockers: Record<string, string[]> = {}): OverlapTracker & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    issueText: async (id) => {
      read.push(id);
      return JSON.stringify({
        title: `ticket ${id}`,
        body: `Touches: ${(touches[id] ?? []).map((f) => `\`${f}\``).join(", ")}`,
        comments: [],
      });
    },
    blockedBy: async (id) => blockers[id] ?? [],
  };
}

const lines = (...ls: string[]) => ls.join("\n") + "\n";
const start = (ts: string, waves: string[][]) => ({ ts, event: "campaign-start", waves, slots: 4 });

test("a pair of tickets that both declared a key and whose real changes merge cleanly counts as clean for it", async () => {
  const p = scratchProject({ "k.txt": lines("one", "-", "two", "-", "three") });
  p.log(start("2026-01-01T00:00:00Z", [["1", "2"]]));
  p.land("1", { "k.txt": lines("ONE", "-", "two", "-", "three") }, "2026-01-01T01:00:00Z", "main");
  p.land("2", { "k.txt": lines("one", "-", "two", "-", "THREE") }, "2026-01-01T02:00:00Z", "main~1");

  const result = await replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: tracker({ 1: ["k.txt"], 2: ["k.txt"] }) });

  assert.deepEqual(result.keys, [{ key: "k.txt", pairs: 1, clean: 1, collides: 0, indeterminate: 0, rate: 0 }]);
});

/** The project's refs, object count and working-tree status — what a read-only run must leave as it found. */
function snapshot(dir: string) {
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { refs: git(["for-each-ref"]), objects: git(["count-objects", "-v"]), status: git(["status", "--porcelain", "--ignored"]) };
}

/** Three archived-and-live campaigns over `k.txt`: a pair that merges cleanly, one that conflicts,
 *  and one whose second ticket was cut after the first merged and rewrote its line. */
function threePairProject() {
  const p = scratchProject({ "k.txt": lines("one", "-", "two", "-", "three") });
  // Campaign 1, archived: 1 and 2 edit different lines — clean.
  p.land("1", { "k.txt": lines("ONE", "-", "two", "-", "three") }, "2026-01-01T01:00:00Z");
  p.land("2", { "k.txt": lines("one", "-", "two", "-", "THREE") }, "2026-01-01T02:00:00Z", "main~1");
  // Campaign 2: 3 and 4 both rewrite line 1 — a conflict.
  p.land("3", { "k.txt": lines("THREE-WAS-HERE", "-", "two", "-", "THREE") }, "2026-01-02T01:00:00Z");
  p.land("4", { "k.txt": lines("FOUR-WAS-HERE", "-", "two", "-", "THREE") }, "2026-01-02T02:00:00Z", "main~1");
  // Campaign 3: 6 was cut after 5 merged and edits the line 5 wrote — no common base to apply on.
  p.land("5", { "k.txt": lines("FOUR-WAS-HERE", "-", "five", "-", "THREE") }, "2026-01-03T01:00:00Z");
  p.land("6", { "k.txt": lines("FOUR-WAS-HERE", "-", "five and six", "-", "THREE") }, "2026-01-03T02:00:00Z");
  mkdirSync(join(p.dir, ".vetinari.local", "logs", "archive"), { recursive: true });
  writeFileSync(
    join(p.dir, ".vetinari.local", "logs", "archive", "orchestrator-2026-01-01.jsonl"),
    JSON.stringify(start("2026-01-01T00:00:00Z", [["1", "2"]])) + "\n",
  );
  p.log(start("2026-01-02T00:00:00Z", [["3", "4"]]), start("2026-01-03T00:00:00Z", [["5"], ["6"]]));
  const touches = Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((id) => [id, ["k.txt"]]));
  return { p, touches };
}

test("the replay counts a clean, a conflicting and an un-appliable pair once each, rates the key 50%, and leaves the project's repo untouched", async () => {
  const { p, touches } = threePairProject();
  const before = snapshot(p.dir);
  const tmpRoot = mkdtempSync(join(tmpdir(), "overlap-replay-tmp-"));

  const result = await replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: tracker(touches), tmpRoot });

  assert.deepEqual(result.keys, [{ key: "k.txt", pairs: 3, clean: 1, collides: 1, indeterminate: 1, rate: 0.5 }]);
  assert.deepEqual(snapshot(p.dir), before, "the project's refs, objects or working tree changed");
  assert.deepEqual(readdirSync(tmpRoot), [], "the temporary clone was left behind");
});

test("a pair that conflicts only in b.ts counts as colliding on b.ts but clean on a.md, which both also declared", async () => {
  const p = scratchProject({ "a.md": lines("intro", "-", "outro"), "b.ts": lines("const x = 0;") });
  p.log(start("2026-01-01T00:00:00Z", [["1", "2"]]));
  p.land("1", { "a.md": lines("INTRO", "-", "outro"), "b.ts": lines("const x = 1;") }, "2026-01-01T01:00:00Z");
  p.land("2", { "a.md": lines("intro", "-", "OUTRO"), "b.ts": lines("const x = 2;") }, "2026-01-01T02:00:00Z", "main~1");

  const result = await replayOverlap({
    root: p.dir,
    fileSet: defaultFileSet(p.dir),
    tracker: tracker({ 1: ["a.md", "b.ts"], 2: ["a.md", "b.ts"] }),
  });

  assert.deepEqual(
    result.keys.map(({ key, clean, collides }) => ({ key, clean, collides })),
    [
      { key: "a.md", clean: 1, collides: 0 },
      { key: "b.ts", clean: 0, collides: 1 },
    ],
  );
});

test("a pair where one ticket is transitively blocked by the other is left out; a pair with disjoint real diffs is clean", async () => {
  const p = scratchProject({ "k.txt": lines("one"), "x.txt": "x\n", "y.txt": "y\n", "z.txt": "z\n" });
  p.log(start("2026-01-01T00:00:00Z", [["1", "4"], ["2"], ["3"]]));
  // 3 is blocked by 2, which is blocked by 1: 1–3 are dependent, though 3 never names 1.
  p.land("1", { "x.txt": "X\n" }, "2026-01-01T01:00:00Z");
  p.land("2", { "y.txt": "Y\n" }, "2026-01-01T02:00:00Z");
  p.land("3", { "z.txt": "Z\n" }, "2026-01-01T03:00:00Z");
  // 4 declared k.txt too but its real change never met 1's.
  p.land("4", { "k.txt": lines("four") }, "2026-01-01T04:00:00Z", "main~3");
  const touches = { 1: ["k.txt"], 3: ["k.txt"], 4: ["k.txt"] };

  const result = await replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: tracker(touches, { 3: ["2"], 2: ["1"] }) });

  // 1–4 and 3–4 count (both clean: no real overlap); 1–3 does not.
  assert.deepEqual(result.keys, [{ key: "k.txt", pairs: 2, clean: 2, collides: 0, indeterminate: 0, rate: 0 }]);
});

/** Two tickets that both rewrote line 1 of k.txt in one campaign. */
function conflictingPair(campaignStart: object) {
  const p = scratchProject({ "k.txt": lines("one"), "other.txt": "o\n" });
  p.log(campaignStart);
  p.land("1", { "k.txt": lines("uno") }, "2026-01-01T01:00:00Z");
  p.land("2", { "k.txt": lines("eins") }, "2026-01-01T02:00:00Z", "main~1");
  return p;
}

test("keys recorded on campaign-start are used as declared, and the issue is never read for that campaign", async () => {
  const p = conflictingPair({ ...start("2026-01-01T00:00:00Z", [["1", "2"]]), fileKeys: { 1: ["k.txt"], 2: ["k.txt"] } });
  const t = tracker({ 1: ["other.txt"], 2: ["other.txt"] });

  const result = await replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: t });

  assert.deepEqual(
    result.keys.map(({ key, collides }) => ({ key, collides })),
    [{ key: "k.txt", collides: 1 }],
  );
  assert.deepEqual(t.read, []);
});

test("with no recorded keys, a Touches: marker that lives only in a triage comment is found", async () => {
  const p = conflictingPair(start("2026-01-01T00:00:00Z", [["1", "2"]]));
  const t: OverlapTracker = {
    issueText: async (id) =>
      JSON.stringify({
        title: `ticket ${id}`,
        body: "Some prose about `other.txt`.",
        comments: [{ body: "## Agent Brief\n\nTouches (existing files): `k.txt`" }],
      }),
    blockedBy: async () => [],
  };

  const result = await replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: t });

  assert.deepEqual(
    result.keys.map(({ key, collides }) => ({ key, collides })),
    [{ key: "k.txt", collides: 1 }],
  );
});

test("a ticket whose cites no longer all resolve contributes the keys that do, and is counted", async () => {
  const p = conflictingPair(start("2026-01-01T00:00:00Z", [["1", "2"]]));

  const result = await replayOverlap({
    root: p.dir,
    fileSet: defaultFileSet(p.dir),
    tracker: tracker({ 1: ["k.txt", "gone.txt"], 2: ["k.txt"] }),
  });

  assert.deepEqual(
    result.keys.map(({ key, collides }) => ({ key, collides })),
    [{ key: "k.txt", collides: 1 }],
  );
  assert.deepEqual(result.staleCiteTickets, ["1"]);
});

test("a run that throws midway still removes its temporary clone and leaves the project's repo untouched", async () => {
  const { p } = threePairProject();
  const before = snapshot(p.dir);
  const tmpRoot = mkdtempSync(join(tmpdir(), "overlap-replay-tmp-"));
  const failing: OverlapTracker = {
    issueText: async () => {
      throw new Error("tracker down");
    },
    blockedBy: async () => [],
  };

  await assert.rejects(replayOverlap({ root: p.dir, fileSet: defaultFileSet(p.dir), tracker: failing, tmpRoot }), /tracker down/);

  assert.deepEqual(readdirSync(tmpRoot), [], "the temporary clone was left behind");
  assert.deepEqual(snapshot(p.dir), before, "the project's refs, objects or working tree changed");
});

test("a key needs 5 measured pairs to judge: 6 clean is a waive candidate, 2 collisions in 6 (33%) a hot spot, 3 pairs too few", () => {
  const tally = (clean: number, collides: number, indeterminate = 0) => ({
    key: "k",
    pairs: clean + collides + indeterminate,
    clean,
    collides,
    indeterminate,
    rate: clean + collides ? collides / (clean + collides) : null,
  });

  assert.equal(overlapVerdict(tally(6, 0)), "waive-candidate");
  assert.equal(overlapVerdict(tally(4, 2)), "hot-spot");
  assert.equal(overlapVerdict(tally(3, 0)), "too-few");
  // Indeterminate pairs are not measured: 3 clean plus 4 indeterminate is still too few.
  assert.equal(overlapVerdict(tally(3, 0, 4)), "too-few");
  // Between the two thresholds (1 in 6, 17%) is neither.
  assert.equal(overlapVerdict(tally(5, 1)), "mixed");
});

test("end to end, overlap.mts loads the project's config, reads gh, and prints waive candidates and hot spots naming their waivedFiles entry and evidence", () => {
  // Six tickets in one campaign, each rewriting its own line of notes.md and the same line of hot.ts.
  const sections = (edit = 0) =>
    lines(...[1, 2, 3, 4, 5, 6].flatMap((n) => [n === edit ? `section ${n}, edited` : `section ${n}`, "-", "-"]));
  const p = scratchProject({
    "notes.md": sections(),
    "hot.ts": lines("export const owner = 0;", "", "export const other = 0;"),
    "CHANGELOG.md": "# log\n",
  });
  mkdirSync(join(p.dir, "vetinari"));
  writeFileSync(
    join(p.dir, "vetinari", "config.mts"),
    `export default { project: "demo", image: "img", baseBranch: "main", gates: [{ cmd: "true" }], fetchTask: (id) => id, waivedFiles: ["CHANGELOG.md"] };\n`,
  );
  p.git(["add", "-A"]);
  p.git(["commit", "-qm", "config"]);
  p.log(start("2026-01-01T00:00:00Z", [["1", "2", "3", "4", "5", "6"]]));
  for (const n of [1, 2, 3, 4, 5, 6])
    p.land(
      String(n),
      { "notes.md": sections(n), "hot.ts": lines(`export const owner = ${n};`, "", "export const other = 0;") },
      `2026-01-01T0${n}:00:00Z`,
      `main~${n - 1}`,
    );
  // A stub gh: every issue cites all three files, and none is blocked.
  const bin = mkdtempSync(join(tmpdir(), "overlap-replay-bin-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\ncase "$1" in\n  api) echo '[]' ;;\n  issue) echo '{"title":"t","body":"Touches: \`notes.md\`, \`hot.ts\`, \`CHANGELOG.md\`","comments":[]}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const out = execFileSync(
    join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"),
    [join(import.meta.dirname, "..", "skills", "review-logs", "overlap.mts"), p.dir],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );

  assert.match(out, /waive candidate.*≤ ?5%/is, "the thresholds head the report");
  assert.match(out, /Waive candidates[\s\S]*add `notes\.md` to `waivedFiles` — 15 pairs[^\n]*0% /);
  assert.match(out, /Hot spots[\s\S]*`hot\.ts` — leave it out of `waivedFiles`: 15 pairs[^\n]*100%/);
  // Neither ticket changed CHANGELOG.md, so it can't have collided, whatever else made a pair indeterminate.
  assert.match(out, /Already waived[\s\S]*`CHANGELOG\.md` \(already waived; waive candidate\) — 15 pairs: 15 clean/);
});

test("cites the project's own fileSet filters out are reported as unmeasurable, with how many tickets cited them", async () => {
  const p = conflictingPair(start("2026-01-01T00:00:00Z", [["1", "2"]]));
  const dflt = defaultFileSet(p.dir);
  // Like goal-tracker's coWaveSafe set: other.txt never reaches the planner.
  const coWaveSafe: FileSetOf = async (ticket) => {
    const { files, confident } = await dflt(ticket);
    return { files: files.filter((f) => f !== "other.txt"), confident };
  };

  const result = await replayOverlap({
    root: p.dir,
    fileSet: coWaveSafe,
    unfilteredFileSet: defaultFileSet(p.dir),
    tracker: tracker({ 1: ["k.txt", "other.txt"], 2: ["k.txt", "other.txt"] }),
  });

  assert.deepEqual(
    result.keys.map(({ key }) => key),
    ["k.txt"],
  );
  assert.deepEqual(result.filteredKeys, { "other.txt": 2 });
  assert.match(renderOverlapReport(result), /not measurable[^\n]*\n- `other\.txt` — cited by 2 tickets/i);
});
