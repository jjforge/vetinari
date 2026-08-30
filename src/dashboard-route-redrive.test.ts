// Tests for the /redrive route's server-side safety re-check (dashboard-route-redrive.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { register } from "./registry.ts";
import { logFileOf } from "./dashboard-model.ts";
import { slotsDir } from "./host-slots.ts";
import { event } from "./event-log.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handleRedrive } from "./dashboard-route-redrive.ts";

let counter = 0;

// A POST request whose body is the given form-encoded string — a readable stream so
// `readBody` can drain it, carrying the method and pathname the handler matches on.
const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/redrive", headers: {} });

// A response spy capturing the status, headers and body the handler writes.
const resSpy = () => {
  const res: { statusCode?: number; headers?: unknown; body?: string; writeHead(s: number, h?: unknown): typeof res; end(b?: string): void } = {
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(b) {
      res.body = b;
    },
  };
  return res;
};

// A config dir with one registered project whose log holds the given events.
const seed = (events: unknown[]): { configDir: string; project: string } => {
  const configDir = join(tmpdir(), `vetinari-redrive-route-${Date.now()}-${counter++}`);
  const base = join(configDir, "base");
  const project = "beta";
  register(configDir, { project, projectRoot: join(configDir, "root"), baseLocation: base });
  mkdirSync(join(base, "logs"), { recursive: true });
  writeFileSync(logFileOf(base), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { configDir, project };
};

// A live host lease for the project, owned by this (alive) process, so the crash probe
// reads the project as holding a live lease.
const seedLiveLease = (configDir: string, project: string) => {
  mkdirSync(slotsDir(configDir), { recursive: true });
  writeFileSync(join(slotsDir(configDir), `${process.pid}.json`), JSON.stringify({ project, weight: 1, held: 1, pid: process.pid }));
};

const depsFor = (configDir: string, spawn: DashboardDeps["spawn"]): DashboardDeps => ({
  configDir,
  spawn,
  prunePreview: async () => null,
  pruneClosure: async () => null,
  graftClosure: async () => null,
});

test("POST /redrive refuses with 409 and the reason while a campaign process holds the host lease (#325)", async () => {
  // A campaign still in flight (a wave running, no stop marker) with a live lease is exactly
  // the observed hazard: a redrive here would spawn a second process over the live one.
  const { configDir, project } = seed([
    event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
    event("wave-start", { ts: "2026-08-01T00:01:00.000Z", index: 0, tasks: ["201"] }),
    event("spawn", { ts: "2026-08-01T00:02:00.000Z", taskId: "201", running: 1, left: 0 }),
  ]);
  seedLiveLease(configDir, project);
  let spawned = 0;
  const res = resSpy();
  const handled = await handleRedrive(postReq(`project=${project}`) as never, res as never, new URL("http://x/redrive"), depsFor(configDir, () => (spawned++, undefined)));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "a campaign process is still running");
  // It refused before shelling anything — no second campaign process.
  assert.equal(spawned, 0);
});

test("POST /redrive shells the CLI and redirects when the campaign is stopped and the lease is dead (#325)", async () => {
  // A campaign parked on a red base with no live lease is safe: the fold is stopped and no
  // process holds the lease, so the route shells `redrive` in the project root and redirects.
  const { configDir, project } = seed([
    event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
    event("wave-start", { ts: "2026-08-01T00:01:00.000Z", index: 0, tasks: ["201"] }),
    event("spawn", { ts: "2026-08-01T00:02:00.000Z", taskId: "201", running: 1, left: 0 }),
    event("green", { ts: "2026-08-01T00:03:00.000Z", taskId: "201", commits: ["abc123"], branch: "agent/201" }),
    event("campaign-parked", { ts: "2026-08-01T00:04:00.000Z", index: 0, reason: "red-base", detail: "base gated red" }),
  ]);
  let spawnedCwd: string | undefined;
  const res = resSpy();
  const handled = await handleRedrive(
    postReq(`project=${project}`) as never,
    res as never,
    new URL("http://x/redrive"),
    depsFor(configDir, (_cmd, _args, opts) => ((spawnedCwd = (opts as { cwd: string }).cwd), undefined)),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 303);
  assert.match(String((res.headers as { location: string }).location), /\/\?project=beta/);
  // It shelled the CLI in the project's own root (dumb router, ADR 0002).
  assert.equal(spawnedCwd, join(configDir, "root"));
});
