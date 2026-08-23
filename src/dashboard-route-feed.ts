import { listProjects } from "./registry.ts";
import { buildFeed } from "./dashboard-model.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/** `GET /api/feed` — the cross-project event feed as JSON: every registered
 * project's live-run log flattened to its narratable events, repo-prefixed and
 * newest-first. Reconstructed live off the registry each request, exactly as
 * `/api/landing` is, so a newly run project's events show up with no restart. The
 * landing shell fetches this and renders the feed under the cards on desktop. */
export const handleFeed: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/feed")) return false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(buildFeed(listProjects(deps.configDir))));
  return true;
};
