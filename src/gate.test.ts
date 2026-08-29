import test from "node:test";
import assert from "node:assert/strict";
import type { GateSpec } from "./config.ts";
import { selectGates } from "./gate.ts";

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
