import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODES,
  renderUsage,
  renderModesReference,
  MODES_REFERENCE_BEGIN,
  MODES_REFERENCE_END,
} from "./help.ts";

/**
 * The generated modes block of `docs/reference.md` — the exhaustive CLI-mode list
 * the README/help drift test now points at (design §13.3; it used to guard the
 * README "## Modes" table). Read verbatim between the marker comments so the test
 * compares the same text on disk, not a re-encoding of it.
 */
function referenceModesBlock(): string {
  const md = readFileSync(join(process.cwd(), "docs/reference.md"), "utf8");
  const start = md.indexOf(MODES_REFERENCE_BEGIN);
  const end = md.indexOf(MODES_REFERENCE_END);
  assert.ok(
    start >= 0 && end > start,
    "docs/reference.md has no generated modes block (regenerate with `npm run gen-reference`)",
  );
  return md.slice(start, end + MODES_REFERENCE_END.length);
}

/** The first-column mode signatures of that generated block. */
function referenceModeSignatures(): string[] {
  const sigs: string[] = [];
  for (const line of referenceModesBlock().split("\n")) {
    if (!line.startsWith("| `")) continue; // data rows only
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (m) sigs.push(m[1]);
  }
  return sigs;
}

test("docs/reference.md's modes block is generated verbatim from MODES — regenerate, never hand-edit (#167)", () => {
  // The block on disk must byte-match the renderer, so an edit to a signature OR
  // a blurb is caught, not just an added/removed row.
  assert.equal(
    referenceModesBlock(),
    renderModesReference(),
    "docs/reference.md modes block is stale — run `npm run gen-reference`",
  );
});

test("docs/reference.md's modes table lists exactly the CLI's modes — neither can drift (#167)", () => {
  const reference = referenceModeSignatures();
  const cli = MODES.map((m) => m.signature);

  const referenceSet = new Set(reference);
  const cliSet = new Set(cli);
  const missingFromReference = cli.filter((s) => !referenceSet.has(s));
  const staleInReference = reference.filter((s) => !cliSet.has(s));

  // The failure message names exactly which mode drifted, so the gate tells the
  // implementer what to add or remove rather than just "they differ".
  assert.deepEqual(
    { missingFromReference, staleInReference },
    { missingFromReference: [], staleInReference: [] },
  );
});

test("the README stays under its 1,500-word ceiling — the pitch and first hour, not the reference (design §13.3)", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const words = readme.split(/\s+/).filter(Boolean).length;
  assert.ok(
    words <= 1500,
    `README.md is ${words} words (> 1,500) — move detail into docs/reference.md or the guides`,
  );
});

test("the README no longer carries a Modes table — the exhaustive list lives in docs/reference.md (design §13.3)", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  assert.ok(
    !/^##\s+Modes\s*$/m.test(readme),
    "README.md still has a `## Modes` section; the modes table belongs in docs/reference.md",
  );
});

test("neither the reference table nor the CLI mode list carries a duplicate signature", () => {
  const reference = referenceModeSignatures();
  const cli = MODES.map((m) => m.signature);
  assert.equal(new Set(reference).size, reference.length, "duplicate mode row in docs/reference.md");
  assert.equal(new Set(cli).size, cli.length, "duplicate mode in MODES");
});

test("the standalone `queue` command is no longer a public mode — only campaign's queue() engine remains (#186)", () => {
  // `queue()` stays as campaign's per-wave concurrency core, but `vetinari queue`
  // is gone: it must not appear in MODES, so --help and the README table drop it
  // and `vetinari queue …` falls through to the unknown-mode/usage handling.
  const queueModes = MODES.filter((m) => /^queue\b/.test(m.signature));
  assert.deepEqual(queueModes, [], "MODES still lists a `queue` command");
});

test("`redrive` is the documented verb; `campaign --resume` is no longer a listed mode (#293)", () => {
  const sigs = MODES.map((m) => m.signature);
  assert.ok(sigs.includes("redrive"), "MODES lists `redrive`");
  assert.ok(!sigs.includes("campaign --resume"), "`campaign --resume` is a one-release alias, not a documented mode");
});

test("the retired surfaces are gone from MODES — prune batch, fileset-check, demo (#293)", () => {
  const sigs = MODES.map((m) => m.signature);
  assert.ok(!sigs.includes("prune <issue> <batch…>"), "the prune batch form is retired");
  assert.ok(!sigs.some((s) => /^fileset-check\b/.test(s)), "fileset-check is retired as a mode");
  assert.ok(!sigs.some((s) => /^demo\b/.test(s)), "demo create/remove are `make` targets, not modes");
});

test("renderModesReference renders one table row per mode, MODES pipes escaped so the table survives", () => {
  const md = renderModesReference();
  for (const m of MODES)
    assert.ok(
      md.includes("`" + m.signature + "`"),
      `docs/reference.md modes section is missing "${m.signature}"`,
    );
  // Every generated row is `| \`sig\` | blurb |`: exactly three UNescaped pipes,
  // so a blurb pipe (`claude | pi | codex`) that leaked through unescaped would
  // split the cell and be caught here.
  for (const line of md.split("\n")) {
    if (!line.startsWith("| `")) continue; // only the data rows, not header/separator
    const unescaped = (line.match(/(?<!\\)\|/g) ?? []).length;
    assert.equal(unescaped, 3, `row has unescaped pipes: ${line}`);
  }
});

test("renderUsage shows every mode's signature — --help is produced from MODES, never hand-kept", () => {
  const usage = renderUsage();
  for (const m of MODES)
    assert.ok(
      usage.includes(m.signature),
      `--help is missing the "${m.signature}" mode`,
    );
});
