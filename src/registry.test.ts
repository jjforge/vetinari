import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { autoRegister, gatewayConfigDir, listProjects, pointerFor, readProject, readProjects, register, writeRouting, type ProjectPointer } from "./registry.ts";

let counter = 0;
const tmpConfigDir = () => {
  const dir = join(tmpdir(), `sctdd-registry-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const pointer = (over: Partial<ProjectPointer> = {}): ProjectPointer => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.sandcastle.local",
  ...over,
});

test("register then listProjects round-trips the pointer", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer());

  assert.deepEqual(listProjects(configDir), [pointer()]);
});

// A base location on disk with a `orchestrator.env` carrying the project's
// Telegram secrets — the shape `readProject` reads live.
const baseLocationWith = (env: string): string => {
  const base = join(tmpConfigDir(), ".sandcastle.local");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "orchestrator.env"), env);
  return base;
};

test("readProject loads the project's Telegram connection live from its base location", () => {
  const baseLocation = baseLocationWith(
    "export SANDCASTLE_TELEGRAM_BOT_TOKEN=123:abc\n" +
      "SANDCASTLE_TELEGRAM_CHAT_ID=-1001\n" +
      'SANDCASTLE_TELEGRAM_THREAD_ID="42"\n',
  );
  const read = readProject(pointer({ baseLocation }));

  assert.deepEqual(read?.conn, { token: "123:abc", chat: "-1001", thread: "42" });
});

test("readProject loads the project's notify map and destinations live from its base location", () => {
  const base = join(tmpConfigDir(), ".sandcastle.local");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "orchestrator.env"), "SANDCASTLE_TELEGRAM_BOT_TOKEN=t\nSANDCASTLE_TELEGRAM_CHAT_ID=c\n");
  writeRouting(base, {
    notify: { "*": "ops", failure: "alerts" },
    destinations: { ops: { bot: "main", chat: "-100" }, alerts: { bot: "main", chat: "-200" } },
  });

  const read = readProject(pointer({ baseLocation: base }));

  assert.deepEqual(read?.notify, { "*": "ops", failure: "alerts" });
  assert.deepEqual(read?.destinations, { ops: { bot: "main", chat: "-100" }, alerts: { bot: "main", chat: "-200" } });
});

test("readProject leaves notify/destinations undefined when the project materialized no routing", () => {
  const baseLocation = baseLocationWith("SANDCASTLE_TELEGRAM_BOT_TOKEN=t\nSANDCASTLE_TELEGRAM_CHAT_ID=c\n");

  const read = readProject(pointer({ baseLocation }));

  assert.equal(read?.notify, undefined);
  assert.equal(read?.destinations, undefined);
});

test("readProject returns undefined for a pointer whose base location is gone", () => {
  const read = readProject(pointer({ baseLocation: join(tmpdir(), `sctdd-gone-${Date.now()}-${counter++}`) }));

  assert.equal(read, undefined);
});

test("readProjects skips a stale pointer and never throws on it", () => {
  const configDir = tmpConfigDir();
  const live = baseLocationWith("SANDCASTLE_TELEGRAM_BOT_TOKEN=t\nSANDCASTLE_TELEGRAM_CHAT_ID=c\n");
  register(configDir, pointer({ project: "live", baseLocation: live }));
  register(configDir, pointer({ project: "stale", baseLocation: join(tmpdir(), `sctdd-gone-${Date.now()}-${counter++}`) }));

  const read = readProjects(configDir);

  assert.deepEqual(
    read.map((r) => r.pointer.project),
    ["live"],
  );
});

test("pointerFor derives the base location as the state dir under the project root", () => {
  const cfg = { project: "jjforge", stateDir: ".sandcastle.local" } as ResolvedConfig;

  assert.deepEqual(pointerFor(cfg, "/home/me/code/jjforge"), {
    project: "jjforge",
    projectRoot: "/home/me/code/jjforge",
    baseLocation: "/home/me/code/jjforge/.sandcastle.local",
  });
});

const withEnv = (over: Record<string, string | undefined>, fn: () => void) => {
  const keys = Object.keys(over);
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) over[k] === undefined ? delete process.env[k] : (process.env[k] = over[k]);
  try {
    fn();
  } finally {
    for (const k of keys) prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k]);
  }
};

test("gatewayConfigDir honours SANDCASTLE_GATEWAY_HOME above all else", () => {
  withEnv({ SANDCASTLE_GATEWAY_HOME: "/opt/gw", XDG_CONFIG_HOME: "/home/me/.config" }, () => {
    assert.equal(gatewayConfigDir(), "/opt/gw");
  });
});

test("gatewayConfigDir falls back to XDG_CONFIG_HOME/sandcastle", () => {
  withEnv({ SANDCASTLE_GATEWAY_HOME: undefined, XDG_CONFIG_HOME: "/home/me/.config" }, () => {
    assert.equal(gatewayConfigDir(), join("/home/me/.config", "sandcastle"));
  });
});

test("autoRegister writes the current project's pointer and is idempotent on re-run", () => {
  const configDir = tmpConfigDir();
  const cfg = { project: "jjforge", stateDir: ".sandcastle.local" } as ResolvedConfig;
  withEnv({ SANDCASTLE_GATEWAY_HOME: configDir }, () => {
    autoRegister(cfg, "/home/me/code/jjforge");
    autoRegister(cfg, "/home/me/code/jjforge");
  });

  assert.deepEqual(listProjects(configDir), [
    { project: "jjforge", projectRoot: "/home/me/code/jjforge", baseLocation: "/home/me/code/jjforge/.sandcastle.local" },
  ]);
});

test("autoRegister materializes the project's routing so the gateway reads it live", () => {
  const configDir = tmpConfigDir();
  const projectRoot = join(tmpConfigDir(), "proj");
  const cfg = {
    project: "jjforge",
    stateDir: join(projectRoot, ".sandcastle.local"),
    notify: { "*": "ops" },
    destinations: { ops: { bot: "main", chat: "-100" } },
  } as unknown as ResolvedConfig;
  withEnv({ SANDCASTLE_GATEWAY_HOME: configDir }, () => autoRegister(cfg, projectRoot));

  const [read] = readProjects(configDir);
  assert.deepEqual(read.notify, { "*": "ops" });
  assert.deepEqual(read.destinations, { ops: { bot: "main", chat: "-100" } });
});

test("re-registering a project refreshes its pointer in place", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ baseLocation: "/old/.sandcastle.local" }));
  register(configDir, pointer({ baseLocation: "/new/.sandcastle.local" }));

  // One project, not two — the same name upserts rather than duplicating.
  assert.deepEqual(listProjects(configDir), [pointer({ baseLocation: "/new/.sandcastle.local" })]);
});
