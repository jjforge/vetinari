import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, setLogFile } from "./log.ts";

/**
 * Compile-time contract for `log()`'s producer overloads. These calls are never run — they exist
 * so `tsc` proves the seam: a narrowed kind must be emitted with its `event-log.ts` field shape,
 * while a peripheral kind stays one-line cheap through the untyped catch-all. `tsx --test` erases
 * types without checking them, so the real gate here is `tsc --noEmit` (the typecheck gate); a
 * `@ts-expect-error` that stops erroring would surface there as an unused directive.
 */
function _typeContract() {
  // A narrowed kind compiles with its full, correct field shape.
  log("carve", { target: "1", removed: ["2", "3"], dropped: ["3"] });
  log("green", { taskId: "42", branch: "agent/42", commits: ["abc"] });

  // Wrong/missing fields on a narrowed kind must fail to compile.
  // @ts-expect-error `carve` needs target/removed/dropped, not this.
  log("carve", { nope: true });
  // @ts-expect-error `green` is missing `commits`.
  log("green", { taskId: "42", branch: "agent/42" });

  // A peripheral kind stays cheap: any payload compiles via the untyped catch-all.
  log("telegram-send-failed", { error: "boom" });
  log("gate-result", { cmd: "x", exitCode: 1, seconds: 2, outFile: "y" });
}
void _typeContract;

test("log() appends the event as one JSON line carrying its data", () => {
  const file = join(mkdtempSync(join(tmpdir(), "log-")), "orchestrator.jsonl");
  setLogFile(file);
  log("carve", { target: "1", removed: ["2"], dropped: ["2"] });
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "carve");
  assert.deepEqual(rows[0].dropped, ["2"]);
  assert.equal(typeof rows[0].ts, "string");
});

test("log() kind is authoritative — a data.event key can't override it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "log-")), "orchestrator.jsonl");
  setLogFile(file);
  // enqueueOutbound passes `event: rec.event` (the outbound record's kind, e.g. "green")
  // as payload; the persisted line's kind must stay the true `log()` kind, not the payload's.
  log("outbound-enqueued", { id: "abc", category: "success", event: "green" });
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "outbound-enqueued");
});
