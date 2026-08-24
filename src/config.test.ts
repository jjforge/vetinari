import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveConfigPath, resolveDestination } from "./config.ts";

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

const scratch = () => mkdtempSync(join(tmpdir(), "vetinari-config-"));

const touch = (baseDir: string, rel: string) => {
  const full = join(baseDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export default {}\n");
  return full;
};

test("resolveConfigPath prefers committed vetinari/config.mts over every legacy location", () => {
  const dir = scratch();
  touch(dir, "vetinari/config.mts");
  touch(dir, ".sandcastle/config.mts");

  const res = resolveConfigPath(dir);

  assert.equal(res?.path, join(dir, "vetinari/config.mts"));
  assert.equal(res?.deprecatedFrom, undefined);
});

for (const legacy of [".sandcastle/config.mts"]) {
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

test("loadConfig defaults state under .vetinari.local, with parkedDir and logFile following", async () => {
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts");

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, ".vetinari.local");
  assert.equal(cfg.parkedDir, ".vetinari.local/parked");
  assert.equal(cfg.logFile, ".vetinari.local/logs/orchestrator.jsonl");
});

test("loadConfig defaults hostWeight to 1, and honors an explicit weight", async () => {
  const dflt = await loadConfig(writeConfig(scratch(), "vetinari/config.mts"));
  assert.equal(dflt.hostWeight, 1);

  const weighted = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
  hostWeight: 3,
};
`;
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", weighted));
  assert.equal(cfg.hostWeight, 3);
});

test("loadConfig's not-found error leads with the canonical path and mentions --config", async () => {
  const cwd = process.cwd();
  process.chdir(scratch());
  try {
    await assert.rejects(loadConfig(), (err: Error) => {
      const msg = err.message;
      assert.match(msg, /--config <path>/);
      assert.match(msg, /vetinari\/config\.mts/);
      return true;
    });
  } finally {
    process.chdir(cwd);
  }
});

test("loadConfig warns naming the canonical location when it resolves from a legacy config", async () => {
  const dir = scratch();
  writeConfig(dir, ".sandcastle/config.mts");
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
  assert.match(warning, /\.sandcastle\/config\.mts/);
  assert.match(warning, /vetinari\/config\.mts/);
});

test("loadConfig does not warn when resolving from the canonical location", async () => {
  const dir = scratch();
  writeConfig(dir, "vetinari/config.mts");
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

test("resolveDestination prefers a bare category entry over the wildcard default", () => {
  const notify = { "*": "ops", failure: "alerts" };

  assert.equal(resolveDestination(notify, "failure"), "alerts");
  assert.equal(resolveDestination(notify, "success"), "ops");
});

test("resolveDestination lets an exact category:event entry win over the bare category and wildcard", () => {
  const notify = { "*": "ops", progress: "chatter", "progress:carve": "alerts" };

  assert.equal(resolveDestination(notify, "progress", "carve"), "alerts");
  // An event with no exact entry falls back to the bare category, not the wildcard.
  assert.equal(resolveDestination(notify, "progress", "wave-start"), "chatter");
});

test("resolveDestination returns undefined for an unmapped category with no wildcard", () => {
  const notify = { failure: "alerts" };

  assert.equal(resolveDestination(notify, "success"), undefined);
  assert.equal(resolveDestination(notify, "progress", "carve"), undefined);
});

const withNotify = (notify: string) =>
  CONFIG_BODY.replace("fetchTask:", `notify: ${notify},\n  fetchTask:`);

test("loadConfig rejects a notify map that fans the interactive question category out to two destinations", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ question: "alerts", "question:urgent": "ops" }`),
  );

  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.match(err.message, /question/);
    assert.match(err.message, /alerts/);
    assert.match(err.message, /ops/);
    return true;
  });
});

test("loadConfig rejects question fan-out that comes via the wildcard catching unlisted question events", async () => {
  // `question:urgent` -> ops, but every other question event falls to `*` -> alerts.
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ "question:urgent": "ops", "*": "alerts" }`),
  );

  await assert.rejects(loadConfig(cfgPath), /question/);
});

test("loadConfig accepts a notify map where question resolves to one destination while broadcasts fan freely", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ "*": "ops", question: "alerts", "question:urgent": "alerts", failure: "pager", "progress:carve": "chatter" }`),
  );

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.notify?.question, "alerts");
});

test("loadConfig honors an explicit stateDir over the flipped default", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    CONFIG_BODY.replace("fetchTask:", 'stateDir: "custom-state",\n  fetchTask:'),
  );

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, "custom-state");
  assert.equal(cfg.parkedDir, "custom-state/parked");
  assert.equal(cfg.logFile, "custom-state/logs/orchestrator.jsonl");
});
