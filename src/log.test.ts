import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loggerForRun } from "./log.ts";

/** Capture whatever a body writes through `console.log`, restoring it afterwards. */
const captureConsole = (fn: () => void): string[] => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
};

test("a run logger echoes NO JSON to stdout by default — the screen is human-readable, the log file is JSONL (#299)", () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "log-")), "orchestrator.jsonl");
  const logger = loggerForRun({ logFile });
  const prev = process.env.VETINARI_JSON;
  delete process.env.VETINARI_JSON;
  const out = captureConsole(() => logger.log("green", { taskId: "101", branch: "agent/101", commits: [] }));
  if (prev !== undefined) process.env.VETINARI_JSON = prev;
  assert.deepEqual(out, [], "default run output must not echo events to stdout");
  // …but the event is still persisted to the log file.
  assert.equal(readFileSync(logFile, "utf8").split("\n").filter(Boolean).length, 1);
});

test("under VETINARI_JSON the run logger streams the raw event line to stdout for tooling (#299)", () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "log-")), "orchestrator.jsonl");
  const logger = loggerForRun({ logFile });
  const prev = process.env.VETINARI_JSON;
  process.env.VETINARI_JSON = "1";
  const out = captureConsole(() => logger.log("green", { taskId: "101", branch: "agent/101", commits: [] }));
  if (prev === undefined) delete process.env.VETINARI_JSON;
  else process.env.VETINARI_JSON = prev;
  assert.equal(out.length, 1);
  const echoed = JSON.parse(out[0]);
  assert.equal(echoed.event, "green");
  assert.equal(echoed.taskId, "101");
  // The stdout line is byte-identical to the persisted JSONL line.
  assert.equal(out[0], readFileSync(logFile, "utf8").split("\n").filter(Boolean)[0]);
});

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
