// Tests for the dashboard's event reduction and issue/campaign lifecycle — the reducer, the
// lifecycle/membership/phase readers, issue-detail reconstruction, the wave and campaign
// folds, and the campaign* predicates (dashboard-lifecycle.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  campaignRunning,
  campaignSettled,
  campaignState,
  issueLifecycle,
  issueMembership,
  issuePhase,
  parkReasonFromEvent,
  reconstructIssueDetail,
  reduceCampaign,
  waveState,
} from "./dashboard-lifecycle.ts";
import { festiveOffsetFor } from "./dashboard-event-text.ts";
import { event, type OrchestratorEvent } from "./event-log.ts";

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

test("issue lifecycle + wave/campaign folds are one FSM, tested by replaying events (ADR 0019)", () => {
  // Replay an event sequence and assert the resulting issue lifecycles and the folds above
  // them, no render harness needed. 101 merges (completed), 102 parks blocked (question),
  // 103 quarantines on a merge conflict (parked/conflict), 104 errors (failure).
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["101", "102", "103", "104"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["101", "102", "103", "104"] }),
    event("green", { ts: "t2", taskId: "101", branch: "agent/101", commits: [] }),
    event("merged", { ts: "t2b", taskId: "101", branch: "agent/101" }),
    event("parked", { ts: "t3", taskId: "102", reason: "question" }),
    event("green", { ts: "t4", taskId: "103", branch: "agent/103", commits: [] }),
    event("parked", { ts: "t5", taskId: "103", reason: "conflict", detail: "CONFLICT" }),
    event("failed", { ts: "t6", taskId: "104" }),
  ]);
  assert.deepEqual(issueLifecycle(reduced, "101"), { state: "completed" });
  assert.deepEqual(issueLifecycle(reduced, "102"), { state: "parked", reason: "question" });
  assert.deepEqual(issueLifecycle(reduced, "103"), { state: "parked", reason: "conflict" });
  assert.deepEqual(issueLifecycle(reduced, "104"), { state: "failed" });
  // Every id is a plain member here; the folds skip pruned membership only.
  for (const id of ["101", "102", "103", "104"]) assert.equal(issueMembership(reduced, id), "member");

  // The wave fold: failure outranks parked outranks running (#262). A red member makes the
  // wave read `failed`, never `running`.
  assert.equal(waveState([{ status: "completed" }, { status: "parked" }, { status: "failed" }, { status: "running" }]), "failed");
  assert.equal(waveState([{ status: "completed" }, { status: "parked" }, { status: "running" }]), "parked");
  assert.equal(waveState([{ status: "completed" }, { status: "running" }]), "running");
  assert.equal(waveState([{ status: "completed" }, { status: "completed" }]), "completed");
  // A pruned member never forces a wave's state; a wholly-pruned wave reads unstarted.
  assert.equal(waveState([{ status: "running", membership: "pruned" }]), "unstarted");

  // The campaign fold mirrors the wave fold's precedence over the waves below it.
  assert.equal(campaignState(["completed", "parked", "failed", "running"]), "failed");
  assert.equal(campaignState(["completed", "parked", "running"]), "parked");
  assert.equal(campaignState(["completed", "running"]), "running");
  assert.equal(campaignState(["completed", "completed"]), "completed");
  assert.equal(campaignState([]), "unstarted");
});

test("parkReasonFromEvent recognizes `stopped`, and a member parked{stopped} folds to parked/stopped", () => {
  // `stopped` is a park reason (a signalled run), so it passes the validator unchanged rather
  // than defaulting to `question`.
  assert.equal(parkReasonFromEvent("stopped"), "stopped");
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["501"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["501"] }),
    event("spawn", { ts: "t2", taskId: "501" }),
    event("parked", { ts: "t3", taskId: "501", reason: "stopped", detail: "SIGINT" }),
  ]);
  assert.deepEqual(issueLifecycle(reduced, "501"), { state: "parked", reason: "stopped" });
});

test("parkReasonFromEvent recognizes `outdated-agent`, and a member parked{outdated-agent} folds to parked/outdated-agent (#444)", () => {
  assert.equal(parkReasonFromEvent("outdated-agent"), "outdated-agent");
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["501"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["501"] }),
    event("spawn", { ts: "t2", taskId: "501" }),
    event("parked", { ts: "t3", taskId: "501", reason: "outdated-agent", detail: "API Error: 400" }),
  ]);
  assert.deepEqual(issueLifecycle(reduced, "501"), { state: "parked", reason: "outdated-agent" });
});

test("issueLifecycle reads a running issue live, and its crash reconciliation off the reducer (ADR 0019, design §7)", () => {
  const events = [
    event("campaign-start", { ts: "t0", waves: [["301"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301"] }),
    event("spawn", { ts: "t2", taskId: "301" }),
  ];
  // A live (or probe-less) read leaves it running.
  assert.deepEqual(issueLifecycle(reduceCampaign(events), "301"), { state: "running" });
  // A dead read reconciles it inside the reducer; the lifecycle just surfaces the crash.
  assert.deepEqual(issueLifecycle(reduceCampaign(events, { alive: false }), "301"), { state: "parked", reason: "crash" });
});

test("reduceCampaign reconciles a dead run's in-flight issue to parked{crash}; a live probe leaves it running (design §7)", () => {
  const events = [
    event("campaign-start", { ts: "t0", waves: [["301"], ["302"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301"] }),
    event("spawn", { ts: "t2", taskId: "301" }),
    event("spawn", { ts: "t3", taskId: "301", running: 1, left: 0 }),
  ];
  // A live run (its slot is held) leaves the in-flight issue running — and the pure
  // default (no probe injected) never crash-folds either.
  assert.equal(reduceCampaign(events, { alive: true }).outcomes.get("301"), "running");
  assert.equal(reduceCampaign(events).outcomes.get("301"), "running");

  // A dead run — its slot is not held (design §8) and its log has no terminal stop
  // marker — reconciles the in-flight issue to parked{crash}, never left reading
  // running forever (§15). A never-started later member stays honestly unstarted.
  const dead = reduceCampaign(events, { alive: false });
  assert.equal(dead.outcomes.get("301"), "parked");
  assert.equal(dead.parkReasons.get("301"), "crash");
  assert.equal(dead.outcomes.get("302") ?? "unstarted", "unstarted");
  assert.deepEqual(issueLifecycle(dead, "301"), { state: "parked", reason: "crash" });

  // A cleanly-finished run has released its slot too (dead process), but its members
  // reached a terminal event and the log carries a stop marker — a crash never
  // overrides a completed issue.
  const done = [
    ...events,
    event("green", { ts: "t4", taskId: "301", branch: "agent/301", commits: [] }),
    event("wave-done", { ts: "t5", index: 0, merged: ["301"] }),
    event("campaign-done", { ts: "t6", waves: 1 }),
  ];
  assert.equal(reduceCampaign(done, { alive: false }).outcomes.get("301"), "completed");
});

test("reduceCampaign: a bare green is running-with-a-pending-green, completed only once merged (design §2.2)", () => {
  const base = [
    event("campaign-start", { ts: "t0", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "t2", taskId: "101" }),
    event("green", { ts: "t3", taskId: "101", branch: "agent/101", commits: [] }),
  ];
  // An unmerged green banks nothing on the base: the issue is `running` with a pending green,
  // exposed as a distinct chip detail and set in `pendingGreen` — never `completed`, and it
  // does NOT count toward "merged today" (no `mergedAt` stamp) since nothing merged.
  const green = reduceCampaign(base);
  assert.equal(green.outcomes.get("101"), "running", "an unmerged green reads running, not completed");
  assert.equal(green.pendingGreen.has("101"), true, "the pending green is flagged");
  assert.equal(green.mergedAt.has("101"), false, "a bare green stamps no mergedAt — nothing merged");
  assert.deepEqual(issueLifecycle(green, "101"), { state: "running" });
  assert.notEqual(green.details.get("101"), undefined);
  assert.match(green.details.get("101")!, /pending/i, "the chip detail distinguishes a pending green");

  // The integrator lands it: `merged` is what banks it — `completed`, with a `mergedAt` stamp,
  // and the pending-green flag cleared.
  const merged = reduceCampaign([...base, event("merged", { ts: "t4", taskId: "101", branch: "agent/101" })]);
  assert.equal(merged.outcomes.get("101"), "completed", "a merged green is completed");
  assert.equal(merged.pendingGreen.has("101"), false, "the pending-green flag clears on merge");
  assert.equal(merged.mergedAt.get("101"), "t4", "mergedAt is the merge stamp, not the green stamp");

  // A wave-done's `merged` list banks it the same way (the batch-merge path).
  const waveDone = reduceCampaign([...base, event("wave-done", { ts: "t5", index: 0, merged: ["101"] })]);
  assert.equal(waveDone.outcomes.get("101"), "completed");
  assert.equal(waveDone.pendingGreen.has("101"), false);
  assert.equal(waveDone.mergedAt.get("101"), "t5");
});

test("reduceCampaign: completed (merged) is terminal — a stale parked/failed/spawn is ignored and logged as an anomaly (design §2.2)", () => {
  // Observed 2026-08-30: #313 merged at 16:47:49Z, then a second process's stale parked{stalled}
  // at 16:48:28Z made the dashboard read it parked after the record was gone. A merge is terminal.
  const base = [
    event("campaign-start", { ts: "t0", waves: [["313"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["313"] }),
    event("spawn", { ts: "t2", taskId: "313" }),
    event("green", { ts: "t3", taskId: "313", branch: "agent/313", commits: [] }),
    event("merged", { ts: "2026-08-30T16:47:49.000Z", taskId: "313", branch: "agent/313" }),
  ];

  const staleParked = reduceCampaign([...base, event("parked", { ts: "2026-08-30T16:48:28.000Z", taskId: "313", reason: "stalled" })]);
  assert.equal(staleParked.outcomes.get("313"), "completed", "a stale parked never flips a merged issue back to parked");
  assert.deepEqual(issueLifecycle(staleParked, "313"), { state: "completed" });
  assert.ok(
    staleParked.anomalies.some((a) => a.includes("313")),
    "the ignored stale event is recorded as an anomaly",
  );

  const staleFailed = reduceCampaign([...base, event("failed", { ts: "2026-08-30T16:48:28.000Z", taskId: "313" })]);
  assert.equal(staleFailed.outcomes.get("313"), "completed", "a stale failed never flips a merged issue to failure");
  assert.ok(staleFailed.anomalies.some((a) => a.includes("313")));

  const staleSpawn = reduceCampaign([...base, event("spawn", { ts: "2026-08-30T16:48:28.000Z", taskId: "313" })]);
  assert.equal(staleSpawn.outcomes.get("313"), "completed", "a stale spawn never flips a merged issue to running");
  assert.ok(staleSpawn.anomalies.some((a) => a.includes("313")));
});

test("reduceCampaign: a dead run's pending green is NOT crash-folded — it reached a green verdict (design §2.2, §7)", () => {
  const events = [
    event("campaign-start", { ts: "t0", waves: [["301", "302"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301", "302"] }),
    event("spawn", { ts: "t2", taskId: "301" }),
    event("spawn", { ts: "t3", taskId: "302" }),
    // 301 reached green (a verdict) but never merged before the run died; 302 was still in flight.
    event("green", { ts: "t4", taskId: "301", branch: "agent/301", commits: [] }),
  ];
  const dead = reduceCampaign(events, { alive: false });
  // The in-flight, verdict-less 302 crash-folds; the pending green 301 keeps its verdict — it is
  // banked-but-unmerged work a redrive lands, not a crash to redrive from scratch.
  assert.equal(dead.outcomes.get("302"), "parked");
  assert.equal(dead.parkReasons.get("302"), "crash");
  assert.equal(dead.outcomes.get("301"), "running");
  assert.equal(dead.pendingGreen.has("301"), true);
  assert.deepEqual(issueLifecycle(dead, "301"), { state: "running" });
});

test("reduceCampaign: a spawn re-admits a parked member back to running (design §5 step 3)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "t2", taskId: "101" }),
    event("parked", { ts: "t3", taskId: "101", reason: "question" }),
    // The answer is delivered and the member re-admitted — its child spawns again.
    event("spawn", { ts: "t4", taskId: "101" }),
  ]);
  // The re-admit moves it back to running; a redrive/dashboard reads it running, not still parked.
  assert.equal(reduced.outcomes.get("101"), "running");
  assert.deepEqual(issueLifecycle(reduced, "101"), { state: "running" });
});

test("reduceCampaign: a spawn re-runs a failed member back to running — redrive --override (#399)", () => {
  // Observed on wave 10: a member timed out (`failed`), `campaign-failed`, then `redrive --override`
  // re-ran it — `wave-start` for the same index, `spawn` for the same id. The agent is live, but the
  // fold kept the member `failed`, so (failed outranks all) its wave and the campaign read failed.
  const base = [
    event("campaign-start", { ts: "t0", waves: [["6"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t2", taskId: "6" }),
    event("failed", { ts: "t3", taskId: "6" }),
    event("campaign-failed", { ts: "t4", index: 0, detail: "6 failed" }),
    event("wave-start", { ts: "t5", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t6", taskId: "6" }),
  ];
  const reduced = reduceCampaign(base);
  const waveStatuses = (reduced.waves[reduced.currentWave] ?? []).map((id) => ({ status: issueLifecycle(reduced, id).state }));
  assert.deepEqual(issueLifecycle(reduced, "6"), { state: "running" }, "the re-spawned member reads running, not failed");
  assert.equal(waveState(waveStatuses), "running", "its wave is running again");
  assert.equal(campaignState([waveState(waveStatuses)]), "running", "the campaign is running again");

  // A later failure for the same id still folds back to failed — the promotion is a re-run, not a lock.
  const refailed = reduceCampaign([...base, event("failed", { ts: "t7", taskId: "6" })]);
  const refailedStatuses = (refailed.waves[refailed.currentWave] ?? []).map((id) => ({ status: issueLifecycle(refailed, id).state }));
  assert.deepEqual(issueLifecycle(refailed, "6"), { state: "failed" });
  assert.equal(waveState(refailedStatuses), "failed");
  assert.equal(campaignState([waveState(refailedStatuses)]), "failed");
});

test("reduceCampaign treats any campaign-* stop marker as not-a-crash — an in-flight member is not crash-folded past a park/fail (design §7, #314)", () => {
  // A wave stopped with a stop marker on the log, but a member never reached a terminal
  // event of its own (a racy/partial log). A crash is the ABSENCE of a stop marker (design
  // §7); a campaign-parked or campaign-failed is a clean stop, so the reducer must not
  // reconcile the lingering `running` member to parked{crash}.
  const parked = [
    event("campaign-start", { ts: "t0", waves: [["301", "302"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301", "302"] }),
    event("spawn", { ts: "t2", taskId: "301" }),
    event("parked", { ts: "t3", taskId: "302", reason: "question" }),
    event("campaign-parked", { ts: "t4", index: 0, reason: "question", detail: "302 parked" }),
  ];
  assert.equal(reduceCampaign(parked, { alive: false }).outcomes.get("301"), "running", "a campaign-parked marker is not a crash");

  const failed = [
    event("campaign-start", { ts: "t0", waves: [["301", "302"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301", "302"] }),
    event("spawn", { ts: "t2", taskId: "301" }),
    event("failed", { ts: "t3", taskId: "302" }),
    event("campaign-failed", { ts: "t4", index: 0, detail: "302 failed" }),
  ];
  assert.equal(reduceCampaign(failed, { alive: false }).outcomes.get("301"), "running", "a campaign-failed marker is not a crash");
});

test("reduceCampaign crash-folds a redriven run that died mid-wave — only a stop marker since the latest wave-start counts (design §7)", () => {
  // A redrive writes no new `campaign-start` and logs its `redrive` only once the re-entered
  // wave integrates, so a redrive that dies mid-wave leaves the earlier run's
  // `campaign-parked`, then a fresh `wave-start` and `spawn`, then nothing. The earlier
  // marker belongs to a finished stop, not to the run that died.
  const redriven = [
    event("campaign-start", { ts: "t0", waves: [["6"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t2", taskId: "6" }),
    event("parked", { ts: "t3", taskId: "6", reason: "question" }),
    event("campaign-parked", { ts: "t4", index: 0, reason: "question", detail: "6 parked" }),
    event("wave-start", { ts: "t5", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t6", taskId: "6" }),
  ];
  assert.deepEqual(issueLifecycle(reduceCampaign(redriven, { alive: false }), "6"), { state: "parked", reason: "crash" });
  // A live or unprobed read never crash-folds.
  assert.deepEqual(issueLifecycle(reduceCampaign(redriven, { alive: true }), "6"), { state: "running" });
  assert.deepEqual(issueLifecycle(reduceCampaign(redriven), "6"), { state: "running" });
});

test("reduceCampaign: a redriven run that died mid-wave after a campaign-failed never reads running (design §7)", () => {
  const redriven = [
    event("campaign-start", { ts: "t0", waves: [["6"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t2", taskId: "6" }),
    event("failed", { ts: "t3", taskId: "6" }),
    event("campaign-failed", { ts: "t4", index: 0, detail: "6 failed" }),
    event("wave-start", { ts: "t5", index: 0, tasks: ["6"] }),
    event("spawn", { ts: "t6", taskId: "6" }),
  ];
  assert.notEqual(issueLifecycle(reduceCampaign(redriven, { alive: false }), "6").state, "running");
});

test("reduceCampaign: a redriven run that stopped cleanly again is not crash-folded (design §7)", () => {
  const redriven = [
    event("campaign-start", { ts: "t0", waves: [["6", "7"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["6", "7"] }),
    event("spawn", { ts: "t2", taskId: "6" }),
    event("parked", { ts: "t3", taskId: "6", reason: "question" }),
    event("campaign-parked", { ts: "t4", index: 0, reason: "question", detail: "6 parked" }),
    event("wave-start", { ts: "t5", index: 0, tasks: ["6", "7"] }),
    event("spawn", { ts: "t6", taskId: "6" }),
    event("spawn", { ts: "t7", taskId: "7" }),
    event("parked", { ts: "t8", taskId: "6", reason: "question" }),
    event("campaign-parked", { ts: "t9", index: 0, reason: "question", detail: "6 parked" }),
  ];
  const reduced = reduceCampaign(redriven, { alive: false });
  assert.deepEqual(issueLifecycle(reduced, "7"), { state: "running" });
  assert.deepEqual(issueLifecycle(reduced, "6"), { state: "parked", reason: "question" });
});

test("reduceCampaign: a campaign-parked reason question/conflict does not fold its wave to red-base — members keep their own reason (design §2.1, §2.3, #314)", () => {
  // The wave's reason is written on `campaign-parked`, not inferred (§2.1 rule 2). A
  // question/conflict park is NOT a red merged base, so the reducer must not stamp the
  // wave `red-base` — its members carry their own hold and the wave has no wave-level reason.
  const question = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["611", "612"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("parked", { ts: "t3", taskId: "612", reason: "question" }),
    event("campaign-parked", { ts: "t4", index: 0, reason: "question", detail: "612 parked" }),
  ]);
  assert.equal(question.redBase.size, 0, "a question park is not a red base");

  const conflict = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["611", "640"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["611", "640"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "t3", taskId: "640", branch: "agent/640", commits: [] }),
    event("parked", { ts: "t4", taskId: "640", reason: "conflict", detail: "CONFLICT" }),
    event("campaign-parked", { ts: "t5", index: 0, reason: "conflict", detail: "640 conflict" }),
  ]);
  assert.equal(conflict.redBase.size, 0, "a conflict park is not a red base");
  assert.deepEqual(issueLifecycle(conflict, "640"), { state: "parked", reason: "conflict" });

  // The explicit red-base reason still stamps the wave.
  const red = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["611", "612"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "t3", taskId: "612", branch: "agent/612", commits: [] }),
    event("campaign-parked", { ts: "t4", index: 0, reason: "red-base", detail: "GATE FAILED" }),
  ]);
  assert.deepEqual([...red.redBase].sort(), ["611", "612"], "an explicit red-base park stamps the wave");
});

test("reduceCampaign never adds a wave with a quarantined member to closedWaves; resumeIndex returns it (design §7, #314)", () => {
  // A conflict-parked green holds the wave — even were a wave-done ever logged over it, a
  // quarantined member means the wave is not resolved, so it stays out of closedWaves and a
  // redrive re-enters it (the resumeIndex boundary reads closedWaves).
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["611", "640"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["611", "640"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "t3", taskId: "640", branch: "agent/640", commits: [] }),
    event("merged", { ts: "t4", taskId: "611" }),
    event("parked", { ts: "t5", taskId: "640", reason: "conflict", detail: "CONFLICT" }),
    // A wave-done that names only the merged member must NOT close a wave still holding a quarantine.
    event("wave-done", { ts: "t6", index: 0, merged: ["611"] }),
  ]);
  assert.ok(!reduced.closedWaves.has(0), "a wave with a quarantined member is not closed");
});

test("reduceCampaign folds a campaign-failed stop marker to a failed, un-closed wave (#285)", () => {
  // The campaign-failed marker is authoritative: even with no error carried in queue-done,
  // it names the failed member and the fold reads it `failure`, so the wave holding it folds
  // to `failed` (failure outranks parked, ADR 0019). The wave is never logged done, so it is
  // not closed and the campaign cannot read complete.
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["101", "102"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["101", "102"] }),
    event("green", { ts: "t2", taskId: "101", branch: "agent/101", commits: [] }),
    // 101's green was integrated before the wave failed on 102, so it is banked on the base.
    event("merged", { ts: "t2b", taskId: "101", branch: "agent/101" }),
    // The per-task failure marks 102 `failure`; the campaign-failed marker is just the stop.
    event("failed", { ts: "t3", taskId: "102" }),
    event("campaign-failed", { ts: "t3", index: 0, detail: "#102 could not be made green" }),
  ]);

  assert.deepEqual(issueLifecycle(reduced, "101"), { state: "completed" });
  assert.deepEqual(issueLifecycle(reduced, "102"), { state: "failed" });

  // The failed wave is not closed — it holds, it does not read done.
  assert.ok(!reduced.closedWaves.has(0), "the wave holding the failure is not closed");

  // The wave folds to `failed`, and the campaign with it.
  const waveStatus = waveState(reduced.waves[0].map((id) => ({ status: issueLifecycle(reduced, id).state })));
  assert.equal(waveStatus, "failed");
  assert.equal(campaignState([waveStatus]), "failed");
});

test("reduceCampaign reconstructs a fresh campaign's waves with no wave running yet", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"], ["201"]],
      slots: 1,
    }),
  ]);

  assert.deepEqual(reduced.waves, [["101", "102"], ["201"]]);
  // Nothing has started: no wave is current and none is closed.
  assert.equal(reduced.currentWave, -1);
  assert.deepEqual([...reduced.closedWaves], []);
  // No queue-start/green/etc. yet, so no issue has a reconstructed outcome.
  assert.deepEqual([...reduced.outcomes.entries()], []);
});

test("reduceCampaign reads an optional campaign name off the campaign-start event", () => {
  // A named run carries its name on the start event; an unnamed one leaves it undefined.
  assert.equal(
    reduceCampaign([
      event("campaign-start", {
        ts: "2025-01-01T00:00:00.000Z",
        waves: [["101"]],
        slots: 1,
        name: "gateway work",
      }),
    ]).name,
    "gateway work",
  );
  assert.equal(
    reduceCampaign([
      event("campaign-start", {
        ts: "2025-01-01T00:00:00.000Z",
        waves: [["101"]],
        slots: 1,
      }),
    ]).name,
    undefined,
  );
  // The latest campaign-start wins, name and all.
  assert.equal(
    reduceCampaign([
      event("campaign-start", {
        ts: "2025-01-01T00:00:00.000Z",
        waves: [["1"]],
        slots: 1,
        name: "first",
      }),
      event("campaign-start", {
        ts: "2025-01-01T00:10:00.000Z",
        waves: [["101"]],
        slots: 1,
        name: "second",
      }),
    ]).name,
    "second",
  );
});

test("reduceCampaign derives the festive offset from the latest campaign-start ts (#193)", () => {
  // No presentation state is written to the log (design §2.1): the offset is derived by
  // hashing the campaign-start timestamp, not read off a stamped field.
  const ts1 = "2025-01-01T00:00:00.000Z";
  assert.equal(reduceCampaign([event("campaign-start", { ts: ts1, waves: [["101"]], slots: 1 })]).festiveOffset, festiveOffsetFor(ts1));
  // The latest campaign-start's ts wins, so a fresh run rederives its own offset.
  const ts2 = "2025-02-02T00:00:00.000Z";
  assert.equal(
    reduceCampaign([
      event("campaign-start", { ts: ts1, waves: [["1"]], slots: 1 }),
      event("campaign-start", { ts: ts2, waves: [["101"]], slots: 1 }),
    ]).festiveOffset,
    festiveOffsetFor(ts2),
  );
});

test("reduceCampaign reports one completed wave closed and the next wave current mid-campaign", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-start", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);

  assert.deepEqual(reduced.waves, [["101"], ["201"]]);
  // Wave 0 closed and banked its merged issue; wave 1 is now the running one.
  assert.deepEqual([...reduced.closedWaves], [0]);
  assert.equal(reduced.currentWave, 1);
  assert.equal(reduced.outcomes.get("101"), "completed");
});

test("reduceCampaign records when each issue merged, from wave-done and merged", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201", "202"]],
      slots: 1,
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("merged", { ts: "2025-01-02T09:00:00.000Z", taskId: "201", branch: "agent/201" }),
    event("merged", { ts: "2025-01-02T10:00:00.000Z", taskId: "202", branch: "agent/202" }),
    event("merged", { ts: "2025-01-02T10:00:00.000Z", taskId: "201", branch: "agent/201" }),
  ]);

  // A merge stamp is recorded from every path an issue reaches "completed" by — the wave
  // merge and a per-issue `merged` (design §2.2: only merged banks work) — so merged-today
  // can count them. 201's stamp keeps its first (09:00) merge, not the later duplicate.
  assert.equal(reduced.mergedAt.get("101"), "2025-01-01T00:02:00.000Z");
  assert.equal(reduced.mergedAt.get("201"), "2025-01-02T09:00:00.000Z");
  assert.equal(reduced.mergedAt.get("202"), "2025-01-02T10:00:00.000Z");
});

test("reduceCampaign derives failure from an issue that errored, not a campaign-level event (ADR 0019)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102"],
    }),
    event("failed", { ts: "2025-01-01T00:02:00.000Z", taskId: "101" }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "102", branch: "agent/102", commits: [] }),
  ]);

  // `failure` is the single red terminal — an issue the agent could not make green. 102 went
  // green but is not yet merged, so it reads `running` with a pending green (design §2.2).
  assert.equal(reduced.outcomes.get("101"), "failed");
  assert.equal(reduced.outcomes.get("102"), "running");
  assert.equal(reduced.pendingGreen.has("102"), true);
});

test("campaignRunning is true for a started campaign that has not finished", () => {
  assert.equal(
    campaignRunning([event("campaign-start", { waves: [["101"], ["201"]], slots: 1 }), event("wave-start", { index: 0, tasks: ["101"] })]),
    true,
  );
});

test("campaignRunning is false with no campaign, and once it completes", () => {
  assert.equal(campaignRunning([event("spawn", { taskId: "101" })]), false, "a run with no campaign-start is not a campaign");
  assert.equal(
    campaignRunning([event("campaign-start", { waves: [["101"]], slots: 1 }), event("campaign-done", { waves: 1 })]),
    false,
    "a completed campaign is not running",
  );
});

test("campaignRunning tracks the latest campaign only", () => {
  // An earlier campaign finished; a fresh one started after it is what counts.
  assert.equal(
    campaignRunning([
      event("campaign-start", { waves: [["1"]], slots: 1 }),
      event("campaign-done", { waves: 1 }),
      event("campaign-start", { waves: [["101"], ["201"]], slots: 1 }),
    ]),
    true,
  );
});

test("campaignSettled is true only when every member merged — the fold, not the campaign-done marker", () => {
  // A campaign whose every wave merged is settled even with no `campaign-done` on
  // the log (a crash right after the last merge): the fold decides, not the marker.
  assert.equal(
    campaignSettled([
      event("campaign-start", { waves: [["101"], ["201"]], slots: 1 }),
      event("wave-done", { index: 0, merged: ["101"] }),
      event("wave-done", { index: 1, merged: ["201"] }),
    ]),
    true,
    "every member merged → settled",
  );
});

test("campaignSettled is false for an unsettled campaign, whatever stopped it", () => {
  // Parked and stopped with no `campaign-done`: a held member is unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { waves: [["101"]], slots: 1 }),
      event("wave-start", { index: 0, tasks: ["101"] }),
      event("parked", { taskId: "101", reason: "question" }),
    ]),
    false,
    "parked-and-stopped is unsettled",
  );
  // Failed and stopped: a member that errored out holds the campaign unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { waves: [["101"]], slots: 1 }),
      event("wave-start", { index: 0, tasks: ["101"] }),
      event("failed", { taskId: "101" }),
    ]),
    false,
    "failed-and-stopped is unsettled",
  );
  // Still running: a member in flight is unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { waves: [["101"]], slots: 1 }),
      event("wave-start", { index: 0, tasks: ["101"] }),
      event("spawn", { taskId: "101" }),
    ]),
    false,
    "running is unsettled",
  );
  // No events at all: nothing folds to completed.
  assert.equal(campaignSettled([]), false, "an empty log is not settled");
});

test("reduceCampaign folds a prune event, pruning unfinished issues from future waves", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201", "202"], ["301"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-start", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201", "202"],
    }),
    event("spawn", { ts: "2025-01-01T00:03:30.000Z", taskId: "201" }),
    event("spawn", { ts: "2025-01-01T00:03:30.000Z", taskId: "202" }),
    // 202 pruned mid-wave: it is running, so it stays; its unstarted dependent 301 goes.
    event("prune", {
      ts: "2025-01-01T00:04:00.000Z",
      target: "202",
      removed: ["202", "301"],
      dropped: ["301"],
    }),
  ]);

  // 101 (merged) and 202 (in-flight) stay; only the future, unstarted 301 is pruned.
  assert.deepEqual(reduced.waves, [["101"], ["201", "202"]]);
  // The in-flight wave is still current; wave 0 is still closed at its original index.
  assert.deepEqual([...reduced.closedWaves], [0]);
  assert.equal(reduced.currentWave, 1);
});

test("reduceCampaign's prune fold clears an emptied future wave and reindexes", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"], ["301"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    // Between waves: 201 not yet started, so pruning it empties and drops its wave.
    event("prune", {
      ts: "2025-01-01T00:03:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: ["201"],
    }),
  ]);

  assert.deepEqual(reduced.waves, [["101"], ["301"]]);
  assert.deepEqual([...reduced.closedWaves], [0]);
});

test("reduceCampaign ignores an old archived `carve` event instead of crashing (#177)", () => {
  // Pre-rename archived runs logged the mutation as a `carve` event kind. The verb
  // is now `prune` and the reducer has no `carve` case, so an old log's `carve` reads
  // as an inert/unknown row — ignored, never throwing — leaving the plan whole. This
  // is the accepted consequence of hard-renaming with no read-time alias: a stale
  // `carve` simply does not prune, but it must not break the load either.
  const staleCarve = {
    ts: "2025-01-01T00:03:00.000Z",
    event: "carve",
    target: "201",
    removed: ["201", "301"],
    dropped: ["201", "301"],
  } as unknown as Parameters<typeof reduceCampaign>[0][number];

  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"], ["301"]],
      slots: 1,
    }),
    staleCarve,
  ]);

  // The stale carve did nothing: every planned wave survives and nothing reads pruned.
  assert.deepEqual(reduced.waves, [["101"], ["201"], ["301"]]);
  assert.deepEqual([...reduced.pruned], []);
});

test("reconstructIssueDetail folds an issue's turn log, count, elapsed and status from the log", () => {
  const detail = reconstructIssueDetail(
    [
      event("campaign-start", {
        ts: "2025-01-01T00:00:00.000Z",
        waves: [["101"], ["201"]],
        slots: 1,
        titles: { "101": "Do the thing" },
        name: "gateway work",
      }),
      event("wave-start", {
        ts: "2025-01-01T00:01:00.000Z",
        index: 0,
        tasks: ["101"],
      }),
      event("turn", {
        ts: "2025-01-01T00:02:00.000Z",
        taskId: "101",
        turn: 0,
        signal: undefined,
        summary: "Wrote a failing test for the parser.",
      }),
      event("turn", {
        ts: "2025-01-01T00:07:00.000Z",
        taskId: "101",
        turn: 1,
        signal: "done",
        summary: "Made it green and tidied up.",
      }),
      event("green", {
        ts: "2025-01-01T00:12:00.000Z",
        taskId: "101",
        branch: "agent/101",
        commits: ["abc123"],
      }),
    ],
    "101",
  );

  assert.equal(detail.issueNumber, "101");
  // The log ends at an unmerged green, so the sheet reads `running` with a pending green (§2.2).
  assert.equal(detail.status, "running");
  assert.equal(detail.title, "Do the thing");
  assert.equal(detail.campaignName, "gateway work");
  assert.equal(detail.turns, 2);
  // Working span: first turn (00:02) to the green (00:12) — the plan-only campaign-start is excluded.
  assert.equal(detail.elapsedMs, 10 * 60 * 1000);
  // Newest first, each carrying the agent's own summary verbatim (ADR 0009).
  assert.deepEqual(
    detail.turnLog.map((t) => [t.turn, t.summary]),
    [
      [1, "Made it green and tidied up."],
      [0, "Wrote a failing test for the parser."],
    ],
  );
  // No worktree-preserved event named this issue, so there is no worktree path.
  assert.equal(detail.worktree, undefined);
});

test("reconstructIssueDetail surfaces the preserved worktree path for a parked issue", () => {
  const detail = reconstructIssueDetail(
    [
      event("campaign-start", {
        ts: "2025-01-01T00:00:00.000Z",
        waves: [["102"]],
        slots: 1,
        name: "gateway work",
      }),
      event("wave-start", {
        ts: "2025-01-01T00:01:00.000Z",
        index: 0,
        tasks: ["102"],
      }),
      event("turn", {
        ts: "2025-01-01T00:02:00.000Z",
        taskId: "102",
        turn: 0,
        summary: "Asked which option to take.",
      }),
      event("parked", {
        ts: "2025-01-01T00:03:00.000Z",
        taskId: "102",
        reason: "question",
      }),
      event("worktree-preserved", {
        ts: "2025-01-01T00:03:01.000Z",
        taskId: "102",
        path: ".vetinari.local/wt/102",
      }),
    ],
    "102",
  );

  // The real per-task worktree the loop logged when it preserved the parked slot —
  // not a fabricated agent id (ADR/#55). Surfaced verbatim for the WORKTREE tile.
  assert.equal(detail.worktree, ".vetinari.local/wt/102");
});

test("issueLifecycle: an issue's own reason outranks the wave's red-base park; a completed member stays completed (#288)", () => {
  // A red-base wave-park is the wave's reason, not a rewrite of its members (design §2.3):
  // 611 merged clean (completed), 612 parked on a question inside the same red-base wave.
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", waves: [["611", "612"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("merged", { ts: "t2b", taskId: "611", branch: "agent/611" }),
    event("parked", { ts: "t3", taskId: "612", reason: "question" }),
    event("campaign-parked", { ts: "t4", index: 0, detail: "npm test failed" }),
  ]);
  // The merged member stays completed — the wave-park never rewrites it.
  assert.deepEqual(issueLifecycle(reduced, "611"), { state: "completed" });
  // The parked member keeps its own question reason, so the sheet still draws its reply box.
  assert.deepEqual(issueLifecycle(reduced, "612"), { state: "parked", reason: "question" });
});

test("reconstructIssueDetail carries a question member's own reason inside a red-base wave (reply box) (#288)", () => {
  // The issue sheet's reply affordance keys off the issue reason: a question held inside a
  // red-base wave must read reason `question`, not the wave's `red-base`, or it loses its reply.
  const events = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["611", "612"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("parked", { ts: "2025-01-01T00:03:00.000Z", taskId: "612", reason: "question" }),
    event("campaign-parked", { ts: "2025-01-01T00:04:00.000Z", index: 0, detail: "npm test failed" }),
  ];
  const detail = reconstructIssueDetail(events, "612");
  assert.equal(detail.status, "parked");
  assert.equal(detail.reason, "question");
});

test("reduceCampaign folds a graft event, extending future waves with the added issues (#166)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"]],
      slots: 1,
    }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    // Graft 301 (no deps) and 302 (blocked by 301) mid-wave-0. No tracker/filesystem
    // access — the reducer folds the inputs the event carries.
    event("graft", {
      ts: "2025-01-01T00:02:00.000Z",
      ids: ["301", "302"],
      blockedBy: { "302": ["301"] },
      fileKeys: {},
    }),
  ]);

  // The in-flight wave (0) is untouched; 301 lands in the earliest later wave (1)
  // and 302, blocked by 301, opens a new wave after it.
  assert.deepEqual(reduced.waves, [["101"], ["201", "301"], ["302"]]);
  // The grafted issues render as a chip in the wave they joined (layout carries them).
  assert.deepEqual(reduced.layout, [["101"], ["201", "301"], ["302"]]);
  // They are marked grafted (a transient render overlay) while still unstarted.
  assert.deepEqual([...reduced.grafted].sort(), ["301", "302"]);
});

test("reduceCampaign folds a graft event written before the rename, reading its layering input from the legacy `basenames` key (#394)", () => {
  // A graft event exactly as an `orchestrator.jsonl` already on disk carries it: the
  // layering input lives under the pre-rename `basenames` key, never `fileKeys`. The
  // reducer must still read it, so the file-disjoint placement replays. Here 301 shares
  // `shared.ts` with the still-unstarted 201, so it cannot join 201's wave and opens a
  // new one after it — a placement only reachable if the `basenames` value is honored.
  const oldShapeGraft = {
    ts: "2025-01-01T00:02:00.000Z",
    event: "graft",
    ids: ["301"],
    blockedBy: {},
    basenames: { "201": ["shared.ts"], "301": ["shared.ts"] },
  } as unknown as OrchestratorEvent;
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"], ["201"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    oldShapeGraft,
  ]);
  // 301 is bumped past 201's wave by the shared file — proving the legacy value folded.
  assert.deepEqual(reduced.waves, [["101"], ["201"], ["301"]]);
  assert.equal(reduced.grafted.has("301"), true);
});

test("reduceCampaign drops a graft's grafted overlay once the issue is picked up (#166)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, fileKeys: {} }),
    // 301 is picked up in the next wave and merges — it is no longer "grafted".
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "301", branch: "agent/301", commits: [] }),
    event("merged", { ts: "2025-01-01T00:04:00.000Z", taskId: "301", branch: "agent/301" }),
  ]);
  assert.equal(reduced.outcomes.get("301"), "completed");
  // The overlay is transient: it drops once the issue leaves the unstarted state.
  assert.equal(reduced.grafted.has("301"), false);
});

test("a graft into a wave-parked (resumable) campaign is folded and allowed (#166)", () => {
  const log = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"], ["201"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    // The wave's merged base gated red — the campaign pauses, resumable (ADR 0013).
    event("campaign-parked", { ts: "2025-01-01T00:03:00.000Z", index: 0, detail: "GATE FAILED" }),
    // An operator grafts new work while it is parked, honored on the next --resume.
    event("graft", { ts: "2025-01-01T00:04:00.000Z", ids: ["301"], blockedBy: {}, fileKeys: {} }),
  ];
  // A wave-parked run is not done, so graft is allowed against it.
  assert.equal(campaignRunning(log), true);
  const reduced = reduceCampaign(log);
  // 301 re-layers into a future wave; the parked wave 0 (101) is untouched.
  assert.ok(reduced.waves.flat().includes("301"));
  assert.deepEqual(reduced.waves[0], ["101"]);
  assert.equal(reduced.grafted.has("301"), true);
});

test("issuePhase derives a running issue's phase from its latest own event (design §11)", () => {
  // A spawned issue with no container up yet is `starting`, and pulses (work spinning up).
  const spawned = [
    event("campaign-start", { ts: "t0", waves: [["301"]], slots: 1 }),
    event("wave-start", { ts: "t1", index: 0, tasks: ["301"] }),
    event("spawn", { ts: "t2", taskId: "301", running: 1, left: 0 }),
  ];
  assert.deepEqual(issuePhase(spawned, "301"), { label: "starting", steady: false });

  // Container up (`sandbox`) → the agent is `coding`.
  const coding = [...spawned, noise({ event: "sandbox", ts: "t3", taskId: "301" })];
  assert.deepEqual(issuePhase(coding, "301"), { label: "coding", steady: false });

  // A finished turn keeps it `coding` until the gate opens.
  const turned = [...coding, event("turn", { ts: "t4", taskId: "301", turn: 0, summary: "did a thing" })];
  assert.deepEqual(issuePhase(turned, "301"), { label: "coding", steady: false });
});

test("issuePhase names the running gate command, advancing as the gate progresses (#332)", () => {
  const base = [
    event("campaign-start", { ts: "t0", waves: [["301"]], slots: 1 }),
    event("spawn", { ts: "t1", taskId: "301", running: 1, left: 0 }),
    event("turn", { ts: "t2", taskId: "301", turn: 0, summary: "s" }),
    event("gate", { ts: "t3", taskId: "301", cmds: ["go-unit", "rust"], skipped: 0 }),
  ];
  // Right after the gate opens, its first command is the one running.
  assert.deepEqual(issuePhase(base, "301"), { label: "testing · go-unit", steady: false });

  // go-unit passes → rust is now the command in flight.
  const second = [...base, event("gate-result", { ts: "t4", taskId: "301", cmd: "go-unit", exitCode: 0, seconds: 221, outFile: "f" })];
  assert.deepEqual(issuePhase(second, "301"), { label: "testing · rust", steady: false });

  // rust passes too → the whole gate is green, so the agent is back to coding (green imminent).
  const done = [...second, event("gate-result", { ts: "t5", taskId: "301", cmd: "rust", exitCode: 0, seconds: 54, outFile: "f" })];
  assert.deepEqual(issuePhase(done, "301"), { label: "coding", steady: false });

  // A red command ends the gate early — the agent resumes to fix it, so it reads coding.
  const red = [...base, event("gate-result", { ts: "t4", taskId: "301", cmd: "go-unit", exitCode: 1, seconds: 3, outFile: "f" })];
  assert.deepEqual(issuePhase(red, "301"), { label: "coding", steady: false });
});

test("issuePhase reads a green-but-unmerged issue as waiting to merge, with a steady dot (design §2.2, Appendix A)", () => {
  const green = [
    event("campaign-start", { ts: "t0", waves: [["301"]], slots: 1 }),
    event("spawn", { ts: "t1", taskId: "301", running: 1, left: 0 }),
    event("green", { ts: "t2", taskId: "301", branch: "agent/301", commits: ["abc"] }),
  ];
  // Green banks nothing on the base yet, so its slot is freed and nothing executes: steady.
  assert.deepEqual(issuePhase(green, "301"), { label: "waiting to merge", steady: true });

  // The post-green findings harvest is a real phase while it runs...
  const filing = [...green, noise({ event: "findings", ts: "t3", taskId: "301", count: 2 })];
  assert.deepEqual(issuePhase(filing, "301"), { label: "filing findings", steady: false });

  // ...and once every finding is filed the issue is back to waiting to merge, not stuck filing.
  const filed = [
    ...filing,
    noise({ event: "finding-filed", ts: "t4", taskId: "301", summary: "a", url: "u" }),
    noise({ event: "finding-filed", ts: "t5", taskId: "301", summary: "b", url: "u" }),
  ];
  assert.deepEqual(issuePhase(filed, "301"), { label: "waiting to merge", steady: true });

  // A merged issue is terminal (completed), never running — so it carries no phase.
  const merged = [...green, event("merged", { ts: "t6", taskId: "301", branch: "agent/301" })];
  assert.equal(issuePhase(merged, "301"), undefined);
});

test("issuePhase scopes to the latest campaign and ignores the wave-merge gate (no taskId)", () => {
  const events = [
    // A superseded earlier run for the same issue — must not leak into the latest campaign's phase.
    event("campaign-start", { ts: "a0", waves: [["301"]], slots: 1 }),
    event("spawn", { ts: "a1", taskId: "301", running: 1, left: 0 }),
    event("green", { ts: "a2", taskId: "301", branch: "agent/301", commits: [] }),
    // The latest campaign: 301 is only just spawned.
    event("campaign-start", { ts: "b0", waves: [["301"]], slots: 1 }),
    event("spawn", { ts: "b1", taskId: "301", running: 1, left: 0 }),
    // The wave-merge gate carries no taskId, so it never touches a member's phase.
    event("gate", { ts: "b2", cmds: ["base"], skipped: 0 }),
  ];
  assert.deepEqual(issuePhase(events, "301"), { label: "starting", steady: false });
});

test("reconstructIssueDetail carries a live running issue's phase for the sheet (#359)", () => {
  const events = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "101", running: 1, left: 0 }),
    event("turn", { ts: "2025-01-01T00:03:00.000Z", taskId: "101", turn: 0, summary: "s" }),
    event("gate", { ts: "2025-01-01T00:04:00.000Z", taskId: "101", cmds: ["npm-test"], skipped: 0 }),
  ];
  assert.deepEqual(reconstructIssueDetail(events, "101").phase, { label: "testing · npm-test", steady: false });

  // A completed (merged) issue is not running, so the sheet carries no phase.
  const merged = [
    ...events,
    event("green", { ts: "2025-01-01T00:05:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("merged", { ts: "2025-01-01T00:06:00.000Z", taskId: "101", branch: "agent/101" }),
  ];
  assert.equal(reconstructIssueDetail(merged, "101").phase, undefined);
});

test("issuePhase re-establishes a phase after a park is re-admitted (design §5 step 3)", () => {
  const events = [
    event("campaign-start", { ts: "t0", waves: [["301"]], slots: 1 }),
    event("spawn", { ts: "t1", taskId: "301", running: 1, left: 0 }),
    event("parked", { ts: "t2", taskId: "301", reason: "question" }),
    // The answer is delivered and the member re-spawns — its phase follows the re-admit,
    // never stuck on the cleared park.
    event("spawn", { ts: "t3", taskId: "301", running: 1, left: 0 }),
    event("turn", { ts: "t4", taskId: "301", turn: 1, summary: "s" }),
  ];
  assert.deepEqual(issuePhase(events, "301"), { label: "coding", steady: false });
});
