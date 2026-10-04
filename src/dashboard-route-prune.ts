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
 * <issue>` in the selected project's own root (the no-plan prune, ticket B) and
 * awaits it (#365): a clean exit redirects back to that project's board, a failed
 * child is a 502 carrying its last stderr line, and a child still running at the
 * cap is a 202, left running; without it, it shells `prune … --dry-run`
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
    // Await the child under the one dashboard child cap (#365), as graft does, so the
    // response reports what the prune did rather than that it was merely spawned.
    const { code, stderr, timedOut } = await deps.runChild(pointer.projectRoot, ["prune", taskId], {
      timeoutMs: deps.graftTimeoutMs,
    });
    const text = { "content-type": "text/plain; charset=utf-8" };
    if (timedOut) {
      // Still running at the cap: left running, never killed — it may be about to append its event.
      res.writeHead(202, text).end(`pruning… #${taskId} will drop from the plan when it lands`);
      return true;
    }
    if (code === 0) {
      res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
      return true;
    }
    // A failed child: surface its own last non-empty stderr line — the operator's language.
    const lastLine = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    res.writeHead(502, text).end(lastLine || `Couldn't prune #${taskId} for ${project} — is a campaign still running?`);
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
