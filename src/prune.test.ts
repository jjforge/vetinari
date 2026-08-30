import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { listOutbox } from "./state.ts";
import {
  applyPrune,
  pruneClosure,
  computePrune,
  defaultPruneDeps,
  quarantineImpacts,
  restrictBlockers,
  resumeIndex,
  runPrune,
} from "./prune.ts";

// A fake "blocked by" resolver from a plain edge map: id -> the ids that block it.
const blockedByFrom = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];

// A reduced campaign's outcomes as a plain map: id -> its current status.
const outcomesFrom = (o: Record<string, string>) => new Map(Object.entries(o));

test("computePrune removes a linear dependent chain and keeps unrelated issues", async () => {
  const res = await computePrune(
    [["611", "640"], ["623", "701"]],
    "640",
    blockedByFrom({ "701": ["640"] }), // 701 is blocked by 640
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, [["611"], ["623"]]);
});

test("computePrune follows every branch and sub-chain of dependents", async () => {
  const res = await computePrune(
    [["611", "640"], ["623", "701", "712", "720"], ["730"]],
    "640",
    blockedByFrom({ "701": ["640"], "712": ["701"], "720": ["701"], "730": ["720"], "623": ["611"] }),
  );

  assert.deepEqual(res.removed.sort(), ["640", "701", "712", "720", "730"]);
  // 611 and its own dependent 623 are unreachable to 640, so they stay.
  assert.deepEqual(res.remaining, [["611"], ["623"]]);
});

test("computePrune removes a diamond dependent even when it has another, kept blocker", async () => {
  const res = await computePrune(
    [["623", "640"], ["750"]],
    "640",
    blockedByFrom({ "750": ["640", "623"] }), // 750 needs BOTH; 623 is kept
  );

  assert.ok(res.removed.includes("750"), "750 depends on the pruned 640 via one path, so it must go");
  assert.deepEqual(res.remaining, [["623"]]);
});

test("computePrune removes only the target when nothing depends on it, dropping an emptied wave", async () => {
  const res = await computePrune(
    [["611", "623"], ["640"]],
    "640",
    blockedByFrom({}),
  );

  assert.deepEqual(res.removed, ["640"]);
  assert.deepEqual(res.remaining, [["611", "623"]]); // the "640"-only wave is dropped
});

test("computePrune normalizes leading # in the target, waves, and resolver output", async () => {
  const res = await computePrune(
    [["#611", "#640"], ["#701"]],
    "#640",
    blockedByFrom({ "701": ["#640"] }),
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, [["611"]]);
});

test("computePrune rejects a target that is not in the campaign", async () => {
  await assert.rejects(
    () => computePrune([["611", "640"]], "999", blockedByFrom({})),
    /999.*not in the campaign/i,
  );
});

test("computePrune ignores blockers that live outside the named campaign", async () => {
  // 701's blocker 555 is not part of this campaign; only the in-campaign edge to 640 matters.
  const res = await computePrune(
    [["640", "701"]],
    "640",
    blockedByFrom({ "701": ["640", "555"] }),
  );

  assert.deepEqual(res.removed, ["640", "701"]);
  assert.deepEqual(res.remaining, []);
});

test("applyPrune keeps a merged member and drops an unstarted one", () => {
  // 640 already merged, 701 not yet started; both are in the removed closure.
  const res = applyPrune(
    { waves: [["611", "640"], ["701"]], outcomes: outcomesFrom({ "640": "completed" }) },
    ["640", "701"],
  );

  // Banked work stays; the unstarted dependent leaves the plan.
  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []);
  assert.deepEqual(res.remaining, [["611", "640"]]); // 701's wave emptied and dropped
});

test("applyPrune drops a parked member but preserves its record by default (resumable)", () => {
  // 701 is parked; pruning it drops it from the plan but leaves its parked record
  // intact so its branch/worktree/session can be investigated and resumed (ADR 0013).
  const res = applyPrune(
    { waves: [["611"], ["701"]], outcomes: outcomesFrom({ "701": "parked" }) },
    ["701"],
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []); // preserved, not cleared
  assert.deepEqual(res.remaining, [["611"]]);
});

test("applyPrune with purge drops a parked member and clears its record (the true drop)", () => {
  // `--purge` is the rare true-drop: the parked record is cleared, reclaiming the work.
  const res = applyPrune(
    { waves: [["611"], ["701"]], outcomes: outcomesFrom({ "701": "parked" }) },
    ["701"],
    { purge: true },
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, ["701"]);
  assert.deepEqual(res.remaining, [["611"]]);
});

test("applyPrune keeps a green member so it still merges", () => {
  // 640 is green (mergeable) but in the closure — banked work is never discarded.
  const res = applyPrune(
    { waves: [["640", "701"]], outcomes: outcomesFrom({ "640": "completed", "701": "unstarted" }) },
    ["640", "701"],
  );

  assert.deepEqual(res.dropped, ["701"]);
  assert.deepEqual(res.parkedToClear, []);
  assert.deepEqual(res.remaining, [["640"]]);
});

test("applyPrune keeps a merged/green target but still drops its unfinished dependents", () => {
  // The target 640 already merged; its dependents 701 (parked) and 712 (unstarted)
  // are unfinished, so the deliberate subtree removal still drops them.
  const res = applyPrune(
    {
      waves: [["640"], ["701", "712"]],
      outcomes: outcomesFrom({ "640": "completed", "701": "parked" }),
    },
    ["640", "701", "712"],
  );

  assert.deepEqual(res.dropped, ["701", "712"]);
  assert.deepEqual(res.parkedToClear, []); // preserved by default
  assert.deepEqual(res.remaining, [["640"]]);
});

test("pruneClosure names the target, dropped dependents, kept-banked work, and remaining waves", () => {
  // 640 already merged (banked), its dependent 701 unstarted: the closure is
  // {640, 701}, but only 701 leaves the plan — 640 stays banked.
  const removed = ["640", "701"];
  const applied = applyPrune(
    { waves: [["611", "640"], ["701"]], outcomes: outcomesFrom({ "640": "completed" }) },
    removed,
  );

  assert.deepEqual(pruneClosure("640", removed, applied), {
    target: "640",
    dropped: ["701"],
    keptBanked: ["640"],
    remaining: [["611", "640"]],
  });
});

test("pruneClosure normalizes a leading # target and keeps closure order for kept-banked", () => {
  // Nothing merged: every closure member is dropped, so kept-banked is empty.
  const removed = ["640", "701", "712"];
  const applied = applyPrune({ waves: [["640"], ["701", "712"]], outcomes: outcomesFrom({}) }, removed);

  assert.deepEqual(pruneClosure("#640", removed, applied), {
    target: "640",
    dropped: ["640", "701", "712"],
    keptBanked: [],
    remaining: [],
  });
});

test("quarantineImpacts reports a quarantined issue's orphaned later-wave dependents", async () => {
  // Wave 0 ran; 640 quarantined on a merge conflict (green, so `completed`), 611 merged.
  // 701 in the unstarted wave 1 is blocked by 640, so it is orphaned.
  const impacts = await quarantineImpacts(
    { waves: [["611", "640"], ["623", "701"]], outcomes: outcomesFrom({ "611": "completed", "640": "completed" }) },
    ["640"],
    blockedByFrom({ "701": ["640"] }),
  );

  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].target, "640");
  assert.deepEqual(impacts[0].removed, ["640", "701"]);
  // Only the unstarted dependent is orphaned; the quarantined target itself is kept.
  assert.deepEqual(impacts[0].dropped, ["701"]);
});

test("quarantineImpacts reports an empty drop for a quarantine that orphans nothing", async () => {
  // 611 quarantined but nothing depends on it — no later-wave work is stranded.
  const impacts = await quarantineImpacts(
    { waves: [["611", "640"], ["623", "701"]], outcomes: outcomesFrom({ "611": "completed", "640": "completed" }) },
    ["611"],
    blockedByFrom({ "701": ["640"] }),
  );

  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].target, "611");
  assert.deepEqual(impacts[0].dropped, []);
});

test("quarantineImpacts follows the transitive closure across every quarantined issue", async () => {
  // 640 quarantined; 701 (blocked by 640) and 712 (blocked by 701) are both orphaned.
  const impacts = await quarantineImpacts(
    { waves: [["640"], ["701"], ["712"]], outcomes: outcomesFrom({ "640": "completed" }) },
    ["640"],
    blockedByFrom({ "701": ["640"], "712": ["701"] }),
  );

  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0].dropped.sort(), ["701", "712"]);
});

test("quarantineImpacts skips a quarantined id no longer in the plan (an earlier prune took it)", async () => {
  const impacts = await quarantineImpacts(
    { waves: [["611"]], outcomes: outcomesFrom({ "611": "completed" }) },
    ["999"],
    blockedByFrom({}),
  );

  assert.deepEqual(impacts, []);
});

test("resumeIndex skips waves that already merged work and points at the first unrun wave", () => {
  // Waves 0 and 1 fully merged, wave 2 never started: resume picks up at wave 2.
  const index = resumeIndex({
    waves: [["611", "640"], ["623"], ["701", "712"]],
    outcomes: outcomesFrom({ "611": "completed", "640": "completed", "623": "completed" }),
  });
  assert.equal(index, 2);
});

test("resumeIndex skips a wave-parked wave whose greens are merged but never closed", () => {
  // Wave 1 wave-parked: its greens merged (completed) though the wave never closed.
  // Resume must not redo those merged issues, so it continues at the unstarted wave 2.
  const index = resumeIndex({
    waves: [["611"], ["640", "655"], ["701"]],
    outcomes: outcomesFrom({ "611": "completed", "640": "completed", "655": "completed" }),
  });
  assert.equal(index, 2);
});

test("resumeIndex returns the wave count when every wave has merged — nothing left to run", () => {
  const index = resumeIndex({
    waves: [["611"], ["640"]],
    outcomes: outcomesFrom({ "611": "completed", "640": "completed" }),
  });
  assert.equal(index, 2); // == waves.length: the caller reports nothing left
});

test("resumeIndex resumes from the top when no wave has banked any work", () => {
  const index = resumeIndex({
    waves: [["611"], ["640"]],
    outcomes: outcomesFrom({ "611": "parked" }),
  });
  assert.equal(index, 0);
});

test("resumeIndex resumes past the last wave with any merged member, not just fully-merged waves", () => {
  // Wave 1 has one merged (640) and one still parked (655): it banked work, so resume
  // must not re-run it (that would redo 640). Continue at the next unrun wave.
  const index = resumeIndex({
    waves: [["611"], ["640", "655"], ["701"]],
    outcomes: outcomesFrom({ "611": "completed", "640": "completed", "655": "parked" }),
  });
  assert.equal(index, 2);
});

test("restrictBlockers keeps only the edges that stay inside the selected set", async () => {
  // 701 is blocked by 640 (in the set) and 555 (outside it); 611 has no blocker.
  const { inSet, external } = await restrictBlockers(
    ["611", "640", "701"],
    blockedByFrom({ "701": ["#640", "555"], "640": ["611"] }),
  );

  assert.deepEqual([...inSet.get("701")!], ["640"], "external blocker 555 is not an in-set edge");
  assert.deepEqual([...external.get("701")!], ["555"], "555 is recorded as external");
  assert.deepEqual([...inSet.get("640")!], ["611"]);
  assert.deepEqual([...inSet.get("611")!], []);
  assert.deepEqual([...external.get("640")!], []);
});

// --- runPrune: the command's inline orchestration, driven at the seam ---
//
// A temp-dir `cfg` mirroring graft.test's `harnessCfg`: a real on-disk event log
// under a throwaway state dir is what the prune path's `readEventLog`/`reduceCampaign`
// re-derive reads and what `enqueueOutbound`/`cfg.log` write — so the seam is
// exercised for real; only the tracker edge (`blockedBy`) is stubbed per test.
const harnessCfg = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-prune-"));
  const logFile = join(stateDir, "orchestrator.jsonl");
  return {
    project: "harness",
    stateDir,
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    log: loggerForRun({ logFile }),
    blockedBy: async () => [],
    ...overrides,
  } as unknown as ResolvedConfig;
};

// Seed a running campaign onto the temp log: `campaign-start` with wave batches
// (unsettled — no member merged, so the fold reads it as open) plus a `campaign-batch`
// marking wave 0 in-flight.
const launch = (cfg: ResolvedConfig, batches: string[][]) => {
  cfg.log.log("campaign-start", { batches, slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: batches[0] });
};

test("runPrune rejects a missing target before any campaign lookup", async () => {
  const cfg = harnessCfg();
  await assert.rejects(() => runPrune(cfg, "", {}), /prune needs an issue/);
});

test("runPrune rejects a config with no blockedBy resolver", async () => {
  const cfg = harnessCfg({ blockedBy: undefined });
  await assert.rejects(
    () => runPrune(cfg, "640", {}),
    /prune needs a "blockedBy" resolver/,
  );
});

test("runPrune rejects a prune when no campaign has been launched (empty log)", async () => {
  const cfg = harnessCfg();
  await assert.rejects(
    () => runPrune(cfg, "640", {}),
    /no campaign to prune/,
  );
});

test("runPrune rejects a prune when the campaign is settled (every member merged)", async () => {
  // Every wave merged and closed — the fold reads `completed`, so the campaign is
  // settled and refuses adjustment, even though the log carries no `campaign-done`.
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["640"]], slots: 4 });
  cfg.log.log("campaign-batch-done", { index: 0, merged: ["101"], held: [], clearedParked: [] });
  cfg.log.log("campaign-batch-done", { index: 1, merged: ["640"], held: [], clearedParked: [] });

  await assert.rejects(() => runPrune(cfg, "640", {}), /settled/);
});

test("runPrune proceeds on a campaign parked and stopped with no campaign-done", async () => {
  // Wave 0 parked and the run stopped; wave 1's 640 is still unstarted. The campaign
  // is unsettled, so a prune of 640 takes effect.
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["640"]], slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: ["101"] });
  cfg.log.log("parked", { taskId: "101", reason: "needs a decision" });

  const result = await runPrune(cfg, "640", {});
  assert.equal(result.mode, "prune");
  assert.equal(result.applied, true);
  assert.deepEqual(result.dropped, ["640"]);
});

test("runPrune proceeds on a campaign that failed and stopped with no campaign-done", async () => {
  // Wave 0's member errored out; wave 1's 640 is unstarted. A failed run is unsettled,
  // so a prune of 640 takes effect.
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["640"]], slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: ["101"] });
  cfg.log.log("queue-done", { outcomes: { "101": "error(1)" } });

  const result = await runPrune(cfg, "640", {});
  assert.equal(result.mode, "prune");
  assert.equal(result.applied, true);
  assert.deepEqual(result.dropped, ["640"]);
});

test("runPrune proceeds on a running campaign", async () => {
  // Wave 0 in flight (queue-start, no outcomes yet); wave 1's 640 is unstarted. A
  // running campaign is unsettled, so a prune of 640 takes effect.
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["640"]], slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: ["101"] });
  cfg.log.log("queue-start", { taskIds: ["101"], slots: 4 });

  const result = await runPrune(cfg, "640", {});
  assert.equal(result.mode, "prune");
  assert.equal(result.applied, true);
  assert.deepEqual(result.dropped, ["640"]);
});

test("runPrune --dry-run previews the prune but appends no event and enqueues nothing", async () => {
  const cfg = harnessCfg();
  launch(cfg, [["101"], ["640"]]);

  const result = await runPrune(cfg, "640", { dryRun: true });

  assert.equal(result.mode, "prune");
  assert.equal(result.applied, false);
  assert.deepEqual(result.remaining, [["101"]]);
  // The structured closure rides along on a dry-run so the dashboard preview can
  // name the exact closure without re-parsing prose.
  assert.deepEqual(result.mode === "prune" && result.closure, {
    target: "640",
    dropped: ["640"],
    keptBanked: [],
    remaining: [["101"]],
  });
  // Nothing was written: no prune event on the log, no outbound record.
  assert.equal(readEventLog(cfg).some((e) => e.event === "prune"), false);
  assert.equal(listOutbox(cfg).length, 0);
});

test("runPrune appends the prune event with its closure and enqueues a progress:prune note", async () => {
  // 701 is blocked by 640; pruning 640 drops its dependent 701 too.
  const cfg = harnessCfg({
    blockedBy: async (id) => (String(id) === "701" ? ["640"] : []),
  });
  launch(cfg, [["101"], ["640", "701"]]);

  const result = await runPrune(cfg, "640", {});

  assert.equal(result.mode, "prune");
  assert.equal(result.applied, true);
  assert.deepEqual(result.removed, ["640", "701"]);
  assert.deepEqual(result.dropped, ["640", "701"]);
  assert.deepEqual(result.remaining, [["101"]]);

  // The appended prune event carries target + closure + dropped, so the loop
  // replays the same rule at its next wave boundary.
  const ev = readEventLog(cfg).find((e) => e.event === "prune") as
    | { target: string; removed: string[]; dropped: string[] }
    | undefined;
  assert.ok(ev, "expected a prune event on the log");
  assert.equal(ev!.target, "640");
  assert.deepEqual(ev!.removed, ["640", "701"]);
  assert.deepEqual(ev!.dropped, ["640", "701"]);

  // ...and a single routable progress:prune outbound record.
  const outbox = listOutbox(cfg);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].category, "progress");
  assert.equal(outbox[0].event, "prune");
  assert.match(outbox[0].text, /pruned #640/);
});

test("runPrune preserves a dropped parked member's record by default", async () => {
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["701"]], slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: ["101"] });
  cfg.log.log("parked", { taskId: "701", reason: "needs attention" });

  const cleared: string[][] = [];
  const result = await runPrune(cfg, "701", {}, {
    ...defaultPruneDeps,
    clearParkedForTasks: (_cfg, ids) => cleared.push(ids),
  });

  assert.equal(result.mode, "prune");
  assert.deepEqual(result.mode === "prune" && result.dropped, ["701"]);
  assert.deepEqual(result.mode === "prune" && result.parkedDropped, ["701"]);
  // Preserved, not cleared (ADR 0013): the parked record stays resumable.
  assert.deepEqual(cleared, []);
});

test("runPrune --purge clears a dropped parked member's record", async () => {
  const cfg = harnessCfg();
  cfg.log.log("campaign-start", { batches: [["101"], ["701"]], slots: 4 });
  cfg.log.log("campaign-batch", { index: 0, tasks: ["101"] });
  cfg.log.log("parked", { taskId: "701", reason: "needs attention" });

  const cleared: string[][] = [];
  const result = await runPrune(cfg, "701", { purge: true }, {
    ...defaultPruneDeps,
    clearParkedForTasks: (_cfg, ids) => cleared.push(ids),
  });

  assert.equal(result.mode, "prune");
  assert.deepEqual(result.mode === "prune" && result.parkedDropped, ["701"]);
  // The rare true-drop: the parked record is cleared, reclaiming the work.
  assert.deepEqual(cleared, [["701"]]);
});

test("runPrune with an explicit plan launches a fresh reduced campaign", async () => {
  // 701 is blocked by 640; pruning 640 out of the supplied plan strips its dependent
  // and launches the remainder.
  const cfg = harnessCfg({
    blockedBy: async (id) => (String(id) === "701" ? ["640"] : []),
  });

  const launched: string[][][] = [];
  const result = await runPrune(
    cfg,
    "640",
    { plan: [["611", "640"], ["623", "701"]] },
    {
      ...defaultPruneDeps,
      launchCampaign: async (_cfg, batches) => {
        launched.push(batches);
        return true;
      },
    },
  );

  assert.equal(result.mode, "launch");
  assert.equal(result.mode === "launch" && result.launched, true);
  assert.deepEqual(result.removed, ["640", "701"]);
  assert.deepEqual(result.remaining, [["611"], ["623"]]);
  // The reduced remainder was handed to the campaign launcher.
  assert.deepEqual(launched, [[["611"], ["623"]]]);
  // ...and the fresh-launch path still announces a progress:prune note.
  const outbox = listOutbox(cfg);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].event, "prune");
  assert.match(outbox[0].text, /pruned #640/);
});

test("runPrune --dry-run on an explicit plan previews but launches nothing", async () => {
  const cfg = harnessCfg({
    blockedBy: async (id) => (String(id) === "701" ? ["640"] : []),
  });

  const launched: string[][][] = [];
  const result = await runPrune(
    cfg,
    "640",
    { dryRun: true, plan: [["611", "640"], ["623", "701"]] },
    {
      ...defaultPruneDeps,
      launchCampaign: async (_cfg, batches) => {
        launched.push(batches);
        return true;
      },
    },
  );

  assert.equal(result.mode, "launch");
  assert.equal(result.mode === "launch" && result.launched, false);
  assert.deepEqual(result.remaining, [["611"], ["623"]]);
  assert.deepEqual(launched, []);
  assert.equal(listOutbox(cfg).length, 0);
});
