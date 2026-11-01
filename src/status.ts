import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { isIP, type AddressInfo } from "node:net";
import type { PruneClosure } from "./dashboard-prune.ts";
import { shellPruneClosure, shellPrunePreview } from "./dashboard-prune.ts";
import type { GraftClosure } from "./dashboard-graft.ts";
import { shellGraftClosure } from "./dashboard-graft.ts";
import { runChild, startChild } from "./dashboard-child.ts";
import { BodyTooLargeError, type DashboardDeps, type RouteHandler } from "./dashboard-http.ts";
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
import { handleHealthz } from "./dashboard-route-healthz.ts";
import { handlePage } from "./dashboard-route-page.ts";
import { hostLogger, type Logger } from "./log.ts";
import { dockerPeerDenial, watchDockerPeerSubnets, type DockerSubnetLister } from "./docker-peers.ts";

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
  handleHealthz,
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
 * The one Content-Security-Policy every dashboard response carries: its pages' inline scripts and
 * styles only under this response's nonce (#600), same-origin fetch/EventSource and form posts, and
 * nothing external — nor may any other page frame it.
 */
const dashboardCsp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

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
    prunePreview?: (projectRoot: string, taskId: string) => Promise<string | null>;
    pruneClosure?: (projectRoot: string, taskId: string) => Promise<PruneClosure | null>;
    graftClosure?: (projectRoot: string, taskIds: string[]) => Promise<GraftClosure | null>;
    runChild?: DashboardDeps["runChild"];
    graftTimeoutMs?: number;
    startChild?: DashboardDeps["startChild"];
    childStartupMs?: number;
    health?: DashboardDeps["health"];
    /** Where the access and failure rows go; defaults to the host log. */
    logger?: Logger;
    /** Replaces the built-in route list (tests); the denial guard still runs first. */
    routes?: RouteHandler[];
    /**
     * Lists the subnets of the Docker network agent containers run on, whose requests are refused
     * (ADR 0021). Defaults to none — only the `status` and gateway entry points wire in Docker.
     */
    dockerPeerSubnets?: DockerSubnetLister;
    /** How long one listing may take before it counts as failed; defaults to 5 s. */
    dockerPeerTimeoutMs?: number;
  },
) {
  const deps: DashboardDeps = {
    configDir,
    prunePreview: opts.prunePreview ?? shellPrunePreview,
    pruneClosure: opts.pruneClosure ?? shellPruneClosure,
    graftClosure: opts.graftClosure ?? shellGraftClosure,
    runChild: opts.runChild ?? runChild,
    graftTimeoutMs: opts.graftTimeoutMs ?? 60_000,
    startChild: opts.startChild ?? startChild,
    childStartupMs: opts.childStartupMs ?? 5_000,
    health: opts.health,
  };
  const allowedHosts = (process.env.VETINARI_STATUS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const logger = opts.logger ?? hostLogger();
  const handlers = opts.routes ?? routes;
  const peers = await watchDockerPeerSubnets(opts.dockerPeerSubnets ?? (async () => []), {
    timeoutMs: opts.dockerPeerTimeoutMs ?? 5_000,
    logger,
  });
  const server = createServer((req, res) => {
    const path = URL.parse(req.url ?? "/", "http://localhost")?.pathname ?? null;
    // One access row per POST — every one starts a process or reshapes a campaign — written once
    // the response closes (sent or aborted), so `status` is the code actually sent (#582). A failed
    // write is dropped: thrown from this listener it would be an uncaught exception (#632).
    if (req.method === "POST") {
      const remote = req.socket.remoteAddress ?? null;
      res.once("close", () => {
        try {
          logger.log("dashboard-request", { method: "POST", path, status: res.statusCode, remote });
        } catch {}
      });
    }
    // Defence in depth on every response (#526): the pages load only their own inline assets and
    // talk only to this origin, so any future escaping slip cannot reach out or be framed.
    // A fresh nonce per response (#600): an injected inline block cannot know it, so cannot run.
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("content-security-policy", dashboardCsp(nonce));
    // A framed click carries the dashboard's own Origin and so passes the ADR 0021 Origin check;
    // refusing to be framed (CSP frame-ancestors, and this for older browsers) stops clickjacking (#525).
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    // Error bodies echo request input; type them as plain text. JSON, HTML and SSE routes set their own.
    res.setHeader("content-type", "text/plain; charset=utf-8");
    void (async () => {
      // First, before the Host check: an agent container is a script that can forge Host and Origin,
      // but not the address it connects from — and a forged DNS-name Host still gets this row (#603).
      const remote = req.socket.remoteAddress;
      const peerDenial = dockerPeerDenial(remote, peers.subnets());
      if (peerDenial) {
        try {
          logger.log("dashboard-docker-peer-refused", { method: req.method, path, remote });
        } catch {}
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(peerDenial);
        return;
      }
      const denial = dashboardRequestDenial(req.headers.host, req.headers.origin, allowedHosts);
      if (denial) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(denial);
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      // The two GETs that shell a child (ADR 0021): a cross-site <img>/<iframe> GET carries no
      // Origin, so the Origin check admits it — refuse any Sec-Fetch-Site but same-origin (#524).
      const fetchSite = req.headers["sec-fetch-site"];
      const spawningPreview =
        req.method === "GET" && (url.pathname === "/graft" || url.pathname === "/prune") && url.searchParams.has("preview");
      if (spawningPreview && fetchSite !== undefined && fetchSite !== "same-origin") {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(`cross-site request refused: Sec-Fetch-Site ${fetchSite}`);
        return;
      }
      for (const handle of handlers) {
        // A per-request copy carries the nonce: `deps` is shared by every request, never mutated.
        if (await handle(req, res, url, { ...deps, nonce })) return;
      }
      res.writeHead(404).end("not found");
    })().catch((err) => {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }).end("request body too large");
        return;
      }
      // A head already sent (the SSE route sends its first) cannot be rewritten — and trying throws
      // here, an unhandled rejection that exits the hosting gateway — so cut the response off instead.
      if (res.headersSent) res.destroy();
      else res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("internal server error");
      // Log the failure, never send it: the stack is for the operator, not the client (#538). A log
      // write that fails cannot be logged either — drop it, so the error path never rejects (#632).
      try {
        logger.log("dashboard-request-failed", { method: req.method, path, error: String(err) });
      } catch {}
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
