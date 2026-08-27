import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { event, readEventLog, type OrchestratorEvent } from "./event-log.ts";

const withLog = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "event-log-"));
  const file = join(dir, "orchestrator.jsonl");
  writeFileSync(file, lines.join("\n"));
  return file;
};

test("readEventLog skips a non-JSON line and a line missing a string event, keeping the well-formed events around them", () => {
  const logFile = withLog([
    JSON.stringify(event("campaign-start", { ts: "2026-08-24T00:00:00.000Z", batches: [["1"]], slots: 1 })),
    "this is not json{",
    JSON.stringify({ ts: "2026-08-24T00:00:01.000Z", foo: "no event field" }),
    JSON.stringify({ ts: "2026-08-24T00:00:02.000Z", event: 42 }),
    JSON.stringify(event("campaign-done", { ts: "2026-08-24T00:00:03.000Z", batches: 1 })),
  ]);

  const events = readEventLog({ logFile });

  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "campaign-done"],
  );
});

// A `switch (e.event)` narrows each of the 18 kinds to its member's fields with no `any` — this
// only type-checks (the `test` gate's typecheck compiles it) if every case reaches a field that
// exists solely on that member. It returns a string per kind so the runtime assertion below also
// proves the narrowing runs, not just compiles.
const describe = (e: OrchestratorEvent): string => {
  switch (e.event) {
    case "campaign-start":
      return `start ${e.batches.length}w/${e.slots}`;
    case "campaign-batch":
      return `batch ${e.index}: ${e.tasks.join(",")}`;
    case "campaign-batch-done":
      return `done ${e.index} merged ${e.merged.join(",")} held ${e.held.join(",")}`;
    case "campaign-done":
      return `campaign ${e.batches}`;
    case "campaign-halt":
      return `halt ${e.index}: ${e.reason}`;
    case "queue-start":
      return `queue ${e.taskIds.join(",")} x${e.slots}`;
    case "queue-done":
      return `drained ${Object.keys(e.outcomes).join(",")}`;
    case "queue-spawn":
      return `spawn ${e.taskId} (${e.running}/${e.left})`;
    case "turn":
      return `turn ${e.taskId}#${e.turn}: ${e.summary}`;
    case "green":
      return `green ${e.taskId} on ${e.branch} (${e.commits.length})`;
    case "parked":
      return `parked ${e.taskId}: ${e.reason}`;
    case "quarantined":
      return `quarantined ${e.taskId} on ${e.branch}`;
    case "wave-parked":
      return `wave-parked merged ${e.merged.join(",")}`;
    case "carve":
      return `carve ${e.target} dropped ${e.dropped.join(",")}`;
    case "worktree-preserved":
      return `worktree ${e.taskId} at ${e.path}`;
    case "telegram-unconfigured":
      return `unconfigured ${e.project} at ${e.baseLocation}`;
    case "wave-start":
    case "wave-merged":
      return e.text;
  }
};

test("a switch over the 18 narrowed kinds reads each member's fields", () => {
  assert.equal(describe(event("green", { taskId: "42", branch: "agent/42", commits: ["abc"] })), "green 42 on agent/42 (1)");
  assert.equal(describe(event("queue-spawn", { taskId: "7", running: 2, left: 3 })), "spawn 7 (2/3)");
  assert.equal(describe(event("wave-start", { text: "wave 1 started" })), "wave 1 started");
  assert.equal(describe(event("quarantined", { taskId: "8", branch: "agent/8", detail: "CONFLICT" })), "quarantined 8 on agent/8");
  assert.equal(describe(event("wave-parked", { merged: ["1", "2"], detail: "GATE FAILED" })), "wave-parked merged 1,2");
});

test("event() builds well-formed rows assignable to OrchestratorEvent, stamping ts and keeping fields typed", () => {
  const green = event("green", { taskId: "42", branch: "agent/42", commits: ["abc", "def"] });
  const asEvent: OrchestratorEvent = green; // assignable
  assert.equal(asEvent.event, "green");
  assert.equal(typeof green.ts, "string");
  assert.ok(green.ts.length > 0);
  assert.deepEqual(green.commits, ["abc", "def"]);

  // An explicit ts overrides the stamped default.
  const turn = event("turn", { ts: "2026-08-24T09:00:00.000Z", taskId: "9", turn: 1, summary: "did a thing" });
  assert.equal(turn.ts, "2026-08-24T09:00:00.000Z");
  assert.equal(turn.summary, "did a thing");
});
