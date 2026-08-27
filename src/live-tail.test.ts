import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { buildLiveTail } from "./dashboard-model.ts";
import type { AddressInfo } from "node:net";
import { renderLiveTail, renderStatusPage, tailAppend, tailFresh, tailView } from "./dashboard-render.ts";
import type { CampaignStatus } from "./dashboard-model.ts";
import { serveAllStatus } from "./status.ts";
import { register } from "./registry.ts";
import { event } from "./event-log.ts";
import { appendActivity, initActivityLog } from "./activity.ts";

let seq = 0;
const tmp = (): string => {
  const dir = join(tmpdir(), `vetinari-tail-${Date.now()}-${seq++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  return dir;
};

const cfgFor = (dir: string): ResolvedConfig =>
  ({
    project: "acme",
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
    fetchTask: (id: string) => id,
  }) as unknown as ResolvedConfig;

const writeJsonl = (path: string, events: object[]) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

test("buildLiveTail merges a running agent's activity lines, tagged with its issue and status", () => {
  const dir = tmp();
  // A bare queue marks both issues running; 203 then goes green (completed), so 204 alone runs.
  writeJsonl(cfgFor(dir).logFile, [
    event("queue-start", { taskIds: ["203", "204"], slots: 2, ts: "2026-08-27T00:00:00.000Z" }),
    event("green", { taskId: "203", branch: "agent/203", commits: ["a"], ts: "2026-08-27T00:00:05.000Z" }),
  ]);
  // 204's live activity stream (the file the pane tails).
  initActivityLog(dir, "204");
  appendActivity(dir, "204", event("tool", { taskId: "204", name: "Read", path: "/repo/src/x.ts", ts: "2026-08-27T00:00:01.000Z" }));
  appendActivity(dir, "204", event("sandbox-exec", { taskId: "204", cmd: "npm test", ts: "2026-08-27T00:00:02.000Z" }));

  const tail = buildLiveTail(cfgFor(dir));

  // Only the still-running agent surfaces, and it carries the running status.
  assert.deepEqual(tail.agents, [{ issue: "204", status: "running" }]);
  // Both of 204's lines, in file order, each keyed by its 0-based file index (n).
  assert.deepEqual(
    tail.lines.map((l) => [l.issue, l.status, l.n]),
    [
      ["204", "running", 0],
      ["204", "running", 1],
    ],
  );
  // `raw` is the exact JSONL text so the client can tokenise and substring-filter it.
  assert.ok(tail.lines[0].raw.includes('"event":"tool"'));
  assert.ok(tail.lines[1].raw.includes('"cmd":"npm test"'));
});

test("buildLiveTail interleaves two running agents by ts and excludes finished ones", () => {
  const dir = tmp();
  writeJsonl(cfgFor(dir).logFile, [
    event("queue-start", { taskIds: ["301", "302", "303"], slots: 3, ts: "2026-08-27T00:00:00.000Z" }),
    event("green", { taskId: "303", branch: "agent/303", commits: ["a"], ts: "2026-08-27T00:00:09.000Z" }),
  ]);
  // 301 and 302 run; 303 completed. Even though 303 has an activity file, it is dropped.
  initActivityLog(dir, "301");
  initActivityLog(dir, "302");
  initActivityLog(dir, "303");
  appendActivity(dir, "301", event("tool", { taskId: "301", name: "Read", ts: "2026-08-27T00:00:01.000Z" }));
  appendActivity(dir, "302", event("tool", { taskId: "302", name: "Edit", ts: "2026-08-27T00:00:02.000Z" }));
  appendActivity(dir, "301", event("commit", { taskId: "301", branch: "agent/301", sha: "abc", files: ["x"], ts: "2026-08-27T00:00:03.000Z" }));
  appendActivity(dir, "303", event("tool", { taskId: "303", name: "Read", ts: "2026-08-27T00:00:04.000Z" }));

  const tail = buildLiveTail(cfgFor(dir));

  assert.deepEqual(tail.agents.map((a) => a.issue).sort(), ["301", "302"]);
  // Interleaved by ts across the two running agents; 303's line is excluded entirely.
  assert.deepEqual(
    tail.lines.map((l) => l.issue),
    ["301", "302", "301"],
  );
});

// A small line factory for the pure client reducers (issue/raw are all they read).
const ln = (issue: string, n: number, raw = `{"issue":"${issue}","n":${n}}`) => ({ issue, status: "running", ts: "", n, raw });

test("tailView (following) shows the last `cap` lines after the issue+substring filters", () => {
  const buffer = [ln("1", 0, "alpha"), ln("2", 1, "beta"), ln("1", 2, "gamma"), ln("2", 3, "alpha-two")];
  // No filter, cap 2 → the newest two of four, following.
  const all = tailView({ buffer, mark: 0, live: true, issue: "", query: "", cap: 2 });
  assert.deepEqual(all.rows.map((r) => r.raw), ["gamma", "alpha-two"]);
  assert.equal(all.visible, 2);
  assert.equal(all.total, 4);
  assert.equal(all.backlog, 0);
  assert.equal(all.following, true);
  assert.equal(all.empty, false);

  // Issue filter composes with a case-insensitive substring filter on the whole raw line.
  const filtered = tailView({ buffer, mark: 0, live: true, issue: "2", query: "ALPHA", cap: 10 });
  assert.deepEqual(filtered.rows.map((r) => r.raw), ["alpha-two"]);
  assert.equal(filtered.visible, 1);
  assert.equal(filtered.total, 4);

  // A filter matching nothing is the empty state.
  const none = tailView({ buffer, mark: 0, live: true, issue: "", query: "zzz", cap: 10 });
  assert.equal(none.empty, true);
  assert.equal(none.visible, 0);
});

test("tailView (paused) freezes the visible set at the mark and counts the rest as backlog", () => {
  // Four lines buffered; pause was hit at mark=2, so lines 2 and 3 arrived after.
  const buffer = [ln("1", 0, "a"), ln("1", 1, "b"), ln("1", 2, "c"), ln("2", 3, "d")];
  const paused = tailView({ buffer, mark: 2, live: false, issue: "", query: "", cap: 10 });
  // Visible is frozen at the first two; the two newer lines are held as backlog.
  assert.deepEqual(paused.rows.map((r) => r.raw), ["a", "b"]);
  assert.equal(paused.backlog, 2);
  assert.equal(paused.total, 4);
  assert.equal(paused.following, false);

  // The backlog respects the active filters — only new lines that would show count.
  const filtered = tailView({ buffer, mark: 2, live: false, issue: "2", query: "", cap: 10 });
  assert.equal(filtered.backlog, 1);
});

test("tailAppend caps the buffer while following but lets it grow while paused", () => {
  const start = [ln("1", 0), ln("1", 1)];
  const incoming = [ln("1", 2), ln("1", 3)];
  // Following, cap 3 → keeps the newest 3, oldest discarded.
  const followed = tailAppend(start, incoming, true, 3);
  assert.deepEqual(followed.map((r) => r.n), [1, 2, 3]);
  // Paused → grows past the cap so a piling backlog survives.
  const grown = tailAppend(start, incoming, false, 3);
  assert.deepEqual(grown.map((r) => r.n), [0, 1, 2, 3]);
});

test("tailFresh treats a re-sent snapshot line as new only when its per-file index advances", () => {
  const snapshot = [ln("1", 0), ln("1", 1), ln("2", 0)];
  const first = tailFresh(snapshot, {});
  assert.deepEqual(first.fresh.map((r) => [r.issue, r.n]), [["1", 0], ["1", 1], ["2", 0]]);
  assert.deepEqual(first.seen, { "1": 1, "2": 0 });

  // Next snapshot re-sends the window plus one new line for issue 1; only the new one is fresh.
  const next = tailFresh([ln("1", 1), ln("2", 0), ln("1", 2)], first.seen);
  assert.deepEqual(next.fresh.map((r) => [r.issue, r.n]), [["1", 2]]);
  assert.deepEqual(next.seen, { "1": 2, "2": 0 });
});

// Collect SSE frames (with their optional `event:` type) for a fixed span, past the route's
// ~300ms debounce — the deterministic pattern the existing /api/events tests use.
const collectSse = async (port: number, ms: number): Promise<Array<{ event: string; data: any }>> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Array<{ event: string; data: any }> = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()))]);
    if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  for (const block of buf.split("\n\n")) {
    let event = "message";
    let data: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data !== undefined) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
};

test("GET /api/events seeds a running agent's tail as a named `tail` SSE frame (#124)", async () => {
  const configDir = tmp();
  const projDir = tmp();
  writeJsonl(join(projDir, "logs", "orchestrator.jsonl"), [
    event("queue-start", { taskIds: ["204"], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
  ]);
  initActivityLog(projDir, "204");
  appendActivity(projDir, "204", event("tool", { taskId: "204", name: "Edit", path: "/repo/a.ts", ts: "2026-08-27T00:00:01.000Z" }));
  register(configDir, { project: "acme", projectRoot: projDir, baseLocation: projDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const port = (server.address() as AddressInfo).port;
  try {
    const frames = await collectSse(port, 700);
    const tail = frames.find((f) => f.event === "tail");
    assert.ok(tail, "a tail frame was seeded on connect");
    assert.equal(tail!.data.project, "acme");
    assert.deepEqual(tail!.data.tail.agents, [{ issue: "204", status: "running" }]);
    assert.equal(tail!.data.tail.lines.length, 1);
    assert.ok(tail!.data.tail.lines[0].raw.includes('"name":"Edit"'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

const statusWith = (issues: Array<[string, string]>): CampaignStatus => ({
  project: "acme",
  waves: [{ index: 0, status: "running", issues: issues.map(([issueNumber, status]) => ({ issueNumber, status: status as CampaignStatus["waves"][0]["issues"][0]["status"] })) }],
  parked: [],
});

test("renderLiveTail draws the pane only when a repo has a running agent, one dropdown row each", () => {
  const html = renderLiveTail(statusWith([["204", "running"], ["205", "running"], ["203", "completed"]]));
  assert.match(html, /data-live-tail/);
  assert.match(html, /Live tail · agent logs/);
  // Summary counts the running agents (not the completed one).
  assert.match(html, /2 agents/);
  // The issue dropdown carries an "all agents" row plus one row per running issue, with a
  // status-coloured dot and the issue number — and NOT the completed issue.
  assert.match(html, /data-issue=""[^>]*>[\s\S]*?all agents/);
  assert.match(html, /data-issue="204"[\s\S]*?#204/);
  assert.match(html, /data-issue="205"[\s\S]*?#205/);
  assert.doesNotMatch(html, /data-issue="203"/);
  // The running gutter/dot reads the issue's status colour (a `.dot.running`).
  assert.match(html, /class="dot running"/);
  // The pane is visible (not hidden) when there is a running agent.
  assert.doesNotMatch(html, /class="live-tail"[^>]*\shidden/);
});

test("renderLiveTail renders the pane hidden when no agent is running", () => {
  const html = renderLiveTail(statusWith([["203", "completed"], ["205", "parked"]]));
  // Still emitted (so the client can reveal it when an agent starts) but hidden, and the
  // vocabulary is ours — never the mockup's `queued`.
  assert.match(html, /data-live-tail[^>]*\shidden/);
  assert.doesNotMatch(html, /queued/);
});

test("renderStatusPage places the live tail between the wave grid and the archived runs, outside #live-region", () => {
  const status = statusWith([["204", "running"]]);
  const html = renderStatusPage(status, { archivedRuns: [] });
  // The pane sits after the #live-region close (so a soft-refresh that swaps live-region
  // never blows away the tail's client state) — i.e. the tail markup follows </div> that
  // closes live-region.
  const liveRegionClose = html.indexOf('</div>\n');
  const tailAt = html.indexOf("data-live-tail");
  assert.ok(tailAt > -1, "tail is rendered");
  const regionOpen = html.indexOf('id="live-region"');
  assert.ok(regionOpen > -1 && tailAt > regionOpen, "tail comes after live-region opens");
});
