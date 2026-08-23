import { listProjects } from "./registry.ts";
import { archiveStatusConfig, buildAllStatus, buildStatus, listArchivedRuns, selectStatus } from "./dashboard-model.ts";
import { renderLandingShell, renderStatusPage } from "./dashboard-render.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /` — the dashboard page. With no `project` query param it serves the
 * all-repos landing shell (client-rendered off `/api/landing`), which replaces the
 * old server-rendered status page as the thing you land on. With a project
 * selected it serves that project's campaign view: its status built live off the
 * registry, its archived runs listed beneath the live one, and — when a `run`
 * token is given — that archived run rendered read-only below the list. Both the
 * archived body and the raw-log link resolve the token by matching the listing,
 * never by joining request input into a path, so an unknown token is rejected.
 */
export const handlePage: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && (url.pathname === "/" || req.url === undefined))) return false;
  res.setHeader("content-type", "text/html; charset=utf-8");
  const statuses = buildAllStatus(listProjects(deps.configDir));
  // No project selected → the all-repos landing shell. Also the empty-registry
  // fallback, so a fresh host lands on the (empty) landing rather than a stub page.
  const project = url.searchParams.get("project");
  if (!project || !statuses.length) {
    res.end(renderLandingShell(statuses.map((s) => s.project)));
    return true;
  }
  const selected = selectStatus(statuses, project);
  const pointer = listProjects(deps.configDir).find((p) => p.project === selected.project);
  const archivedRuns = pointer ? listArchivedRuns(pointer.baseLocation) : [];
  const requestedRun = url.searchParams.get("run") ?? undefined;
  const match = requestedRun ? archivedRuns.find((r) => r.run === requestedRun) : undefined;
  // Read-only: point buildStatus at the archived log; its dir holds no parked
  // records, so the reconstructed status carries none (a finished run has nothing
  // to act on).
  const archived = match ? buildStatus(archiveStatusConfig(selected.project, match.file)) : undefined;
  res.end(
    renderStatusPage(selected, {
      projects: statuses.map((s) => s.project),
      selected: selected.project,
      carve: true,
      archivedRuns: archivedRuns.map((r) => ({ run: r.run, summary: r.summary, name: r.name })),
      archived,
      archivedRun: match?.run,
    }),
  );
  return true;
};
