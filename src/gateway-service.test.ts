import test from "node:test";
import assert from "node:assert/strict";
import {
  gatewayServiceArgv,
  isGatewayServiceVerb,
  runGatewayService,
  type GatewayServiceIO,
  type RunResult,
} from "./gateway-service.ts";

/**
 * A fake IO that records every argv (verb runs and probes alike, in call order)
 * and captures composed log lines. `results` feeds the verb `run`s; `probes` feeds
 * the captured `is-active` probes — each queue drained independently.
 */
function fakeIo(opts: {
  installed?: boolean;
  results?: RunResult[];
  probes?: RunResult[];
}): GatewayServiceIO & { calls: string[][]; logs: string[] } {
  const results = [...(opts.results ?? [])];
  const probes = [...(opts.probes ?? [])];
  const calls: string[][] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    unitExists: () => opts.installed ?? true,
    run: async (argv) => {
      calls.push(argv);
      return results.shift() ?? { code: 0 };
    },
    probe: async (argv) => {
      calls.push(argv);
      return probes.shift() ?? { code: 0 };
    },
    log: (line) => logs.push(line),
  };
}

test("each lifecycle verb maps to `systemctl --user <verb> vetinari-gateway`", () => {
  assert.deepEqual(gatewayServiceArgv("start"), ["--user", "start", "vetinari-gateway"]);
  assert.deepEqual(gatewayServiceArgv("stop"), ["--user", "stop", "vetinari-gateway"]);
  assert.deepEqual(gatewayServiceArgv("restart"), ["--user", "restart", "vetinari-gateway"]);
});

test("`status` adds --no-pager so it prints one block instead of opening a pager", () => {
  assert.deepEqual(gatewayServiceArgv("status"), ["--user", "status", "vetinari-gateway", "--no-pager"]);
});

test("`is-active` — the restart follow-up probe — targets the same unit, no --no-pager", () => {
  assert.deepEqual(gatewayServiceArgv("is-active"), ["--user", "is-active", "vetinari-gateway"]);
});

test("isGatewayServiceVerb accepts exactly the four exposed verbs, nothing else", () => {
  for (const v of ["status", "start", "stop", "restart"]) assert.ok(isGatewayServiceVerb(v));
  for (const v of ["install", "is-active", "", "restart ", "STATUS"]) assert.ok(!isGatewayServiceVerb(v));
});

test("status delegates to systemctl's own output and propagates its exit code — one call, no message", async () => {
  const io = fakeIo({ results: [{ code: 3 }] });
  const code = await runGatewayService("status", io);
  assert.equal(code, 3);
  assert.deepEqual(io.calls, [gatewayServiceArgv("status")]);
  assert.deepEqual(io.logs, [], "status composes no line of its own");
});

test("a failed start/stop propagates the verb's code and composes no success line", async () => {
  for (const verb of ["start", "stop"] as const) {
    const io = fakeIo({ probes: [{ code: 0 }], results: [{ code: 3 }] });
    const code = await runGatewayService(verb, io);
    assert.equal(code, 3, `${verb} should propagate systemctl's exit code`);
    assert.deepEqual(io.logs, [], `${verb} should not claim success over a failed verb`);
  }
});

test("start when stopped starts it, confirms active, and reports it — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }, { code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [
    gatewayServiceArgv("is-active"),
    gatewayServiceArgv("start"),
    gatewayServiceArgv("is-active"),
  ]);
  assert.deepEqual(io.logs, [
    "started vetinari-gateway — now active.\nlogs: journalctl --user -u vetinari-gateway",
  ]);
});

test("start when already running is a no-op: reports it and skips the resulting-state probe — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active"), gatewayServiceArgv("start")]);
  assert.deepEqual(io.logs, [
    "vetinari-gateway was already running — nothing to do.\nlogs: journalctl --user -u vetinari-gateway",
  ]);
});

test("start that comes up not active says so honestly rather than claiming success — exit still the verb's 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }, { code: 3 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.logs, [
    "started vetinari-gateway — but it is not active; see journalctl --user -u vetinari-gateway",
  ]);
});

test("stop when running stops it and reports inactive — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("stop", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active"), gatewayServiceArgv("stop")]);
  assert.deepEqual(io.logs, [
    "stopped vetinari-gateway — now inactive.\nlogs: journalctl --user -u vetinari-gateway",
  ]);
});

test("stop when not running is a no-op: reports it, no resulting-state probe — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }], results: [{ code: 0 }] });
  const code = await runGatewayService("stop", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active"), gatewayServiceArgv("stop")]);
  assert.deepEqual(io.logs, [
    "vetinari-gateway wasn't running — nothing to do.\nlogs: journalctl --user -u vetinari-gateway",
  ]);
});

test("a probe spawn-error falls back to a plain confirmation without changing the outcome", async () => {
  const io = fakeIo({
    probes: [{ code: null, spawnError: Object.assign(new Error("boom"), { code: "ENOENT" }) }],
    results: [{ code: 0 }],
  });
  const code = await runGatewayService("stop", io);
  assert.equal(code, 0);
  assert.deepEqual(io.logs, ["stopped vetinari-gateway.\nlogs: journalctl --user -u vetinari-gateway"]);
});

test("restart runs restart then a captured is-active, reports active, and returns is-active's code", async () => {
  const io = fakeIo({ results: [{ code: 0 }], probes: [{ code: 0 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart"), gatewayServiceArgv("is-active")]);
  assert.deepEqual(io.logs, [
    "restarted vetinari-gateway — now active.\nlogs: journalctl --user -u vetinari-gateway",
  ]);
});

test("restart reports a service that came back inactive honestly and exits non-zero (is-active's code)", async () => {
  const io = fakeIo({ results: [{ code: 0 }], probes: [{ code: 3 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 3);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart"), gatewayServiceArgv("is-active")]);
  assert.deepEqual(io.logs, [
    "restarted vetinari-gateway — but it is not active; see journalctl --user -u vetinari-gateway",
  ]);
});

test("a failed restart propagates its own code and never probes is-active", async () => {
  const io = fakeIo({ results: [{ code: 1 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 1);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart")]);
  assert.deepEqual(io.logs, []);
});

test("an uninstalled unit exits non-zero without shelling systemctl at all", async () => {
  const io = fakeIo({ installed: false });
  const code = await runGatewayService("start", io);
  assert.notEqual(code, 0);
  assert.deepEqual(io.calls, [], "must not shell systemctl when the unit isn't installed");
});

test("an absent systemctl (spawn ENOENT) exits non-zero rather than crashing", async () => {
  const enoent = Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
  const io = fakeIo({ results: [{ code: null, spawnError: enoent }] });
  const code = await runGatewayService("status", io);
  assert.notEqual(code, 0);
});
