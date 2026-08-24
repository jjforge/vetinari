import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedConfig } from "./config.ts";
import {
  clearParkedForTasks,
  enqueueOutbound,
  listOutbox,
  listOutboxIn,
  listParked,
  listParkedIn,
  markOutboundSent,
  outboxDirOf,
  park,
  setParkedMessageId,
} from "./state.ts";

const cfgFor = (dir: string): ResolvedConfig =>
  ({
    project: "demo",
    image: "img",
    baseBranch: "main",
    branchPrefix: "agent/",
    gates: [{ cmd: "true" }],
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
    promptFile: "prompt.md",
    fetchTask: (id: string) => id,
  }) as ResolvedConfig;

const parkFixture = (dir: string, taskId: string) =>
  writeFileSync(
    join(dir, "parked", `${taskId}.json`),
    JSON.stringify({ taskId, parkedAt: "now", reason: "blocked", branch: `agent/${taskId}`, sessionId: "s", question: "Need a choice." }),
  );

test("clearParkedForTasks removes only parked records for completed wave tasks", () => {
  const dir = join(tmpdir(), `vetinari-clear-parked-${Date.now()}`);
  mkdirSync(join(dir, "parked"), { recursive: true });
  parkFixture(dir, "101");
  parkFixture(dir, "102");
  parkFixture(dir, "201");

  clearParkedForTasks(cfgFor(dir), ["101", "102"]);

  assert.deepEqual(
    listParked(cfgFor(dir)).map((p) => p.taskId),
    ["201"],
  );
});

test("park writes its record silently — the gateway is the only sender, so park never calls Telegram", async () => {
  const dir = join(tmpdir(), `vetinari-park-silent-${Date.now()}`);
  mkdirSync(join(dir, "parked"), { recursive: true });

  // Telegram fully configured in the orchestrator env: park must STILL not send.
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  process.env.VETINARI_TELEGRAM_BOT_TOKEN = "tok";
  process.env.VETINARI_TELEGRAM_CHAT_ID = "chat";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { json: async () => ({ ok: true, result: { message_id: 7 } }), status: 200 } as unknown as Response;
  }) as typeof fetch;

  try {
    await park(cfgFor(dir), { taskId: "301", reason: "blocked", sessionId: "s", branch: "agent/301", question: "Need a choice." });
  } finally {
    globalThis.fetch = savedFetch;
    process.env = savedEnv;
  }

  assert.equal(fetchCalls, 0, "park must not send to Telegram");
  const rec = listParked(cfgFor(dir)).find((p) => p.taskId === "301");
  assert.ok(rec, "the record is written");
  assert.equal(rec!.tgMessageId, undefined, "no message id yet — the gateway announces and fills it in");
});

test("setParkedMessageId stamps the announced message id into an existing parked record", async () => {
  const dir = join(tmpdir(), `vetinari-stamp-${Date.now()}`);
  mkdirSync(join(dir, "parked"), { recursive: true });
  await park(cfgFor(dir), { taskId: "410", reason: "blocked", sessionId: "s", branch: "agent/410", question: "?" });

  setParkedMessageId(join(dir, "parked"), "410", 4242);

  const rec = listParkedIn(join(dir, "parked")).find((p) => p.taskId === "410");
  assert.equal(rec?.tgMessageId, 4242);
});

test("setParkedMessageId leaves an already-cleared record alone", () => {
  const dir = join(tmpdir(), `vetinari-stamp-gone-${Date.now()}`);
  mkdirSync(join(dir, "parked"), { recursive: true });

  // No throw for a record that was answered and cleared before the stamp landed.
  setParkedMessageId(join(dir, "parked"), "999", 7);

  assert.deepEqual(listParkedIn(join(dir, "parked")), []);
});

let outboxCounter = 0;
const outboxDir = () => join(tmpdir(), `vetinari-outbox-${Date.now()}-${outboxCounter++}`);

test("enqueueOutbound writes a category-tagged outbound record the gateway can drain", () => {
  const dir = outboxDir();

  enqueueOutbound(cfgFor(dir), { category: "progress", event: "wave-start", text: "batch 1 started" });

  const recs = listOutboxIn(outboxDirOf(dir));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].category, "progress");
  assert.equal(recs[0].event, "wave-start");
  assert.equal(recs[0].text, "batch 1 started");
  assert.equal(recs[0].sentAt, undefined, "a fresh record is unsent");
  assert.ok(recs[0].id, "every record carries an id");
});

test("enqueueOutbound records an eventless category and keeps event undefined", () => {
  const dir = outboxDir();

  enqueueOutbound(cfgFor(dir), { category: "finding", text: "filed 2 findings" });

  const recs = listOutbox(cfgFor(dir));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].category, "finding");
  assert.equal(recs[0].event, undefined);
});

test("enqueueOutbound keeps concurrent records distinct — no id collision within a tick", () => {
  const dir = outboxDir();

  for (let i = 0; i < 5; i++) enqueueOutbound(cfgFor(dir), { category: "progress", text: `msg ${i}` });

  const recs = listOutboxIn(outboxDirOf(dir));
  assert.equal(recs.length, 5, "five enqueues leave five records");
  assert.equal(new Set(recs.map((r) => r.id)).size, 5, "ids are unique");
});

test("markOutboundSent stamps a record sent-in-place so it is never routed twice", () => {
  const dir = outboxDir();
  enqueueOutbound(cfgFor(dir), { category: "success", event: "green", text: "GREEN on 26" });
  const [rec] = listOutboxIn(outboxDirOf(dir));

  markOutboundSent(outboxDirOf(dir), rec.id, "ops");

  const [after] = listOutboxIn(outboxDirOf(dir));
  assert.equal(after.id, rec.id);
  assert.ok(after.sentAt, "sentAt is stamped");
  assert.equal(after.destination, "ops", "the resolved destination is recorded");
});

test("markOutboundSent leaves an already-cleared record alone", () => {
  const dir = outboxDir();
  mkdirSync(outboxDirOf(dir), { recursive: true });

  // No throw for a record cleared (archived) before the mark landed.
  markOutboundSent(outboxDirOf(dir), "gone", "ops");

  assert.deepEqual(listOutboxIn(outboxDirOf(dir)), []);
});
