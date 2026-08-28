import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGraftClosure } from "./dashboard-graft.ts";

test("parseGraftClosure reads the structured closure line the dry-run prints", () => {
  // `graft <ids…> --dry-run` prints a `graft-closure {json}` line alongside its
  // prose — the requested ids, where each lands, the resulting waves, and any
  // rejection — so the panel names each without re-parsing the prose.
  const structured = {
    ids: ["301", "302"],
    placement: [
      { id: "301", wave: 2 },
      { id: "302", wave: 3 },
    ],
    remaining: [["101"], ["301"], ["302"]],
    rejected: [],
  };
  assert.deepEqual(
    parseGraftClosure(
      `graft #301, #302 → #301 in wave 2, #302 in wave 3\nresulting campaign: "101" "301" "302"\ngraft-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
});

test("parseGraftClosure carries a whole-batch rejection's offenders", () => {
  const structured = {
    ids: ["202", "303"],
    placement: [],
    remaining: [["101"], ["202"]],
    rejected: [{ id: "202", reason: "already-in-campaign" }],
  };
  assert.deepEqual(
    parseGraftClosure(
      `graft rejected — nothing added (already in the campaign: #202).\ngraft-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
});

test("parseGraftClosure returns null when the line is absent or unparseable", () => {
  // No structured line (an install predating this closure) → null, so the route can
  // 502 rather than half-render a closure it cannot vouch for.
  assert.equal(
    parseGraftClosure(`graft #301 → #301 in wave 2\nresulting campaign: "101" "301"`),
    null,
  );
  // Present but malformed JSON → null too.
  assert.equal(parseGraftClosure("graft-closure {not json"), null);
});
