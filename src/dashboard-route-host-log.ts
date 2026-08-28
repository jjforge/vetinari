import { readHostLogLines } from "./log.ts";
import type { RouteHandler } from "./dashboard-http.ts";

/** The bounded recent window the host-log pane shows — the most recent this-many rows,
 * matching the client's own buffer cap so the initial fetch and the live buffer agree. */
const HOST_LOG_WINDOW = 500;

/**
 * `GET /api/host-log` — the persistent host log (`host.jsonl`) as the dashboard's
 * host-log pane reads it (#180): its raw JSONL lines **newest-first**, bounded to the
 * most recent window, as `{ lines: string[] }`. It reads verbatim off disk via
 * `readHostLogLines` (#169) — no daemon required — so the bytes stay faithful for the
 * pane's JSON highlighting and its client-side notable-event scan, exactly as the SSE
 * `host` frames carry them. A missing `host.jsonl` (the host daemon never ran) reads an
 * empty window, which the client renders as a clean "no host log yet".
 */
export const handleHostLog: RouteHandler = (req, res, url) => {
  if (!(req.method === "GET" && url.pathname === "/api/host-log")) return false;
  // `readHostLogLines` returns the recent window oldest-first; the pane is newest-first.
  const lines = readHostLogLines(HOST_LOG_WINDOW).reverse();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ lines }));
  return true;
};
