import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentStreamEvent, LoggingOption } from "@ai-hero/sandcastle";
import type { OrchestratorEvent, SandboxExecEvent, ToolEvent } from "./event-log.ts";

/** The activity-stream rows the raw-run-stream projector produces (ADR 0015). */
export type ProjectedEvent = ToolEvent | SandboxExecEvent;

/** The live-only, per-task structured activity stream the live-tail pane tails (ADR 0015, #124):
 * one stamped JSON event per line. A sibling of the runner's human-readable `agent-<taskId>.log`. */
export const activityLogPath = (stateDir: string, taskId: string): string => `${stateDir}/logs/activity-${taskId}.jsonl`;

/** The runner's human-readable per-task transcript (the one the campaign tells you to `tail -f`). We
 * pin its path explicitly at the `sbx.run` call site so the JSONL sink is purely additive alongside it. */
export const agentLogPath = (stateDir: string, taskId: string): string => `${stateDir}/logs/agent-${taskId}.log`;

/** Start a task's activity stream: ensure the logs dir exists and truncate the file to empty. The
 * stream is live-only scratch, overwritten per run and never archived, so each run starts fresh. */
export function initActivityLog(stateDir: string, taskId: string): void {
  const file = activityLogPath(stateDir, taskId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
}

/** Append one activity event as a JSONL line to the task's stream. */
export function appendActivity(stateDir: string, taskId: string, ev: OrchestratorEvent): void {
  appendFileSync(activityLogPath(stateDir, taskId), `${JSON.stringify(ev)}\n`);
}

/**
 * The `logging` sink to hand `sbx.run(...)` for a task (ADR 0015). It keeps the runner's
 * human-readable transcript at its usual `agent-<taskId>.log` path (so the `tail -f` hint is
 * unchanged) and *additionally* forwards each `raw` stream line through the projector, appending the
 * per-tool-use activity events to `activity-<taskId>.jsonl` as they happen. Callback errors are
 * swallowed by the runner, so a malformed line can never fault a run.
 */
export function activityLoggingSink(stateDir: string, taskId: string): LoggingOption {
  return {
    type: "file",
    path: agentLogPath(stateDir, taskId),
    onAgentStreamEvent: (e: AgentStreamEvent) => {
      if (e.type !== "raw") return;
      for (const ev of projectRawLine(e.line, taskId, e.timestamp.toISOString())) appendActivity(stateDir, taskId, ev);
    },
  };
}

/** The tools whose activity we recover from the raw stream. `Bash` becomes a `sandbox-exec`; the rest
 * are file ops projected to `tool`. A `tool_use` for any other name (e.g. `WebFetch`, an MCP tool) is
 * not projected — it carries no path/command we render in the file-and-shell activity view. */
const FILE_OP_TOOLS = new Set(["Read", "Edit", "Write", "Grep", "Glob"]);

/** The byte count a file op wrote, from whichever content field its input carries: `content` for a
 * Write, `new_string` for an Edit. Reads and searches carry no written content, so they have no size. */
const writtenSize = (input: Record<string, unknown>): number | undefined => {
  const body = input.content ?? input.new_string;
  return typeof body === "string" ? Buffer.byteLength(body) : undefined;
};

/**
 * Project one raw agent-stream line into the activity events it represents.
 *
 * The line is a Claude Code `--output-format stream-json` object; an `assistant`
 * message's `content` may hold text and one-or-more `tool_use` blocks. We recover
 * the file-op tools (Read/Edit/Write/Grep/Glob) the runner's typed tool event drops
 * and the `Bash` calls, stamping each with `taskId` and `ts`. Pure — no clock, no I/O
 * — so it is unit-testable off a fixture line (ADR 0015). A line with no projectable
 * tool-use (plain text, a non-assistant row, or unparseable) yields `[]`.
 */
export function projectRawLine(line: string, taskId: string, ts: string): ProjectedEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || obj.type !== "assistant" || !Array.isArray(obj.message?.content)) return [];

  const events: ProjectedEvent[] = [];
  for (const block of obj.message.content) {
    if (!block || block.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;

    if (block.name === "Bash") {
      const cmd = input.command;
      if (typeof cmd !== "string") continue;
      const pid = typeof input.pid === "number" ? input.pid : undefined;
      events.push({ event: "sandbox-exec", taskId, ts, cmd, ...(pid !== undefined ? { pid } : {}) });
      continue;
    }

    if (FILE_OP_TOOLS.has(block.name)) {
      const path = input.file_path ?? input.path;
      const size = writtenSize(input);
      events.push({
        event: "tool",
        taskId,
        ts,
        name: block.name,
        ...(typeof path === "string" ? { path } : {}),
        ...(size !== undefined ? { size } : {}),
      });
    }
  }
  return events;
}
