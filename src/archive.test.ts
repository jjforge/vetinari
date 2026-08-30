import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { archiveRun, hasUnarchivedRun, shouldArchiveLeftover } from "./archive.ts";
import { enqueueOutbound, listOutbox, markOutboundSent, outboxDirOf } from "./state.ts";
import { memoryLogger } from "./log.ts";

let counter = 0;
const cfgFor = (): ResolvedConfig => {
  const dir = join(tmpdir(), `vetinari-archive-${Date.now()}-${counter++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  return { project: "demo", stateDir: dir, logFile: join(dir, "logs", "orchestrator.jsonl"), parkedDir: join(dir, "parked"), log: memoryLogger() } as unknown as ResolvedConfig;
};

test("archiveRun moves the log aside, resets it, and clears parked records", () => {
  const cfg = cfgFor();
  writeFileSync(cfg.logFile, '{"event":"campaign-start","batches":[["101"]]}\n{"event":"green","taskId":"101"}\n');
  writeFileSync(join(cfg.parkedDir, "202.json"), JSON.stringify({ taskId: "202", reason: "question", branch: "agent/202", sessionId: "s", question: "?" }));

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

test("hasUnarchivedRun is false for a missing, empty, or marker-only live log", () => {
  const cfg = cfgFor();
  // missing file
  assert.equal(hasUnarchivedRun(cfg), false);
  // empty file
  writeFileSync(cfg.logFile, "");
  assert.equal(hasUnarchivedRun(cfg), false);
  // only the "archived" marker a clean end-of-run archive leaves behind — no run
  writeFileSync(cfg.logFile, '{"event":"archived","archivedLog":"x"}\n');
  assert.equal(hasUnarchivedRun(cfg), false);
});

test("hasUnarchivedRun is true when a prior campaign or queue run still sits in the live log", () => {
  const campaignCfg = cfgFor();
  writeFileSync(campaignCfg.logFile, '{"event":"archived"}\n{"event":"campaign-start","batches":[["101"]]}\n{"event":"campaign-done","batches":1}\n');
  assert.equal(hasUnarchivedRun(campaignCfg), true);

  const queueCfg = cfgFor();
  writeFileSync(queueCfg.logFile, '{"event":"queue-start","taskIds":["101"]}\n');
  assert.equal(hasUnarchivedRun(queueCfg), true);
});

test("shouldArchiveLeftover: a child run never archives, even with a genuine leftover in the log (#150)", () => {
  const cfg = cfgFor();
  // A parent campaign's in-flight log — hasUnarchivedRun would see this as a leftover.
  writeFileSync(cfg.logFile, '{"event":"campaign-start","batches":[["101"]]}\n');
  assert.equal(hasUnarchivedRun(cfg), true); // the leftover is real…
  // …but a child `run` spawned by that campaign must leave it alone, or it would
  // archive its own parent's plan mid-run and stop the campaign after wave 0.
  assert.equal(shouldArchiveLeftover(cfg, { isChild: true }), false);
});

test("shouldArchiveLeftover: a top-level run still archives a genuine leftover (#141)", () => {
  const cfg = cfgFor();
  writeFileSync(cfg.logFile, '{"event":"campaign-start","batches":[["101"]]}\n');
  assert.equal(shouldArchiveLeftover(cfg, { isChild: false }), true);
  // No leftover → nothing to archive, child or not.
  const fresh = cfgFor();
  assert.equal(shouldArchiveLeftover(fresh, { isChild: false }), false);
});

test("archiveRun handles a missing or empty log without creating an archive", () => {
  const cfg = cfgFor();
  writeFileSync(join(cfg.parkedDir, "1.json"), JSON.stringify({ taskId: "1", reason: "question", branch: "b", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  assert.equal(result.archivedLog, undefined); // nothing to archive
  assert.equal(result.clearedParked, 1); // parked still cleared
});
