import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLayoutMigration, computeLayoutMigration, describeMigration, scanLayout } from "./migrate.ts";

let counter = 0;
const tmpProject = () => {
  const dir = join(tmpdir(), `sctdd-migrate-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

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

test("applyLayoutMigration moves the files where the plan says and updates .gitignore", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle", "logs"), { recursive: true });
  mkdirSync(join(dir, ".sandcastle", "parked"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "config.mts"), "export default {}\n");
  writeFileSync(join(dir, ".sandcastle", ".env"), "SECRET=1\n");
  writeFileSync(join(dir, ".sandcastle", "logs", "orchestrator.jsonl"), "{}\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.sandcastle/\n");

  const plan = computeLayoutMigration({
    legacyConfig: ".sandcastle/config.mts",
    oldState: ["config.mts", "logs", "parked", ".env"],
    gitignore: readFileSync(join(dir, ".gitignore"), "utf8"),
  });
  const result = applyLayoutMigration(dir, plan);

  // Config is now the committed, canonical config.
  assert.ok(existsSync(join(dir, "sandcastle", "config.mts")));
  assert.ok(!existsSync(join(dir, ".sandcastle", "config.mts")));
  // State and secrets, including nested files, are under the new excluded dir.
  assert.equal(readFileSync(join(dir, ".sandcastle.local", "logs", "orchestrator.jsonl"), "utf8"), "{}\n");
  assert.equal(readFileSync(join(dir, ".sandcastle.local", ".env"), "utf8"), "SECRET=1\n");
  assert.ok(existsSync(join(dir, ".sandcastle.local", "parked")));

  // .gitignore now excludes both dirs.
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /^\.sandcastle\.local\/$/m);
  assert.match(gi, /^\.sandcastle\/$/m);

  assert.equal(result.gitignoreUpdated, true);
  assert.equal(result.moved.length, plan.moves.length);
});

test("applyLayoutMigration refuses a plan with conflicts and changes nothing", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  mkdirSync(join(dir, ".sandcastle.local"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "logs"), "old\n");
  writeFileSync(join(dir, ".sandcastle.local", "logs"), "already here\n");

  const plan = computeLayoutMigration({
    oldState: ["logs"],
    gitignore: ".sandcastle/\n",
    existing: [".sandcastle.local/logs"],
  });

  assert.throws(() => applyLayoutMigration(dir, plan), /already exist/i);
  // The pre-existing destination is untouched and the source is left in place.
  assert.equal(readFileSync(join(dir, ".sandcastle.local", "logs"), "utf8"), "already here\n");
  assert.equal(readFileSync(join(dir, ".sandcastle", "logs"), "utf8"), "old\n");
});

test("scanLayout reads a legacy project off disk into a scan the planner can use", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle", "logs"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "config.mts"), "export default {}\n");
  writeFileSync(join(dir, ".gitignore"), ".sandcastle/\n");

  const scan = scanLayout(dir);

  assert.equal(scan.legacyConfig, ".sandcastle/config.mts");
  assert.deepEqual([...scan.oldState!].sort(), ["config.mts", "logs"]);
  assert.equal(scan.gitignore, ".sandcastle/\n");

  // Fed to the planner it produces the config + state moves.
  const plan = computeLayoutMigration(scan);
  assert.ok(plan.moves.some((m) => m.to === "sandcastle/config.mts"));
  assert.ok(plan.moves.some((m) => m.to === ".sandcastle.local/logs"));
});

test("scanLayout flags an existing destination so the plan refuses it", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  mkdirSync(join(dir, ".sandcastle.local"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "logs"), "x\n");
  writeFileSync(join(dir, ".sandcastle.local", "logs"), "y\n");

  const plan = computeLayoutMigration(scanLayout(dir));
  assert.deepEqual(plan.conflicts, [".sandcastle.local/logs"]);
});

test("describeMigration reports nothing to do for an empty plan", () => {
  const text = describeMigration(computeLayoutMigration({ oldState: [], gitignore: ".sandcastle.local/\n.sandcastle/\n" }));
  assert.match(text, /nothing to do/i);
});

test("describeMigration summarizes moves, the gitignore edit, and the deferred warning", () => {
  const text = describeMigration(
    computeLayoutMigration({
      legacyConfig: ".sandcastle/config.mts",
      oldState: ["config.mts", "logs"],
      gitignore: ".sandcastle/\n",
    }),
  );
  assert.match(text, /\.sandcastle\/config\.mts.*sandcastle\/config\.mts/);
  assert.match(text, /\.sandcastle\/logs.*\.sandcastle\.local\/logs/);
  assert.match(text, /\.gitignore/);
  assert.match(text, /E3|#14/);
});

test("describeMigration leads with the conflicts when the plan is refused", () => {
  const text = describeMigration(
    computeLayoutMigration({ oldState: ["logs"], gitignore: ".sandcastle/\n", existing: [".sandcastle.local/logs"] }),
  );
  assert.match(text, /refus|conflict/i);
  assert.match(text, /\.sandcastle\.local\/logs/);
});
