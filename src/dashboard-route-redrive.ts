import { listProjects } from "./registry.ts";
import { buildStatus, campaignState, statusConfigFromPointer } from "./dashboard-model.ts";
import { projectHasLiveLease } from "./host-slots.ts";
import { redriveAllowed } from "./dashboard-visual-state.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";

/**
 * `POST /redrive` — the campaign redrive action (design §7, §11). Redrive picks up the
 * *whole* unfinished campaign, so it is project-scoped (no `taskId`): it shells `redrive`
 * in the selected project's own root (dumb router, ADR 0002) so the shared install picks
 * that project's campaign back up in its own log, then redirects back to that project's board.
 *
 * Redrive is risky — fired on a draining wave it spawned a second campaign process over the
 * live one (#325) — so the route re-checks the same {@link redriveAllowed} rule the greyed
 * control and its confirm dialog gate on, server-side, before it spawns anything: it refuses
 * with a 409 and the one-line reason when the campaign is not stopped or a campaign process
 * still holds the host lease. The CLI's own refusal (§7) is the last line of defence, not the
 * first. Mirrors the `/prune` and `/answer` shell-the-CLI routes.
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
  // Re-check the safety rule the control gates on — the same live-lease probe crash detection
  // reads (design §8), folded through the campaign state so a crash reads as stopped.
  const leaseLive = projectHasLiveLease(deps.configDir, project);
  const status = buildStatus(statusConfigFromPointer(pointer), { alive: leaseLive });
  const gate = redriveAllowed(campaignState(status.waves.map((wave) => wave.status)), leaseLive);
  if (!gate.allowed) {
    res.writeHead(409).end(gate.reason);
    return true;
  }
  deps.spawn(process.execPath, [...process.execArgv, process.argv[1], "redrive"], {
    cwd: pointer.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
  return true;
};
