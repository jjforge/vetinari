import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The retired conflict-hold vocabulary (`quarantined`, `waveParked`) is gone from the
 * code (design §13.1, §13.2): the parked-conflict set is `conflictParked`, a red merged
 * base wave-parks the campaign, and `tidy`'s keep-reasons read `parked(conflict)` /
 * `campaign-parked`. The single exception is the alias table in `event-log.ts`, which
 * translates archived logs written in the old event names — "the one and only place the
 * retired names appear" (§13.2). Test files may name the archived events as fixtures, so
 * this scans only the non-test sources.
 */
test("no retired quarantine/waveParked identifier survives in the sources (design §13.1)", () => {
  const allow = new Set(["event-log.ts"]);
  const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !allow.has(f));
  for (const file of sources) {
    const text = readFileSync(join(SRC, file), "utf8");
    assert.ok(!/quarantin/i.test(text), `${file} still mentions the retired 'quarantine' vocabulary`);
    assert.ok(!/waveParked/.test(text), `${file} still carries a 'waveParked' identifier`);
  }
});

/** The non-test `.ts` and `.mts` sources — `cli.mts` is a source too, so the scans below read it. */
function nonTestSources(): string[] {
  return readdirSync(SRC).filter((f) => /\.m?ts$/.test(f) && !/\.test\.m?ts$/.test(f));
}

/**
 * CONTEXT.md's **lease** honours **max concurrent containers** — there is no "host budget".
 * The `{ configDir, ceiling, weight }` record is a `HostCeiling`.
 */
test("no 'HostBudget' identifier survives in the sources", () => {
  for (const file of nonTestSources()) {
    const text = readFileSync(join(SRC, file), "utf8");
    assert.ok(!/HostBudget/.test(text), `${file} still carries a 'HostBudget' identifier — it is a 'HostCeiling'`);
  }
});

/** The lease module is `lease.ts`; the old `host-slots.ts` name spoke of a "host slot budget". */
test("the lease module is lease.ts, not host-slots.ts", () => {
  const files = readdirSync(SRC);
  assert.ok(!files.includes("host-slots.ts"), "src/host-slots.ts still exists — it is src/lease.ts");
  assert.ok(files.includes("lease.ts"), "src/lease.ts is missing");
});

/**
 * CONTEXT.md's **Wave** entry avoids "batch": a wave is a wave. The exemptions are per
 * pattern — `campaign-batch` (the legacy `campaign-batch`/`campaign-batch-done` events) and a
 * graft's `whole-batch` rejection — plus files where every mention means something other
 * than a wave.
 */
test("no 'batch' meaning a wave survives in the sources", () => {
  const nonWaveOnly = new Map([
    ["event-log.ts", "the legacy reader of archived campaign-batch events and their `batches` field"],
    ["notice.ts", "a list of retired words"],
    ["cli.mts", "a batch of JSONL lines"],
    ["dashboard-live-tail.ts", "a batch of appended log lines"],
    ["gateway.ts", "a poll's batch of updates"],
    ["telegram.ts", "a poll's batch of updates"],
    ["dashboard-graft.ts", "a graft's set of issues"],
    ["dashboard-route-graft.ts", "a graft's set of issues"],
    ["dashboard-assets.ts", "a graft's set of issues"],
    ["dashboard-http.ts", "a graft's set of issues"],
    ["dashboard-render-issue.ts", "a graft's set of issues"],
    ["dashboard-render-project.ts", "a graft's set of issues"],
    ["graft.ts", "a graft's set of issues"],
    ["dashboard-demo-fixture.ts", "the demo fixture's prose"],
  ]);
  for (const file of nonTestSources().filter((f) => !nonWaveOnly.has(f))) {
    const text = readFileSync(join(SRC, file), "utf8").replace(/campaign-batch|whole-batch/g, "");
    const hit = /\bbatch(es)?\b|batch(es)?[A-Z_]|[a-z_]Batch(es)?/.exec(text);
    assert.ok(!hit, `${file} still says '${hit?.[0]}' — where it means a wave, say 'wave'`);
  }
});
