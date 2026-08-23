import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";

/**
 * `POST /answer` — a parked issue's reply. The resume runs in the project's own
 * root so `answer` loads that project's config and gates — the same shell-out the
 * gateway's reply router uses (ADR 0003). Redirects back to that project's board.
 */
export const handleAnswer: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "POST" && url.pathname === "/answer")) return false;
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const taskId = form.get("taskId");
  const text = form.get("text");
  const project = form.get("project");
  if (!taskId || !text || !project) {
    res.writeHead(400).end("taskId, text and project are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "answer", taskId, text], {
    cwd: pointer.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
  return true;
};
