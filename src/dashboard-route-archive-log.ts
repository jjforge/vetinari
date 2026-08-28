import { readFileSync } from "node:fs";
import { listProjects } from "./registry.ts";
import { listArchivedRuns } from "./dashboard-model.ts";
import { humanizeLogLine } from "./log-view.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/**
 * `GET /archive/log` — one archived run's event log, as `{ lines: [{ raw, humanized }] }`.
 * Each line ships its verbatim NDJSON (`raw` — the Raw toggle and Download JSON source) and
 * its server-computed humanized parts (`humanized` — `time · actor · what happened` + a state
 * dot). Humanizing runs here, not in the client, because the run-level kinds narrate through
 * `describeEvent` (not shippable to the browser), exactly as the live tail attaches its parts
 * server-side. The `run` token is resolved by matching the project's archive listing — the same
 * guard the archived-run render uses — so an unlisted or crafted token is a 404, never a path
 * joined from request input.
 */
export const handleArchiveLog: RouteHandler = (req, res, url, deps) => {
  if (!(req.method === "GET" && url.pathname === "/archive/log")) return false;
  const project = url.searchParams.get("project");
  const run = url.searchParams.get("run");
  if (!project || !run) {
    res.writeHead(400).end("project and run are required");
    return true;
  }
  const pointer = listProjects(deps.configDir).find((p) => p.project === project);
  if (!pointer) {
    res.writeHead(404).end(`unknown project: ${project}`);
    return true;
  }
  const match = listArchivedRuns(pointer.baseLocation).find((r) => r.run === run);
  if (!match) {
    res.writeHead(404).end(`unknown run: ${run}`);
    return true;
  }
  const lines = readFileSync(match.file, "utf8")
    .split("\n")
    .filter((line) => line.length)
    .map((raw) => ({ raw, humanized: humanizeLogLine(raw) }));
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ lines }));
  return true;
};
