import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateSpec, ResolvedConfig } from "./config.ts";
import type { Sandbox } from "./sandbox.ts";
import { runGates, selectGates } from "./gate.ts";
import { activityLogPath } from "./activity.ts";
import { loggerForRun } from "./log.ts";
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
