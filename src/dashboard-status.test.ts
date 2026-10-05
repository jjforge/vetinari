// Tests for the dashboard's status assembly — a project's campaign status (waves, chips,
// parked cards) off its log and parked records, and the per-project status config helpers
// (dashboard-status.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  archiveStatusConfig,
  buildAllStatus,
  buildStatus,
  buildStatusWithIssueNames,
  selectStatus,
  stopPending,
  type CampaignStatus,
} from "./dashboard-status.ts";
import { campaignSettled, campaignState, reduceCampaign } from "./dashboard-lifecycle.ts";
import { archivedRunState } from "./dashboard-archived-runs.ts";
import { event, type OrchestratorEvent } from "./event-log.ts";
import type { ProjectPointer } from "./registry.ts";
import { hostLogTarget, memoryLogger } from "./log.ts";

const cfgFor = (dir: string): ResolvedConfig =>
  ({
    project: "demo",
    image: "img",
    baseBranch: "main",
    branchPrefix: "agent/",
    gates: [{ cmd: "npm test" }],
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
    promptFile: "prompt.md",
    fetchTask: (id: string) => id,
  }) as ResolvedConfig;

const writeJsonl = (path: string, events: unknown[]) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const pointerFor = (project: string, dir: string): ProjectPointer => ({
  project,
  projectRoot: join(dir, "root"),
  baseLocation: dir,
});

const seedState = (dir: string, events: unknown[]) => {
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);
};

test("buildAllStatus builds one status per live project and skips a stale one", () => {
  const base = join(tmpdir(), `vetinari-all-status-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"]],
      slots: 1,
    }),
    event("green", { ts: "2025-01-01T00:01:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["201"]],
      slots: 1,
    }),
  ]);

  const statuses = buildAllStatus([
    pointerFor("alpha", alphaDir),
    pointerFor("beta", betaDir),
    // A stale registration whose base location was moved/deleted — must be skipped, not throw.
    pointerFor("ghost", join(base, "gone")),
  ]);

  assert.deepEqual(
    statuses.map((s) => s.project),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    statuses[0].waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      // 101 went green but no wave-done merged it yet — running with a pending green (§2.2).
      ["101", "running"],
      ["102", "unstarted"],
    ],
  );
  assert.deepEqual(
    statuses[1].waves[0].issues.map((i) => i.issueNumber),
    ["201"],
  );
});

test("buildAllStatus routes a stale-registration skip to the injected logger, not the process-global", () => {
  const base = join(tmpdir(), `vetinari-all-status-log-${Date.now()}`);
  const logger = memoryLogger();

  buildAllStatus([pointerFor("ghost", join(base, "gone"))], logger);

  // The skip diagnostic is captured by the host logger the reader was handed —
  // it no longer writes to the process-global event log.
  assert.deepEqual(
    logger.events.map((e) => [e.event, (e as { project?: string }).project]),
    [["status-project-skipped", "ghost"]],
  );
});

test("selectStatus picks the requested project, defaulting to the first otherwise", () => {
  const statuses: CampaignStatus[] = [
    { project: "alpha", waves: [], parked: [] },
    { project: "beta", waves: [], parked: [] },
  ];

  assert.equal(selectStatus(statuses, "beta").project, "beta");
  assert.equal(selectStatus(statuses, undefined).project, "alpha");
  // An unknown or stale selection falls back to the first, never undefined.
  assert.equal(selectStatus(statuses, "ghost").project, "alpha");
});

test("buildStatus shows campaign waves with issue chips and statuses", () => {
  const dir = join(tmpdir(), `vetinari-status-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"], ["201"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102"],
    }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("parked", { ts: "2025-01-01T00:02:00.000Z", taskId: "102", reason: "question" }),
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({
      taskId: "102",
      parkedAt: "now",
      reason: "question",
      branch: "agent/102",
      sessionId: "s",
      question: "Need a choice.\n\nOptions:\n- A: do the simple thing\n- B: do the robust thing",
    }),
  );

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.project, "demo");
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status])),
    [
      [
        // 101 went green but is not yet merged onto the base — running with a pending green (§2.2).
        ["101", "running"],
        ["102", "parked"],
      ],
      [["201", "unstarted"]],
    ],
  );
  assert.equal(status.parked[0].issueNumber, "102");
  assert.deepEqual(status.parked[0].options, ["A: do the simple thing", "B: do the robust thing"]);
});

test("buildStatus marks a display wave `closed` only once it actually closed, not when its members merge (#362)", () => {
  // The `closed` flag carries the reducer's `closedWaves` membership — set by `wave-done`,
  // never by a member's `merged` — so a wave reads `completed` (the fold) while `closed` still
  // lags until its gates ran. The renderer keys the collapse-into-a-chip affordance on `closed`.
  const dir = join(tmpdir(), `vetinari-wave-closed-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["854"]], slots: 1 }),
    event("wave-start", { ts: "2026-09-02T04:10:00.000Z", index: 0, tasks: ["854"] }),
    event("green", { ts: "2026-09-02T04:15:00.000Z", taskId: "854", branch: "agent/854", commits: [] }),
    event("merged", { ts: "2026-09-02T04:16:55.000Z", taskId: "854" }),
  ]);
  const merged = buildStatus(cfgFor(dir));
  // Every member merged → the fold reads `completed`, but no `wave-done` → not yet closed.
  assert.equal(merged.waves[0].status, "completed");
  assert.equal(merged.waves[0].closed, false);

  // Add the `wave-done` its gates produce → the wave has actually closed.
  seedState(dir, [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["854"]], slots: 1 }),
    event("wave-start", { ts: "2026-09-02T04:10:00.000Z", index: 0, tasks: ["854"] }),
    event("green", { ts: "2026-09-02T04:15:00.000Z", taskId: "854", branch: "agent/854", commits: [] }),
    event("merged", { ts: "2026-09-02T04:16:55.000Z", taskId: "854" }),
    event("wave-done", { ts: "2026-09-02T04:20:03.000Z", index: 0, merged: ["854"] }),
  ]);
  const closed = buildStatus(cfgFor(dir));
  assert.equal(closed.waves[0].status, "completed");
  assert.equal(closed.waves[0].closed, true);
});

test("buildStatus marks a wave `closed` when its surviving member merged, even though a member was pruned (#363)", () => {
  // A pruned member's chip stays in the wave it left (ADR 0007), but it left the loop-facing
  // plan and never appears in `closedWaves` — so the `closed` fold must skip it, exactly as
  // `waveState` does, or a wave that genuinely closed never collapses into its chip.
  const dir = join(tmpdir(), `vetinari-wave-closed-pruned-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["854", "999"]], slots: 1 }),
    event("wave-start", { ts: "2026-09-02T04:10:00.000Z", index: 0, tasks: ["854", "999"] }),
    event("parked", { ts: "2026-09-02T04:12:00.000Z", taskId: "999", reason: "question" }),
    event("prune", { ts: "2026-09-02T04:13:00.000Z", target: "999", removed: ["999"], dropped: [] }),
    event("green", { ts: "2026-09-02T04:15:00.000Z", taskId: "854", branch: "agent/854", commits: [] }),
    event("merged", { ts: "2026-09-02T04:16:55.000Z", taskId: "854" }),
    event("wave-done", { ts: "2026-09-02T04:20:03.000Z", index: 0, merged: ["854"] }),
  ]);
  const status = buildStatus(cfgFor(dir));
  // The surviving member merged and the wave's `wave-done` landed — the wave closed.
  assert.equal(status.waves[0].status, "completed");
  assert.equal(status.waves[0].closed, true);
  // The pruned chip still renders in the wave it left (ADR 0007) — only the fold changed.
  const chip = status.waves[0].issues.find((i) => i.issueNumber === "999");
  assert.equal(chip?.membership, "pruned");
});

test("buildStatus survives an unparseable parked record and still shows the valid park beside it", () => {
  // A writer killed mid-write leaves a torn record under `parked/`; it must not take the
  // project's dashboard down. `buildStatus` takes no logger, so the lister falls back to the
  // host logger — point the gateway home at a temp dir so nothing reaches the real host log.
  const dir = join(tmpdir(), `vetinari-status-torn-parked-${Date.now()}`);
  const prev = process.env.VETINARI_GATEWAY_HOME;
  process.env.VETINARI_GATEWAY_HOME = join(dir, "gw-home");
  try {
    seedState(dir, [
      event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["701"]], slots: 1 }),
      event("wave-start", { ts: "2026-09-02T04:10:00.000Z", index: 0, tasks: ["701"] }),
    ]);
    writeFileSync(
      join(dir, "parked", "701.json"),
      JSON.stringify({ taskId: "701", parkedAt: "2026-09-02T04:12:00.000Z", reason: "question", branch: "agent/701", question: "Which?" }),
    );
    writeFileSync(join(dir, "parked", "bad.json"), '{ "taskId": "7');

    const status = buildStatus(cfgFor(dir));

    assert.deepEqual(
      status.parked.map((p) => p.issueNumber),
      ["701"],
    );
    assert.ok(readFileSync(hostLogTarget(), "utf8").includes('"event":"parked-record-unreadable"'));
  } finally {
    prev === undefined ? delete process.env.VETINARI_GATEWAY_HOME : (process.env.VETINARI_GATEWAY_HOME = prev);
  }
});

test("buildStatus collapses a wave that had a member pruned and a member grafted once its wave-done lands (#363)", () => {
  // A grafted id lands in both `waves` and `layout`, so it satisfies the `closed` fold like a
  // plain member; a pruned id lands only in `layout` and is skipped. The two overlays must not
  // interfere — a wave carrying one of each still collapses when its surviving members close.
  const dir = join(tmpdir(), `vetinari-wave-closed-graft-prune-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["101"], ["201", "301"]], slots: 1 }),
    event("wave-start", { ts: "2026-09-02T04:01:00.000Z", index: 0, tasks: ["101"] }),
    // 401 grafts in while wave 0 is in flight → lands in the next unstarted wave (wave 1).
    event("graft", { ts: "2026-09-02T04:02:00.000Z", ids: ["401"], blockedBy: {}, fileKeys: {} }),
    // 301 is pruned out of wave 1 but keeps its chip there (ADR 0007).
    event("prune", { ts: "2026-09-02T04:03:00.000Z", target: "301", removed: ["301"], dropped: [] }),
    event("green", { ts: "2026-09-02T04:04:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("merged", { ts: "2026-09-02T04:05:00.000Z", taskId: "101" }),
    event("wave-done", { ts: "2026-09-02T04:06:00.000Z", index: 0, merged: ["101"] }),
    event("wave-start", { ts: "2026-09-02T04:07:00.000Z", index: 1, tasks: ["201", "401"] }),
    event("green", { ts: "2026-09-02T04:08:00.000Z", taskId: "201", branch: "agent/201", commits: [] }),
    event("merged", { ts: "2026-09-02T04:09:00.000Z", taskId: "201" }),
    event("green", { ts: "2026-09-02T04:10:00.000Z", taskId: "401", branch: "agent/401", commits: [] }),
    event("merged", { ts: "2026-09-02T04:11:00.000Z", taskId: "401" }),
    event("wave-done", { ts: "2026-09-02T04:12:00.000Z", index: 1, merged: ["201", "401"] }),
  ]);
  const status = buildStatus(cfgFor(dir));
  // The grafted 401 landed in wave 1 alongside 201; 301's pruned chip stays but is skipped.
  const wave = status.waves.find((w) => w.issues.some((i) => i.issueNumber === "401"));
  assert.ok(wave, "the grafted member should land in a display wave");
  assert.ok(
    wave!.issues.some((i) => i.issueNumber === "301" && i.membership === "pruned"),
    "the pruned chip stays",
  );
  assert.equal(wave!.status, "completed");
  assert.equal(wave!.closed, true);
});

test("buildStatus never reads a wholly-pruned display wave as `closed` (#363)", () => {
  // A wave every member of which was pruned is a display ghost — its `live` set is empty, so the
  // `live.length > 0` guard holds exactly as `waveState`'s does and it never reads `closed`.
  const dir = join(tmpdir(), `vetinari-wave-closed-all-pruned-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["101"], ["301"]], slots: 1 }),
    event("wave-start", { ts: "2026-09-02T04:01:00.000Z", index: 0, tasks: ["101"] }),
    event("prune", { ts: "2026-09-02T04:02:00.000Z", target: "301", removed: ["301"], dropped: [] }),
    event("green", { ts: "2026-09-02T04:03:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("merged", { ts: "2026-09-02T04:04:00.000Z", taskId: "101" }),
    event("wave-done", { ts: "2026-09-02T04:05:00.000Z", index: 0, merged: ["101"] }),
  ]);
  const status = buildStatus(cfgFor(dir));
  const ghost = status.waves.find((w) => w.issues.every((i) => i.membership === "pruned"));
  assert.ok(ghost, "the wholly-pruned wave still renders as a ghost");
  assert.notEqual(ghost!.closed, true);
});

test("buildStatus surfaces the campaign name from the start event", () => {
  const dir = join(tmpdir(), `vetinari-status-name-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      name: "gateway work",
      slots: 1,
    }),
  ]);

  assert.equal(buildStatus(cfgFor(dir)).name, "gateway work");
});

test("buildStatus fills issue names from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `vetinari-status-log-titles-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"]],
      titles: { "101": "Add login flow", "102": "Rotate logs" },
      slots: 1,
    }),
  ]);

  // cfgFor's fetchTask echoes the id — so a name here can only have come from the
  // log, never a live lookup (the dumb-router dashboard has no real fetchTask).
  const status = buildStatus(cfgFor(dir));

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, "Rotate logs");
});

test("buildStatus fills issue names from a single-wave run's campaign-start titles", () => {
  const dir = join(tmpdir(), `vetinari-status-queue-titles-${Date.now()}`);
  seedState(dir, [
    // A single-wave run frames its tasks as one wave and carries their titles on campaign-start.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["301", "302"]],
      slots: 2,
      titles: { "301": "Fix parser", "302": "Tune cache" },
    }),
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.waves[0].issues[0].name, "Fix parser");
  assert.equal(status.waves[0].issues[1].name, "Tune cache");
});

test("buildStatus leaves issue names unset when the log carries no titles", () => {
  const dir = join(tmpdir(), `vetinari-status-no-titles-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
      slots: 1,
    }),
  ]);

  assert.equal(buildStatus(cfgFor(dir)).waves[0].issues[0].name, undefined);
});

test("buildStatus marks completed waves as closed", () => {
  const dir = join(tmpdir(), `vetinari-status-closed-wave-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
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

  const status = buildStatus(cfgFor(dir));

  // The wave status is now a pure fold of its members' lifecycles (ADR 0019): wave 0's
  // single merged issue → `closed`. Wave 1's batch was announced but no member has spawned
  // (no queue-start), so it folds to `unstarted` — a wave is `running` only once a member is.
  assert.deepEqual(
    status.waves.map((w) => [w.index, w.status]),
    [
      [0, "completed"],
      [1, "unstarted"],
    ],
  );
});

test("buildStatus renders a pruned issue as a pruned chip in the wave it left", () => {
  const dir = join(tmpdir(), `vetinari-status-pruned-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"], ["201"]],
      titles: { "101": "seed the db", "201": "add the report" },
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
    // 201 is a future, unstarted wave: pruning it drops it from the running plan…
    event("prune", {
      ts: "2025-01-01T00:03:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: [],
    }),
  ]);

  const status = buildStatus(cfgFor(dir));

  // …but it still renders as a chip in the wave it left (ADR 0007), carrying the
  // orthogonal `pruned` membership badge while its lifecycle stays its own (`unstarted`) —
  // the two axes compose, no lifecycle "pruned" word (ADR 0019).
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status, i.membership])),
    [[["101", "completed", "member"]], [["201", "unstarted", "pruned"]]],
  );
  // The pruned issue keeps its title on the chip.
  assert.equal(status.waves[1].issues[0].name, "add the report");
});

test("buildStatus marks active wave issues as running before they finish", () => {
  const dir = join(tmpdir(), `vetinari-status-running-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
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
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "101" }),
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "102" }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      // Mid-wave, 101's green is not yet integrated (merges land at the wave boundary), so it
      // reads running with a pending green — not completed — just like the still-in-flight 102.
      ["101", "running"],
      ["102", "running"],
    ],
  );
});

test("buildStatus folds a red-base wave-park to a parked wave whose completed members stay completed (#288)", () => {
  const dir = join(tmpdir(), `vetinari-status-wave-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // Both greens merged, but the combined base gated red: the wave wave-parks with no
  // batch-done to close it (ADR 0013). Red-base is the wave's reason (design §2.3), not a
  // rewrite of its members — so the members stay `completed` and the wave folds to `parked`
  // carrying reason `red-base`; wave 1 (unstarted) still reads as itself.
  const events = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["611", "612"], ["701"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "612", branch: "agent/612", commits: [] }),
    event("merged", { ts: "2025-01-01T00:03:30.000Z", taskId: "611", branch: "agent/611" }),
    event("merged", { ts: "2025-01-01T00:03:40.000Z", taskId: "612", branch: "agent/612" }),
    event("campaign-parked", { ts: "2025-01-01T00:04:00.000Z", index: 0, detail: "npm test failed" }),
  ];
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);

  const status = buildStatus(cfgFor(dir));
  assert.deepEqual(
    status.waves.map((w) => w.status),
    ["parked", "unstarted"],
  );
  // The wave carries the red-base reason; wave 1 has no reason.
  assert.equal(status.waves[0].reason, "red-base");
  assert.equal(status.waves[1].reason, undefined);
  // Each member stays completed — the wave-park never rewrites it.
  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status, i.reason]),
    [
      ["611", "completed", undefined],
      ["612", "completed", undefined],
    ],
  );

  // The same reducer drives an archived run's read (buildStatus at the archive file),
  // so a wave-parked wave renders identically there.
  const archive = join(dir, "logs", "archive", "orchestrator-2025-01-01T00-04-00-000Z.jsonl");
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(archive, events);
  const archived = buildStatus(archiveStatusConfig("demo", archive));
  assert.equal(archived.waves[0].status, "parked");
  assert.equal(archived.waves[0].reason, "red-base");
});

test("buildStatus renders a merge-conflict-quarantined issue as parked with reason conflict (ADR 0019)", () => {
  const dir = join(tmpdir(), `vetinari-status-quarantined-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // 640 passed its own gate (green) but hit a merge conflict on integration and was
  // quarantined; 611 merged clean. The batch closes with 640 held out of `merged`.
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["611", "640"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "640"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "640", branch: "agent/640", commits: [] }),
    event("parked", { ts: "2025-01-01T00:04:00.000Z", taskId: "640", reason: "conflict", detail: "CONFLICT" }),
    event("wave-done", { ts: "2025-01-01T00:05:00.000Z", index: 0, merged: ["611"] }),
  ]);

  const status = buildStatus(cfgFor(dir));

  // The conflict hold wins over 640's green outcome: it reads parked(conflict), a plain
  // `member` on the other axis; 611 stays completed.
  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status, i.reason]),
    [
      ["611", "completed", undefined],
      ["640", "parked", "conflict"],
    ],
  );
  // Its detail names the human's next move.
  assert.equal(status.waves[0].issues.find((i) => i.issueNumber === "640")?.detail, "Parked on a merge conflict — resolve the conflict");
});

test("buildStatus clears the quarantine once the issue merges on resume", () => {
  const dir = join(tmpdir(), `vetinari-status-quarantine-cleared-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // 640 was quarantined, then a resumed batch merged it clean: it reads completed, not quarantined.
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["640"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["640"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "640", branch: "agent/640", commits: [] }),
    event("parked", { ts: "2025-01-01T00:03:00.000Z", taskId: "640", reason: "conflict", detail: "CONFLICT" }),
    event("wave-done", { ts: "2025-01-01T00:04:00.000Z", index: 0, merged: ["640"] }),
  ]);

  assert.equal(buildStatus(cfgFor(dir)).waves[0].issues[0].status, "completed");
});

test("buildStatus does not show parked interaction cards for closed wave issues", () => {
  const dir = join(tmpdir(), `vetinari-status-closed-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
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
      merged: [],
    }),
    event("wave-start", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);
  for (const taskId of ["101", "201"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({
        taskId,
        parkedAt: "now",
        reason: "question",
        branch: `agent/${taskId}`,
        sessionId: "s",
        question: "Need a choice.",
      }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.parked.map((p) => p.issueNumber),
    ["201"],
  );
});

test("buildStatus keeps a merged member of an open wave completed and out of parked despite a surviving record (#465)", () => {
  const dir = join(tmpdir(), `vetinari-status-merged-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101", "102"]], slots: 2 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("spawn", { ts: "2025-01-01T00:01:30.000Z", taskId: "101" }),
    event("spawn", { ts: "2025-01-01T00:01:40.000Z", taskId: "102" }),
    event("merged", { ts: "2025-01-01T00:03:00.000Z", taskId: "101" }),
  ]);
  writeFileSync(
    join(dir, "parked", "101.json"),
    JSON.stringify({ taskId: "101", parkedAt: "now", reason: "conflict", branch: "agent/101", question: "Conflict" }),
  );

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.waves[0].issues.find((i) => i.issueNumber === "101")?.status, "completed");
  assert.deepEqual(status.parked, []);
});

test("buildStatus only shows parked cards for issues in the active campaign", () => {
  const dir = join(tmpdir(), `vetinari-status-filter-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["243"]],
      slots: 1,
    }),
  ]);
  for (const taskId of ["243", "999"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({
        taskId,
        parkedAt: "now",
        reason: "question",
        branch: `agent/${taskId}`,
        sessionId: "s",
        question: "Need a choice.",
      }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.parked.map((p) => p.issueNumber),
    ["243"],
  );
});

test("buildStatus adds rough activity details for issue hover", () => {
  const dir = join(tmpdir(), `vetinari-status-activity-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102", "103"]],
      slots: 1,
    }),
    event("spawn", { ts: "2025-01-01T00:01:00.000Z", taskId: "102" }),
    event("spawn", { ts: "2025-01-01T00:01:00.000Z", taskId: "103" }),
    event("spawn", {
      ts: "2025-01-01T00:02:00.000Z",
      taskId: "101",
      running: 1,
      left: 2,
    }),
    event("turn", {
      ts: "2025-01-01T00:03:00.000Z",
      taskId: "101",
      turn: 2,
      signal: "<promise>COMPLETE</promise>",
      summary: "",
    }),
    event("green", {
      ts: "2025-01-01T00:04:00.000Z",
      taskId: "102",
      branch: "agent/102",
      commits: [],
    }),
    event("parked", {
      ts: "2025-01-01T00:05:00.000Z",
      taskId: "103",
      reason: "question",
    }),
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.detail]),
    [
      ["101", "Agent turn 2 finished; waiting for verification/redrive"],
      // A green banks nothing yet — the chip detail says so, distinct from a merged "completed".
      ["102", "Green on agent/102 — pending merge onto the base"],
      ["103", "Parked: question"],
    ],
  );
});

test("buildStatusWithIssueNames adds issue names from fetchTask when available", async () => {
  const dir = join(tmpdir(), `vetinari-status-issue-names-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"]],
      slots: 1,
    }),
  ]);

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    fetchTask: async (id: string) => (id === "101" ? JSON.stringify({ title: "Add login flow" }) : "no structured title"),
  });

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, undefined);
});

test("a dead (archived) run folds its in-flight `running` to parked{crash}, while a live read stays running (#152, design §7)", () => {
  // The issue's self-contained reproducer: a campaign that logged its first wave's
  // spawn and then stopped — no campaign-done / queue-done.
  const events = [
    event("campaign-start", { ts: "2026-08-26T23:27:59.174Z", waves: [["101"], ["202"]], slots: 8, name: "crashed run" }),
    event("wave-start", { ts: "2026-08-26T23:28:00.000Z", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "2026-08-26T23:28:01.000Z", taskId: "101" }),
    event("spawn", { ts: "2026-08-26T23:28:02.000Z", taskId: "101", running: 1, left: 0 }),
  ];
  // The live-log path is unchanged: an in-flight issue with no terminal event reduces
  // to `running`, exactly as today (no regression).
  assert.equal(reduceCampaign(events).outcomes.get("101"), "running");

  const dir = join(tmpdir(), `vetinari-status-152-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archive = join(archiveDir, "orchestrator-2026-08-26T23-27-59-684Z.jsonl");
  writeJsonl(archive, events);
  const cfg = archiveStatusConfig("demo", archive);

  // A live read of the same archived log still derives running (the reducer only crash-folds
  // on a dead read).
  assert.equal(buildStatus(cfg).waves[0].issues[0].status, "running");

  // The dead read: the log has no terminal event and the process is gone, so the reducer folds
  // the in-flight issue/wave to `parked{crash}` — an archived run must carry no live status.
  assert.equal(archivedRunState(events), "stalled");
  const status = buildStatus(cfg, { dead: true });
  const statuses = status.waves.flatMap((w) => [w.status as string, ...w.issues.map((i) => i.status as string)]);
  assert.ok(!statuses.includes("running"), `an archived run must show no live status; got ${statuses.join(", ")}`);
  assert.equal(status.waves[0].status, "parked");
  assert.deepEqual([status.waves[0].issues[0].status, status.waves[0].issues[0].reason], ["parked", "crash"]);
  // The never-reached second wave stays honestly unstarted — that is not a live status.
  assert.equal(status.waves[1].status, "unstarted");
  assert.equal(status.waves[1].issues[0].status, "unstarted");
});

test("buildStatus renders a grafted issue with the `grafted` membership while unstarted, then a plain member on pickup (#166, ADR 0019)", () => {
  const dir = join(tmpdir(), `vetinari-status-graft-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"], ["201"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, fileKeys: {} }),
  ]);

  const status = buildStatus(cfgFor(dir));
  // 301 joined wave 1 (index 1): its lifecycle is `unstarted` (waiting), and it carries the
  // `grafted` badge on the orthogonal membership axis while it waits there.
  const graftedChip = status.waves.flatMap((w) => w.issues).find((i) => i.issueNumber === "301");
  assert.equal(graftedChip?.status, "unstarted");
  assert.equal(graftedChip?.membership, "grafted");
});

test("buildStatus reads a grafted issue as running once its wave picks it up (#166)", () => {
  const dir = join(tmpdir(), `vetinari-status-graft-run-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, fileKeys: {} }),
    event("wave-start", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["301"] }),
    event("spawn", { ts: "2025-01-01T00:04:00.000Z", taskId: "301" }),
  ]);

  const status = buildStatus(cfgFor(dir));
  const chip = status.waves.flatMap((w) => w.issues).find((i) => i.issueNumber === "301");
  // On pickup the transient `grafted` overlay drops — it now reads its live status.
  assert.equal(chip?.status, "running");
});

test("buildStatus attaches a live running issue's phase, and an archived run carries none (#359)", () => {
  const dir = join(tmpdir(), `vetinari-status-phase-${Date.now()}`);
  const events = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["301", "302"]], slots: 2 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["301", "302"] }),
    // 301 is mid-gate; 302 went green and is waiting to merge (its wave has not drained).
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "301", running: 2, left: 0 }),
    event("spawn", { ts: "2025-01-01T00:02:01.000Z", taskId: "302", running: 2, left: 0 }),
    event("turn", { ts: "2025-01-01T00:03:00.000Z", taskId: "301", turn: 0, summary: "s" }),
    event("gate", { ts: "2025-01-01T00:04:00.000Z", taskId: "301", cmds: ["go-unit", "rust"], skipped: 0 }),
    event("green", { ts: "2025-01-01T00:05:00.000Z", taskId: "302", branch: "agent/302", commits: [] }),
  ];
  seedState(dir, events);

  const status = buildStatus(cfgFor(dir));
  const [mid, green] = status.waves[0].issues;
  assert.deepEqual(mid.phase, { label: "testing · go-unit", steady: false });
  assert.deepEqual(green.phase, { label: "waiting to merge", steady: true });

  // An archived (dead) read renders no phases (design settled: every issue's last event is
  // terminal or its work is banked, and phase is running-only for a live grid).
  const archive = join(dir, "logs", "archive", "orchestrator-2025-01-01T00-06-00-000Z.jsonl");
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(archive, events);
  const archived = buildStatus(archiveStatusConfig("demo", archive), { dead: true });
  for (const issue of archived.waves[0].issues) assert.equal(issue.phase, undefined);
});

test("buildStatus folds a campaign stopped between waves to parked{stopped} on the next wave — not idle, not crashed (#403)", () => {
  const dir = join(tmpdir(), `vetinari-status-stopped-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // Wave 0 closed; a graceful stop parked the campaign before wave 1 started.
  const events = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["611"], ["701"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("merged", { ts: "2025-01-01T00:03:00.000Z", taskId: "611", branch: "agent/611" }),
    event("stop-requested", { ts: "2025-01-01T00:03:10.000Z", index: 0 }),
    event("wave-done", { ts: "2025-01-01T00:03:30.000Z", index: 0, merged: ["611"] }),
    event("campaign-parked", { ts: "2025-01-01T00:04:00.000Z", index: 1, reason: "stopped", detail: "stopped by an operator" }),
  ];
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);

  for (const status of [buildStatus(cfgFor(dir)), buildStatus(cfgFor(dir), { alive: false })]) {
    assert.deepEqual(
      status.waves.map((w) => [w.status, w.reason]),
      [
        ["completed", undefined],
        ["parked", "stopped"],
      ],
    );
    assert.equal(campaignState(status.waves.map((w) => w.status)), "parked");
    // No crash fold: the unstarted member stays unstarted under a dead probe.
    assert.equal(status.waves[1].issues[0].status, "unstarted");
  }
  assert.equal(campaignSettled(events as OrchestratorEvent[]), false);

  // The redrive's wave-start for wave 1 clears the hold.
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    ...events,
    event("wave-start", { ts: "2025-01-01T00:05:00.000Z", index: 1, tasks: ["701"] }),
  ]);
  const resumed = buildStatus(cfgFor(dir));
  assert.equal(resumed.waves[1].status, "unstarted");
  assert.equal(resumed.waves[1].reason, undefined);
});

test("stopPending reads a stop-requested after the latest campaign-start with no stop marker after it as pending (#432)", () => {
  const start = event("campaign-start", { waves: [["201"], ["202"]], slots: 1 });
  const wave = event("wave-start", { index: 0, tasks: ["201"] });
  const request = event("stop-requested", { index: 0 });
  assert.equal(stopPending([start, wave, request]), true);
  // A stop marker after the request settles it — the campaign took the stop (or ended anyway).
  assert.equal(stopPending([start, wave, request, event("campaign-parked", { index: 1, reason: "stopped" })]), false);
  assert.equal(stopPending([start, wave, request, event("campaign-failed", { index: 0 })]), false);
  assert.equal(stopPending([start, wave, request, event("campaign-done", { waves: 2 })]), false);
  // A request that belongs to an earlier campaign is not this campaign's stop.
  assert.equal(stopPending([start, wave, request, event("campaign-parked", { reason: "stopped" }), start, wave]), false);
  assert.equal(stopPending([request, start, wave]), false);
  // No request at all is not pending.
  assert.equal(stopPending([start, wave]), false);
});

test("stopPending drops a stale stop-requested from a campaign that died once a redrive logs a wave-start (#463)", () => {
  const start = event("campaign-start", { waves: [["201"], ["202"]], slots: 1 });
  const wave = event("wave-start", { index: 0, tasks: ["201"] });
  const spawn = event("spawn", { taskId: "201", running: 1, left: 1 });
  const request = event("stop-requested", { index: 0 });
  // The campaign took the request and died with no stop marker; a redrive is a new process.
  const stale = [start, wave, spawn, request, wave, spawn];
  assert.equal(stopPending(stale), false);
  assert.equal(
    stopPending([
      ...stale,
      event("wave-done", { index: 0, merged: ["201"] }),
      event("redrive", { fromWave: 0 }),
      event("wave-start", { index: 1, tasks: ["202"] }),
    ]),
    false,
  );
  // A request on the redriven run is that run's stop.
  assert.equal(stopPending([start, wave, request, wave, request]), true);
});

test("buildStatus carries the stop pending flag off the event log (#432)", () => {
  const dir = join(tmpdir(), `vetinari-stop-pending-${Date.now()}`);
  const start = event("campaign-start", { waves: [["201"]], slots: 1 });
  const wave = event("wave-start", { index: 0, tasks: ["201"] });
  seedState(dir, [start, wave]);
  assert.equal(buildStatus(cfgFor(dir)).stopPending, false);
  seedState(dir, [start, wave, event("stop-requested", { index: 0 })]);
  assert.equal(buildStatus(cfgFor(dir)).stopPending, true);
});
