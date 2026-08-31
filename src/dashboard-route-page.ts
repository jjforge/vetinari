import { listProjects } from "./registry.ts";
import { archiveStatusConfig, baseBranchForProject, buildAllStatus, buildStatus, cardState, festiveFromCookie, listArchivedRuns, repoForProject, selectStatus } from "./dashboard-model.ts";
import { renderLandingShell, renderStatusPage } from "./dashboard-render.ts";
import { projectHasLiveCampaign } from "./host-slots.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /` — the dashboard page. With no `project` query param it serves the
 * all-repos landing shell (client-rendered off `/api/landing`), which replaces the
 * old server-rendered status page as the thing you land on. With a project
 * selected it serves that project's campaign view: its status built live off the
 * registry, its archived runs listed beneath the live one, and — when a `run`
 * token is given — that archived run's wave cards rendered read-only below the list.
 * The archived body resolves the token by matching the listing, never by joining
 * request input into a path, so an unknown token is rejected.
 */
export const handlePage: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && (url.pathname === "/" || req.url === undefined))) return false;
  res.setHeader("content-type", "text/html; charset=utf-8");
  const pointers = listProjects(deps.configDir);
  const statuses = buildAllStatus(pointers, undefined, deps.configDir);
  // The repo dropdown, on both pages, is one option per registered project carrying
  // its rolled-up run state (ADR 0007) so each menu row can dot + note it, and its
  // owner/name (from the git remote) so it reads that instead of the bare key.
  const repos = statuses.map((s) => {
    const pointer = pointers.find((p) => p.project === s.project);
    return { project: s.project, runState: cardState(s), repo: pointer ? repoForProject(pointer.projectRoot) : undefined };
  });
  // No project selected → the all-repos landing shell. Also the empty-registry
  // fallback, so a fresh host lands on the (empty) landing rather than a stub page.
  const project = url.searchParams.get("project");
  if (!project || !statuses.length) {
    res.end(renderLandingShell(repos));
    return true;
  }
  const selected = selectStatus(statuses, project);
  const pointer = pointers.find((p) => p.project === selected.project);
  const archivedRuns = pointer ? listArchivedRuns(pointer.baseLocation) : [];
  const requestedRun = url.searchParams.get("run") ?? undefined;
  const match = requestedRun ? archivedRuns.find((r) => r.run === requestedRun) : undefined;
  // Each row's body renders the run's reconstructed status read-only: point
  // buildStatus at the archived log with `dead: true`; its dir holds no parked records,
  // so the status carries none (a finished run has nothing to act on). A stalled run's
  // log ends with no terminal event, so the reducer folds its in-flight `running` issues,
  // dead with no verdict, to `parked{crash}` — an archived run must never read as live
  // (#152, design §7).
  const runs = archivedRuns.map((r) => ({
    run: r.run,
    name: r.name,
    startedAt: r.startedAt,
    state: r.state,
    issues: r.issues,
    status: buildStatus(archiveStatusConfig(selected.project, r.file), { dead: true }),
  }));
  // The Redrive campaign control (design §7, §11): whether a campaign process still holds the
  // host lease — the same live-lease probe crash detection reads — gates it, and the base
  // branch it would land on is read live from the checkout for its confirm dialog.
  const leaseLive = pointer ? projectHasLiveCampaign(deps.configDir, selected.project) : false;
  res.end(
    renderStatusPage(selected, {
      projects: repos,
      selected: selected.project,
      prune: true,
      graft: true,
      archivedRuns: runs,
      archivedRun: match?.run,
      festive: festiveFromCookie(req.headers.cookie),
      leaseLive,
      baseBranch: pointer ? baseBranchForProject(pointer.projectRoot) : undefined,
    }),
  );
  return true;
};
