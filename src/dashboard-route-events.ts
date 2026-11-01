import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { listProjects } from "./registry.ts";
import { buildLiveTail, logFileOf, statusConfigFromPointer, viewRelevantEvents } from "./dashboard-model.ts";
import { type EventLogTailAt, tailEventLog } from "./dashboard-live-tail.ts";
import type { ProjectPointer } from "./registry.ts";
import type { OrchestratorEvent } from "./event-log.ts";
import { hostLogger, hostLogTarget } from "./log.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "./dashboard-http.ts";

/** The per-project SSE debounce window: view-relevant appends landing within it
 * coalesce into a single frame (~300ms — long enough to swallow an append burst,
 * short enough that a real state change still lands within a window). */
const DEBOUNCE_MS = 300;

/** This host route's own logger — a watcher failing to arm is a host-registry
 * diagnostic (no per-project run scope), so it emits to the host log target, not
 * the process-global. The `RouteHandler` signature is fixed, so it can't be
 * handed one; it constructs its own, exactly as the other host readers default to. */
const logger = hostLogger();

/** The most live-update connections open at once in a dashboard process. Each one arms
 * its own watchers and re-reads every appended-to log, so an unbounded count (many tabs,
 * a misbehaving client) multiplies that work without limit; past the cap a connection is
 * refused with `503`. Fixed, not configurable. */
export const MAX_EVENT_CONNECTIONS = 16;

/** The live-update connections currently open — process-wide, since a process runs one
 * dashboard server. Counted from admission until the request's `close`. */
let openEventConnections = 0;

/**
 * Admit a live-update connection under the one cap both `/api/events` and `/api/v1/events` share,
 * or refuse it with `503` and return false. A refusal goes out before any SSE header, so a refused
 * client never sees a `200`, and neither takes nor frees a slot. An admitted connection's slot is
 * released on the request's `close` however the handler exits — registered here, before any work
 * that can throw — and `teardown` closes whatever the handler set up by then. `once`, so a repeated
 * `close` can't release the slot twice and drift the count below the connections actually open.
 */
const admitEventConnection = (req: IncomingMessage, res: ServerResponse, teardown: () => void): boolean => {
  if (openEventConnections >= MAX_EVENT_CONNECTIONS) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(`too many live-update connections (max ${MAX_EVENT_CONNECTIONS})`);
    return false;
  }
  openEventConnections++;
  req.once("close", () => {
    openEventConnections--;
    teardown();
    res.end();
  });
  return true;
};

// A log's current end — its byte size and inode — or `{ 0, 0 }` when it doesn't exist yet.
const logEndOf = (logFile: string): EventLogTailAt => {
  try {
    const { size, ino } = statSync(logFile);
    return { offset: size, ino };
  } catch {
    return { offset: 0, ino: 0 };
  }
};

/**
 * One connection's per-project read of the live logs: where it last read each log (its byte
 * offset and inode, so a replaced or truncated log is read from its start), and the debounce that
 * coalesces each project's `viewRelevantEvents` survivors into one frame per `DEBOUNCE_MS` window.
 * `frame` renders a project's window of survivors as the SSE frame `flush` writes. `seed` starts a
 * project at its log's current end; `push` reads what was appended since; `close` drops the timers.
 */
const projectLogFeed = (res: ServerResponse, frame: (project: string, events: OrchestratorEvent[]) => string) => {
  const tailAt = new Map<string, EventLogTailAt>();
  // The debounce buffers: the view-relevant events collected for a project since its last
  // flush, and the pending timer that will flush them as one frame.
  const pending = new Map<string, OrchestratorEvent[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Flush a project's debounced survivors as a single SSE frame. Emits nothing when the
  // response has ended or nothing view-relevant accumulated (a window of pure noise).
  const flush = (project: string) => {
    timers.delete(project);
    const events = pending.get(project) ?? [];
    pending.delete(project);
    if (res.writableEnded || !events.length) return;
    res.write(frame(project, events));
  };

  return {
    seed: (project: string, logFile: string) => tailAt.set(project, logEndOf(logFile)),
    push: (project: string, logFile: string) => {
      // A watch callback can fire in the gap between the client disconnecting and the
      // watchers closing; never write to an already-ended response.
      if (res.writableEnded) return;
      const { events, at } = tailEventLog(logFile, tailAt.get(project) ?? { offset: 0, ino: 0 });
      tailAt.set(project, at);
      const relevant = viewRelevantEvents(events);
      if (!relevant.length) return;
      // Buffer the survivors and arm a single debounce timer per project; a burst of
      // appends within the window coalesces into the one frame `flush` writes.
      const buffered = pending.get(project) ?? [];
      buffered.push(...relevant);
      pending.set(project, buffered);
      if (!timers.has(project))
        timers.set(
          project,
          setTimeout(() => flush(project), DEBOUNCE_MS),
        );
    },
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer);
    },
  };
};

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
 * from the page's own first fetch. It tails each log from a byte offset
 * (`tailEventLog`), reading only the appended bytes, and reads it from its start
 * when it shrinks or is replaced (an archive). A project whose base location has moved or been
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
  const watchers: FSWatcher[] = [];
  const feed = projectLogFeed(res, (project, events) => `data: ${JSON.stringify({ project, events })}\n\n`);
  // The live-tail arm (#124): the same watch fires on each running agent's
  // `activity-<id>.jsonl` append (they share the watched logs dir), so alongside the
  // orchestrator frame we recompute the project's merged tail snapshot and push it as a
  // *named* `tail` SSE event. A named event never triggers the default `onmessage`, so the
  // landing (which listens for the unnamed frame) ignores it; only the repo page's tail
  // listener consumes it. Deduped by the last snapshot JSON so an unchanged tail is silent.
  const tailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const tailSent = new Map<string, string>();
  // The host-log arm (#180): the persistent `host.jsonl` (gateway/registry/Telegram/SSE
  // diagnostics across every project, #157) is one more watched log under a synthetic key,
  // its newly-appended raw lines pushed as a *named* `host` SSE frame. Like the tail frame, a
  // named event never fires the landing's `onmessage`, so it drives only the host-log pane
  // (its gear badge + rows), never a cards/feed refresh. Its own character offset and
  // debounce buffer, separate from the per-project maps since it carries raw lines, not events.
  let hostOffset = 0;
  let hostPending: string[] = [];
  let hostTimer: ReturnType<typeof setTimeout> | undefined;

  // Refuse past the cap before any watcher arms. Teardown covers only what was set up by the
  // time the request closes: the collections start empty, so a part never reached closes nothing.
  const admitted = admitEventConnection(req, res, () => {
    for (const watcher of watchers) watcher.close();
    feed.close();
    for (const timer of tailTimers.values()) clearTimeout(timer);
    if (hostTimer) clearTimeout(hostTimer);
  });
  if (!admitted) return true;

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

  const readLog = (logFile: string): string => {
    try {
      return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    } catch {
      return "";
    }
  };

  // Recompute a project's live-tail snapshot and push it as a named `tail` frame when it
  // changed. Guarded so an idle project we've never announced stays silent (no empty-frame
  // flood on connect), but a project whose agents drop to zero *does* get one last frame so
  // the client hides the pane.
  const flushTail = (project: string, pointer: ProjectPointer) => {
    tailTimers.delete(project);
    if (res.writableEnded) return;
    let snapshot;
    try {
      snapshot = buildLiveTail(statusConfigFromPointer(pointer));
    } catch {
      return;
    }
    const json = JSON.stringify(snapshot);
    if (tailSent.get(project) === json) return;
    const firstMention = !tailSent.has(project);
    tailSent.set(project, json);
    if (firstMention && !snapshot.agents.length && !snapshot.lines.length) return;
    res.write(`event: tail\ndata: ${JSON.stringify({ project, tail: snapshot })}\n\n`);
  };
  const pushTail = (project: string, pointer: ProjectPointer) => {
    if (res.writableEnded) return;
    if (!tailTimers.has(project))
      tailTimers.set(
        project,
        setTimeout(() => flushTail(project, pointer), DEBOUNCE_MS),
      );
  };

  // Flush the host log's debounced newly-appended lines as one named `host` frame. Emits
  // nothing when the response has ended or nothing landed (a rotation/no-op change event).
  const flushHost = () => {
    hostTimer = undefined;
    const lines = hostPending;
    hostPending = [];
    if (res.writableEnded || !lines.length) return;
    res.write(`event: host\ndata: ${JSON.stringify({ lines })}\n\n`);
  };
  const pushHost = (hostFile: string) => {
    if (res.writableEnded) return;
    const text = readLog(hostFile);
    // A truncation/rotation resets the offset so we don't slice past the new, shorter file.
    if (text.length < hostOffset) hostOffset = 0;
    const appended = text.slice(hostOffset).split("\n").filter(Boolean);
    hostOffset = text.length;
    if (!appended.length) return;
    hostPending.push(...appended);
    if (!hostTimer) hostTimer = setTimeout(flushHost, DEBOUNCE_MS);
  };

  for (const pointer of listProjects(deps.configDir)) {
    const logFile = logFileOf(pointer.baseLocation);
    // Seed at the current end so the backlog isn't re-pushed on connect (the page
    // already loaded it); the append itself is the "something happened" signal.
    feed.seed(pointer.project, logFile);
    // Watch the logs directory, not the file, so a not-yet-created log or a
    // rotation still registers. A missing base location is skipped, not fatal.
    const logsDir = dirname(logFile);
    if (!existsSync(logsDir)) continue;
    try {
      watchers.push(
        watch(logsDir, () => {
          feed.push(pointer.project, logFile);
          pushTail(pointer.project, pointer);
        }),
      );
    } catch (e) {
      logger.log("dashboard-events-watch-failed", { project: pointer.project, error: String(e) });
    }
    // Seed the pane with the project's current tail on connect (its lines are live-only and
    // never came down with the page render), so it fills before the first append.
    flushTail(pointer.project, pointer);
  }

  // The host-log arm (#180): seed the offset at the log's current end so the connect
  // backlog isn't re-pushed (the page's own `/api/host-log` fetch already has it), then
  // watch the host logs dir — not the file — so a not-yet-created or rotated `host.jsonl`
  // still registers. A missing dir is skipped, not fatal, exactly like a per-project arm.
  const hostFile = hostLogTarget();
  hostOffset = readLog(hostFile).length;
  const hostDir = dirname(hostFile);
  if (existsSync(hostDir)) {
    try {
      watchers.push(watch(hostDir, () => pushHost(hostFile)));
    } catch (e) {
      logger.log("dashboard-events-host-watch-failed", { error: String(e) });
    }
  }

  // Ring the grid on connect, symmetric with the tail's connect-seed above (#331). Every
  // offset seeded to the log's current end assumes a connection means a fresh page load — true
  // on first load, false on the `EventSource` auto-reconnect (`retry: 3000`) after a network
  // blip or gateway restart, which seeds past everything written during the gap so those events
  // are never delivered and the grid sits stale until the next append (many minutes away, or
  // never). No client reads this frame's payload — both consumers re-fetch authoritative state
  // on any unnamed frame — so one unconditional doorbell on connect heals a gap of any size from
  // any cause, and also covers the render→connect window (events landing between the page render
  // and this connect). It fires *last*, after every offset is seeded and every watcher armed, so
  // there is no window an append could fall through: the ring covers up to seeding, the armed
  // watcher covers everything after. A direct `res.write`, bypassing the debounce and denylist —
  // it is not an append, and a gap may have hidden view-relevant events even if only noise landed
  // last. One frame per connection (not per project): the landing page's `refresh()` has no
  // single-flight latch and would fire N concurrent loads for N registered projects. The
  // `{ project, events }` shape is kept, sent empty since nothing reads it.
  if (!res.writableEnded) res.write(`data: ${JSON.stringify({ project: null, events: [] })}\n\n`);

  return true;
};

/**
 * `GET /api/v1/events` — the external API's change doorbell (ADR 0027, docs/api.md). It carries no
 * event payload and no named frame: on connect, one `{"project":null}` frame (re-fetch everything —
 * the same gap-healing ring as `/api/events`' connect frame); after that, one `{"project":"<name>"}`
 * frame per debounced window in which that project's live log gained a view-relevant event, so the
 * consumer re-fetches `/api/v1/campaign` for it. Same watch, offset seeding, debounce and connection
 * cap as `/api/events` — one cap across both routes.
 */
export const handleApiV1Events: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/v1/events")) return false;
  const watchers: FSWatcher[] = [];
  const feed = projectLogFeed(res, (project) => `data: ${JSON.stringify({ project })}\n\n`);
  const admitted = admitEventConnection(req, res, () => {
    for (const watcher of watchers) watcher.close();
    feed.close();
  });
  if (!admitted) return true;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  for (const pointer of listProjects(deps.configDir)) {
    const logFile = logFileOf(pointer.baseLocation);
    feed.seed(pointer.project, logFile);
    const logsDir = dirname(logFile);
    if (!existsSync(logsDir)) continue;
    try {
      watchers.push(watch(logsDir, () => feed.push(pointer.project, logFile)));
    } catch (e) {
      logger.log("dashboard-events-watch-failed", { project: pointer.project, error: String(e) });
    }
  }

  // The connect ring, last — after every offset is seeded and every watcher armed — exactly as
  // `/api/events` rings it, so no append can fall between the consumer's re-fetch and the watch.
  if (!res.writableEnded) res.write(`data: ${JSON.stringify({ project: null })}\n\n`);
  return true;
};
