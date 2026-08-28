import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";
import { renderAggregatedGraftRejection } from "./dashboard-render.ts";

/** `graft` is variadic, so both routes carry a *set* of ids rather than prune's
 *  single target — parsed off the same whitespace/comma split the CLI uses. */
const parseIds = (raw: string | null) => (raw ?? "").split(/[\s,]+/).filter(Boolean);

/**
 * `GET /graft?preview` — the lightweight JSON closure the inline panel fetches
 * before any POST, so it can disclose where the added issues would land (and any
 * whole-batch rejection) before committing. The closure is computed by the selected
 * project's own install (dumb router, ADR 0002), never here. The additive mirror of
 * `handlePrunePreview`, carrying a set of ids.
 */
export const handleGraftPreview: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/graft" && url.searchParams.has("preview"))) return false;
  const ids = parseIds(url.searchParams.get("ids"));
  const project = url.searchParams.get("project");
  if (!ids.length || !project) {
    res.writeHead(400).end("ids and project are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  const closure = await deps.graftClosure(pointer.projectRoot, ids);
  if (closure == null) {
    res.writeHead(502).end(`Couldn't preview graft ${ids.map((i) => `#${i}`).join(", ")} for ${project} — is a campaign still running?`);
    return true;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(closure));
  return true;
};

/**
 * `POST /graft` — the graft surface's write (option 1a). It acts *on submit*, with no
 * preview/confirm form: it validates the batch against the selected project's own
 * `graft <ids…> --dry-run` closure (ADR 0014 — whole-batch, all-or-nothing) and then
 * either grafts directly or surfaces the rejection. A clean batch shells the variadic
 * `graft <ids…>` in the project's own root and redirects to its board, where the new
 * wave card appears on the next live refresh (the graft confirms on the wave). A batch
 * with any offender grafts *nothing* and returns the per-id verdicts (422), so the
 * summary-line input can show them inline and retain the typed ids. The aggregated site
 * is a dumb router (ADR 0002), so it routes to the project's own install, exactly as
 * prune and the Telegram gateway do.
 */
export const handleGraft: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "POST" && url.pathname === "/graft")) return false;
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const ids = parseIds(form.get("ids"));
  const project = form.get("project");
  if (!ids.length || !project) {
    res.writeHead(400).end("ids and project are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  // Validate the batch against the project's own dry-run closure before acting — the
  // same closure the summary-line input fetches on blur, so submit and blur agree.
  const closure = await deps.graftClosure(pointer.projectRoot, ids);
  if (closure == null) {
    res.writeHead(502).end(`Couldn't graft ${ids.map((i) => `#${i}`).join(", ")} for ${project} — is a campaign still running?`);
    return true;
  }
  if (closure.rejected.length) {
    // Whole-batch rejection (any offender): graft nothing, surface the per-id verdicts
    // inline — the operator keeps the typed ids and corrects them, no navigation away.
    res.writeHead(422, { "content-type": "text/html; charset=utf-8" }).end(renderAggregatedGraftRejection(project, closure));
    return true;
  }
  // Clean batch: shell the variadic `graft <ids…>` against the selected project's own
  // root and redirect to its board — the graft confirms on the wave, not a form.
  deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "graft", ...ids], {
    cwd: pointer.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
  return true;
};
