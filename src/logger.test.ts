import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostLogger, hostLogTarget, loggerForRun, memoryLogger, readHostLog, readHostLogLines, renderHostEvent, type Logger } from "./log.ts";
import { readEventLog, type BaseEvent } from "./event-log.ts";
import { loadConfig } from "./config.ts";

/**
 * Compile-time contract: an injected `Logger` carries the same narrowed-kind typed overload the
 * free `log()` has. These calls never run — `tsc --noEmit` is the real gate (tsx erases types).
 */
function _typeContract(l: Logger) {
  l.log("prune", { target: "1", removed: ["2"], dropped: ["2"] });
  // @ts-expect-error `green` is missing `commits`.
  l.log("green", { taskId: "42", branch: "agent/42" });
  // A peripheral kind stays cheap via the untyped catch-all.
  l.log("sandbox", { taskId: "42", branch: "agent/42", mounts: [] });
}
void _typeContract;

const scratchFile = () => join(mkdtempSync(join(tmpdir(), "logger-")), "orchestrator.jsonl");

test("loggerForRun writes a JSONL line readEventLog parses back (round-trip)", () => {
  const logFile = scratchFile();
  const logger = loggerForRun({ logFile });

  logger.log("prune", { target: "1", removed: ["2", "3"], dropped: ["3"] });

  const events = readEventLog({ logFile });
  assert.equal(events.length, 1);
  const [row] = events;
  assert.equal(row.event, "prune");
  assert.deepEqual(row, { ts: row.ts, event: "prune", target: "1", removed: ["2", "3"], dropped: ["3"] });
  assert.equal(typeof row.ts, "string");
});

test("memoryLogger captures typed events, writing nothing to disk and echoing nothing to console", () => {
  const before = console.log;
  const echoed: unknown[] = [];
  console.log = (...args: unknown[]) => void echoed.push(args);
  try {
    const logger = memoryLogger();
    logger.log("green", { taskId: "42", branch: "agent/42", commits: ["abc"] });
    logger.log("parked", { taskId: "7", reason: "stalled" });

    assert.equal(logger.events.length, 2);
    assert.equal(logger.events[0].event, "green");
    assert.deepEqual(logger.events[1], { ts: logger.events[1].ts, event: "parked", taskId: "7", reason: "stalled" });
  } finally {
    console.log = before;
  }
  assert.deepEqual(echoed, [], "memoryLogger must not echo to console");
});

test("hostLogTarget is a persistent host log under the gateway config dir, not a temp fallback", () => {
  const gwDir = mkdtempSync(join(tmpdir(), "gw-home-"));
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = gwDir;
  try {
    const target = hostLogTarget();
    // Persistent, mirroring a project's logs/orchestrator.jsonl: <gatewayConfigDir>/logs/host.jsonl.
    assert.equal(target, join(gwDir, "logs", "host.jsonl"), `host target must live under the gateway config dir, got ${target}`);
    assert.ok(!target.includes("unset"), `host target must be a named binding, not the unset default, got ${target}`);
    assert.ok(!target.includes(".vetinari.local"), `host target must not be a real project log, got ${target}`);

    const logger = hostLogger();
    logger.log("prune", { target: "1", removed: [], dropped: [] });
    assert.ok(existsSync(target), "hostLogger must write to its host target");
    const events = readEventLog({ logFile: target });
    assert.ok(events.some((e) => e.event === "prune"));
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
  }
});

test("renderHostEvent renders a stamped row as one line: timestamp, event, then the salient fields as JSON", () => {
  const withData: BaseEvent & Record<string, unknown> = {
    ts: "2026-08-27T14:20:35Z",
    event: "tg-send",
    ok: true,
    project: "foo",
  };
  assert.equal(renderHostEvent(withData), '2026-08-27T14:20:35Z tg-send {"ok":true,"project":"foo"}');
  // A row with nothing beyond ts/event renders those two alone — no trailing "{}".
  assert.equal(
    renderHostEvent({ ts: "2026-08-27T14:20:35Z", event: "gateway-start" }),
    "2026-08-27T14:20:35Z gateway-start",
  );
});

test("readHostLog returns the host log newest-first, bounded to the most recent window; a missing file reads empty", () => {
  const gwDir = mkdtempSync(join(tmpdir(), "gw-home-"));
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = gwDir;
  try {
    // No host.jsonl yet — the daemon never ran.
    assert.deepEqual(readHostLog(), [], "a missing host log reads empty");

    const logger = hostLogger();
    for (let i = 0; i < 5; i++) logger.log("tick", { i });

    // Newest-first: the last-written row leads.
    const all = readHostLog();
    assert.deepEqual(all.map((e) => (e as unknown as { i: number }).i), [4, 3, 2, 1, 0]);

    // Bounded to the most recent `limit` — still newest-first.
    const recent = readHostLog(2);
    assert.deepEqual(recent.map((e) => (e as unknown as { i: number }).i), [4, 3]);
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
  }
});

test("readHostLogLines returns the raw JSONL lines untouched, in file order, bounded to the most recent window", () => {
  const gwDir = mkdtempSync(join(tmpdir(), "gw-home-"));
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = gwDir;
  try {
    // A missing host log yields no lines — the --json surface stays silent, not an error.
    assert.deepEqual(readHostLogLines(), [], "a missing host log reads empty");

    const logger = hostLogger();
    for (let i = 0; i < 4; i++) logger.log("tick", { i });

    // Untouched: each line is verbatim what's on disk, and in on-disk (oldest-first) order —
    // JSON.parse round-trips to the same object the reader would return.
    const lines = readHostLogLines();
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.map((l) => JSON.parse(l).i), [0, 1, 2, 3]);
    // The raw file's exact lines, so `--json` is byte-faithful for jq/grep.
    const onDisk = readFileSync(hostLogTarget(), "utf8").split("\n").filter(Boolean);
    assert.deepEqual(lines, onDisk);

    // Bounded to the last `limit`, still in file order.
    assert.deepEqual(readHostLogLines(2).map((l) => JSON.parse(l).i), [2, 3]);
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
  }
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
