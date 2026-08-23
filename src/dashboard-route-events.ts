import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { listProjects } from "./registry.ts";
import { appendedEvents, logFileOf } from "./dashboard-model.ts";
import { log } from "./log.ts";
import type { RouteHandler } from "./dashboard-http.ts";

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

  const readLog = (logFile: string): string => {
    try {
      return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    } catch {
      return "";
    }
  };

  const push = (project: string, logFile: string) => {
    // A watch callback can fire in the gap between the client disconnecting and the
    // watchers closing; never write to an already-ended response.
    if (res.writableEnded) return;
    const { events, offset } = appendedEvents(readLog(logFile), offsets.get(project) ?? 0);
    offsets.set(project, offset);
    if (events.length) res.write(`data: ${JSON.stringify({ project, events })}\n\n`);
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
    res.end();
  });
  return true;
};
