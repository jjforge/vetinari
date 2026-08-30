// Tests for the dashboard data model — the build*/reduce* reconstructors and the
// pure data helpers they compose (dashboard-model.ts, reached via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { appendedEvents, archiveStatusConfig, archivedRunState, buildAllStatus, buildFeed, buildLanding, buildStatus, buildStatusWithIssueNames, campaignRunning, campaignSettled, campaignState, cardState, describeEvent, event, extractParkedDetails, formatFeedEvent, issueLifecycle, issueMembership, issueStateFromTask, lastEventText, listArchivedRuns, ownerRepoFromRemote, parkedReplyFor, parsePruneClosure, parseRunTimestamp, reconstructIssueDetail, reduceCampaign, festiveFromCookie, viewRelevantEvents, waveLabel, waveState, selectStatus, summarizeRun, type CampaignStatus, type OrchestratorEvent } from "./status.ts";
import type { ProjectPointer } from "./registry.ts";
import { memoryLogger } from "./log.ts";

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

const writeJsonl = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

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

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

test("ownerRepoFromRemote parses SSH and HTTPS GitHub remotes to owner/name, and rejects garbage", () => {
  // SSH form, with the .git suffix stripped.
  assert.equal(
    ownerRepoFromRemote("git@github.com:jjforge/vetinari.git"),
    "jjforge/vetinari",
  );
  // HTTPS form, with and without the .git suffix.
  assert.equal(
    ownerRepoFromRemote("https://github.com/jjforge/vetinari.git"),
    "jjforge/vetinari",
  );
  assert.equal(
    ownerRepoFromRemote("https://github.com/acme/tidepool"),
    "acme/tidepool",
  );
  // Trailing whitespace (as `git remote get-url` prints a newline) and a trailing slash.
  assert.equal(
    ownerRepoFromRemote("https://github.com/acme/tidepool/\n"),
    "acme/tidepool",
  );
  // Garbage — not a recognizable remote — is undefined so the caller falls back to the bare key.
  assert.equal(ownerRepoFromRemote("not-a-remote"), undefined);
  assert.equal(ownerRepoFromRemote(""), undefined);
});

test("buildLanding's card carries owner/name from the project's git remote, and omits it when there is none", () => {
  const base = join(tmpdir(), `vetinari-landing-repo-${Date.now()}`);
  // A project whose root is a git repo with a GitHub origin → the card carries owner/name.
  const withRemote = join(base, "with-remote");
  const root = join(withRemote, "root");
  seedState(withRemote, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      batches: [["101"]],
      name: "work",
      slots: 1,
    }),
  ]);
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "git@github.com:jjforge/vetinari.git"]);
  // A project with no git remote (the demo) → no repo, so the display falls back to the bare key.
  const noRemote = join(base, "no-remote");
  seedState(noRemote, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      batches: [["102"]],
      name: "work",
      slots: 1,
    }),
  ]);

  const { projects } = buildLanding(
    [pointerFor("with-remote", withRemote), pointerFor("no-remote", noRemote)],
    new Date("2025-01-02T12:00:00.000Z"),
  );
  const [a, b] = projects;
  assert.equal(a.repo, "jjforge/vetinari");
  // The bare project key is unchanged — repo is display-only.
  assert.equal(a.project, "with-remote");
  assert.equal(b.repo, undefined);
});

test("buildLanding builds a per-project card for a live campaign", () => {
  const base = join(tmpdir(), `vetinari-landing-card-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      batches: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-02T08:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-batch-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-02T08:04:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("queue-start", { ts: "2025-01-02T08:05:00.000Z", taskIds: ["201"], slots: 1 }),
    event("turn", {
      ts: "2025-01-02T08:06:00.000Z",
      taskId: "201",
      turn: 2,
      summary: "Writing the failing test",
    }),
  ]);

  const { projects } = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2025-01-02T12:00:00.000Z"),
  );
  assert.equal(projects.length, 1);
  const card = projects[0];
  assert.equal(card.project, "demo");
  assert.equal(card.runState, "running");
  assert.equal(card.campaignName, "gateway work");
  // Wave 1 is closed and banked; wave 2 is the one in flight — "2 of 3".
  assert.deepEqual(card.wave, { current: 2, total: 3 });
  // One of three issues has merged.
  assert.equal(card.percentMerged, 33);
  // 201 is in the running wave; 301 is a future-wave issue still queued; 101 is banked.
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 1 });
  // The last operator-facing line is the agent's own turn summary (ADR 0009).
  assert.equal(card.lastEvent, "Writing the failing test");
});

test("buildLanding's card counts the live plan, not pruned chips", () => {
  const base = join(tmpdir(), `vetinari-landing-pruned-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      batches: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-02T08:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-batch-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-02T08:04:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("queue-start", { ts: "2025-01-02T08:05:00.000Z", taskIds: ["201"], slots: 1 }),
    // The future, unstarted wave 301 is pruned out — a display ghost, not live work.
    event("prune", {
      ts: "2025-01-02T08:06:00.000Z",
      target: "301",
      removed: ["301"],
      dropped: [],
    }),
  ]);

  const [card] = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2025-01-02T12:00:00.000Z"),
  ).projects;

  // Two live waves remain (101 closed, 201 running); the pruned-out 301 wave and its
  // chip do not inflate the count, the "queued" tally, or drag down percent merged.
  assert.deepEqual(card.wave, { current: 2, total: 2 });
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 0 });
  assert.equal(card.percentMerged, 50);
  assert.equal(card.runState, "running");
});

test("buildLanding counts grafted issues as queued but still excludes pruned (#200)", () => {
  const base = join(tmpdir(), `vetinari-landing-graft-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      batches: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("campaign-batch", { ts: "2025-01-02T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-batch-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", { ts: "2025-01-02T08:04:00.000Z", index: 1, tasks: ["201"] }),
    event("queue-start", { ts: "2025-01-02T08:05:00.000Z", taskIds: ["201"], slots: 1 }),
    // The future, unstarted wave 301 is pruned out — a display ghost, not live work.
    event("prune", { ts: "2025-01-02T08:06:00.000Z", target: "301", removed: ["301"], dropped: [] }),
    // Two issues grafted into later, unstarted waves — pending work that reads `grafted`.
    event("graft", { ts: "2025-01-02T08:07:00.000Z", ids: ["305", "306"], blockedBy: {}, basenames: {} }),
  ]);

  const { counters, projects } = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2025-01-02T12:00:00.000Z"),
  );
  const [card] = projects;
  // 101 banked, 201 running; the two grafted issues fold to unstarted → queued 2,
  // not 0. The pruned-out 301 stays excluded from every bucket.
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 2 });
  // The aggregate "QUEUED · in later waves" counter inherits the corrected count.
  assert.equal(counters.queued, 2);
});

test("buildLanding sums the counters, reads an idle project's last campaign, and skips a stale one", () => {
  const base = join(tmpdir(), `vetinari-landing-agg-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-06-15T08:00:00.000Z",
      batches: [["101", "102"], ["201"], ["301"]],
      slots: 1,
    }),
    event("green", { ts: "2025-06-14T09:00:00.000Z", taskId: "102", branch: "agent/102", commits: [] }),
    event("green", { ts: "2025-06-15T09:00:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-batch-done", {
      ts: "2025-06-15T09:05:00.000Z",
      index: 0,
      merged: ["101", "102"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-06-15T09:06:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("queue-start", { ts: "2025-06-15T09:07:00.000Z", taskIds: ["201"], slots: 1 }),
  ]);
  // Beta has no live run, only an archived campaign — it must read idle with that campaign.
  seedState(betaDir, []);
  mkdirSync(join(betaDir, "logs", "archive"), { recursive: true });
  writeJsonl(
    join(betaDir, "logs", "archive", "orchestrator-2025-06-10T00-00-00.jsonl"),
    [
      event("campaign-start", {
        ts: "2025-06-10T00:00:00.000Z",
        batches: [["501"]],
        name: "old work",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2025-06-10T00:05:00.000Z",
        index: 0,
        merged: ["501"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2025-06-10T00:06:00.000Z", batches: 1 }),
    ],
  );

  const { counters, projects } = buildLanding(
    [
      pointerFor("alpha", alphaDir),
      pointerFor("beta", betaDir),
      pointerFor("ghost", join(base, "gone")),
    ],
    new Date("2025-06-15T12:00:00.000Z"),
  );

  // The stale registration is skipped, never fatal.
  assert.deepEqual(
    projects.map((p) => p.project),
    ["alpha", "beta"],
  );
  // Counters sum across live projects; merged-today counts only 101 (102 merged yesterday).
  assert.deepEqual(counters, {
    working: 1,
    parked: 0,
    queued: 1,
    mergedToday: 1,
  });

  const beta = projects[1];
  assert.equal(beta.runState, "idle");
  assert.equal(beta.campaignName, "old work");
  assert.equal(beta.wave, null);
  assert.match(beta.lastEvent, /^Last run: campaign · 1 issue · complete$/);
});

test("an idle project's merged % and merged-today read its latest archived run, not the cleared live log (#70)", () => {
  const base = join(tmpdir(), `vetinari-landing-idle-archive-${Date.now()}`);
  const dir = join(base, "beta");
  // Idle: the run finished, so its live log is empty and its work is in the archive.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // A completed run that merged both its issues today.
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T09:00:00.000Z",
        batches: [["501"], ["502"]],
        name: "shipped",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T09:05:00.000Z",
        index: 0,
        merged: ["501"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T09:10:00.000Z",
        index: 1,
        merged: ["502"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-15T09:11:00.000Z", batches: 2 }),
    ],
  );

  const { counters, projects } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  const [card] = projects;
  assert.equal(card.runState, "idle");
  // Both issues merged, so the idle card reads 100% — not the hardcoded 0%.
  assert.equal(card.percentMerged, 100);
  // And both merges count toward "merged today", read from the archived run.
  assert.equal(counters.mergedToday, 2);
});

test("an archived run whose parked record survived reads parked, not idle — it still rolls up to the counter, queue, and card (#232)", () => {
  const base = join(tmpdir(), `vetinari-landing-archived-parked-${Date.now()}`);
  const dir = join(base, "beta");
  // Idle path: the live log is empty (the run's log was archived — a process killed
  // before end-of-run, or an out-of-band archive), yet a parked record survived on
  // disk. The archived-card branch must consult the surviving park, not fold to idle.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T09:00:00.000Z",
        batches: [["501"], ["601"]],
        name: "shipped",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T09:05:00.000Z",
        index: 0,
        merged: ["501"],
        held: [],
        clearedParked: [],
      }),
    ],
  );
  writeFileSync(
    join(dir, "parked", "601.json"),
    JSON.stringify({
      taskId: "601",
      parkedAt: "2026-06-15T09:06:00.000Z",
      reason: "needs a decision",
      branch: "agent/601",
      question: "Which approach?",
    }),
  );

  const { counters, projects, parked } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  const [card] = projects;
  // The card surfaces the outstanding park rather than reading a clean idle/complete.
  assert.equal(card.runState, "parked");
  assert.ok(card.tally.parked >= 1, `expected tally.parked >= 1, got ${card.tally.parked}`);
  // …and it rolls up to the landing counter and the cross-repo parked queue.
  assert.equal(counters.parked, 1);
  assert.deepEqual(
    parked.map((p) => [p.project, p.issueNumber]),
    [["beta", "601"]],
  );
});

test("a finished run lingering in the live log whose parked record survived reads parked, not folded-to-idle (#232)", () => {
  const base = join(tmpdir(), `vetinari-landing-fold-parked-${Date.now()}`);
  const dir = join(base, "demo");
  // The live log reached its clean terminal campaign-done (101 merged, its wave closed),
  // so `status.parked` filters the record out and the run would otherwise fold to idle
  // (#208). But a parked record for 101 survived on disk (a crash before `clearParked`),
  // so the fold branch must consult it and surface the outstanding park, not idle.
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", batches: [["101"]], name: "gateway work", slots: 1 }),
    event("campaign-batch-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["101"], held: [], clearedParked: [] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 1 }),
  ]);
  writeFileSync(
    join(dir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "2026-06-15T08:02:00.000Z",
      reason: "needs a decision",
      branch: "agent/101",
      question: "Which approach?",
    }),
  );

  const { counters, projects, parked } = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  const [card] = projects;
  assert.equal(card.runState, "parked");
  assert.ok(card.tally.parked >= 1, `expected tally.parked >= 1, got ${card.tally.parked}`);
  // Counter and queue stay consistent with the card — the surviving park is not filtered away.
  assert.equal(counters.parked, 1);
  assert.deepEqual(
    parked.map((p) => [p.project, p.issueNumber]),
    [["demo", "101"]],
  );
});

test("buildLanding folds a finished campaign still in the live log to idle, display-only, keeping its summary (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-done-live-${Date.now()}`);
  const dir = join(base, "demo");
  // A completed campaign that reached its clean terminal campaign-done but was never
  // archived — the read-only dashboard cannot archive (ADR 0002), so it lingers live.
  seedState(dir, [
    event("campaign-start", {
      ts: "2026-06-15T08:00:00.000Z",
      batches: [["101"], ["201"]],
      name: "gateway work",
      slots: 1,
    }),
    event("campaign-batch-done", {
      ts: "2026-06-15T08:03:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch-done", {
      ts: "2026-06-15T08:05:00.000Z",
      index: 1,
      merged: ["201"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 2 }),
  ]);
  const logFile = join(dir, "logs", "orchestrator.jsonl");
  const before = readFileSync(logFile);

  const [card] = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  ).projects;

  // The finished run fades to idle rather than lingering green forever …
  assert.equal(card.runState, "idle");
  // … while still surfacing the finished run's name and summary ("Last run: …").
  assert.equal(card.campaignName, "gateway work");
  assert.equal(card.wave, null);
  assert.equal(card.percentMerged, 100);
  assert.match(card.lastEvent, /^Last run: campaign · 2 issues · complete$/);

  // The fold is display-only: the live log's bytes are untouched and nothing was archived.
  assert.deepEqual(readFileSync(logFile), before);
  assert.equal(existsSync(join(dir, "logs", "archive")), false);
});

test("buildLanding folds a finished queue-done live log to idle too (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-done-queue-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    event("queue-start", { ts: "2026-06-15T08:00:00.000Z", taskIds: ["101"], slots: 1 }),
    event("green", { ts: "2026-06-15T08:01:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("queue-done", { ts: "2026-06-15T08:02:00.000Z", outcomes: { "101": "green" } }),
  ]);

  const [card] = buildLanding(
    [pointerFor("demo", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  ).projects;
  assert.equal(card.runState, "idle");
  assert.match(card.lastEvent, /^Last run: queue · 1 issue · complete$/);
});

test("buildLanding does NOT fold a failed, parked, or in-flight live log to idle (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-nofold-${Date.now()}`);
  // A run with a failed issue (the agent could not make it green) is an attention state, never idle.
  const failedDir = join(base, "failed");
  seedState(failedDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", batches: [["101"]], name: "failed", slots: 1 }),
    event("campaign-batch", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("queue-start", { ts: "2026-06-15T08:02:00.000Z", taskIds: ["101"], slots: 1 }),
    event("queue-done", { ts: "2026-06-15T08:03:00.000Z", outcomes: { "101": "error(3)" } }),
  ]);
  // A parked question outranks "done and quiet": even a run whose log reached the
  // terminal campaign-done keeps a lingering parked record (archiveIfIdle no-ops
  // while anything is parked), so it must read parked, never fold to idle.
  const parkedDir = join(base, "parked");
  seedState(parkedDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", batches: [["201"], ["101"]], name: "parked", slots: 1 }),
    event("campaign-batch-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["201"], held: [], clearedParked: [] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 2 }),
  ]);
  writeFileSync(
    join(parkedDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "2026-06-15T08:01:00.000Z",
      reason: "needs a decision",
      branch: "agent/101",
      question: "Which approach?",
    }),
  );
  // An in-flight run (no terminal event) still reads running.
  const runDir = join(base, "run");
  seedState(runDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", batches: [["101"]], name: "running", slots: 1 }),
    event("campaign-batch", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("queue-start", { ts: "2026-06-15T08:02:00.000Z", taskIds: ["101"], slots: 1 }),
  ]);

  const { projects } = buildLanding(
    [pointerFor("failed", failedDir), pointerFor("parked", parkedDir), pointerFor("run", runDir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  const byProject = Object.fromEntries(projects.map((p) => [p.project, p.runState]));
  assert.equal(byProject.failed, "failure");
  assert.equal(byProject.parked, "parked");
  assert.equal(byProject.run, "running");
});

test("an idle project whose latest archived run merged on an earlier day counts 0 toward merged-today (#70)", () => {
  const base = join(tmpdir(), `vetinari-landing-idle-archive-old-${Date.now()}`);
  const dir = join(base, "beta");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-10T00-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-10T09:00:00.000Z",
        batches: [["501"]],
        name: "older",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-10T09:05:00.000Z",
        index: 0,
        merged: ["501"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-10T09:06:00.000Z", batches: 1 }),
    ],
  );

  const { counters, projects } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  // Fully merged run → 100% on the card, but merged five days ago → nothing today.
  assert.equal(projects[0].percentMerged, 100);
  assert.equal(counters.mergedToday, 0);
});

test("merged-today sums every archived run merged today, not just the latest (#97)", () => {
  const base = join(tmpdir(), `vetinari-landing-merged-many-${Date.now()}`);
  const dir = join(base, "beta");
  // Idle: two campaigns ran and completed today, so both live in the archive.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // Earlier run today merged 501.
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T08:00:00.000Z",
        batches: [["501"]],
        name: "morning",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T08:05:00.000Z",
        index: 0,
        merged: ["501"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 1 }),
    ],
  );
  // Later run today (the latest archive) merged 502.
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T10-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T10:00:00.000Z",
        batches: [["502"]],
        name: "afternoon",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T10:05:00.000Z",
        index: 0,
        merged: ["502"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-15T10:06:00.000Z", batches: 1 }),
    ],
  );

  const { counters } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  // Both runs merged today — the earlier archive is no longer ignored.
  assert.equal(counters.mergedToday, 2);
});

test("merged-today combines the live run's merges with the archives' (#97)", () => {
  const base = join(tmpdir(), `vetinari-landing-merged-live-arch-${Date.now()}`);
  const dir = join(base, "beta");
  // A live campaign in flight that has already merged 601 today (602 still running).
  seedState(dir, [
    event("campaign-start", {
      ts: "2026-06-15T11:00:00.000Z",
      batches: [["601"], ["602"]],
      name: "live",
      slots: 1,
    }),
    event("campaign-batch-done", {
      ts: "2026-06-15T11:05:00.000Z",
      index: 0,
      merged: ["601"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", { ts: "2026-06-15T11:06:00.000Z", index: 1, tasks: [] }),
    event("queue-start", { ts: "2026-06-15T11:07:00.000Z", taskIds: ["602"], slots: 1 }),
  ]);
  // An earlier completed run today, archived, merged 701.
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T08:00:00.000Z",
        batches: [["701"]],
        name: "earlier",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T08:05:00.000Z",
        index: 0,
        merged: ["701"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 1 }),
    ],
  );

  const { counters } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  // The live run's 601 and the archive's 701 both count.
  assert.equal(counters.mergedToday, 2);
});

test("merged-today counts an issue merged in more than one run only once (#97)", () => {
  const base = join(tmpdir(), `vetinari-landing-merged-dedupe-${Date.now()}`);
  const dir = join(base, "beta");
  // 801 merged in the live run today...
  seedState(dir, [
    event("campaign-start", {
      ts: "2026-06-15T11:00:00.000Z",
      batches: [["801"]],
      name: "re-run",
      slots: 1,
    }),
    event("campaign-batch-done", {
      ts: "2026-06-15T11:05:00.000Z",
      index: 0,
      merged: ["801"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-done", { ts: "2026-06-15T11:06:00.000Z", batches: 1 }),
  ]);
  // ...and the same 801 was already merged in an earlier archived run today.
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(
    join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"),
    [
      event("campaign-start", {
        ts: "2026-06-15T08:00:00.000Z",
        batches: [["801"]],
        name: "earlier",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-06-15T08:05:00.000Z",
        index: 0,
        merged: ["801"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", batches: 1 }),
    ],
  );

  const { counters } = buildLanding(
    [pointerFor("beta", dir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  // One issue, two runs — counted once.
  assert.equal(counters.mergedToday, 1);
});

test("merged-today counts against the operator's LOCAL day, not the UTC day (#97)", () => {
  // Divergent case: PDT (UTC−7). `now` is Sun Aug 23 19:24 local = Mon Aug 24
  // 02:24 UTC — a different UTC day from a merge that happened earlier the same
  // local afternoon (Sun Aug 23 13:00 PDT = 20:00 UTC on Aug 23). UTC-day counts
  // it 0 (Aug-23-UTC ≠ Aug-24-UTC); the operator's local day counts it 1.
  const origTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const base = join(tmpdir(), `vetinari-landing-merged-localday-${Date.now()}`);
    const dir = join(base, "beta");
    seedState(dir, [
      event("campaign-start", {
        ts: "2026-08-23T19:00:00.000Z",
        batches: [["901"]],
        name: "afternoon",
        slots: 1,
      }),
      event("campaign-batch-done", {
        ts: "2026-08-23T20:00:00.000Z",
        index: 0,
        merged: ["901"],
        held: [],
        clearedParked: [],
      }),
      event("campaign-done", { ts: "2026-08-23T20:01:00.000Z", batches: 1 }),
    ]);

    const { counters } = buildLanding(
      [pointerFor("beta", dir)],
      new Date("2026-08-24T02:24:00.000Z"),
    );
    // Same local day (Aug 23 PDT) as `now`, so it counts — even though its UTC day
    // (Aug 23) differs from `now`'s UTC day (Aug 24).
    assert.equal(counters.mergedToday, 1);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("buildFeed merges every project's narratable events into one newest-first, repo-prefixed feed", () => {
  const base = join(tmpdir(), `vetinari-feed-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-03-01T08:00:00.000Z",
      batches: [["101"]],
      name: "alpha work",
      slots: 1,
    }),
    // Machine noise carries no narration and must not surface as a feed row.
    { ts: "2025-03-01T08:00:30.000Z", event: "sandbox", taskId: "101" },
    event("green", { ts: "2025-03-01T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  seedState(betaDir, [
    event("parked", {
      ts: "2025-03-01T08:01:00.000Z",
      taskId: "201",
      reason: "needs a choice",
    }),
  ]);

  const feed = buildFeed(
    [
      pointerFor("alpha", alphaDir),
      pointerFor("beta", betaDir),
      pointerFor("ghost", join(base, "gone")),
    ],
    new Date("2025-03-01T09:00:00.000Z"),
  );

  // Newest-first across projects; the stale registration and the machine-noise event are both absent.
  assert.deepEqual(
    feed.map((f) => f.text),
    [
      "alpha — #101 merged",
      "beta — #201 parked: needs a choice",
      "alpha — Campaign “alpha work” started",
    ],
  );
  // Each row carries the time and the event kind alongside the sentence.
  assert.equal(feed[0].ts, "2025-03-01T08:02:00.000Z");
  assert.equal(feed[0].kind, "green");
  assert.equal(feed[0].project, "alpha");
});

test("buildFeed carries each row's underlying event as raw NDJSON, alongside the humanized text (#203)", () => {
  const base = join(tmpdir(), `vetinari-feed-raw-${Date.now()}`);
  const dir = join(base, "acme");
  const green = event("green", { ts: "2025-03-01T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] });
  seedState(dir, [green]);

  // The humanized row `time` renders in the host's local timezone (#239); pin the process TZ to
  // PST (UTC−8 on Mar 1, pre-DST) so the local slice is deterministic — `08:02:00Z` → `00:02:00`.
  const origTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const feed = buildFeed([pointerFor("acme", dir)], new Date("2025-03-01T09:00:00.000Z"));

    // The row's `raw` is the underlying event serialized — the bytes the Raw toggle highlights and
    // Download JSON emits (#203), distinct from the repo-prefixed humanized `text`.
    assert.equal(feed[0].text, "acme — #101 merged");
    assert.deepEqual(JSON.parse(feed[0].raw), green);
    // …and each row carries the shared log-view parts (#216): the repo leads the message as the
    // actor, the narration is one plain span, and the dot reads the event's state (a merge → green).
    assert.deepEqual(feed[0].humanized, { time: "00:02:00", actor: "acme", verb: "", spans: [{ text: "#101 merged", kind: "plain" }], dot: "merged" });
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("describeEvent narrates a campaign-failed stop marker so the feed shows why it stopped (#285)", () => {
  assert.equal(
    describeEvent(event("campaign-failed", { merged: ["101"], failed: ["102"] })),
    "Campaign failed — #102 could not be made green",
  );
  // More than one failure lists them all.
  assert.equal(
    describeEvent(event("campaign-failed", { merged: [], failed: ["102", "103"] })),
    "Campaign failed — #102, #103 could not be made green",
  );
});

test("a merged event that names its issue only through its branch still renders the number, never #undefined", () => {
  // The campaign wave-merge / per-issue green path can carry the issue number in
  // its `branch` (agent/<id>) rather than a `taskId`. The feed formatter must
  // recover it there so the row reads "#<issue> merged", not "#undefined merged".
  assert.equal(describeEvent(event("green", { taskId: "", branch: "agent/639", commits: [] })), "#639 merged");

  const base = join(tmpdir(), `vetinari-feed-branch-${Date.now()}`);
  const dir = join(base, "acme");
  seedState(dir, [event("green", { ts: "2025-03-01T08:02:00.000Z", branch: "agent/639", taskId: "", commits: [] })]);

  const feed = buildFeed([pointerFor("acme", dir)], new Date("2025-03-01T09:00:00.000Z"));

  assert.equal(feed[0].text, "acme — #639 merged");
  assert.ok(!feed.some((f) => f.text.includes("#undefined")));
});

test("buildFeed surfaces an idle project's recently-archived run, and drops one archived more than 48h ago (#101)", () => {
  const base = join(tmpdir(), `vetinari-feed-archive-${Date.now()}`);
  const dir = join(base, "acme");
  // Idle: the live run archived, so its live log is empty and its work is in the archive.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // A run that finished ~6h ago — inside the 48h feed window, so it still feeds.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-08-24T06-00-00-000Z.jsonl"), [
    event("campaign-start", { ts: "2026-08-24T06:00:00.000Z", batches: [["101"]], name: "recent", slots: 1 }),
    event("green", { ts: "2026-08-24T06:05:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  // A run that finished ~4.5 days ago — past the window, so nothing from it feeds.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-08-20T00-00-00-000Z.jsonl"), [
    event("campaign-start", { ts: "2026-08-20T00:00:00.000Z", batches: [["999"]], name: "ancient", slots: 1 }),
    event("green", { ts: "2026-08-20T00:05:00.000Z", taskId: "999", branch: "agent/999", commits: [] }),
  ]);

  const feed = buildFeed([pointerFor("acme", dir)], new Date("2026-08-24T12:00:00.000Z"));

  const texts = feed.map((f) => f.text);
  assert.ok(texts.includes("acme — #101 merged"), "the recently-archived merge feeds");
  assert.ok(!texts.some((t) => t.includes("#999")), "the >48h-old run does not feed");
});

test("buildFeed cuts individual events by ts even inside an in-window archive (#101)", () => {
  const base = join(tmpdir(), `vetinari-feed-tscut-${Date.now()}`);
  const dir = join(base, "acme");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // The run *started* ~49h ago — just before the 48h window, so it is read (its
  // start falls within the archive margin) — but its opening event predates the
  // window while its merge lands inside it.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-08-22T11-00-00-000Z.jsonl"), [
    event("campaign-start", { ts: "2026-08-22T11:00:00.000Z", batches: [["777"]], name: "edge", slots: 1 }),
    event("green", { ts: "2026-08-22T13:00:00.000Z", taskId: "777", branch: "agent/777", commits: [] }),
  ]);

  const feed = buildFeed([pointerFor("acme", dir)], new Date("2026-08-24T12:00:00.000Z"));

  const texts = feed.map((f) => f.text);
  // The 47h-old merge is in-window; the 49h-old campaign-start is cut by its ts.
  assert.ok(texts.includes("acme — #777 merged"), "the in-window merge feeds");
  assert.ok(!texts.some((t) => t.includes("edge")), "the pre-window start is cut by ts");
});

test("buildLanding collects every parked question across repos, oldest first", () => {
  const base = join(tmpdir(), `vetinari-landing-parked-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-06-15T08:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-06-15T08:00:00.000Z",
      batches: [["301"]],
      slots: 1,
    }),
  ]);
  // Alpha's question was parked more recently than beta's — beta must sort first.
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "2025-06-15T09:00:00.000Z",
      reason: "blocked",
      branch: "agent/101",
      question: "Should the counter live-update?\n\nOptions:\n- A\n- B",
    }),
  );
  writeFileSync(
    join(betaDir, "parked", "301.json"),
    JSON.stringify({
      taskId: "301",
      parkedAt: "2025-06-14T09:00:00.000Z",
      reason: "blocked",
      branch: "agent/301",
      question: "Which colour for the badge?",
    }),
  );

  const { parked } = buildLanding(
    [pointerFor("alpha", alphaDir), pointerFor("beta", betaDir)],
    new Date("2025-06-15T12:00:00.000Z"),
  );

  // Oldest-first across repos: beta (yesterday) before alpha (this morning).
  assert.deepEqual(
    parked.map((p) => ({
      project: p.project,
      issueNumber: p.issueNumber,
      parkedAt: p.parkedAt,
    })),
    [
      {
        project: "beta",
        issueNumber: "301",
        parkedAt: "2025-06-14T09:00:00.000Z",
      },
      {
        project: "alpha",
        issueNumber: "101",
        parkedAt: "2025-06-15T09:00:00.000Z",
      },
    ],
  );
  // The full question travels with the row.
  assert.equal(parked[0].question, "Which colour for the badge?");
  assert.equal(parked[1].question, "Should the counter live-update?");
});

test("the landing parked counter equals the cross-repo parked queue length, even with a conflict-held chip (#259)", () => {
  const base = join(tmpdir(), `vetinari-landing-parked-count-${Date.now()}`);
  const dir = join(base, "acme");
  // 101 hit a merge conflict (parked{conflict}) and 102 parked on a question. Both read
  // `parked` on the lifecycle, but only the question writes a parked record — so the
  // cross-repo queue lists one row. The counter must equal that list, not the two held
  // chips (ADR 0019, the pre-0019 bug where quarantined over-counted the queue).
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101", "102"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("queue-start", { ts: "2025-01-01T00:02:00.000Z", taskIds: ["101", "102"], slots: 2 }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("quarantined", { ts: "2025-01-01T00:04:00.000Z", taskId: "101", branch: "agent/101", detail: "CONFLICT" }),
    event("parked", { ts: "2025-01-01T00:05:00.000Z", taskId: "102", reason: "blocked" }),
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({ taskId: "102", parkedAt: "2025-01-01T00:05:00.000Z", reason: "blocked", branch: "agent/102", question: "Which approach?" }),
  );

  const { counters, parked } = buildLanding([pointerFor("acme", dir)], new Date("2025-01-01T12:00:00.000Z"));
  // The conflict chip (101) is held but not a queued question — the queue lists only 102.
  assert.deepEqual(
    parked.map((p) => p.issueNumber),
    ["102"],
  );
  // …and the counter equals that list length exactly, never the two held chips.
  assert.equal(counters.parked, parked.length);
  assert.equal(counters.parked, 1);
});

test("buildAllStatus builds one status per live project and skips a stale one", () => {
  const base = join(tmpdir(), `vetinari-all-status-${Date.now()}`);
  const alphaDir = join(base, "alpha");
  const betaDir = join(base, "beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102"]],
      slots: 1,
    }),
    event("queue-done", {
      ts: "2025-01-01T00:01:00.000Z",
      outcomes: { "101": "green" },
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"]],
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
      ["101", "completed"],
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

  buildAllStatus(
    [pointerFor("ghost", join(base, "gone"))],
    logger,
  );

  // The skip diagnostic is captured by the host logger the reader was handed —
  // it no longer writes to the process-global event log.
  assert.deepEqual(
    logger.events.map((e) => [e.event, (e as { project?: string }).project]),
    [["status-project-skipped", "ghost"]],
  );
});

test("cardState folds a card's state, failure outranking parked, completed/none → idle (ADR 0019)", () => {
  const wave = (status: "running" | "parked" | "failed" | "closed" | "unstarted", issues: { issueNumber: string; status: string }[]) => [
    { index: 0, status, issues: issues as any },
  ];
  // failure outranks parked now — the deliberate reversal of the old parked-first order:
  // a broken issue is a louder signal than a held one. A failed wave reads failure even
  // with a surviving parked record.
  assert.equal(
    cardState({
      project: "p",
      waves: wave("failed", [
        { issueNumber: "1", status: "failure" },
        { issueNumber: "2", status: "running" },
      ]),
      parked: [{ issueNumber: "3" }] as any,
    }),
    "failure",
  );
  // A held (parked) wave with no failure reads parked.
  assert.equal(
    cardState({
      project: "p",
      waves: wave("parked", [{ issueNumber: "1", status: "parked" }]),
      parked: [],
    }),
    "parked",
  );
  // A surviving parked record forces parked even when the plan folds to idle (#232).
  assert.equal(
    cardState({
      project: "p",
      waves: wave("closed", [{ issueNumber: "1", status: "completed" }]),
      parked: [{ issueNumber: "9" }] as any,
    }),
    "parked",
  );
  // Then running.
  assert.equal(
    cardState({
      project: "p",
      waves: wave("running", [{ issueNumber: "1", status: "running" }]),
      parked: [],
    }),
    "running",
  );
  // A completed campaign folds to idle — the card never reads a bare "completed" (ADR 0019).
  assert.equal(
    cardState({
      project: "p",
      waves: wave("closed", [{ issueNumber: "1", status: "completed" }]),
      parked: [],
    }),
    "idle",
  );
  // No live run at all reads idle.
  assert.equal(cardState({ project: "p", waves: [], parked: [] }), "idle");
});

test("issue lifecycle + wave/campaign folds are one FSM, tested by replaying events (ADR 0019)", () => {
  // Replay an event sequence and assert the resulting issue lifecycles and the folds above
  // them, no render harness needed. 101 merges (completed), 102 parks blocked (question),
  // 103 quarantines on a merge conflict (parked/conflict), 104 errors (failure).
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", batches: [["101", "102", "103", "104"]], slots: 1 }),
    event("campaign-batch", { ts: "t1", index: 0, tasks: ["101", "102", "103", "104"] }),
    event("green", { ts: "t2", taskId: "101", branch: "agent/101", commits: [] }),
    event("parked", { ts: "t3", taskId: "102", reason: "blocked" }),
    event("green", { ts: "t4", taskId: "103", branch: "agent/103", commits: [] }),
    event("quarantined", { ts: "t5", taskId: "103", branch: "agent/103", detail: "CONFLICT" }),
    event("queue-done", { ts: "t6", outcomes: { "104": "error(3)" } }),
  ]);
  assert.deepEqual(issueLifecycle(reduced, "101"), { state: "completed" });
  assert.deepEqual(issueLifecycle(reduced, "102"), { state: "parked", reason: "question" });
  assert.deepEqual(issueLifecycle(reduced, "103"), { state: "parked", reason: "conflict" });
  assert.deepEqual(issueLifecycle(reduced, "104"), { state: "failure" });
  // Every id is a plain member here; the folds skip pruned membership only.
  for (const id of ["101", "102", "103", "104"]) assert.equal(issueMembership(reduced, id), "member");

  // The wave fold: failure outranks parked outranks running (#262). A red member makes the
  // wave read `failed`, never `running`.
  assert.equal(
    waveState([
      { status: "completed" },
      { status: "parked" },
      { status: "failure" },
      { status: "running" },
    ]),
    "failed",
  );
  assert.equal(waveState([{ status: "completed" }, { status: "parked" }, { status: "running" }]), "parked");
  assert.equal(waveState([{ status: "completed" }, { status: "running" }]), "running");
  assert.equal(waveState([{ status: "completed" }, { status: "completed" }]), "closed");
  // A pruned member never forces a wave's state; a wholly-pruned wave reads unstarted.
  assert.equal(waveState([{ status: "running", membership: "pruned" }]), "unstarted");

  // The campaign fold mirrors the wave fold's precedence over the waves below it.
  assert.equal(campaignState(["closed", "parked", "failed", "running"]), "failed");
  assert.equal(campaignState(["closed", "parked", "running"]), "parked");
  assert.equal(campaignState(["closed", "running"]), "running");
  assert.equal(campaignState(["closed", "closed"]), "completed");
  assert.equal(campaignState([]), "unstarted");
});

test("issueLifecycle folds a stalled (dead, no-terminal) running issue to parked{stalled} (ADR 0019)", () => {
  const running = reduceCampaign([
    event("campaign-start", { ts: "t0", batches: [["301"]], slots: 1 }),
    event("campaign-batch", { ts: "t1", index: 0, tasks: ["301"] }),
    event("queue-start", { ts: "t2", taskIds: ["301"], slots: 1 }),
  ]);
  // A live read leaves it running; a dead read with no terminal event stalls it.
  assert.deepEqual(issueLifecycle(running, "301"), { state: "running" });
  assert.deepEqual(issueLifecycle(running, "301", { stalled: true }), { state: "parked", reason: "stalled" });
});

test("reduceCampaign folds a campaign-failed stop marker to a failed, un-closed wave (#285)", () => {
  // The campaign-failed marker is authoritative: even with no error carried in queue-done,
  // it names the failed member and the fold reads it `failure`, so the wave holding it folds
  // to `failed` (failure outranks parked, ADR 0019). The wave is never logged done, so it is
  // not closed and the campaign cannot read complete.
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", batches: [["101", "102"]], slots: 1 }),
    event("campaign-batch", { ts: "t1", index: 0, tasks: ["101", "102"] }),
    event("green", { ts: "t2", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-failed", { ts: "t3", merged: ["101"], failed: ["102"] }),
  ]);

  assert.deepEqual(issueLifecycle(reduced, "101"), { state: "completed" });
  assert.deepEqual(issueLifecycle(reduced, "102"), { state: "failure" });

  // The failed wave is not closed — it holds, it does not read done.
  assert.ok(!reduced.closedWaves.has(0), "the wave holding the failure is not closed");

  // The wave folds to `failed`, and the campaign with it.
  const waveStatus = waveState(reduced.waves[0].map((id) => ({ status: issueLifecycle(reduced, id).state })));
  assert.equal(waveStatus, "failed");
  assert.equal(campaignState([waveStatus]), "failed");
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

test("buildLanding's last-event line names the wave festively when the toggle is on (#193)", () => {
  const dir = join(tmpdir(), `vetinari-landing-festive-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"], ["201"]], slots: 1, festiveOffset: 11, name: "gateway work" }),
    event("campaign-batch", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["201", "202"], name: "gateway work" }),
  ]);
  const pointers = [pointerFor("demo", dir)];
  // Off — today's plain narration lists the member titles/ids.
  assert.equal(buildLanding(pointers, new Date("2025-01-02T00:00:00.000Z")).projects[0].lastEvent, "Campaign “gateway work” — Wave 2 — #201, #202 started");
  // On — the wave draws pool[11+1] = "Nanny Ogg" and lists the member issue numbers.
  assert.equal(
    buildLanding(pointers, new Date("2025-01-02T00:00:00.000Z"), undefined, true).projects[0].lastEvent,
    "Campaign “gateway work” — Wave 2 · Nanny Ogg · #201, #202 started",
  );
});

test("festiveFromCookie reads the toggle out of the request's Cookie header (#193)", () => {
  // Absent header → the fallback (the config default; false at the host dashboard).
  assert.equal(festiveFromCookie(undefined, false), false);
  assert.equal(festiveFromCookie("", false), false);
  assert.equal(festiveFromCookie("theme=dark", false), false);
  // `festiveWaveNames=1` turns it on; `=0` turns it off — the cookie wins over the fallback.
  assert.equal(festiveFromCookie("festiveWaveNames=1", false), true);
  assert.equal(festiveFromCookie("festiveWaveNames=0", true), false);
  // Found among other cookies, with the usual "; " separators and stray whitespace.
  assert.equal(festiveFromCookie("theme=dark; festiveWaveNames=1; tz=UTC", false), true);
  // No cookie present → the fallback decides, so a config default of true still reads on.
  assert.equal(festiveFromCookie("theme=dark", true), true);
});

test("waveLabel's festive input names the wave through the one derivation (#193)", () => {
  // Off (no festive input) — exactly today's wording, card and bare.
  assert.equal(waveLabel(1, undefined, 0), "Wave 2");
  assert.equal(waveLabel(1, "cache eviction", 2), "Wave 2 — cache eviction +2");
  // Card surface — `index · name`; the lead title + "+M" is dropped (the card's member
  // rows already carry the titles), so only the index and the festive name show.
  assert.equal(waveLabel(1, "cache eviction", 2, { name: "Granny Weatherwax", surface: "card" }), "Wave 2 · Granny Weatherwax");
  // Line surface — `index · name · #num, #num, …`; the single-line narration has no member
  // rows, so it lists the member issue numbers inline.
  assert.equal(
    waveLabel(1, undefined, 0, { name: "Granny Weatherwax", surface: "line", numbers: ["1234", "145", "234"] }),
    "Wave 2 · Granny Weatherwax · #1234, #145, #234",
  );
  // A member-less wave degrades the line to just `index · name`.
  assert.equal(waveLabel(1, undefined, 0, { name: "Death", surface: "line", numbers: [] }), "Wave 2 · Death");
});

test("describeEvent narrates festively when given a campaign's reserved offset (#193)", () => {
  // festive offset 11 → wave 1 (index 0) draws pool[11] = "Granny Weatherwax". The one-line
  // narration lists the member issue numbers inline (no member rows on a line).
  assert.equal(
    describeEvent(
      event("campaign-batch", { index: 0, tasks: ["1234", "145", "234"], titles: { "1234": "a" }, name: "gateway work" }),
      { offset: 11 },
    ),
    "Campaign “gateway work” — Wave 1 · Granny Weatherwax · #1234, #145, #234 started",
  );
  // campaign-batch-done reconstructs the members from merged/quarantined/held, still names
  // the wave festively, and keeps the merged-hashes tail.
  assert.equal(
    describeEvent(event("campaign-batch-done", { index: 1, merged: ["101"], held: ["102"], clearedParked: [] }), { offset: 11 }),
    "Wave 2 · Nanny Ogg · #101, #102 merged #101",
  );
  // Same event with no festive input → exactly today's plain-words narration.
  assert.equal(
    describeEvent(event("campaign-batch", { index: 0, tasks: ["1234"], titles: { "1234": "a" }, name: "gateway work" })),
    "Campaign “gateway work” — Wave 1 — a started",
  );
});

test("describeEvent narrates the operator-facing events in plain words", () => {
  assert.equal(
    describeEvent(event("campaign-start", { batches: [["101"]], slots: 1, name: "gateway work" })),
    "Campaign “gateway work” started",
  );
  assert.equal(describeEvent(event("campaign-start", { batches: [["101"]], slots: 1 })), "Campaign started");
  // A campaign-batch names its run and its wave: unlike the card, the one-line narration
  // lists *every* member issue by title (issue #179), not the lead title + "+M" collapse.
  assert.equal(
    describeEvent(
      event("campaign-batch", {
        index: 1,
        tasks: ["201", "202"],
        name: "gateway work",
        titles: { "201": "cache eviction", "202": "warm the cache" },
      }),
    ),
    "Campaign “gateway work” — Wave 2 — cache eviction, warm the cache started",
  );
  // Name absent → nameless wording, never `Campaign “” —`; a resolved title still names the wave.
  assert.equal(
    describeEvent(event("campaign-batch", { index: 1, tasks: ["201"], titles: { "201": "cache eviction" } })),
    "Wave 2 — cache eviction started",
  );
  // An id whose title hasn't resolved still shows, as its `#id`, so every member appears.
  assert.equal(
    describeEvent(event("campaign-batch", { index: 1, tasks: ["201"] })),
    "Wave 2 — #201 started",
  );
  assert.equal(
    describeEvent(
      event("campaign-batch-done", {
        index: 1,
        merged: ["101"],
        held: [],
        clearedParked: [],
        name: "gateway work",
        titles: { "101": "cache eviction" },
      }),
    ),
    "Campaign “gateway work” — Wave 2 — cache eviction merged #101",
  );
  assert.equal(
    describeEvent(event("campaign-batch-done", { index: 0, merged: ["101", "102"], held: [], clearedParked: [] })),
    "Wave 1 — #101, #102 merged #101, #102",
  );
  assert.equal(
    describeEvent(event("campaign-batch-done", { index: 2, merged: [], held: [], clearedParked: [] })),
    "Wave 3 merged nothing",
  );
  assert.equal(
    describeEvent(event("campaign-done", { batches: 3, name: "gateway work" })),
    "Campaign “gateway work” complete (3 waves)",
  );
  assert.equal(describeEvent(event("campaign-done", { batches: 1 })), "Campaign complete (1 wave)");
  // Queue lines render the counts they already hold — the task count on start, the outcome tally on done.
  assert.equal(
    describeEvent(event("queue-start", { taskIds: ["1", "2", "3", "4"], slots: 2 })),
    "Queue started — 4 tasks",
  );
  assert.equal(
    describeEvent(event("queue-done", { outcomes: { "1": "green", "2": "green", "3": "green", "4": "parked" } })),
    "Queue drained — 3 merged, 1 parked",
  );
  assert.equal(
    describeEvent(event("green", { taskId: "#101", branch: "agent/101", commits: [] })),
    "#101 merged",
  );
  assert.equal(
    describeEvent(event("parked", { taskId: "202", reason: "needs a choice" })),
    "#202 parked: needs a choice",
  );
  assert.equal(
    describeEvent(event("prune", { target: "303", removed: ["303", "304"], dropped: ["303", "304"] })),
    "Pruned #303, #304",
  );
  assert.equal(
    describeEvent(event("graft", { ids: ["305", "306"], blockedBy: {}, basenames: {} })),
    "Grafted #305, #306",
  );
  // A turn renders its agent-authored summary verbatim (ADR 0009), falling back when absent.
  assert.equal(
    describeEvent(event("turn", { taskId: "101", turn: 3, summary: "Added a failing test for the counter" })),
    "Added a failing test for the counter",
  );
  // An empty summary is the pre-summary case: the mechanical fallback line stands in.
  assert.equal(
    describeEvent(event("turn", { taskId: "101", turn: 3, summary: "" })),
    "#101 — turn 3",
  );
  // An un-notifiable project reads as a plain-words warning (issue #116), not machine noise.
  assert.equal(
    describeEvent(
      event("telegram-unconfigured", { project: "myapp", baseLocation: "/x/.vetinari.local" }),
    ),
    "⚠ Telegram not configured — parked questions won't be announced",
  );
  // A merge conflict quarantined one issue mid-wave; it reads as an attention line
  // whose detail is the human's next move (ADR 0013).
  assert.equal(
    describeEvent(event("quarantined", { taskId: "640", branch: "agent/640", detail: "CONFLICT (content)" })),
    "#640 parked — merge conflict, resolve it",
  );
  // A red merged base parked the whole wave — a run-level held state, no single culprit (ADR 0013).
  assert.equal(
    describeEvent(event("wave-parked", { merged: ["611", "612"], detail: "npm test failed" })),
    "Wave parked — merged base gated red",
  );
});

test("formatFeedEvent prefixes an event's plain-words sentence with its repo, and drops machine noise", () => {
  // A narratable event reads as one repo-prefixed sentence.
  assert.equal(
    formatFeedEvent("alpha", event("green", { taskId: "101", branch: "agent/101", commits: [] })),
    "alpha — #101 merged",
  );
  assert.equal(
    formatFeedEvent("beta", event("turn", { taskId: "201", turn: 2, summary: "Wrote a failing test" })),
    "beta — Wrote a failing test",
  );
  // An event describeEvent can't narrate (machine noise) yields no feed line.
  assert.equal(
    formatFeedEvent("alpha", noise({ event: "sandbox", taskId: "102" })),
    "",
  );
});

test("lastEventText picks the most recent operator-facing event, ignoring machine noise", () => {
  const events: OrchestratorEvent[] = [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
    event("green", { ts: "2025-01-01T00:01:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    // Machine noise after the meaningful event must not become the "last event".
    noise({
      ts: "2025-01-01T00:02:00.000Z",
      event: "sandbox",
      taskId: "102",
      branch: "agent/102",
    }),
    noise({ ts: "2025-01-01T00:03:00.000Z", event: "gate", cmds: ["npm test"] }),
  ];
  assert.equal(lastEventText(events), "#101 merged");
  assert.equal(lastEventText([]), "No activity yet");
});

test("reduceCampaign reconstructs a fresh campaign's waves with no wave running yet", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102"], ["201"]],
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
        batches: [["101"]],
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
        batches: [["101"]],
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
        batches: [["1"]],
        slots: 1,
        name: "first",
      }),
      event("campaign-start", {
        ts: "2025-01-01T00:10:00.000Z",
        batches: [["101"]],
        slots: 1,
        name: "second",
      }),
    ]).name,
    "second",
  );
});

test("reduceCampaign reads the reserved festiveOffset off the latest campaign-start (#193)", () => {
  assert.equal(
    reduceCampaign([
      event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1, festiveOffset: 11 }),
    ]).festiveOffset,
    11,
  );
  // An offset of 0 is a real reservation, not "absent" — it must survive the fold.
  assert.equal(
    reduceCampaign([
      event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1, festiveOffset: 0 }),
    ]).festiveOffset,
    0,
  );
  // A pre-feature run (no offset stamped) leaves it undefined.
  assert.equal(
    reduceCampaign([event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1 })]).festiveOffset,
    undefined,
  );
});

test("reduceCampaign reports one completed wave closed and the next wave current mid-campaign", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
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

test("reduceCampaign records when each issue merged, from batch-done, green and queue-done", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["201", "202"]],
      slots: 1,
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("green", { ts: "2025-01-02T09:00:00.000Z", taskId: "201", branch: "agent/201", commits: [] }),
    event("queue-done", {
      ts: "2025-01-02T10:00:00.000Z",
      outcomes: { "202": "green", "201": "green" },
    }),
  ]);

  // A merge stamp is recorded from every path an issue reaches "completed" by — the
  // batch merge, a bare green, and a queue-done green — so merged-today can count them.
  assert.equal(reduced.mergedAt.get("101"), "2025-01-01T00:02:00.000Z");
  assert.equal(reduced.mergedAt.get("201"), "2025-01-02T09:00:00.000Z");
  assert.equal(reduced.mergedAt.get("202"), "2025-01-02T10:00:00.000Z");
});

test("reduceCampaign derives failure from an issue that errored, not a campaign-level event (ADR 0019)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102"],
    }),
    event("queue-done", {
      ts: "2025-01-01T00:02:00.000Z",
      outcomes: { "101": "error(3)", "102": "green" },
    }),
  ]);

  // `failure` is the single red terminal — an issue the agent could not make green.
  assert.equal(reduced.outcomes.get("101"), "failure");
  assert.equal(reduced.outcomes.get("102"), "completed");
});

test("campaignRunning is true for a started campaign that has not finished", () => {
  assert.equal(
    campaignRunning([
      event("campaign-start", { batches: [["101"], ["201"]], slots: 1 }),
      event("campaign-batch", { index: 0, tasks: ["101"] }),
    ]),
    true,
  );
});

test("campaignRunning is false with no campaign, and once it completes", () => {
  assert.equal(
    campaignRunning([event("queue-start", { taskIds: ["101"], slots: 1 })]),
    false,
    "queue-only run is not a campaign",
  );
  assert.equal(
    campaignRunning([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-done", { batches: 1 }),
    ]),
    false,
    "a completed campaign is not running",
  );
});

test("campaignRunning tracks the latest campaign only", () => {
  // An earlier campaign finished; a fresh one started after it is what counts.
  assert.equal(
    campaignRunning([
      event("campaign-start", { batches: [["1"]], slots: 1 }),
      event("campaign-done", { batches: 1 }),
      event("campaign-start", { batches: [["101"], ["201"]], slots: 1 }),
    ]),
    true,
  );
});

test("campaignSettled is true only when every member merged — the fold, not the campaign-done marker", () => {
  // A campaign whose every wave merged is settled even with no `campaign-done` on
  // the log (a crash right after the last merge): the fold decides, not the marker.
  assert.equal(
    campaignSettled([
      event("campaign-start", { batches: [["101"], ["201"]], slots: 1 }),
      event("campaign-batch-done", { index: 0, merged: ["101"], held: [], clearedParked: [] }),
      event("campaign-batch-done", { index: 1, merged: ["201"], held: [], clearedParked: [] }),
    ]),
    true,
    "every member merged → settled",
  );
});

test("campaignSettled is false for an unsettled campaign, whatever stopped it", () => {
  // Parked and stopped with no `campaign-done`: a held member is unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-batch", { index: 0, tasks: ["101"] }),
      event("parked", { taskId: "101", reason: "needs a decision" }),
    ]),
    false,
    "parked-and-stopped is unsettled",
  );
  // Failed and stopped: a member that errored out holds the campaign unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-batch", { index: 0, tasks: ["101"] }),
      event("queue-done", { outcomes: { "101": "error(1)" } }),
    ]),
    false,
    "failed-and-stopped is unsettled",
  );
  // Still running: a member in flight is unsettled.
  assert.equal(
    campaignSettled([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-batch", { index: 0, tasks: ["101"] }),
      event("queue-start", { taskIds: ["101"], slots: 1 }),
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
      batches: [["101"], ["201", "202"], ["301"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201", "202"],
    }),
    event("queue-start", {
      ts: "2025-01-01T00:03:30.000Z",
      taskIds: ["201", "202"],
      slots: 3,
    }),
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
      batches: [["101"], ["201"], ["301"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
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
      batches: [["101"], ["201"], ["301"]],
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
        batches: [["101"], ["201"]],
        slots: 1,
        titles: { "101": "Do the thing" },
        name: "gateway work",
      }),
      event("campaign-batch", {
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
  assert.equal(detail.status, "completed");
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
        batches: [["102"]],
        slots: 1,
        name: "gateway work",
      }),
      event("campaign-batch", {
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
        reason: "blocked",
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

test("buildStatus shows campaign waves with issue chips and statuses", () => {
  const dir = join(tmpdir(), `vetinari-status-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102"],
    }),
    event("queue-done", {
      ts: "2025-01-01T00:02:00.000Z",
      outcomes: { "101": "green", "102": "parked" },
    }),
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({
      taskId: "102",
      parkedAt: "now",
      reason: "blocked",
      branch: "agent/102",
      sessionId: "s",
      question:
        "Need a choice.\n\nOptions:\n- A: do the simple thing\n- B: do the robust thing",
    }),
  );

  const status = buildStatus(cfgFor(dir));

  assert.equal(status.project, "demo");
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status])),
    [
      [
        ["101", "completed"],
        ["102", "parked"],
      ],
      [["201", "unstarted"]],
    ],
  );
  assert.equal(status.parked[0].issueNumber, "102");
  assert.deepEqual(status.parked[0].options, [
    "A: do the simple thing",
    "B: do the robust thing",
  ]);
});

test("buildStatus surfaces the campaign name from the start event", () => {
  const dir = join(tmpdir(), `vetinari-status-name-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
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
      batches: [["101", "102"]],
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

test("buildStatus fills issue names from a queue-only run's queue-start titles", () => {
  const dir = join(tmpdir(), `vetinari-status-queue-titles-${Date.now()}`);
  seedState(dir, [
    // No campaign frame — a bare queue run frames its taskIds as a single wave,
    // and carries their titles on queue-start.
    event("queue-start", {
      ts: "2025-01-01T00:00:00.000Z",
      taskIds: ["301", "302"],
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
      batches: [["101"]],
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
      batches: [["101"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
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
      [0, "closed"],
      [1, "unstarted"],
    ],
  );
});

test("buildStatus renders a pruned issue as a pruned chip in the wave it left", () => {
  const dir = join(tmpdir(), `vetinari-status-pruned-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["201"]],
      titles: { "101": "seed the db", "201": "add the report" },
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101"],
      held: [],
      clearedParked: [],
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
      batches: [["101", "102"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102"],
    }),
    event("queue-start", {
      ts: "2025-01-01T00:02:00.000Z",
      taskIds: ["101", "102"],
      slots: 2,
    }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      ["101", "completed"],
      ["102", "running"],
    ],
  );
});

test("issueLifecycle: an issue's own reason outranks the wave's red-base park; a completed member stays completed (#288)", () => {
  // A red-base wave-park is the wave's reason, not a rewrite of its members (design §2.3):
  // 611 merged clean (completed), 612 parked on a question inside the same red-base wave.
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "t0", batches: [["611", "612"]], slots: 1 }),
    event("campaign-batch", { ts: "t1", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "t2", taskId: "611", branch: "agent/611", commits: [] }),
    event("parked", { ts: "t3", taskId: "612", reason: "which colour?" }),
    event("wave-parked", { ts: "t4", merged: ["611"], detail: "npm test failed" }),
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
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["611", "612"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("parked", { ts: "2025-01-01T00:03:00.000Z", taskId: "612", reason: "which colour?" }),
    event("wave-parked", { ts: "2025-01-01T00:04:00.000Z", merged: ["611"], detail: "npm test failed" }),
  ];
  const detail = reconstructIssueDetail(events, "612");
  assert.equal(detail.status, "parked");
  assert.equal(detail.reason, "question");
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
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["611", "612"], ["701"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "612"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "612", branch: "agent/612", commits: [] }),
    event("wave-parked", { ts: "2025-01-01T00:04:00.000Z", merged: ["611", "612"], detail: "npm test failed" }),
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
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["611", "640"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["611", "640"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "611", branch: "agent/611", commits: [] }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "640", branch: "agent/640", commits: [] }),
    event("quarantined", { ts: "2025-01-01T00:04:00.000Z", taskId: "640", branch: "agent/640", detail: "CONFLICT" }),
    event("campaign-batch-done", { ts: "2025-01-01T00:05:00.000Z", index: 0, merged: ["611"], held: [], clearedParked: [], quarantined: ["640"] }),
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
  assert.equal(
    status.waves[0].issues.find((i) => i.issueNumber === "640")?.detail,
    "Parked on a merge conflict — resolve the conflict",
  );
});

test("buildStatus clears the quarantine once the issue merges on resume", () => {
  const dir = join(tmpdir(), `vetinari-status-quarantine-cleared-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // 640 was quarantined, then a resumed batch merged it clean: it reads completed, not quarantined.
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["640"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["640"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "640", branch: "agent/640", commits: [] }),
    event("quarantined", { ts: "2025-01-01T00:03:00.000Z", taskId: "640", branch: "agent/640", detail: "CONFLICT" }),
    event("campaign-batch-done", { ts: "2025-01-01T00:04:00.000Z", index: 0, merged: ["640"], held: [], clearedParked: [], quarantined: [] }),
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
      batches: [["101"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: [],
      held: ["101"],
      clearedParked: [],
    }),
    event("campaign-batch", {
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
        reason: "blocked",
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

test("buildStatus only shows parked cards for issues in the active campaign", () => {
  const dir = join(tmpdir(), `vetinari-status-filter-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["243"]],
      slots: 1,
    }),
  ]);
  for (const taskId of ["243", "999"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({
        taskId,
        parkedAt: "now",
        reason: "blocked",
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
      batches: [["101", "102", "103"]],
      slots: 1,
    }),
    event("queue-start", {
      ts: "2025-01-01T00:01:00.000Z",
      taskIds: ["101", "102", "103"],
      slots: 3,
    }),
    event("queue-spawn", {
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
      reason: "blocked",
    }),
  ]);

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.detail]),
    [
      ["101", "Agent turn 2 finished; waiting for verification/resume"],
      ["102", "Completed on agent/102"],
      ["103", "Parked: blocked"],
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
      batches: [["101", "102"]],
      slots: 1,
    }),
  ]);

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    fetchTask: async (id: string) =>
      id === "101"
        ? JSON.stringify({ title: "Add login flow" })
        : "no structured title",
  });

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, undefined);
});

test("a dead (archived) run folds its in-flight `running` to parked{stalled}, while a live read stays running (#152, ADR 0019)", () => {
  // The issue's self-contained reproducer: a campaign that logged its first wave's
  // spawn and then stopped — no campaign-done / queue-done.
  const events = [
    event("campaign-start", { ts: "2026-08-26T23:27:59.174Z", batches: [["101"], ["202"]], slots: 8, name: "stalled run" }),
    event("campaign-batch", { ts: "2026-08-26T23:28:00.000Z", index: 0, tasks: ["101"] }),
    event("queue-start", { ts: "2026-08-26T23:28:01.000Z", taskIds: ["101"], slots: 8 }),
    event("queue-spawn", { ts: "2026-08-26T23:28:02.000Z", taskId: "101", running: 1, left: 0 }),
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

  // A live read of the same archived log still derives running (the FSM only stalls on a
  // dead read).
  assert.equal(buildStatus(cfg).waves[0].issues[0].status, "running");

  // The dead read: the log has no terminal event and the process is gone, so the FSM folds
  // the in-flight issue/wave to `parked{stalled}` — an archived run must carry no live status.
  assert.equal(archivedRunState(events), "stalled");
  const status = buildStatus(cfg, { dead: true });
  const statuses = status.waves.flatMap((w) => [w.status as string, ...w.issues.map((i) => i.status as string)]);
  assert.ok(!statuses.includes("running"), `an archived run must show no live status; got ${statuses.join(", ")}`);
  assert.equal(status.waves[0].status, "parked");
  assert.deepEqual([status.waves[0].issues[0].status, status.waves[0].issues[0].reason], ["parked", "stalled"]);
  // The never-reached second wave stays honestly unstarted — that is not a live status.
  assert.equal(status.waves[1].status, "unstarted");
  assert.equal(status.waves[1].issues[0].status, "unstarted");
});

test("parsePruneClosure reads the structured closure line the dry-run prints", () => {
  // The dry-run prints a `prune-closure {json}` line (E2) carrying the exact
  // closure — target, the dependents that would leave, the banked work kept, and
  // the remaining waves — so the panel names each without re-parsing the prose.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    remaining: [["501"]],
  };
  assert.deepEqual(
    parsePruneClosure(
      `prune #201 → dropping #201, #401 (keeping banked #301)\nremaining campaign: "501"\nprune-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
  // No structured line (e.g. an install predating E2) → null, so the route can 502
  // rather than half-render a closure it cannot vouch for.
  assert.equal(
    parsePruneClosure(
      "prune #201 → nothing to drop\nremaining campaign: (nothing left to run)",
    ),
    null,
  );
});

test("listArchivedRuns lists a project's archived runs newest-first with summaries, skipping a malformed file", () => {
  const dir = join(tmpdir(), `vetinari-archive-list-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["101"]], slots: 1 }),
    event("campaign-done", { batches: 1 }),
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["201"], ["202"]], slots: 1 }),
    event("campaign-done", { batches: 2 }),
  ]);
  // A malformed archive (no reconstructable run) is skipped, not fatal — even
  // though its timestamp is the newest.
  writeFileSync(
    join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"),
    "not json at all\n{broken",
  );

  const runs = listArchivedRuns(dir);

  // Newest-first by timestamp token; the malformed newest file is dropped.
  assert.deepEqual(
    runs.map((r) => r.run),
    ["2026-02-01T00-00-00-000Z", "2026-01-01T00-00-00-000Z"],
  );
  assert.equal(runs[0].summary, "campaign · 2 issues · complete");
  assert.equal(runs[1].summary, "campaign · 1 issue · complete");
  // Neither archived run was named, so each carries no name (the list falls back to its token).
  assert.equal(runs[0].name, undefined);
  assert.equal(runs[1].name, undefined);
  // The file path is resolved from the listing, never joined from request input.
  assert.ok(
    runs[0].file.endsWith("orchestrator-2026-02-01T00-00-00-000Z.jsonl"),
  );
});

test("listArchivedRuns carries a named run's --name for the list's primary label", () => {
  const dir = join(tmpdir(), `vetinari-archive-named-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["101"]], name: "gateway + comms", slots: 1 }),
    event("campaign-done", { batches: 1 }),
  ]);

  const runs = listArchivedRuns(dir);
  assert.equal(runs[0].name, "gateway + comms");
});

test("listArchivedRuns returns nothing when a project has no archive directory", () => {
  assert.deepEqual(
    listArchivedRuns(join(tmpdir(), `vetinari-archive-none-${Date.now()}`)),
    [],
  );
});

test("parseRunTimestamp reverses an archive run token to an ISO timestamp, tolerating older tokens", () => {
  // The token `archiveRun` writes: `toISOString().replace(/[:.]/g, "-")`.
  assert.equal(
    parseRunTimestamp("2026-08-23T22-22-36-267Z"),
    "2026-08-23T22:22:36.267Z",
  );
  // Older archives were written without milliseconds and/or the trailing Z.
  assert.equal(
    parseRunTimestamp("2025-06-10T00-00-00"),
    "2025-06-10T00:00:00.000Z",
  );
  // A token that isn't a timestamp yields undefined, so the row falls back to it verbatim.
  assert.equal(parseRunTimestamp("not-a-stamp"), undefined);
});

test("listArchivedRuns carries each run's state, startedAt and issue count, derived from the log", () => {
  const dir = join(tmpdir(), `vetinari-archive-fields-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  // A clean run that reached campaign-done: complete, three issues.
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["101", "102"], ["201"]], slots: 1 }),
    event("campaign-done", { batches: 2 }),
  ]);
  // A run whose log has a campaign-start but no terminal event — the process was
  // killed mid-wave, so it reads stalled and expands to its partial waves (ADR 0019).
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["301"], ["302"]], slots: 1 }),
    event("campaign-batch", { index: 0, tasks: ["301"] }),
  ]);
  const runs = listArchivedRuns(dir);
  const byRun = Object.fromEntries(runs.map((r) => [r.run, r]));

  assert.equal(byRun["2026-01-01T00-00-00-000Z"].state, "complete");
  assert.equal(byRun["2026-01-01T00-00-00-000Z"].issues, 3);
  assert.equal(
    byRun["2026-01-01T00-00-00-000Z"].startedAt,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].state, "stalled");
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].issues, 2);
});

test("summarizeRun folds an archived log into a one-line mode/issue-count/outcome summary", () => {
  // A finished campaign of two waves (three issues total) that completed.
  assert.equal(
    summarizeRun([
      event("campaign-start", { batches: [["101", "102"], ["201"]], slots: 1 }),
      event("campaign-done", { batches: 2 }),
    ]),
    "campaign · 3 issues · complete",
  );
  // A campaign whose one issue failed (the agent could not make it green) — singular noun.
  assert.equal(
    summarizeRun([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("queue-done", { outcomes: { "101": "error(3)" } }),
    ]),
    "campaign · 1 issue · failed",
  );
  // A queue-only run (no campaign frame) reads as a queue of its task ids.
  assert.equal(
    summarizeRun([
      event("queue-start", { taskIds: ["101", "102"], slots: 1 }),
      event("queue-done", { outcomes: { "101": "green", "102": "green" } }),
    ]),
    "queue · 2 issues · complete",
  );
});

test("summarizeRun describes only the last run in a multi-run archive (#69)", () => {
  // An archive whose live log accumulated two campaigns before it was archived: an
  // earlier run failed on #61, then a fresh campaign ran the remainder to completion.
  // The summary must reflect the terminal run — complete, four issues — not fold the
  // stale failure from the superseded earlier run into a false "failed", and its
  // count must be the last run's, not the whole file's.
  const events = [
    event("campaign-start", { batches: [["56", "57"], ["61"]], slots: 1, name: "first" }),
    event("queue-done", { outcomes: { "61": "error(3)" } }),
    event("campaign-start", { batches: [["63"], ["64"], ["65"], ["67"]], slots: 1, name: "second" }),
    event("campaign-batch-done", { index: 0, merged: ["63"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 1, merged: ["64"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 2, merged: ["65"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 3, merged: ["67"], held: [], clearedParked: [] }),
    event("campaign-done", { batches: 4 }),
  ];
  assert.equal(summarizeRun(events), "campaign · 4 issues · complete");
});

test("summarizeRun still reports failed when the last run failed after an earlier one completed (#69)", () => {
  // The mirror case: an earlier run completed, then a fresh campaign failed on an
  // issue. The terminal run failed, so the summary must say failed — the scoping must
  // not swing the other way and hide a genuine failure behind an earlier clean run.
  const events = [
    event("campaign-start", { batches: [["101"]], slots: 1, name: "first" }),
    event("campaign-done", { batches: 1 }),
    event("campaign-start", { batches: [["201"], ["202"]], slots: 1, name: "second" }),
    event("queue-done", { outcomes: { "201": "error(3)" } }),
  ];
  assert.equal(summarizeRun(events), "campaign · 2 issues · failed");
});

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails(
    "I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?",
  );

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, [
    "Return raw JSON",
    "Render HTML server-side",
  ]);
});

test("parkedReplyFor returns the matching record's question and parsed options for the issue-detail sheet", () => {
  const records = [
    {
      taskId: "#102",
      parkedAt: "now",
      reason: "blocked",
      branch: "agent/102",
      question: "Which store?\n\nOptions:\n- Postgres\n- SQLite",
    },
    {
      taskId: "201",
      parkedAt: "now",
      reason: "blocked",
      branch: "agent/201",
      question: "No options here.",
    },
  ];

  // Matched by normalized issue number (the "#" prefix is irrelevant).
  assert.deepEqual(parkedReplyFor(records, "102"), {
    question: "Which store?",
    options: ["Postgres", "SQLite"],
  });
  // A record with no Options section yields the whole question and no options.
  assert.deepEqual(parkedReplyFor(records, "201"), {
    question: "No options here.",
    options: [],
  });
  // No record names the issue → undefined, so the sheet shows only the free-text field.
  assert.equal(parkedReplyFor(records, "999"), undefined);
});

test("appendedEvents returns the whole log and its end offset from a zero offset", () => {
  const log =
    JSON.stringify(event("campaign-start", { batches: [], slots: 1 })) +
    "\n" +
    JSON.stringify(event("queue-start", { taskIds: [], slots: 1 })) +
    "\n";
  const { events, offset } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "queue-start"],
  );
  assert.equal(offset, log.length);
});

test("appendedEvents returns only the events appended past a prior offset", () => {
  const first = JSON.stringify(event("campaign-start", { batches: [], slots: 1 })) + "\n";
  const appended = JSON.stringify(event("turn", { taskId: "101", turn: 0, summary: "" })) + "\n";
  const { offset } = appendedEvents(first, 0);
  const next = appendedEvents(first + appended, offset);
  assert.deepEqual(
    next.events.map((e) => e.event),
    ["turn"],
  );
  assert.equal(next.offset, first.length + appended.length);
});

test("appendedEvents leaves a partial trailing line unconsumed until it is complete", () => {
  const complete = JSON.stringify(event("campaign-start", { batches: [], slots: 1 })) + "\n";
  const partial = '{"event":"turn"';
  const mid = appendedEvents(complete + partial, 0);
  // Only the complete line is consumed; the offset stops before the partial line.
  assert.deepEqual(
    mid.events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(mid.offset, complete.length);
  // Once the line is finished, resuming from the same offset yields it whole.
  const done = appendedEvents(
    complete + partial + ',"taskId":"101"}\n',
    mid.offset,
  );
  assert.deepEqual(
    done.events.map((e) => e.event),
    ["turn"],
  );
});

test("appendedEvents re-reads from the start when the log is shorter than the offset (rotated/truncated)", () => {
  const rotated = JSON.stringify(event("campaign-start", { batches: [], slots: 1 })) + "\n";
  const { events, offset } = appendedEvents(rotated, 9999);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(offset, rotated.length);
});

test("appendedEvents skips an unparseable line the way readEventLog does", () => {
  const log = "not json\n" + JSON.stringify(event("queue-start", { taskIds: [], slots: 1 })) + "\n";
  const { events } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["queue-start"],
  );
});

test("viewRelevantEvents drops known machine-noise the live view never shows, fail-open on the rest (#131)", () => {
  const events: OrchestratorEvent[] = [
    event("green", { taskId: "101", branch: "agent/101", commits: [] }),
    noise({ event: "telegram-send-failed", chatId: "42" }),
    event("turn", { taskId: "101", turn: 0, summary: "" }),
    noise({ event: "outbound-enqueued", kind: "wave-start" }),
    event("parked", { taskId: "202", reason: "needs a choice" }),
  ];
  // The two side-channel noise rows fall away; every view-relevant row survives, in order.
  assert.deepEqual(
    viewRelevantEvents(events).map((e) => e.event),
    ["green", "turn", "parked"],
  );
  // Fail-open: an unknown/new event kind is kept, never dropped — an allowlist would
  // silently swallow events the per-repo detail view needs (turn/gate detail).
  assert.deepEqual(
    viewRelevantEvents([noise({ event: "some-future-kind" })]).map((e) => e.event),
    ["some-future-kind"],
  );
  // A batch of pure noise survives to nothing, so the SSE path can emit zero frames for it.
  assert.deepEqual(viewRelevantEvents([noise({ event: "telegram-send-failed" }), noise({ event: "outbound-enqueued" })]), []);
});

test("reduceCampaign folds a graft event, extending future waves with the added issues (#166)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    // Graft 301 (no deps) and 302 (blocked by 301) mid-wave-0. No tracker/filesystem
    // access — the reducer folds the inputs the event carries.
    event("graft", {
      ts: "2025-01-01T00:02:00.000Z",
      ids: ["301", "302"],
      blockedBy: { "302": ["301"] },
      basenames: {},
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

test("reduceCampaign drops a graft's grafted overlay once the issue is picked up (#166)", () => {
  const reduced = reduceCampaign([
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, basenames: {} }),
    // 301 is picked up in the next wave and merges — it is no longer "grafted".
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "301", branch: "agent/301", commits: [] }),
  ]);
  assert.equal(reduced.outcomes.get("301"), "completed");
  // The overlay is transient: it drops once the issue leaves the unstarted state.
  assert.equal(reduced.grafted.has("301"), false);
});

test("buildStatus renders a grafted issue with the `grafted` membership while unstarted, then a plain member on pickup (#166, ADR 0019)", () => {
  const dir = join(tmpdir(), `vetinari-status-graft-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"], ["201"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, basenames: {} }),
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
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, basenames: {} }),
    event("campaign-batch", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["301"] }),
    event("queue-start", { ts: "2025-01-01T00:04:00.000Z", taskIds: ["301"], slots: 1 }),
  ]);

  const status = buildStatus(cfgFor(dir));
  const chip = status.waves.flatMap((w) => w.issues).find((i) => i.issueNumber === "301");
  // On pickup the transient `grafted` overlay drops — it now reads its live status.
  assert.equal(chip?.status, "running");
});

test("issueStateFromTask reads open/closed from a tracker's task JSON, defaulting to open (#166)", () => {
  assert.equal(issueStateFromTask('{"state":"CLOSED"}'), "closed");
  assert.equal(issueStateFromTask('{"state":"closed"}'), "closed");
  assert.equal(issueStateFromTask('{"state":"OPEN"}'), "open");
  assert.equal(issueStateFromTask('{"closed":true}'), "closed");
  assert.equal(issueStateFromTask('{"closedAt":"2026-01-01T00:00:00Z"}'), "closed");
  // No state signal (a title-only task, or plain non-JSON text) reads as open.
  assert.equal(issueStateFromTask('{"title":"Add login"}'), "open");
  assert.equal(issueStateFromTask("just some prose"), "open");
});

test("a graft into a wave-parked (resumable) campaign is folded and allowed (#166)", () => {
  const log = [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"], ["201"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("green", { ts: "2025-01-01T00:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    // The wave's merged base gated red — the campaign pauses, resumable (ADR 0013).
    event("wave-parked", { ts: "2025-01-01T00:03:00.000Z", merged: ["101"], detail: "GATE FAILED" }),
    // An operator grafts new work while it is parked, honored on the next --resume.
    event("graft", { ts: "2025-01-01T00:04:00.000Z", ids: ["301"], blockedBy: {}, basenames: {} }),
  ];
  // A wave-parked run is not done, so graft is allowed against it.
  assert.equal(campaignRunning(log), true);
  const reduced = reduceCampaign(log);
  // 301 re-layers into a future wave; the parked wave 0 (101) is untouched.
  assert.ok(reduced.waves.flat().includes("301"));
  assert.deepEqual(reduced.waves[0], ["101"]);
  assert.equal(reduced.grafted.has("301"), true);
});
