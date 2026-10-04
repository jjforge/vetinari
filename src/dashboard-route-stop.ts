import { listProjects } from "./registry.ts";
import { projectHasLiveCampaign } from "./host-slots.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";

/**
 * `POST /stop` — the campaign Stop control's write (design §11). Stop is project-scoped (no
 * `taskId`): it shells the selected project's own `vetinari stop` — `--now` when the form carries
 * `now` — in its root (dumb router, ADR 0002), so the CLI, not the dashboard, delivers the signal.
 *
 * It re-checks the same live-lease probe the greyed control reads before it spawns anything,
 * refusing with a 409 when no campaign holds the lease. `stop` only sends a signal and exits, so
 * the route awaits it through `runChild` (graft's seam) rather than #369's startup window: a clean
 * exit redirects to the board, where "stop pending" and then the `stopped` park arrive off the
 * event log on the live refresh; the CLI's own refusal (exit 4) is a 409 and any other failure —
 * or a child still running at the cap — a 502, each carrying the child's last stderr line.
 */
export const handleStop: RouteHandler = async (req, res, url, deps) => {
  if (!(req.method === "POST" && url.pathname === "/stop")) return false;
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
  if (!projectHasLiveCampaign(deps.configDir, project)) {
    res.writeHead(409).end(`no campaign running for ${project}`);
    return true;
  }
  const args = form.get("now") ? ["stop", "--now"] : ["stop"];
  const { code, stderr, timedOut } = await deps.runChild(pointer.projectRoot, args, { timeoutMs: deps.stopTimeoutMs ?? 10_000 });
  if (!timedOut && code === 0) {
    res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
    return true;
  }
  const lastLine = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  res
    .writeHead(!timedOut && code === 4 ? 409 : 502, { "content-type": "text/plain; charset=utf-8" })
    .end(lastLine || "vetinari stop did not finish");
  return true;
};
