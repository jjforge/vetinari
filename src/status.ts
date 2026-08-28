import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { CarveClosure } from "./dashboard-carve.ts";
import { shellCarveClosure, shellCarvePreview } from "./dashboard-carve.ts";
import type { DashboardDeps, RouteHandler, SpawnDashboardChild } from "./dashboard-http.ts";
import { handleApiStatus } from "./dashboard-route-api-status.ts";
import { handleApiIssue } from "./dashboard-route-api-issue.ts";
import { handleLanding } from "./dashboard-route-landing.ts";
import { handleFeed } from "./dashboard-route-feed.ts";
import { handleEvents } from "./dashboard-route-events.ts";
import { handleAnswer } from "./dashboard-route-answer.ts";
import { handleCarve, handleCarvePreview } from "./dashboard-route-carve.ts";
import { handleResume } from "./dashboard-route-resume.ts";
import { handleArchiveLog } from "./dashboard-route-archive-log.ts";
import { handleHostLog } from "./dashboard-route-host-log.ts";
import { handlePage } from "./dashboard-route-page.ts";

// The dashboard is split into a reconstruction/model, presentation renders, carve
// shelling, and one module per HTTP surface (ADR 0006). This file is the thin
// composer that wires them into the registry-backed server, and re-exports their
// public API so `status`'s existing importers keep a single import site.
export * from "./dashboard-model.ts";
export * from "./dashboard-render.ts";
export * from "./dashboard-carve.ts";
export * from "./event-log.ts";

// The dashboard surfaces, tried in order; each owns its own method+path match and
// returns true once it has handled the request. A `/` request only ever matches
// the page handler, so ordering never has to disambiguate two live routes.
const routes: RouteHandler[] = [handleApiStatus, handleApiIssue, handleLanding, handleFeed, handleEvents, handleHostLog, handleCarvePreview, handleAnswer, handleCarve, handleResume, handleArchiveLog, handlePage];

/**
 * The gateway's aggregated status site: one port fronting every registered
 * project. It reads the registry live each request (so a newly run project shows
 * up with no restart), builds each project's status from its base location, and
 * renders the one the `project` query param selects — defaulting to the first.
 * The parked-answer POST carries its project so the resume runs in that project's
 * own root with its own config and gates (ADR 0003), mirroring the gateway's
 * reply routing. This is the one dashboard the `status` CLI mode serves; it reads
 * only the registry, so it needs no gateway daemon — a single, no-gateway project
 * is just a one-entry dropdown (ADR 0006).
 */
export async function serveAllStatus(
  configDir: string,
  opts: {
    port: number;
    host: string;
    spawn?: (command: string, args: string[], options: { cwd: string; stdio: readonly (string | number)[] }) => unknown;
    carvePreview?: (projectRoot: string, taskId: string) => Promise<string | null>;
    carveClosure?: (projectRoot: string, taskId: string) => Promise<CarveClosure | null>;
  },
) {
  const deps: DashboardDeps = {
    configDir,
    spawn: opts.spawn ?? (spawn as SpawnDashboardChild),
    carvePreview: opts.carvePreview ?? shellCarvePreview,
    carveClosure: opts.carveClosure ?? shellCarveClosure,
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      for (const handle of routes) {
        if (await handle(req, res, url, deps)) return;
      }
      res.writeHead(404).end("not found");
    })().catch((err) => {
      res.writeHead(500).end(String(err?.stack ?? err));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  const address = server.address() as AddressInfo;
  const shownHost = opts.host === "0.0.0.0" ? "<tailnet-or-host-ip>" : opts.host;
  console.log(`vetinari status: http://${shownHost}:${address.port}`);
  return server;
}
