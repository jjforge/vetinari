import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGraftClosure, shellGraftClosure } from "./dashboard-graft.ts";

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

// The preview path (`GET /graft?preview`) shells the project's own `graft --dry-run`
// through `runChild` now (folded off the old duplicated spawn). Point `process.argv[1]`
// at a fixture CLI that prints a `graft-closure {json}` line to exercise the fold + parse.
const withFixtureCli = async <T>(script: string, fn: () => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-graft-preview-"));
  const entry = join(dir, "cli.cjs");
  writeFileSync(entry, script);
  const orig = process.argv[1];
  process.argv[1] = entry;
  try {
    return await fn();
  } finally {
    process.argv[1] = orig;
  }
};

test("shellGraftClosure parses the closure the project's own dry-run prints", async () => {
  const closure = { project: "demo", ids: ["301"], placement: [{ id: "301", wave: 2 }], remaining: [["101"], ["301"]], rejected: [] };
  const closure_json = JSON.stringify(closure);
  const result = await withFixtureCli(
    `process.stdout.write('graft #301 → #301 in wave 2\\ngraft-closure ' + ${JSON.stringify(closure_json)} + '\\n'); process.exit(0);`,
    () => shellGraftClosure("/tmp", ["301"]),
  );
  assert.deepEqual(result, closure);
});

test("shellGraftClosure returns null when the child exits non-zero", async () => {
  const result = await withFixtureCli(
    `process.stderr.write('no campaign running\\n'); process.exit(1);`,
    () => shellGraftClosure("/tmp", ["301"]),
  );
  assert.equal(result, null);
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
