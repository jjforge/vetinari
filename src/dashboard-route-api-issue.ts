import { listProjects } from "./registry.ts";
import { logFileOf, readEvents, reconstructIssueDetail } from "./dashboard-model.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /api/issue?project=<name>&issue=<number>` — one issue's reconstructed detail
 * (status, title, turn count, elapsed span, and the turn log) as JSON, the data the
 * issue-detail sheet renders (story: issue detail sheet). The project is resolved by
 * matching the live registry, never by joining request input into a path, so an
 * unknown project is a 404 rather than a read of somewhere it shouldn't reach; a
 * project whose log names the issue nowhere reconstructs to an empty, unstarted
 * detail, which is a valid answer, not an error.
 */
export const handleApiIssue: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/issue")) return false;
  const project = url.searchParams.get("project");
  const issue = url.searchParams.get("issue");
  const pointer = project ? listProjects(deps.configDir).find((p) => p.project === project) : undefined;
  if (!pointer || !issue) {
    res.writeHead(404).end("not found");
    return true;
  }
  const detail = reconstructIssueDetail(readEvents({ logFile: logFileOf(pointer.baseLocation) }), issue);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ project: pointer.project, ...detail }));
  return true;
};
