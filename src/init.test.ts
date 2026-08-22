import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInit, computeInit, describeInit, scanInit } from "./init.ts";

const TEMPLATES = { configTemplate: "CONFIG SKELETON\n", dockerfileTemplate: "FROM node:22-bookworm\n" };

let counter = 0;
const tmpProject = () => {
  const dir = join(tmpdir(), `sctdd-init-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("computeInit plans the full scaffold for a fresh directory", () => {
  const plan = computeInit({ hasConfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES });

  // Not a refusal — greenfield project, so the committed scaffold is laid down.
  assert.equal(plan.refused, false);
  // The committed sandcastle/ scaffold: a defineConfig skeleton and a Dockerfile.
  assert.deepEqual(
    plan.creates.find((c) => c.path === "sandcastle/config.mts"),
    { path: "sandcastle/config.mts", content: "CONFIG SKELETON\n" },
  );
  assert.deepEqual(
    plan.creates.find((c) => c.path === "sandcastle/Dockerfile"),
    { path: "sandcastle/Dockerfile", content: "FROM node:22-bookworm\n" },
  );
  // The excluded machine-local dir is created...
  assert.ok(plan.dirs.includes(".sandcastle.local"));
  // ...and .gitignore gains its entry (the file was absent, so it is created).
  assert.match(plan.gitignore!, /^\.sandcastle\.local\/$/m);
});

test("computeInit yields an empty plan for an already-initialized directory", () => {
  const plan = computeInit({
    // Config present, local dir present, and .gitignore already excludes it.
    hasConfig: true,
    hasLocalDir: true,
    gitignore: "node_modules/\n.sandcastle.local/\n*.log\n",
    ...TEMPLATES,
  });

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.dirs, []);
  assert.equal(plan.gitignore, undefined);
});

test("computeInit refuses to overwrite an existing config but still fills missing pieces", () => {
  const plan = computeInit({
    // A config the maintainer already wrote — never to be clobbered.
    hasConfig: true,
    // ...but the machine-local dir and the gitignore entry are still missing.
    hasLocalDir: false,
    gitignore: "node_modules/\n",
    ...TEMPLATES,
  });

  // The committed scaffold is withheld — no config, no Dockerfile write.
  assert.equal(plan.refused, true);
  assert.equal(plan.creates.length, 0);
  // The missing machine-local pieces are still planned, without disturbing config.
  assert.ok(plan.dirs.includes(".sandcastle.local"));
  assert.match(plan.gitignore!, /^\.sandcastle\.local\/$/m);
});

test("computeInit plans only the gitignore edit when that is the sole missing piece", () => {
  const plan = computeInit({
    hasConfig: true,
    hasLocalDir: true,
    // Everything is in place except the .gitignore entry.
    gitignore: "node_modules/\n*.log\n",
    ...TEMPLATES,
  });

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.dirs, []);
  // The excluded dir is appended; the pre-existing lines survive.
  assert.match(plan.gitignore!, /^\.sandcastle\.local\/$/m);
  assert.match(plan.gitignore!, /^node_modules\/$/m);
});

test("computeInit adds nothing to a .gitignore that already lists the entry without a trailing slash", () => {
  const plan = computeInit({ hasConfig: true, hasLocalDir: true, gitignore: ".sandcastle.local\n", ...TEMPLATES });
  assert.equal(plan.gitignore, undefined);
});

test("applyInit lays the scaffold down where the plan says, against a tmp dir", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const plan = computeInit({
    hasConfig: false,
    hasLocalDir: false,
    gitignore: readFileSync(join(dir, ".gitignore"), "utf8"),
    ...TEMPLATES,
  });
  const result = applyInit(dir, plan);

  // Committed scaffold files land with the template content.
  assert.equal(readFileSync(join(dir, "sandcastle", "config.mts"), "utf8"), "CONFIG SKELETON\n");
  assert.equal(readFileSync(join(dir, "sandcastle", "Dockerfile"), "utf8"), "FROM node:22-bookworm\n");
  // The excluded machine-local dir exists.
  assert.ok(statSync(join(dir, ".sandcastle.local")).isDirectory());
  // .gitignore now excludes it, keeping the pre-existing entry.
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /^\.sandcastle\.local\/$/m);
  assert.match(gi, /^node_modules\/$/m);

  assert.deepEqual(result.created.sort(), ["sandcastle/Dockerfile", "sandcastle/config.mts"]);
  assert.deepEqual(result.dirsCreated, [".sandcastle.local"]);
  assert.equal(result.gitignoreUpdated, true);
});

test("applyInit refuses to clobber a committed scaffold file that appeared since the scan", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "sandcastle"), { recursive: true });
  writeFileSync(join(dir, "sandcastle", "config.mts"), "MINE — do not touch\n");

  // A stale plan (scanned when the config was absent) must not overwrite it.
  const stalePlan = computeInit({ hasConfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES });
  assert.throws(() => applyInit(dir, stalePlan), /already exists/i);
  assert.equal(readFileSync(join(dir, "sandcastle", "config.mts"), "utf8"), "MINE — do not touch\n");
});

test("applyInit fills only the gitignore when that is all the plan carries", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const plan = computeInit({ hasConfig: true, hasLocalDir: true, gitignore: "node_modules/\n", ...TEMPLATES });
  const result = applyInit(dir, plan);

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.dirsCreated, []);
  assert.equal(result.gitignoreUpdated, true);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.sandcastle\.local\/$/m);
});

test("describeInit reports nothing to do for an empty plan", () => {
  const text = describeInit(computeInit({ hasConfig: true, hasLocalDir: true, gitignore: ".sandcastle.local/\n", ...TEMPLATES }));
  assert.match(text, /nothing to do/i);
});

test("describeInit summarizes the full scaffold and the next steps", () => {
  const text = describeInit(computeInit({ hasConfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES }));

  assert.match(text, /sandcastle\/config\.mts/);
  assert.match(text, /sandcastle\/Dockerfile/);
  assert.match(text, /\.sandcastle\.local/);
  assert.match(text, /\.gitignore/);
  // The next steps: fill Dockerfile/gates, build the image, run baseline.
  assert.match(text, /baseline/);
  assert.match(text, /build/i);
});

test("describeInit leads with a clear refusal when a config already exists", () => {
  const text = describeInit(computeInit({ hasConfig: true, hasLocalDir: false, gitignore: "node_modules/\n", ...TEMPLATES }));

  // The config is called out as untouched...
  assert.match(text, /sandcastle\/config\.mts/);
  assert.match(text, /already exists|untouched/i);
  // ...and the still-missing pieces it filled are listed.
  assert.match(text, /\.sandcastle\.local/);
});

test("scanInit reads a fresh directory and the install templates into a scan the planner can use", () => {
  const dir = tmpProject();

  const scan = scanInit(dir);

  assert.equal(scan.hasConfig, false);
  assert.equal(scan.hasLocalDir, false);
  assert.equal(scan.gitignore, undefined);
  // Templates come from the shared install, not the project.
  assert.match(scan.configTemplate, /defineConfig/);
  assert.match(scan.dockerfileTemplate, /^FROM /m);

  // Fed to the planner it produces the full scaffold.
  const plan = computeInit(scan);
  assert.equal(plan.refused, false);
  assert.ok(plan.creates.some((c) => c.path === "sandcastle/config.mts"));
});

test("scanInit detects an existing canonical config and the excluded dir off disk", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "sandcastle"), { recursive: true });
  writeFileSync(join(dir, "sandcastle", "config.mts"), "export default {}\n");
  mkdirSync(join(dir, ".sandcastle.local"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const scan = scanInit(dir);

  assert.equal(scan.hasConfig, true);
  assert.equal(scan.hasLocalDir, true);
  assert.equal(scan.gitignore, "node_modules/\n");

  // The planner refuses the committed scaffold but plans the gitignore entry.
  const plan = computeInit(scan);
  assert.equal(plan.refused, true);
  assert.match(plan.gitignore!, /^\.sandcastle\.local\/$/m);
});
