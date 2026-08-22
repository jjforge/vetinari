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
  // The gateway-coupled parts (E3) are no longer deferred, so a layout-only scan
  // carries no "handle it in E3" warning.
  assert.deepEqual(plan.warnings, []);
});

test("computeLayoutMigration folds orchestrator.env into the gateway host-level config", () => {
  const plan = computeLayoutMigration({
    orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/home/z/.gitconfig\n",
    gatewayConfigDir: "/home/z/.config/sandcastle",
  });

  assert.ok(plan.hostConfig, "expected a host-config fold");
  assert.equal(plan.hostConfig!.path, "/home/z/.config/sandcastle/gateway.env");
  assert.match(plan.hostConfig!.content, /^SANDCASTLE_TELEGRAM_BOT_TOKEN=abc$/m);
  assert.match(plan.hostConfig!.content, /^GIT_CONFIG_GLOBAL=\/home\/z\/\.gitconfig$/m);
  assert.deepEqual(plan.hostConfig!.folded.sort(), ["GIT_CONFIG_GLOBAL", "SANDCASTLE_TELEGRAM_BOT_TOKEN"]);
});

test("computeLayoutMigration fold is idempotent — already-present keys with the same value add nothing", () => {
  const plan = computeLayoutMigration({
    orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/home/z/.gitconfig\n",
    gatewayConfigDir: "/home/z/.config/sandcastle",
    // The gateway already carries both keys, verbatim.
    gatewayEnv: "GIT_CONFIG_GLOBAL=/home/z/.gitconfig\nSANDCASTLE_TELEGRAM_BOT_TOKEN=abc\n",
  });

  assert.equal(plan.hostConfig, undefined);
  assert.deepEqual(plan.conflicts, []);
});

test("computeLayoutMigration fold appends only the missing keys, preserving the existing gateway env", () => {
  const plan = computeLayoutMigration({
    orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/home/z/.gitconfig\n",
    gatewayConfigDir: "/home/z/.config/sandcastle",
    // Only the token is already there; GIT_CONFIG_GLOBAL is new.
    gatewayEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\n",
  });

  assert.deepEqual(plan.hostConfig!.folded, ["GIT_CONFIG_GLOBAL"]);
  // The pre-existing line survives and the new key is appended, not rewritten.
  assert.match(plan.hostConfig!.content, /^SANDCASTLE_TELEGRAM_BOT_TOKEN=abc$/m);
  assert.match(plan.hostConfig!.content, /^GIT_CONFIG_GLOBAL=\/home\/z\/\.gitconfig$/m);
  assert.deepEqual(plan.conflicts, []);
});

test("computeLayoutMigration fold refuses a key whose gateway value differs, rather than clobbering it", () => {
  const plan = computeLayoutMigration({
    orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=fromProject\n",
    gatewayConfigDir: "/home/z/.config/sandcastle",
    // The gateway already has a DIFFERENT token (another project got there first).
    gatewayEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=alreadyHere\n",
  });

  assert.ok(plan.conflicts.some((c) => /SANDCASTLE_TELEGRAM_BOT_TOKEN/.test(c)));
  // The conflicting key is not folded in.
  assert.ok(!plan.hostConfig?.folded.includes("SANDCASTLE_TELEGRAM_BOT_TOKEN"));
});

const DISPATCH_UNIT = [
  "[Unit]",
  "Description=sandcastle-tdd Telegram dispatch poller (jjforge)",
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
    gatewayConfigDir: "/home/z/.config/sandcastle",
    systemdUnitPath: "/home/z/.config/systemd/user/sandcastle-dispatch.service",
    systemdUnit: DISPATCH_UNIT,
  });

  assert.ok(plan.unit, "expected a unit rewrite");
  assert.equal(plan.unit!.path, "/home/z/.config/systemd/user/sandcastle-dispatch.service");
  // No longer bound to one project's directory...
  assert.doesNotMatch(plan.unit!.content, /WorkingDirectory=/);
  assert.doesNotMatch(plan.unit!.content, /jjforge/);
  // ...and it runs the gateway, not the retired dispatch poller.
  assert.match(plan.unit!.content, /exec sandcastle-tdd gateway/);
  assert.doesNotMatch(plan.unit!.content, /run dispatch/);
  // It sources the folded host-level env, not a project's orchestrator.env.
  assert.match(plan.unit!.content, /source \/home\/z\/\.config\/sandcastle\/gateway\.env/);
});

test("computeLayoutMigration leaves an already-gateway unit untouched (idempotent rewrite)", () => {
  const first = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/sandcastle",
    systemdUnitPath: "/home/z/.config/systemd/user/sandcastle-dispatch.service",
    systemdUnit: DISPATCH_UNIT,
  });
  // Feed the rewritten unit straight back in — a second migrate must change nothing.
  const second = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/sandcastle",
    systemdUnitPath: "/home/z/.config/systemd/user/sandcastle-dispatch.service",
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

test("applyLayoutMigration writes the folded gateway env and the rewritten unit", () => {
  const dir = tmpProject();
  const gatewayDir = join(dir, "host-config", "sandcastle");
  const unitPath = join(dir, "host-config", "systemd", "sandcastle-dispatch.service");

  const plan = computeLayoutMigration({
    orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/home/z/.gitconfig\n",
    gatewayConfigDir: gatewayDir,
    systemdUnitPath: unitPath,
    systemdUnit: "ExecStart=exec ./.sandcastle/run dispatch\n",
  });
  // apply must create the (absent) host dirs and land both writes.
  const result = applyLayoutMigration(dir, plan);

  const env = readFileSync(join(gatewayDir, "gateway.env"), "utf8");
  assert.match(env, /^SANDCASTLE_TELEGRAM_BOT_TOKEN=abc$/m);
  assert.match(env, /^GIT_CONFIG_GLOBAL=\/home\/z\/\.gitconfig$/m);

  const unit = readFileSync(unitPath, "utf8");
  assert.match(unit, /exec sandcastle-tdd gateway/);
  assert.doesNotMatch(unit, /run dispatch/);

  assert.equal(result.hostConfigWritten, true);
  assert.equal(result.unitRewritten, true);
});

test("applyLayoutMigration reports nothing folded or rewritten when the plan carries neither", () => {
  const dir = tmpProject();
  const plan = computeLayoutMigration({ oldState: [], gitignore: ".sandcastle.local/\n.sandcastle/\n" });
  const result = applyLayoutMigration(dir, plan);

  assert.equal(result.hostConfigWritten, false);
  assert.equal(result.unitRewritten, false);
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

test("scanLayout reads orchestrator.env and the host-level gateway + systemd inputs off disk", () => {
  const dir = tmpProject();
  const gatewayHome = join(dir, "host", "sandcastle");
  const unitPath = join(dir, "host", "systemd", "sandcastle-dispatch.service");
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  writeFileSync(join(dir, ".sandcastle", "orchestrator.env"), "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/g\n");
  mkdirSync(gatewayHome, { recursive: true });
  writeFileSync(join(gatewayHome, "gateway.env"), "OTHER=1\n");
  mkdirSync(join(dir, "host", "systemd"), { recursive: true });
  writeFileSync(unitPath, "ExecStart=exec ./.sandcastle/run dispatch\n");

  const prevHome = process.env.SANDCASTLE_GATEWAY_HOME;
  const prevUnit = process.env.SANDCASTLE_SYSTEMD_UNIT;
  process.env.SANDCASTLE_GATEWAY_HOME = gatewayHome;
  process.env.SANDCASTLE_SYSTEMD_UNIT = unitPath;
  try {
    const scan = scanLayout(dir);
    assert.match(scan.orchestratorEnv!, /SANDCASTLE_TELEGRAM_BOT_TOKEN=abc/);
    assert.equal(scan.gatewayConfigDir, gatewayHome);
    assert.equal(scan.gatewayEnv, "OTHER=1\n");
    assert.equal(scan.systemdUnitPath, unitPath);
    assert.match(scan.systemdUnit!, /run dispatch/);

    // Fed to the planner it produces the fold and the unit rewrite.
    const plan = computeLayoutMigration(scan);
    assert.deepEqual(plan.hostConfig!.folded.sort(), ["GIT_CONFIG_GLOBAL", "SANDCASTLE_TELEGRAM_BOT_TOKEN"]);
    assert.ok(plan.unit);
  } finally {
    if (prevHome === undefined) delete process.env.SANDCASTLE_GATEWAY_HOME;
    else process.env.SANDCASTLE_GATEWAY_HOME = prevHome;
    if (prevUnit === undefined) delete process.env.SANDCASTLE_SYSTEMD_UNIT;
    else process.env.SANDCASTLE_SYSTEMD_UNIT = prevUnit;
  }
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

test("describeMigration summarizes moves and the gitignore edit", () => {
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
});

test("describeMigration summarizes the orchestrator.env fold and the unit rewrite", () => {
  const text = describeMigration(
    computeLayoutMigration({
      orchestratorEnv: "SANDCASTLE_TELEGRAM_BOT_TOKEN=abc\nGIT_CONFIG_GLOBAL=/home/z/.gitconfig\n",
      gatewayConfigDir: "/home/z/.config/sandcastle",
      systemdUnitPath: "/home/z/.config/systemd/user/sandcastle-dispatch.service",
      systemdUnit: "ExecStart=exec ./.sandcastle/run dispatch\n",
    }),
  );
  // The fold: which keys, into the gateway host config.
  assert.match(text, /gateway\.env/);
  assert.match(text, /SANDCASTLE_TELEGRAM_BOT_TOKEN/);
  assert.match(text, /GIT_CONFIG_GLOBAL/);
  // The unit rewrite is called out with its path.
  assert.match(text, /sandcastle-dispatch\.service/);
});

test("describeMigration leads with the conflicts when the plan is refused", () => {
  const text = describeMigration(
    computeLayoutMigration({ oldState: ["logs"], gitignore: ".sandcastle/\n", existing: [".sandcastle.local/logs"] }),
  );
  assert.match(text, /refus|conflict/i);
  assert.match(text, /\.sandcastle\.local\/logs/);
});
