import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLayoutMigration,
  computeLayoutMigration,
  describeMigration,
  numericWeightToTier,
  resolveGatewayExecStart,
  scanLayout,
  systemdQuoteArg,
} from "./migrate.ts";

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

test("computeLayoutMigration renames a legacy .sandcastle/orchestrator.env straight to .vetinari.local/host.env", () => {
  const plan = computeLayoutMigration({
    oldState: ["orchestrator.env", "logs"],
    gitignore: ".sandcastle/\n",
  });

  // The host-side secrets file lands under its new name (ADR 0011), not carried
  // across verbatim as orchestrator.env.
  assert.deepEqual(
    plan.moves.find((m) => m.from === ".sandcastle/orchestrator.env"),
    { from: ".sandcastle/orchestrator.env", to: ".vetinari.local/host.env" },
  );
  assert.ok(!plan.moves.some((m) => m.to === ".vetinari.local/orchestrator.env"));
});

test("computeLayoutMigration renames an already-migrated .vetinari.local/orchestrator.env to host.env", () => {
  const plan = computeLayoutMigration({
    // Project already on the .vetinari.local/ layout, but its secrets file
    // predates the host.env rename.
    oldState: [],
    localState: ["orchestrator.env", ".env", "parked"],
    gitignore: ".vetinari.local/\n.sandcastle/\n",
  });

  assert.deepEqual(
    plan.moves.find((m) => m.from === ".vetinari.local/orchestrator.env"),
    { from: ".vetinari.local/orchestrator.env", to: ".vetinari.local/host.env" },
  );
  // The container gate (.env) keeps its sandcastle-imposed name, untouched.
  assert.ok(!plan.moves.some((m) => m.from === ".vetinari.local/.env"));
});

test("computeLayoutMigration plans no host.env rename when the local secrets are already renamed", () => {
  const plan = computeLayoutMigration({
    oldState: [],
    localState: ["host.env", ".env"],
    gitignore: ".vetinari.local/\n.sandcastle/\n",
  });

  assert.deepEqual(plan.moves, []);
});

test("computeLayoutMigration plans to strip VETINARI_TELEGRAM_* from the container-gate .env, keeping agent secrets", () => {
  const plan = computeLayoutMigration({
    // A container gate .env that (wrongly) carries the host-side bot credentials
    // alongside the model-harness token the in-container agent legitimately needs.
    containerEnv:
      "CLAUDE_CODE_OAUTH_TOKEN=keepme\n" +
      "VETINARI_TELEGRAM_BOT_TOKEN=leaked\n" +
      "VETINARI_TELEGRAM_CHAT_ID=123\n" +
      "VETINARI_TELEGRAM_THREAD_ID=7\n",
  });

  assert.ok(plan.envRewrite, "expected an env rewrite");
  assert.equal(plan.envRewrite!.path, ".vetinari.local/.env");
  // The host-side secrets are gone from the container gate...
  assert.doesNotMatch(plan.envRewrite!.content, /VETINARI_TELEGRAM_/);
  // ...while the agent's own token survives.
  assert.match(plan.envRewrite!.content, /^CLAUDE_CODE_OAUTH_TOKEN=keepme$/m);
  assert.deepEqual(plan.envRewrite!.stripped, [
    "VETINARI_TELEGRAM_BOT_TOKEN",
    "VETINARI_TELEGRAM_CHAT_ID",
    "VETINARI_TELEGRAM_THREAD_ID",
  ]);
  // A warning names what was stripped and calls for rotation of the exposed token.
  assert.ok(plan.warnings.some((w) => /rotate/i.test(w) && /VETINARI_TELEGRAM/.test(w)));
});

test("computeLayoutMigration plans no env rewrite when the container .env carries no host secrets", () => {
  const plan = computeLayoutMigration({
    containerEnv: "CLAUDE_CODE_OAUTH_TOKEN=keepme\n",
  });
  assert.equal(plan.envRewrite, undefined);
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

test("numericWeightToTier maps an old numeric hostWeight to the nearest containerShare tier", () => {
  // Tiers map to internal weights 1/2/7; nearest by distance, midpoints 1.5 and 4.5.
  assert.equal(numericWeightToTier(1), "low");
  assert.equal(numericWeightToTier(0.5), "low");
  assert.equal(numericWeightToTier(2), "medium");
  assert.equal(numericWeightToTier(3), "medium");
  assert.equal(numericWeightToTier(4), "medium");
  assert.equal(numericWeightToTier(5), "high");
  assert.equal(numericWeightToTier(7), "high");
  assert.equal(numericWeightToTier(1.5), "medium");
  assert.equal(numericWeightToTier(4.5), "high");
});

test("systemdQuoteArg leaves an ordinary absolute path unquoted", () => {
  // No whitespace or metacharacters — a clean path needs no quoting, so the line
  // reads exactly like the paths systemd will exec.
  assert.equal(systemdQuoteArg("/opt/node/bin/node"), "/opt/node/bin/node");
  assert.equal(systemdQuoteArg("file:///app/node_modules/tsx/dist/loader.mjs"), "file:///app/node_modules/tsx/dist/loader.mjs");
});

test("systemdQuoteArg double-quotes an argument with a space (a home dir with a space)", () => {
  // systemd splits ExecStart on whitespace, so a path with a space must be quoted
  // or it would be read as two arguments.
  assert.equal(systemdQuoteArg("/home/z z/node"), '"/home/z z/node"');
  // Embedded quotes and backslashes are escaped inside the double quotes.
  assert.equal(systemdQuoteArg('a "b" c'), '"a \\"b\\" c"');
  assert.equal(systemdQuoteArg("a\\b c"), '"a\\\\b c"');
});

test("resolveGatewayExecStart bakes an absolute node + tsx-loader + cli invocation, PATH-independent", () => {
  const line = resolveGatewayExecStart({
    execPath: "/opt/node/bin/node",
    execArgv: ["--require", "/app/node_modules/tsx/dist/preflight.cjs", "--import", "file:///app/node_modules/tsx/dist/loader.mjs"],
    argv1: "/app/src/cli.mts",
  });

  assert.equal(
    line,
    "ExecStart=/opt/node/bin/node --require /app/node_modules/tsx/dist/preflight.cjs " +
      "--import file:///app/node_modules/tsx/dist/loader.mjs /app/src/cli.mts gateway",
  );
  // Absolute node, the gateway command last, and NONE of the PATH-dependent launchers.
  assert.match(line, /^ExecStart=\/opt\/node\/bin\/node /);
  assert.match(line, / gateway$/);
  assert.doesNotMatch(line, /\bbash\b/);
  assert.doesNotMatch(line, /\benv\b/);
  assert.doesNotMatch(line, /\bnpx\b/);
});

test("resolveGatewayExecStart quotes a launch path that contains a space", () => {
  const line = resolveGatewayExecStart({
    execPath: "/home/z z/.nvm/node",
    execArgv: [],
    argv1: "/app/src/cli.mts",
  });
  assert.match(line, /ExecStart="\/home\/z z\/\.nvm\/node" \/app\/src\/cli\.mts gateway/);
});

test("computeLayoutMigration rewrites a numeric hostWeight into a containerShare tier in an already-migrated config", () => {
  const plan = computeLayoutMigration({
    configRel: "vetinari/config.mts",
    configContent: `export default {\n  project: "demo",\n  hostWeight: 3,\n  gates: [],\n};\n`,
  });

  assert.ok(plan.configRewrite);
  assert.equal(plan.configRewrite!.path, "vetinari/config.mts");
  assert.match(plan.configRewrite!.content, /containerShare: "medium"/);
  assert.doesNotMatch(plan.configRewrite!.content, /hostWeight/);
});

test("computeLayoutMigration rewrites hostWeight at the config's DESTINATION when it is a legacy config being moved", () => {
  const plan = computeLayoutMigration({
    legacyConfig: ".sandcastle/config.mts",
    configRel: ".sandcastle/config.mts",
    configContent: `export default {\n  project: "demo",\n  hostWeight: 7,\n};\n`,
    oldState: ["config.mts"],
  });

  // The rewrite lands on the moved-to canonical path, not the legacy one.
  assert.equal(plan.configRewrite!.path, "vetinari/config.mts");
  assert.match(plan.configRewrite!.content, /containerShare: "high"/);
});

test("computeLayoutMigration plans no config rewrite when the config carries no hostWeight", () => {
  const plan = computeLayoutMigration({
    configRel: "vetinari/config.mts",
    configContent: `export default {\n  project: "demo",\n  containerShare: "low",\n};\n`,
  });
  assert.equal(plan.configRewrite, undefined);
});

test("computeLayoutMigration renames a legacy host-slots ceiling file to max-concurrent-containers", () => {
  const plan = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    hostCeilingLegacy: "6\n",
  });

  assert.deepEqual(plan.hostCeilingRename, {
    from: "/home/z/.config/vetinari/host-slots",
    to: "/home/z/.config/vetinari/max-concurrent-containers",
  });
});

test("computeLayoutMigration plans no ceiling-file rename when no legacy host-slots file exists", () => {
  const plan = computeLayoutMigration({ gatewayConfigDir: "/home/z/.config/vetinari" });
  assert.equal(plan.hostCeilingRename, undefined);
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

// A resolved, PATH-independent launch chain as `scanLayout` would hand the planner
// on this host — absolute node + tsx loader flags + the cli entrypoint.
const GATEWAY_EXEC_START = resolveGatewayExecStart({
  execPath: "/opt/node/bin/node",
  execArgv: ["--require", "/app/node_modules/tsx/dist/preflight.cjs", "--import", "file:///app/node_modules/tsx/dist/loader.mjs"],
  argv1: "/app/src/cli.mts",
});

test("computeLayoutMigration rewrites the per-project dispatch unit into the host-level gateway service", () => {
  const plan = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
    systemdUnit: DISPATCH_UNIT,
    gatewayExecStart: GATEWAY_EXEC_START,
  });

  assert.ok(plan.unit, "expected a unit rewrite");
  assert.equal(plan.unit!.path, "/home/z/.config/systemd/user/vetinari-gateway.service");
  // No longer bound to one project's directory...
  assert.doesNotMatch(plan.unit!.content, /WorkingDirectory=/);
  assert.doesNotMatch(plan.unit!.content, /jjforge/);
  // ...and it launches the gateway via the resolved absolute chain, not the retired
  // dispatch poller — and never through the crash-looping bash -lc / env / npx path.
  assert.match(plan.unit!.content, new RegExp(GATEWAY_EXEC_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(plan.unit!.content, /run dispatch/);
  assert.doesNotMatch(plan.unit!.content, /bash -lc/);
  assert.doesNotMatch(plan.unit!.content, /\benv\b/);
  assert.doesNotMatch(plan.unit!.content, /\bnpx\b/);
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
    gatewayExecStart: GATEWAY_EXEC_START,
  });
  // Feed the rewritten unit straight back in — a second migrate, resolving the same
  // host's launch chain, must change nothing.
  const second = computeLayoutMigration({
    gatewayConfigDir: "/home/z/.config/vetinari",
    systemdUnitPath: "/home/z/.config/systemd/user/vetinari-gateway.service",
    systemdUnit: first.unit!.content,
    gatewayExecStart: GATEWAY_EXEC_START,
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
    gatewayExecStart: GATEWAY_EXEC_START,
  });
  // apply must delete the stale env and create the (absent) unit dir before writing.
  const result = applyLayoutMigration(dir, plan);

  // The stale gateway.env is gone — the gateway holds no secrets of its own.
  assert.ok(!existsSync(join(gatewayDir, "gateway.env")));

  const unit = readFileSync(unitPath, "utf8");
  assert.match(unit, new RegExp(GATEWAY_EXEC_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(unit, /run dispatch/);
  assert.doesNotMatch(unit, /gateway\.env/);

  assert.equal(result.gatewayEnvDeleted, true);
  assert.equal(result.unitRewritten, true);
});

test("applyLayoutMigration strips VETINARI_TELEGRAM_* from a legacy .env as it moves it, keeping agent secrets", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".sandcastle"), { recursive: true });
  writeFileSync(
    join(dir, ".sandcastle", ".env"),
    "CLAUDE_CODE_OAUTH_TOKEN=keepme\nVETINARI_TELEGRAM_BOT_TOKEN=leaked\nVETINARI_TELEGRAM_CHAT_ID=123\n",
  );
  writeFileSync(join(dir, ".gitignore"), ".sandcastle/\n");

  const plan = computeLayoutMigration(scanLayout(dir));
  const result = applyLayoutMigration(dir, plan);

  // The container gate landed in the new excluded dir with its host secrets gone...
  const env = readFileSync(join(dir, ".vetinari.local", ".env"), "utf8");
  assert.doesNotMatch(env, /VETINARI_TELEGRAM_/);
  // ...and the in-container agent's own token intact.
  assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=keepme$/m);
  assert.equal(result.envRewritten, true);
});

test("the assembled container env for a run excludes VETINARI_TELEGRAM_* after migrate", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  // The container gate as sandcastle would inject it: every key here rides into
  // the agent container, so a leaked bot token would too.
  writeFileSync(
    join(dir, ".vetinari.local", ".env"),
    "CLAUDE_CODE_OAUTH_TOKEN=keepme\nVETINARI_TELEGRAM_BOT_TOKEN=leaked\nVETINARI_TELEGRAM_CHAT_ID=123\nVETINARI_TELEGRAM_THREAD_ID=7\n",
  );

  applyLayoutMigration(dir, computeLayoutMigration(scanLayout(dir)));

  // Model the assembled container env exactly as sandcastle does: every KEY=VALUE
  // in .env becomes a container environment variable. None may be a Telegram secret.
  const containerEnvKeys = readFileSync(join(dir, ".vetinari.local", ".env"), "utf8")
    .split("\n")
    .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l.trim())?.[1])
    .filter((k): k is string => Boolean(k));

  assert.ok(!containerEnvKeys.some((k) => k.startsWith("VETINARI_TELEGRAM_")));
  assert.ok(containerEnvKeys.includes("CLAUDE_CODE_OAUTH_TOKEN"));
});

test("applyLayoutMigration renames an already-migrated orchestrator.env to host.env on disk", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  writeFileSync(join(dir, ".vetinari.local", "orchestrator.env"), "VETINARI_TELEGRAM_BOT_TOKEN=tok\n");
  writeFileSync(join(dir, ".vetinari.local", ".env"), "MODEL_TOKEN=x\n");

  const plan = computeLayoutMigration(scanLayout(dir));
  applyLayoutMigration(dir, plan);

  // The host-side secrets moved to host.env, contents intact...
  assert.equal(readFileSync(join(dir, ".vetinari.local", "host.env"), "utf8"), "VETINARI_TELEGRAM_BOT_TOKEN=tok\n");
  assert.ok(!existsSync(join(dir, ".vetinari.local", "orchestrator.env")));
  // ...and the container gate .env is left exactly where it was.
  assert.equal(readFileSync(join(dir, ".vetinari.local", ".env"), "utf8"), "MODEL_TOKEN=x\n");
});

test("applyLayoutMigration rewrites a numeric hostWeight into a containerShare tier on disk", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "vetinari"), { recursive: true });
  writeFileSync(join(dir, "vetinari", "config.mts"), `export default {\n  project: "demo",\n  hostWeight: 5,\n  gates: [],\n};\n`);

  const plan = computeLayoutMigration({
    configRel: "vetinari/config.mts",
    configContent: readFileSync(join(dir, "vetinari", "config.mts"), "utf8"),
  });
  const result = applyLayoutMigration(dir, plan);

  const rewritten = readFileSync(join(dir, "vetinari", "config.mts"), "utf8");
  assert.match(rewritten, /containerShare: "high"/);
  assert.doesNotMatch(rewritten, /hostWeight/);
  assert.equal(result.configRewritten, true);
});

test("applyLayoutMigration renames the host-ceiling file on disk, preserving its value", () => {
  const dir = tmpProject();
  const gatewayDir = join(dir, "host-config");
  mkdirSync(gatewayDir, { recursive: true });
  writeFileSync(join(gatewayDir, "host-slots"), "6\n");

  const plan = computeLayoutMigration({ gatewayConfigDir: gatewayDir, hostCeilingLegacy: "6\n" });
  const result = applyLayoutMigration(dir, plan);

  assert.ok(!existsSync(join(gatewayDir, "host-slots")));
  assert.equal(readFileSync(join(gatewayDir, "max-concurrent-containers"), "utf8"), "6\n");
  assert.equal(result.hostCeilingRenamed, true);
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

test("scanLayout reads the .vetinari.local/ entries so the planner can rename the secrets file", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  writeFileSync(join(dir, ".vetinari.local", "orchestrator.env"), "VETINARI_TELEGRAM_BOT_TOKEN=tok\n");
  writeFileSync(join(dir, ".vetinari.local", ".env"), "MODEL_TOKEN=x\n");

  const scan = scanLayout(dir);
  assert.ok(scan.localState!.includes("orchestrator.env"));

  // Fed to the planner it produces the host.env rename.
  const plan = computeLayoutMigration(scan);
  assert.ok(plan.moves.some((m) => m.from === ".vetinari.local/orchestrator.env" && m.to === ".vetinari.local/host.env"));
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
    // The resolved launch chain is baked from this process — an absolute node, no
    // PATH-dependent launcher — so the rewrite is immune to systemd's clean PATH.
    assert.match(scan.gatewayExecStart!, /^ExecStart=\//);
    assert.doesNotMatch(scan.gatewayExecStart!, /bash -lc|\benv\b|\bnpx\b/);

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
      gatewayExecStart: GATEWAY_EXEC_START,
    }),
  );
  // The stale gateway.env is deleted, not folded into.
  assert.match(text, /[Dd]elete.*gateway\.env/);
  // The unit rewrite is called out with its path.
  assert.match(text, /vetinari-gateway\.service/);
});

test("describeMigration reports the .env strip (and does not read as nothing-to-do)", () => {
  const text = describeMigration(
    computeLayoutMigration({
      // Already on the layout; the only thing left to do is close the .env leak.
      oldState: [],
      gitignore: ".vetinari.local/\n.sandcastle/\n",
      containerEnv: "CLAUDE_CODE_OAUTH_TOKEN=keepme\nVETINARI_TELEGRAM_BOT_TOKEN=leaked\n",
    }),
  );
  assert.doesNotMatch(text, /nothing to do/i);
  assert.match(text, /VETINARI_TELEGRAM_BOT_TOKEN/);
  assert.match(text, /rotate/i);
});

test("describeMigration leads with the conflicts when the plan is refused", () => {
  const text = describeMigration(
    computeLayoutMigration({ oldState: ["logs"], gitignore: ".sandcastle/\n", existing: [".vetinari.local/logs"] }),
  );
  assert.match(text, /refus|conflict/i);
  assert.match(text, /\.vetinari\.local\/logs/);
});
