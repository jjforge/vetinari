import test from "node:test";
import assert from "node:assert/strict";
import {
  gatewayServiceArgv,
  isGatewayServiceVerb,
  launchdManager,
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
  // Each from the state where the verb runs: start from stopped, stop from running.
  for (const [verb, before] of [
    ["start", 3],
    ["stop", 0],
  ] as const) {
    const io = fakeIo({ probes: [{ code: before }], results: [{ code: 3 }] });
    const code = await runGatewayService(verb, io);
    assert.equal(code, 3, `${verb} should propagate systemctl's exit code`);
    assert.deepEqual(io.logs, [], `${verb} should not claim success over a failed verb`);
  }
});

test("start when stopped starts it, confirms active, and reports it — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }, { code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active"), gatewayServiceArgv("start"), gatewayServiceArgv("is-active")]);
  assert.deepEqual(io.logs, ["started vetinari-gateway — now active.\nlogs: journalctl --user -u vetinari-gateway"]);
});

test("start when already running is a no-op: reports it and skips the resulting-state probe — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active")], "an already-running service is not started again");
  assert.deepEqual(io.logs, ["vetinari-gateway was already running — nothing to do.\nlogs: journalctl --user -u vetinari-gateway"]);
});

test("start that comes up not active says so honestly rather than claiming success — exit still the verb's 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }, { code: 3 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io);
  assert.equal(code, 0);
  assert.deepEqual(io.logs, ["started vetinari-gateway — but it is not active; see journalctl --user -u vetinari-gateway"]);
});

test("stop when running stops it and reports inactive — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("stop", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active"), gatewayServiceArgv("stop")]);
  assert.deepEqual(io.logs, ["stopped vetinari-gateway — now inactive.\nlogs: journalctl --user -u vetinari-gateway"]);
});

test("stop when not running is a no-op: reports it, no resulting-state probe — exit 0", async () => {
  const io = fakeIo({ probes: [{ code: 3 }], results: [{ code: 0 }] });
  const code = await runGatewayService("stop", io);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [gatewayServiceArgv("is-active")], "a stopped service is not stopped again");
  assert.deepEqual(io.logs, ["vetinari-gateway wasn't running — nothing to do.\nlogs: journalctl --user -u vetinari-gateway"]);
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
  assert.deepEqual(io.logs, ["restarted vetinari-gateway — now active.\nlogs: journalctl --user -u vetinari-gateway"]);
});

test("restart reports a service that came back inactive honestly and exits non-zero (is-active's code)", async () => {
  const io = fakeIo({ results: [{ code: 0 }], probes: [{ code: 3 }] });
  const code = await runGatewayService("restart", io);
  assert.equal(code, 3);
  assert.deepEqual(io.calls, [gatewayServiceArgv("restart"), gatewayServiceArgv("is-active")]);
  assert.deepEqual(io.logs, ["restarted vetinari-gateway — but it is not active; see journalctl --user -u vetinari-gateway"]);
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

// macOS runs the gateway as a launchd LaunchAgent: the verbs map onto launchctl against
// the user's GUI domain, and messages point at the agent's log file, not journalctl.
const mac = launchdManager(501, "/Users/u/Library/LaunchAgents/vetinari-gateway.plist", "/Users/u/Library/Logs/vetinari-gateway.log");

test("launchd: each verb maps to launchctl in the gui/<uid> domain", () => {
  assert.equal(mac.tool, "launchctl");
  assert.deepEqual(mac.argv("start"), ["bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/vetinari-gateway.plist"]);
  assert.deepEqual(mac.argv("stop"), ["bootout", "gui/501/vetinari-gateway"]);
  assert.deepEqual(mac.argv("restart"), ["kickstart", "-k", "gui/501/vetinari-gateway"]);
  assert.deepEqual(mac.argv("status"), ["print", "gui/501/vetinari-gateway"]);
  assert.deepEqual(mac.argv("is-active"), ["print", "gui/501/vetinari-gateway"]);
});

test("launchd: start when stopped bootstraps the agent and points at its log file", async () => {
  const io = fakeIo({ probes: [{ code: 113 }, { code: 0 }], results: [{ code: 0 }] });
  const code = await runGatewayService("start", io, mac);
  assert.equal(code, 0);
  assert.deepEqual(io.calls, [mac.argv("is-active"), mac.argv("start"), mac.argv("is-active")]);
  assert.deepEqual(io.logs, ["started vetinari-gateway — now active.\nlogs: /Users/u/Library/Logs/vetinari-gateway.log"]);
});

test("launchd: start when loaded never bootstraps again (launchctl would fail on a loaded job)", async () => {
  const io = fakeIo({ probes: [{ code: 0 }] });
  assert.equal(await runGatewayService("start", io, mac), 0);
  assert.deepEqual(io.calls, [mac.argv("is-active")]);
});

test("launchd: a service that came back inactive points at the log file, not journalctl", async () => {
  const io = fakeIo({ results: [{ code: 0 }], probes: [{ code: 113 }] });
  assert.equal(await runGatewayService("restart", io, mac), 113);
  assert.deepEqual(io.logs, ["restarted vetinari-gateway — but it is not active; see /Users/u/Library/Logs/vetinari-gateway.log"]);
});

test("launchd: an uninstalled agent exits non-zero without shelling launchctl", async () => {
  const io = fakeIo({ installed: false });
  assert.notEqual(await runGatewayService("status", io, mac), 0);
  assert.deepEqual(io.calls, []);
});
