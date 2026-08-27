import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { listOutbox } from "./state.ts";
import { runGraft } from "./graft.ts";

// A temp-dir `cfg` mirroring modes.test's `harnessCfg`: a real on-disk event log
// under a throwaway state dir is what the command's `readEventLog`/`reduceCampaign`
// re-derive reads and what `enqueueOutbound`/`cfg.log` write — so the seam is
// exercised for real; only the tracker edges (`fetchTask`/`blockedBy`/`fileSet`)
// are stubbed per test.
const harnessCfg = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-graft-"));
  const logFile = join(stateDir, "orchestrator.jsonl");
  return {
    project: "harness",
    stateDir,
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    log: loggerForRun({ logFile }),
    fetchTask: async () => JSON.stringify({ state: "OPEN" }),
    blockedBy: async () => [],
    fileSet: () => ({ files: [], confident: true }),
    ...overrides,
  } as unknown as ResolvedConfig;
};

// Seed a running campaign onto the temp log: `campaign-start` with wave batches
// (no terminal event, so `campaignRunning` reads it as open) plus a `campaign-batch`
// marking wave 0 in-flight — so grafts land in a *future* wave, as they do live.
const launch = (cfg: ResolvedConfig, batches: string[][]) => {
  cfg.log.log("campaign-start", { batches, slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: batches[0] });
};

test("graft with no ids is rejected before any campaign lookup", async () => {
  const cfg = harnessCfg();
  await assert.rejects(
    () => runGraft(cfg, [], {}),
    /graft needs at least one issue id/,
  );
});

test("graft with no open campaign is rejected by the precondition guard", async () => {
  const cfg = harnessCfg();
  await assert.rejects(
    () => runGraft(cfg, ["301"], {}),
    /graft adds to a live-or-resumable campaign, but none is open/,
  );
});

test("--dry-run previews the placement but appends no event and enqueues nothing", async () => {
  const cfg = harnessCfg();
  launch(cfg, [["101"]]);

  const result = await runGraft(cfg, ["301"], { dryRun: true });

  assert.equal(result.applied, false);
  assert.deepEqual(result.placement, [{ id: "301", wave: 2 }]);
  assert.deepEqual(result.remaining, [["101"], ["301"]]);
  // Nothing was written: no graft event on the log, no outbound record.
  assert.equal(readEventLog(cfg).some((e) => e.event === "graft"), false);
  assert.equal(listOutbox(cfg).length, 0);
});

test("a real graft appends the graft event and enqueues a progress:graft note", async () => {
  const cfg = harnessCfg({ blockedBy: async () => [] });
  launch(cfg, [["101"]]);

  const result = await runGraft(cfg, ["301"], {});

  assert.equal(result.applied, true);
  assert.deepEqual(result.placement, [{ id: "301", wave: 2 }]);

  // The appended event carries the precomputed ADR-0012 layering inputs.
  const graftEvent = readEventLog(cfg).find((e) => e.event === "graft") as
    | { ids: string[]; blockedBy: Record<string, string[]>; basenames: Record<string, string[]> }
    | undefined;
  assert.ok(graftEvent, "expected a graft event on the log");
  assert.deepEqual(graftEvent!.ids, ["301"]);
  assert.deepEqual(graftEvent!.blockedBy, { "301": [] });
  // Basenames cover the grafted id plus the still-unstarted members it lays out
  // disjointly against (the in-flight wave 0's 101 has no outcome yet).
  assert.deepEqual(graftEvent!.basenames, { "101": [], "301": [] });

  // ...and a single routable progress:graft outbound record.
  const outbox = listOutbox(cfg);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].category, "progress");
  assert.equal(outbox[0].event, "graft");
  assert.match(outbox[0].text, /grafted #301/);
});

test("the graft event records only in-campaign/co-grafted blockers, and placement respects them", async () => {
  // 302 is blocked by 301 (co-grafted) and by 888 (outside the campaign+graft set).
  // The seam keeps the in-set edge and drops 888, then places 302 after 301.
  const cfg = harnessCfg({
    blockedBy: async (id) => (String(id) === "302" ? ["301", "888"] : []),
  });
  launch(cfg, [["101"]]);

  const result = await runGraft(cfg, ["301", "302"], {});

  assert.deepEqual(result.event.blockedBy, { "301": [], "302": ["301"] });
  assert.deepEqual(result.placement, [
    { id: "301", wave: 2 },
    { id: "302", wave: 3 },
  ]);
});

test("an id already in the campaign is rejected whole — nothing appended", async () => {
  const cfg = harnessCfg();
  launch(cfg, [["101"], ["202"]]);

  await assert.rejects(
    () => runGraft(cfg, ["202"], {}),
    /graft rejected — nothing added \(already in the campaign: #202\)/,
  );
  assert.equal(readEventLog(cfg).some((e) => e.event === "graft"), false);
  assert.equal(listOutbox(cfg).length, 0);
});

test("an unknown id (a throwing fetchTask) is rejected whole — nothing appended", async () => {
  const cfg = harnessCfg({
    fetchTask: async (id) => {
      if (String(id) === "999") throw new Error("no such issue");
      return JSON.stringify({ state: "OPEN" });
    },
  });
  launch(cfg, [["101"]]);

  await assert.rejects(
    () => runGraft(cfg, ["999"], {}),
    /graft rejected — nothing added \(unknown\/missing: #999\)/,
  );
  assert.equal(readEventLog(cfg).some((e) => e.event === "graft"), false);
  assert.equal(listOutbox(cfg).length, 0);
});
