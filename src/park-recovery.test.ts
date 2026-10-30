import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PARK_RECOVERY, recoverySentence } from "./park-recovery.ts";

test("PARK_RECOVERY holds exactly one move per park reason, conflict resolved on the base (#578)", () => {
  assert.deepEqual(PARK_RECOVERY, {
    question: "answer it",
    stalled: "read the turn log, then answer with guidance or `vetinari prune <id>`",
    conflict: "resolve the conflict on the base, then `vetinari redrive`",
    "red-base": "fix forward on the base, then `vetinari redrive`",
    crash: "`vetinari redrive`",
    stopped: "`vetinari redrive` to resume the campaign, or `vetinari run <id>` for a standalone run",
    "outdated-agent": "rebuild the image with `vetinari build`, then `vetinari redrive`",
  });
});

test("recoverySentence names the issue, capitalises the move and ends it with a period (#578)", () => {
  assert.equal(recoverySentence(PARK_RECOVERY.conflict, "7"), "Resolve the conflict on the base, then `vetinari redrive`.");
  // A leading backtick is left as is.
  assert.equal(
    recoverySentence(PARK_RECOVERY.stopped, "12"),
    "`vetinari redrive` to resume the campaign, or `vetinari run 12` for a standalone run.",
  );
});

test("the .toString() copy of recoverySentence shipped to the dashboard behaves as the import (#578)", () => {
  // The sheet inlines the function's source; evaluated alone it must need nothing from this module.
  const shipped = new Function(`return ${recoverySentence.toString()}`)() as typeof recoverySentence;
  for (const [move, issue] of [
    [PARK_RECOVERY.conflict, "7"],
    [PARK_RECOVERY.stopped, "12"],
    [PARK_RECOVERY.stalled, "3"],
    [PARK_RECOVERY.crash, "1"],
  ]) {
    assert.equal(shipped(move, issue), recoverySentence(move, issue));
  }
  assert.equal(
    shipped(PARK_RECOVERY.stopped, "12"),
    "`vetinari redrive` to resume the campaign, or `vetinari run 12` for a standalone run.",
  );
});

test("no recovery surface tells the human to resolve a conflict on the branch (#578)", () => {
  for (const file of ["report.ts", "modes.ts", "gateway.ts", "cli-dispatch.ts", "merge.ts", "dashboard-assets.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(!source.includes("on the branch then"), `${file} still says "on the branch then"`);
  }
});
