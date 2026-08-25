import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { listProjects } from "./registry.ts";
import { appendedEvents, logFileOf, viewRelevantEvents } from "./dashboard-model.ts";
import type { OrchestratorEvent } from "./event-log.ts";
import { log } from "./log.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/** The per-project SSE debounce window: view-relevant appends landing within it
 * coalesce into a single frame (~300ms — long enough to swallow an append burst,
 * short enough that a real state change still lands within a window). */
const DEBOUNCE_MS = 300;

/**
 * `GET /api/events` — the live update stream (ADR 0008). The server `fs.watch`es
 * every registered project's live-run log and, on a change, pushes the events
 * appended since this connection last read as a Server-Sent Events `data:` frame
 * carrying `{ project, events }`. It is server→client only: the client's own two
 * writes go as ordinary POSTs, so a one-way push fits and a WebSocket would be
 * unused complexity.
 *
 * Each connection starts each project's read offset at its log's current end, so
 * only what lands *after* the client connected is pushed — the initial state came
 * from the page's own first fetch. A project whose base location has moved or been
 * deleted is simply a watcher that never arms, tolerated the same way the gateway
 * tolerates a stale registration (ADR 0002); it never takes the stream down.
 *
 * Two coalescing steps sit between the watch and the wire (#131), so a busy run no
 * longer refreshes the client on every appended line: appended events are first
 * filtered through `viewRelevantEvents` (a fail-open denylist — pure machine-noise
 * like a failed Telegram send or an outbound-queue enqueue changes no rendered view,
 * so it pushes nothing), then the survivors are debounced per project into a single
 * frame per `DEBOUNCE_MS` window, so a burst of appends yields one refresh, not N.
 */
export const handleEvents: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/events")) return false;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Opening handshake: flush the headers so the client's stream opens, carry the
  // reconnect hint, and — because it runs before the watchers are armed below in
  // the same synchronous pass — guarantee a client that has seen a frame is
  // watching a live stream.
  res.write("retry: 3000\n: connected\n\n");

  const watchers: FSWatcher[] = [];
  // Per-project character offset into its live log — where this connection last read.
  const offsets = new Map<string, number>();
  // The debounce buffers: the view-relevant events collected for a project since its last
  // flush, and the pending timer that will flush them as one frame.
  const pending = new Map<string, OrchestratorEvent[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const readLog = (logFile: string): string => {
    try {
      return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    } catch {
      return "";
    }
  };

  // Flush a project's debounced survivors as a single SSE frame. Emits nothing when the
  // response has ended or nothing view-relevant accumulated (a window of pure noise).
  const flush = (project: string) => {
    timers.delete(project);
    const events = pending.get(project) ?? [];
    pending.delete(project);
    if (res.writableEnded || !events.length) return;
    res.write(`data: ${JSON.stringify({ project, events })}\n\n`);
  };

  const push = (project: string, logFile: string) => {
    // A watch callback can fire in the gap between the client disconnecting and the
    // watchers closing; never write to an already-ended response.
    if (res.writableEnded) return;
    const { events, offset } = appendedEvents(readLog(logFile), offsets.get(project) ?? 0);
    offsets.set(project, offset);
    const relevant = viewRelevantEvents(events);
    if (!relevant.length) return;
    // Buffer the survivors and arm a single debounce timer per project; a burst of
    // appends within the window coalesces into the one frame `flush` writes.
    const buffered = pending.get(project) ?? [];
    buffered.push(...relevant);
    pending.set(project, buffered);
    if (!timers.has(project)) timers.set(project, setTimeout(() => flush(project), DEBOUNCE_MS));
  };

  for (const pointer of listProjects(deps.configDir)) {
    const logFile = logFileOf(pointer.baseLocation);
    // Seed at the current end so the backlog isn't re-pushed on connect (the page
    // already loaded it); the append itself is the "something happened" signal.
    offsets.set(pointer.project, readLog(logFile).length);
    // Watch the logs directory, not the file, so a not-yet-created log or a
    // rotation still registers. A missing base location is skipped, not fatal.
    const logsDir = dirname(logFile);
    if (!existsSync(logsDir)) continue;
    try {
      watchers.push(watch(logsDir, () => push(pointer.project, logFile)));
    } catch (e) {
      log("dashboard-events-watch-failed", { project: pointer.project, error: String(e) });
    }
  }

  req.on("close", () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    res.end();
  });
  return true;
};
