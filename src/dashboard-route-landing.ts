import { listProjects } from "./registry.ts";
import { buildLanding, festiveFromCookie } from "./dashboard-model.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/** `GET /api/landing` — the all-repos landing model (four counters + one card per
 * project) as JSON, reconstructed live off the registry each request so a newly
 * run project shows up with no restart. The client shell (`GET /`) fetches this
 * and renders the counters and cards. */
export const handleLanding: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/landing")) return false;
  res.setHeader("content-type", "application/json");
  const festive = festiveFromCookie(req.headers.cookie);
  res.end(JSON.stringify(buildLanding(listProjects(deps.configDir), new Date(), undefined, festive, deps.configDir)));
  return true;
};
