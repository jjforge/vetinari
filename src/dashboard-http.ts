import type { IncomingMessage, ServerResponse } from "node:http";
import type { PruneClosure } from "./dashboard-prune.ts";
import type { GraftClosure } from "./dashboard-graft.ts";

/** How the dumb-router shells a project's own CLI (`answer`, `prune`, `graft`) in its
 * root — the injectable seam every route that spawns a child shares, so tests can
 * capture the spawn instead of running it. */
export type SpawnDashboardChild = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: readonly (string | number)[] },
) => unknown;

/**
 * The shared dependencies every dashboard route handler is wired with by the
 * composer (`serveAllStatus`): the host config dir the registry lives in, and the
 * dumb-router seams for spawning a project's CLI and computing a prune closure or
 * preview against its own install (ADR 0002). The composer resolves the defaults
 * once and passes this to each handler.
 */
export interface DashboardDeps {
  configDir: string;
  spawn: SpawnDashboardChild;
  prunePreview: (projectRoot: string, taskId: string) => Promise<string | null>;
  pruneClosure: (projectRoot: string, taskId: string) => Promise<PruneClosure | null>;
  /** The graft closure — variadic (a set of ids), routed to the project's own
   *  `graft <ids…> --dry-run` exactly as `pruneClosure` routes to `prune … --dry-run`;
   *  the graft surface (option 1a) validates the batch against it before acting. */
  graftClosure: (projectRoot: string, taskIds: string[]) => Promise<GraftClosure | null>;
}

/**
 * A single dashboard surface's handler: it inspects the request and, if it owns
 * that method+path, writes the response and returns true; otherwise it returns
 * false untouched so the composer can try the next one. Keeping the match inside
 * each handler is what lets the composer stay a thin, order-only router.
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DashboardDeps,
) => boolean | Promise<boolean>;

export const readBody = (req: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
