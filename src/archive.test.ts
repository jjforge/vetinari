import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { archiveRun } from "./archive.ts";
import { enqueueOutbound, listOutbox, markOutboundSent, outboxDirOf } from "./state.ts";

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

test("archiveRun clears sent outbound records but leaves unsent ones for the gateway", () => {
  const cfg = cfgFor();
  enqueueOutbound(cfg, { category: "success", event: "green", text: "GREEN" });
  enqueueOutbound(cfg, { category: "progress", event: "campaign-complete", text: "done" });
  const [first] = listOutbox(cfg);
  markOutboundSent(outboxDirOf(cfg.stateDir), first.id); // one already routed

  const result = archiveRun(cfg);

  // The routed record is cleared; the still-unsent one survives so a message
  // emitted while the gateway was down is not dropped (user story 14).
  assert.equal(result.clearedOutbound, 1);
  const left = listOutbox(cfg);
  assert.equal(left.length, 1);
  assert.equal(left[0].sentAt, undefined);
});

test("archiveRun handles a missing or empty log without creating an archive", () => {
  const cfg = cfgFor();
  writeFileSync(join(cfg.parkedDir, "1.json"), JSON.stringify({ taskId: "1", reason: "blocked", branch: "b", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  assert.equal(result.archivedLog, undefined); // nothing to archive
  assert.equal(result.clearedParked, 1); // parked still cleared
});
