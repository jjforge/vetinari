import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { isIP, type AddressInfo } from "node:net";
import type { PruneClosure } from "./dashboard-prune.ts";
import { shellPruneClosure, shellPrunePreview } from "./dashboard-prune.ts";
import type { GraftClosure } from "./dashboard-graft.ts";
import { shellGraftClosure } from "./dashboard-graft.ts";
import { runChild, startChild } from "./dashboard-child.ts";
import type { DashboardDeps, RouteHandler, SpawnDashboardChild } from "./dashboard-http.ts";
import { handleApiStatus } from "./dashboard-route-api-status.ts";
import { handleApiIssue } from "./dashboard-route-api-issue.ts";
import { handleLanding } from "./dashboard-route-landing.ts";
import { handleFeed } from "./dashboard-route-feed.ts";
import { handleEvents } from "./dashboard-route-events.ts";
import { handleAnswer } from "./dashboard-route-answer.ts";
import { handlePrune, handlePrunePreview } from "./dashboard-route-prune.ts";
import { handleGraft, handleGraftPreview } from "./dashboard-route-graft.ts";
import { handleRedrive } from "./dashboard-route-redrive.ts";
import { handleStop } from "./dashboard-route-stop.ts";
import { handleHostLog } from "./dashboard-route-host-log.ts";
import { handlePage } from "./dashboard-route-page.ts";

// The dashboard is split into a reconstruction/model, presentation renders, prune
// shelling, and one module per HTTP surface (ADR 0006). This file is the thin
// composer that wires them into the registry-backed server, and re-exports their
// public API so `status`'s existing importers keep a single import site.
export * from "./dashboard-model.ts";
export * from "./dashboard-render.ts";
export * from "./dashboard-prune.ts";
export * from "./dashboard-graft.ts";
export * from "./event-log.ts";

// The dashboard surfaces, tried in order; each owns its own method+path match and
// returns true once it has handled the request. A `/` request only ever matches
// the page handler, so ordering never has to disambiguate two live routes.
const routes: RouteHandler[] = [
  handleApiStatus,
  handleApiIssue,
  handleLanding,
  handleFeed,
  handleEvents,
  handleHostLog,
  handlePrunePreview,
  handleGraftPreview,
  handleAnswer,
  handlePrune,
  handleGraft,
  handleRedrive,
  handleStop,
  handlePage,
];

/**
 * The dashboard's guard against browser-borne requests (ADR 0021): the server is
 * unauthenticated by design, so this decides — before any route runs — whether a
 * request could only have come from a page that is not the dashboard's own. Returns
 * the one-line 403 body for a refusal, or null to admit the request.
 *
 * The Host check defeats DNS rebinding: a rebound page always arrives under a DNS
 * name, so only an IP literal, `localhost`, or a name the operator allowlisted is
 * admitted. The Origin check defeats a cross-site form POST: a browser that sends an
 * Origin (the literal `null` included) must name this very Host, port and all. No
 * Origin passes — curl and scripts send none, and they are not the browser threat.
 */
export function dashboardRequestDenial(host: string | undefined, origin: string | undefined, allowedHosts: string[]): string | null {
  if (!host) return "missing Host header; list the dashboard's name in VETINARI_STATUS_ALLOWED_HOSTS";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  const name = (bracketed ? bracketed[1] : host.replace(/:\d+$/, "")).toLowerCase();
  const admitted = isIP(name) !== 0 || name === "localhost" || allowedHosts.some((h) => h.toLowerCase() === name);
  if (!admitted) return `host not allowed: ${name}; list it in VETINARI_STATUS_ALLOWED_HOSTS`;
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return `cross-origin request refused: Origin ${origin} does not match Host ${host}`;
  }
  return null;
}

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
    prunePreview?: (projectRoot: string, taskId: string) => Promise<string | null>;
    pruneClosure?: (projectRoot: string, taskId: string) => Promise<PruneClosure | null>;
    graftClosure?: (projectRoot: string, taskIds: string[]) => Promise<GraftClosure | null>;
    runChild?: DashboardDeps["runChild"];
    graftTimeoutMs?: number;
    startChild?: DashboardDeps["startChild"];
    childStartupMs?: number;
  },
) {
  const deps: DashboardDeps = {
    configDir,
    spawn: opts.spawn ?? (spawn as SpawnDashboardChild),
    prunePreview: opts.prunePreview ?? shellPrunePreview,
    pruneClosure: opts.pruneClosure ?? shellPruneClosure,
    graftClosure: opts.graftClosure ?? shellGraftClosure,
    runChild: opts.runChild ?? runChild,
    graftTimeoutMs: opts.graftTimeoutMs ?? 60_000,
    startChild: opts.startChild ?? startChild,
    childStartupMs: opts.childStartupMs ?? 5_000,
  };
  const allowedHosts = (process.env.VETINARI_STATUS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const server = createServer((req, res) => {
    void (async () => {
      const denial = dashboardRequestDenial(req.headers.host, req.headers.origin, allowedHosts);
      if (denial) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(denial);
        return;
      }
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
  const loopback = opts.host === "localhost" || opts.host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(opts.host);
  if (!loopback) {
    console.log(
      "vetinari status: the dashboard is unauthenticated — reach it only over a private overlay network or an authenticating reverse proxy (see docs/operations.md)",
    );
  }
  return server;
}
