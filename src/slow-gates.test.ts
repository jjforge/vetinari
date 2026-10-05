// Tests for slow-gate detection (slow-gates.ts): the history flag and the budget flag over a
// project's `gate-result` events, and which results count as "current" and "earlier".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { event, type OrchestratorEvent } from "./event-log.ts";
import { latestCampaignSlowGates, readSlowGateLogs, slowGatesAtSettle } from "./slow-gates.ts";

const result = (seconds: number, opts: { cmd?: string; exitCode?: number; budgetSeconds?: number; taskId?: string } = {}) =>
  event("gate-result", {
    cmd: opts.cmd ?? "make test",
    exitCode: opts.exitCode ?? 0,
    seconds,
    outFile: "out.log",
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.budgetSeconds !== undefined ? { budgetSeconds: opts.budgetSeconds } : {}),
  });
const campaignStart = () => event("campaign-start", { waves: [["1"]], slots: 1 });
const waveStart = (index: number) => event("wave-start", { index, tasks: ["1"] });
const waveDone = (index: number) => event("wave-done", { index, merged: ["1"] });

/** One campaign's worth of green results at the given durations, framed as a single wave. */
const campaignOf = (...seconds: number[]): OrchestratorEvent[] => [
  campaignStart(),
  waveStart(0),
  ...seconds.map((s) => result(s)),
  waveDone(0),
];

test("a gate whose current-campaign median is well over its earlier median is flagged, naming both medians and run counts", () => {
  const events = [...campaignOf(60, 60, 60, 60, 60), campaignStart(), waveStart(0), result(100), result(110), result(120)];
  assert.deepEqual(slowGatesAtSettle(events).history, [
    { cmd: "make test", earlierMedian: 60, earlierRuns: 5, currentMedian: 110, currentRuns: 3 },
  ]);
});

test("creep is caught: each campaign under 1.5× the one before, but the latest ≥ 1.5× and ≥ 30s over all earlier results", () => {
  // Per-campaign medians 100 → 140 → 190: each step < 1.5×, but 190 vs the pooled earlier median (120) is 1.58× and +70s.
  const events = [...campaignOf(100, 100, 100), ...campaignOf(140, 140, 140), ...campaignOf(190, 190, 190)];
  assert.deepEqual(slowGatesAtSettle(events).history, [
    { cmd: "make test", earlierMedian: 120, earlierRuns: 6, currentMedian: 190, currentRuns: 3 },
  ]);
});

test("red results are excluded from both medians", () => {
  // Without the reds, earlier is 60 and current 120 — flagged. Counting the fast fail-fast reds would
  // drag the current median down to 6, and slow earlier reds would lift the earlier one.
  const events = [
    ...campaignOf(60, 60, 60, 60, 60),
    result(900, { exitCode: 1 }),
    result(900, { exitCode: 1 }),
    campaignStart(),
    waveStart(0),
    result(120),
    result(120),
    result(120),
    ...[1, 1, 1, 1].map((s) => result(s, { exitCode: 2 })),
  ];
  assert.deepEqual(slowGatesAtSettle(events).history, [
    { cmd: "make test", earlierMedian: 60, earlierRuns: 5, currentMedian: 120, currentRuns: 3 },
  ]);
});

test("no history flag with fewer than 5 earlier or fewer than 3 current green results", () => {
  const fourEarlier = [...campaignOf(60, 60, 60, 60), ...campaignOf(200, 200, 200)];
  assert.deepEqual(slowGatesAtSettle(fourEarlier).history, []);
  const twoCurrent = [...campaignOf(60, 60, 60, 60, 60), ...campaignOf(200, 200)];
  assert.deepEqual(slowGatesAtSettle(twoCurrent).history, []);
});

test("no history flag when the slowdown is under 1.5× or under 30s", () => {
  const underRatio = [...campaignOf(100, 100, 100, 100, 100), ...campaignOf(149, 149, 149)];
  assert.deepEqual(slowGatesAtSettle(underRatio).history, []);
  const underFloor = [...campaignOf(10, 10, 10, 10, 10), ...campaignOf(39, 39, 39)];
  assert.deepEqual(slowGatesAtSettle(underFloor).history, []);
});

test("gates are keyed by cmd: an edited command starts a new series, and agent-run and base results pool", () => {
  const events = [
    ...campaignOf(60, 60, 60, 60, 60),
    campaignStart(),
    waveStart(0),
    // Agent-run and merged-base results of the same cmd pool into one series.
    result(200, { taskId: "1" }),
    result(200, { taskId: "2" }),
    result(200),
    // A renamed command has no earlier history, so it cannot be flagged.
    ...[300, 300, 300].map((s) => result(s, { cmd: "make test-all" })),
  ];
  assert.deepEqual(
    slowGatesAtSettle(events).history.map((h) => h.cmd),
    ["make test"],
  );
});

test("a history flag that tripped at an earlier settle of this campaign is not reported again — once per gate per campaign", () => {
  const history = campaignOf(60, 60, 60, 60, 60);
  const firstWave = [campaignStart(), waveStart(0), result(200), result(200), result(200), waveDone(0)];
  // At wave 1's settle the flag trips for the first time.
  assert.equal(slowGatesAtSettle([...history, ...firstWave]).history.length, 1);
  // Wave 2 settles still slow: already reported at wave 1's settle, so nothing new.
  const secondWave = [waveStart(1), result(210), event("campaign-parked", { index: 1, reason: "question" })];
  assert.deepEqual(slowGatesAtSettle([...history, ...firstWave, ...secondWave]).history, []);
  // A redrive re-enters wave 2 in a new process, appending to the same log with a fresh wave-start
  // and no new campaign-start: still the same campaign, still reported.
  const redrive = [waveStart(1), result(220), waveDone(1)];
  assert.deepEqual(slowGatesAtSettle([...history, ...firstWave, ...secondWave, ...redrive]).history, []);
});

test("a history flag first reported at a later settle when it had not tripped at the earlier ones", () => {
  const history = campaignOf(60, 60, 60, 60, 60);
  // Wave 1 has only two green results — under the current minimum, so no flag at its settle.
  const firstWave = [campaignStart(), waveStart(0), result(200), result(200), waveDone(0)];
  assert.deepEqual(slowGatesAtSettle([...history, ...firstWave]).history, []);
  const secondWave = [waveStart(1), result(200), event("campaign-failed", { index: 1, detail: "2 failed" })];
  assert.equal(slowGatesAtSettle([...history, ...firstWave, ...secondWave]).history.length, 1);
});

test("a budget overrun counts the settling wave's results over the logged budget — red results too — with no history needed", () => {
  const events = [
    campaignStart(),
    waveStart(0),
    // Wave 1's overrun belongs to wave 1's settle, not wave 2's.
    result(700, { budgetSeconds: 300 }),
    waveDone(0),
    waveStart(1),
    result(200, { budgetSeconds: 300 }),
    result(301, { budgetSeconds: 300 }),
    // A timeout is red, and still over budget.
    result(601, { exitCode: 2, budgetSeconds: 300 }),
    // A gate that sets no budget is never budget-flagged.
    result(900, { cmd: "make lint" }),
  ];
  assert.deepEqual(slowGatesAtSettle(events).budget, [{ cmd: "make test", budgetSeconds: 300, over: 2, runs: 3 }]);
});

test("a wave with no result over budget reports no budget overrun", () => {
  const events = [campaignStart(), waveStart(0), result(300, { budgetSeconds: 300 })];
  assert.deepEqual(slowGatesAtSettle(events).budget, []);
});

test("the dashboard's latest campaign is the live log's: the whole campaign's history flag and budget overruns, already-reported or not", () => {
  const archives = [campaignOf(60, 60, 60), campaignOf(60, 60)];
  const live = [
    campaignStart(),
    waveStart(0),
    result(200, { budgetSeconds: 250 }),
    result(200, { budgetSeconds: 250 }),
    result(200, { budgetSeconds: 250 }),
    waveDone(0),
    waveStart(1),
    result(400, { exitCode: 2, budgetSeconds: 250 }),
  ];
  assert.deepEqual(latestCampaignSlowGates(archives, live), {
    history: [{ cmd: "make test", earlierMedian: 60, earlierRuns: 5, currentMedian: 200, currentRuns: 3 }],
    budget: [{ cmd: "make test", budgetSeconds: 250, over: 1, runs: 4 }],
  });
});

test("with no campaign-start in the live log, the dashboard reads the newest archive's latest campaign against everything older", () => {
  const archives = [campaignOf(60, 60, 60, 60, 60), campaignOf(200, 200, 200)];
  assert.deepEqual(latestCampaignSlowGates(archives, []).history, [
    { cmd: "make test", earlierMedian: 60, earlierRuns: 5, currentMedian: 200, currentRuns: 3 },
  ]);
  // A campaign that is not slow flags nothing.
  assert.deepEqual(latestCampaignSlowGates([campaignOf(60, 60, 60, 60, 60), campaignOf(60, 60, 60)], []), { history: [], budget: [] });
});

test("readSlowGateLogs reads every archived orchestrator log oldest-first, plus the live log", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-slow-gates-"));
  const archive = join(stateDir, "logs", "archive");
  mkdirSync(archive, { recursive: true });
  const jsonl = (...rows: OrchestratorEvent[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(archive, "orchestrator-2026-10-02T00-00-00-000Z.jsonl"), jsonl(result(2)));
  writeFileSync(join(archive, "orchestrator-2026-10-01T00-00-00-000Z.jsonl"), jsonl(result(1)));
  writeFileSync(join(archive, "notes.txt"), "not a log");
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  writeFileSync(logFile, jsonl(result(3)));
  const { archives, live } = readSlowGateLogs(stateDir, logFile);
  assert.deepEqual(
    archives.map((a) => a.map((e) => (e as { seconds?: number }).seconds)),
    [[1], [2]],
  );
  assert.deepEqual(
    live.map((e) => (e as { seconds?: number }).seconds),
    [3],
  );
});
