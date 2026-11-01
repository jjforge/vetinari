// Tests for the aggregated status server and its HTTP routes (status.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardRequestDenial, event, serveAllStatus, type OrchestratorEvent } from "./status.ts";
import type { RouteHandler } from "./dashboard-http.ts";
import { memoryLogger } from "./log.ts";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { register } from "./registry.ts";
import { registerProject } from "./lease.ts";
import { issueMoves } from "./dashboard-visual-state.ts";
import { withEnv } from "./test-support.ts";

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

const writeJsonl = (path: string, events: unknown[]) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

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

    const beta = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    assert.match(beta, /<option value="beta" selected>/);
    // Beta's own campaign (issue 201) renders in the body, not alpha's issue 101.
    assert.match(beta, /#201 <small>/);
    assert.doesNotMatch(beta, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the project page flags a budget overrun read from the log alone, and shows no Slow gates section when none is flagged (#445)", async () => {
  const configDir = join(tmpdir(), `vetinari-slow-gates-page-${Date.now()}`);
  const slowDir = join(configDir, "state-slow");
  const calmDir = join(configDir, "state-calm");
  const start = event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 });
  // The budget lives only on the logged gate-result — the gateway never loads the project config.
  seedState(slowDir, [start, event("gate-result", { cmd: "make test", exitCode: 2, seconds: 601, outFile: "o", budgetSeconds: 300 })]);
  seedState(calmDir, [start, event("gate-result", { cmd: "make test", exitCode: 0, seconds: 60, outFile: "o", budgetSeconds: 300 })]);
  register(configDir, { project: "slow", projectRoot: join(configDir, "slow-root"), baseLocation: slowDir });
  register(configDir, { project: "calm", projectRoot: join(configDir, "calm-root"), baseLocation: calmDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const slow = await (await fetch(`http://127.0.0.1:${port}/?project=slow`)).text();
    assert.match(slow, /<h2>Slow gates<\/h2>/);
    assert.match(slow, /<code>make test<\/code> — 1 of 1 run this campaign went over its 300s budget/);
    const calm = await (await fetch(`http://127.0.0.1:${port}/?project=calm`)).text();
    assert.doesNotMatch(calm, /<section class="slow-gates">/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("GET /api/host-log serves the host log newest-first as raw JSONL lines; a missing file reads empty (#180)", async () => {
  const configDir = join(tmpdir(), `vetinari-hostlog-route-${Date.now()}`);
  const gwHome = join(configDir, "gw-home");
  await withEnv({ VETINARI_GATEWAY_HOME: gwHome }, async () => {
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
  });
});

test("GET /healthz serves the health source's object as JSON with a 200; with no health source it is a 404", async () => {
  const configDir = join(tmpdir(), `vetinari-healthz-${Date.now()}`);
  const body = { stale: true, announce: { lastTick: null, stale: true }, bots: [] };
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", health: () => body });
  const bare = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
    assert.equal(res.status, 200, "200 even when stale — the flag carries the verdict");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), body);

    const missing = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/healthz`);
    assert.equal(missing.status, 404, "the standalone status server has no health source");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bare.close(() => r()));
  }
});

test("serveAllStatus answers a POST body over 64 KiB with a plain 413, not a 500 with a stack", async () => {
  const configDir = join(tmpdir(), `vetinari-body-cap-${Date.now()}`);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `text=${"a".repeat(70000)}`,
    });
    assert.equal(res.status, 413);
    const text = await res.text();
    assert.match(text, /too large/);
    assert.doesNotMatch(text, /\n\s+at /, "no stack trace in the response");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus sends nosniff, no-referrer and one nonce-only CSP on HTML, JSON and SSE responses, keeping each content-type (#600)", async () => {
  const configDir = join(tmpdir(), `vetinari-security-headers-${Date.now()}`);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const nonces: string[] = [];
  try {
    for (const [path, type] of [
      ["/", "text/html; charset=utf-8"],
      ["/api/landing", "application/json"],
      ["/api/events", "text/event-stream; charset=utf-8"],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.headers.get("content-type"), type, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
      // fetch joins repeated headers with ", "; a CSP holds none, so a comma means two were sent.
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.ok(csp && !csp.includes(","), `${path}: exactly one CSP, got ${JSON.stringify(csp)}`);
      const directives = csp.split(";").map((d) => d.trim().split(/\s+/));
      const sources = directives.flatMap(([, ...s]) => s);
      assert.ok(
        directives.some(([name, ...s]) => name === "frame-ancestors" && s.join(" ") === "'none'"),
        path,
      );
      assert.ok(!sources.some((s) => s === "*" || /^https?:/.test(s)), `${path}: no external source in ${csp}`);
      assert.ok(!csp.includes("'unsafe-inline'"), `${path}: no 'unsafe-inline' in ${csp}`);
      // Scripts and styles run only under this response's one nonce, the same for both.
      const scripts = directives.find(([name]) => name === "script-src") ?? [];
      const styles = directives.find(([name]) => name === "style-src") ?? [];
      assert.equal(scripts.length, 2, `${path}: one script source in ${csp}`);
      assert.match(scripts[1], /^'nonce-[A-Za-z0-9+/]{22,}={0,2}'$/, `${path}: scripts only by nonce`);
      assert.deepEqual(styles.slice(1), scripts.slice(1), `${path}: styles by the same nonce`);
      nonces.push(scripts[1]);
      await res.body?.cancel();
    }
    assert.equal(new Set(nonces).size, nonces.length, `a fresh nonce per response: ${nonces.join(" ")}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Every `<script>`/`<style>` start tag in a served page must carry that response's CSP nonce,
// and no element an inline `on…=` handler, which no nonce can admit (#600).
const assertPageNonced = async (res: Response, label: string) => {
  const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
  assert.ok(nonce, `${label}: a CSP nonce`);
  const html = await res.text();
  const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
  assert.ok(tags.length, `${label}: has inline blocks`);
  for (const tag of tags) assert.ok(tag.includes(` nonce="${nonce}"`), `${label}: ${tag} carries the response nonce`);
  assert.doesNotMatch(html, /\son[a-z]+=/, `${label}: no inline event handler`);
  return html;
};

test("serveAllStatus nonces every inline script and style on each page it serves, with no inline handlers (#600)", async () => {
  const configDir = join(tmpdir(), `vetinari-csp-nonce-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A pruned wave, so the project page also emits its `<noscript><style>` fallback.
  seedState(betaDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"], ["401"]], slots: 1 }),
    event("prune", { ts: "2025-01-01T00:01:00.000Z", target: "401", removed: ["401"], dropped: [] }),
  ]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });
  const rejection = {
    project: "beta",
    ids: ["202"],
    placement: [],
    remaining: [["201"]],
    rejected: [{ id: "202", reason: "already-in-campaign" }],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    prunePreview: () => Promise.resolve("prune #201 → dropping #201"),
    // Only POST /graft runs a child here; a closure line on a non-zero exit is its 422 page.
    runChild: () => Promise.resolve({ code: 1, stdout: `graft-closure ${JSON.stringify(rejection)}`, stderr: "", timedOut: false }),
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string, form: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  try {
    await assertPageNonced(await fetch(`http://127.0.0.1:${port}/`), "landing");
    const project = await assertPageNonced(await fetch(`http://127.0.0.1:${port}/?project=beta`), "project page");
    assert.match(project, /<noscript><style nonce=/, "project page: the no-JS fallback style is present");
    // The no-JS picker still renders its select and options, only without the dead handler.
    assert.match(project, /<noscript>[^]*?<select name="project"><option value=""[^>]*>All repos<\/option><option value="beta"/);
    const prune = await post("/prune", { taskId: "201", project: "beta" });
    assert.equal(prune.status, 200);
    await assertPageNonced(prune, "prune preview");
    const graft = await post("/graft", { ids: "202", project: "beta" });
    assert.equal(graft.status, 422);
    await assertPageNonced(graft, "graft rejection");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus refuses to be framed — X-Frame-Options DENY and CSP frame-ancestors 'none' — on page, API, SSE, 403 and 404 responses (#525)", async () => {
  const configDir = join(tmpdir(), `vetinari-no-framing-${Date.now()}`);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  // `fetch` silently replaces a caller-set Host, so every request goes out by node:http; the
  // response is read for its head only and then dropped, which also ends the SSE stream.
  const headUnder = (path: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; frameOptions: unknown; csp: unknown }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        resolve({ status: res.statusCode ?? 0, frameOptions: res.headers["x-frame-options"], csp: res.headers["content-security-policy"] });
        req.destroy();
      });
      req.on("error", reject).end();
    });
  try {
    for (const [path, status, host] of [
      ["/", 200],
      ["/api/landing", 200],
      ["/api/events", 200],
      ["/api/status", 403, `evil.example:${port}`],
      ["/no-such-page", 404],
    ] as const) {
      const head = await headUnder(path, host);
      assert.equal(head.status, status, path);
      assert.equal(head.frameOptions, "DENY", `${path}: X-Frame-Options`);
      assert.equal(typeof head.csp, "string", `${path}: exactly one CSP header`);
      assert.match(head.csp as string, /(^|;)\s*frame-ancestors 'none'\s*(;|$)/, `${path}: CSP frame-ancestors`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus sends error bodies that echo request input as text/plain, never untyped", async () => {
  const configDir = join(tmpdir(), `vetinari-error-type-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [res, body] of [
      [await fetch(`${base}/no-such-page`), "not found"],
      [await fetch(`${base}/api/issue?project=alpha&issue=101&run=ghost-run`), "unknown run: ghost-run"],
      [
        await fetch(`${base}/answer`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "taskId=101&text=hi&project=ghost",
        }),
        "unknown project: ghost",
      ],
    ] as const) {
      assert.equal(res.status, 404, body);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", body);
      assert.equal(await res.text(), body);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
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
    const alpha = await (await fetch(`http://127.0.0.1:${port}/?project=alpha`)).text();
    assert.match(alpha, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET / labels the repo dropdown with the registered owner/name, reading no git remote", async () => {
  const configDir = join(tmpdir(), `vetinari-dropdown-repo-${Date.now()}`);
  const stateDir = join(configDir, "state-alpha");
  seedState(stateDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  // The root is not a git repo, so the label can only come from the registered pointer.
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: stateDir, repo: "o/r" });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    for (const path of ["/", "/?project=alpha"]) {
      const page = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
      assert.match(page, /data-project="alpha"[^>]*>.*?<span class="repo-optlabel">o\/r<\/span>/, path);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /?project= names the checkout's branch in the Redrive confirm dialog", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-redrive-base-"));
  const stateDir = join(configDir, "state-alpha");
  // A gracefully stopped campaign with no live lease — the only time the Redrive dialog renders.
  seedState(stateDir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"], ["201"]], slots: 1 }),
    event("wave-done", { ts: "2025-01-01T01:00:00.000Z", index: 0, merged: ["101"] }),
    event("campaign-parked", { ts: "2025-01-01T01:00:01.000Z", index: 1, reason: "stopped" }),
  ]);
  const projectRoot = join(configDir, "alpha-root");
  mkdirSync(projectRoot);
  const git = (...args: string[]) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "trunk");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  register(configDir, { project: "alpha", projectRoot, baseLocation: stateDir });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/?project=alpha`)).text();
    assert.match(page, /<dialog class="redrive-dialog" data-redrive-dialog>/);
    assert.match(page, /on <code>trunk<\/code>/);
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
  registerProject(configDir, "alpha", 1, "campaign", 1, { pid: process.pid });

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
    assert.deepEqual(Object.keys(landing.counters).sort(), ["mergedToday", "parked", "queued", "working"]);
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
      ["alpha — #101 merged", "beta — #201 parked: question", "alpha — Campaign “alpha work” started"],
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
    const res = await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`);
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
      detail.turnLog.map((t: { turn: number; summary: string }) => [t.turn, t.summary]),
      [[0, "Sketched the grammar and a red test."]],
    );
    // An unknown project is a 404, never a path joined from request input.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/issue?project=ghost&issue=101`)).status, 404);
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
      question: "Which parser?\n\nOptions:\n- Recursive descent\n- Parser combinator",
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
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)).json();
    assert.equal(detail.status, "parked");
    // The sheet's reply block reads the question (its Options tail split off) and the parsed options.
    assert.deepEqual(detail.parked, {
      question: "Which parser?",
      options: ["Recursive descent", "Parser combinator"],
    });
    // Unanswered: no answer on the payload, and the sheet still offers its reply.
    assert.equal(detail.answer, undefined);
    assert.equal(issueMoves(detail).reply, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const live of [true, false]) {
  test(`serveAllStatus GET /api/issue carries an answered issue's answer and answeredAt, so the sheet offers no reply (${live ? "live campaign: reads running · answered" : "no live campaign: reads parked"})`, async () => {
    const configDir = join(tmpdir(), `vetinari-issue-answered-${live}-${Date.now()}`);
    const alphaDir = join(configDir, "state-alpha");
    seedState(alphaDir, [
      event("campaign-start", { ts: "2025-05-01T08:00:00.000Z", waves: [["101"]], slots: 1 }),
      event("spawn", { ts: "2025-05-01T08:00:30.000Z", taskId: "101", running: 1, left: 0 }),
      event("parked", { ts: "2025-05-01T08:06:00.000Z", taskId: "101", reason: "question" }),
      event("answered", { ts: "2025-05-01T08:09:00.000Z", taskId: "101", source: "ui" }),
    ]);
    writeFileSync(
      join(alphaDir, "parked", "101.json"),
      JSON.stringify({
        taskId: "101",
        parkedAt: "2025-05-01T08:06:00.000Z",
        reason: "question",
        branch: "agent/101",
        sessionId: "s",
        question: "Which parser?",
        answer: "Recursive descent",
        answeredAt: "2025-05-01T08:09:00.000Z",
      }),
    );
    register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
    if (live) registerProject(configDir, "alpha", 1, "campaign", 1, { pid: process.pid });

    const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
    const { port } = server.address() as AddressInfo;
    try {
      const detail = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)).json();
      assert.equal(detail.answer, "Recursive descent");
      assert.equal(detail.answeredAt, "2025-05-01T08:09:00.000Z");
      if (live) {
        assert.equal(detail.status, "running");
        assert.deepEqual(detail.phase, { label: "answered", steady: true });
      } else {
        assert.equal(detail.status, "parked");
        assert.equal(detail.reason, "question");
      }
      assert.equal(issueMoves(detail).reply, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

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
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)).json();
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
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE frame")), 4000)),
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
    const burst = async () => {
      for (let i = 0; i < 3; i++) {
        appendFileSync(logPath, JSON.stringify(event("turn", { taskId: "101", turn: i, summary: "" })) + "\n");
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    setTimeout(() => void burst(), 250);
    // Read well past the burst + debounce window so a second frame, if one were emitted, would show.
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "a burst within the debounce window coalesces to a single frame");
    assert.deepEqual(
      (frames[0].events ?? []).map((e) => e.turn),
      [0, 1, 2],
      "the single frame carries every appended event, in order",
    );
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
    const noiseThenGreen = async () => {
      appendFileSync(logPath, JSON.stringify(noise({ event: "telegram-send-failed", chatId: "42" })) + "\n");
      await new Promise((r) => setTimeout(r, 30));
      appendFileSync(logPath, JSON.stringify(event("green", { taskId: "101", branch: "agent/101", commits: [] })) + "\n");
    };
    setTimeout(() => void noiseThenGreen(), 250);
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "only the view-relevant append surfaces a frame");
    assert.deepEqual(
      (frames[0].events ?? []).map((e) => e.event),
      ["green"],
      "the denylisted noise event never reaches the client",
    );
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
    const solo = await (await fetch(`http://127.0.0.1:${port}/?project=solo`)).text();
    assert.match(solo, /<select name="project"/);
    assert.match(solo, /<option value="solo" selected>/);
    // Its own campaign wave and parked card render intact; the reply happens in the
    // sheet, whose /answer form is present.
    assert.match(solo, /#101 <small>/);
    assert.match(solo, /Parked · <span class="parked-count">1<\/span>/);
    assert.match(solo, /<a class="parked-card"[^>]*data-issue="101" data-project="solo"/);
    assert.match(solo, /<form method="post" action="\/answer" id="reply-form">/);
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

  const ran: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    runChild: async (projectRoot, args) => {
      ran.push({ args, cwd: projectRoot });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
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
    // Redirects back to the selected project's dashboard once the awaited prune exits clean.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Executes the no-plan prune (ticket B) against the SELECTED project's own root
    // — so the shared install loads beta's config and gates, not alpha's.
    assert.deepEqual(ran, [{ args: ["prune", "401"], cwd: join(configDir, "beta-root") }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /redrive starts redrive in the selected project's root", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-redrive-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  // Beta campaign-parked (greens merged, base gated red, campaign paused) — the state the
  // Redrive control acts on. Alpha is a plain running campaign, untouched.
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
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

  const started: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    startChild: async (projectRoot, args) => (started.push({ args, cwd: projectRoot }), { code: 0, lastLine: "", running: false }),
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
    // Starts `redrive` against the SELECTED project's own root (dumb router, ADR 0002),
    // so the shared install picks beta's unfinished campaign back up in beta's log.
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].args, ["redrive"]);
    assert.equal(started[0].cwd, join(configDir, "beta-root"));
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
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const started: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    startChild: async (...a) => (started.push(a), { code: 0, lastLine: "", running: false }),
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
    // Neither validation failure starts anything.
    assert.equal(started.length, 0);
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
  const ran: unknown[] = [];
  const started: unknown[] = [];
  // The structured closure (E2) the confirmation renders: the target and dropped
  // dependents that would leave, the banked work kept, and the remaining waves.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    keptInFlight: [] as string[],
    remaining: [] as string[][],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    runChild: async (...a) => (ran.push(a), { code: 0, stdout: "", stderr: "", timedOut: false }),
    startChild: async (...a) => (started.push(a), { code: 0, lastLine: "", running: false }),
    // The dumb router routes the closure to the selected project's own install,
    // which computes it against that project's real blockedBy graph.
    pruneClosure: (projectRoot, taskId) => {
      closures.push({ projectRoot, taskId });
      return Promise.resolve(structured);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/prune?preview&taskId=201&project=beta`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    // The endpoint returns the full structured closure the panel discloses —
    // dropped, kept-banked, and remaining all reach the client verbatim.
    assert.deepEqual(await res.json(), structured);
    // The closure came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(closures, [{ projectRoot: join(configDir, "beta-root"), taskId: "201" }]);
    // A preview computes nothing destructive — no child is run or started.
    assert.equal(ran.length, 0);
    assert.equal(started.length, 0);
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
        keptInFlight: [],
        remaining: [],
      }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing taskId/project → 400.
    assert.equal((await fetch(`http://127.0.0.1:${port}/prune?preview&project=beta`)).status, 400);
    // Unknown project → 404.
    assert.equal((await fetch(`http://127.0.0.1:${port}/prune?preview&taskId=201&project=ghost`)).status, 404);
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
  const ran: unknown[] = [];
  const started: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    runChild: async (...a) => (ran.push(a), { code: 0, stdout: "", stderr: "", timedOut: false }),
    startChild: async (...a) => (started.push(a), { code: 0, lastLine: "", running: false }),
    // The dumb router routes the preview to the selected project's own install,
    // which computes the closure against that project's real blockedBy graph.
    prunePreview: (projectRoot, taskId) => {
      previews.push({ projectRoot, taskId });
      return Promise.resolve(`prune #201 → dropping #201, #401\nremaining campaign: (nothing left to run)`);
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
    assert.deepEqual(previews, [{ projectRoot: join(configDir, "beta-root"), taskId: "201" }]);
    // It shows the shelled closure and a confirm affordance carrying the project.
    assert.match(html, /#401/);
    assert.match(html, /<form method="post" action="\/prune"[\s\S]*?name="confirm"/);
    assert.match(html, /name="project" value="beta"/);
    assert.match(html, /name="taskId" value="201"/);
    // Nothing has been pruned yet — preview executes nothing.
    assert.equal(ran.length, 0);
    assert.equal(started.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /graft shells graft directly for a clean batch — no confirm gate (#202)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-direct-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
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
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const closures: { projectRoot: string; taskIds: string[] }[] = [];
  const ran: unknown[] = [];
  const started: unknown[] = [];
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
    runChild: async (...a) => (ran.push(a), { code: 0, stdout: "", stderr: "", timedOut: false }),
    startChild: async (...a) => (started.push(a), { code: 0, lastLine: "", running: false }),
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
    // A preview computes nothing destructive — no child is run or started.
    assert.equal(ran.length, 0);
    assert.equal(started.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview validates params and the project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-json-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
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
    assert.equal((await fetch(`http://127.0.0.1:${port}/graft?preview&ids=640&project=ghost`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview 400s on any id that is not an issue token and shells no preview (#524)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-badid-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  let closures = 0;
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    graftClosure: () => (closures++, Promise.resolve({ ids: [], placement: [], remaining: [], rejected: [] })),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // One bad id in the set rejects the whole request — it would otherwise land in the child's argv.
    const res = await fetch(`http://127.0.0.1:${port}/graft?preview&ids=${encodeURIComponent("1,--config,/tmp/x.mjs")}&project=beta`);
    assert.equal(res.status, 400);
    assert.equal(closures, 0, "no preview child is shelled for a bad id");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview and /prune?preview refuse a cross-site Sec-Fetch-Site with 403 and shell nothing (#524)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-preview-fetch-site-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const shelled: string[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    graftClosure: () => (shelled.push("graft"), Promise.resolve({ ids: ["640"], placement: [], remaining: [], rejected: [] })),
    pruneClosure: () => (
      shelled.push("prune"),
      Promise.resolve({ target: "201", dropped: ["201"], keptBanked: [], keptInFlight: [], remaining: [] })
    ),
  });
  const { port } = server.address() as AddressInfo;
  const previews = [`/graft?preview&ids=640&project=beta`, `/prune?preview&taskId=201&project=beta`];
  try {
    // An <img>/<iframe> GET from another site carries no Origin, so only Sec-Fetch-Site tells it apart.
    for (const site of ["cross-site", "same-site", "none"]) {
      for (const path of previews) {
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "sec-fetch-site": site } })).status,
          403,
          `${site} ${path}`,
        );
      }
    }
    assert.deepEqual(shelled, [], "no preview child is shelled for a cross-site request");
    // The dashboard's own same-origin fetch, and a header-less curl/script, behave as before.
    for (const headers of [{ "sec-fetch-site": "same-origin" }, {}] as Record<string, string>[]) {
      for (const path of previews) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status, 200, path);
    }
    assert.deepEqual(shelled, ["graft", "prune", "graft", "prune"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /graft?preview 502s when the project emits no closure line", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-502-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: betaDir });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    // No campaign running / an install predating the closure → null → 502.
    graftClosure: () => Promise.resolve(null),
  });
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/graft?preview&ids=640&project=beta`)).status, 502);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /graft rejects a whole batch with per-id verdicts and grafts nothing (#202)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-graft-reject-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["201"]], slots: 1 })]);
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
    const html = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    // The unstarted future-wave row is flagged prunable and carries beta, so the
    // panel's Prune routes preview and confirm to beta's own install.
    assert.match(html, /class="wave-member [a-z]+"[^>]*data-issue="401"[^>]*data-project="beta"[^>]*data-prunable="1"/);
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
  writeFileSync(join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"), "garbage\n{");
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
    const root = await (await fetch(`http://127.0.0.1:${port}/?project=beta`)).text();
    // The collapsible archived-runs list shows both good runs, newest-first; the live
    // run (201) still renders at the top.
    assert.match(root, /#201 <small>/);
    assert.match(root, /<section class="archived-runs">/);
    // Each row carries its token, state (a stalled run stopped short — a campaign-start
    // with no terminal event, ADR 0019) and issue count; unnamed runs fall back to the
    // token as the label.
    assert.match(root, /<li data-run="2026-02-01T00-00-00-000Z">/);
    assert.match(root, /<span class="lv-verb">stalled · 1 issue<\/span>/);
    assert.match(root, /<li data-run="2026-01-01T00-00-00-000Z">/);
    assert.match(root, /<span class="lv-verb">complete · 2 issues<\/span>/);
    assert.ok(root.indexOf("2026-02-01") < root.indexOf("2026-01-01"), "newest-first");
    // The malformed run is skipped, never listed.
    assert.doesNotMatch(root, /2026-03-01/);
    // No run selected → every row starts collapsed.
    assert.doesNotMatch(root, /<li class="open" data-run=/);
    // No run-level raw/log pane rides any row — the detail is the wave cards only (#222).
    assert.doesNotMatch(root, /archive-raw/);
    assert.doesNotMatch(root, /data-pane=/);

    // Selecting a run opens that row on load (a ?run= deep-link).
    const withRun = await (await fetch(`http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z`)).text();
    assert.match(withRun, /#201 <small>/); // live run still on top
    assert.match(withRun, /<li class="open" data-run="2026-01-01T00-00-00-000Z">/);
    assert.match(withRun, /#101 <small>/); // the archived run's own issues, in its body
    // Read-only: the archived run's chips are never prunable (a finished run has
    // nothing to prune).
    assert.doesNotMatch(withRun, /data-issue="101"[^>]*data-prunable/);

    // A stale ?mode=raw param no longer means anything — the run opens normally, no
    // error and no raw pane (#222).
    const staleMode = await fetch(`http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z&mode=raw`);
    assert.equal(staleMode.status, 200);
    const staleModeHtml = await staleMode.text();
    assert.match(staleModeHtml, /<li class="open" data-run="2026-01-01T00-00-00-000Z">/);
    assert.match(staleModeHtml, /#101 <small>/); // wave cards, as normal
    assert.doesNotMatch(staleModeHtml, /archive-raw/);

    // A run not present in the archive listing is rejected — no row opens.
    const bogus = await fetch(`http://127.0.0.1:${port}/?project=beta&run=..%2F..%2Forchestrator`);
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
    const html = await (await fetch(`http://127.0.0.1:${port}/?project=beta&run=2026-04-01T00-00-00-000Z`)).text();
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
    const withRun = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=2026-01-01T00-00-00-000Z`)).json();
    assert.equal(withRun.status, "completed");
    assert.equal(withRun.title, "old work");
    assert.equal(withRun.archived, true);
    assert.equal(withRun.turnLog.length, 1);
    assert.equal(withRun.turnLog[0].summary, "did the thing");

    // Without a run token it reads the live log, where 101 is unknown → unstarted.
    const live = await (await fetch(`http://127.0.0.1:${port}/api/issue?project=beta&issue=101`)).json();
    assert.equal(live.status, "unstarted");
    assert.equal(live.turnLog.length, 0);

    // An unlisted run token is rejected, never a path to traverse.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=..%2F..%2Forchestrator`)).status, 404);
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
    [event("campaign-start", { waves: [["101"], ["102"]], slots: 1 }), event("campaign-done", { waves: 2 })]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
  writeFileSync(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), raw);
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
    const gone = await fetch(`http://127.0.0.1:${port}/archive/log?project=beta&run=2026-01-01T00-00-00-000Z`);
    assert.equal(gone.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(String(serveAllStatus), /server\.listen\(opts\.port,\s*opts\.host,/);
});

test("dashboardRequestDenial admits an IP-literal or localhost Host, and an allowlisted name, ignoring the port (#361)", () => {
  for (const host of ["127.0.0.1:8765", "[::1]:8765", "100.64.1.2:8765", "localhost:8765", "127.0.0.1"]) {
    assert.equal(dashboardRequestDenial(host, undefined, []), null, host);
  }
  // A MagicDNS or reverse-proxy name is admitted only when listed, case-insensitively.
  assert.equal(dashboardRequestDenial("MyHost.Tailnet.ts.net:8765", undefined, ["myhost.tailnet.ts.net"]), null);
  assert.equal(dashboardRequestDenial("myhost.tailnet.ts.net:8765", undefined, ["MYHOST.tailnet.ts.net"]), null);
});

test("dashboardRequestDenial refuses a DNS-name Host that is not allowlisted, and a missing Host, naming the variable (#361)", () => {
  const rebound = dashboardRequestDenial("evil.example:8765", undefined, []);
  assert.match(rebound ?? "", /evil\.example/);
  assert.match(rebound ?? "", /VETINARI_STATUS_ALLOWED_HOSTS/);
  assert.doesNotMatch(rebound ?? "", /\n/);
  assert.notEqual(dashboardRequestDenial("other.tailnet.ts.net:8765", undefined, ["myhost.tailnet.ts.net"]), null);
  assert.match(dashboardRequestDenial(undefined, undefined, []) ?? "", /VETINARI_STATUS_ALLOWED_HOSTS/);
});

test("dashboardRequestDenial admits no Origin, or an Origin of the request's own Host over http or https (#361)", () => {
  assert.equal(dashboardRequestDenial("127.0.0.1:8765", undefined, []), null);
  assert.equal(dashboardRequestDenial("127.0.0.1:8765", "http://127.0.0.1:8765", []), null);
  assert.equal(dashboardRequestDenial("myhost.tailnet.ts.net", "https://myhost.tailnet.ts.net", ["myhost.tailnet.ts.net"]), null);
});

test("dashboardRequestDenial refuses a cross-site Origin, a different port, and the literal null (#361)", () => {
  for (const origin of ["http://evil.example", "http://127.0.0.1:9999", "null"]) {
    const denial = dashboardRequestDenial("127.0.0.1:8765", origin, []);
    assert.notEqual(denial, null, origin);
    assert.doesNotMatch(denial ?? "", /\n/);
  }
});

test("serveAllStatus refuses a cross-site POST /answer with 403 and spawns nothing; with no Origin it reaches the route (#361)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-origin-${Date.now()}`);
  const stateDir = join(configDir, "state-solo");
  seedState(stateDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 })]);
  register(configDir, { project: "solo", projectRoot: join(configDir, "solo-root"), baseLocation: stateDir });

  const started: string[][] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    startChild: async (_root, args) => (started.push(args), { code: 0, lastLine: "", running: false }),
  });
  const { port } = server.address() as AddressInfo;
  const answer = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/answer`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ taskId: "101", text: "rm -rf /", project: "solo" }).toString(),
    });
  try {
    const refused = await answer({ origin: "http://evil.example" });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /evil\.example/);
    assert.deepEqual(started, []);

    const admitted = await answer({});
    assert.notEqual(admitted.status, 403);
    assert.deepEqual(started, [["answer", "101", "rm -rf /"]]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus refuses GET /api/status under a rebound DNS-name Host with 403, and serves it under a loopback Host (#361)", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-host-${Date.now()}`);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  // `fetch` silently replaces a caller-set Host, so the rebound request goes out by node:http.
  const statusUnder = (host: string) =>
    new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/api/status", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
  try {
    assert.equal(await statusUnder(`evil.example:${port}`), 403);
    assert.equal(await statusUnder(`127.0.0.1:${port}`), 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus warns, after its URL line, that a non-loopback bind is unauthenticated; a loopback bind prints no warning (#361)", async (t) => {
  const configDir = join(tmpdir(), `vetinari-agg-bind-${Date.now()}`);
  const log = t.mock.method(console, "log", () => {});
  const linesFor = async (host: string) => {
    log.mock.resetCalls();
    const server = await serveAllStatus(configDir, { port: 0, host });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return log.mock.calls.map((c) => String(c.arguments[0]));
  };
  const wide = await linesFor("0.0.0.0");
  assert.equal(wide.length, 2);
  assert.match(wide[0], /^vetinari status: http:\/\//);
  assert.match(wide[1], /unauthenticated/);
  assert.match(wide[1], /docs\/operations\.md/);
  const loopback = await linesFor("127.0.0.1");
  assert.equal(loopback.length, 1);
  assert.match(loopback[0], /^vetinari status: http:\/\//);
});

// Start a port-0 dashboard with its host log in a fresh temp gateway home, hand `body` the port and a
// reader of the `dashboard-request` rows that waits for `n` of them (the row is written once the
// response closes, which can land a tick after the client has read it), then restore the env (#582).
async function withAccessLog(
  body: (port: number, accessRows: (n: number) => Promise<Record<string, unknown>[]>) => Promise<void>,
): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-access-log-"));
  const logFile = join(configDir, "gw-home", "logs", "host.jsonl");
  const read = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((r) => r.event === "dashboard-request")
      : [];
  const accessRows = async (n: number) => {
    for (let i = 0; i < 100 && read().length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return read();
  };
  await withEnv({ VETINARI_GATEWAY_HOME: join(configDir, "gw-home") }, async () => {
    const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
    try {
      await body((server.address() as AddressInfo).port, accessRows);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}

test("serveAllStatus logs a POST no route owns as one dashboard-request host-log row with method, path, status and remote (#582)", async () => {
  await withAccessLog(async (port, accessRows) => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "POST" });
    assert.equal(res.status, 404);
    await res.text();
    const rows = await accessRows(1);
    assert.equal(rows.length, 1);
    const { method, path, status, remote } = rows[0];
    assert.deepEqual({ method, path, status }, { method: "POST", path: "/nope", status: 404 });
    assert.match(String(remote), /^(::ffff:)?127\.0\.0\.1$/);
  });
});

test("serveAllStatus logs the status a POST was actually sent: a 403 denial and a route's 400 (#582)", async () => {
  await withAccessLog(async (port, accessRows) => {
    const refused = await fetch(`http://127.0.0.1:${port}/answer`, { method: "POST", headers: { origin: "http://evil.example" } });
    assert.equal(refused.status, 403);
    await refused.text();
    const rejected = await fetch(`http://127.0.0.1:${port}/prune`, { method: "POST" });
    assert.equal(rejected.status, 400);
    await rejected.text();
    const rows = await accessRows(2);
    assert.deepEqual(
      rows.map(({ path, status }) => ({ path, status })),
      [
        { path: "/answer", status: 403 },
        { path: "/prune", status: 400 },
      ],
    );
  });
});

test("serveAllStatus logs a POST's path without its query string, and logs no GET (#582)", async () => {
  await withAccessLog(async (port, accessRows) => {
    for (const path of ["/", "/api/landing"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200);
      await res.text();
    }
    const posted = await fetch(`http://127.0.0.1:${port}/nope?project=solo&secret=1`, { method: "POST" });
    await posted.text();
    // The POST's row is written after the GETs', so once it is there any GET row would be too.
    const rows = await accessRows(1);
    assert.deepEqual(
      rows.map(({ method, path }) => ({ method, path })),
      [{ method: "POST", path: "/nope" }],
    );
  });
});

test("serveAllStatus answers a route that throws before its head with a generic 500 and logs one dashboard-request-failed row (#538)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-route-throws-"));
  const logger = memoryLogger();
  const boom: RouteHandler = () => {
    throw new Error("secret detail");
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, routes: [boom] });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/boom?x=1`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /\n\s+at /, "no stack trace in the response");
    assert.doesNotMatch(text, /secret detail/, "no error message in the response");
    const failed = logger.events.filter((e) => (e.event as string) === "dashboard-request-failed");
    assert.equal(failed.length, 1);
    const { method, path, error } = failed[0] as unknown as Record<string, unknown>;
    assert.deepEqual({ method, path, error }, { method: "GET", path: "/boom", error: "Error: secret detail" });
    assert.deepEqual(unhandled, [], "the error path rejects nothing");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus destroys a response whose route throws after its head, logs it once, and stays up (#538)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-route-throws-late-"));
  const logger = memoryLogger();
  const late: RouteHandler = async (_req, res, url) => {
    if (url.pathname !== "/late") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("mid-stream failure");
  };
  const ok: RouteHandler = (_req, res) => (res.writeHead(200).end("ok"), true);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, routes: [late, ok] });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/late`);
    assert.equal(res.status, 200);
    // Race the body read so a response left hanging fails the test instead of stalling it.
    const read = await Promise.race([
      res.text().then(
        () => "completed",
        () => "errored",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 2000)),
    ]);
    assert.equal(read, "errored", "the half-sent stream is cut off, not rewritten");
    const failed = logger.events.filter((e) => (e.event as string) === "dashboard-request-failed");
    assert.equal(failed.length, 1);
    const { method, path } = failed[0] as unknown as Record<string, unknown>;
    assert.deepEqual({ method, path }, { method: "GET", path: "/late" });
    const after = await fetch(`${base}/next`);
    assert.equal(after.status, 200);
    assert.equal(await after.text(), "ok");
    assert.deepEqual(unhandled, [], "the error path rejects nothing");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// A logger whose every write fails, as `fileLogger` does when its retried append also fails (disk
// full, EACCES on host.jsonl). It records each event name before it throws, so a test can wait for
// a call that lands a tick after the client has its response (#632).
function failingHostLogger632(): { log: (event: string) => never; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    log: (event: string) => {
      calls.push(event);
      throw new Error("log append failed");
    },
  };
}

test("serveAllStatus still answers a route that throws before its head with the generic 500 when the failure log throws, and rejects nothing (#632)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-route-throws-log-fails-"));
  const logger = failingHostLogger632();
  const boom: RouteHandler = (_req, _res, url) => {
    if (url.pathname !== "/boom") return false;
    throw new Error("secret detail");
  };
  const ok: RouteHandler = (_req, res) => (res.writeHead(200).end("ok"), true);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, routes: [boom, ok] });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "internal server error");
    const after = await fetch(`${base}/next`);
    assert.equal(after.status, 200);
    assert.equal(await after.text(), "ok");
    assert.ok(logger.calls.includes("dashboard-request-failed"), "the failure log was attempted");
    // An unhandled rejection is reported on a later tick; give it one before asserting none fired.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], "a throwing failure log rejects nothing");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus destroys a response whose route throws after its head when the failure log throws, rejects nothing, and stays up (#632)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-route-throws-late-log-fails-"));
  const logger = failingHostLogger632();
  const late: RouteHandler = async (_req, res, url) => {
    if (url.pathname !== "/late") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("mid-stream failure");
  };
  const ok: RouteHandler = (_req, res) => (res.writeHead(200).end("ok"), true);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, routes: [late, ok] });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/late`);
    assert.equal(res.status, 200);
    const read = await Promise.race([
      res.text().then(
        () => "completed",
        () => "errored",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 2000)),
    ]);
    assert.equal(read, "errored", "the half-sent stream is cut off");
    const after = await fetch(`${base}/next`);
    assert.equal(after.status, 200);
    assert.equal(await after.text(), "ok");
    assert.ok(logger.calls.includes("dashboard-request-failed"), "the failure log was attempted");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], "a throwing failure log rejects nothing");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus completes a POST a route answers when the access log throws, and throws nothing when the response closes (#632)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-access-log-fails-"));
  const logger = failingHostLogger632();
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rejected = await fetch(`${base}/prune`, { method: "POST" });
    assert.equal(rejected.status, 400);
    await rejected.text();
    // The access log runs on the response's close, which can land a tick after the client has read
    // it; wait until the logger was called, or the assertion below could run before it throws.
    for (let i = 0; i < 100 && !logger.calls.includes("dashboard-request"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(logger.calls.includes("dashboard-request"), "the access log was attempted");
    assert.deepEqual(uncaught, [], "a throwing access log throws nothing out of the close listener");
    const after = await fetch(`${base}/prune`, { method: "POST" });
    assert.equal(after.status, 400);
    await after.text();
  } finally {
    process.off("uncaughtException", onUncaught);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// A request by node:http under a chosen Host header (`fetch` replaces a caller-set Host), resolved
// with its status and body once the response ends.
function requestUnderHost603(port: number, path: string, host: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject).end();
  });
}

test("serveAllStatus refuses a request from an agent containers' Docker subnet first — before the Host check — with a 403 and one dashboard-docker-peer-refused row (#603)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-docker-peer-"));
  const logger = memoryLogger();
  // The loopback test client stands in for a container: its address is inside the listed subnet.
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, dockerPeerSubnets: async () => ["127.0.0.0/8"] });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/landing`);
    assert.equal(res.status, 403);
    assert.equal(await res.text(), "request from a Docker network refused (agent containers may not use the dashboard)");
    // A DNS-name Host would fail the Host check; this check runs first, so the refusal is this one.
    const named = await requestUnderHost603(port, "/answer?project=x", "dashboard.example", "POST");
    assert.equal(named.status, 403);
    assert.equal(named.body, "request from a Docker network refused (agent containers may not use the dashboard)");
    const refused = logger.events
      .filter((e) => (e.event as string) === "dashboard-docker-peer-refused")
      .map((e) => {
        const { method, path, remote } = e as unknown as Record<string, unknown>;
        return { method, path, remote: String(remote).replace(/^::ffff:/, "") };
      });
    assert.deepEqual(refused, [
      { method: "GET", path: "/api/landing", remote: "127.0.0.1" },
      { method: "POST", path: "/answer", remote: "127.0.0.1" },
    ]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("serveAllStatus admits every request when the Docker lister throws or hangs, and logs one dashboard-docker-peers-unavailable warning (#603)", async () => {
  const listers: [string, () => Promise<string[]>][] = [
    ["throws", async () => Promise.reject(new Error("docker: command not found"))],
    ["hangs", () => new Promise<string[]>(() => {})],
  ];
  for (const [name, dockerPeerSubnets] of listers) {
    const configDir = mkdtempSync(join(tmpdir(), "vetinari-docker-peer-unavailable-"));
    const logger = memoryLogger();
    const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, dockerPeerSubnets, dockerPeerTimeoutMs: 50 });
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/landing`);
      assert.equal(res.status, 200, name);
      await res.text();
      const warned = logger.events.filter((e) => (e.event as string) === "dashboard-docker-peers-unavailable");
      assert.equal(warned.length, 1, name);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

test("serveAllStatus re-lists the Docker subnets on its refresh interval, warns once per failure streak, and stops listing once closed (#603)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-docker-peer-refresh-"));
  const logger = memoryLogger();
  let answer: () => Promise<string[]> = async () => [];
  let calls = 0;
  const dockerPeerSubnets = () => {
    calls++;
    return answer();
  };
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1", logger, dockerPeerSubnets, dockerPeerRefreshMs: 10 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const statusOf = async () => {
    const res = await fetch(`${base}/api/landing`);
    await res.text();
    return res.status;
  };
  // Wait until `n` more listings have run since now.
  const refreshes = async (n: number) => {
    const target = calls + n;
    for (let i = 0; i < 200 && calls < target; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(calls >= target, `${n} more refreshes ran`);
  };
  const warnings = () => logger.events.filter((e) => (e.event as string) === "dashboard-docker-peers-unavailable").length;
  try {
    assert.equal(await statusOf(), 200);
    answer = async () => ["127.0.0.0/8"];
    await refreshes(2);
    assert.equal(await statusOf(), 403, "the next refresh covers the new subnet");
    answer = async () => Promise.reject(new Error("daemon down"));
    await refreshes(3);
    assert.equal(await statusOf(), 200, "a failed listing filters nothing");
    assert.equal(warnings(), 1, "one warning for the whole failure streak");
    answer = async () => [];
    await refreshes(2);
    answer = async () => Promise.reject(new Error("daemon down"));
    await refreshes(2);
    assert.equal(warnings(), 2, "a new streak warns again");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  const closedAt = calls;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, closedAt, "no listing runs once the server is closed");
});
