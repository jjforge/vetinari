import test from "node:test";
import assert from "node:assert/strict";
import {
  formatComplete,
  formatOutcomes,
  formatPlan,
  formatResume,
  formatResumeNothing,
  formatSlowGates,
  formatStop,
  formatWaveDone,
  formatWaveStart,
  issueLabel,
  makeReporter,
  campaignBaseGates,
  formatBaseGateEstimate,
  formatCampaignBaseGates,
  formatWaveTimeSplit,
  waveTimeSplit,
} from "./report.ts";
import type { OrchestratorEvent } from "./event-log.ts";

// --- issueLabel: an id, plus its title when the run resolved one ---------------

test("issueLabel prefixes # and appends the resolved title when there is one", () => {
  assert.equal(issueLabel("640", { "640": "Carve drops dependents" }), "#640 Carve drops dependents");
});

test("issueLabel is the bare #id when no title was resolved", () => {
  assert.equal(issueLabel("640", {}), "#640");
});

// --- formatPlan: the waves with ids and titles, named when the run is ----------

test("formatPlan lists each wave with its ids and titles, headed by the name", () => {
  const out = formatPlan([["101", "102"], ["201"]], { "101": "Foo", "201": "Baz" }, "vocab");
  assert.equal(out, "plan “vocab” · 2 waves\n  wave 1 — #101 Foo, #102\n  wave 2 — #201 Baz");
});

test("formatPlan omits the name segment when the campaign is unnamed", () => {
  const out = formatPlan([["101"]], {}, undefined);
  assert.equal(out, "plan · 1 wave\n  wave 1 — #101");
});

// --- formatWaveStart / formatWaveDone: per-wave progress -----------------------

test("formatWaveStart names the wave, its position, and its issues", () => {
  assert.equal(formatWaveStart(0, 2, ["101", "102"], { "101": "Foo" }), "▶ wave 1/2 — #101 Foo, #102");
});

test("formatWaveDone reports what merged", () => {
  assert.equal(formatWaveDone(0, 2, { merged: ["101"] }), "✔ wave 1/2 merged #101");
});

test("formatWaveDone says nothing merged when the wave banked none", () => {
  assert.equal(formatWaveDone(0, 1, { merged: [] }), "✔ wave 1/1 merged nothing");
});

// --- formatOutcomes: the per-issue outcome, error mapped to the vocabulary -----

test("formatOutcomes prints one line per issue, mapping error(n) to failed", () => {
  assert.equal(
    formatOutcomes(["101", "102", "103"], { "101": "green", "102": "parked", "103": "error(1)" }),
    "  #101 green\n  #102 parked\n  #103 failed",
  );
});

// --- formatComplete / resume ---------------------------------------------------

test("formatComplete names the run and the base it landed on", () => {
  assert.equal(formatComplete(2, "main", "vocab"), "🏆 campaign “vocab” complete · 2 waves onto main");
});

test("formatComplete drops the name segment when unnamed", () => {
  assert.equal(formatComplete(1, "main", undefined), "🏆 campaign complete · 1 wave onto main");
});

test("formatResume announces the wave a redrive re-enters", () => {
  assert.equal(formatResume(1, 3), "↩ redrive · continuing from wave 2/3");
});

test("formatResumeNothing reports an already-merged campaign", () => {
  assert.equal(formatResumeNothing(3), "↩ redrive · nothing to run — all 3 waves already merged");
});

// --- formatStop: the one-line stop reason and the exact recovery command -------

test("a failed stop names the failure and the redrive/prune recovery", () => {
  const out = formatStop({
    kind: "failed",
    index: 0,
    total: 2,
    failed: ["101"],
    merged: ["102"],
  });
  assert.equal(
    out,
    "✖ campaign failed at wave 1/2 — #101 failed; merged #102 kept, 1 wave not started\n" +
      "recover: fix it forward or `vetinari prune 101`, then `vetinari redrive`",
  );
});

test("an issue-parked stop offers answer/prune, then redrive", () => {
  const out = formatStop({
    kind: "issue-parked",
    index: 0,
    total: 2,
    parked: ["102"],
    merged: ["101"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — #102 awaiting a human; merged #101 kept, 1 wave not started\n" +
      'recover: `vetinari answer 102 "…"` (or resolve) or `vetinari prune 102`, then `vetinari redrive`',
  );
});

test("a member-stopped stop names every held member and points at redrive, never at answering (#441)", () => {
  const out = formatStop({
    kind: "member-stopped",
    index: 0,
    total: 2,
    parked: ["102", "103"],
    merged: ["101"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — #102, #103 stopped mid-run (stopped); merged #101 kept, 1 wave not started\n" +
      "recover: `vetinari redrive` (or `vetinari prune 102`)",
  );
});

test("an outdated-agent stop names the held members and points at `vetinari build`, then redrive — never at answering (#444)", () => {
  const out = formatStop({ kind: "outdated-agent", index: 0, total: 2, parked: ["102", "103"], merged: ["101"] });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — #102, #103: the image's agent CLI is too old for the model (outdated-agent); merged #101 kept, 1 wave not started\n" +
      "recover: `vetinari build`, then `vetinari redrive`",
  );
});

test("a red-base stop points at fix-forward then redrive", () => {
  const out = formatStop({
    kind: "red-base",
    index: 1,
    total: 3,
    merged: ["201"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 2/3 — merged base is red (red-base); merged #201 kept, 1 wave not started\n" +
      "recover: fix forward on the base, then `vetinari redrive` — or `vetinari prune <id>`",
  );
});

test("a stranded-conflict stop offers redrive or redrive --auto-prune", () => {
  const out = formatStop({
    kind: "stranded-conflict",
    index: 0,
    total: 2,
    stranded: ["201"],
    merged: ["101"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — conflict stranded #201 in a later wave; merged #101 kept, 1 wave not started\n" +
      "recover: resolve the conflict then `vetinari redrive`, or `vetinari redrive --auto-prune`",
  );
});

// --- makeReporter: the json gate. Human lines only reach stdout without --json --

test("a default reporter prints its line to the sink", () => {
  const lines: string[] = [];
  const r = makeReporter({ json: false, out: (s) => lines.push(s) });
  r.line("hello");
  assert.deepEqual(lines, ["hello"]);
  assert.equal(r.json, false);
});

test("a --json reporter suppresses human lines (raw events go to the log echo instead)", () => {
  const lines: string[] = [];
  const r = makeReporter({ json: true, out: (s) => lines.push(s) });
  r.line("hello");
  assert.deepEqual(lines, []);
  assert.equal(r.json, true);
});

test("a stopped stop names the wave, the stop, and `vetinari redrive` (#403)", () => {
  const out = formatStop({ kind: "stopped", index: 1, total: 3, merged: ["101"] });
  assert.equal(out, "🅿 campaign parked at wave 2/3 — stopped; merged #101 kept, 1 wave not started\n" + "recover: `vetinari redrive`");
});

test("formatSlowGates names a history flag's gate, both medians and the runs behind each (#445)", () => {
  const lines = formatSlowGates({
    history: [{ cmd: "make test", earlierMedian: 60, earlierRuns: 40, currentMedian: 228.5, currentRuns: 3 }],
    budget: [],
  });
  assert.deepEqual(lines, ["🐢 slow gate `make test` — median 229s over 3 runs this campaign, up from 60s over 40 earlier runs"]);
});

test("formatSlowGates names a budget overrun's gate, its budget and how many of the wave's runs went over (#445)", () => {
  const lines = formatSlowGates({ history: [], budget: [{ cmd: "make test", budgetSeconds: 300, over: 2, runs: 5 }] });
  assert.deepEqual(lines, ["🐢 slow gate `make test` — 2 of 5 runs this wave went over its 300s budget"]);
});

test("formatSlowGates prints nothing when no gate is slow", () => {
  assert.deepEqual(formatSlowGates({ history: [], budget: [] }), []);
});

// --- the wave time split: where a wave's time went, read off its events (#615) ---------------

/** An event `at` seconds after a fixed epoch — fixture logs are written in whole seconds. */
const at = (seconds: number, event: string, fields: Record<string, unknown> = {}): OrchestratorEvent =>
  ({ ts: new Date(Date.UTC(2026, 9, 30, 12, 0, seconds)).toISOString(), event, ...fields }) as unknown as OrchestratorEvent;

/** A clean wave of two members: #102 is the slower one (398s spawn→green, 79s of it in branch gates). */
const twoMemberWave: OrchestratorEvent[] = [
  at(0, "wave-start", { index: 2, tasks: ["101", "102"] }),
  at(1, "spawn", { taskId: "101" }),
  at(2, "spawn", { taskId: "102" }),
  at(200, "gate-result", { taskId: "101", cmd: "make test", exitCode: 0, seconds: 30, outFile: "a" }),
  at(210, "green", { taskId: "101", branch: "agent/101", commits: [] }),
  at(350, "gate-result", { taskId: "102", cmd: "make test", exitCode: 1, seconds: 50, outFile: "b" }),
  at(380, "gate-result", { taskId: "102", cmd: "make test", exitCode: 0, seconds: 29, outFile: "c" }),
  at(400, "green", { taskId: "102", branch: "agent/102", commits: [] }),
  at(410, "merged", { taskId: "101" }),
  at(411, "merged", { taskId: "102" }),
  at(470, "gate-result", { cmd: "make test", exitCode: 0, seconds: 52, outFile: "d" }),
  at(490, "gate-result", { cmd: "make e2e", exitCode: 0, seconds: 20, outFile: "e" }),
  at(491, "base-gate", { index: 2, green: true }),
  at(492, "wave-done", { index: 2, merged: ["101", "102"] }),
];

test("waveTimeSplit splits a wave into agent, branch gates, integration + base gate and post-merge, off its slower member", () => {
  assert.deepEqual(waveTimeSplit(twoMemberWave), { total: 492, agent: 319, branchGates: 79, integration: 91, postMerge: 1 });
});

test("waveTimeSplit leaves the agent and branch-gate phases undefined when a member ran twice in the wave (a re-admit)", () => {
  const readmitted = [
    ...twoMemberWave.slice(0, 8),
    at(401, "re-admit", { taskId: "102", reason: "conflict", paths: ["a.ts"], base: "abc" }),
    at(402, "spawn", { taskId: "102" }),
    at(405, "green", { taskId: "102", branch: "agent/102", commits: [] }),
    ...twoMemberWave.slice(8),
  ];
  const split = waveTimeSplit(readmitted);
  assert.equal(split.agent, undefined);
  assert.equal(split.branchGates, undefined);
  assert.deepEqual(split, { total: 492, integration: 86, postMerge: 1 });
});

test("waveTimeSplit keeps only the total when a redriven wave banked its members and merged nothing new", () => {
  const redriven = [
    at(0, "wave-start", { index: 2, tasks: ["101", "102"] }),
    at(3, "redrive", { fromWave: 2, landed: 0, skipped: 2 }),
    at(5, "wave-done", { index: 2, merged: [] }),
  ];
  const split = waveTimeSplit(redriven);
  assert.equal(split.total, 5);
  for (const phase of ["agent", "branchGates", "integration", "postMerge"] as const) assert.equal(split[phase], undefined, phase);
});

test("formatWaveTimeSplit prints the wave's total, then each phase", () => {
  assert.equal(
    formatWaveTimeSplit({ total: 504, agent: 333, branchGates: 79, integration: 91, postMerge: 1 }),
    "8m24s — agent 5m33s · branch gates 1m19s · integration + base gate 1m31s · post-merge 1s",
  );
});

test("formatWaveTimeSplit prints — for a phase it could not derive, and the rest still print", () => {
  assert.equal(
    formatWaveTimeSplit({ total: 3725, integration: 65 }),
    "1h2m5s — agent — · branch gates — · integration + base gate 1m5s · post-merge —",
  );
});

// --- the campaign's merged-base gates: how many, and their total time (#615) ------------------

/** A wave's integration: its members merge, then the merged base gates on `seconds` (taskId-less rows). */
const integration = (t: number, taskId: string, seconds: number[]): OrchestratorEvent[] => [
  at(t, "merged", { taskId }),
  ...seconds.map((s, i) => at(t + 1 + i, "gate-result", { cmd: `gate ${i}`, exitCode: 0, seconds: s, outFile: "x" })),
  at(t + 1 + seconds.length, "base-gate", { green: true }),
];

const campaignLog: OrchestratorEvent[] = [
  // an earlier campaign — not this one's
  at(0, "campaign-start", { waves: [["90"]], slots: 1 }),
  ...integration(10, "90", [500]),
  // a `vetinari baseline` run: taskId-less results no base-gate follows
  at(30, "gate-result", { cmd: "make test", exitCode: 0, seconds: 400, outFile: "x" }),
  at(40, "campaign-start", { waves: [["101"], ["102"], ["103"]], slots: 1 }),
  at(41, "wave-start", { index: 0, tasks: ["101"] }),
  at(42, "gate-result", { taskId: "101", cmd: "make test", exitCode: 0, seconds: 300, outFile: "x" }),
  ...integration(50, "101", [52, 20]),
  at(60, "wave-start", { index: 1, tasks: ["102"] }),
  ...integration(70, "102", [40, 18]),
  at(80, "wave-start", { index: 2, tasks: ["103"] }),
  ...integration(90, "103", [60]),
];

test("campaignBaseGates totals this campaign's merged-base gates — never a branch gate, a baseline run or an earlier campaign's", () => {
  assert.deepEqual(campaignBaseGates(campaignLog), { count: 3, seconds: 190 });
});

test("formatCampaignBaseGates names the total merged-base gate time and how many gates it was", () => {
  assert.equal(formatCampaignBaseGates({ count: 13, seconds: 936 }), "⏱ base gates: 15m36s over 13 merged-base gates this campaign");
  assert.equal(formatCampaignBaseGates({ count: 1, seconds: 72 }), "⏱ base gates: 1m12s over 1 merged-base gate this campaign");
});

test("formatBaseGateEstimate reads a plan's wave count as base-gate time, naming the median and its sample size", () => {
  assert.equal(formatBaseGateEstimate(13, { median: 72, runs: 24 }), "base gates: ~13 × 1m12s (median of 24 past base gates) ≈ 16m");
  assert.equal(formatBaseGateEstimate(1, { median: 40, runs: 1 }), "base gates: ~1 × 40s (median of 1 past base gate) ≈ 40s");
  assert.equal(formatBaseGateEstimate(60, { median: 65, runs: 3 }), "base gates: ~60 × 1m5s (median of 3 past base gates) ≈ 1h5m");
});

test("formatBaseGateEstimate says there is no history, and prints no number, when no merged-base gate ever ran", () => {
  const line = formatBaseGateEstimate(13, undefined);
  assert.equal(line, "base gates: no estimate — no merged-base gate in this project's history yet");
  assert.doesNotMatch(line, /\d/);
});
