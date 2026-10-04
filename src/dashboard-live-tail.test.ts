// Tests for the dashboard's live surfaces — the live-update stream's appended-event reader and
// machine-noise filter (dashboard-live-tail.ts). `buildLiveTail` is tested in live-tail.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { appendedEvents, viewRelevantEvents } from "./dashboard-live-tail.ts";
import { event, type OrchestratorEvent } from "./event-log.ts";

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

test("appendedEvents returns the whole log and its end offset from a zero offset", () => {
  const log =
    JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n" + JSON.stringify(event("spawn", { taskId: "101" })) + "\n";
  const { events, offset } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "spawn"],
  );
  assert.equal(offset, log.length);
});

test("appendedEvents returns only the events appended past a prior offset", () => {
  const first = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
  const appended = JSON.stringify(event("turn", { taskId: "101", turn: 0, summary: "" })) + "\n";
  const { offset } = appendedEvents(first, 0);
  const next = appendedEvents(first + appended, offset);
  assert.deepEqual(
    next.events.map((e) => e.event),
    ["turn"],
  );
  assert.equal(next.offset, first.length + appended.length);
});

test("appendedEvents leaves a partial trailing line unconsumed until it is complete", () => {
  const complete = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
  const partial = '{"event":"turn"';
  const mid = appendedEvents(complete + partial, 0);
  // Only the complete line is consumed; the offset stops before the partial line.
  assert.deepEqual(
    mid.events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(mid.offset, complete.length);
  // Once the line is finished, resuming from the same offset yields it whole.
  const done = appendedEvents(complete + partial + ',"taskId":"101"}\n', mid.offset);
  assert.deepEqual(
    done.events.map((e) => e.event),
    ["turn"],
  );
});

test("appendedEvents re-reads from the start when the log is shorter than the offset (rotated/truncated)", () => {
  const rotated = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
  const { events, offset } = appendedEvents(rotated, 9999);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(offset, rotated.length);
});

test("appendedEvents skips an unparseable line the way readEventLog does", () => {
  const log = "not json\n" + JSON.stringify(event("spawn", { taskId: "101" })) + "\n";
  const { events } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["spawn"],
  );
});

test("viewRelevantEvents drops known machine-noise the live view never shows, fail-open on the rest (#131)", () => {
  const events: OrchestratorEvent[] = [
    event("green", { taskId: "101", branch: "agent/101", commits: [] }),
    noise({ event: "telegram-send-failed", chatId: "42" }),
    event("turn", { taskId: "101", turn: 0, summary: "" }),
    noise({ event: "outbound-enqueued", kind: "wave-start" }),
    event("parked", { taskId: "202", reason: "question" }),
  ];
  // The two side-channel noise rows fall away; every view-relevant row survives, in order.
  assert.deepEqual(
    viewRelevantEvents(events).map((e) => e.event),
    ["green", "turn", "parked"],
  );
  // Fail-open: an unknown/new event kind is kept, never dropped — an allowlist would
  // silently swallow events the per-repo detail view needs (turn/gate detail).
  assert.deepEqual(
    viewRelevantEvents([noise({ event: "some-future-kind" })]).map((e) => e.event),
    ["some-future-kind"],
  );
  // A batch of pure noise survives to nothing, so the SSE path can emit zero frames for it.
  assert.deepEqual(viewRelevantEvents([noise({ event: "telegram-send-failed" }), noise({ event: "outbound-enqueued" })]), []);
});
