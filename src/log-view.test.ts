import test from "node:test";
import assert from "node:assert/strict";
import { humanizeHostLine, humanizeLogLine, LOG_DOT_STATE_COLOR } from "./log-view.ts";
import { event } from "./event-log.ts";
import { describeEvent } from "./dashboard-model.ts";

const raw = (e: object) => JSON.stringify(e);

// The humanizer registry (#203): one JSONL activity line → its humanized parts
// (time · actor · what happened, plus the state-coloured dot). Keyed on the event
// kind; every shipped kind renders a purpose-built line, an unknown kind falls back
// to a one-line raw dump (never a blank row).

test("a tool event humanizes to `time · #issue · <name> <path>` with a running dot", () => {
  const row = humanizeLogLine(raw(event("tool", { taskId: "204", name: "Edit", path: "src/x.ts", ts: "2026-08-28T14:01:23.000Z" })));
  assert.equal(row.time, "14:01:23");
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "Edit src/x.ts");
  assert.equal(row.dot, "running");
});

test("a tool event with a byte size appends it; a pathless tool omits the path", () => {
  const wrote = humanizeLogLine(raw(event("tool", { taskId: "9", name: "Write", path: "a.ts", size: 128, ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(wrote.message, "Write a.ts (128 bytes)");
  const search = humanizeLogLine(raw(event("tool", { taskId: "9", name: "Grep", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(search.message, "Grep");
});

test("a sandbox-exec event humanizes to a `$ <cmd>` shell line, running dot", () => {
  const row = humanizeLogLine(raw(event("sandbox-exec", { taskId: "204", cmd: "npm test", ts: "2026-08-28T09:15:00.000Z" })));
  assert.equal(row.time, "09:15:00");
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "$ npm test");
  assert.equal(row.dot, "running");
});

test("a commit event names its short sha and file count, running dot", () => {
  const one = humanizeLogLine(raw(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["src/x.ts"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(one.message, "committed abcdef1 · 1 file");
  assert.equal(one.dot, "running");
  const many = humanizeLogLine(raw(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["a", "b"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(many.message, "committed abcdef1 · 2 files");
});

test("a gate-result event reads pass green (merged) and fail red (failure)", () => {
  const pass = humanizeLogLine(raw(event("gate-result", { taskId: "204", cmd: "npm test", exitCode: 0, seconds: 12, outFile: "o", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(pass.message, "npm test → passed (12s)");
  assert.equal(pass.dot, "merged");
  const fail = humanizeLogLine(raw(event("gate-result", { taskId: "204", cmd: "npm test", exitCode: 1, seconds: 3, outFile: "o", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(fail.message, "npm test → exit 1 (3s)");
  assert.equal(fail.dot, "failure");
});

test("a gate event names how many checks it selected, running dot", () => {
  const row = humanizeLogLine(raw(event("gate", { taskId: "204", cmds: ["a", "b"], skipped: 1, ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.message, "gate — 2 checks");
  assert.equal(row.dot, "running");
});

// Per-issue outcome kinds: the actor is split out to `#issue`, the message is the
// describeEvent wording minus that prefix, and the dot reads the outcome's colour.
test("a turn event carries the agent summary as the message, #issue actor, running dot", () => {
  const row = humanizeLogLine(raw(event("turn", { taskId: "204", turn: 3, summary: "Wired the humanizer registry", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "Wired the humanizer registry");
  assert.equal(row.dot, "running");
  // A pre-summary turn degrades to the mechanical "turn N".
  const bare = humanizeLogLine(raw(event("turn", { taskId: "204", turn: 3, summary: "", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(bare.message, "turn 3");
});

test("a green event reads as merged (green dot), #issue actor", () => {
  const row = humanizeLogLine(raw(event("green", { taskId: "204", branch: "agent/204", commits: ["a"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "merged");
  assert.equal(row.dot, "merged");
});

test("a parked event reads amber (parked dot) with its reason", () => {
  const row = humanizeLogLine(raw(event("parked", { taskId: "204", reason: "blocked", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "parked: blocked");
  assert.equal(row.dot, "parked");
});

test("a quarantined event reads amber (parked dot)", () => {
  const row = humanizeLogLine(raw(event("quarantined", { taskId: "204", branch: "agent/204", detail: "conflict", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.message, "quarantined — resolve the conflict");
  assert.equal(row.dot, "parked");
});

// Run-level campaign/wave kinds: no per-issue actor, and the message is single-sourced
// from `describeEvent` so the log view and the feed narrate them with identical words
// (the registry is "seeded from describeEvent"). The dot reads the comms colour.
test("run-level kinds narrate through describeEvent verbatim, with no actor", () => {
  const cases = [
    event("campaign-start", { batches: [["1"]], slots: 1, name: "Ship it", ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-batch", { index: 0, tasks: ["1", "2"], name: "Ship it", ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-batch-done", { index: 0, merged: ["1"], held: [], clearedParked: [], ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-done", { batches: 2, ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-halt", { index: 1, reason: "gate red", ts: "2026-08-28T00:00:00.000Z" }),
    event("wave-parked", { merged: ["1"], detail: "red", ts: "2026-08-28T00:00:00.000Z" }),
    event("carve", { target: "5", removed: ["5", "6"], dropped: ["6"], ts: "2026-08-28T00:00:00.000Z" }),
    event("graft", { ids: ["9"], blockedBy: {}, basenames: {}, ts: "2026-08-28T00:00:00.000Z" }),
  ];
  for (const e of cases) {
    const row = humanizeLogLine(raw(e));
    assert.equal(row.actor, "", `${e.event} is run-level, no actor`);
    assert.equal(row.message, describeEvent(e), `${e.event} narration matches describeEvent`);
  }
});

test("run-level dot colours: success→merged, halt→failure, wave-parked→parked, start→running, carve→neutral", () => {
  const dot = (e: object) => humanizeLogLine(raw(e)).dot;
  assert.equal(dot(event("campaign-batch-done", { index: 0, merged: ["1"], held: [], clearedParked: [], ts: "2026-08-28T00:00:00.000Z" })), "merged");
  assert.equal(dot(event("campaign-done", { batches: 1, ts: "2026-08-28T00:00:00.000Z" })), "merged");
  assert.equal(dot(event("campaign-halt", { index: 0, reason: "x", ts: "2026-08-28T00:00:00.000Z" })), "failure");
  assert.equal(dot(event("wave-parked", { merged: [], detail: "d", ts: "2026-08-28T00:00:00.000Z" })), "parked");
  assert.equal(dot(event("campaign-start", { batches: [], slots: 1, ts: "2026-08-28T00:00:00.000Z" })), "running");
  assert.equal(dot(event("carve", { target: "5", removed: ["5"], dropped: [], ts: "2026-08-28T00:00:00.000Z" })), "neutral");
});

// The fallback contract: an unknown kind, or an unparseable line, is never a blank row —
// it dumps the raw source text on a neutral dot, keeping its time and any actor it named.
test("an unknown event kind falls back to a one-line raw dump, never blank", () => {
  const line = raw({ event: "host-heartbeat", taskId: "204", detail: "ok", ts: "2026-08-28T12:00:00.000Z" });
  const row = humanizeLogLine(line);
  assert.equal(row.time, "12:00:00");
  assert.equal(row.actor, "#204");
  assert.equal(row.message, line);
  assert.equal(row.dot, "neutral");
});

test("an unparseable line dumps its raw text, no crash, never blank", () => {
  const row = humanizeLogLine("}{ not json");
  assert.equal(row.time, "");
  assert.equal(row.actor, "");
  assert.equal(row.message, "}{ not json");
  assert.equal(row.dot, "neutral");
  assert.ok(row.message.length > 0, "the raw dump is never a blank row");
});

test("each dot state maps to a stateColor token so the chrome can paint all five", () => {
  // The five painted states, mapped to the ADR-0007 status token stateColor keys off:
  // running→blue, merged→completed(green), failure→red, parked→amber, neutral→dim.
  assert.deepEqual(LOG_DOT_STATE_COLOR, {
    running: "running",
    merged: "completed",
    failure: "failure",
    parked: "parked",
    neutral: "unstarted",
  });
});

// The host-log's registry (#203): `humanizeHostLine` is the sibling of `humanizeLogLine`
// for the host surface — the same `time · actor · what happened` parts, keyed on the
// host-kind `event`. Self-contained (no `describeEvent`) so it ships into the host-log
// client via `.toString()` and humanizes the fetched window and each live frame in-browser.

test("a gateway-routed line reads `routed <category> → <destination>`, the project as actor, neutral dot", () => {
  const row = humanizeHostLine(raw({ event: "gateway-routed", project: "alpha", id: "12", category: "question", destination: "telegram", ts: "2026-08-28T14:01:23.000Z" }));
  assert.equal(row.time, "14:01:23");
  assert.equal(row.actor, "alpha");
  assert.equal(row.message, "routed question → telegram");
  assert.equal(row.dot, "neutral");
});

test("a gateway-announced line reads `announced #<task>`, project actor, neutral dot", () => {
  const row = humanizeHostLine(raw({ event: "gateway-announced", project: "beta", task: "204", messageId: 7, ts: "2026-08-28T09:15:00.000Z" }));
  assert.equal(row.actor, "beta");
  assert.equal(row.message, "announced #204");
  assert.equal(row.dot, "neutral");
});

test("a gateway-start line reads `gateway up` with its bot count, host actor, neutral dot", () => {
  const up = humanizeHostLine(raw({ event: "gateway-start", configDir: "/cfg", bots: 2, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(up.actor, "host");
  assert.equal(up.message, "gateway up · 2 bots");
  assert.equal(up.dot, "neutral");
  // No bots yet: the count clause drops rather than reading "· 0 bots".
  const silent = humanizeHostLine(raw({ event: "gateway-start", configDir: "/cfg", bots: 0, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(silent.message, "gateway up");
});

test("a telegram-unconfigured line reads a parked (amber) warning, project actor", () => {
  const row = humanizeHostLine(raw({ event: "telegram-unconfigured", project: "alpha", baseLocation: "/a", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "alpha");
  assert.equal(row.message, "⚠ Telegram not configured");
  assert.equal(row.dot, "parked");
});

test("a registry-stale line reads a parked (amber) `stale registration`, project actor", () => {
  const row = humanizeHostLine(raw({ event: "registry-stale", project: "gone", baseLocation: "/x", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "gone");
  assert.equal(row.message, "stale registration");
  assert.equal(row.dot, "parked");
});

test("a telegram-send-failed line reads red (failure dot) and names the status", () => {
  const row = humanizeHostLine(raw({ event: "telegram-send-failed", status: 429, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "host");
  assert.equal(row.message, "Telegram send failed (429)");
  assert.equal(row.dot, "failure");
});

test("a registry-register-failed line reads red (failure dot) and names the error, project actor", () => {
  const row = humanizeHostLine(raw({ event: "registry-register-failed", project: "alpha", error: "EACCES", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "alpha");
  assert.equal(row.message, "registration failed: EACCES");
  assert.equal(row.dot, "failure");
});

// The red rule tracks `isNotableHostEvent` (a fail/error kind, a non-null `error`, or
// `ok:false`), so even a host kind with no purpose-built line still paints red — it dumps
// the raw source on a failure dot rather than a neutral one, keeping failures visible.
test("an unrecognized but notable host kind still paints red, dumping its raw source", () => {
  const kind = humanizeHostLine(raw({ event: "gateway-poll-error", token: "t", error: "boom", ts: "2026-08-28T12:00:00.000Z" }));
  assert.equal(kind.dot, "failure");
  assert.equal(kind.message, raw({ event: "gateway-poll-error", token: "t", error: "boom", ts: "2026-08-28T12:00:00.000Z" }));
  const okFalse = humanizeHostLine(raw({ event: "gateway-thing", ok: false, ts: "2026-08-28T12:00:00.000Z" }));
  assert.equal(okFalse.dot, "failure");
});

// The fallback contract mirrors humanizeLogLine: an unknown, non-notable kind (or an
// unparseable line) is never a blank row — it dumps the raw source on a neutral dot.
test("an unknown, non-notable host kind falls back to a neutral raw dump", () => {
  const line = raw({ event: "gateway-heartbeat", detail: "ok", ts: "2026-08-28T12:00:00.000Z" });
  const row = humanizeHostLine(line);
  assert.equal(row.time, "12:00:00");
  assert.equal(row.message, line);
  assert.equal(row.dot, "neutral");
});

test("an unparseable host line dumps its raw text on a neutral dot, no crash", () => {
  const row = humanizeHostLine("}{ not json");
  assert.equal(row.time, "");
  assert.equal(row.actor, "");
  assert.equal(row.message, "}{ not json");
  assert.equal(row.dot, "neutral");
});
