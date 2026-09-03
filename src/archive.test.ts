import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { archiveRun, hasUnarchivedRun, shouldArchiveIdle, shouldArchiveLeftover } from "./archive.ts";
import { enqueueOutbound, listOutbox, markOutboundSent, outboxDirOf } from "./state.ts";
import type { OrchestratorEvent } from "./event-log.ts";
import { memoryLogger } from "./log.ts";

let counter = 0;
const cfgFor = (): ResolvedConfig => {
  const dir = join(tmpdir(), `vetinari-archive-${Date.now()}-${counter++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  return { project: "demo", stateDir: dir, logFile: join(dir, "logs", "orchestrator.jsonl"), parkedDir: join(dir, "parked"), log: memoryLogger() } as unknown as ResolvedConfig;
};

test("archiveRun moves the log aside and resets it, but leaves parked records alone (design §2.5)", () => {
  const cfg = cfgFor();
  writeFileSync(cfg.logFile, '{"event":"campaign-start","batches":[["101"]]}\n{"event":"green","taskId":"101"}\n');
  writeFileSync(join(cfg.parkedDir, "202.json"), JSON.stringify({ taskId: "202", reason: "question", branch: "agent/202", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  // Live log is reset to empty; the archive preserves the old content.
  assert.equal(readFileSync(cfg.logFile, "utf8"), "");
  assert.ok(result.archivedLog && existsSync(result.archivedLog));
  assert.match(readFileSync(result.archivedLog!, "utf8"), /campaign-start/);
  // The parked record survives the archive — it keeps the card off idle and the gateway's
  // reply index intact until the issue is answered/redriven or explicitly purged (§2.4, §2.5).
  assert.equal(readdirSync(cfg.parkedDir).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(existsSync(join(cfg.parkedDir, "202.json")), true);
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

const ev = (event: string, extra: Record<string, unknown> = {}): OrchestratorEvent =>
  ({ event, ...extra }) as unknown as OrchestratorEvent;

test("shouldArchiveIdle: a campaign that ended failed (nothing parked) is not idle — stays in the live log for redrive (#383)", () => {
  // A member's agent could not go green; the campaign logs campaign-failed and stops.
  // No per-issue parked record — a failure needs a redrive or a fix, not an answer.
  const events = [
    ev("campaign-start", { waves: [["382"]], slots: 1 }),
    ev("wave-start", { index: 0, tasks: ["382"] }),
    ev("spawn", { taskId: "382" }),
    ev("failed", { taskId: "382" }),
    ev("campaign-failed", { index: 0, detail: "382 failed" }),
  ];
  assert.equal(shouldArchiveIdle(events, { parked: 0 }), false);
});

test("shouldArchiveIdle: a campaign parked on a red base (no per-issue record) is not idle (#383)", () => {
  // The merged base gated red — a whole-wave park, never a per-issue parked record.
  // Nothing is parked on disk, but the campaign has not settled, so it must stay live
  // for a plain redrive (once the base is fixed) to find and continue it.
  const events = [
    ev("campaign-start", { waves: [["101"]], slots: 1 }),
    ev("wave-start", { index: 0, tasks: ["101"] }),
    ev("green", { taskId: "101" }),
    ev("campaign-parked", { index: 0, reason: "red-base" }),
  ];
  assert.equal(shouldArchiveIdle(events, { parked: 0 }), false);
});

test("shouldArchiveIdle: a campaign that reached campaign-done still archives immediately (#383)", () => {
  // Every wave closed, every member merged — the run is truly over and archives at once,
  // exactly as before.
  const events = [
    ev("campaign-start", { waves: [["101"]], slots: 1 }),
    ev("wave-start", { index: 0, tasks: ["101"] }),
    ev("green", { taskId: "101" }),
    ev("wave-done", { index: 0, merged: ["101"] }),
    ev("campaign-done", { waves: 1 }),
  ];
  assert.equal(shouldArchiveIdle(events, { parked: 0 }), true);
});

test("shouldArchiveIdle: a per-issue parked record keeps the run live, campaign or not (#383)", () => {
  // A question/stall/conflict park was already suppressed by the parked check — still is.
  const settled = [
    ev("campaign-start", { waves: [["101"]], slots: 1 }),
    ev("wave-done", { index: 0, merged: ["101"] }),
    ev("campaign-done", { waves: 1 }),
  ];
  assert.equal(shouldArchiveIdle(settled, { parked: 1 }), false);
});

test("shouldArchiveIdle: a standalone run/answer (never a campaign-start) is decided by the parked check alone (#383)", () => {
  // A green standalone run archives; a parked one stays live. No campaign to keep live either way.
  assert.equal(shouldArchiveIdle([ev("spawn", { taskId: "101" }), ev("green", { taskId: "101" })], { parked: 0 }), true);
  assert.equal(shouldArchiveIdle([ev("spawn", { taskId: "101" })], { parked: 1 }), false);
});

test("archiveRun handles a missing or empty log without creating an archive, and still leaves records alone", () => {
  const cfg = cfgFor();
  writeFileSync(join(cfg.parkedDir, "1.json"), JSON.stringify({ taskId: "1", reason: "question", branch: "b", sessionId: "s", question: "?" }));

  const result = archiveRun(cfg);

  assert.equal(result.archivedLog, undefined); // nothing to archive
  assert.equal(existsSync(join(cfg.parkedDir, "1.json")), true); // the record is untouched (§2.5)
});
