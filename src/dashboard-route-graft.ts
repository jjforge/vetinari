import { listProjects } from "./registry.ts";
import { readBody, type RouteHandler } from "./dashboard-http.ts";
import { renderAggregatedGraftRejection } from "./dashboard-render.ts";
import { parseGraftClosure } from "./dashboard-graft.ts";

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
 * preview/confirm form: it shells the selected project's own **real** `graft <ids…> --json`
 * and *awaits* it (#367), so the response means "recorded in the log" — the `graft` event
 * is appended by the time the client hears back, closing the window where the control read
 * done seconds before the wave landed. Shelling the real graft once (not a pre-validation
 * dry-run) also halves the wait and closes a TOCTOU window between validation and the child.
 *
 * The child's outcome decides the response (decision 4): a clean exit redirects to the
 * board, where the new wave card appears on the next live refresh; a non-zero exit that
 * printed a `graft-closure` line is a whole-batch rejection (ADR 0014, all-or-nothing) →
 * `422` with the per-id verdicts, ids retained; a non-zero exit without one is a broken
 * child → `502` carrying its own last stderr line; and a child still running at the cap →
 * `202`, left running, the wave to appear when it lands. The aggregated site is a dumb
 * router (ADR 0002), so it routes to the project's own install, as prune and the gateway do.
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
  // Shell the real graft in the project's own root and wait for it to exit — no dry-run.
  const { code, stdout, stderr, timedOut } = await deps.runChild(
    pointer.projectRoot,
    ["graft", ...ids, "--json"],
    { timeoutMs: deps.graftTimeoutMs },
  );
  if (timedOut) {
    // Still running at the cap: the child is NOT killed (it may be about to append its
    // event, decision 6). A refusal would have printed its closure and exited, so all
    // that is known is the batch was not refused — settle into a persistent note in
    // prune's idiom and clear the ids (a retry would only race or read as "already in").
    res.writeHead(202, { "content-type": "text/plain; charset=utf-8" }).end("grafting… the wave will appear when it lands");
    return true;
  }
  if (code === 0) {
    // Recorded in the log — redirect to the board, the graft confirms on the wave.
    res.writeHead(303, { location: `/?project=${encodeURIComponent(project)}` }).end();
    return true;
  }
  // Non-zero. A printed closure means the child had already decided not to apply — a
  // whole-batch rejection — so surface the per-id verdicts inline and keep the typed ids.
  const closure = parseGraftClosure(stdout);
  if (closure) {
    res.writeHead(422, { "content-type": "text/html; charset=utf-8" }).end(renderAggregatedGraftRejection(project, closure));
    return true;
  }
  // No closure line: the child broke. Surface its own last non-empty stderr line — `graft`
  // throws in the operator's own language, and that sentence is what makes it actionable.
  const lastLine = stderr.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(lastLine || `Couldn't graft ${ids.map((i) => `#${i}`).join(", ")} for ${project} — is a campaign still running?`);
  return true;
};
