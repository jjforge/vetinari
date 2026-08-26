import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  build,
  buildImageArgs,
  markMergedIssues,
  requireTelegram,
  resolveTitles,
} from "./modes.ts";

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

test("markMergedIssues calls the configured onIssueMerged seam with exactly the merged ids", async () => {
  const seen: string[] = [];
  await markMergedIssues({ onIssueMerged: (id) => void seen.push(id) }, [
    "101",
    "102",
    "103",
  ]);
  assert.deepEqual(seen, ["101", "102", "103"]);
});

test("markMergedIssues is a no-op when onIssueMerged is unconfigured — core names no labels", async () => {
  // No throw, nothing to observe: the core stays tracker-agnostic.
  await markMergedIssues({}, ["101"]);
});

test("markMergedIssues isolates a throwing hook — it is logged and the rest still run, no throw", async () => {
  const seen: string[] = [];
  await markMergedIssues(
    {
      onIssueMerged: (id) => {
        seen.push(id);
        if (id === "102") throw new Error("offline");
      },
    },
    ["101", "102", "103"],
  );
  // 102 threw but 101 and 103 were still attempted, and the call itself did not throw.
  assert.deepEqual(seen, ["101", "102", "103"]);
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

const buildCfg = (): ResolvedConfig =>
  ({ image: "vetinari-myapp" }) as ResolvedConfig;

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
