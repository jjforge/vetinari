// Tests for the POST /stop route (dashboard-route-stop.ts): it re-checks the campaign lease,
// shells the project's own `vetinari stop [--now]` through the awaiting `runChild` seam, and maps
// the child's exit to the response — 303 on a delivered stop, 409 on the CLI's own refusal, 502
// on a broken or stuck child.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { register } from "./registry.ts";
import { slotsDir } from "./host-slots.ts";
import type { ChildResult } from "./dashboard-child.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handleStop } from "./dashboard-route-stop.ts";

let counter = 0;

const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/stop", headers: {} });

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

// A config dir with one registered project — the route routes the child to its own root (ADR 0002).
const seed = () => {
  const configDir = join(tmpdir(), `vetinari-stop-route-${Date.now()}-${counter++}`);
  const project = "beta";
  register(configDir, { project, projectRoot: join(configDir, "beta-root"), baseLocation: join(configDir, "state-beta") });
  return { configDir, project, projectRoot: join(configDir, "beta-root") };
};

// A live campaign lease for the project, owned by this (alive) process.
const seedLiveLease = (configDir: string, project: string) => {
  mkdirSync(slotsDir(configDir), { recursive: true });
  writeFileSync(
    join(slotsDir(configDir), `${process.pid}.json`),
    JSON.stringify({ project, weight: 1, held: 1, pid: process.pid, kind: "campaign" }),
  );
};

// Deps whose runChild returns a canned outcome and records how it was called.
const depsFor = (configDir: string, outcome: ChildResult) => {
  const calls: { projectRoot: string; args: string[]; timeoutMs: number }[] = [];
  const deps: DashboardDeps = {
    configDir,
    spawn: () => undefined,
    prunePreview: async () => null,
    pruneClosure: async () => null,
    graftClosure: async () => null,
    runChild: async (projectRoot, args, opts) => {
      calls.push({ projectRoot, args, timeoutMs: opts.timeoutMs });
      return outcome;
    },
    graftTimeoutMs: 60_000,
  };
  return { deps, calls };
};

const ok: ChildResult = { code: 0, stdout: "", stderr: "", timedOut: false };

const post = async (body: string, deps: DashboardDeps) => {
  const res = resSpy();
  const handled = await handleStop(postReq(body) as never, res as never, new URL("http://x/stop"), deps);
  assert.equal(handled, true);
  return res;
};

test("POST /stop with no project is a 400, and an unknown project a 404 — neither shells stop (#432)", async () => {
  const { configDir } = seed();
  const { deps, calls } = depsFor(configDir, ok);
  assert.equal((await post("", deps)).statusCode, 400);
  assert.equal((await post("project=ghost", deps)).statusCode, 404);
  assert.deepEqual(calls, []);
});

test("POST /stop refuses with 409 when no campaign holds the lease, before shelling anything (#432)", async () => {
  const { configDir, project } = seed();
  const { deps, calls } = depsFor(configDir, ok);
  const res = await post(`project=${project}`, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "no campaign running for beta");
  assert.deepEqual(calls, []);
});

test("POST /stop shells `vetinari stop` in the project root and 303s to the board on a clean exit (#432)", async () => {
  const { configDir, project, projectRoot } = seed();
  seedLiveLease(configDir, project);
  const { deps, calls } = depsFor(configDir, ok);
  const res = await post(`project=${project}`, deps);
  assert.deepEqual(calls, [{ projectRoot, args: ["stop"], timeoutMs: 10_000 }]);
  assert.equal(res.statusCode, 303);
  assert.equal((res.headers as { location: string }).location, "/?project=beta");
});

test("POST /stop with now=1 shells `vetinari stop --now`, capped by stopTimeoutMs (#432)", async () => {
  const { configDir, project, projectRoot } = seed();
  seedLiveLease(configDir, project);
  const { deps, calls } = depsFor(configDir, ok);
  await post(`project=${project}&now=1`, { ...deps, stopTimeoutMs: 50 });
  assert.deepEqual(calls, [{ projectRoot, args: ["stop", "--now"], timeoutMs: 50 }]);
});

test("POST /stop maps the CLI's refusal (exit 4) to a 409 with its own last stderr line (#432)", async () => {
  const { configDir, project } = seed();
  seedLiveLease(configDir, project);
  const { deps } = depsFor(configDir, { code: 4, stdout: "", stderr: "warming up\nno campaign running for beta\n\n", timedOut: false });
  const res = await post(`project=${project}`, deps);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "no campaign running for beta");
});

test("POST /stop maps a broken child to a 502 with its last stderr line (#432)", async () => {
  const { configDir, project } = seed();
  seedLiveLease(configDir, project);
  const { deps } = depsFor(configDir, { code: 1, stdout: "", stderr: "Error: kill EPERM\n", timedOut: false });
  const res = await post(`project=${project}`, deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "Error: kill EPERM");
});

test("POST /stop maps a child that did not finish inside the cap to a 502 (#432)", async () => {
  const { configDir, project } = seed();
  seedLiveLease(configDir, project);
  const { deps } = depsFor(configDir, { code: null, stdout: "", stderr: "", timedOut: true });
  const res = await post(`project=${project}`, deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "vetinari stop did not finish");
});
