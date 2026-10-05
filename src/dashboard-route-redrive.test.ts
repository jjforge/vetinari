// Tests for the /redrive route's server-side safety re-check (dashboard-route-redrive.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { register } from "./registry.ts";
import { logFileOf } from "./dashboard-model.ts";
import { slotsDir } from "./host-slots.ts";
import { event } from "./event-log.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import type { StartedChild } from "./dashboard-child.ts";
import { handleRedrive } from "./dashboard-route-redrive.ts";

let counter = 0;

// A POST request whose body is the given form-encoded string — a readable stream so
// `readBody` can drain it, carrying the method and pathname the handler matches on.
const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/redrive", headers: {} });

// A response spy capturing the status, headers and body the handler writes.
const resSpy = () => {
  const res: {
    statusCode?: number;
    headers?: unknown;
    body?: string;
    writeHead(s: number, h?: unknown): typeof res;
    end(b?: string): void;
  } = {
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

const depsFor = (configDir: string): DashboardDeps => ({
  configDir,
  prunePreview: async () => null,
  pruneClosure: async () => null,
  graftClosure: async () => null,
  runChild: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  graftTimeoutMs: 60_000,
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
  let started = 0;
  const res = resSpy();
  const handled = await handleRedrive(postReq(`project=${project}`) as never, res as never, new URL("http://x/redrive"), {
    ...depsFor(configDir),
    startChild: async () => (started++, { code: 0, lastLine: "", running: false }),
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "a campaign process is still running");
  // It refused before shelling anything — no second campaign process.
  assert.equal(started, 0);
});

// A campaign parked on a red base with no live lease: the fold is stopped and no process holds
// the lease, so the gate lets a redrive through to the child.
const seedStopped = () =>
  seed([
    event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["201"]], slots: 1 }),
    event("wave-start", { ts: "2026-08-01T00:01:00.000Z", index: 0, tasks: ["201"] }),
    event("spawn", { ts: "2026-08-01T00:02:00.000Z", taskId: "201", running: 1, left: 0 }),
    event("green", { ts: "2026-08-01T00:03:00.000Z", taskId: "201", commits: ["abc123"], branch: "agent/201" }),
    event("campaign-parked", { ts: "2026-08-01T00:04:00.000Z", index: 0, reason: "red-base", detail: "base gated red" }),
  ]);

// POST /redrive against a stopped campaign with `startChild` stubbed to the given outcome,
// recording what the stub was called with.
const redriveWith = async (outcome: StartedChild) => {
  const { configDir, project } = seedStopped();
  const calls: { projectRoot: string; args: string[]; opts: { logFile: string; startupMs: number } }[] = [];
  const res = resSpy();
  const handled = await handleRedrive(postReq(`project=${project}`) as never, res as never, new URL("http://x/redrive"), {
    ...depsFor(configDir),
    childStartupMs: 7,
    startChild: async (projectRoot, args, opts) => (calls.push({ projectRoot, args, opts }), outcome),
  });
  assert.equal(handled, true);
  return { configDir, res, calls };
};

test("POST /redrive starts redrive in the project root, logging under logs/dashboard/, and redirects on a clean exit (#369)", async () => {
  const { configDir, res, calls } = await redriveWith({ code: 0, lastLine: "", running: false });
  assert.equal(res.statusCode, 303);
  assert.match(String((res.headers as { location: string }).location), /\/\?project=beta/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectRoot, join(configDir, "root"));
  assert.deepEqual(calls[0].args, ["redrive"]);
  assert.equal(calls[0].opts.startupMs, 7);
  const dashboardLogs = join(configDir, "base", "logs", "dashboard");
  assert.equal(dirname(calls[0].opts.logFile), dashboardLogs);
  assert.match(basename(calls[0].opts.logFile), /^redrive-.+\.log$/);
});

test("POST /redrive redirects when the child parks inside the window (exit 2) (#369)", async () => {
  const { res } = await redriveWith({ code: 2, lastLine: "parked", running: false });
  assert.equal(res.statusCode, 303);
});

test("POST /redrive answers 409 with the refusal's sentence when the child exits 4 (#369)", async () => {
  const { res } = await redriveWith({ code: 4, lastLine: "no ANTHROPIC_API_KEY set", running: false });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "no ANTHROPIC_API_KEY set");
});

test("POST /redrive answers 502 with the child's last line when it dies inside the window (#369)", async () => {
  const { res } = await redriveWith({ code: 1, lastLine: "TypeError: boom", running: false });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "TypeError: boom");
});

test("POST /redrive answers 502 with a fixed sentence when the dead child printed nothing (#369)", async () => {
  const { res } = await redriveWith({ code: 1, lastLine: "", running: false });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "redrive did not start — no output");
});

test("POST /redrive answers 202 naming the log file when the child outlives the window (#369)", async () => {
  const { res, calls } = await redriveWith({ code: null, lastLine: "", running: true });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, `redrive started — output in ${calls[0].opts.logFile}`);
});

test("POST /redrive spawns redrive for a campaign stopped between waves after its parked member was pruned (#366)", async () => {
  // Wave 0's only unmerged member parks, the campaign parks, then the member is pruned: wave 0
  // folds `completed`, wave 1 never started, and the campaign folds `unstarted`. With no live
  // lease that is a stopped campaign the route must let through, not a never-run one it refuses.
  const { configDir, project } = seed([
    event("campaign-start", { ts: "2026-08-01T00:00:00.000Z", waves: [["101", "102"], ["201"]], slots: 2 }),
    event("wave-start", { ts: "2026-08-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("spawn", { ts: "2026-08-01T00:02:00.000Z", taskId: "101", running: 1, left: 1 }),
    event("spawn", { ts: "2026-08-01T00:02:00.000Z", taskId: "102", running: 2, left: 0 }),
    event("green", { ts: "2026-08-01T00:03:00.000Z", taskId: "101", commits: ["abc123"], branch: "agent/101" }),
    event("merged", { ts: "2026-08-01T00:04:00.000Z", taskId: "101", branch: "agent/101" }),
    event("parked", { ts: "2026-08-01T00:05:00.000Z", taskId: "102", reason: "stalled", detail: "no-commit" }),
    event("campaign-parked", { ts: "2026-08-01T00:06:00.000Z", index: 0, reason: "stalled", detail: "102 stalled" }),
    event("prune", { ts: "2026-08-01T00:07:00.000Z", target: "102", removed: ["102"], dropped: ["102"] }),
  ]);
  const calls: string[][] = [];
  const res = resSpy();
  const handled = await handleRedrive(postReq(`project=${project}`) as never, res as never, new URL("http://x/redrive"), {
    ...depsFor(configDir),
    startChild: async (_projectRoot, args) => (calls.push(args), { code: 0, lastLine: "", running: false }),
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 303);
  assert.deepEqual(calls, [["redrive"]]);
});
