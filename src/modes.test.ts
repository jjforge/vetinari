import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConfig } from "./config.ts";
import { build, buildImageArgs, resolveTitles } from "./modes.ts";

const cfgWith = (fetchTask: ResolvedConfig["fetchTask"]): ResolvedConfig => ({ fetchTask }) as ResolvedConfig;

test("resolveTitles maps each id to its fetched title", async () => {
  const titles: Record<string, string> = { "101": "Add login flow", "102": "Rotate logs" };
  const map = await resolveTitles(cfgWith(async (id) => JSON.stringify({ title: titles[id] })), ["101", "102"]);
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
  const map = await resolveTitles(cfgWith(async (id) => (id === "101" ? JSON.stringify({ title: "Real title" }) : "just a body")), ["101", "102"]);
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
  assert.deepEqual(args, ["docker", "build-image", "--dockerfile", "vetinari/Dockerfile", "--image-name", "vetinari-myapp"]);
});

const buildCfg = (): ResolvedConfig => ({ image: "vetinari-myapp" }) as ResolvedConfig;

test("build builds the image, then runs baseline by default, returning its result", async () => {
  const calls: string[] = [];
  const ok = await build(buildCfg(), { baseline: true }, {
    buildImage: async (image, dockerfile) => {
      calls.push(`build ${image} ${dockerfile}`);
      return 0;
    },
    baseline: async () => {
      calls.push("baseline");
      return true;
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["build vetinari-myapp vetinari/Dockerfile", "baseline"]);
});

test("build with --no-baseline builds only, skipping the probe", async () => {
  let baselineRan = false;
  const ok = await build(buildCfg(), { baseline: false }, {
    buildImage: async () => 0,
    baseline: async () => {
      baselineRan = true;
      return true;
    },
  });
  assert.equal(ok, true);
  assert.equal(baselineRan, false);
});

test("build fails and skips baseline when the image build exits non-zero", async () => {
  let baselineRan = false;
  const ok = await build(buildCfg(), { baseline: true }, {
    buildImage: async () => 1,
    baseline: async () => {
      baselineRan = true;
      return true;
    },
  });
  assert.equal(ok, false);
  assert.equal(baselineRan, false);
});

test("build fails when the image builds but baseline is red", async () => {
  const ok = await build(buildCfg(), { baseline: true }, {
    buildImage: async () => 0,
    baseline: async () => false,
  });
  assert.equal(ok, false);
});
