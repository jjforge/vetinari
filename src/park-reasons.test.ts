import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PARK_REASON_FACTS, recoverySentence, type ParkReason } from "./park-reasons.ts";

// One row per reason, five facts each — the reason-by-question table every surface reads (#685).
// The moves are today's text, unchanged (#578); only `stopped` has a distinct campaign-level move.
test("PARK_REASON_FACTS answers every park reason's five facts, one row per reason (#685)", () => {
  const rows: Record<
    ParkReason,
    [answerable: boolean, asksNothing: boolean, writesParkedRecord: boolean, issueMove: string, campaignMove: string]
  > = {
    question: [true, false, true, "answer it", "answer it"],
    stalled: [
      true,
      false,
      true,
      "read the turn log, then answer with guidance or `vetinari prune <id>`",
      "read the turn log, then answer with guidance or `vetinari prune <id>`",
    ],
    conflict: [
      false,
      false,
      true,
      "resolve the conflict on the base, then `vetinari redrive`",
      "resolve the conflict on the base, then `vetinari redrive`",
    ],
    "red-base": [
      false,
      false,
      false,
      "fix forward on the base, then `vetinari redrive`",
      "fix forward on the base, then `vetinari redrive`",
    ],
    crash: [false, false, false, "`vetinari redrive`", "`vetinari redrive`"],
    stopped: [
      false,
      true,
      true,
      "`vetinari redrive` to resume the campaign, or `vetinari run <id>` for a standalone run",
      "`vetinari redrive` to resume it",
    ],
    "outdated-agent": [
      false,
      true,
      true,
      "update the agent CLI in the project's sandbox (`vetinari build` for the default Docker image), then `vetinari redrive`",
      "update the agent CLI in the project's sandbox (`vetinari build` for the default Docker image), then `vetinari redrive`",
    ],
  };
  const expected = Object.fromEntries(
    Object.entries(rows).map(([reason, [answerable, asksNothing, writesParkedRecord, issueMove, campaignMove]]) => [
      reason,
      { answerable, asksNothing, writesParkedRecord, issueMove, campaignMove },
    ]),
  );
  assert.deepEqual(PARK_REASON_FACTS, expected);
});

test("recoverySentence names the issue, capitalises the move and ends it with a period (#578)", () => {
  assert.equal(recoverySentence(PARK_REASON_FACTS.conflict.issueMove, "7"), "Resolve the conflict on the base, then `vetinari redrive`.");
  // A leading backtick is left as is.
  assert.equal(
    recoverySentence(PARK_REASON_FACTS.stopped.issueMove, "12"),
    "`vetinari redrive` to resume the campaign, or `vetinari run 12` for a standalone run.",
  );
});

test("the .toString() copy of recoverySentence shipped to the dashboard behaves as the import (#578)", () => {
  // The sheet inlines the function's source; evaluated alone it must need nothing from this module.
  const shipped = new Function(`return ${recoverySentence.toString()}`)() as typeof recoverySentence;
  for (const [move, issue] of [
    [PARK_REASON_FACTS.conflict.issueMove, "7"],
    [PARK_REASON_FACTS.stopped.issueMove, "12"],
    [PARK_REASON_FACTS.stalled.issueMove, "3"],
    [PARK_REASON_FACTS.crash.issueMove, "1"],
  ]) {
    assert.equal(shipped(move, issue), recoverySentence(move, issue));
  }
  assert.equal(
    shipped(PARK_REASON_FACTS.stopped.issueMove, "12"),
    "`vetinari redrive` to resume the campaign, or `vetinari run 12` for a standalone run.",
  );
});

test("no recovery surface tells the human to resolve a conflict on the branch (#578)", () => {
  for (const file of ["report.ts", "modes.ts", "gateway.ts", "cli-dispatch.ts", "merge.ts", "dashboard-assets.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(!source.includes("on the branch then"), `${file} still says "on the branch then"`);
  }
});
