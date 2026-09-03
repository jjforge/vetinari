import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  autoRegister,
  computeRegistryDedup,
  gatewayConfigDir,
  hostSecretsPath,
  listProjects,
  normalizeProjectRoot,
  pointerFor,
  readPointer,
  readProject,
  readProjects,
  register,
  removePointer,
  tgConnForBaseLocation,
  writeRouting,
  type ProjectPointer,
} from "./registry.ts";
import { memoryLogger } from "./log.ts";

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

test("listProjects skips a pointer that will not parse and returns every other one", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ project: "good" }));
  // The exact reported corruption: a zero-byte pointer file left by a torn write.
  writeFileSync(join(configDir, "registry", "broken.json"), "");

  assert.deepEqual(
    listProjects(configDir).map((p) => p.project),
    ["good"],
  );
});

test("listProjects logs an unparseable pointer as registry-pointer-unreadable, naming the file", () => {
  const configDir = tmpConfigDir();
  const logger = memoryLogger();
  register(configDir, pointer({ project: "good" }));
  writeFileSync(join(configDir, "registry", "broken.json"), "{ not json");

  listProjects(configDir, logger);

  assert.deepEqual(
    logger.events.map((e) => [e.event, (e as { file?: string }).file]),
    [
      [
        "registry-pointer-unreadable",
        join(configDir, "registry", "broken.json"),
      ],
    ],
  );
});

test("register replaces a pointer without leaving a temp file the listing would pick up", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ baseLocation: "/old/.vetinari.local" }));
  register(configDir, pointer({ baseLocation: "/new/.vetinari.local" }));

  // The atomic write renames its same-directory temp into place — no residue is
  // left behind, and none of what remains is a stray *.json the listing reads.
  const files = readdirSync(join(configDir, "registry"));
  assert.deepEqual(files, ["jjforge.json"]);
  assert.deepEqual(listProjects(configDir), [
    pointer({ baseLocation: "/new/.vetinari.local" }),
  ]);
});

test("removePointer drops the named pointer and leaves live ones — a stale entry stops rendering", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ project: "live" }));
  register(configDir, pointer({ project: "stale" }));

  const removed = removePointer(configDir, "stale");

  assert.equal(removed, true);
  assert.deepEqual(
    listProjects(configDir).map((p) => p.project),
    ["live"],
  );
});

test("removePointer is a no-op returning false for a name that was never registered", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ project: "live" }));

  const removed = removePointer(configDir, "ghost");

  assert.equal(removed, false);
  assert.deepEqual(
    listProjects(configDir).map((p) => p.project),
    ["live"],
  );
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
      ops: { chat: "-100" },
      alerts: { chat: "-200" },
    },
  });

  const read = readProject(pointer({ baseLocation: base }));

  assert.deepEqual(read?.notify, { "*": "ops", failure: "alerts" });
  assert.deepEqual(read?.destinations, {
    ops: { chat: "-100" },
    alerts: { chat: "-200" },
  });
});

test("writeRouting refreshes routing.json without leaving a temp file behind", () => {
  const base = join(tmpConfigDir(), ".vetinari.local");
  writeRouting(base, { notify: { "*": "ops" } });
  writeRouting(base, { notify: { "*": "alerts" } });

  // The atomic write leaves only the final routing.json — no half-written residue.
  assert.deepEqual(readdirSync(base), ["routing.json"]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(base, "routing.json"), "utf8")),
    { notify: { "*": "alerts" } },
  );
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

test("readProjects survives an unparseable pointer mid-registry, serving the rest — the reconcile-tick path", () => {
  const configDir = tmpConfigDir();
  const logger = memoryLogger();
  const live = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=t\nVETINARI_TELEGRAM_CHAT_ID=c\n",
  );
  register(configDir, pointer({ project: "live", baseLocation: live }));
  // A zero-byte pointer appears mid-run, exactly as a torn write leaves it.
  writeFileSync(join(configDir, "registry", "torn.json"), "");

  const read = readProjects(configDir, logger);

  assert.deepEqual(
    read.map((r) => r.pointer.project),
    ["live"],
  );
  assert.deepEqual(
    logger.events.map((e) => e.event),
    ["registry-pointer-unreadable"],
  );
});

test("readProjects routes a stale pointer's skip to the injected logger, not the process-global", () => {
  const configDir = tmpConfigDir();
  const logger = memoryLogger();
  const staleBase = join(tmpdir(), `vetinari-gone-${Date.now()}-${counter++}`);
  register(configDir, pointer({ project: "stale", baseLocation: staleBase }));

  readProjects(configDir, logger);

  assert.deepEqual(
    logger.events.map((e) => [e.event, (e as { project?: string }).project]),
    [["registry-stale", "stale"]],
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

// A pointer sharing a projectRoot with another but based somewhere else (a temp
// dir, a moved checkout) — the non-canonical duplicate `tidy` may drop.
const dupPointer = (over: Partial<ProjectPointer> = {}): ProjectPointer => ({
  project: "verify150",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/tmp/verify150/.vetinari.local",
  ...over,
});

test("computeRegistryDedup drops the non-canonical duplicate, keeps the canonical base", () => {
  // Two pointers resolve to one repo; only `jjforge` is based at <root>/.vetinari.local.
  const drops = computeRegistryDedup([pointer(), dupPointer()]);

  assert.deepEqual(drops, [
    {
      drop: "verify150",
      kept: "jjforge",
      projectRoot: "/home/me/code/jjforge",
    },
  ]);
});

test("computeRegistryDedup removes nothing when no member has the canonical base", () => {
  // Both bases sit off-root — the winner is ambiguous, so leave the group for the human.
  const drops = computeRegistryDedup([
    dupPointer({ project: "a", baseLocation: "/tmp/a/.vetinari.local" }),
    dupPointer({ project: "b", baseLocation: "/tmp/b/.vetinari.local" }),
  ]);

  assert.deepEqual(drops, []);
});

test("computeRegistryDedup removes nothing when two members share the canonical base", () => {
  // Two canonical winners is ambiguous (can't happen on disk, but never guess) — leave both.
  const drops = computeRegistryDedup([
    pointer({ project: "a" }),
    pointer({ project: "b" }),
  ]);

  assert.deepEqual(drops, []);
});

test("computeRegistryDedup leaves singletons and distinct-root pointers untouched", () => {
  // A lone pointer whose root is gone from disk, and a lone temp-based pointer at a
  // different root — neither is a duplicate, so neither is ever dropped.
  const drops = computeRegistryDedup([
    pointer(),
    dupPointer({
      project: "other",
      projectRoot: "/home/me/code/elsewhere",
      baseLocation: "/tmp/x/.vetinari.local",
    }),
  ]);

  assert.deepEqual(drops, []);
});

test("computeRegistryDedup groups by NORMALIZED root — a trailing slash is one group", () => {
  const drops = computeRegistryDedup([
    pointer(),
    dupPointer({ projectRoot: "/home/me/code/jjforge/" }),
  ]);

  assert.deepEqual(drops, [
    {
      drop: "verify150",
      kept: "jjforge",
      projectRoot: "/home/me/code/jjforge",
    },
  ]);
});

test("normalizeProjectRoot strips a trailing slash", () => {
  assert.equal(
    normalizeProjectRoot("/home/me/code/jjforge/"),
    "/home/me/code/jjforge",
  );
});

test("normalizeProjectRoot realpath-resolves a symlinked root so path variants dedup", () => {
  const real = join(tmpConfigDir(), "real-checkout");
  mkdirSync(real, { recursive: true });
  const link = join(tmpConfigDir(), "link-checkout");
  symlinkSync(real, link);

  assert.equal(normalizeProjectRoot(link), realpathSync(real));
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
    destinations: { ops: { chat: "-100" } },
  } as unknown as ResolvedConfig;
  withEnv({ VETINARI_GATEWAY_HOME: configDir }, () =>
    autoRegister(cfg, projectRoot),
  );

  const [read] = readProjects(configDir);
  assert.deepEqual(read.notify, { "*": "ops" });
  assert.deepEqual(read.destinations, { ops: { chat: "-100" } });
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

test("readPointer reads one pointer by name, and is undefined when unregistered", () => {
  const configDir = tmpConfigDir();
  register(configDir, pointer({ project: "here" }));
  assert.deepEqual(
    readPointer(configDir, "here"),
    pointer({ project: "here" }),
  );
  assert.equal(readPointer(configDir, "absent"), undefined);
});

test("pointerFor carries the derived repo when given one, and omits the key when not", () => {
  const cfg = {
    project: "jjforge",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;
  assert.deepEqual(pointerFor(cfg, "/root", "jjforge/vetinari"), {
    project: "jjforge",
    projectRoot: "/root",
    baseLocation: "/root/.vetinari.local",
    repo: "jjforge/vetinari",
  });
  // A degraded derivation leaves the key off entirely — no explicit `undefined`.
  assert.deepEqual(Object.keys(pointerFor(cfg, "/root")), [
    "project",
    "projectRoot",
    "baseLocation",
  ]);
});

test("autoRegister fills the pointer's repo from the root's git origin", () => {
  const configDir = tmpConfigDir();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vetinari-reporoot-")));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "git@github.com:jjforge/vetinari.git",
  ]);
  const cfg = {
    project: "jjforge",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;

  withEnv({ VETINARI_GATEWAY_HOME: configDir }, () => autoRegister(cfg, root));

  assert.equal(readPointer(configDir, "jjforge")?.repo, "jjforge/vetinari");
});

test("autoRegister refuses to overwrite an incumbent pointer at a different root", () => {
  const configDir = tmpConfigDir();
  const cfg = {
    project: "shared",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;
  const errors: string[] = [];
  const realErr = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    withEnv({ VETINARI_GATEWAY_HOME: configDir }, () => {
      autoRegister(cfg, "/home/me/alpha");
      // A second project declaring the same name from a different root must not steal it.
      autoRegister(cfg, "/home/me/beta");
    });
  } finally {
    console.error = realErr;
  }

  // The incumbent is kept intact — the collision never overwrote it.
  assert.equal(readPointer(configDir, "shared")?.projectRoot, "/home/me/alpha");
  // One line on stderr names both roots and the shared name.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /shared/);
  assert.match(errors[0], /\/home\/me\/alpha/);
  assert.match(errors[0], /\/home\/me\/beta/);
});

test("autoRegister still refreshes a pointer at the same root (not a collision)", () => {
  const configDir = tmpConfigDir();
  const cfg = {
    project: "shared",
    stateDir: ".vetinari.local",
  } as ResolvedConfig;
  withEnv({ VETINARI_GATEWAY_HOME: configDir }, () => {
    autoRegister(cfg, "/home/me/alpha");
    autoRegister(cfg, "/home/me/alpha");
  });
  assert.equal(readPointer(configDir, "shared")?.projectRoot, "/home/me/alpha");
});
