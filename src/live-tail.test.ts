import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { buildLiveTail } from "./dashboard-model.ts";
import type { AddressInfo } from "node:net";
import { followView, renderLiveTail, renderStatusPage, tailAppend, tailFresh, tailView } from "./dashboard-render.ts";
import type { CampaignStatus } from "./dashboard-model.ts";
import { serveAllStatus } from "./status.ts";
import { register } from "./registry.ts";
import { event } from "./event-log.ts";
import { appendActivity, initActivityLog } from "./activity.ts";

// Humanized row times render in the host's LOCAL timezone (#239); pin the process TZ to PDT
// (UTC−7 in August) so the local slice is deterministic — a `…T09:15:00Z` line reads `02:15:00`.
process.env.TZ = "America/Los_Angeles";

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
  // A wave marks both issues running; 203 then goes green (completed), so 204 alone runs.
  writeJsonl(cfgFor(dir).logFile, [
    event("campaign-start", { waves: [["203", "204"]], slots: 2, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["203", "204"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "203", ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "204", ts: "2026-08-27T00:00:00.000Z" }),
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

test("buildLiveTail attaches each line's humanized parts for the log-view component (#203)", () => {
  const dir = tmp();
  writeJsonl(cfgFor(dir).logFile, [
    event("campaign-start", { waves: [["204"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["204"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "204", ts: "2026-08-27T00:00:00.000Z" }),
  ]);
  initActivityLog(dir, "204");
  appendActivity(dir, "204", event("tool", { taskId: "204", name: "Edit", path: "src/x.ts", ts: "2026-08-27T09:15:00.000Z" }));

  const tail = buildLiveTail(cfgFor(dir));

  // The server humanizes each raw line once so the client renders pre-humanized rows and
  // keeps `raw` for the Raw toggle and the download.
  assert.deepEqual(tail.lines[0].humanized, { time: "02:15:00", actor: "#204", verb: "edited", spans: [{ text: "src/x.ts", kind: "code" }], dot: "running" });
});

test("buildLiveTail interleaves two running agents by ts and excludes finished ones", () => {
  const dir = tmp();
  writeJsonl(cfgFor(dir).logFile, [
    event("campaign-start", { waves: [["301", "302", "303"]], slots: 3, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["301", "302", "303"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "301", ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "302", ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "303", ts: "2026-08-27T00:00:00.000Z" }),
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

test("buildLiveTail follows the wave in flight: a running agent from a wave not yet in flight is excluded (#309)", () => {
  const dir = tmp();
  // Wave 0 is in flight (301 running); a stray spawn logged 302 (a wave-1 member) running too —
  // a racy/partial log leaves a ghost in a wave that has not started. The tail answers "what is
  // running in the wave in flight", so it must list 301 only, never the ghost from the unstarted wave.
  writeJsonl(cfgFor(dir).logFile, [
    event("campaign-start", { waves: [["301"], ["302"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["301"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "301", ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "302", ts: "2026-08-27T00:00:01.000Z" }),
  ]);
  initActivityLog(dir, "301");
  initActivityLog(dir, "302");
  appendActivity(dir, "301", event("tool", { taskId: "301", name: "Read", ts: "2026-08-27T00:00:02.000Z" }));
  appendActivity(dir, "302", event("tool", { taskId: "302", name: "Read", ts: "2026-08-27T00:00:03.000Z" }));

  const tail = buildLiveTail(cfgFor(dir));

  assert.deepEqual(tail.agents, [{ issue: "301", status: "running" }]);
  assert.deepEqual(tail.lines.map((l) => l.issue), ["301"]);
});

test("buildLiveTail re-subscribes to the new wave on advance: the prior wave's stale-running ghost is dropped (#309)", () => {
  const dir = tmp();
  // Wave 0 advanced to wave 1 (302 running), but 301 never logged a terminal, so it still reads
  // running in a wave that is no longer in flight. The tail must follow wave 1 (302) and never
  // strand the operator on the ghost — nor go empty.
  writeJsonl(cfgFor(dir).logFile, [
    event("campaign-start", { waves: [["301"], ["302"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["301"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "301", ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-done", { index: 0, merged: [], ts: "2026-08-27T00:00:05.000Z" }),
    event("wave-start", { index: 1, tasks: ["302"], ts: "2026-08-27T00:00:06.000Z" }),
    event("spawn", { taskId: "302", ts: "2026-08-27T00:00:06.000Z" }),
  ]);
  initActivityLog(dir, "301");
  initActivityLog(dir, "302");
  appendActivity(dir, "301", event("tool", { taskId: "301", name: "Read", ts: "2026-08-27T00:00:01.000Z" }));
  appendActivity(dir, "302", event("tool", { taskId: "302", name: "Read", ts: "2026-08-27T00:00:07.000Z" }));

  const tail = buildLiveTail(cfgFor(dir));

  assert.deepEqual(tail.agents, [{ issue: "302", status: "running" }]);
  assert.deepEqual(tail.lines.map((l) => l.issue), ["302"]);
});

// A small line factory for the pure client reducers (issue/raw are all they read).
const ln = (issue: string, n: number, raw = `{"issue":"${issue}","n":${n}}`) => ({ issue, status: "running", ts: "", n, raw });

test("tailView (following) shows the newest `cap` lines, newest-first, after the issue+substring filters", () => {
  const buffer = [ln("1", 0, "alpha"), ln("2", 1, "beta"), ln("1", 2, "gamma"), ln("2", 3, "alpha-two")];
  // No filter, cap 2 → the newest two of four, following, newest at the head.
  const all = tailView({ buffer, mark: 0, live: true, issue: "", query: "", cap: 2 });
  assert.deepEqual(all.rows.map((r) => r.raw), ["alpha-two", "gamma"]);
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
  // Visible is frozen at the first two, rendered newest-first; the two newer lines are held as backlog.
  assert.deepEqual(paused.rows.map((r) => r.raw), ["b", "a"]);
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

// The generalized follow/pause view-model (#196) — the tail's tailView delegates to it, and
// the event-log feed drives it with its own row shape + match predicate. Exercised here over
// plain string rows to prove it is generic: it only knows a buffer, a mark, live, a cap and a
// match predicate.
test("followView (following) shows the newest `cap` matches newest-first, backlog zero", () => {
  const buffer = ["alpha", "beta", "gamma", "alpha-two"];
  const match = (r: string) => r.indexOf("alpha") !== -1;
  const all = followView({ buffer, mark: 0, live: true, cap: 2, match: () => true });
  assert.deepEqual(all.rows, ["alpha-two", "gamma"]);
  assert.equal(all.visible, 2);
  assert.equal(all.total, 4);
  assert.equal(all.backlog, 0);
  assert.equal(all.following, true);
  assert.equal(all.empty, false);

  // The predicate composes: only the two alpha rows survive, still newest-first.
  const filtered = followView({ buffer, mark: 0, live: true, cap: 10, match });
  assert.deepEqual(filtered.rows, ["alpha-two", "alpha"]);
  assert.equal(filtered.visible, 2);
  assert.equal(filtered.total, 4);

  // A predicate matching nothing is the empty state.
  const none = followView({ buffer, mark: 0, live: true, cap: 10, match: (r) => r === "zzz" });
  assert.equal(none.empty, true);
  assert.equal(none.visible, 0);
});

test("followView (paused) freezes the visible set at the mark and counts matching newer rows as backlog", () => {
  const buffer = ["a", "b", "c", "d"];
  const paused = followView({ buffer, mark: 2, live: false, cap: 10, match: () => true });
  // Frozen at the first two, rendered newest-first; the two newer rows are held as backlog.
  assert.deepEqual(paused.rows, ["b", "a"]);
  assert.equal(paused.backlog, 2);
  assert.equal(paused.total, 4);
  assert.equal(paused.following, false);

  // The backlog respects the predicate — only newer rows that would show count.
  const filtered = followView({ buffer, mark: 2, live: false, cap: 10, match: (r) => r === "d" });
  assert.equal(filtered.backlog, 1);
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Open an /api/events stream and continuously accumulate parsed frames (with their optional
// `event:` type) into an array until closed — a continuous pump, so a frame that arrives at any
// time is captured (racing read() against a timeout would drop a late frame mid-read).
const openStream = async (port: number): Promise<{ frames: Array<{ event: string; data: any }>; close: () => Promise<void> }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = [];
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = "message";
          let d: string | undefined;
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) d = line.slice(5).trim();
          }
          if (d !== undefined) frames.push({ event: ev, data: JSON.parse(d) });
        }
      }
    } catch {
      // reader cancelled at close
    }
  })();
  return {
    frames,
    close: async () => {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
};

test("GET /api/events seeds a running agent's tail as a named `tail` SSE frame (#124)", async () => {
  const configDir = tmp();
  const projDir = tmp();
  writeJsonl(join(projDir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { waves: [["204"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["204"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "204", ts: "2026-08-27T00:00:00.000Z" }),
  ]);
  initActivityLog(projDir, "204");
  appendActivity(projDir, "204", event("tool", { taskId: "204", name: "Edit", path: "/repo/a.ts", ts: "2026-08-27T00:00:01.000Z" }));
  register(configDir, { project: "acme", projectRoot: projDir, baseLocation: projDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const port = (server.address() as AddressInfo).port;
  const stream = await openStream(port);
  try {
    await delay(500);
    const tail = stream.frames.find((f) => f.event === "tail");
    assert.ok(tail, "a tail frame was seeded on connect");
    assert.equal(tail!.data.project, "acme");
    assert.deepEqual(tail!.data.tail.agents, [{ issue: "204", status: "running" }]);
    assert.equal(tail!.data.tail.lines.length, 1);
    assert.ok(tail!.data.tail.lines[0].raw.includes('"name":"Edit"'));
  } finally {
    await stream.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("GET /api/events pushes an updated tail frame when a running agent appends activity (#124)", async () => {
  const configDir = tmp();
  const projDir = tmp();
  writeJsonl(join(projDir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { waves: [["204"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["204"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "204", ts: "2026-08-27T00:00:00.000Z" }),
  ]);
  initActivityLog(projDir, "204");
  appendActivity(projDir, "204", event("tool", { taskId: "204", name: "Read", ts: "2026-08-27T00:00:01.000Z" }));
  register(configDir, { project: "acme", projectRoot: projDir, baseLocation: projDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const port = (server.address() as AddressInfo).port;
  const stream = await openStream(port);
  try {
    await delay(400);
    assert.ok(
      stream.frames.find((f) => f.event === "tail" && f.data.tail.lines.length === 1),
      "the seed tail frame carries the one existing line",
    );
    // A fresh activity append must surface as a new tail frame with both lines.
    appendActivity(projDir, "204", event("sandbox-exec", { taskId: "204", cmd: "npm test", ts: "2026-08-27T00:00:02.000Z" }));
    await delay(800);
    const updated = [...stream.frames].reverse().find((f) => f.event === "tail");
    assert.ok(updated && updated.data.tail.lines.length === 2, "the appended line arrives in a new tail frame");
  } finally {
    await stream.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("GET /api/events re-subscribes the tail to the new wave on advance, without a reload (#309)", async () => {
  const configDir = tmp();
  const projDir = tmp();
  // Connect while wave 0 is in flight (204 running).
  writeJsonl(join(projDir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { waves: [["204"], ["205"]], slots: 1, ts: "2026-08-27T00:00:00.000Z" }),
    event("wave-start", { index: 0, tasks: ["204"], ts: "2026-08-27T00:00:00.000Z" }),
    event("spawn", { taskId: "204", ts: "2026-08-27T00:00:00.000Z" }),
  ]);
  initActivityLog(projDir, "204");
  appendActivity(projDir, "204", event("tool", { taskId: "204", name: "Read", ts: "2026-08-27T00:00:01.000Z" }));
  register(configDir, { project: "acme", projectRoot: projDir, baseLocation: projDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const port = (server.address() as AddressInfo).port;
  const stream = await openStream(port);
  try {
    await delay(400);
    const seed = stream.frames.find((f) => f.event === "tail");
    assert.deepEqual(seed?.data.tail.agents, [{ issue: "204", status: "running" }], "the seed tail follows wave 0");

    // The server advances the wave: wave 0 closes, wave 1 starts and its agent spawns and works.
    appendFileSync(
      join(projDir, "logs", "orchestrator.jsonl"),
      [
        event("green", { taskId: "204", branch: "agent/204", commits: ["a"], ts: "2026-08-27T00:00:05.000Z" }),
        event("wave-done", { index: 0, merged: ["204"], ts: "2026-08-27T00:00:05.000Z" }),
        event("wave-start", { index: 1, tasks: ["205"], ts: "2026-08-27T00:00:06.000Z" }),
        event("spawn", { taskId: "205", ts: "2026-08-27T00:00:06.000Z" }),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    initActivityLog(projDir, "205");
    appendActivity(projDir, "205", event("tool", { taskId: "205", name: "Read", ts: "2026-08-27T00:00:07.000Z" }));
    await delay(800);

    // The tail re-subscribes to wave 1 in a fresh frame — no page reload — and drops wave 0's agent.
    const advanced = [...stream.frames].reverse().find((f) => f.event === "tail");
    assert.deepEqual(advanced?.data.tail.agents, [{ issue: "205", status: "running" }], "the tail follows the new wave");
    assert.ok(
      advanced!.data.tail.lines.every((l: { issue: string }) => l.issue === "205"),
      "only the new wave's activity remains",
    );
  } finally {
    await stream.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("GET /api/events pushes a named `host` frame when host.jsonl gains a row (#180)", async () => {
  const configDir = tmp();
  const gwHome = join(configDir, "gw-home");
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = gwHome;
  mkdirSync(join(gwHome, "logs"), { recursive: true });
  const hostFile = join(gwHome, "logs", "host.jsonl");
  writeFileSync(hostFile, '{"ts":"2026-08-28T00:00:00.000Z","event":"gateway-routed"}\n');
  try {
    const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
    const port = (server.address() as AddressInfo).port;
    const stream = await openStream(port);
    try {
      await delay(300);
      // The connect backlog is not re-pushed (the page's own /api/host-log fetch already has it);
      // only rows appended after connect arrive as frames.
      assert.ok(!stream.frames.some((f) => f.event === "host"), "no host frame for the connect backlog");
      appendFileSync(hostFile, '{"ts":"2026-08-28T00:00:01.000Z","event":"telegram-send","error":"429"}\n');
      await delay(800);
      const host = [...stream.frames].reverse().find((f) => f.event === "host");
      assert.ok(host, "the appended host row arrives as a named host frame");
      assert.equal(host!.data.lines.length, 1);
      assert.ok(host!.data.lines[0].includes('"error":"429"'), "the frame carries the raw appended line");
    } finally {
      await stream.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
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

test("renderLiveTail is humanized-only: no Humanized/Raw toggle, keeps the ⤓ Download JSON icon (#221)", () => {
  const html = renderLiveTail(statusWith([["204", "running"]]));
  // #221: the pane always renders humanized — the Humanized/Raw toggle is gone entirely.
  assert.doesNotMatch(html, /data-tail-mode/);
  assert.doesNotMatch(html, />Humanized</);
  assert.doesNotMatch(html, />Raw</);
  // Download JSON stays — the mockup's ⤓ .lv-ico icon (aria-labelled), still emitting raw NDJSON.
  assert.match(html, /class="lv-ico" data-tail-save[^>]*aria-label="Download JSON"[^>]*>⤓</);
  assert.ok(!/>Save</.test(html) && !/>Download JSON</.test(html), "no old text Save/Download button label");
  // The mockup's chrome drops the Clear control (the download preserves the data).
  assert.ok(!/data-tail-clear/.test(html), "the old Clear control is gone");
});

test("renderLiveTail omits follow/pause and renders the dot idle for a static (non-streaming) source (#203)", () => {
  const streaming = renderLiveTail(statusWith([["204", "running"]]), true);
  assert.match(streaming, /data-tail-play/);
  const stat = renderLiveTail(statusWith([["204", "running"]]), false);
  // A static source has no live stream to follow, so the play/pause control is absent and the
  // header dot is seeded idle (dim + still), never the streaming "live" state.
  assert.doesNotMatch(stat, /data-tail-play/);
  assert.match(stat, /data-tail-dot[^>]*data-state="idle"/);
});

test("renderLiveTail renders the pane collapsed (present, not hidden) when no agent is running (#330)", () => {
  const html = renderLiveTail(statusWith([["203", "completed"], ["205", "parked"]]));
  // The pane holds its space at all times now — never removed from the layout, so no `hidden`
  // on the section (that would drop it and reflow everything below).
  assert.doesNotMatch(html, /data-live-tail[^>]*\shidden/);
  // It seeds collapsed instead: the toggle reports aria-expanded="false" and the controls,
  // body and footer regions are hidden — exactly the state the toggle handler produces.
  assert.match(html, /data-tail-toggle aria-expanded="false"/);
  assert.match(html, /class="tail-controls" data-tail-controls hidden/);
  assert.match(html, /class="tail-body" data-tail-body hidden/);
  assert.match(html, /class="tail-footer" data-tail-footer hidden/);
  // The resting summary reads "no agents running" — never "0 agents", never a " · paused" suffix.
  assert.match(html, /data-tail-summary>no agents running</);
  assert.doesNotMatch(html, /0 agent/);
  assert.doesNotMatch(html, /· paused/);
  // The vocabulary is ours — never the mockup's `queued`.
  assert.doesNotMatch(html, /queued/);
});

test("renderLiveTail scopes the pane to the wave in flight, excluding a ghost runner from another wave (#309)", () => {
  // Wave 1 is in flight (302 running); 301 still reads running in wave 0 (a stale ghost). The tail
  // lists exactly the in-flight wave's slot-holder — never the ghost.
  const status: CampaignStatus = {
    project: "acme",
    waves: [
      { index: 0, status: "running", issues: [{ issueNumber: "301", status: "running" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "302", status: "running" }] },
    ],
    parked: [],
    inFlight: ["302"],
  };
  const html = renderLiveTail(status);
  // Exactly one agent — the in-flight runner — in both the summary and the dropdown.
  assert.match(html, />1 agent</);
  assert.match(html, /data-issue="302"[\s\S]*?#302/);
  assert.doesNotMatch(html, /data-issue="301"/);
  // The pane is visible (the wave in flight has a runner).
  assert.doesNotMatch(html, /class="live-tail"[^>]*\shidden/);
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

test("renderStatusPage ships the tail styles and a client that reuses the archived-raw tokeniser over SSE", () => {
  const html = renderStatusPage(statusWith([["204", "running"]]), {});
  // The pane's styles are present (fixed 236px body, the shell card).
  assert.match(html, /\.tail-body \{[^}]*height: 236px/);
  // #235: the log lines read at the same comfortable size as the sibling host-log pane
  // (.78rem ≈ 12.5px), not the old sub-readable 10.5px.
  assert.match(html, /\.tail-body \{[^}]*font-size: \.78rem/);
  assert.doesNotMatch(html, /\.tail-body \{[^}]*10\.5px/);
  assert.match(html, /\.live-tail \{/);
  // The client single-sources the pure reducers and listens for the named `tail` SSE frame —
  // live updates without a whole-page refetch.
  assert.match(html, /function tailView/);
  assert.match(html, /function tailFresh/);
  assert.match(html, /function tailAppend/);
  assert.match(html, /addEventListener\("tail"/);
  // Newest-on-top (#195): following pins the newest line to the top of the pane (scrollTop 0,
  // never the bottom via scrollHeight), and the backlog affordance points up.
  assert.match(html, /body\.scrollTop = 0/);
  assert.doesNotMatch(html, /scrollTop = body\.scrollHeight/);
  assert.match(html, /"↑ " \+ view\.backlog/);
  assert.doesNotMatch(html, /"↓ " \+ view\.backlog/);
});

test("the tail client collapses the pane instead of removing it, and single-sources the collapse reducer (#330)", () => {
  const html = renderStatusPage(statusWith([["204", "running"]]), {});
  // The pane is never taken out of the layout on the client any more — the old
  // `tailEl.hidden = agents.length === 0` full-removal is gone.
  assert.doesNotMatch(html, /tailEl\.hidden/);
  // The collapse/expand decision is the single-sourced pure reducer, so the browser runs the
  // very function the node test pins.
  assert.match(html, /function tailCollapseIntent/);
  // The resting summary the client writes reads exactly "no agents running" — the same string
  // the server seeds, so the first frame does not flicker the text.
  assert.match(html, /"no agents running"/);
});

test("the tail client renders humanized-only rows in the shared .lv-row, keeping the raw NDJSON download (#221)", () => {
  const html = renderStatusPage(statusWith([["204", "running"]]), {});
  // Humanized rows read the server-attached parts (time · actor · what happened) and a
  // state-coloured dot, built by the shared .lv-row component — there is no raw display mode.
  assert.match(html, /r\.humanized/);
  assert.match(html, /humanizedRow\(h, document\)/);
  // The multiline-collapse split (#217) ships alongside, since humanizedRow calls it client-side.
  assert.match(html, /function splitOverflow/);
  assert.match(html, /lv-dot/);
  // #221: no Humanized/Raw toggle — the tail is humanized-only.
  assert.doesNotMatch(html, /data-tail-mode/);
  // Download JSON still emits the raw NDJSON.
  assert.match(html, /\.map\(\(r\) => r\.raw\)\.join/);
  assert.match(html, /application\/x-ndjson/);
});
