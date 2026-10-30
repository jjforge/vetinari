import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { reduceCampaign } from "./dashboard-lifecycle.ts";
import { defaultReplanDeps, runReplan } from "./replan.ts";

// A temp-dir `cfg` mirroring graft.test's: a real on-disk event log under a throwaway state
// dir is what `runReplan` reads and appends to, so the seam is exercised for real; only the
// tracker edges (`fetchTask`/`blockedBy`/`fileSet`) are stubbed. Each issue's body carries a
// `Touches:` line the stub `fileSet` reads, so a test changes the plan by changing `touches`.
const harnessCfg = (touches: Record<string, string>, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-replan-"));
  const logFile = join(stateDir, "orchestrator.jsonl");
  return {
    project: "harness",
    stateDir,
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    log: loggerForRun({ logFile }),
    fetchTask: async (id: string) => JSON.stringify({ state: "OPEN", body: `Touches: ${touches[id] ?? ""}` }),
    blockedBy: async () => [],
    fileSet: (ticket: string) => {
      const cites = (ticket.match(/Touches: (.*)/)?.[1] ?? "").split(" ").filter(Boolean);
      return { files: cites, confident: cites.length > 0 };
    },
    ...overrides,
  } as unknown as ResolvedConfig;
};

// Seed a running campaign: `campaign-start` with its waves plus a `wave-start` marking wave 0
// in flight, as it is live.
const launch = (cfg: ResolvedConfig, waves: string[][]) => {
  cfg.log.log("campaign-start", { waves, slots: 4 });
  cfg.log.log("wave-start", { index: 0, tasks: waves[0] });
};

const replans = (cfg: ResolvedConfig) => readEventLog(cfg).filter((e) => e.event === "replan");

test("replan puts two unstarted issues that no longer share a file key in one wave, without archiving the log", async () => {
  // At launch 102 and 103 shared `shared.ts`, so they sat in waves of their own; the
  // config's file data now has them disjoint.
  const cfg = harnessCfg({ "101": "a.ts", "102": "b.ts", "103": "c.ts" });
  launch(cfg, [["101"], ["102"], ["103"]]);

  const result = await runReplan(cfg, {}, defaultReplanDeps);

  assert.equal(result.applied, true);
  assert.deepEqual(
    replans(cfg).map((e) => e.event === "replan" && e.waves),
    [[["102", "103"]]],
  );
  // The log is the same live log, not archived — the plan the loop re-folds now runs them together.
  assert.equal(existsSync(cfg.logFile), true);
  assert.deepEqual(reduceCampaign(readEventLog(cfg)).waves, [["101"], ["102", "103"]]);
});

test("replan with no unfinished campaign refuses and logs nothing", async () => {
  const empty = harnessCfg({});
  await assert.rejects(() => runReplan(empty, {}), /no unfinished campaign/);
  assert.equal(replans(empty).length, 0);

  const done = harnessCfg({ "101": "a.ts", "102": "b.ts" });
  launch(done, [["101"], ["102"]]);
  done.log.log("campaign-done", { waves: 2 });
  await assert.rejects(() => runReplan(done, {}), /no unfinished campaign/);
  assert.equal(replans(done).length, 0);
});

test("replan refuses whole, naming every offender, when an unstarted issue is under-specified or blocked from outside the campaign", async () => {
  // 103 cites nothing (no confident file set); 104 waits on #900, open and not in the campaign.
  const cfg = harnessCfg(
    { "101": "a.ts", "102": "b.ts", "103": "", "104": "d.ts" },
    { blockedBy: async (id: string) => (id === "104" ? ["900"] : []) },
  );
  launch(cfg, [["101"], ["102"], ["103"], ["104"]]);

  await assert.rejects(
    () => runReplan(cfg, {}),
    (err: Error) => {
      assert.match(err.message, /#103 has no confident file set — fix its Touches:\/Creates: marker, or `prune 103`/);
      assert.match(err.message, /#104 is blocked by #900, open and outside the campaign — `graft 900`, or `prune 104`/);
      return true;
    },
  );
  assert.equal(replans(cfg).length, 0);
});

test("replan keeps an unstarted issue after its in-campaign blocker, and reads a started blocker as satisfied", async () => {
  // All four are file-disjoint, so only blockers order them. 103 waits on the unstarted 102;
  // 104 waits on 101, which is in flight (started, not merged) — every unstarted wave runs after it.
  const cfg = harnessCfg(
    { "101": "a.ts", "102": "b.ts", "103": "c.ts", "104": "d.ts" },
    { blockedBy: async (id: string) => ({ "103": ["102"], "104": ["101"] })[id] ?? [] },
  );
  launch(cfg, [["101"], ["102"], ["103"], ["104"]]);

  const result = await runReplan(cfg, {});

  assert.deepEqual(result.next, [["102", "104"], ["103"]]);
  assert.deepEqual(reduceCampaign(readEventLog(cfg)).waves, [["101"], ["102", "104"], ["103"]]);
});

test("replan --dry-run reports both plans and logs nothing; an unchanged result logs nothing either", async () => {
  const cfg = harnessCfg({ "101": "a.ts", "102": "b.ts", "103": "c.ts" });
  launch(cfg, [["101"], ["102"], ["103"]]);

  const preview = await runReplan(cfg, { dryRun: true });
  assert.deepEqual(preview.current, [["102"], ["103"]]);
  assert.deepEqual(preview.next, [["102", "103"]]);
  assert.equal(preview.started, 1);
  assert.equal(preview.applied, false);
  assert.equal(replans(cfg).length, 0);

  // Once applied, a second re-plan computes the same waves: plan unchanged, no second event.
  await runReplan(cfg, {});
  const again = await runReplan(cfg, {});
  assert.equal(again.unchanged, true);
  assert.equal(again.applied, false);
  assert.equal(replans(cfg).length, 1);
});

test("replan refuses and logs nothing when a graft lands between its read and its append", async () => {
  const touches: Record<string, string> = { "101": "a.ts", "102": "b.ts", "103": "c.ts" };
  let racedGraft = false;
  const cfg: ResolvedConfig = harnessCfg(touches, {
    // A `graft` from another terminal lands while replan is reading the tracker.
    fetchTask: async (id: string) => {
      if (!racedGraft) {
        racedGraft = true;
        cfg.log.log("graft", { ids: ["301"], blockedBy: {}, fileKeys: {} });
      }
      return JSON.stringify({ state: "OPEN", body: `Touches: ${touches[id] ?? ""}` });
    },
  });
  launch(cfg, [["101"], ["102"], ["103"]]);

  await assert.rejects(() => runReplan(cfg, {}), /the campaign changed while re-planning; run it again/);
  assert.equal(replans(cfg).length, 0);
});

test("replan with no blockedBy resolver configured refuses, since it cannot keep blockers first", async () => {
  const cfg = harnessCfg({ "101": "a.ts", "102": "b.ts" }, { blockedBy: undefined });
  launch(cfg, [["101"], ["102"]]);
  await assert.rejects(() => runReplan(cfg, {}), /replan needs a "blockedBy" resolver/);
});
