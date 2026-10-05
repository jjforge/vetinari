// Tests for the POST /prune confirm leg (dashboard-route-prune.ts). After #365 the route
// shells `prune <id>` through the awaiting `runChild` seam, capped at the shared dashboard
// child cap, and reads the child's outcome: a clean exit redirects, a failed child 502s
// with its last stderr line, and a child still running at the cap 202s without being killed.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "./registry.ts";
import type { ChildResult } from "./dashboard-child.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import { handlePrune } from "./dashboard-route-prune.ts";

let counter = 0;

const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/prune", headers: {} });

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

// A config dir with one registered project — the route only needs the pointer to route
// the child to the project's own root (ADR 0002).
const seed = () => {
  const configDir = join(tmpdir(), `vetinari-prune-route-${Date.now()}-${counter++}`);
  register(configDir, { project: "beta", projectRoot: join(configDir, "beta-root"), baseLocation: join(configDir, "state-beta") });
  return { configDir, projectRoot: join(configDir, "beta-root") };
};

// Deps whose runChild returns a canned outcome and records how it was called.
const depsFor = (configDir: string, outcome: ChildResult) => {
  const calls: { projectRoot: string; args: string[]; timeoutMs: number }[] = [];
  const deps: DashboardDeps = {
    configDir,
    prunePreview: async () => null,
    pruneClosure: async () => null,
    graftClosure: async () => null,
    runChild: async (projectRoot, args, opts) => {
      calls.push({ projectRoot, args, timeoutMs: opts.timeoutMs });
      return outcome;
    },
    graftTimeoutMs: 60_000,
  };
  return {
    deps,
    calls,
  };
};

const confirm = "taskId=401&project=beta&confirm=1";

test("POST /prune confirm awaits `prune <id>` in the project's root, capped at the dashboard child cap, and 303s on a clean exit", async () => {
  const { configDir, projectRoot } = seed();
  const bundle = depsFor(configDir, { code: 0, stdout: "", stderr: "", timedOut: false });
  const res = resSpy();
  const handled = await handlePrune(postReq(confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(handled, true);
  assert.deepEqual(bundle.calls, [{ projectRoot, args: ["prune", "401"], timeoutMs: 60_000 }]);
  assert.equal(res.statusCode, 303);
  assert.equal((res.headers as { location: string }).location, "/?project=beta");
});

test("POST /prune confirm on a failed child 502s with the child's last non-empty stderr line", async () => {
  const { configDir } = seed();
  const bundle = depsFor(configDir, {
    code: 1,
    stdout: "",
    stderr: "some noise\nprune: #401 is not in the running campaign.\n\n",
    timedOut: false,
  });
  const res = resSpy();
  await handlePrune(postReq(confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "prune: #401 is not in the running campaign.");
});

test("POST /prune confirm on a failed child with no stderr 502s with a fixed sentence naming the issue", async () => {
  const { configDir } = seed();
  const bundle = depsFor(configDir, { code: 1, stdout: "", stderr: "\n", timedOut: false });
  const res = resSpy();
  await handlePrune(postReq(confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "Couldn't prune #401 for beta — is a campaign still running?");
});

test("POST /prune confirm on a child still running at the cap 202s (child left running) with a lands-later note", async () => {
  const { configDir } = seed();
  const bundle = depsFor(configDir, { code: null, stdout: "", stderr: "", timedOut: true });
  const res = resSpy();
  await handlePrune(postReq(confirm) as never, res as never, new URL("http://x/prune"), bundle.deps);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, "pruning… #401 will drop from the plan when it lands");
});
