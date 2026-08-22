import test from "node:test";
import assert from "node:assert/strict";
import { computeLayoutMigration } from "./migrate.ts";

test("computeLayoutMigration moves a root-level legacy config into sandcastle/, keeping its extension", () => {
  const plan = computeLayoutMigration({
    legacyConfig: "sandcastle-tdd.config.ts",
    oldState: ["logs"],
    gitignore: ".sandcastle/\n",
  });

  assert.ok(plan.moves.some((m) => m.from === "sandcastle-tdd.config.ts" && m.to === "sandcastle/config.ts"));
  // A root config is not under .sandcastle/, so the state sweep is untouched by it.
  assert.ok(plan.moves.some((m) => m.from === ".sandcastle/logs" && m.to === ".sandcastle.local/logs"));
});

test("computeLayoutMigration yields an empty plan for an already-migrated project", () => {
  const plan = computeLayoutMigration({
    // config already canonical (no legacyConfig), no old .sandcastle/ state,
    // and .gitignore already excludes both dirs.
    oldState: [],
    gitignore: "node_modules/\n.sandcastle.local/\n.sandcastle/\n*.log\n",
  });

  assert.deepEqual(plan.moves, []);
  assert.equal(plan.gitignore, undefined);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.warnings, []);
});

test("computeLayoutMigration refuses a move whose destination already exists", () => {
  const plan = computeLayoutMigration({
    legacyConfig: ".sandcastle/config.mts",
    oldState: ["config.mts", "logs", "parked"],
    gitignore: ".sandcastle/\n",
    // A previous half-run already left a .sandcastle.local/logs behind.
    existing: [".sandcastle.local/logs"],
  });

  // The conflicting destination is reported, not silently overwritten...
  assert.deepEqual(plan.conflicts, [".sandcastle.local/logs"]);
  // ...and its move is withheld from the plan.
  assert.ok(!plan.moves.some((m) => m.to === ".sandcastle.local/logs"));
  // Non-conflicting moves are still planned.
  assert.ok(plan.moves.some((m) => m.to === ".sandcastle.local/parked"));
  assert.ok(plan.moves.some((m) => m.to === "sandcastle/config.mts"));
});

test("computeLayoutMigration plans the full move for a fresh legacy project", () => {
  const plan = computeLayoutMigration({
    legacyConfig: ".sandcastle/config.mts",
    oldState: ["config.mts", "logs", "parked", ".env"],
    gitignore: "node_modules/\n.sandcastle/\n*.log\n",
  });

  // Config leaves the excluded dir and becomes the committed, canonical config.
  assert.deepEqual(
    plan.moves.find((m) => m.to === "sandcastle/config.mts"),
    { from: ".sandcastle/config.mts", to: "sandcastle/config.mts" },
  );
  // State and secrets move into the new excluded dir — config is NOT among them.
  assert.deepEqual(
    plan.moves.filter((m) => m.to.startsWith(".sandcastle.local/")),
    [
      { from: ".sandcastle/logs", to: ".sandcastle.local/logs" },
      { from: ".sandcastle/parked", to: ".sandcastle.local/parked" },
      { from: ".sandcastle/.env", to: ".sandcastle.local/.env" },
    ],
  );
  // The config file is not moved twice.
  assert.equal(plan.moves.filter((m) => m.from === ".sandcastle/config.mts").length, 1);

  // .gitignore gains the new excluded dir while keeping the old one ignored.
  assert.match(plan.gitignore!, /^\.sandcastle\.local\/$/m);
  assert.match(plan.gitignore!, /^\.sandcastle\/$/m);

  assert.deepEqual(plan.conflicts, []);
  // The deferred gateway work is called out, not attempted.
  assert.ok(plan.warnings.some((w) => /orchestrator secret|systemd/i.test(w) && /E3|#14/.test(w)));
});
