// Tests for the dashboard's live surfaces — the live-update stream's appended-event reader and
// machine-noise filter (dashboard-live-tail.ts). `buildLiveTail` is tested in live-tail.test.ts.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendedEvents, tailEventLog, viewRelevantEvents } from "./dashboard-live-tail.ts";
import { event, readEventLog, type OrchestratorEvent } from "./event-log.ts";

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

// What `readEventLog` — the single parse site — returns for the same text, read off a real file.
function readEventLogOf(content: string): OrchestratorEvent[] {
  const dir = mkdtempSync(join(tmpdir(), "live-tail-"));
  const logFile = join(dir, "orchestrator.jsonl");
  writeFileSync(logFile, content);
  try {
    return readEventLog({ logFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("appendedEvents translates a legacy row exactly as readEventLog does", () => {
  const log = '{"event":"parked","reason":"blocked","taskId":"1"}\n';
  const { events } = appendedEvents(log, 0);
  assert.equal((events[0] as { reason?: string }).reason, "question");
  assert.deepEqual(events, readEventLogOf(log));
});

test("appendedEvents fans out a legacy row into the same multiple rows readEventLog does", () => {
  const log = '{"ts":"2026-01-01T00:00:00Z","event":"queue-start","taskIds":["1","2"]}\n';
  const { events } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["spawn", "spawn"],
  );
  assert.deepEqual(events, readEventLogOf(log));
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

const row = (e: unknown) => JSON.stringify(e) + "\n";
const tailLogFile = () => join(mkdtempSync(join(tmpdir(), "vetinari-tail-")), "orchestrator.jsonl");

test("tailEventLog reads only the bytes appended past its byte offset", () => {
  const file = tailLogFile();
  writeFileSync(
    file,
    row(event("campaign-start", { waves: [["101"]], slots: 1 })) +
      row(event("turn", { taskId: "101", turn: 0, summary: "é—✓" })) +
      row(event("spawn", { taskId: "101" })),
  );

  const first = tailEventLog(file, { offset: 0, ino: 0 });
  assert.deepEqual(
    first.events.map((e) => e.event),
    ["campaign-start", "turn", "spawn"],
  );
  assert.equal(first.at.offset, statSync(file).size);

  appendFileSync(file, row(event("turn", { taskId: "101", turn: 1, summary: "next" })));
  const reads: string[] = [];
  const real = fs.readFileSync;
  const spy = mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    reads.push(String(path));
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  let next: ReturnType<typeof tailEventLog>;
  try {
    next = tailEventLog(file, first.at);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(
    next.events.map((e) => [e.event, (e as { summary?: string }).summary]),
    [["turn", "next"]],
  );
  assert.equal(next.at.offset, statSync(file).size);
  assert.deepEqual(
    reads.filter((p) => p === file),
    [],
  );
});

test("tailEventLog leaves a partial trailing line for the next read", () => {
  const file = tailLogFile();
  writeFileSync(file, row(event("campaign-start", { waves: [["101"]], slots: 1 })));
  const { at } = tailEventLog(file, { offset: 0, ino: 0 });
  const line = row(event("turn", { taskId: "101", turn: 0, summary: "é—✓" }));
  // Cut mid-way through the multi-byte summary, so the partial line ends mid-character.
  const bytes = Buffer.from(line);
  const cut = Buffer.byteLength(line.slice(0, line.indexOf("—"))) + 1;
  appendFileSync(file, bytes.subarray(0, cut));

  const partial = tailEventLog(file, at);
  assert.deepEqual(partial.events, []);
  assert.deepEqual(partial.at, at);

  appendFileSync(file, bytes.subarray(cut));
  const done = tailEventLog(file, partial.at);
  assert.deepEqual(
    done.events.map((e) => [e.event, (e as { summary?: string }).summary]),
    [["turn", "é—✓"]],
  );
  assert.equal(done.at.offset, statSync(file).size);
});

test("tailEventLog reads a truncated or replaced log from its start", () => {
  const file = tailLogFile();
  writeFileSync(
    file,
    row(event("campaign-start", { waves: [["101"]], slots: 1 })) +
      row(event("spawn", { taskId: "101" })) +
      row(event("spawn", { taskId: "102" })),
  );
  const { at } = tailEventLog(file, { offset: 0, ino: 0 });

  // Truncated to a shorter log, in place.
  writeFileSync(file, row(event("campaign-start", { waves: [["201"]], slots: 1 })));
  const truncated = tailEventLog(file, at);
  assert.deepEqual(
    truncated.events.map((e) => e.event),
    ["campaign-start"],
  );

  // Moved aside (as `archiveRun` does) and recreated longer than the old file.
  renameSync(file, file + ".archived");
  writeFileSync(
    file,
    row(event("campaign-start", { waves: [["301"]], slots: 1 })) +
      row(event("spawn", { taskId: "301" })) +
      row(event("turn", { taskId: "301", turn: 0, summary: "a longer row than any before it" })),
  );
  const replaced = tailEventLog(file, truncated.at);
  assert.deepEqual(
    replaced.events.map((e) => e.event),
    ["campaign-start", "spawn", "turn"],
  );
  assert.equal(replaced.at.offset, statSync(file).size);
});

test("tailEventLog yields nothing and a zero position for a missing log", () => {
  assert.deepEqual(tailEventLog(join(tmpdir(), `vetinari-tail-none-${Date.now()}.jsonl`), { offset: 9, ino: 9 }), {
    events: [],
    at: { offset: 0, ino: 0 },
  });
});

/** Run `fn` with `fs[name]` replaced by `impl`, restoring it (and the ESM bindings) after. */
function withFsSpy<K extends "openSync" | "readSync" | "closeSync", T>(
  name: K,
  impl: (typeof fs)[K],
  fn: (spy: ReturnType<typeof mock.method>) => T,
): T {
  const spy = mock.method(fs, name, impl);
  syncBuiltinESMExports();
  try {
    return fn(spy as unknown as ReturnType<typeof mock.method>);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

test("tailEventLog yields nothing and keeps its position when the log vanishes before it is opened", () => {
  const file = tailLogFile();
  writeFileSync(file, row(event("campaign-start", { waves: [["101"]], slots: 1 })));
  const { at } = tailEventLog(file, { offset: 0, ino: 0 });
  appendFileSync(file, row(event("spawn", { taskId: "101" })));

  const result = withFsSpy(
    "openSync",
    (() => {
      throw enoent();
    }) as typeof fs.openSync,
    () => tailEventLog(file, at),
  );

  assert.deepEqual(result, { events: [], at });
});

test("tailEventLog yields nothing, keeps its position and closes the log when a read fails", () => {
  const file = tailLogFile();
  writeFileSync(file, row(event("campaign-start", { waves: [["101"]], slots: 1 })));
  const { at } = tailEventLog(file, { offset: 0, ino: 0 });
  appendFileSync(file, row(event("spawn", { taskId: "101" })));

  const opened: number[] = [];
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;
  const { result, closed } = withFsSpy(
    "openSync",
    ((...a: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...a);
      opened.push(fd);
      return fd;
    }) as typeof fs.openSync,
    () =>
      withFsSpy(
        "readSync",
        (() => {
          throw enoent();
        }) as typeof fs.readSync,
        () =>
          withFsSpy("closeSync", ((fd: number) => realClose(fd)) as typeof fs.closeSync, (close) => ({
            result: tailEventLog(file, at),
            closed: close.mock.calls.map((c) => c.arguments[0]),
          })),
      ),
  );

  assert.deepEqual(result, { events: [], at });
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened);
});
