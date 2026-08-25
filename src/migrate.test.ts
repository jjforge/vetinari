import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLayoutMigration, computeLayoutMigration, describeMigration, scanLayout } from "./migrate.ts";

let counter = 0;
const tmpProject = () => {
  const dir = join(tmpdir(), `vetinari-migrate-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("computeLayoutMigration yields an empty plan for an already-migrated project", () => {
  const plan = computeLayoutMigration({
    // config already canonical (no legacyConfig), no old .sandcastle/ state,
    // and .gitignore already excludes both dirs.
    oldState: [],
    gitignore: "node_modules/\n.vetinari.local/\n.sandcastle/\n*.log\n",
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
    // A previous half-run already left a .vetinari.local/logs behind.
    existing: [".vetinari.local/logs"],
  });

  // The conflicting destination is reported, not silently overwritten...
  assert.deepEqual(plan.conflicts, [".vetinari.local/logs"]);
  // ...and its move is withheld from the plan.
  assert.ok(!plan.moves.some((m) => m.to === ".vetinari.local/logs"));
  // Non-conflicting moves are still planned.
  assert.ok(plan.moves.some((m) => m.to === ".vetinari.local/parked"));
  assert.ok(plan.moves.some((m) => m.to === "vetinari/config.mts"));
});

test("computeLayoutMigration plans the full move for a fresh legacy project", () => {
  const plan = computeLayoutMigration({
    legacyConfig: ".sandcastle/config.mts",
    oldState: ["config.mts", "logs", "parked", ".env"],
    gitignore: "node_modules/\n.sandcastle/\n*.log\n",
  });

  // Config leaves the excluded dir and becomes the committed, canonical config.
  assert.deepEqual(
    plan.moves.find((m) => m.to === "vetinari/config.mts"),
    { from: ".sandcastle/config.mts", to: "vetinari/config.mts" },
  );
  // State and secrets move into the new excluded dir — config is NOT among them.
  assert.deepEqual(
    plan.moves.filter((m) => m.to.startsWith(".vetinari.local/")),
    [
      { from: ".sandcastle/logs", to: ".vetinari.local/logs" },
      { from: ".sandcastle/parked", to: ".vetinari.local/parked" },
      { from: ".sandcastle/.env", to: ".vetinari.local/.env" },
    ],
  );
  // The config file is not moved twice.
  assert.equal(plan.moves.filter((m) => m.from === ".sandcastle/config.mts").length, 1);

  // .gitignore gains the new excluded dir while keeping the old one ignored.
  assert.match(plan.gitignore!, /^\.vetinari\.local\/$/m);
  assert.match(plan.gitignore!, /^\.sandcastle\/$/m);

  assert.deepEqual(plan.conflicts, []);
  // The gateway-coupled parts (E3) are no longer deferred, so a layout-only scan
  // carries no "handle it in E3" warning.
  assert.deepEqual(plan.warnings, []);
});

test("computeLayoutMigration plans to delete a stale gateway.env", () => {
  const plan = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    // A gateway.env left behind by the retired fold — it holds nothing legitimate.
    gatewayEnv: "VETINARI_TELEGRAM_BOT_TOKEN=abc\n",
  });

  assert.equal(plan.gatewayEnvDelete, "/home/z/.config/vetinari/gateway.env");
  // Removing a stale secrets file is never a conflict.
  assert.deepEqual(plan.conflicts, []);
});

test("computeLayoutMigration plans no gateway.env deletion when none exists", () => {
  const plan = computeLayoutMigration({ gatewayConfigDir: "/home/z/.config/vetinari" });
  assert.equal(plan.gatewayEnvDelete, undefined);
});

test("migrate no longer folds secrets — a second project with a different token never conflicts", () => {
  // The first project migrated and left a gateway.env behind; the second project
  // carries a DIFFERENT token. Because migrate no longer folds secrets up (ADR 0002),
  // the second migration is not refused as a conflict — it just clears the stale file.
  const second = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    gatewayEnv: "VETINARI_TELEGRAM_BOT_TOKEN=fromFirstProject\n",
  });

  assert.deepEqual(second.conflicts, []);
  assert.equal(second.gatewayEnvDelete, "/home/z/.config/vetinari/gateway.env");
});

const DISPATCH_UNIT = [
  "[Unit]",
  "Description=vetinari Telegram dispatch poller (jjforge)",
  "After=docker.service network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "WorkingDirectory=/home/z/Code/jjforge",
  "ExecStart=/usr/bin/env bash -lc 'set -a; source .sandcastle/orchestrator.env; set +a; exec ./.sandcastle/run dispatch'",
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");

test("computeLayoutMigration rewrites the per-project dispatch unit into the host-level gateway service", () => {
  const plan = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
    systemdUnit: DISPATCH_UNIT,
  });

  assert.ok(plan.unit, "expected a unit rewrite");
  assert.equal(plan.unit!.path, "/home/z/.config/systemd/user/vetinari-gateway.service");
  // No longer bound to one project's directory...
  assert.doesNotMatch(plan.unit!.content, /WorkingDirectory=/);
  assert.doesNotMatch(plan.unit!.content, /jjforge/);
  // ...and it runs the gateway, not the retired dispatch poller.
  assert.match(plan.unit!.content, /exec vetinari gateway/);
  assert.doesNotMatch(plan.unit!.content, /run dispatch/);
  // The gateway holds no secrets of its own (ADR 0002), so the unit sources no
  // gateway.env — it reads each project's credentials live from the base location.
  assert.doesNotMatch(plan.unit!.content, /source/);
  assert.doesNotMatch(plan.unit!.content, /gateway\.env/);
});

test("computeLayoutMigration leaves an already-gateway unit untouched (idempotent rewrite)", () => {
  const first = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
    systemdUnit: DISPATCH_UNIT,
  });
  // Feed the rewritten unit straight back in — a second migrate must change nothing.
  const second = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
    systemdUnit: first.unit!.content,
  });

  assert.equal(second.unit, undefined);
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
  assert.ok(existsSync(join(dir, "vetinari", "config.mts")));
  assert.ok(!existsSync(join(dir, ".sandcastle", "config.mts")));
  // State and secrets, including nested files, are under the new excluded dir.
  assert.equal(readFileSync(join(dir, ".vetinari.local", "logs", "orchestrator.jsonl"), "utf8"), "{}\n");
  assert.equal(readFileSync(join(dir, ".vetinari.local", ".env"), "utf8"), "SECRET=1\n");
  assert.ok(existsSync(join(dir, ".vetinari.local", "parked")));

  // .gitignore now excludes both dirs.
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /^\.vetinari\.local\/$/m);
  assert.match(gi, /^\.sandcastle\/$/m);

  assert.equal(result.gitignoreUpdated, true);
  assert.equal(result.moved.length, plan.moves.length);
});

test("applyLayoutMigration deletes the stale gateway.env and writes the rewritten unit", () => {
  const dir = tmpProject();
  const gatewayDir = join(dir, "host-config", "sandcastle");
  const unitPath = join(dir, "host-config", "systemd", "vetinari-gateway.service");
  mkdirSync(gatewayDir, { recursive: true });
  writeFileSync(join(gatewayDir, "gateway.env"), "VETINARI_TELEGRAM_BOT_TOKEN=abc\n");

  const plan = computeLayoutMigration({
    gatewayConfigDir: gatewayDir,
    gatewayEnv: readFileSync(join(gatewayDir, "gateway.env"), "utf8"),
    systemdUnitPath: unitPath,
    systemdUnit: "ExecStart=exec ./.sandcastle/run dispatch\n",
  });
  // apply must delete the stale env and create the (absent) unit dir before writing.
  const result = applyLayoutMigration(dir, plan);

  // The stale gateway.env is gone — the gateway holds no secrets of its own.
  assert.ok(!existsSync(join(gatewayDir, "gateway.env")));

  const unit = readFileSync(unitPath, "utf8");
  assert.match(unit, /exec vetinari gateway/);
  assert.doesNotMatch(unit, /run dispatch/);
  assert.doesNotMatch(unit, /gateway\.env/);

  assert.equal(result.gatewayEnvDeleted, true);
  assert.equal(result.unitRewritten, true);
});

test("applyLayoutMigration reports nothing deleted or rewritten when the plan carries neither", () => {
  const dir = tmpProject();
  const plan = computeLayoutMigration({ oldState: [], gitignore: ".vetinari.local/\n.sandcastle/\n" });
  const result = applyLayoutMigration(dir, plan);

  assert.equal(result.gatewayEnvDeleted, false);
  assert.equal(result.unitRewritten, false);
});

test("applyLayoutMigration refuses a plan with conflicts and changes nothing", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "logs"), "old\n");
  writeFileSync(join(dir, ".vetinari.local", "logs"), "already here\n");

  const plan = computeLayoutMigration({
    oldState: ["logs"],
    gitignore: ".sandcastle/\n",
    existing: [".vetinari.local/logs"],
  });

  assert.throws(() => applyLayoutMigration(dir, plan), /already exist/i);
  // The pre-existing destination is untouched and the source is left in place.
  assert.equal(readFileSync(join(dir, ".vetinari.local", "logs"), "utf8"), "already here\n");
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
  assert.ok(plan.moves.some((m) => m.to === "vetinari/config.mts"));
  assert.ok(plan.moves.some((m) => m.to === ".vetinari.local/logs"));
});

test("scanLayout reads the host-level gateway + systemd inputs off disk", () => {
  const dir = tmpProject();
  const gatewayHome = join(dir, "host", "sandcastle");
  const unitPath = join(dir, "host", "systemd", "vetinari-gateway.service");
  mkdirSync(gatewayHome, { recursive: true });
  writeFileSync(join(gatewayHome, "gateway.env"), "OTHER=1\n");
  mkdirSync(join(dir, "host", "systemd"), { recursive: true });
  writeFileSync(unitPath, "ExecStart=exec ./.sandcastle/run dispatch\n");

  const prevHome = process.env.VETINARI_GATEWAY_HOME;
  const prevUnit = process.env.VETINARI_SYSTEMD_UNIT;
  process.env.VETINARI_GATEWAY_HOME = gatewayHome;
  process.env.VETINARI_SYSTEMD_UNIT = unitPath;
  try {
    const scan = scanLayout(dir);
    assert.equal(scan.gatewayConfigDir, gatewayHome);
    assert.equal(scan.gatewayEnv, "OTHER=1\n");
    assert.equal(scan.systemdUnitPath, unitPath);
    assert.match(scan.systemdUnit!, /run dispatch/);

    // Fed to the planner it produces the gateway.env deletion and the unit rewrite.
    const plan = computeLayoutMigration(scan);
    assert.equal(plan.gatewayEnvDelete, join(gatewayHome, "gateway.env"));
    assert.ok(plan.unit);
  } finally {
    if (prevHome === undefined) delete process.env.VETINARI_GATEWAY_HOME;
    else process.env.VETINARI_GATEWAY_HOME = prevHome;
    if (prevUnit === undefined) delete process.env.VETINARI_SYSTEMD_UNIT;
    else process.env.VETINARI_SYSTEMD_UNIT = prevUnit;
  }
});

test("scanLayout flags an existing destination so the plan refuses it", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "logs"), "x\n");
  writeFileSync(join(dir, ".vetinari.local", "logs"), "y\n");

  const plan = computeLayoutMigration(scanLayout(dir));
  assert.deepEqual(plan.conflicts, [".vetinari.local/logs"]);
});

test("describeMigration reports nothing to do for an empty plan", () => {
  const text = describeMigration(computeLayoutMigration({ oldState: [], gitignore: ".vetinari.local/\n.sandcastle/\n" }));
  assert.match(text, /nothing to do/i);
});

test("describeMigration summarizes moves and the gitignore edit", () => {
  const text = describeMigration(
    computeLayoutMigration({
      legacyConfig: ".sandcastle/config.mts",
      oldState: ["config.mts", "logs"],
      gitignore: ".sandcastle/\n",
    }),
  );
  assert.match(text, /\.sandcastle\/config\.mts.*vetinari\/config\.mts/);
  assert.match(text, /\.sandcastle\/logs.*\.vetinari\.local\/logs/);
  assert.match(text, /\.gitignore/);
});

test("describeMigration summarizes the gateway.env deletion and the unit rewrite", () => {
  const text = describeMigration(
    computeLayoutMigration({
      gatewayConfigDir: "/home/z/.config/vetinari",
      gatewayEnv: "VETINARI_TELEGRAM_BOT_TOKEN=abc\n",
      systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
      systemdUnit: "ExecStart=exec ./.sandcastle/run dispatch\n",
    }),
  );
  // The stale gateway.env is deleted, not folded into.
  assert.match(text, /[Dd]elete.*gateway\.env/);
  // The unit rewrite is called out with its path.
  assert.match(text, /vetinari-gateway\.service/);
});

test("describeMigration leads with the conflicts when the plan is refused", () => {
  const text = describeMigration(
    computeLayoutMigration({ oldState: ["logs"], gitignore: ".sandcastle/\n", existing: [".vetinari.local/logs"] }),
  );
  assert.match(text, /refus|conflict/i);
  assert.match(text, /\.vetinari\.local\/logs/);
});
