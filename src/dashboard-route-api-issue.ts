import { listProjects } from "./registry.ts";
import { listArchivedRuns, logFileOf, parkedReplyFor, readEvents, reconstructIssueDetail } from "./dashboard-model.ts";
import { listParkedIn, parkedDirOf } from "./state.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /api/issue?project=<name>&issue=<number>[&run=<token>]` — one issue's
 * reconstructed detail (status, title, turn count, elapsed span, and the turn log)
 * as JSON, the data the issue-detail sheet renders (story: issue detail sheet). The
 * project is resolved by matching the live registry, never by joining request input
 * into a path, so an unknown project is a 404 rather than a read of somewhere it
 * shouldn't reach; a project whose log names the issue nowhere reconstructs to an
 * empty, unstarted detail, which is a valid answer, not an error.
 *
 * With a `run` token the detail is read from that archived run's own log instead of
 * the live one — so an archived campaign chip opens the sheet on its own turns — and
 * the response is flagged `archived` (read-only: no reply/resume). The token is
 * resolved by matching the archive listing, exactly as the raw-log route does, so an
 * unlisted or crafted token is a 404, never a path joined from request input.
 */
export const handleApiIssue: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/api/issue")) return false;
  const project = url.searchParams.get("project");
  const issue = url.searchParams.get("issue");
  const run = url.searchParams.get("run");
  const pointer = project ? listProjects(deps.configDir).find((p) => p.project === project) : undefined;
  if (!pointer || !issue) {
    res.writeHead(404).end("not found");
    return true;
  }
  if (run) {
    const match = listArchivedRuns(pointer.baseLocation).find((r) => r.run === run);
    if (!match) {
      res.writeHead(404).end(`unknown run: ${run}`);
      return true;
    }
    // Read-only from the archived log: a finished run has no parked reply to offer.
    const detail = reconstructIssueDetail(readEvents({ logFile: match.file }), issue);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ project: pointer.project, ...detail, archived: true }));
    return true;
  }
  const detail = reconstructIssueDetail(readEvents({ logFile: logFileOf(pointer.baseLocation) }), issue);
  // A parked issue also carries its reply payload — the full question and the
  // agent's offered options — so the sheet can draw its reply block (story:
  // parked-question reply). Read live from the project's own parked records.
  const parked = detail.status === "parked" ? parkedReplyFor(listParkedIn(parkedDirOf(pointer.baseLocation)), issue) : undefined;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ project: pointer.project, ...detail, ...(parked ? { parked } : {}) }));
  return true;
};
