import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";
import { renderAggregatedPrunePreview } from "./dashboard-render.ts";

/**
 * `GET /prune?preview` — the lightweight JSON closure the inline panel fetches
 * when Prune is tapped, so it can disclose the removed list before any POST. The
 * closure is computed by the selected project's own install (dumb router, ADR
 * 0002), never here.
 */
export const handlePrunePreview: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/prune" && url.searchParams.has("preview"))) return false;
  const taskId = url.searchParams.get("taskId");
  const project = url.searchParams.get("project");
  if (!taskId || !project) {
    res.writeHead(400).end("taskId and project are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  const closure = await deps.pruneClosure(pointer.projectRoot, taskId);
  if (closure == null) {
    res.writeHead(502).end(`Couldn't preview prune #${taskId} for ${project} — is a campaign still running?`);
    return true;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(closure));
  return true;
};

/**
 * `POST /prune` — the prune surface's write. With `confirm` it shells `prune
 * <issue>` in the selected project's own root (the no-plan prune, ticket B),
 * redirecting back to that project's board; without it, it shells `prune … --dry-run`
 * and shows the closure behind a confirm form, gating the destructive act. The
 * aggregated site is a dumb router (ADR 0002), so both route to the project's own
 * install, exactly as the Telegram gateway does.
 */
export const handlePrune: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "POST" && url.pathname === "/prune")) return false;
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const taskId = form.get("taskId");
  const project = form.get("project");
  if (!taskId || !project) {
    res.writeHead(400).end("taskId and project are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  if (form.get("confirm")) {
    deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "prune", taskId], {
      cwd: pointer.projectRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
    return true;
  }
  // Preview step: route `prune <issue> --dry-run` to the selected project's
  // install and show the closure it computed, gating the destructive act behind
  // a confirm — the danger is that one issue drags a bigger subtree than you
  // realized.
  const previewText = await deps.prunePreview(pointer.projectRoot, taskId);
  if (previewText == null) {
    res.writeHead(502).end(`Couldn't preview prune #${taskId} for ${project} — is a campaign still running?`);
    return true;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(renderAggregatedPrunePreview(project, taskId, previewText));
  return true;
};
