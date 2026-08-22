import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveConfigPath } from "./config.ts";

const CONFIG_BODY = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
};
`;

const writeConfig = (baseDir: string, rel: string, body = CONFIG_BODY) => {
  const full = join(baseDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
};

const scratch = () => mkdtempSync(join(tmpdir(), "sctdd-config-"));

const touch = (baseDir: string, rel: string) => {
  const full = join(baseDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export default {}\n");
  return full;
};

test("resolveConfigPath prefers committed sandcastle/config.mts over every legacy location", () => {
  const dir = scratch();
  touch(dir, "sandcastle/config.mts");
  touch(dir, "sandcastle-tdd.config.mts");
  touch(dir, ".sandcastle/config.mts");

  const res = resolveConfigPath(dir);

  assert.equal(res?.path, join(dir, "sandcastle/config.mts"));
  assert.equal(res?.deprecatedFrom, undefined);
});

for (const legacy of ["sandcastle-tdd.config.mts", "sandcastle-tdd.config.ts", ".sandcastle/config.mts"]) {
  test(`resolveConfigPath reports ${legacy} as a deprecated origin when it is the only config`, () => {
    const dir = scratch();
    touch(dir, legacy);

    const res = resolveConfigPath(dir);

    assert.equal(res?.path, join(dir, legacy));
    assert.equal(res?.deprecatedFrom, legacy);
  });
}

test("resolveConfigPath returns undefined when no candidate exists", () => {
  assert.equal(resolveConfigPath(scratch()), undefined);
});

test("loadConfig defaults state under .sandcastle.local, with parkedDir and logFile following", async () => {
  const cfgPath = writeConfig(scratch(), "sandcastle/config.mts");

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, ".sandcastle.local");
  assert.equal(cfg.parkedDir, ".sandcastle.local/parked");
  assert.equal(cfg.logFile, ".sandcastle.local/logs/orchestrator.jsonl");
});

test("loadConfig's not-found error leads with the canonical path and mentions --config", async () => {
  const cwd = process.cwd();
  process.chdir(scratch());
  try {
    await assert.rejects(loadConfig(), (err: Error) => {
      const msg = err.message;
      assert.match(msg, /--config <path>/);
      // The canonical location leads the message, before any legacy candidate.
      const legacyAt = msg.indexOf("sandcastle-tdd.config");
      const canonicalAt = msg.indexOf("sandcastle/config.mts");
      assert.ok(canonicalAt >= 0, "canonical path is named");
      assert.ok(legacyAt === -1 || canonicalAt < legacyAt, "canonical path leads any legacy mention");
      return true;
    });
  } finally {
    process.chdir(cwd);
  }
});

test("loadConfig warns naming the canonical location when it resolves from a legacy config", async () => {
  const dir = scratch();
  writeConfig(dir, "sandcastle-tdd.config.mts");
  const cwd = process.cwd();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  process.chdir(dir);
  try {
    await loadConfig();
  } finally {
    process.chdir(cwd);
    console.warn = origWarn;
  }

  const warning = warnings.join("\n");
  assert.match(warning, /deprecated/i);
  assert.match(warning, /sandcastle-tdd\.config\.mts/);
  assert.match(warning, /sandcastle\/config\.mts/);
});

test("loadConfig does not warn when resolving from the canonical location", async () => {
  const dir = scratch();
  writeConfig(dir, "sandcastle/config.mts");
  const cwd = process.cwd();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  process.chdir(dir);
  try {
    await loadConfig();
  } finally {
    process.chdir(cwd);
    console.warn = origWarn;
  }

  assert.deepEqual(warnings, []);
});

test("loadConfig honors an explicit stateDir over the flipped default", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "sandcastle/config.mts",
    CONFIG_BODY.replace("fetchTask:", 'stateDir: "custom-state",\n  fetchTask:'),
  );

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, "custom-state");
  assert.equal(cfg.parkedDir, "custom-state/parked");
  assert.equal(cfg.logFile, "custom-state/logs/orchestrator.jsonl");
});
