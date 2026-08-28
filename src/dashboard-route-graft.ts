import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";
import { renderAggregatedGraftPreview } from "./dashboard-render.ts";

/** `graft` is variadic, so both routes carry a *set* of ids rather than carve's
 *  single target — parsed off the same whitespace/comma split the CLI uses. */
const parseIds = (raw: string | null) => (raw ?? "").split(/[\s,]+/).filter(Boolean);

/**
 * `GET /graft?preview` — the lightweight JSON closure the inline panel fetches
 * before any POST, so it can disclose where the added issues would land (and any
 * whole-batch rejection) before committing. The closure is computed by the selected
 * project's own install (dumb router, ADR 0002), never here. The additive mirror of
 * `handleCarvePreview`, carrying a set of ids.
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
 * `POST /graft` — the graft surface's write. With `confirm` it shells the variadic
 * `graft <ids…>` in the selected project's own root, redirecting back to that
 * project's board; without it, it shells `graft <ids…> --dry-run` and shows the
 * placement behind a confirm form, gating the write. The aggregated site is a dumb
 * router (ADR 0002), so both route to the project's own install, exactly as carve
 * and the Telegram gateway do.
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
  if (form.get("confirm")) {
    deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "graft", ...ids], {
      cwd: pointer.projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
    return true;
  }
  // Preview step: route `graft <ids…> --dry-run` to the selected project's install
  // and show the placement it computed, gating the write behind a confirm — the
  // added issues land in future waves, and the whole batch rejects if any id is
  // unknown/closed/already in the campaign.
  const previewText = await deps.graftPreview(pointer.projectRoot, ids);
  if (previewText == null) {
    res.writeHead(502).end(`Couldn't preview graft ${ids.map((i) => `#${i}`).join(", ")} for ${project} — is a campaign still running?`);
    return true;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(renderAggregatedGraftPreview(project, ids, previewText));
  return true;
};
