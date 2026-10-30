import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /healthz` — the gateway's loop health as JSON (`gatewayHealth`). Always a 200:
 * the body's `stale` flag carries the verdict. Only the gateway supplies a health
 * source, so on the standalone `status` server this falls through to the 404.
 */
export const handleHealthz: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/healthz" && deps.health)) return false;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(deps.health()));
  return true;
};
