import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";

/**
 * `POST /redrive` — the campaign redrive action (design §7). When a wave gated its
 * merged base red the campaign pauses for a human; once they have fixed forward,
 * this shells `redrive` in the selected project's own root (dumb router, ADR 0002)
 * so the shared install picks that project's unfinished campaign back up in its own
 * log, then redirects back to that project's board. Redrive is non-destructive and
 * project-scoped (one unfinished campaign per project), so it needs only the
 * `project` — no `taskId` target and, unlike prune, no preview/confirm gate.
 * Mirrors the `/prune` and `/answer` shell-the-CLI routes.
 */
export const handleRedrive: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "POST" && url.pathname === "/redrive")) return false;
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const project = form.get("project");
  if (!project) {
    res.writeHead(400).end("project is required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "redrive"], {
    cwd: pointer.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
  return true;
};
