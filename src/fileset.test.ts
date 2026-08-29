import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet, ticketProse } from "./fileset.ts";

let counter = 0;
/** A throwaway tree with the given repo-relative files (each created empty). */
const treeWith = (...files: string[]): string => {
  const root = join(tmpdir(), `vetinari-fileset-${Date.now()}-${counter++}`);
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

  const res = fileSet(
    "Touches `src/plan.ts` and templates/repo/stack_strip.tmpl for the strip.",
  );

  assert.deepEqual(res.files.sort(), ["plan.ts", "stack_strip.tmpl"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet judges collisions by basename: the same file via different paths is one entry", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // Cited twice under two different paths — both normalize to the one basename.
  const res = fileSet(
    "Edits `src/plan.ts`, and also referenced as a/b/plan.ts elsewhere.",
  );

  assert.deepEqual(res.files, ["plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet is not confident when the ticket cites no path at all", () => {
  const root = treeWith("src/plan.ts");

  const res = defaultFileSet(root)(
    "Refactor the planner for clarity. No file mentioned.",
  );

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

test("ticketProse falls back to an anchored marker line found only in a comment", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // The body carries no marker line; the brief comment holds the real marker. The
  // planner must resolve it exactly as if the marker had lived in the body.
  const task = JSON.stringify({
    title: "Fix the resolver",
    body: "Reworks the resolver, per the brief below.",
    comments: [
      { body: "Agent brief.\n\nTouches (existing files): `fileset.ts`\n" },
    ],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse reads a comment's marker line but ignores a filename in the comment's prose", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // Body has no marker, so comments are consulted. The comment names `ghost.ts`
  // in passing prose and `fileset.ts` on a real marker line — only the latter counts.
  const task = JSON.stringify({
    title: "Fix",
    body: "Reworks the resolver.",
    comments: [
      {
        body: "See also `ghost.ts` in passing.\n\nTouches (existing files): `fileset.ts`\n",
      },
    ],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse lets a body marker win over a stale marker in a comment", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // The body's marker is authoritative; an old comment marker (naming an absent
  // `ghost.ts`) must not override it or drag confidence down.
  const task = JSON.stringify({
    title: "Fix",
    body: "Touches (existing files): `fileset.ts`",
    comments: [{ body: "Touches (existing files): `ghost.ts`\n" }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse unions marker lines across several comments when the body has none", () => {
  const root = treeWith("src/fileset.ts", "src/plan.ts");
  const fileSet = defaultFileSet(root);

  // Two comments each carry a Touches marker; with no body marker their cites union
  // (rather than the last one winning — comments have no "correction" ordering).
  const task = JSON.stringify({
    title: "Fix",
    body: "No marker here.",
    comments: [
      { body: "Touches (existing files): `fileset.ts`\n" },
      { body: "Touches (existing files): `plan.ts`\n" },
    ],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files.sort(), ["fileset.ts", "plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet recovers a slash-path cite fenced by backslash-escaped backticks (#249)", () => {
  const root = treeWith("src/dashboard-render.ts");

  // #249's shape: `\`src/dashboard-render.ts\`` — a slash path fenced by stray
  // backslashes. The escape is a delimiter artifact orthogonal to tree-presence, so
  // the resolver strips it and recovers the clean basename rather than halting.
  const res = defaultFileSet(root)(
    "Touches (existing files): \\`src/dashboard-render.ts\\`\n",
  );

  assert.deepEqual(res.files, ["dashboard-render.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet resolves an escaped-backtick marker identically to a plain one", () => {
  const root = treeWith("src/dashboard-render.ts");
  const fileSet = defaultFileSet(root);

  const escaped = fileSet("Touches (existing files): \\`src/dashboard-render.ts\\`\n");
  const plain = fileSet("Touches (existing files): `src/dashboard-render.ts`\n");

  assert.deepEqual(escaped, plain);
  assert.equal(escaped.confident, true);
});

test("defaultFileSet recovers a #201-shaped bare-filename cite fenced by escaped backticks", () => {
  const root = treeWith("src/fileset.ts");

  // #201's shape: `\`fileset.ts\`` — a bare name wrapped in stray backslashes. The
  // escape is stripped, so the bare name is recovered just like the slash path.
  const res = defaultFileSet(root)(
    "Touches (existing files): \\`fileset.ts\\`\n",
  );

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet counts an escaped-backtick Creates: cite for disjointness, tree-exempt (#249)", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // A Creates: cite names a not-yet-existing file, so it is absent from the tree —
  // escaped or not, it is recovered, counted, and exempt from the tree-presence check.
  const res = fileSet("Creates (new files): \\`src/new-thing.ts\\`\n");

  assert.deepEqual(res.files, ["new-thing.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse resolves an escaped-backtick body marker directly, no comment fallback needed (#249)", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // The body marker's backticks are escaped (#201/#249) but it names a real file, so
  // it is now resolvable on its own — the body marker wins and the comment is ignored.
  const task = JSON.stringify({
    title: "Fix",
    body: "Touches (existing files): \\`src/fileset.ts\\`",
    comments: [{ body: "Touches (existing files): `plan.ts`\n" }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["fileset.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse still falls back to a comment marker when the body's marker cites only prose", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // The body marker cites only a non-path word (`campaign`), which is not a cite even
  // after normalization, so it is not a marker the resolver would act on and must not
  // shadow the resolvable marker living in the comment.
  const task = JSON.stringify({
    title: "Fix",
    body: "Touches (existing files): the `campaign` planner",
    comments: [{ body: "Touches (existing files): `fileset.ts`\n" }],
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
  const root = treeWith("src/plan.ts", "src/prune.ts");
  const fileSet = defaultFileSet(root);

  // A first marker line, then a corrected one lower down — the correction wins.
  const res = fileSet("Files: `src/plan.ts`\nFiles: `src/prune.ts`\n");

  assert.deepEqual(res.files, ["prune.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet is not confident when the marker line cites nothing", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // A marker line is present but empty — that is a genuine "cites nothing", so the
  // halt path is preserved even though `src/plan.ts` is named off the marker line.
  const res = fileSet(
    "Reworks `src/plan.ts` for clarity.\n\nTouches (existing files):\n",
  );

  assert.deepEqual(res.files, []);
  assert.equal(res.confident, false);
});

test("defaultFileSet is confident about a ticket that only creates new files, absent from the tree", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // #108's shape: the ticket creates event-log.ts + its test, neither in the tree
  // yet. A `Creates:` cite is legitimately absent, so absence must not read as a typo.
  const res = fileSet(
    "Creates (new files): `event-log.ts`, `event-log.test.ts`\n",
  );

  assert.deepEqual(res.files.sort(), ["event-log.test.ts", "event-log.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet unions a Touches line (existing) with a Creates line (new)", () => {
  const root = treeWith("src/status.ts");
  const fileSet = defaultFileSet(root);

  const res = fileSet(
    "Touches: `status.ts`\nCreates (new files): `event-log.ts`\n",
  );

  assert.deepEqual(res.files.sort(), ["event-log.ts", "status.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet keeps Touches strictness even alongside a Creates line", () => {
  const root = treeWith("src/status.ts");
  const fileSet = defaultFileSet(root);

  // `ghost.ts` under Touches is absent from the tree — a stale existing-file note.
  // A valid Creates line must not launder that miss into confidence.
  const res = fileSet(
    "Touches: `status.ts`, `ghost.ts`\nCreates: `event-log.ts`\n",
  );

  assert.deepEqual(res.files.sort(), ["event-log.ts", "status.ts"]);
  assert.equal(res.confident, false);
});

test("defaultFileSet reads only the marker line's cites, ignoring incidental prose tokens", () => {
  const root = treeWith("src/fileset.ts", "src/cli.mts");
  const fileSet = defaultFileSet(root);

  // The prose names an env file and a config that are not source files; a
  // whole-body scan would flip confidence to false. The marker line pins it down.
  const res = fileSet(
    "The resolver reads `orchestrator.env` and a `.vetinari.local` mention in prose.\n" +
      "\n" +
      "Touches (existing files): `fileset.ts`, `cli.mts`\n",
  );

  assert.deepEqual(res.files.sort(), ["cli.mts", "fileset.ts"]);
  assert.equal(res.confident, true);
});
