import { listProjects } from "./registry.ts";
import { buildAllStatus } from "./dashboard-model.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/** `GET /api/status` — every registered project's status as JSON, read live off
 * the registry each request (a newly run project shows up with no restart). */
export const handleApiStatus: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/status")) return false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(buildAllStatus(listProjects(deps.configDir), undefined, deps.configDir)));
  return true;
};
