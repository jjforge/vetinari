import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  autoRegister,
  gatewayConfigDir,
  hostSecretsPath,
  listProjects,
  pointerFor,
  readProject,
  readProjects,
  register,
  tgConnForBaseLocation,
  writeRouting,
  type ProjectPointer,
} from "./registry.ts";

let counter = 0;
const tmpConfigDir = () => {
  const dir = join(tmpdir(), `vetinari-registry-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const pointer = (over: Partial<ProjectPointer> = {}): ProjectPointer => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.vetinari.local",
  ...over,
});

test("register then listProjects round-trips the pointer", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer());

  assert.deepEqual(listProjects(configDir), [pointer()]);
});

// A base location on disk with a `host.env` carrying the project's
// Telegram secrets — the shape `readProject` reads live.
const baseLocationWith = (env: string): string => {
  const base = join(tmpConfigDir(), ".vetinari.local");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "host.env"), env);
  return base;
};

test("readProject loads the project's Telegram connection live from its base location", () => {
  const baseLocation = baseLocationWith(
    "export VETINARI_TELEGRAM_BOT_TOKEN=123:abc\n" +
      "VETINARI_TELEGRAM_CHAT_ID=-1001\n" +
      'VETINARI_TELEGRAM_THREAD_ID="42"\n',
  );
  const read = readProject(pointer({ baseLocation }));

  assert.deepEqual(read?.conn, {
    token: "123:abc",
    chat: "-1001",
    thread: "42",
  });
});

test("readProject strips inline comments from host.env values (shell semantics)", () => {
  // A human-authored host.env annotates its secrets with trailing comments;
  // shell `source` honours them, so the parser must too or the token carries the
  // comment and Telegram rejects it. A quoted value keeps a literal '#'.
  const baseLocation = baseLocationWith(
    "export VETINARI_TELEGRAM_BOT_TOKEN=123:abc  # from @BotFather /newbot\n" +
      "VETINARI_TELEGRAM_CHAT_ID=-1001   # your numeric chat id (getUpdates)\n" +
      'VETINARI_TELEGRAM_THREAD_ID="42 # not a comment"\n',
  );
  const read = readProject(pointer({ baseLocation }));

  assert.deepEqual(read?.conn, {
    token: "123:abc",
    chat: "-1001",
    thread: "42 # not a comment",
  });
});

test("readProject loads the project's notify map and destinations live from its base location", () => {
  const base = join(tmpConfigDir(), ".vetinari.local");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "host.env"),
    "VETINARI_TELEGRAM_BOT_TOKEN=t\nVETINARI_TELEGRAM_CHAT_ID=c\n",
  );
  writeRouting(base, {
    notify: { "*": "ops", failure: "alerts" },
    destinations: {
      ops: { bot: "main", chat: "-100" },
      alerts: { bot: "main", chat: "-200" },
    },
  });

  const read = readProject(pointer({ baseLocation: base }));

  assert.deepEqual(read?.notify, { "*": "ops", failure: "alerts" });
  assert.deepEqual(read?.destinations, {
    ops: { bot: "main", chat: "-100" },
    alerts: { bot: "main", chat: "-200" },
  });
});

test("readProject leaves notify/destinations undefined when the project materialized no routing", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=t\nVETINARI_TELEGRAM_CHAT_ID=c\n",
  );

  const read = readProject(pointer({ baseLocation }));

  assert.equal(read?.notify, undefined);
  assert.equal(read?.destinations, undefined);
});

test("tgConnForBaseLocation reads the Telegram connection from the base location's host.env", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\nVETINARI_TELEGRAM_CHAT_ID=-1001\n",
  );

  assert.deepEqual(tgConnForBaseLocation(baseLocation), {
    token: "123:abc",
    chat: "-1001",
    thread: undefined,
  });
});

test("tgConnForBaseLocation is undefined when host.env is absent", () => {
  const baseLocation = join(tmpConfigDir(), ".vetinari.local");
  mkdirSync(baseLocation, { recursive: true });

  assert.equal(tgConnForBaseLocation(baseLocation), undefined);
});

test("tgConnForBaseLocation is undefined when host.env lacks the required keys", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\n",
  );

  assert.equal(tgConnForBaseLocation(baseLocation), undefined);
});

test("tgConnForBaseLocation reads only host.env, never process.env", () => {
  const baseLocation = join(tmpConfigDir(), ".vetinari.local");
  mkdirSync(baseLocation, { recursive: true });
  withEnv(
    {
      VETINARI_TELEGRAM_BOT_TOKEN: "exported",
      VETINARI_TELEGRAM_CHAT_ID: "exported",
    },
    () => {
      // Creds exported into the process env but no host.env — the gateway would not
      // see them, so neither may this reader.
      assert.equal(tgConnForBaseLocation(baseLocation), undefined);
    },
  );
});

test("hostSecretsPath names host.env under the base location", () => {
  assert.equal(
    hostSecretsPath("/home/me/code/jjforge/.vetinari.local"),
    "/home/me/code/jjforge/.vetinari.local/host.env",
  );
});

test("readProject returns undefined for a pointer whose base location is gone", () => {
  const read = readProject(
    pointer({
      baseLocation: join(tmpdir(), `vetinari-gone-${Date.now()}-${counter++}`),
    }),
  );

  assert.equal(read, undefined);
});

test("readProjects skips a stale pointer and never throws on it", () => {
  const configDir = tmpConfigDir();
  const live = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=t\nVETINARI_TELEGRAM_CHAT_ID=c\n",
  );
  register(configDir, pointer({ project: "live", baseLocation: live }));
  register(
    configDir,
    pointer({
      project: "stale",
      baseLocation: join(tmpdir(), `vetinari-gone-${Date.now()}-${counter++}`),
    }),
  );

  const read = readProjects(configDir);

  assert.deepEqual(
    read.map((r) => r.pointer.project),
    ["live"],
  );
});

test("pointerFor derives the base location as the state dir under the project root", () => {
  const cfg = {
    project: "jjforge",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;

  assert.deepEqual(pointerFor(cfg, "/home/me/code/jjforge"), {
    project: "jjforge",
    projectRoot: "/home/me/code/jjforge",
    baseLocation: "/home/me/code/jjforge/.vetinari.local",
  });
});

const withEnv = (over: Record<string, string | undefined>, fn: () => void) => {
  const keys = Object.keys(over);
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys)
    over[k] === undefined ? delete process.env[k] : (process.env[k] = over[k]);
  try {
    fn();
  } finally {
    for (const k of keys)
      prev[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = prev[k]);
  }
};

test("gatewayConfigDir honours VETINARI_GATEWAY_HOME above all else", () => {
  withEnv(
    { VETINARI_GATEWAY_HOME: "/opt/gw", XDG_CONFIG_HOME: "/home/me/.config" },
    () => {
      assert.equal(gatewayConfigDir(), "/opt/gw");
    },
  );
});

test("gatewayConfigDir falls back to XDG_CONFIG_HOME/vetinari", () => {
  withEnv(
    { VETINARI_GATEWAY_HOME: undefined, XDG_CONFIG_HOME: "/home/me/.config" },
    () => {
      assert.equal(gatewayConfigDir(), join("/home/me/.config", "vetinari"));
    },
  );
});

test("autoRegister writes the current project's pointer and is idempotent on re-run", () => {
  const configDir = tmpConfigDir();
  const cfg = {
    project: "jjforge",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;
  withEnv({ VETINARI_GATEWAY_HOME: configDir }, () => {
    autoRegister(cfg, "/home/me/code/jjforge");
    autoRegister(cfg, "/home/me/code/jjforge");
  });

  assert.deepEqual(listProjects(configDir), [
    {
      project: "jjforge",
      projectRoot: "/home/me/code/jjforge",
      baseLocation: "/home/me/code/jjforge/.vetinari.local",
    },
  ]);
});

test("autoRegister materializes the project's routing so the gateway reads it live", () => {
  const configDir = tmpConfigDir();
  const projectRoot = join(tmpConfigDir(), "proj");
  const cfg = {
    project: "jjforge",
    stateDir: join(projectRoot, ".vetinari.local"),
    notify: { "*": "ops" },
    destinations: { ops: { bot: "main", chat: "-100" } },
  } as unknown as ResolvedConfig;
  withEnv({ VETINARI_GATEWAY_HOME: configDir }, () =>
    autoRegister(cfg, projectRoot),
  );

  const [read] = readProjects(configDir);
  assert.deepEqual(read.notify, { "*": "ops" });
  assert.deepEqual(read.destinations, { ops: { bot: "main", chat: "-100" } });
});

test("re-registering a project refreshes its pointer in place", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ baseLocation: "/old/.vetinari.local" }));
  register(configDir, pointer({ baseLocation: "/new/.vetinari.local" }));

  // One project, not two — the same name upserts rather than duplicating.
  assert.deepEqual(listProjects(configDir), [
    pointer({ baseLocation: "/new/.vetinari.local" }),
  ]);
});
