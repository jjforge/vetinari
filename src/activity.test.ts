import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityLogPath, agentLogPath, appendActivity, initActivityLog, projectRawLine } from "./activity.ts";
import { event } from "./event-log.ts";

const TS = "2026-08-27T00:00:00.000Z";
const TASK = "182";

// A single assistant stream-json line carrying one `tool_use` block.
const assistantLine = (block: unknown): string =>
  JSON.stringify({ type: "assistant", message: { content: [block] } });

test("projects a Read tool_use into a `tool` event with its name and path", () => {
  const line = assistantLine({ type: "tool_use", name: "Read", input: { file_path: "/repo/src/loop.ts" } });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "tool", taskId: TASK, ts: TS, name: "Read", path: "/repo/src/loop.ts" },
  ]);
});

test("projects an Edit tool_use into a `tool` event with a byte size from the new content", () => {
  const line = assistantLine({
    type: "tool_use",
    name: "Edit",
    input: { file_path: "/repo/src/gate.ts", old_string: "a", new_string: "hello" },
  });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "tool", taskId: TASK, ts: TS, name: "Edit", path: "/repo/src/gate.ts", size: 5 },
  ]);
});

test("projects a Write tool_use with the byte size of its content", () => {
  const line = assistantLine({ type: "tool_use", name: "Write", input: { file_path: "/repo/new.ts", content: "abcd" } });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "tool", taskId: TASK, ts: TS, name: "Write", path: "/repo/new.ts", size: 4 },
  ]);
});

test("projects a Bash tool_use into a `sandbox-exec` event carrying the command", () => {
  const line = assistantLine({ type: "tool_use", name: "Bash", input: { command: "npm test" } });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "sandbox-exec", taskId: TASK, ts: TS, cmd: "npm test" },
  ]);
});

test("projects a Grep tool_use using its `path` target (not `file_path`)", () => {
  const line = assistantLine({ type: "tool_use", name: "Grep", input: { pattern: "TODO", path: "/repo/src" } });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "tool", taskId: TASK, ts: TS, name: "Grep", path: "/repo/src" },
  ]);
});

test("projects every tool_use block in a multi-tool assistant line, dropping the text block", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "let me look and run" },
        { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  assert.deepEqual(projectRawLine(line, TASK, TS), [
    { event: "tool", taskId: TASK, ts: TS, name: "Read", path: "/a.ts" },
    { event: "sandbox-exec", taskId: TASK, ts: TS, cmd: "ls" },
  ]);
});

test("yields nothing for a text-only assistant line, a non-assistant row, or unparseable input", () => {
  assert.deepEqual(projectRawLine(assistantLine({ type: "text", text: "thinking" }), TASK, TS), []);
  assert.deepEqual(projectRawLine(JSON.stringify({ type: "result", subtype: "success" }), TASK, TS), []);
  assert.deepEqual(projectRawLine("not json {", TASK, TS), []);
  assert.deepEqual(projectRawLine("", TASK, TS), []);
});

const withStateDir = (): string => mkdtempSync(join(tmpdir(), "activity-"));

test("path helpers name a per-task activity JSONL sibling to the human-readable agent log", () => {
  assert.equal(activityLogPath(".vetinari.local", "182"), ".vetinari.local/logs/activity-182.jsonl");
  assert.equal(agentLogPath(".vetinari.local", "182"), ".vetinari.local/logs/agent-182.log");
});

test("initActivityLog creates the logs dir and truncates the activity file to empty each run", () => {
  const stateDir = withStateDir();
  initActivityLog(stateDir, TASK);
  appendActivity(stateDir, TASK, event("sandbox-exec", { taskId: TASK, cmd: "ls" }));
  assert.equal(readFileSync(activityLogPath(stateDir, TASK), "utf8").trim().split("\n").length, 1);
  // A second run of the same task starts the file fresh (live-only scratch, overwritten per run).
  initActivityLog(stateDir, TASK);
  assert.equal(readFileSync(activityLogPath(stateDir, TASK), "utf8"), "");
});

test("appendActivity writes one stamped JSON event per line, each carrying event/taskId/ts", () => {
  const stateDir = withStateDir();
  initActivityLog(stateDir, TASK);
  appendActivity(stateDir, TASK, event("tool", { taskId: TASK, name: "Read", path: "/a.ts" }));
  appendActivity(stateDir, TASK, event("commit", { taskId: TASK, branch: "agent/182", sha: "abc123", files: ["src/a.ts"] }));

  const rows = readFileSync(activityLogPath(stateDir, TASK), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.taskId, TASK);
    assert.equal(typeof r.event, "string");
    assert.equal(typeof r.ts, "string");
  }
  assert.equal(rows[0].event, "tool");
  assert.equal(rows[1].event, "commit");
  assert.deepEqual(rows[1].files, ["src/a.ts"]);
});
