import { readFileSync } from "node:fs";
import { listProjects } from "./registry.ts";
import { listArchivedRuns } from "./dashboard-model.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /archive/log` — one archived run's raw event log, served as-is. The `run`
 * token is resolved by matching the project's archive listing — the same guard the
 * archived-run render uses — so an unlisted or crafted token is a 404, never a
 * path joined from request input.
 */
export const handleArchiveLog: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/archive/log")) return false;
  const project = url.searchParams.get("project");
  const run = url.searchParams.get("run");
  if (!project || !run) {
    res.writeHead(400).end("project and run are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  const match = listArchivedRuns(pointer.baseLocation).find((r) => r.run === run);
  if (!match) {
    res.writeHead(404).end(`unknown run: ${run}`);
    return true;
  }
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(readFileSync(match.file, "utf8"));
  return true;
};
