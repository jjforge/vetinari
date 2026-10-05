// Tests for the /answer route's startup-window contract (dashboard-route-answer.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { register } from "./registry.ts";
import type { DashboardDeps } from "./dashboard-http.ts";
import type { StartedChild } from "./dashboard-child.ts";
import { handleAnswer } from "./dashboard-route-answer.ts";

let counter = 0;

// A POST request whose body is the given form-encoded string — a readable stream so
// `readBody` can drain it, carrying the method and pathname the handler matches on.
const postReq = (body: string) => Object.assign(Readable.from([body]), { method: "POST", url: "/answer", headers: {} });

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

// A config dir with one registered project, `beta`.
const seed = () => {
  const configDir = join(tmpdir(), `vetinari-answer-route-${Date.now()}-${counter++}`);
  register(configDir, { project: "beta", projectRoot: join(configDir, "root"), baseLocation: join(configDir, "base") });
  return configDir;
};

// POST /answer with `startChild` stubbed to the given outcome, recording what it was called with.
const answerWith = async (body: string, outcome: StartedChild = { code: 0, lastLine: "", running: false }) => {
  const configDir = seed();
  const calls: { projectRoot: string; args: string[]; opts: { logFile: string; startupMs: number } }[] = [];
  const deps: DashboardDeps = {
    configDir,
    prunePreview: async () => null,
    pruneClosure: async () => null,
    graftClosure: async () => null,
    runChild: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    graftTimeoutMs: 60_000,
    childStartupMs: 7,
    startChild: async (projectRoot, args, opts) => (calls.push({ projectRoot, args, opts }), outcome),
  };
  const res = resSpy();
  const handled = await handleAnswer(postReq(body) as never, res as never, new URL("http://x/answer"), deps);
  assert.equal(handled, true);
  return { configDir, res, calls };
};

const REPLY = "taskId=201&text=use+the+v2+API&project=beta";

test("POST /answer starts answer in the project root, logging under logs/dashboard/, and redirects on a clean exit (#369)", async () => {
  const { configDir, res, calls } = await answerWith(REPLY, { code: 0, lastLine: "", running: false });
  assert.equal(res.statusCode, 303);
  assert.match(String((res.headers as { location: string }).location), /\/\?project=beta/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectRoot, join(configDir, "root"));
  assert.deepEqual(calls[0].args, ["answer", "201", "use the v2 API"]);
  assert.equal(calls[0].opts.startupMs, 7);
  assert.equal(dirname(calls[0].opts.logFile), join(configDir, "base", "logs", "dashboard"));
  assert.match(basename(calls[0].opts.logFile), /^answer-.+\.log$/);
});

test("POST /answer redirects when the child parks inside the window (exit 2) (#369)", async () => {
  const { res } = await answerWith(REPLY, { code: 2, lastLine: "parked", running: false });
  assert.equal(res.statusCode, 303);
});

test("POST /answer answers 409 with the refusal's sentence when the child exits 4 (#369)", async () => {
  const { res } = await answerWith(REPLY, { code: 4, lastLine: "issue #201 is not parked", running: false });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body, "issue #201 is not parked");
});

test("POST /answer answers 502 with the child's last line when it dies inside the window (#369)", async () => {
  const { res } = await answerWith(REPLY, { code: 1, lastLine: "could not post the comment: offline", running: false });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "could not post the comment: offline");
});

test("POST /answer answers 502 with a fixed sentence when the dead child printed nothing (#369)", async () => {
  const { res } = await answerWith(REPLY, { code: null, lastLine: "", running: false });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body, "answer did not start — no output");
});

test("POST /answer answers 202 naming the log file when the child outlives the window (#369)", async () => {
  const { res, calls } = await answerWith(REPLY, { code: null, lastLine: "", running: true });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, `answer started — output in ${calls[0].opts.logFile}`);
});

test("POST /answer answers 400 on a missing field and starts no child", async () => {
  const { res, calls } = await answerWith("taskId=201&project=beta");
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("POST /answer answers 404 on an unknown project and starts no child", async () => {
  const { res, calls } = await answerWith("taskId=201&text=hi&project=nope");
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 0);
});
