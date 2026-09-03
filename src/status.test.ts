// Tests for the aggregated status server and its HTTP routes (status.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { event, serveAllStatus, type OrchestratorEvent } from "./status.ts";
import type { AddressInfo } from "node:net";
import { register } from "./registry.ts";
import { registerProject } from "./host-slots.ts";

// The parsed payload the dashboard SSE stream carries in each `data:` frame.
type EventPayload = { project?: string; events?: { event: string; turn?: number }[] };

// Split every complete `\n\n`-terminated SSE frame out of `buf` and `JSON.parse`
// each frame's `data:` payload *individually*, returning the parsed payloads and
// the still-incomplete tail. One `reader.read()` can deliver two frames coalesced
// (handshake + first data frame, or two data frames when fs.watch fires close
// together); parsing per-frame is what stops their `data:` lines being joined into
// `{…}{…}` and thrown at by JSON.parse (#272). Comment/handshake frames carry no
// `data:` line and yield nothing.
const drainFrames = (buf: string): { payloads: EventPayload[]; rest: string } => {
  const payloads: EventPayload[] = [];
  let idx: number;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).trim())
      .join("");
    if (data) payloads.push(JSON.parse(data));
  }
  return { payloads, rest: buf };
};

const writeJsonl = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const seedState = (dir: string, events: unknown[]) => {
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);
};

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

// A live-stream harness for the filter/debounce tests: connects to /api/events, then
// `collect(ms)` reads for a fixed span and returns every data frame's parsed payload
// (comment/handshake frames carry no `data:` line and are skipped). Reading for a
// fixed span — past the ~300ms debounce window — is how "exactly one frame" and "zero
// frames" are asserted deterministically despite fs.watch's own coalescing.
const openEventStream = async (port: number) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const collect = async (ms: number): Promise<{ project?: string; events?: { event: string; turn?: number }[] }[]> => {
    const payloads: { project?: string; events?: { event: string; turn?: number }[] }[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("done")), remaining)),
        ]);
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const drained = drainFrames(buf);
      buf = drained.rest;
      payloads.push(...drained.payloads);
    }
    return payloads;
  };
  return { reader, collect };
};

test("serveAllStatus serves the aggregated site, selecting the project from the query param", async () => {
  const configDir = join(tmpdir(), `vetinari-serve-all-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    // A bare open lands on the all-repos shell; its dropdown lists both projects with All repos current.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);

    const beta = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    assert.match(beta, /<option value="beta" selected>/);
    // Beta's own campaign (issue 201) renders in the body, not alpha's issue 101.
    assert.match(beta, /#201 <small>/);
    assert.doesNotMatch(beta, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("GET /api/host-log serves the host log newest-first as raw JSONL lines; a missing file reads empty (#180)", async () => {
  const configDir = join(tmpdir(), `vetinari-hostlog-route-${Date.now()}`);
  const gwHome = join(configDir, "gw-home");
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = gwHome;
  try {
    // No host.jsonl yet → a clean empty window (the daemon never ran), never an error.
    const server0 = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
    const port0 = (server0.address() as AddressInfo).port;
    try {
      const empty = await (await fetch(`http://127.0.0.1:${port0}/api/host-log`)).json();
      assert.deepEqual(empty.lines, [], "a missing host log reads empty");
    } finally {
      await new Promise<void>((r) => server0.close(() => r()));
    }
    // Write three host rows oldest→newest; the endpoint returns them newest-first, verbatim.
    mkdirSync(join(gwHome, "logs"), { recursive: true });
    const rows = [
      '{"ts":"2026-08-28T00:00:00.000Z","event":"gateway-routed"}',
      '{"ts":"2026-08-28T00:00:01.000Z","event":"telegram-send","error":"429"}',
      '{"ts":"2026-08-28T00:00:02.000Z","event":"registry-read"}',
    ];
    writeFileSync(join(gwHome, "logs", "host.jsonl"), rows.join("\n") + "\n");
    const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
    const port = (server.address() as AddressInfo).port;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/host-log`)).json();
      // Newest-first: the last-written row leads; the bytes are verbatim (not reparsed).
      assert.deepEqual(body.lines, [rows[2], rows[1], rows[0]]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
  }
});

test("serveAllStatus GET / serves the all-repos landing shell, not a server-rendered campaign", async () => {
  const configDir = join(tmpdir(), `vetinari-landing-shell-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const root = await res.text();
    // The dropdown switches All repos ↔ a project; All repos is the landing selection.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);
    // The shell is client-rendered: it fetches the landing model and mounts the cards client-side.
    assert.match(root, /\/api\/landing/);
    assert.match(root, /id="cards"/);
    // The old server-rendered campaign body is retired from the landing — no issue chips here.
    assert.doesNotMatch(root, /#101 <small>/);
    assert.doesNotMatch(root, /#201 <small>/);

    // Selecting a project opens that project's campaign view (server-rendered for now).
    const alpha = await (
      await fetch(`http://127.0.0.1:${port}/?project=alpha`)
    ).text();
    assert.match(alpha, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/landing serves the all-repos landing model as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-landing-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"]],
      name: "alpha work",
      slots: 1,
    }),
    event("spawn", { ts: "2025-01-01T00:01:00.000Z", taskId: "101" }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["301"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });
  // Alpha's run is live: it holds a host slot (this test's own pid is alive), so its
  // in-flight #101 reads `running` rather than reconciling to `parked{crash}` — the live
  // liveness probe the landing route now consults (design §7, §8).
  registerProject(configDir, "alpha", 1, "campaign", { pid: process.pid });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/landing`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const landing = await res.json();
    // One card per registered project, read live off the registry, with the counters summed.
    assert.deepEqual(
      landing.projects.map((p: { project: string }) => p.project),
      ["alpha", "beta"],
    );
    assert.equal(landing.projects[0].campaignName, "alpha work");
    assert.equal(landing.projects[0].runState, "running");
    assert.deepEqual(Object.keys(landing.counters).sort(), [
      "mergedToday",
      "parked",
      "queued",
      "working",
    ]);
    // Alpha's issue 101 is running; alpha's 201 and beta's 301 are still queued — summed.
    assert.equal(landing.counters.working, 1);
    assert.equal(landing.counters.queued, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/feed serves the cross-project event feed as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-feed-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  // The live route reads the feed with a default `now`, so seed within the 48h
  // window (#101): campaign-start oldest, parked next, the merge newest.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  seedState(alphaDir, [
    event("campaign-start", {
      ts: hoursAgo(3),
      waves: [["101"]],
      name: "alpha work",
      slots: 1,
    }),
    event("green", { ts: hoursAgo(1), taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  seedState(betaDir, [
    event("parked", {
      ts: hoursAgo(2),
      taskId: "201",
      reason: "question",
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/feed`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const feed = await res.json();
    // The feed merges both projects newest-first, each row repo-prefixed.
    assert.deepEqual(
      feed.map((f: { text: string }) => f.text),
      [
        "alpha — #101 merged",
        "beta — #201 parked: question",
        "alpha — Campaign “alpha work” started",
      ],
    );
    assert.equal(feed[0].kind, "green");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue serves one issue's reconstructed detail as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      waves: [["101"]],
      titles: { "101": "Wire the parser" },
      name: "parser work",
      slots: 1,
    }),
    event("turn", {
      ts: "2025-05-01T08:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "Sketched the grammar and a red test.",
    }),
    event("parked", {
      ts: "2025-05-01T08:06:00.000Z",
      taskId: "101",
      reason: "question",
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const detail = await res.json();
    assert.equal(detail.project, "alpha");
    assert.equal(detail.issueNumber, "101");
    assert.equal(detail.status, "parked");
    assert.equal(detail.title, "Wire the parser");
    assert.equal(detail.campaignName, "parser work");
    assert.equal(detail.turns, 1);
    assert.equal(detail.elapsedMs, 5 * 60 * 1000);
    assert.deepEqual(
      detail.turnLog.map((t: { turn: number; summary: string }) => [
        t.turn,
        t.summary,
      ]),
      [[0, "Sketched the grammar and a red test."]],
    );
    // An unknown project is a 404, never a path joined from request input.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/api/issue?project=ghost&issue=101`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue carries the parked question and options for a parked issue", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-parked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      waves: [["101"]],
      titles: { "101": "Wire the parser" },
      slots: 1,
    }),
    event("turn", {
      ts: "2025-05-01T08:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "Sketched the grammar.",
    }),
    event("parked", {
      ts: "2025-05-01T08:06:00.000Z",
      taskId: "101",
      reason: "question",
    }),
  ]);
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "now",
      reason: "question",
      branch: "agent/101",
      sessionId: "s",
      question:
        "Which parser?\n\nOptions:\n- Recursive descent\n- Parser combinator",
    }),
  );
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)
    ).json();
    assert.equal(detail.status, "parked");
    // The sheet's reply block reads the question (its Options tail split off) and the parsed options.
    assert.deepEqual(detail.parked, {
      question: "Which parser?",
      options: ["Recursive descent", "Parser combinator"],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue omits parked reply data for a non-parked issue", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-unparked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
    event("green", {
      ts: "2025-05-01T08:02:00.000Z",
      taskId: "101",
      branch: "agent/101",
      commits: [],
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)
    ).json();
    // An unmerged green reads running with a pending green (§2.2); it is a non-parked issue,
    // so the reply data is still omitted.
    assert.equal(detail.status, "running");
    assert.equal(detail.parked, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("drainFrames parses two coalesced SSE frames' data payloads individually (#272)", () => {
  // A single reader.read() delivering two `\n\n`-terminated data frames at once —
  // the coalescing that reds the merged-base gate. Each payload must be parsed on
  // its own, not joined into `{…}{…}` and handed to JSON.parse as one string.
  const frameA = `data: ${JSON.stringify({ project: "alpha", events: [{ event: "turn" }] })}\n\n`;
  const frameB = `data: ${JSON.stringify({ project: "beta", events: [{ event: "green" }] })}\n\n`;
  const { payloads, rest } = drainFrames(frameA + frameB);
  assert.deepEqual(
    payloads.map((p) => p.project),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    payloads.flatMap((p) => (p.events ?? []).map((e) => e.event)),
    ["turn", "green"],
  );
  assert.equal(rest, "");
});

test("drainFrames skips the comment handshake frame and returns an incomplete tail (#272)", () => {
  // The product's opening frame is `retry: 3000\n: connected\n\n` (no `data:` line);
  // a trailing partial frame must be held back as `rest`, not parsed.
  const handshake = "retry: 3000\n: connected\n\n";
  const dataFrame = `data: ${JSON.stringify({ project: "alpha", events: [{ event: "turn" }] })}\n\n`;
  const { payloads, rest } = drainFrames(handshake + dataFrame + "data: {partial");
  assert.deepEqual(
    payloads.map((p) => p.project),
    ["alpha"],
  );
  assert.equal(rest, "data: {partial");
});

test("serveAllStatus GET /api/events streams a project's log appends as SSE frames", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Read until at least one more complete SSE frame (blank-line terminated) is buffered,
  // then return every complete frame's parsed `data:` payload (a comment/handshake-only
  // frame yields []). Coalesced frames are drained individually via drainFrames, so a
  // read that delivers two frames at once never mis-joins them into `{…}{…}` (#272).
  const nextPayloads = async (): Promise<EventPayload[]> => {
    while (!buf.includes("\n\n")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for SSE frame")),
            4000,
          ),
        ),
      ]);
      if (chunk.done) throw new Error("stream closed before a frame arrived");
      buf += decoder.decode(chunk.value, { stream: true });
    }
    const { payloads, rest } = drainFrames(buf);
    buf = rest;
    return payloads;
  };
  try {
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // The opening handshake frame flushes headers and, crucially, means the watcher is now armed.
    await nextPayloads();
    // A fresh append to alpha's live log is pushed as a data frame carrying the project and the new event.
    appendFileSync(
      join(alphaDir, "logs", "orchestrator.jsonl"),
      JSON.stringify(event("turn", { taskId: "101", turn: 0, summary: "" })) + "\n",
    );
    let payload: EventPayload = {};
    // fs.watch can coalesce or emit a bare change with no new bytes; keep reading data frames until one carries the append.
    for (let i = 0; i < 5 && !payload.events?.length; i++) {
      payload = (await nextPayloads()).find((p) => p.events?.length) ?? payload;
    }
    assert.equal(payload.project, "alpha");
    assert.deepEqual(
      (payload.events ?? []).map((e) => e.event),
      ["turn"],
    );
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/events debounces a burst of appends into one frame (#131)", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-debounce-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const { reader, collect } = await openEventStream(port);
  try {
    const logPath = join(alphaDir, "logs", "orchestrator.jsonl");
    // One continuous read; the burst is scheduled to land after the watcher has armed but
    // well inside one debounce window (three separate appends, each a distinct fs.watch trigger).
    setTimeout(async () => {
      for (let i = 0; i < 3; i++) {
        appendFileSync(logPath, JSON.stringify(event("turn", { taskId: "101", turn: i, summary: "" })) + "\n");
        await new Promise((r) => setTimeout(r, 30));
      }
    }, 250);
    // Read well past the burst + debounce window so a second frame, if one were emitted, would show.
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "a burst within the debounce window coalesces to a single frame");
    assert.deepEqual((frames[0].events ?? []).map((e) => e.turn), [0, 1, 2], "the single frame carries every appended event, in order");
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/events emits no frame for a pure machine-noise append (#131)", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-noise-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const { reader, collect } = await openEventStream(port);
  try {
    const logPath = join(alphaDir, "logs", "orchestrator.jsonl");
    // A noise line then a real one in the same window: the read that the `green` guarantees
    // also sees the noise line, so the surviving frame proves the noise was stripped — a
    // deterministic check that doesn't hinge on whether fs.watch fired for the noise alone.
    setTimeout(async () => {
      appendFileSync(logPath, JSON.stringify(noise({ event: "telegram-send-failed", chatId: "42" })) + "\n");
      await new Promise((r) => setTimeout(r, 30));
      appendFileSync(logPath, JSON.stringify(event("green", { taskId: "101", branch: "agent/101", commits: [] })) + "\n");
    }, 250);
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "only the view-relevant append surfaces a frame");
    assert.deepEqual((frames[0].events ?? []).map((e) => e.event), ["green"], "the denylisted noise event never reaches the client");
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus renders a single registered project as a one-entry dropdown with campaign, wave and parked intact", async () => {
  const configDir = join(tmpdir(), `vetinari-serve-solo-${Date.now()}`);
  const soloDir = join(configDir, "state-solo");
  seedState(soloDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
  ]);
  // A parked issue in the active campaign — the single-project view keeps its parked card.
  writeFileSync(
    join(soloDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "now",
      reason: "question",
      branch: "agent/101",
      sessionId: "s",
      question: "Need a choice.",
    }),
  );
  register(configDir, {
    project: "solo",
    projectRoot: join(configDir, "solo-root"),
    baseLocation: soloDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    // A no-gateway, single-project user opens that project's campaign view (ADR 0006).
    const solo = await (
      await fetch(`http://127.0.0.1:${port}/?project=solo`)
    ).text();
    assert.match(solo, /<select name="project"/);
    assert.match(solo, /<option value="solo" selected>/);
    // Its own campaign wave and parked card render intact; the reply happens in the
    // sheet, whose /answer form is present.
    assert.match(solo, /#101 <small>/);
    assert.match(solo, /Parked · <span class="parked-count">1<\/span>/);
    assert.match(
      solo,
      /<a class="parked-card"[^>]*data-issue="101" data-project="solo"/,
    );
    assert.match(
      solo,
      /<form method="post" action="\/answer" id="reply-form">/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /prune on confirm shells prune in the selected project's root", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-prune-confirm-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const spawned: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (_cmd, args, options) => spawned.push({ args, cwd: options.cwd }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/prune`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        taskId: "401",
        project: "beta",
        confirm: "1",
      }).toString(),
    });
    // Redirects back to the selected project's dashboard, like the answer control.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Executes the no-plan prune (ticket B) against the SELECTED project's own root
    // — so the shared install loads beta's config and gates, not alpha's.
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(-2), ["prune", "401"]);
    assert.equal(spawned[0].cwd, join(configDir, "beta-root"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /redrive shells redrive in the selected project's root", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-redrive-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  // Beta campaign-parked (greens merged, base gated red, campaign paused) — the state the
  // Redrive control acts on. Alpha is a plain running campaign, untouched.
  seedState(alphaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
  ]);
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201", "202"], ["401"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["201", "202"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "201", branch: "agent/201", commits: [] }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "202", branch: "agent/202", commits: [] }),
    event("campaign-parked", { ts: "2025-01-01T00:04:00.000Z", index: 0, detail: "npm test failed" }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const spawned: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (_cmd, args, options) => spawned.push({ args, cwd: options.cwd }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/redrive`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "beta" }).toString(),
    });
    // Redirects back to the selected project's board, like prune/answer.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Shells `redrive` against the SELECTED project's own root (dumb router, ADR 0002),
    // so the shared install picks beta's unfinished campaign back up in beta's log.
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(-1), ["redrive"]);
    assert.equal(spawned[0].cwd, join(configDir, "beta-root"));
    // The retired /resume path no longer routes — it 404s.
    const gone = await fetch(`http://127.0.0.1:${port}/resume`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "beta" }).toString(),
    });
    assert.equal(gone.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /redrive validates the project (400 missing, 404 unknown)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-redrive-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const spawned: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing project → 400, matching the prune route's error contract.
    const missing = await fetch(`http://127.0.0.1:${port}/redrive`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}).toString(),
    });
    assert.equal(missing.status, 400);
    // Unknown project → 404.
    const unknown = await fetch(`http://127.0.0.1:${port}/redrive`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "ghost" }).toString(),
    });
    assert.equal(unknown.status, 404);
    // Neither validation failure shells anything.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /prune?preview returns the selected project's structured closure as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-prune-json-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const closures: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  // The structured closure (E2) the confirmation renders: the target and dropped
  // dependents that would leave, the banked work kept, and the remaining waves.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    remaining: [] as string[][],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the closure to the selected project's own install,
    // which computes it against that project's real blockedBy graph.
    pruneClosure: (projectRoot, taskId) => {
      closures.push({ projectRoot, taskId });
      return Promise.resolve(structured);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/prune?preview&taskId=201&project=beta`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    // The endpoint returns the full structured closure the panel discloses —
    // dropped, kept-banked, and remaining all reach the client verbatim.
    assert.deepEqual(await res.json(), structured);
    // The closure came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(closures, [
      { projectRoot: join(configDir, "beta-root"), taskId: "201" },
    ]);
    // A preview computes nothing destructive — no prune is spawned.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /prune?preview validates params and the project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-prune-json-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    pruneClosure: () =>
      Promise.resolve({
        target: "201",
        dropped: ["201"],
        keptBanked: [],
        remaining: [],
      }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing taskId/project → 400.
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/prune?preview&project=beta`))
        .status,
      400,
    );
    // Unknown project → 404.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/prune?preview&taskId=201&project=ghost`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /prune previews the selected project's closure without executing", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-prune-preview-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const previews: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the preview to the selected project's own install,
    // which computes the closure against that project's real blockedBy graph.
    prunePreview: (projectRoot, taskId) => {
      previews.push({ projectRoot, taskId });
      return Promise.resolve(
        `prune #201 → dropping #201, #401\nremaining campaign: (nothing left to run)`,
      );
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/prune`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskId: "201", project: "beta" }).toString(),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // The preview came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(previews, [
      { projectRoot: join(configDir, "beta-root"), taskId: "201" },
    ]);
    // It shows the shelled closure and a confirm affordance carrying the project.
    assert.match(html, /#401/);
    assert.match(
      html,
      /<form method="post" action="\/prune"[\s\S]*?name="confirm"/,
    );
    assert.match(html, /name="project" value="beta"/);
    assert.match(html, /name="taskId" value="201"/);
    // Nothing has been pruned yet — preview executes nothing.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /graft shells graft directly for a clean batch — no confirm gate (#202)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-direct-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
  ]);
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const children: { args: string[]; cwd: string }[] = [];
  let dryRunClosures = 0;
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    // Option 1a acts on submit: it shells the SELECTED project's own real `graft --json`
    // and awaits it (#367) — no pre-validation dry-run. A clean (code 0) exit stands in for
    // beta's install accepting both ids and appending the graft event.
    runChild: (projectRoot, args) => {
      children.push({ args, cwd: projectRoot });
      return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
    },
    graftClosure: () => (dryRunClosures++, Promise.resolve(null)),
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/graft`, {
      method: "POST",
      redirect: "manual",
      // No `confirm` field — 1a acts on submit, confirming on the wave, not via a form.
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ids: "640 655", project: "beta" }).toString(),
    });
    // The response comes back only once the child has exited — then redirects to the board.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Shells the variadic real `graft <ids…> --json` against beta's own root, exactly once,
    // and never a pre-validation dry-run (acceptance: a clean submit grafts once).
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].args, ["graft", "640", "655", "--json"]);
    assert.equal(children[0].cwd, join(configDir, "beta-root"));
    assert.equal(dryRunClosures, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview returns the selected project's structured closure as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-json-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
  ]);
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const closures: { projectRoot: string; taskIds: string[] }[] = [];
  const spawned: unknown[] = [];
  // The structured closure the confirmation renders: the requested ids, where each
  // lands, the resulting waves, and any rejection.
  const structured = {
    ids: ["640", "655"],
    placement: [
      { id: "640", wave: 2 },
      { id: "655", wave: 2 },
    ],
    remaining: [["201"], ["640", "655"]],
    rejected: [],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    graftClosure: (projectRoot, taskIds) => {
      closures.push({ projectRoot, taskIds });
      return Promise.resolve(structured);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/graft?preview&ids=${encodeURIComponent("640 655")}&project=beta`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), structured);
    // The closure came from the selected project's install (beta's root), carrying the
    // full set of ids parsed off the query — not alpha's.
    assert.deepEqual(closures, [{ projectRoot: join(configDir, "beta-root"), taskIds: ["640", "655"] }]);
    // A preview computes nothing destructive — no graft is spawned.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview validates params and the project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-json-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    graftClosure: () => Promise.resolve({ ids: ["640"], placement: [{ id: "640", wave: 2 }], remaining: [], rejected: [] }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing ids/project → 400.
    assert.equal((await fetch(`http://127.0.0.1:${port}/graft?preview&project=beta`)).status, 400);
    // Unknown project → 404.
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/graft?preview&ids=640&project=ghost`)).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview 502s when the project emits no closure line", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-502-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    // No campaign running / an install predating the closure → null → 502.
    graftClosure: () => Promise.resolve(null),
  });
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/graft?preview&ids=640&project=beta`)).status,
      502,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /graft rejects a whole batch with per-id verdicts and grafts nothing (#202)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-reject-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const children: { projectRoot: string; args: string[] }[] = [];
  // beta's real graft rejects the whole batch: #202 is already in the campaign, so per
  // ADR 0014 *nothing* grafts. It exits non-zero and prints the `graft-closure {json}` line
  // (dispatchGraft under --json) — exactly what the route reads to 422.
  const rejectionClosure = {
    project: "beta",
    ids: ["640", "202"],
    placement: [],
    remaining: [["201"]],
    rejected: [{ id: "202", reason: "already-in-campaign" as const }],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    runChild: (projectRoot, args) => {
      children.push({ projectRoot, args });
      return Promise.resolve({
        code: 1,
        stdout: `graft rejected — nothing added (already in the campaign: #202).\ngraft-closure ${JSON.stringify(rejectionClosure)}`,
        stderr: "",
        timedOut: false,
      });
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/graft`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ids: "640 202", project: "beta" }).toString(),
    });
    // A rejection is surfaced inline (422), never a redirect — the operator stays put.
    assert.equal(res.status, 422);
    const html = await res.text();
    // The real graft ran once against the selected project's install (beta's root).
    assert.deepEqual(children, [{ projectRoot: join(configDir, "beta-root"), args: ["graft", "640", "202", "--json"] }]);
    // Per-id verdicts under the "Nothing grafted" header — the clean id "would graft",
    // the offender names its reason — and the typed ids are retained for correction.
    assert.match(html, /Nothing grafted/i);
    assert.match(html, /#640 — would graft/);
    assert.match(html, /#202 — already in the campaign/);
    assert.match(html, /data-graft-ids="640 202"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus flags the selected project's prunable chips with its project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-prune-control-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A running campaign whose future wave (401) is still prunable.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"], ["401"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["201"],
    }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    // The unstarted future-wave row is flagged prunable and carries beta, so the
    // panel's Prune routes preview and confirm to beta's own install.
    assert.match(
      html,
      /class="wave-member [a-z]+"[^>]*data-issue="401"[^>]*data-project="beta"[^>]*data-prunable="1"/,
    );
    // No inline prune control on the row itself.
    assert.doesNotMatch(html, /✂️/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus lists a project's archived runs and renders one read-only when a run is selected", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-archive-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run still in flight.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"]],
      slots: 1,
    }),
  ]);
  // Two archived runs plus a malformed one that must be skipped.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["101"], ["102"]], slots: 1 }),
    event("campaign-done", { waves: 2 }),
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["111"]], slots: 1 }),
    event("wave-start", { index: 0, tasks: ["111"] }),
  ]);
  writeFileSync(
    join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"),
    "garbage\n{",
  );
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    // The collapsible archived-runs list shows both good runs, newest-first; the live
    // run (201) still renders at the top.
    assert.match(root, /#201 <small>/);
    assert.match(root, /<section class="archived-runs">/);
    // Each row carries its token, state (a stalled run stopped short — a campaign-start
    // with no terminal event, ADR 0019) and issue count; unnamed runs fall back to the
    // token as the label.
    assert.match(
      root,
      /<li data-run="2026-02-01T00-00-00-000Z">/,
    );
    assert.match(root, /<span class="lv-verb">stalled · 1 issue<\/span>/);
    assert.match(
      root,
      /<li data-run="2026-01-01T00-00-00-000Z">/,
    );
    assert.match(root, /<span class="lv-verb">complete · 2 issues<\/span>/);
    assert.ok(
      root.indexOf("2026-02-01") < root.indexOf("2026-01-01"),
      "newest-first",
    );
    // The malformed run is skipped, never listed.
    assert.doesNotMatch(root, /2026-03-01/);
    // No run selected → every row starts collapsed.
    assert.doesNotMatch(root, /<li class="open" data-run=/);
    // No run-level raw/log pane rides any row — the detail is the wave cards only (#222).
    assert.doesNotMatch(root, /archive-raw/);
    assert.doesNotMatch(root, /data-pane=/);

    // Selecting a run opens that row on load (a ?run= deep-link).
    const withRun = await (
      await fetch(
        `http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z`,
      )
    ).text();
    assert.match(withRun, /#201 <small>/); // live run still on top
    assert.match(
      withRun,
      /<li class="open" data-run="2026-01-01T00-00-00-000Z">/,
    );
    assert.match(withRun, /#101 <small>/); // the archived run's own issues, in its body
    // Read-only: the archived run's chips are never prunable (a finished run has
    // nothing to prune).
    assert.doesNotMatch(withRun, /data-issue="101"[^>]*data-prunable/);

    // A stale ?mode=raw param no longer means anything — the run opens normally, no
    // error and no raw pane (#222).
    const staleMode = await fetch(
      `http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z&mode=raw`,
    );
    assert.equal(staleMode.status, 200);
    const staleModeHtml = await staleMode.text();
    assert.match(
      staleModeHtml,
      /<li class="open" data-run="2026-01-01T00-00-00-000Z">/,
    );
    assert.match(staleModeHtml, /#101 <small>/); // wave cards, as normal
    assert.doesNotMatch(staleModeHtml, /archive-raw/);

    // A run not present in the archive listing is rejected — no row opens.
    const bogus = await fetch(
      `http://127.0.0.1:${port}/?project=beta&run=..%2F..%2Forchestrator`,
    );
    assert.equal(bogus.status, 200);
    assert.doesNotMatch(await bogus.text(), /<li class="open" data-run=/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus reconstructs a pruned issue in a selected archived run, read-only", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-archive-pruned-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run over an unrelated issue, so the only pruned chip on the page is the
  // archived run's.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["900"]],
      slots: 1,
    }),
  ]);
  // An archived run that pruned an unstarted dependent (201) out of its plan: 101
  // banked, 201 dropped by the prune, then the campaign finished.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-04-01T00:00:00.000Z",
      waves: [["101"], ["201"]],
      name: "spring cleanup",
      slots: 1,
    }),
    event("green", {
      ts: "2026-04-01T00:01:00.000Z",
      taskId: "101",
      branch: "agent/101",
      commits: [],
    }),
    event("prune", {
      ts: "2026-04-01T00:02:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: [],
    }),
    event("campaign-done", { ts: "2026-04-01T00:03:00.000Z", waves: 2 }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (
      await fetch(
        `http://127.0.0.1:${port}/?project=beta&run=2026-04-01T00-00-00-000Z`,
      )
    ).text();
    // The archived run renders under its --name in the collapsible list…
    assert.match(html, /<span class="lv-lead">spring cleanup<\/span>/);
    // …and its campaign pane reconstructs the pruned-out 201 as a chip in the wave it
    // left: its lifecycle dot/word read `unstarted`, and it carries the `pruned` membership
    // badge, so an operator sees what the run was pruned down to (ADR 0007/0019).
    assert.match(
      html,
      /<span class="dot unstarted"><\/span>#201 <span class="member-badge pruned">pruned<\/span><small>unstarted<\/small>/,
    );
    // Read-only: the archived pruned chip (#201) is never prunable.
    assert.doesNotMatch(html, /data-issue="201"[^>]*data-prunable/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue reads an archived run's own log when a run token is given", async () => {
  const configDir = join(tmpdir(), `vetinari-api-issue-archive-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // The live log names 101 nowhere — its detail lives only in the archived run.
  seedState(betaDir, [event("campaign-start", { waves: [["900"]], slots: 1 })]);
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["101"]], titles: { "101": "old work" }, slots: 1 }),
    event("turn", {
      ts: "2026-01-01T00:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "did the thing",
    }),
    event("green", { ts: "2026-01-01T00:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("wave-done", { ts: "2026-01-01T00:03:00.000Z", index: 0, merged: ["101"] }),
    event("campaign-done", { waves: 1 }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    // With the run token, the detail is reconstructed from the archived log: its
    // title, completed status, and the archived turn appear, flagged read-only.
    const withRun = await (
      await fetch(
        `http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=2026-01-01T00-00-00-000Z`,
      )
    ).json();
    assert.equal(withRun.status, "completed");
    assert.equal(withRun.title, "old work");
    assert.equal(withRun.archived, true);
    assert.equal(withRun.turnLog.length, 1);
    assert.equal(withRun.turnLog[0].summary, "did the thing");

    // Without a run token it reads the live log, where 101 is unknown → unstarted.
    const live = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=beta&issue=101`)
    ).json();
    assert.equal(live.status, "unstarted");
    assert.equal(live.turnLog.length, 0);

    // An unlisted run token is rejected, never a path to traverse.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=..%2F..%2Forchestrator`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus no longer serves GET /archive/log — the route is removed (#222)", async () => {
  const configDir = join(tmpdir(), `vetinari-archive-log-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { waves: [["201"]], slots: 1 })]);
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const raw =
    [
      event("campaign-start", { waves: [["101"], ["102"]], slots: 1 }),
      event("campaign-done", { waves: 2 }),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
  writeFileSync(
    join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"),
    raw,
  );
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    // The archive raw pane was the endpoint's only consumer; with it gone the route is
    // deleted, so even a listed run's log path is now an unhandled 404 (#222).
    const gone = await fetch(
      `http://127.0.0.1:${port}/archive/log?project=beta&run=2026-01-01T00-00-00-000Z`,
    );
    assert.equal(gone.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(
    String(serveAllStatus),
    /server\.listen\(opts\.port,\s*opts\.host,/,
  );
});
