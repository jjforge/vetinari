import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedConfig } from "./config.ts";
import { clearParkedForTasks, listParked } from "./state.ts";

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
