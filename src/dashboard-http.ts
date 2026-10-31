import type { IncomingMessage, ServerResponse } from "node:http";
import type { PruneClosure } from "./dashboard-prune.ts";
import type { GraftClosure } from "./dashboard-graft.ts";
import type { ChildResult, StartedChild } from "./dashboard-child.ts";

/**
 * The shared dependencies every dashboard route handler is wired with by the
 * composer (`serveAllStatus`): the host config dir the registry lives in, and the
 * dumb-router seams for computing a prune or graft closure or preview against a
 * project's own install and for running or starting its CLI as a child (ADR 0002). The composer resolves the defaults
 * once and passes this to each handler.
 */
export interface DashboardDeps {
  configDir: string;
  prunePreview: (projectRoot: string, taskId: string) => Promise<string | null>;
  pruneClosure: (projectRoot: string, taskId: string) => Promise<PruneClosure | null>;
  /** The graft closure — variadic (a set of ids), routed to the project's own
   *  `graft <ids…> --dry-run` exactly as `pruneClosure` routes to `prune … --dry-run`;
   *  the graft surface (option 1a) validates the batch against it before acting. */
  graftClosure: (projectRoot: string, taskIds: string[]) => Promise<GraftClosure | null>;
  /**
   * Shell a project's own CLI in its root and *await* it — the seam a route adopts when its
   * response must mean "recorded in the log", not "spawned" (#367): `graft`'s POST awaits it
   * so the wave card is in the log by the time the client hears back, and reads the child's
   * exit code + captured output to decide the response. Caps the wait at `graftTimeoutMs` without killing the child.
   */
  runChild: (projectRoot: string, args: string[], opts: { timeoutMs: number }) => Promise<ChildResult>;
  /** The cap POST /graft passes to `runChild` — injectable so a test need not wait it out. */
  graftTimeoutMs: number;
  /** The cap POST /stop passes to `runChild` — default 10000ms, injectable for tests. */
  stopTimeoutMs?: number;
  /**
   * Start a long-lived child (`redrive`, `answer`) with its output in a per-spawn log file and
   * wait only its startup window (#369) — the route's 2xx then means "started and survived the
   * window", not merely "spawned". Optional: the routes fall back to the real `startChild`.
   */
  startChild?: (
    projectRoot: string,
    args: string[],
    opts: { logFile: string; startupMs: number; env?: Record<string, string> },
  ) => Promise<StartedChild>;
  /** The startup window POST /redrive and POST /answer wait — default 5000ms, injectable for tests. */
  childStartupMs?: number;
  /** The gateway's loop health `GET /healthz` serves — absent on the standalone `status` server, where the route 404s. */
  health?: () => unknown;
  /** This response's CSP nonce (#600) — set per request by the composer on its copy of the deps;
   *  a route rendering a page writes it on every inline `<script>`/`<style>`. */
  nonce?: string;
}

/**
 * A single dashboard surface's handler: it inspects the request and, if it owns
 * that method+path, writes the response and returns true; otherwise it returns
 * false untouched so the composer can try the next one. Keeping the match inside
 * each handler is what lets the composer stay a thin, order-only router.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL, deps: DashboardDeps) => boolean | Promise<boolean>;

/** The most a dashboard POST body may carry — 64 KiB, counted in bytes. */
export const MAX_DASHBOARD_BODY_BYTES = 65536;

/** Thrown by `readBody` when a body exceeds `MAX_DASHBOARD_BODY_BYTES`; the composer answers it with a 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_DASHBOARD_BODY_BYTES} bytes`);
  }
}

/**
 * Read a request body as utf8, rejecting with `BodyTooLargeError` once it passes
 * `MAX_DASHBOARD_BODY_BYTES`. The rest of an oversize body is drained and discarded,
 * not accumulated, so the client can still read the 413.
 */
export const readBody = (req: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.setEncoding("utf8");
    const onData = (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_DASHBOARD_BODY_BYTES) {
        req.removeListener("data", onData);
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      body += chunk;
    };
    req.on("data", onData);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
