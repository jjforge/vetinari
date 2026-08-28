/**
 * The shared log-view component's humanizer (#203). One log surface — the live tail
 * today, the feed / host-log / archived-run log as its siblings adopt it — renders every
 * JSONL line two ways: humanized-by-default (`time · actor · what happened`, a
 * state-coloured dot) and, behind a per-view Raw toggle, the highlighted NDJSON. This
 * module owns the humanized half.
 *
 * `humanizeLogLine` is the registry: a `switch` on the row's `event` kind. It runs
 * server-side — `buildLiveTail` humanizes each line as it builds the tail snapshot and ships
 * the parts down with the raw text, so the client renders pre-humanized rows and keeps the
 * raw NDJSON for the toggle and the download. Running server-side lets the run-level kinds
 * narrate straight through the feed's `describeEvent` (`dashboard-model.ts`), so the two
 * surfaces say the same words with no duplicated vocabulary. A kind the registry does not
 * know renders a one-line raw dump, never a blank row.
 */
import { describeEvent } from "./dashboard-model.ts";
import type { OrchestratorEvent } from "./event-log.ts";

/**
 * The dot state a humanized row carries — the event's own state, from the ADR-0007 /
 * comms vocabulary collapsed to the five colours the log view paints: `running` (blue,
 * in-flight work), `merged` (green, a success), `failure` (red), `parked` (amber, a held
 * attention state), and `neutral` (dim, everything else). `logDotState` maps each back to
 * a `stateColor` token for the CSS.
 */
export type LogDotState = "running" | "merged" | "failure" | "parked" | "neutral";

/**
 * Each painted dot state → the ADR-0007 status token `stateColor` keys off (dashboard-assets.ts),
 * so the log-view dot CSS is generated from the one palette, never a per-instance hex (§1). Kept
 * here beside the states it maps so the humanizer and its colours move together; the chrome that
 * owns `stateColor` folds this into the CSS.
 */
export const LOG_DOT_STATE_COLOR: Record<LogDotState, string> = {
  running: "running",
  merged: "completed",
  failure: "failure",
  parked: "parked",
  neutral: "unstarted",
};

/** One humanized log row: the shipped-verbatim shape `humanizeLogLine` returns. `time` is
 * the `HH:MM:SS` slice of the row's ISO `ts` (UTC, matching the raw pane's verbatim stamps),
 * `actor` the `#issue` (or `host`, or "") the line is about, `message` the `what happened`
 * prose, and `dot` the state colour. */
export interface HumanizedRow {
  time: string;
  actor: string;
  message: string;
  dot: LogDotState;
}

/**
 * Humanize one raw JSONL log line into its `time · actor · what happened` parts. The
 * registry, keyed on the parsed row's `event` — the run-level kinds narrate through
 * `describeEvent` so the wording can't drift from the feed. An unparseable line, a row with
 * no string `event`, or an unknown kind falls back to a one-line raw dump — the trimmed
 * source text, a neutral dot — never a blank row.
 */
export function humanizeLogLine(raw: string): HumanizedRow {
  let e: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") e = parsed as Record<string, unknown>;
  } catch {
    e = null;
  }
  const time = e && typeof e.ts === "string" ? (/T(\d{2}:\d{2}:\d{2})/.exec(e.ts)?.[1] ?? "") : "";
  const hash = (id: unknown) => "#" + String(id).replace(/^#/, "");
  const actorOf = (id: unknown) => (id === undefined || id === null || id === "" ? "" : hash(id));
  const fallback = (): HumanizedRow => ({ time, actor: e ? actorOf(e.taskId) : "", message: raw.trim(), dot: "neutral" });
  if (!e || typeof e.event !== "string") return fallback();
  switch (e.event) {
    case "tool": {
      const size = typeof e.size === "number" ? " (" + e.size + " bytes)" : "";
      return { time, actor: actorOf(e.taskId), message: String(e.name) + (e.path ? " " + String(e.path) : "") + size, dot: "running" };
    }
    case "sandbox-exec":
      return { time, actor: actorOf(e.taskId), message: "$ " + String(e.cmd), dot: "running" };
    case "commit": {
      const files = Array.isArray(e.files) ? e.files.length : 0;
      const sha = typeof e.sha === "string" ? e.sha.slice(0, 7) : "";
      return { time, actor: actorOf(e.taskId), message: "committed " + sha + " · " + files + " file" + (files === 1 ? "" : "s"), dot: "running" };
    }
    case "gate": {
      const n = Array.isArray(e.cmds) ? e.cmds.length : 0;
      return { time, actor: actorOf(e.taskId), message: "gate — " + n + " check" + (n === 1 ? "" : "s"), dot: "running" };
    }
    case "gate-result": {
      const ok = e.exitCode === 0;
      return { time, actor: actorOf(e.taskId), message: String(e.cmd) + " → " + (ok ? "passed" : "exit " + e.exitCode) + " (" + e.seconds + "s)", dot: ok ? "merged" : "failure" };
    }
    case "turn": {
      const summary = typeof e.summary === "string" ? e.summary.trim() : "";
      return { time, actor: actorOf(e.taskId), message: summary || "turn " + (e.turn ?? "?"), dot: "running" };
    }
    case "green":
      return { time, actor: actorOf(e.taskId), message: "merged", dot: "merged" };
    case "parked":
      return { time, actor: actorOf(e.taskId), message: "parked" + (e.reason ? ": " + String(e.reason) : ""), dot: "parked" };
    case "quarantined":
      return { time, actor: actorOf(e.taskId), message: "quarantined — resolve the conflict", dot: "parked" };
    // Run-level campaign/wave kinds — no per-issue actor; the message is single-sourced from
    // `describeEvent` so the log view and the feed narrate them identically, and the dot reads
    // the comms colour (a success green, a halt red, a wave-parked amber, a start blue).
    case "campaign-batch-done":
    case "campaign-done":
    case "queue-done":
      return { time, actor: "", message: describeEvent(e as unknown as OrchestratorEvent), dot: "merged" };
    case "campaign-halt":
      return { time, actor: "", message: describeEvent(e as unknown as OrchestratorEvent), dot: "failure" };
    case "wave-parked":
      return { time, actor: "", message: describeEvent(e as unknown as OrchestratorEvent), dot: "parked" };
    case "campaign-start":
    case "campaign-batch":
    case "queue-start":
      return { time, actor: "", message: describeEvent(e as unknown as OrchestratorEvent), dot: "running" };
    case "carve":
    case "graft":
    case "telegram-unconfigured":
      return { time, actor: "", message: describeEvent(e as unknown as OrchestratorEvent), dot: "neutral" };
    default:
      return fallback();
  }
}
