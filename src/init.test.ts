import test from "node:test";
import assert from "node:assert/strict";
import { computeInit } from "./init.ts";

const TEMPLATES = { configTemplate: "CONFIG SKELETON\n", dockerfileTemplate: "FROM node:22-bookworm\n" };

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
