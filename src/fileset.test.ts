import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet, ticketProse } from "./fileset.ts";
import { packageScopedFileSet } from "../examples/package-scoped-fileset.mts";

let counter = 0;
/** A fresh, not-yet-created throwaway tree path. */
const freshRoot = (): string => join(tmpdir(), `vetinari-fileset-${Date.now()}-${counter++}`);
/** Create the given repo-relative files (each empty) under `root`. */
const populate = (root: string, ...files: string[]): void => {
  for (const rel of files) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  mkdirSync(root, { recursive: true });
};
/** A throwaway tree with the given repo-relative files (each created empty). */
const treeWith = (...files: string[]): string => {
  const root = freshRoot();
  populate(root, ...files);
  return root;
};

test("defaultFileSet resolves the body's cites to their real repo-relative paths against the tree", () => {
  const root = treeWith("src/plan.ts", "templates/repo/stack_strip.tmpl");
  const fileSet = defaultFileSet(root);

  const res = fileSet("Touches `src/plan.ts` and templates/repo/stack_strip.tmpl for the strip.");

  assert.deepEqual(res.files.sort(), ["src/plan.ts", "templates/repo/stack_strip.tmpl"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet resolves the same file cited via different paths to one entry", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // Cited twice under two different paths — both resolve to the one real path.
  const res = fileSet("Edits `src/plan.ts`, and also referenced as a/b/plan.ts elsewhere.");

  assert.deepEqual(res.files, ["src/plan.ts"]);
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

  assert.deepEqual(res.files, ["src/plan.ts"]); // only the resolved path survives
  assert.equal(res.confident, false); // ...but the miss forbids confidence
});

test("defaultFileSet snapshots the tree once: a mutation between two resolutions is not seen", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // First resolution populates the snapshot from the pre-mutation tree.
  const first = fileSet("Touches `src/plan.ts`.");
  assert.equal(first.confident, true);

  // A file appears mid-plan (a concurrent checkout, an editor temp file). The
  // resolver holds one snapshot per built resolver, so the second call must not
  // see it — proving one plan validates against one tree, not N.
  populate(root, "src/ghost.ts");
  const second = fileSet("Touches `src/ghost.ts`.");

  assert.deepEqual(second.files, []); // ghost.ts is off the pre-mutation snapshot
  assert.equal(second.confident, false);
});

test("defaultFileSet never walks the tree when the built resolver is never invoked (§356)", () => {
  // The single-issue path builds a resolver, then decides to resolve no file-sets
  // at all. A root that would throw if walked must not be read at construction.
  assert.doesNotThrow(() => defaultFileSet("/vetinari-nonexistent-root-that-would-throw-if-walked"));
});

test("defaultFileSet snapshots on first use, not at construction", () => {
  const root = freshRoot();
  // Built against a tree that does not exist yet...
  const fileSet = defaultFileSet(root);
  // ...populated only after construction, before the first call.
  populate(root, "src/plan.ts");

  const res = fileSet("Touches `src/plan.ts`.");

  assert.deepEqual(res.files, ["src/plan.ts"]); // first use snapshots the now-present file
  assert.equal(res.confident, true);
});

test("defaultFileSet resolves a cite to its full repo-relative path by suffix match", () => {
  const root = treeWith("a/b/c/foo.md", "a/c/foo.md");
  const fileSet = defaultFileSet(root);

  // Two distinct files share the basename foo.md. Each cite carries enough of its
  // path to name exactly one, so each resolves to that real path — not the shared
  // basename that used to conflate them.
  const one = fileSet("Touches: `a/b/c/foo.md`\n");
  const two = fileSet("Touches: `a/c/foo.md`\n");

  assert.deepEqual(one.files, ["a/b/c/foo.md"]);
  assert.equal(one.confident, true);
  assert.deepEqual(two.files, ["a/c/foo.md"]);
  assert.equal(two.confident, true);
});

test("defaultFileSet resolves a bare filename to its real path when the tree holds exactly one", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // The authoring promise: cite a file however you like. A bare `fileset.ts` and a
  // path `src/fileset.ts` both resolve to the one real path, so they still collide
  // (user story 6).
  const bare = fileSet("Touches: `fileset.ts`\n");
  const path = fileSet("Touches: `src/fileset.ts`\n");

  assert.deepEqual(bare.files, ["src/fileset.ts"]);
  assert.deepEqual(path.files, ["src/fileset.ts"]);
  assert.equal(bare.confident, true);
});

test("defaultFileSet keeps an ambiguous bare cite as a basename, still confident", () => {
  const root = treeWith("a/foo.md", "b/foo.md", "c/foo.md");
  const fileSet = defaultFileSet(root);

  // Three files named foo.md and only a bare `foo.md` to go on — genuinely
  // ambiguous. It must NOT flip the ticket to not-confident (halting a ticket that
  // plans fine today); it stays a bare basename that collides with any foo.md.
  const res = fileSet("Touches: `foo.md`\n");

  assert.deepEqual(res.files, ["foo.md"]);
  assert.equal(res.confident, true);
});

test("packageScopedFileSet maps two files in one directory to the same key, so same-package tickets serialize", async () => {
  // The goal-tracker case: two tickets touch different files in internal/web, a
  // single Go package. Widened to the directory, their keys collide, so the
  // planner puts them in separate waves rather than one wave that cannot compile.
  const root = treeWith("internal/web/checkins.templ", "internal/web/reports.templ", "internal/api/handler.go");
  const fileSet = packageScopedFileSet(root);

  const checkins = await fileSet("Touches: `internal/web/checkins.templ`\n");
  const reports = await fileSet("Touches: `internal/web/reports.templ`\n");
  const api = await fileSet("Touches: `internal/api/handler.go`\n");

  assert.deepEqual(checkins.files, ["internal/web"]);
  assert.deepEqual(reports.files, ["internal/web"]); // same dir -> same key
  assert.deepEqual(api.files, ["internal/api"]); // different dir -> different key
});

test("packageScopedFileSet keys a Creates:-only ticket under '.' (a bare basename has no tree path)", async () => {
  const root = treeWith("internal/web/checkins.templ");
  const fileSet = packageScopedFileSet(root);

  // A Creates: cite stays a bare basename (the resolver has no tree path for a file
  // that does not exist yet), whose dirname is ".". Conservative: it collides with
  // every other bare key and every root-level file, so it serializes more, never less.
  const res = await fileSet("Creates (new files): `reports.templ`\n");

  assert.deepEqual(res.files, ["."]);
  assert.equal(res.confident, true);
});

test("packageScopedFileSet passes confident through from the wrapped defaultFileSet unchanged", async () => {
  const root = treeWith("internal/web/checkins.templ");
  const fileSet = packageScopedFileSet(root);

  // A resolvable cite is confident; a cite absent from the tree forbids confidence —
  // widening the key to the directory must not alter either verdict.
  assert.equal((await fileSet("Touches: `internal/web/checkins.templ`\n")).confident, true);
  assert.equal((await fileSet("Touches: `internal/web/ghost.templ`\n")).confident, false);
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

  assert.deepEqual(res.files, ["src/fileset.ts"]);
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
    comments: [{ body: "Agent brief.\n\nTouches (existing files): `fileset.ts`\n" }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, ["src/fileset.ts"]);
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

  assert.deepEqual(res.files, ["src/fileset.ts"]);
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

  assert.deepEqual(res.files, ["src/fileset.ts"]);
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
    comments: [{ body: "Touches (existing files): `fileset.ts`\n" }, { body: "Touches (existing files): `plan.ts`\n" }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files.sort(), ["src/fileset.ts", "src/plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet recovers a slash-path cite fenced by backslash-escaped backticks (#249)", () => {
  const root = treeWith("src/dashboard-render.ts");

  // #249's shape: `\`src/dashboard-render.ts\`` — a slash path fenced by stray
  // backslashes. The escape is a delimiter artifact orthogonal to tree-presence, so
  // the resolver strips it and recovers the clean path rather than halting.
  const res = defaultFileSet(root)("Touches (existing files): \\`src/dashboard-render.ts\\`\n");

  assert.deepEqual(res.files, ["src/dashboard-render.ts"]);
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
  const res = defaultFileSet(root)("Touches (existing files): \\`fileset.ts\\`\n");

  assert.deepEqual(res.files, ["src/fileset.ts"]);
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

  assert.deepEqual(res.files, ["src/fileset.ts"]);
  assert.equal(res.confident, true);
});

test("ticketProse lets a body marker citing only a non-file word shadow a comment marker (#477)", () => {
  const root = treeWith("src/fileset.ts");
  const fileSet = defaultFileSet(root);

  // Every backticked token on a marker line is a cite, so the body's `campaign` is a
  // real marker: the author's explicit declaration wins over the comment, and since it
  // cites a non-file the planner must halt rather than quietly take the comment's.
  const task = JSON.stringify({
    title: "Fix",
    body: "Touches (existing files): the `campaign` planner",
    comments: [{ body: "Touches (existing files): `fileset.ts`\n" }],
  });

  const res = fileSet(ticketProse(task));

  assert.deepEqual(res.files, []);
  assert.equal(res.confident, false);
});

test("defaultFileSet strips a trailing :line off a cite before resolving it (#388)", () => {
  const root = treeWith("src/host-slots.ts");

  // The most natural way to point at a line — `path:line` — must resolve to the
  // real file, not the unmatchable `host-slots.ts:329` basename.
  const res = defaultFileSet(root)("Fix `src/host-slots.ts:329` please.");

  assert.deepEqual(res.files, ["src/host-slots.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet strips a trailing :line:col off a cite (#388)", () => {
  const root = treeWith("src/host-slots.ts");

  const res = defaultFileSet(root)("See `src/host-slots.ts:329:12`.");

  assert.deepEqual(res.files, ["src/host-slots.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet strips a :line suffix carried on a marker-line cite (#388)", () => {
  const root = treeWith("src/host-slots.ts");

  // The convention-following case: the author wrote the marker line docs ask for,
  // but pointed at a line. The suffix must not fail tree validation.
  const res = defaultFileSet(root)("Touches: `src/host-slots.ts:329`\n");

  assert.deepEqual(res.files, ["src/host-slots.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet still halts on a genuinely absent file even with a :line suffix (#388)", () => {
  const root = treeWith("src/host-slots.ts");

  // Stripping the suffix must not launder a stale cite into a confident one:
  // `ghost.ts` is absent from the tree, suffix or not.
  const res = defaultFileSet(root)("Fix `src/ghost.ts:329` please.");

  assert.deepEqual(res.files, []);
  assert.equal(res.confident, false);
});

test("defaultFileSet still ignores a :line prose cite beside a clean marker line (#388)", () => {
  const root = treeWith("src/host-slots.ts", "src/modes.ts");
  const fileSet = defaultFileSet(root);

  // The marker line wins outright; the prose cite (even now that its suffix would
  // strip cleanly) stays ignored because a marker line is present.
  const res = fileSet("prose cites `src/modes.ts:335`\n\nTouches: `src/host-slots.ts`\n");

  assert.deepEqual(res.files, ["src/host-slots.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet anchors the marker at a line start — an inline prose mention is not the marker", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // The prose mentions the phrase mid-sentence (with an empty-looking inline
  // `Touches:`); the real marker line at line start is what must be read.
  const res = fileSet(
    "The reader must anchor on an actual `Touches:` marker line, not a mention.\n" + "\n" + "Touches (existing files): `src/plan.ts`\n",
  );

  assert.deepEqual(res.files, ["src/plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet lets the last marker line win when several qualify", () => {
  const root = treeWith("src/plan.ts", "src/prune.ts");
  const fileSet = defaultFileSet(root);

  // A first marker line, then a corrected one lower down — the correction wins.
  const res = fileSet("Files: `src/plan.ts`\nFiles: `src/prune.ts`\n");

  assert.deepEqual(res.files, ["src/prune.ts"]);
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

test("defaultFileSet is confident about a ticket that only creates new files, absent from the tree", () => {
  const root = treeWith("src/plan.ts");
  const fileSet = defaultFileSet(root);

  // #108's shape: the ticket creates event-log.ts + its test, neither in the tree
  // yet. A `Creates:` cite is legitimately absent, so absence must not read as a typo.
  const res = fileSet("Creates (new files): `event-log.ts`, `event-log.test.ts`\n");

  assert.deepEqual(res.files.sort(), ["event-log.test.ts", "event-log.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet unions a Touches line (existing) with a Creates line (new)", () => {
  const root = treeWith("src/status.ts");
  const fileSet = defaultFileSet(root);

  const res = fileSet("Touches: `status.ts`\nCreates (new files): `event-log.ts`\n");

  assert.deepEqual(res.files.sort(), ["event-log.ts", "src/status.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet keeps Touches strictness even alongside a Creates line", () => {
  const root = treeWith("src/status.ts");
  const fileSet = defaultFileSet(root);

  // `ghost.ts` under Touches is absent from the tree — a stale existing-file note.
  // A valid Creates line must not launder that miss into confidence.
  const res = fileSet("Touches: `status.ts`, `ghost.ts`\nCreates: `event-log.ts`\n");

  assert.deepEqual(res.files.sort(), ["event-log.ts", "src/status.ts"]);
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

  assert.deepEqual(res.files.sort(), ["src/cli.mts", "src/fileset.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet resolves extensionless and dotfile marker cites against the tree (#477)", () => {
  const root = treeWith("Makefile", ".gitignore", "CLAUDE.md");

  // A marker line already says "these are files", so `Makefile` (no dot) and
  // `.gitignore` (nothing before its dot) are cites, not prose to skip.
  const res = defaultFileSet(root)("Touches (existing files): `Makefile`, `.gitignore`, `CLAUDE.md`\n");

  assert.deepEqual(res.files.sort(), [".gitignore", "CLAUDE.md", "Makefile"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet is not confident when an extensionless marker cite is absent from the tree (#477)", () => {
  const root = treeWith("CLAUDE.md");
  const fileSet = defaultFileSet(root);

  // Beside a resolvable cite, the absent `Nosuchfile` must still forbid confidence.
  const mixed = fileSet("Touches: `Nosuchfile`, `CLAUDE.md`\n");
  assert.deepEqual(mixed.files, ["CLAUDE.md"]);
  assert.equal(mixed.confident, false);

  const alone = fileSet("Touches: `Nosuchfile`\n");
  assert.deepEqual(alone.files, []);
  assert.equal(alone.confident, false);
});

test("defaultFileSet's whole-body fallback still ignores a backticked prose word (#477)", () => {
  const root = treeWith("src/plan.ts");

  // No marker line, so the path-shape filter stays: `campaign` is prose, not a file.
  const res = defaultFileSet(root)("Reworks the `campaign` planner in `src/plan.ts`.");

  assert.deepEqual(res.files, ["src/plan.ts"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet counts an extensionless Creates: cite, tree-exempt (#477)", () => {
  const root = treeWith("src/plan.ts");

  const res = defaultFileSet(root)("Creates (new files): `Dockerfile`\n");

  assert.deepEqual(res.files, ["Dockerfile"]);
  assert.equal(res.confident, true);
});

test("ticketProse + defaultFileSet resolve an extensionless cite on a comment marker line (#477)", () => {
  const root = treeWith("Makefile", "src/plan.ts");

  const task = JSON.stringify({
    title: "Fix the build",
    body: "The build target is wrong.",
    comments: [{ body: "Touches: `Makefile`\n" }],
  });

  const res = defaultFileSet(root)(ticketProse(task));

  assert.deepEqual(res.files, ["Makefile"]);
  assert.equal(res.confident, true);
});

test("defaultFileSet recovers an extensionless marker cite fenced by escaped backticks (#477)", () => {
  const root = treeWith("Makefile");

  const res = defaultFileSet(root)("Touches (existing files): \\`Makefile\\`\n");

  assert.deepEqual(res.files, ["Makefile"]);
  assert.equal(res.confident, true);
});
