import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggerForRun } from "./log.ts";

test("a Logger's kind is authoritative — a data.event key can't override it", () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "log-")), "orchestrator.jsonl");
  const logger = loggerForRun({ logFile });
  // enqueueOutbound passes `event: rec.event` (the outbound record's kind, e.g. "green")
  // as payload; the persisted line's kind must stay the true emit kind, not the payload's.
  logger.log("outbound-enqueued", { id: "abc", category: "success", event: "green" });
  const rows = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "outbound-enqueued");
});
