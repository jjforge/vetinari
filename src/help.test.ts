import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODES, renderUsage } from "./help.ts";

/**
 * The first-column mode signatures of the README "## Modes" table — the command
 * reference an agent actually reads in its worktree (ADR 0003). Parsed from the
 * markdown so the test compares the same text a human reads, not a re-encoding of
 * it. Scoped to the one table under `## Modes`, stopping at the next section.
 */
function readmeModeSignatures(): string[] {
  const md = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Modes\s*$/.test(l));
  assert.ok(start >= 0, "README has no `## Modes` section");
  const sigs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // the next section ends the Modes table
    if (!line.startsWith("|")) continue;
    const first = line.split("|")[1].trim(); // cell between the 1st and 2nd pipe
    if (first === "Mode" || /^-+$/.test(first)) continue; // header / separator row
    const m = first.match(/^`([^`]+)`/);
    if (m) sigs.push(m[1]);
  }
  return sigs;
}

test("the README Modes table lists exactly the CLI's modes — neither can drift (#167)", () => {
  const readme = readmeModeSignatures();
  const cli = MODES.map((m) => m.signature);

  const readmeSet = new Set(readme);
  const cliSet = new Set(cli);
  const missingFromReadme = cli.filter((s) => !readmeSet.has(s));
  const staleInReadme = readme.filter((s) => !cliSet.has(s));

  // The failure message names exactly which mode drifted, so the gate tells the
  // implementer what to add or remove rather than just "they differ".
  assert.deepEqual(
    { missingFromReadme, staleInReadme },
    { missingFromReadme: [], staleInReadme: [] },
  );
});

test("neither the README table nor the CLI mode list carries a duplicate signature", () => {
  const readme = readmeModeSignatures();
  const cli = MODES.map((m) => m.signature);
  assert.equal(new Set(readme).size, readme.length, "duplicate mode row in README");
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

test("renderUsage shows every mode's signature — --help is produced from MODES, never hand-kept", () => {
  const usage = renderUsage();
  for (const m of MODES)
    assert.ok(
      usage.includes(m.signature),
      `--help is missing the "${m.signature}" mode`,
    );
});
