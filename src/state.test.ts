import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedConfig } from "./config.ts";
import { clearParkedForTasks, listParked, park } from "./state.ts";

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
  const dir = join(tmpdir(), `sctdd-clear-parked-${Date.now()}`);
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
  const dir = join(tmpdir(), `sctdd-park-silent-${Date.now()}`);
  mkdirSync(join(dir, "parked"), { recursive: true });

  // Telegram fully configured in the orchestrator env: park must STILL not send.
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  process.env.SANDCASTLE_TELEGRAM_BOT_TOKEN = "tok";
  process.env.SANDCASTLE_TELEGRAM_CHAT_ID = "chat";
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
