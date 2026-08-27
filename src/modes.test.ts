import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  autoCarveNotice,
  build,
  buildImageArgs,
  childSpawnEnv,
  markMergedIssues,
  quarantinePauseNotice,
  requireTelegram,
  resolveTitles,
  warnIfTelegramUnconfigured,
  waveParkedNotice,
} from "./modes.ts";
import { memoryLogger, type MemoryLogger } from "./log.ts";

const cfgWith = (fetchTask: ResolvedConfig["fetchTask"]): ResolvedConfig =>
  ({ fetchTask }) as ResolvedConfig;

let counter = 0;
const baseLocationWith = (env?: string): string => {
  const base = join(
    tmpdir(),
    `vetinari-modes-${Date.now()}-${counter++}`,
    ".vetinari.local",
  );
  mkdirSync(base, { recursive: true });
  if (env !== undefined) writeFileSync(join(base, "host.env"), env);
  return base;
};

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

test("requireTelegram resolves the connection from the base location's host.env — the path the gateway sends on", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\nVETINARI_TELEGRAM_CHAT_ID=-1001\n",
  );

  assert.deepEqual(requireTelegram("tg-test", baseLocation), {
    token: "123:abc",
    chat: "-1001",
    thread: undefined,
  });
});

test("requireTelegram fails naming host.env and the base location when creds are only exported", () => {
  const baseLocation = baseLocationWith(); // no host.env on disk
  withEnv(
    {
      VETINARI_TELEGRAM_BOT_TOKEN: "exported",
      VETINARI_TELEGRAM_CHAT_ID: "exported",
    },
    () => {
      // Exporting the vars is the wrong path — the gateway never reads process.env,
      // so tg-test must still report them missing and point at the file to fix.
      assert.throws(
        () => requireTelegram("tg-test", baseLocation),
        (e: Error) =>
          e.message ===
          `tg-test needs VETINARI_TELEGRAM_BOT_TOKEN and VETINARI_TELEGRAM_CHAT_ID in ${join(baseLocation, "host.env")}`,
      );
    },
  );
});

// Capture what a body writes to stderr, restoring the real console.error after.
const captureStderr = (fn: () => void): string => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = real;
  }
  return lines.join("\n");
};

// A cfg whose base location IS this stateDir (absolute, so it resolves to itself),
// carrying a silent in-memory logger so the emitted event can be read back off
// `cfg.log.events` — no on-disk log target needed.
const unnotifiableCfg = (baseLocation: string): ResolvedConfig =>
  ({ project: "myapp", stateDir: baseLocation, log: memoryLogger() }) as unknown as ResolvedConfig;

/** The `.events` a cfg's injected memory logger captured. */
const eventsOf = (cfg: ResolvedConfig) => (cfg.log as MemoryLogger).events;

test("warnIfTelegramUnconfigured warns naming host.env and logs telegram-unconfigured when the base location resolves no conn", () => {
  const baseLocation = baseLocationWith(); // no host.env → no conn
  const cfg = unnotifiableCfg(baseLocation);

  const stderr = captureStderr(() => warnIfTelegramUnconfigured(cfg));

  // The operator is told, on stderr, that parks won't ping and which file to fix.
  assert.match(stderr, /Telegram/);
  assert.match(
    stderr,
    new RegExp(join(baseLocation, "host.env").replace(/[.\\/]/g, "\\$&")),
  );

  // …and the same fact is logged so the dashboard can narrate it.
  const logged = eventsOf(cfg).filter(
    (e) => e.event === "telegram-unconfigured",
  );
  assert.equal(logged.length, 1);
  assert.deepEqual(
    {
      project: (logged[0] as any).project,
      baseLocation: (logged[0] as any).baseLocation,
    },
    { project: "myapp", baseLocation },
  );
});

test("warnIfTelegramUnconfigured is silent when the base location's host.env resolves a conn", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\nVETINARI_TELEGRAM_CHAT_ID=-1001\n",
  );
  const cfg = unnotifiableCfg(baseLocation);

  const stderr = captureStderr(() => warnIfTelegramUnconfigured(cfg));

  assert.equal(stderr, "");
  assert.equal(
    eventsOf(cfg).filter((e) => e.event === "telegram-unconfigured").length,
    0,
  );
});

test("markMergedIssues calls the configured onIssueMerged seam with exactly the merged ids", async () => {
  const seen: string[] = [];
  await markMergedIssues({ onIssueMerged: (id) => void seen.push(id), log: memoryLogger() }, [
    "101",
    "102",
    "103",
  ]);
  assert.deepEqual(seen, ["101", "102", "103"]);
});

test("waveParkedNotice draws attention to a paused campaign whose greens stay merged, carrying the gate detail", () => {
  const notice = waveParkedNotice("acme", 2, ["101", "102"], "main", "gate line\nGATE FAILED");
  // Routed to the alerting channel — a wave-park demands a human, like the old halt did.
  assert.equal(notice.category, "failure");
  assert.equal(notice.event, "wave-parked");
  // The operator is told which greens stay merged, on which base, and that it paused.
  assert.ok(notice.text.includes("101, 102"));
  assert.ok(notice.text.includes("main"));
  assert.ok(/pause/i.test(notice.text));
  // No machine-named culprit: the notice says the failure is unattributable.
  assert.ok(/no attributable culprit/i.test(notice.text));
  // The gate report tail rides along so the human sees why it went red.
  assert.ok(notice.text.includes("GATE FAILED"));
});

test("quarantinePauseNotice draws a human to a campaign paused by a quarantine that orphaned later-wave dependents", () => {
  const notice = quarantinePauseNotice(
    "acme",
    1,
    [{ target: "640", removed: ["640", "701"], dropped: ["701"] }],
    "main",
  );
  // Routed to the alerting channel — a paused campaign demands a human, like a wave-park.
  assert.equal(notice.category, "failure");
  assert.equal(notice.event, "quarantine-paused");
  // Names the quarantined issue and the dependents it stranded.
  assert.ok(notice.text.includes("640"));
  assert.ok(notice.text.includes("701"));
  assert.ok(/pause/i.test(notice.text));
  // Points at both recovery paths: resolve/resume, or re-run with --auto-carve.
  assert.ok(/--auto-carve/.test(notice.text));
});

test("autoCarveNotice reports the pruned dependents and that the campaign ran on", () => {
  const notice = autoCarveNotice("acme", 1, [
    { target: "640", removed: ["640", "701"], dropped: ["701"] },
  ]);
  // Informational — the campaign continued, so it rides the progress channel.
  assert.equal(notice.category, "progress");
  assert.equal(notice.event, "auto-carve");
  assert.ok(notice.text.includes("640"));
  assert.ok(notice.text.includes("701"));
  assert.ok(/carve/i.test(notice.text));
});

test("markMergedIssues is a no-op when onIssueMerged is unconfigured — core names no labels", async () => {
  // No throw, nothing to observe: the core stays tracker-agnostic.
  await markMergedIssues({ log: memoryLogger() }, ["101"]);
});

test("markMergedIssues isolates a throwing hook — it is logged and the rest still run, no throw", async () => {
  const seen: string[] = [];
  const log = memoryLogger();
  await markMergedIssues(
    {
      onIssueMerged: (id) => {
        seen.push(id);
        if (id === "102") throw new Error("offline");
      },
      log,
    },
    ["101", "102", "103"],
  );
  // 102 threw but 101 and 103 were still attempted, and the call itself did not throw.
  assert.deepEqual(seen, ["101", "102", "103"]);
  // The failure surfaced on the injected event log, naming the offending id.
  const failed = log.events.filter((e) => (e as { event: string }).event === "issue-merged-hook-failed");
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as any).taskId, "102");
});

test("resolveTitles maps each id to its fetched title", async () => {
  const titles: Record<string, string> = {
    "101": "Add login flow",
    "102": "Rotate logs",
  };
  const map = await resolveTitles(
    cfgWith(async (id) => JSON.stringify({ title: titles[id] })),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "Add login flow", "102": "Rotate logs" });
});

test("resolveTitles normalizes #-prefixed ids and dedupes", async () => {
  const seen: string[] = [];
  const map = await resolveTitles(
    cfgWith(async (id) => {
      seen.push(id);
      return JSON.stringify({ title: `title ${id}` });
    }),
    ["#101", "101", "202"],
  );
  assert.deepEqual(map, { "101": "title 101", "202": "title 202" });
  // Each distinct issue is fetched once, by its normalized id.
  assert.deepEqual(seen.sort(), ["101", "202"]);
});

test("resolveTitles omits an id whose task carries no structured title", async () => {
  const map = await resolveTitles(
    cfgWith(async (id) =>
      id === "101" ? JSON.stringify({ title: "Real title" }) : "just a body",
    ),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "Real title" });
});

test("resolveTitles degrades gracefully when a fetch throws — the id is simply absent, no throw", async () => {
  const map = await resolveTitles(
    cfgWith(async (id) => {
      if (id === "102") throw new Error("network down");
      return JSON.stringify({ title: "ok" });
    }),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "ok" });
});

test("buildImageArgs shells sandcastle build-image with the image and dockerfile, each named once", () => {
  const args = buildImageArgs("vetinari-myapp", "vetinari/Dockerfile");
  assert.deepEqual(args, [
    "docker",
    "build-image",
    "--dockerfile",
    "vetinari/Dockerfile",
    "--image-name",
    "vetinari-myapp",
  ]);
});

test("childSpawnEnv marks a spawned child so its `run` skips leftover-archiving, keeping the parent env (#150)", () => {
  const child = childSpawnEnv({ PATH: "/usr/bin", HOME: "/home/x" });
  // The marker a child `run` reads to know it must not archive the campaign log.
  assert.equal(child.VETINARI_CHILD, "1");
  // The rest of the environment crosses through unchanged.
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/home/x");
});

const buildCfg = (): ResolvedConfig =>
  ({ image: "vetinari-myapp", log: memoryLogger() }) as unknown as ResolvedConfig;

test("build builds the image, then runs baseline by default, returning its result", async () => {
  const calls: string[] = [];
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async (image, dockerfile) => {
        calls.push(`build ${image} ${dockerfile}`);
        return 0;
      },
      baseline: async () => {
        calls.push("baseline");
        return true;
      },
    },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    "build vetinari-myapp vetinari/Dockerfile",
    "baseline",
  ]);
});

test("build with --no-baseline builds only, skipping the probe", async () => {
  let baselineRan = false;
  const ok = await build(
    buildCfg(),
    { baseline: false },
    {
      buildImage: async () => 0,
      baseline: async () => {
        baselineRan = true;
        return true;
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(baselineRan, false);
});

test("build fails and skips baseline when the image build exits non-zero", async () => {
  let baselineRan = false;
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async () => 1,
      baseline: async () => {
        baselineRan = true;
        return true;
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(baselineRan, false);
});

test("build fails when the image builds but baseline is red", async () => {
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async () => 0,
      baseline: async () => false,
    },
  );
  assert.equal(ok, false);
});
