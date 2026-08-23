import test from "node:test";
import assert from "node:assert/strict";
import { extractTurnSummary } from "./loop.ts";

test("extractTurnSummary pulls the one-line summary the agent authored this turn", () => {
  const stdout = `working on the slice...\n<turn-summary>Added a failing test for the summary extractor and made it green.</turn-summary>\n<promise>COMPLETE</promise>`;
  assert.equal(extractTurnSummary(stdout), "Added a failing test for the summary extractor and made it green.");
});

test("extractTurnSummary trims surrounding whitespace", () => {
  const stdout = `<turn-summary>\n  Parked: the seam is genuinely ambiguous.\n</turn-summary>`;
  assert.equal(extractTurnSummary(stdout), "Parked: the seam is genuinely ambiguous.");
});

test("extractTurnSummary returns undefined for output predating the contract", () => {
  // Logs written before the summary contract simply carry no tag; the turn
  // event must reconstruct with no summary rather than inventing one.
  assert.equal(extractTurnSummary("no tags here\n<promise>COMPLETE</promise>"), undefined);
});

test("extractTurnSummary does not mistake the <summary> nested in a <question> for the turn summary", () => {
  // A blocked turn's stdout carries a <summary> inside <question>. That is the
  // question's headline, not the turn's account — the turn summary is its own tag.
  const stdout = `<turn-summary>Parked to ask which base branch the carve should target.</turn-summary>
<question>
  <summary>Which base branch?</summary>
  <detail>The task names two.</detail>
</question>
<promise>BLOCKED</promise>`;
  assert.equal(extractTurnSummary(stdout), "Parked to ask which base branch the carve should target.");
});
