import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostLogger, hostLogTarget, loggerForRun, memoryLogger, type Logger } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { loadConfig } from "./config.ts";

/**
 * Compile-time contract: an injected `Logger` carries the same narrowed-kind typed overload the
 * free `log()` has. These calls never run — `tsc --noEmit` is the real gate (tsx erases types).
 */
function _typeContract(l: Logger) {
  l.log("carve", { target: "1", removed: ["2"], dropped: ["2"] });
  // @ts-expect-error `green` is missing `commits`.
  l.log("green", { taskId: "42", branch: "agent/42" });
  // A peripheral kind stays cheap via the untyped catch-all.
  l.log("gate-result", { cmd: "x", exitCode: 1 });
}
void _typeContract;

const scratchFile = () => join(mkdtempSync(join(tmpdir(), "logger-")), "orchestrator.jsonl");

test("loggerForRun writes a JSONL line readEventLog parses back (round-trip)", () => {
  const logFile = scratchFile();
  const logger = loggerForRun({ logFile });

  logger.log("carve", { target: "1", removed: ["2", "3"], dropped: ["3"] });

  const events = readEventLog({ logFile });
  assert.equal(events.length, 1);
  const [row] = events;
  assert.equal(row.event, "carve");
  assert.deepEqual(row, { ts: row.ts, event: "carve", target: "1", removed: ["2", "3"], dropped: ["3"] });
  assert.equal(typeof row.ts, "string");
});

test("memoryLogger captures typed events, writing nothing to disk and echoing nothing to console", () => {
  const before = console.log;
  const echoed: unknown[] = [];
  console.log = (...args: unknown[]) => void echoed.push(args);
  try {
    const logger = memoryLogger();
    logger.log("green", { taskId: "42", branch: "agent/42", commits: ["abc"] });
    logger.log("parked", { taskId: "7", reason: "budget" });

    assert.equal(logger.events.length, 2);
    assert.equal(logger.events[0].event, "green");
    assert.deepEqual(logger.events[1], { ts: logger.events[1].ts, event: "parked", taskId: "7", reason: "budget" });
  } finally {
    console.log = before;
  }
  assert.deepEqual(echoed, [], "memoryLogger must not echo to console");
});

test("hostLogger targets hostLogTarget() — an explicit named host path, not the unset default", () => {
  const target = hostLogTarget();
  assert.ok(target.startsWith(tmpdir()), `host target must be under tmpdir, got ${target}`);
  assert.ok(!target.includes("unset"), `host target must be a named binding, not the unset default, got ${target}`);
  assert.ok(!target.includes(".vetinari.local"), `host target must not be a real project log, got ${target}`);

  const logger = hostLogger();
  logger.log("carve", { target: "1", removed: [], dropped: [] });
  assert.ok(existsSync(target), "hostLogger must write to its host target");
  const events = readEventLog({ logFile: target });
  assert.ok(events.some((e) => e.event === "carve"));
});

const configBody = (stateDir: string) => `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
  stateDir: ${JSON.stringify(stateDir)},
};
`;

test("loadConfig binds cfg.log to a Logger writing at cfg.logFile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-cfg-"));
  // stateDir under a temp dir so cfg.logFile lands there, not in a real project's log.
  const stateDir = join(dir, "state");
  const cfgPath = join(dir, "vetinari/config.mts");
  mkdirSync(join(cfgPath, ".."), { recursive: true });
  writeFileSync(cfgPath, configBody(stateDir));

  const cfg = await loadConfig(cfgPath);

  assert.equal(typeof cfg.log.log, "function");
  assert.equal(cfg.logFile, join(stateDir, "logs/orchestrator.jsonl"));
  // The bound logger writes at cfg.logFile.
  cfg.log.log("green", { taskId: "1", branch: "agent/1", commits: ["a"] });
  assert.ok(readEventLog({ logFile: cfg.logFile }).some((e) => e.event === "green"));
});
