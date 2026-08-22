import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet } from "./fileset.ts";

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
