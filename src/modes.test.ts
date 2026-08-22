import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConfig } from "./config.ts";
import { resolveTitles } from "./modes.ts";

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
