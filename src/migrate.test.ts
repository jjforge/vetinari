import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLayoutMigration,
  computeLayoutMigration,
  describeMigration,
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
});

test("computeLayoutMigration renames a legacy .sandcastle/orchestrator.env straight to .vetinari.local/host.env", () => {
  const plan = computeLayoutMigration({
    oldState: ["orchestrator.env", "logs"],
    gitignore: ".sandcastle/\n",
  });

  // The host-side secrets file lands under its new name, not carried across
  // verbatim as orchestrator.env.
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

test("describeMigration leads with the conflicts when the plan is refused", () => {
  const text = describeMigration(
    computeLayoutMigration({ oldState: ["logs"], gitignore: ".sandcastle/\n", existing: [".vetinari.local/logs"] }),
  );
  assert.match(text, /refus|conflict/i);
  assert.match(text, /\.vetinari\.local\/logs/);
});
