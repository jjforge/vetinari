import test from "node:test";
import assert from "node:assert/strict";
import { humanizeHostLine, humanizeLogLine, LOG_DOT_STATE_COLOR, plainText, splitOverflow, type MessageSpan } from "./log-view.ts";
import { event } from "./event-log.ts";
import { describeEvent } from "./dashboard-model.ts";

// The row `time` renders in the host's LOCAL timezone (#239), matching the archived-run header.
// Pin the process TZ to PDT (UTC−7 in August) so the local slice is deterministic and visibly
// differs from the UTC ISO stamp — a `…T14:01:23Z` line reads `07:01:23` local, not `14:01:23`.
process.env.TZ = "America/Los_Angeles";

const raw = (e: object) => JSON.stringify(e);
const p = (text: string): MessageSpan => ({ text, kind: "plain" });
const code = (text: string): MessageSpan => ({ text, kind: "code" });
const strong = (text: string): MessageSpan => ({ text, kind: "strong" });

// The humanizer registry (#203, finished #216): one JSONL activity line → its structured
// humanized parts — `time`, the `actor` that leads the message (option 1a), a dim `verb`,
// and the message `spans` (plain prose, `code` tokens for ids/paths/shas, `strong` for the
// key term), plus the state-coloured dot. Keyed on the event kind; every shipped kind
// renders a purpose-built shape, an unknown kind falls back to a one-line raw dump.

test("a tool event humanizes to `edited` + a code-styled path, running dot", () => {
  const row = humanizeLogLine(raw(event("tool", { taskId: "204", name: "Edit", path: "src/x.ts", ts: "2026-08-28T14:01:23.000Z" })));
  assert.equal(row.time, "07:01:23");
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "edited");
  assert.deepEqual(row.spans, [code("src/x.ts")]);
  assert.equal(row.dot, "running");
});

test("a tool event with a byte size appends it; a pathless tool names the tool as the key term", () => {
  const wrote = humanizeLogLine(raw(event("tool", { taskId: "9", name: "Write", path: "a.ts", size: 128, ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(wrote.verb, "edited");
  assert.deepEqual(wrote.spans, [code("a.ts"), p(" (128 bytes)")]);
  const search = humanizeLogLine(raw(event("tool", { taskId: "9", name: "Grep", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(search.verb, "ran");
  assert.deepEqual(search.spans, [strong("Grep")]);
});

test("a sandbox-exec event humanizes to `ran` + a code-styled command, running dot", () => {
  const row = humanizeLogLine(raw(event("sandbox-exec", { taskId: "204", cmd: "npm test", ts: "2026-08-28T09:15:00.000Z" })));
  assert.equal(row.time, "02:15:00");
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "ran");
  assert.deepEqual(row.spans, [code("npm test")]);
  assert.equal(row.dot, "running");
});

test("a commit event reads `committed` + a code-styled short sha and file count, running dot", () => {
  const one = humanizeLogLine(raw(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["src/x.ts"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(one.verb, "committed");
  assert.deepEqual(one.spans, [code("abcdef1"), p(" · 1 file")]);
  assert.equal(one.dot, "running");
  const many = humanizeLogLine(raw(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["a", "b"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.deepEqual(many.spans, [code("abcdef1"), p(" · 2 files")]);
});

test("a gate-result event reads `gate passed` green and `gate failed` red, code-styled cmd", () => {
  const pass = humanizeLogLine(raw(event("gate-result", { taskId: "204", cmd: "npm test", exitCode: 0, seconds: 12, outFile: "o", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(pass.verb, "gate passed");
  assert.deepEqual(pass.spans, [code("npm test"), p(" (12s)")]);
  assert.equal(pass.dot, "merged");
  const fail = humanizeLogLine(raw(event("gate-result", { taskId: "204", cmd: "npm test", exitCode: 1, seconds: 3, outFile: "o", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(fail.verb, "gate failed");
  assert.deepEqual(fail.spans, [code("npm test"), p(" — exit 1 (3s)")]);
  assert.equal(fail.dot, "failure");
});

test("a gate event reads `gate` + how many checks it selected as the key term, running dot", () => {
  const row = humanizeLogLine(raw(event("gate", { taskId: "204", cmds: ["a", "b"], skipped: 1, ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.verb, "gate");
  assert.deepEqual(row.spans, [p("— "), strong("2 checks")]);
  assert.equal(row.dot, "running");
});

// Per-issue outcome kinds: the actor is split out to `#issue`, the verb leads the message,
// and the dot reads the outcome's colour.
test("a turn event reads `turn N` + the agent summary as the strong key term, running dot", () => {
  const row = humanizeLogLine(raw(event("turn", { taskId: "204", turn: 3, summary: "Wired the humanizer registry", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "turn 3");
  assert.deepEqual(row.spans, [strong("Wired the humanizer registry")]);
  assert.equal(row.dot, "running");
  // A pre-summary turn carries the verb alone, no message spans.
  const bare = humanizeLogLine(raw(event("turn", { taskId: "204", turn: 3, summary: "", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(bare.verb, "turn 3");
  assert.deepEqual(bare.spans, []);
});

test("a green event reads verb `merged` (green dot), #issue actor, no spans", () => {
  const row = humanizeLogLine(raw(event("green", { taskId: "204", branch: "agent/204", commits: ["a"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "merged");
  assert.deepEqual(row.spans, []);
  assert.equal(row.dot, "merged");
});

test("a parked event reads verb `parked` amber with its reason as the strong key term", () => {
  const row = humanizeLogLine(raw(event("parked", { taskId: "204", reason: "question", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "parked");
  assert.deepEqual(row.spans, [p(": "), strong("question")]);
  assert.equal(row.dot, "parked");
});

test("a quarantined event reads as a parked (amber) merge-conflict hold, not the retired word (ADR 0019)", () => {
  // An archived line in the retired `quarantined` name still humanizes: the alias table
  // normalizes it to `parked{conflict}` before the switch, so a legacy raw line renders the
  // same amber merge-conflict hold as the live `parked` name (design §13.2).
  const row = humanizeLogLine(raw({ event: "quarantined", taskId: "204", branch: "agent/204", detail: "conflict", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "parked");
  assert.deepEqual(row.spans, [p("— merge conflict, resolve it")]);
  assert.equal(row.dot, "parked");
});

// Run-level campaign/wave kinds: no per-issue actor, no verb, and the message is a single
// plain span single-sourced from `describeEvent` so the log view and the feed narrate them
// with identical words. The dot reads the comms colour.
test("run-level kinds narrate through describeEvent verbatim as one plain span, no actor, no verb", () => {
  const cases = [
    event("campaign-start", { waves: [["1"]], slots: 1, name: "Ship it", ts: "2026-08-28T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["1", "2"], ts: "2026-08-28T00:00:00.000Z" }),
    event("wave-done", { index: 0, merged: ["1"], held: [], clearedParked: [], ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-done", { waves: 2, ts: "2026-08-28T00:00:00.000Z" }),
    event("campaign-parked", { index: 0, detail: "red", ts: "2026-08-28T00:00:00.000Z" }),
    event("prune", { target: "5", removed: ["5", "6"], dropped: ["6"], ts: "2026-08-28T00:00:00.000Z" }),
    event("graft", { ids: ["9"], blockedBy: {}, basenames: {}, ts: "2026-08-28T00:00:00.000Z" }),
  ];
  for (const e of cases) {
    const row = humanizeLogLine(raw(e));
    assert.equal(row.actor, "", `${e.event} is run-level, no actor`);
    assert.equal(row.verb, "", `${e.event} run-level narration carries no verb`);
    assert.deepEqual(row.spans, [{ text: describeEvent(e), kind: "plain" }], `${e.event} narration matches describeEvent`);
  }
});

test("run-level dot colours: success→merged, campaign-parked→parked, start→running, prune→neutral", () => {
  const dot = (e: object) => humanizeLogLine(raw(e)).dot;
  assert.equal(dot(event("wave-done", { index: 0, merged: ["1"], held: [], clearedParked: [], ts: "2026-08-28T00:00:00.000Z" })), "merged");
  assert.equal(dot(event("campaign-done", { waves: 1, ts: "2026-08-28T00:00:00.000Z" })), "merged");
  assert.equal(dot(event("campaign-parked", { index: 0, detail: "d", ts: "2026-08-28T00:00:00.000Z" })), "parked");
  assert.equal(dot(event("campaign-start", { waves: [], slots: 1, ts: "2026-08-28T00:00:00.000Z" })), "running");
  assert.equal(dot(event("prune", { target: "5", removed: ["5"], dropped: [], ts: "2026-08-28T00:00:00.000Z" })), "neutral");
});

// The fallback contract (#221): an unknown kind never dumps raw JSON — it renders a readable
// generic summary, the event kind (hyphens→spaces, the strong key term) followed by its salient
// scalar fields in prose (`· key value`, the value a code token), on a neutral dot with no verb,
// keeping its time and any actor it named.
test("an unknown event kind renders a readable generic summary, never a raw JSON dump", () => {
  const line = raw({ event: "host-heartbeat", taskId: "204", detail: "ok", ts: "2026-08-28T12:00:00.000Z" });
  const row = humanizeLogLine(line);
  assert.equal(row.time, "05:00:00");
  assert.equal(row.actor, "#204");
  assert.equal(row.verb, "");
  assert.deepEqual(row.spans, [strong("host heartbeat"), p(" · detail "), code("ok")]);
  assert.equal(row.dot, "neutral");
  // No rendered span is the raw JSON object.
  assert.ok(!plainText(row).includes(line), "the raw JSON is never rendered");
});

test("a generic summary skips object/array fields and reads its scalar fields in prose", () => {
  const row = humanizeLogLine(raw({ event: "status-archive-skipped", file: "/runs/x.jsonl", extras: { a: 1 }, ids: ["7"], ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.verb, "");
  // The kind leads as the strong term; only the scalar `file` field follows — the nested
  // object and the array are dropped so the line stays readable, never a raw dump.
  assert.deepEqual(row.spans, [strong("status archive skipped"), p(" · file "), code("/runs/x.jsonl")]);
  assert.equal(row.dot, "neutral");
});

test("an unparseable line dumps its raw text as a plain span, no crash, never blank", () => {
  const row = humanizeLogLine("}{ not json");
  assert.equal(row.time, "");
  assert.equal(row.actor, "");
  assert.equal(row.verb, "");
  assert.deepEqual(row.spans, [{ text: "}{ not json", kind: "plain" }]);
  assert.equal(row.dot, "neutral");
  assert.ok(plainText(row).length > 0, "the raw dump is never a blank row");
});

// plainText flattens a structured row back to a single string (verb + span texts) — the
// filter/title/accessibility fallback the client and tests read when they need flat text.
test("plainText flattens verb + spans to a single readable string", () => {
  const commit = humanizeLogLine(raw(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["a"], ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(plainText(commit), "committed abcdef1 · 1 file");
  const edit = humanizeLogLine(raw(event("tool", { taskId: "204", name: "Edit", path: "src/x.ts", ts: "2026-08-28T00:00:00.000Z" })));
  assert.equal(plainText(edit), "edited src/x.ts");
});

// splitOverflow (#217) is the pure first-line/overflow split the collapsed log-view row keys
// off: a message whose rendered content is more than one line shows only its first line, and
// its remainder unfolds behind the expand chevron. The split happens on the structured spans
// so the first line keeps its code/strong styling; the overflow is raw text (the mono block).

test("splitOverflow leaves a single-line message untouched, with no overflow", () => {
  const spans: MessageSpan[] = [code("npm test"), p(" (12s)")];
  const out = splitOverflow(spans);
  assert.deepEqual(out.spans, spans);
  assert.equal(out.overflow, "");
});

test("splitOverflow keeps only the first line's spans and returns the remainder as raw overflow", () => {
  const out = splitOverflow([strong("Boom: it broke"), p("\nline two\nline three")]);
  // The first line is everything up to the first newline, spans and styling preserved.
  assert.deepEqual(out.spans, [strong("Boom: it broke")]);
  // The remainder (after that newline) is the raw mono overflow block, later lines intact.
  assert.equal(out.overflow, "line two\nline three");
});

test("splitOverflow splits inside a span, keeping the head styled and the tail in overflow", () => {
  const out = splitOverflow([strong("first line\nsecond line\nthird")]);
  assert.deepEqual(out.spans, [strong("first line")]);
  assert.equal(out.overflow, "second line\nthird");
});

test("splitOverflow concatenates every span after the break into the raw overflow", () => {
  const out = splitOverflow([p("head\ntail-a "), code("path/x"), p(" done")]);
  assert.deepEqual(out.spans, [p("head")]);
  assert.equal(out.overflow, "tail-a path/x done");
});

test("splitOverflow treats a trailing newline with no content after it as single-line", () => {
  const out = splitOverflow([p("only line\n")]);
  assert.deepEqual(out.spans, [p("only line")]);
  assert.equal(out.overflow, "");
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
// for the host surface — the same structured parts, keyed on the host-kind `event`.
// Self-contained (no `describeEvent`) so it ships into the host-log client via `.toString()`
// and humanizes the fetched window and each live frame in-browser.

test("a gateway-routed line reads verb `routed` + code category → destination, project actor, neutral dot", () => {
  const row = humanizeHostLine(raw({ event: "gateway-routed", project: "alpha", id: "12", category: "question", destination: "telegram", ts: "2026-08-28T14:01:23.000Z" }));
  assert.equal(row.time, "07:01:23");
  assert.equal(row.actor, "alpha");
  assert.equal(row.verb, "routed");
  assert.deepEqual(row.spans, [code("question"), p(" → "), code("telegram")]);
  assert.equal(row.dot, "neutral");
});

test("a gateway-announced line reads verb `announced` + a code-styled #task, project actor, neutral dot", () => {
  const row = humanizeHostLine(raw({ event: "gateway-announced", project: "beta", task: "204", messageId: 7, ts: "2026-08-28T09:15:00.000Z" }));
  assert.equal(row.actor, "beta");
  assert.equal(row.verb, "announced");
  assert.deepEqual(row.spans, [code("#204")]);
  assert.equal(row.dot, "neutral");
});

test("a gateway-start line reads verb `gateway up` with its bot count, host actor, neutral dot", () => {
  const up = humanizeHostLine(raw({ event: "gateway-start", configDir: "/cfg", bots: 2, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(up.actor, "host");
  assert.equal(up.verb, "gateway up");
  assert.deepEqual(up.spans, [p(" · 2 bots")]);
  assert.equal(up.dot, "neutral");
  // No bots yet: the count clause drops rather than reading "· 0 bots".
  const silent = humanizeHostLine(raw({ event: "gateway-start", configDir: "/cfg", bots: 0, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(silent.verb, "gateway up");
  assert.deepEqual(silent.spans, []);
});

test("a telegram-unconfigured line reads a parked (amber) warning, project actor", () => {
  const row = humanizeHostLine(raw({ event: "telegram-unconfigured", project: "alpha", baseLocation: "/a", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "alpha");
  assert.equal(plainText(row), "⚠ Telegram not configured");
  assert.equal(row.dot, "parked");
});

test("a registry-stale line reads a parked (amber) `stale registration`, project actor", () => {
  const row = humanizeHostLine(raw({ event: "registry-stale", project: "gone", baseLocation: "/x", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "gone");
  assert.equal(plainText(row), "stale registration");
  assert.equal(row.dot, "parked");
});

test("a telegram-send-failed line reads red (failure dot) and names the status", () => {
  const row = humanizeHostLine(raw({ event: "telegram-send-failed", status: 429, ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "host");
  assert.equal(row.verb, "Telegram send failed");
  assert.deepEqual(row.spans, [p(" ("), code("429"), p(")")]);
  assert.equal(row.dot, "failure");
});

test("a registry-register-failed line reads red (failure dot) and names the error, project actor", () => {
  const row = humanizeHostLine(raw({ event: "registry-register-failed", project: "alpha", error: "EACCES", ts: "2026-08-28T00:00:00.000Z" }));
  assert.equal(row.actor, "alpha");
  assert.equal(row.verb, "registration failed");
  assert.deepEqual(row.spans, [p(": "), code("EACCES")]);
  assert.equal(row.dot, "failure");
});

// The red rule tracks `isNotableHostEvent` (a fail/error kind, a non-null `error`, or
// `ok:false`), so even a host kind with no purpose-built line still paints red — it renders a
// readable generic summary on a failure dot rather than a neutral one, keeping failures visible.
test("an unrecognized but notable host kind still paints red, rendering a readable generic summary", () => {
  const line = raw({ event: "gateway-poll-error", token: "t", error: "boom", ts: "2026-08-28T12:00:00.000Z" });
  const kind = humanizeHostLine(line);
  assert.equal(kind.dot, "failure");
  assert.deepEqual(kind.spans, [strong("gateway poll error"), p(" · token "), code("t"), p(" · error "), code("boom")]);
  assert.ok(!plainText(kind).includes(line), "the raw JSON is never rendered");
  const okFalse = humanizeHostLine(raw({ event: "gateway-thing", ok: false, ts: "2026-08-28T12:00:00.000Z" }));
  assert.equal(okFalse.dot, "failure");
});

// The fallback contract mirrors humanizeLogLine (#221): an unknown, non-notable kind renders a
// readable generic summary (the kind + its salient fields in prose) on a neutral dot, never a
// raw JSON dump and never a blank row. The `project` field leads as the actor, not a field.
test("an unknown, non-notable host kind renders a readable generic summary, neutral dot", () => {
  const line = raw({ event: "gateway-heartbeat", project: "alpha", detail: "ok", ts: "2026-08-28T12:00:00.000Z" });
  const row = humanizeHostLine(line);
  assert.equal(row.time, "05:00:00");
  assert.equal(row.actor, "alpha");
  assert.deepEqual(row.spans, [strong("gateway heartbeat"), p(" · detail "), code("ok")]);
  assert.equal(row.dot, "neutral");
});

test("an unparseable host line dumps its raw text on a neutral dot, no crash", () => {
  const row = humanizeHostLine("}{ not json");
  assert.equal(row.time, "");
  assert.equal(row.actor, "");
  assert.deepEqual(row.spans, [{ text: "}{ not json", kind: "plain" }]);
  assert.equal(row.dot, "neutral");
});
