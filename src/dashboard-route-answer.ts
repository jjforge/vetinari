import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";
import { respondWithStartedChild } from "./dashboard-child.ts";

/**
 * `POST /answer` — a parked issue's reply. The redrive runs in the project's own
 * root so `answer` loads that project's config and gates — the same shell-out the
 * gateway's reply router uses (ADR 0003). Redirects back to that project's board.
 *
 * `answer` may resume a whole campaign or run the issue's loop, so the route waits only the
 * startup window (#369): a refusal or an early death — an offline tracker write, which would
 * otherwise drop the answer silently — reaches the operator; a child still running is a 202.
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
  await respondWithStartedChild(res, deps, pointer, ["answer", taskId, text]);
  return true;
};
