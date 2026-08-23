import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet, ticketProse } from "./fileset.ts";

let counter = 0;
/** A throwaway tree with the given repo-relative files (each created empty). */
const treeWith = (...files: string[]): string => {
  const root = join(tmpdir(), `sctdd-fileset-${Date.now()}-${counter++}`);
  for (const rel of files) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  mkdirSync(root, { recursive: true });
  return root;
};

test("defaultFileSet cites the body's paths, normalized to basename and validated against the tree", () => {
  const root = treeWith("src/plan.ts", "templates/repo/stack_strip.tmpl");
  const fileSet = defaultFileSet(root);

  const res = fileSet("Touches `src/plan.ts` and templates/repo/stack_strip.tmpl for the strip.");

  assert.deepEqual(res.files.sort(), ["plan.ts", "stack_strip.tmpl"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet judges collisions by basename: the same file via different paths is one entry", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // Cited twice under two different paths — both normalize to the one basename.
  const res = fileSet("Edits `src/plan.ts`, and also referenced as a/b/plan.ts elsewhere.");

  assert.deepEqual(res.files, ["plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet is not confident when the ticket cites no path at all", () => {
  const root = treeWith("src/plan.ts");

  const res = defaultFileSet(root)("Refactor the planner for clarity. No file mentioned.");

  assert.deepEqual(res.files, []);
  assert.equal(res.confident, false);
});

test("defaultFileSet is not confident when a cited path is not in the tree", () => {
  const root = treeWith("src/plan.ts");

  // `src/plan.ts` exists, but `src/ghost.ts` does not — a stale or wrong note.
  const res = defaultFileSet(root)("Touches `src/plan.ts` and `src/ghost.ts`.");

  assert.deepEqual(res.files, ["plan.ts"]); // only the validated basename survives
  assert.equal(res.confident, false); // ...but the miss forbids confidence
});

test("ticketProse keeps a GitHub task's title and body but drops its comments", () => {
  const task = JSON.stringify({
    title: "Fix the resolver",
    body: "Touches (existing files): `fileset.ts`",
    comments: [{ body: "A stray `orchestrator.env` mention in triage." }],
    labels: [{ name: "P2" }],
  });

  const prose = ticketProse(task);

  assert.ok(prose.includes("fileset.ts"), "keeps the body's cites");
  assert.ok(prose.includes("Fix the resolver"), "keeps the title");
  assert.ok(!prose.includes("orchestrator.env"), "drops comment tokens");
});

test("ticketProse passes a plain-string task through unchanged", () => {
  assert.equal(ticketProse("Touches `plan.ts`."), "Touches `plan.ts`.");
});

test("defaultFileSet over a task's prose ignores a filename token that lived only in a comment", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // No marker line, so the fallback whole-body scan runs — but a comment's stray
  // `ghost.ts` (absent from the tree) must not reach it and forbid confidence.
  const task = JSON.stringify({
    title: "Fix",
    body: "Reworks `fileset.ts` end to end.",
    comments: [{ body: "See also `ghost.ts` — unrelated." }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet anchors the marker at a line start — an inline prose mention is not the marker", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // The prose mentions the phrase mid-sentence (with an empty-looking inline
  // `Touches:`); the real marker line at line start is what must be read.
  const res = fileSet(
    "The reader must anchor on an actual `Touches:` marker line, not a mention.\n" +
      "\n" +
      "Touches (existing files): `src/plan.ts`\n",
  );

  assert.deepEqual(res.files, ["plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet lets the last marker line win when several qualify", () => {
  const root = treeWith("src/plan.ts", "src/carve.ts");
  const fileSet = defaultFileSet(root);

  // A first marker line, then a corrected one lower down — the correction wins.
  const res = fileSet("Files: `src/plan.ts`\nFiles: `src/carve.ts`\n");

  assert.deepEqual(res.files, ["carve.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet is not confident when the marker line cites nothing", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // A marker line is present but empty — that is a genuine "cites nothing", so the
  // halt path is preserved even though `src/plan.ts` is named off the marker line.
  const res = fileSet("Reworks `src/plan.ts` for clarity.\n\nTouches (existing files):\n");

  assert.deepEqual(res.files, []);
  assert.equal(res.confident, false);
});

test("defaultFileSet reads only the marker line's cites, ignoring incidental prose tokens", () => {
  const root = treeWith("src/fileset.ts", "src/cli.mts");
  const fileSet = defaultFileSet(root);

  // The prose names an env file and a config that are not source files; a
  // whole-body scan would flip confidence to false. The marker line pins it down.
  const res = fileSet(
    "The resolver reads `orchestrator.env` and a `.sandcastle.local` mention in prose.\n" +
      "\n" +
      "Touches (existing files): `fileset.ts`, `cli.mts`\n",
  );

  assert.deepEqual(res.files.sort(), ["cli.mts", "fileset.ts"]);
  assert.equal(res.confident, true);
});
