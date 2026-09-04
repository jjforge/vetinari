import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { event, normalizeLegacyEvent, readEventLog, type OrchestratorEvent } from "./event-log.ts";

const withLog = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "event-log-"));
  const file = join(dir, "orchestrator.jsonl");
  writeFileSync(file, lines.join("\n"));
  return file;
};

test("readEventLog skips a non-JSON line and a line missing a string event, keeping the well-formed events around them", () => {
  const logFile = withLog([
    JSON.stringify(event("campaign-start", { ts: "2026-08-24T00:00:00.000Z", waves: [["1"]], slots: 1 })),
    "this is not json{",
    JSON.stringify({ ts: "2026-08-24T00:00:01.000Z", foo: "no event field" }),
    JSON.stringify({ ts: "2026-08-24T00:00:02.000Z", event: 42 }),
    JSON.stringify(event("campaign-done", { ts: "2026-08-24T00:00:03.000Z", waves: 1 })),
  ]);

  const events = readEventLog({ logFile });

  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "campaign-done"],
  );
});

// A `switch (e.event)` narrows each kind of the §2.1 union to its member's fields with no `any` —
// this only type-checks (the `test` gate's typecheck compiles it) if every case reaches a field
// that exists solely on that member. It returns a string per kind so the runtime assertion below
// also proves the narrowing runs, not just compiles.
const describe = (e: OrchestratorEvent): string => {
  switch (e.event) {
    case "campaign-start":
      return `start ${e.waves.length}w/${e.slots}`;
    case "wave-start":
      return `wave ${e.index}: ${e.tasks.join(",")}`;
    case "spawn":
      return `spawn ${e.taskId} (${e.running}/${e.left})`;
    case "turn":
      return `turn ${e.taskId}#${e.turn}: ${e.summary}`;
    case "green":
      return `green ${e.taskId} on ${e.branch} (${e.commits.length})`;
    case "merged":
      return `merged ${e.taskId}`;
    case "parked":
      return `parked ${e.taskId}: ${e.reason}${e.detail ? ` (${e.detail})` : ""}`;
    case "failed":
      return `failed ${e.taskId}`;
    case "base-gate":
      return `base-gate ${e.index ?? "?"} green=${e.green}`;
    case "wave-done":
      return `done ${e.index} merged ${(e.merged ?? []).join(",")}`;
    case "campaign-parked":
      return `campaign-parked ${e.index ?? "?"}: ${e.detail ?? ""}`;
    case "campaign-failed":
      return `campaign-failed ${e.index ?? "?"}: ${e.detail ?? ""}`;
    case "campaign-done":
      return `campaign ${e.waves}`;
    case "prune":
      return `prune ${e.target} dropped ${e.dropped.join(",")}`;
    case "graft":
      return `graft ${e.ids.join(",")}`;
    case "redrive":
      return `redrive from ${e.fromWave}`;
    case "grace-wait":
      return `grace-wait ${e.seconds}s on ${e.tasks.join(",")}`;
    case "gate":
      return `gate ${e.cmds.join(",")} skip ${e.skipped}`;
    case "gate-check":
      return `gate-check ${e.cmd}`;
    case "gate-result":
      return `gate-result ${e.cmd} exit ${e.exitCode} in ${e.seconds}s -> ${e.outFile}`;
    case "tool":
      return `tool ${e.name} ${e.path ?? ""}`;
    case "sandbox-exec":
      return `sandbox-exec ${e.cmd}`;
    case "commit":
      return `commit ${e.sha} on ${e.branch} touched ${e.files.length}`;
    case "worktree-preserved":
      return `worktree ${e.taskId} at ${e.path}`;
    case "telegram-unconfigured":
      return `unconfigured ${e.project} at ${e.baseLocation}`;
  }
};

test("a switch over the §2.1 narrowed kinds reads each member's fields", () => {
  assert.equal(describe(event("grace-wait", { seconds: 30, tasks: ["102", "103"] })), "grace-wait 30s on 102,103");
  assert.equal(describe(event("green", { taskId: "42", branch: "agent/42", commits: ["abc"] })), "green 42 on agent/42 (1)");
  assert.equal(describe(event("spawn", { taskId: "7", running: 2, left: 3 })), "spawn 7 (2/3)");
  assert.equal(describe(event("wave-start", { index: 0, tasks: ["1", "2"] })), "wave 0: 1,2");
  assert.equal(describe(event("merged", { taskId: "8", branch: "agent/8" })), "merged 8");
  assert.equal(describe(event("parked", { taskId: "8", reason: "conflict", detail: "CONFLICT" })), "parked 8: conflict (CONFLICT)");
  assert.equal(describe(event("failed", { taskId: "2", detail: "error(1)" })), "failed 2");
  assert.equal(describe(event("base-gate", { index: 1, green: false, detail: "boom" })), "base-gate 1 green=false");
  assert.equal(describe(event("wave-done", { index: 1, merged: ["1"] })), "done 1 merged 1");
  assert.equal(describe(event("campaign-parked", { index: 2, detail: "red base" })), "campaign-parked 2: red base");
  assert.equal(describe(event("campaign-failed", { index: 2, detail: "2 failed" })), "campaign-failed 2: 2 failed");
  assert.equal(describe(event("redrive", { fromWave: 1 })), "redrive from 1");
  assert.equal(describe(event("graft", { ids: ["305", "306"], blockedBy: {}, fileKeys: {} })), "graft 305,306");
  assert.equal(describe(event("gate", { taskId: "9", cmds: ["typecheck", "test"], skipped: 1 })), "gate typecheck,test skip 1");
  assert.equal(describe(event("gate-check", { taskId: "9", cmd: "run-tests" })), "gate-check run-tests");
  assert.equal(describe(event("tool", { taskId: "9", name: "Read", path: "/a.ts" })), "tool Read /a.ts");
  assert.equal(describe(event("sandbox-exec", { taskId: "9", cmd: "ls" })), "sandbox-exec ls");
  assert.equal(describe(event("commit", { taskId: "9", branch: "agent/9", sha: "abc", files: ["a.ts", "b.ts"] })), "commit abc on agent/9 touched 2");
});

test("campaign-start records name and titles once, and they round-trip through readEventLog", () => {
  const titles = { "101": "cache eviction", "102": "warm the cache" };
  const logFile = withLog([
    JSON.stringify(event("campaign-start", { ts: "2026-08-27T00:00:00.000Z", waves: [["101", "102"]], slots: 2, name: "gateway work", titles })),
    JSON.stringify(event("wave-start", { ts: "2026-08-27T00:00:01.000Z", index: 0, tasks: ["101", "102"] })),
    JSON.stringify(event("campaign-done", { ts: "2026-08-27T00:00:02.000Z", waves: 1, name: "gateway work" })),
  ]);

  const events = readEventLog({ logFile });

  const start = events[0];
  assert.equal(start.event === "campaign-start" && start.name, "gateway work");
  assert.deepEqual(start.event === "campaign-start" ? start.titles : undefined, titles);
  // The wave event carries no name/titles — they were recorded once, on campaign-start.
  assert.deepEqual(Object.keys(events[1]), ["ts", "index", "tasks", "event"]);
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

// ── the alias table: archived logs in the retired vocabulary still render (design §13.2) ──

test("normalizeLegacyEvent renames the retired event kinds one-for-one to the §2.1 set", () => {
  const map = (event: string, extra: Record<string, unknown> = {}) =>
    normalizeLegacyEvent({ ts: "t", event, ...extra }).map((e) => e.event);
  assert.deepEqual(map("campaign-batch", { index: 0, tasks: ["1"] }), ["wave-start"]);
  assert.deepEqual(map("campaign-batch-done", { index: 0, merged: ["1"] }), ["wave-done"]);
  assert.deepEqual(map("queue-spawn", { taskId: "1" }), ["spawn"]);
  assert.deepEqual(map("wave-parked", { merged: ["1"], detail: "d" }), ["campaign-parked"]);
  assert.deepEqual(map("campaign-resume", { fromIndex: 2 }), ["redrive"]);
});

test("normalizeLegacyEvent maps a quarantined event to parked with reason conflict, keeping its detail", () => {
  const [parked] = normalizeLegacyEvent({ ts: "t", event: "quarantined", taskId: "640", branch: "agent/640", detail: "CONFLICT (content)" });
  assert.equal(parked.event, "parked");
  assert.equal(parked.event === "parked" && parked.reason, "conflict");
  assert.equal(parked.event === "parked" && parked.detail, "CONFLICT (content)");
});

test("normalizeLegacyEvent maps the retired park reasons to the one enum, keeping the specific in detail", () => {
  const reason = (r: string) => {
    const [p] = normalizeLegacyEvent({ ts: "t", event: "parked", taskId: "1", reason: r });
    return p.event === "parked" ? { reason: p.reason, detail: p.detail } : undefined;
  };
  assert.deepEqual(reason("blocked"), { reason: "question", detail: undefined });
  assert.deepEqual(reason("budget"), { reason: "stalled", detail: "budget" });
  assert.deepEqual(reason("idle-timeout"), { reason: "stalled", detail: "idle" });
  assert.deepEqual(reason("no-commit"), { reason: "stalled", detail: "no-commit" });
});

test("normalizeLegacyEvent fans a legacy queue-start into a spawn per task and a legacy queue-done into per-task terminals", () => {
  const spawns = normalizeLegacyEvent({ ts: "t", event: "queue-start", taskIds: ["1", "2"], slots: 2 });
  assert.deepEqual(spawns.map((e) => [e.event, e.event === "spawn" ? e.taskId : undefined]), [["spawn", "1"], ["spawn", "2"]]);
  const drained = normalizeLegacyEvent({ ts: "t", event: "queue-done", outcomes: { "1": "green", "2": "error(1)", "3": "parked" } });
  // green → green, error → failed; a parked outcome already carried its own parked row.
  assert.deepEqual(drained.map((e) => e.event), ["green", "failed"]);
});

test("normalizeLegacyEvent fans an old campaign-failed (failures inline) into a failed per id plus the bare stop marker", () => {
  const rows = normalizeLegacyEvent({ ts: "t", event: "campaign-failed", merged: ["1"], failed: ["2", "3"] });
  assert.deepEqual(rows.map((e) => e.event), ["failed", "failed", "campaign-failed"]);
  assert.deepEqual(rows.filter((e) => e.event === "failed").map((e) => (e.event === "failed" ? e.taskId : "")), ["2", "3"]);
});

test("normalizeLegacyEvent renames campaign-done.batches to waves", () => {
  const [done] = normalizeLegacyEvent({ ts: "t", event: "campaign-done", batches: 3 });
  assert.equal(done.event === "campaign-done" && done.waves, 3);
});

test("readEventLog renders a whole archived run written in the retired vocabulary", () => {
  const logFile = withLog([
    JSON.stringify({ ts: "t0", event: "campaign-start", batches: [["1", "2"]], slots: 2, name: "old run" }),
    JSON.stringify({ ts: "t1", event: "campaign-batch", index: 0, tasks: ["1", "2"] }),
    JSON.stringify({ ts: "t2", event: "queue-spawn", taskId: "1", running: 1, left: 1 }),
    JSON.stringify({ ts: "t3", event: "parked", taskId: "2", reason: "blocked" }),
    JSON.stringify({ ts: "t4", event: "quarantined", taskId: "1", branch: "agent/1", detail: "CONFLICT" }),
    JSON.stringify({ ts: "t5", event: "wave-parked", merged: ["1"], detail: "gate red" }),
    JSON.stringify({ ts: "t6", event: "campaign-done", batches: 1 }),
  ]);

  const events = readEventLog({ logFile });

  // Every row now speaks the §2.1 vocabulary; the retired names are gone from the read output.
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "wave-start", "spawn", "parked", "parked", "campaign-parked", "campaign-done"],
  );
  const start = events[0];
  assert.equal(start.event === "campaign-start" && Array.isArray(start.waves) && start.waves.length, 1);
  const blocked = events[3];
  assert.equal(blocked.event === "parked" && blocked.reason, "question");
  const conflict = events[4];
  assert.equal(conflict.event === "parked" && conflict.reason, "conflict");
});
