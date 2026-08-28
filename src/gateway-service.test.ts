import test from "node:test";
import assert from "node:assert/strict";
import {
  gatewayServiceArgv,
  isGatewayServiceVerb,
  runGatewayService,
  type GatewayServiceIO,
  type RunResult,
} from "./gateway-service.ts";

/** A fake IO that records every argv it was asked to run and returns canned results. */
function fakeIo(opts: { installed?: boolean; results?: RunResult[] }): GatewayServiceIO & { calls: string[][] } {
  const results = [...(opts.results ?? [])];
  const calls: string[][] = [];
  return {
    calls,
    unitExists: () => opts.installed ?? true,
    run: async (argv) => {
      calls.push(argv);
      return results.shift() ?? { code: 0 };
    },
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

test("status/start/stop shell exactly their verb and propagate systemctl's exit code", async () => {
  for (const verb of ["status", "start", "stop"] as const) {
    const io = fakeIo({ results: [{ code: 3 }] });
    const code = await runGatewayService(verb, io);
    assert.equal(code, 3, `${verb} should propagate systemctl's exit code`);
    assert.deepEqual(io.calls, [gatewayServiceArgv(verb)], `${verb} should shell exactly one systemctl call`);
  }
});

test("restart runs restart then is-active, returning is-active's code once restart succeeds", async () => {
  const io = fakeIo({ results: [{ code: 0 }, { code: 0 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart"), gatewayServiceArgv("is-active")]);
});

test("restart reports a service that came back inactive as a non-zero exit (is-active's code)", async () => {
  const io = fakeIo({ results: [{ code: 0 }, { code: 3 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 3);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart"), gatewayServiceArgv("is-active")]);
});

test("a failed restart propagates its own code and never probes is-active", async () => {
  const io = fakeIo({ results: [{ code: 1 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 1);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart")]);
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
