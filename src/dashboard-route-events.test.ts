// Tests for the /api/events connect ring (dashboard-route-events.ts): a connection must
// emit its unnamed "doorbell" frame up front so a reconnected client re-fetches and heals
// a gap it slept through, and pure machine-noise after connect must still push nothing (#331).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { register } from "./registry.ts";
import { logFileOf } from "./dashboard-model.ts";
import { event } from "./event-log.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handleEvents } from "./dashboard-route-events.ts";

let counter = 0;

// A config dir with one registered project whose orchestrator log holds the given events.
const seed = (events: unknown[]): { configDir: string; project: string; base: string } => {
  const configDir = join(tmpdir(), `vetinari-events-route-${Date.now()}-${counter++}`);
  const base = join(configDir, "base");
  const project = "gamma";
  register(configDir, { project, projectRoot: join(configDir, "root"), baseLocation: base });
  mkdirSync(join(base, "logs"), { recursive: true });
  writeFileSync(logFileOf(base), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { configDir, project, base };
};

// A GET /api/events request: an emitter so the handler can bind `req.on("close")` and the
// test can fire it to tear the watchers down.
const connReq = () => Object.assign(new EventEmitter(), { method: "GET", url: "/api/events", headers: {} });

// A response spy capturing every SSE chunk the handler writes.
const resSpy = () => {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    chunks,
    writeHead() {
      return res;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
    },
  };
  return res;
};

const depsFor = (configDir: string): DashboardDeps => ({
  configDir,
  spawn: () => undefined,
  prunePreview: async () => null,
  pruneClosure: async () => null,
  graftClosure: async () => null,
});

// The grid frames: unnamed `data:` frames (the doorbell), distinct from the named `tail`/`host`
// frames the client's `onmessage` never sees.
const unnamedFrames = (chunks: string[]): string[] => chunks.filter((c) => c.includes("data:") && !c.includes("event:"));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a connection emits one unnamed frame without waiting for an append (#331)", (t) => {
  const { configDir } = seed([event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["1"]], slots: 1 })]);
  const req = connReq();
  const res = resSpy();
  t.after(() => req.emit("close")); // tear the watchers down even if an assertion throws

  const handled = handleEvents(req as never, res as never, new URL("http://x/api/events"), depsFor(configDir));

  assert.equal(handled, true);
  const frames = unnamedFrames(res.chunks);
  assert.equal(frames.length, 1, "exactly one unnamed frame per connection, regardless of project count");
  assert.match(frames[0], /"project":null/);
  assert.match(frames[0], /"events":\[\]/);
});

test("a burst of denylisted noise after connect emits no further unnamed frame (#331)", async (t) => {
  const { configDir, base } = seed([event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["1"]], slots: 1 })]);
  const req = connReq();
  const res = resSpy();
  t.after(() => req.emit("close")); // tear the watchers down even if an assertion throws

  handleEvents(req as never, res as never, new URL("http://x/api/events"), depsFor(configDir));
  const afterConnect = unnamedFrames(res.chunks).length;
  assert.equal(afterConnect, 1, "the connect ring is the only unnamed frame so far");

  // Pure machine-noise (a denylisted kind) lands; the watcher fires but `viewRelevantEvents`
  // drops it, so no grid frame follows.
  appendFileSync(logFileOf(base), JSON.stringify({ ts: "2026-08-01T00:01:00.000Z", event: "outbound-enqueued" }) + "\n");
  await delay(600); // fs.watch latency + the DEBOUNCE_MS window

  assert.equal(unnamedFrames(res.chunks).length, afterConnect, "denylisted noise pushes nothing");
});
