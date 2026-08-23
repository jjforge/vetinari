import { listProjects } from "./registry.ts";
import { archiveStatusConfig, buildAllStatus, buildStatus, listArchivedRuns, selectStatus } from "./dashboard-model.ts";
import { renderStatusPage } from "./dashboard-render.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /` — the dashboard page. Builds every project's status live off the
 * registry, renders the one the `project` query param selects (defaulting to the
 * first), and lists the selected project's archived runs beneath the live one. A
 * `run` token renders that archived run read-only below the list. Both the archived
 * body and the raw-log link resolve the token by matching the listing — never by
 * joining request input into a path — so an unknown token is simply rejected.
 */
export const handlePage: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && (url.pathname === "/" || req.url === undefined))) return false;
  const statuses = buildAllStatus(listProjects(deps.configDir));
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (!statuses.length) {
    res.end(renderStatusPage({ project: "No projects registered", waves: [], parked: [] }));
    return true;
  }
  const selected = selectStatus(statuses, url.searchParams.get("project") ?? undefined);
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
