import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { archiveRun } from "./archive.ts";

let counter = 0;
const cfgFor = (): ResolvedConfig => {
  const dir = join(tmpdir(), `sctdd-archive-${Date.now()}-${counter++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  return { project: "demo", stateDir: dir, logFile: join(dir, "logs", "orchestrator.jsonl"), parkedDir: join(dir, "parked") } as ResolvedConfig;
};

test("archiveRun moves the log aside, resets it, and clears parked records", () => {
  const cfg = cfgFor();
  writeFileSync(cfg.logFile, '{"event":"campaign-start","batches":[["101"]]}\n{"event":"green","taskId":"101"}\n');
  writeFileSync(join(cfg.parkedDir, "202.json"), JSON.stringify({ taskId: "202", reason: "blocked", branch: "agent/202", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  // Live log is reset to empty, so the dashboard/statusline read as idle.
  assert.equal(readFileSync(cfg.logFile, "utf8"), "");
  // The old content is preserved in a timestamped archive.
  assert.ok(result.archivedLog && existsSync(result.archivedLog));
  assert.match(readFileSync(result.archivedLog!, "utf8"), /campaign-start/);
  // Parked records are cleared.
  assert.equal(result.clearedParked, 1);
  assert.equal(readdirSync(cfg.parkedDir).filter((f) => f.endsWith(".json")).length, 0);
});

test("archiveRun handles a missing or empty log without creating an archive", () => {
  const cfg = cfgFor();
  writeFileSync(join(cfg.parkedDir, "1.json"), JSON.stringify({ taskId: "1", reason: "blocked", branch: "b", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  assert.equal(result.archivedLog, undefined); // nothing to archive
  assert.equal(result.clearedParked, 1); // parked still cleared
});
