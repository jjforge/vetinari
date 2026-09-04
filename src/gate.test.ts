import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateSpec, ResolvedConfig } from "./config.ts";
import type { Sandbox } from "./sandbox.ts";
import { runGates, selectGates, tapFailures } from "./gate.ts";
import { activityLogPath } from "./activity.ts";
import { loggerForRun, tail } from "./log.ts";
import type { OrchestratorEvent } from "./event-log.ts";

// Fixtures mirror the scoped gates the field actually sees (issue #240): the
// example config's `rust` gate scoped to the sidecar/vendored-jj tree, and the
// README's `e2e` gate scoped to routes + the e2e suite. The project's own
// dogfood gates (typecheck, test) carry no `when` and stand in for the
// always-run case.
const typecheck: GateSpec = { cmd: "tsc --noEmit", label: "typecheck" };
const testGate: GateSpec = { cmd: "run-tests", label: "test" };
const rust: GateSpec = { cmd: "cargo test", label: "rust", when: /^(sidecar\/|vendor\/jj\/)/m };
const e2e: GateSpec = { cmd: "playwright test", label: "e2e", when: /^(src\/routes|e2e\/)/m };

const labels = (gates: GateSpec[]): string[] => gates.map((g) => g.label ?? g.cmd);

test("an unscoped gate is always selected — empty diff", () => {
  assert.deepEqual(labels(selectGates([typecheck, testGate], "")), ["typecheck", "test"]);
});

test("an unscoped gate is always selected — non-empty diff that matches nothing", () => {
  assert.deepEqual(labels(selectGates([typecheck, testGate], "docs/README.md\n")), ["typecheck", "test"]);
});

test("a when-scoped gate is dropped when no changed file matches its pattern", () => {
  assert.deepEqual(labels(selectGates([rust, e2e], "src/gate.ts\n")), []);
});

test("a when-scoped gate is selected iff a changed file matches its pattern", () => {
  // rust matches, e2e does not.
  assert.deepEqual(labels(selectGates([rust, e2e], "sidecar/main.rs\n")), ["rust"]);
  // e2e matches, rust does not.
  assert.deepEqual(labels(selectGates([rust, e2e], "src/routes/home.ts\n")), ["e2e"]);
});

test("a when-scoped gate is NEVER dropped when its files changed (under-select regression)", () => {
  // The hole this closes: a scoped gate whose files DID change must still run.
  const files = "vendor/jj/lib.rs\ne2e/login.spec.ts\n";
  assert.deepEqual(labels(selectGates([typecheck, rust, e2e], files)), ["typecheck", "rust", "e2e"]);
});

test("with all, every gate is selected regardless of the diff", () => {
  const gates = [typecheck, rust, e2e];
  // Empty diff would otherwise drop both scoped gates.
  assert.deepEqual(labels(selectGates(gates, "", { all: true })), ["typecheck", "rust", "e2e"]);
  // A diff matching nothing would otherwise drop both scoped gates too.
  assert.deepEqual(labels(selectGates(gates, "docs/README.md\n", { all: true })), ["typecheck", "rust", "e2e"]);
});

// runGates' per-task activity mirror (ADR 0015): the live tail tails this stream, so each check must
// announce that it is *starting* — a `gate-check` naming the command — and not only report on exit,
// or a slow suite reads as a dead agent (#332).
const gateCfg = (gates: GateSpec[]): ResolvedConfig => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-gate-"));
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return { stateDir, logFile, baseBranch: "base", gates, log: loggerForRun({ logFile }) } as unknown as ResolvedConfig;
};

// A fake sandbox whose `exec` answers each gate command with a scripted exit code (the `git diff`
// probe is never reached under `{ all: true }`). `cmds` are the gate commands, in order.
const gateSandbox = (exits: Record<string, number>): Sandbox =>
  ({
    branch: "agent/T",
    async exec(cmd: string) {
      return { stdout: "out", stderr: "err", exitCode: exits[cmd] ?? 0 };
    },
    async run() {
      throw new Error("unused");
    },
    async close() {},
  }) as unknown as Sandbox;

const readActivity = (cfg: ResolvedConfig, taskId: string): OrchestratorEvent[] => {
  const file = activityLogPath(cfg.stateDir, taskId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("runGates announces each check as it starts — a gate-check before every gate-result", async () => {
  const cfg = gateCfg([{ cmd: "tsc --noEmit" }, { cmd: "run-tests" }]);
  const sbx = gateSandbox({ "tsc --noEmit": 0, "run-tests": 0 });
  const { green } = await runGates(cfg, sbx, { all: true, taskId: "204" });
  assert.equal(green, true);
  const stream = readActivity(cfg, "204").map((e) => [e.event, (e as { cmd?: string }).cmd]);
  assert.deepEqual(stream, [
    ["gate", undefined],
    ["gate-check", "tsc --noEmit"],
    ["gate-result", "tsc --noEmit"],
    ["gate-check", "run-tests"],
    ["gate-result", "run-tests"],
  ]);
});

test("a gate that fails its first check stops there — the failing result, not a dangling gate-check, is last", async () => {
  const cfg = gateCfg([{ cmd: "tsc --noEmit" }, { cmd: "run-tests" }]);
  const sbx = gateSandbox({ "tsc --noEmit": 1, "run-tests": 0 });
  const { green } = await runGates(cfg, sbx, { all: true, taskId: "204" });
  assert.equal(green, false);
  const stream = readActivity(cfg, "204");
  // The start line for the first check, then its failing result — and nothing for the second check.
  assert.deepEqual(stream.map((e) => e.event), ["gate", "gate-check", "gate-result"]);
  const last = stream[stream.length - 1] as { event: string; exitCode?: number };
  assert.equal(last.event, "gate-result");
  assert.equal(last.exitCode, 1);
});

test("the wave-merge gate (no taskId) writes no per-task activity — not even a gate-check", async () => {
  const cfg = gateCfg([{ cmd: "tsc --noEmit" }]);
  const sbx = gateSandbox({ "tsc --noEmit": 0 });
  await runGates(cfg, sbx, { all: true });
  assert.equal(existsSync(activityLogPath(cfg.stateDir, "any")), false);
});

// --- TAP failure selection (#389) ---
// A red gate's report used to tail the command output. On TAP that is the wrong window: failures
// are interleaved in run order and the tail is a passing-heavy summary, so the failing test never
// appears. tapFailures selects the `not ok` lines and their YAML diagnostics instead.

// One `not ok` at the very start, then 500 passing lines and the TAP summary — the shape the ticket
// measured (a failure ~6400 lines above the tail window).
const tapFailFirst = [
  "not ok 1 - the widget explodes",
  "  ---",
  "  error: 'expected 1 to equal 2'",
  "  failureType: 'testCodeFailure'",
  "  location: '/src/widget.test.ts:42:3'",
  "  ...",
  ...Array.from({ length: 500 }, (_, i) => `ok ${i + 2} - passing check ${i + 2}`),
  "1..501",
  "# tests 501",
  "# pass 500",
  "# fail 1",
].join("\n");

test("tapFailures names a failing test the tail would bury under passing lines", () => {
  const report = tapFailures(tapFailFirst);
  assert.ok(report, "TAP output should be recognised");
  assert.match(report!, /not ok 1 - the widget explodes/);
  // Today's report — the last 200 lines — never names it.
  assert.doesNotMatch(tail(tapFailFirst, 200), /the widget explodes/);
});

test("tapFailures carries the failing test's YAML diagnostic — error and location", () => {
  const report = tapFailures(tapFailFirst)!;
  assert.match(report, /error: 'expected 1 to equal 2'/);
  assert.match(report, /location: '\/src\/widget\.test\.ts:42:3'/);
});

test("tapFailures represents several failures, capped, with a count of any omitted", () => {
  const failures = Array.from({ length: 25 }, (_, i) => [
    `not ok ${i + 1} - failure number ${i + 1}`,
    "  ---",
    `  error: 'boom ${i + 1}'`,
    "  ...",
  ]).flat();
  const tap = [...failures, "1..25", "# tests 25", "# pass 0", "# fail 25"].join("\n");
  const report = tapFailures(tap)!;
  assert.match(report, /failure number 1\b/);
  assert.match(report, /failure number 20\b/);
  // Capped: the 21st onward are omitted, and the report says how many.
  assert.doesNotMatch(report, /failure number 21\b/);
  assert.match(report, /5 more failing tests/);
});

test("tapFailures returns null for non-TAP output so the caller keeps today's tail", () => {
  const typecheckOut = "src/gate.ts(62,5): error TS2345: Argument of type 'x'.\nFound 1 error.";
  assert.equal(tapFailures(typecheckOut), null);
});

test("a red TAP gate's report names the failure instead of tailing passing lines", async () => {
  const cfg = gateCfg([{ cmd: "run-tests" }]);
  const sbx = {
    branch: "agent/T",
    async exec(cmd: string) {
      if (cmd === "run-tests") return { stdout: tapFailFirst, stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async run() {
      throw new Error("unused");
    },
    async close() {},
  } as unknown as Sandbox;
  const { green, report } = await runGates(cfg, sbx, { all: true, taskId: "389" });
  assert.equal(green, false);
  assert.match(report, /\$ run-tests/);
  assert.match(report, /not ok 1 - the widget explodes/);
  assert.match(report, /location: '\/src\/widget\.test\.ts:42:3'/);
});
