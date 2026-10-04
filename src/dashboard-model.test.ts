// Tests for the dashboard data model — the build*/reduce* reconstructors and the
// pure data helpers they compose (dashboard-model.ts, reached via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  appendedEvents,
  archiveStatusConfig,
  archivedRunState,
  buildAllStatus,
  buildFeed,
  buildLanding,
  buildStatus,
  buildStatusWithIssueNames,
  campaignSettled,
  campaignState,
  cardState,
  describeEvent,
  event,
  festiveOffsetFor,
  listArchivedRuns,
  ownerRepoFromRemote,
  parsePruneClosure,
  parseRunTimestamp,
  reduceCampaign,
  viewRelevantEvents,
  selectStatus,
  statusConfigFromPointer,
  stopPending,
  summarizeRun,
  type CampaignStatus,
  type OrchestratorEvent,
} from "./status.ts";
import { festiveWaveName } from "./festive-names.ts";
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

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

test("ownerRepoFromRemote parses SSH and HTTPS GitHub remotes to owner/name, and rejects garbage", () => {
  // SSH form, with the .git suffix stripped.
  assert.equal(ownerRepoFromRemote("git@github.com:jjforge/vetinari.git"), "jjforge/vetinari");
  // HTTPS form, with and without the .git suffix.
  assert.equal(ownerRepoFromRemote("https://github.com/jjforge/vetinari.git"), "jjforge/vetinari");
  assert.equal(ownerRepoFromRemote("https://github.com/acme/tidepool"), "acme/tidepool");
  // Trailing whitespace (as `git remote get-url` prints a newline) and a trailing slash.
  assert.equal(ownerRepoFromRemote("https://github.com/acme/tidepool/\n"), "acme/tidepool");
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
      waves: [["101"]],
      name: "work",
      slots: 1,
    }),
  ]);
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["remote", "add", "origin", "git@github.com:jjforge/vetinari.git"]);
  // A project with no git remote (the demo) → no repo, so the display falls back to the bare key.
  const noRemote = join(base, "no-remote");
  seedState(noRemote, [
    event("campaign-start", {
      ts: "2025-01-02T08:00:00.000Z",
      waves: [["102"]],
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
      waves: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-02T08:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("wave-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-start", {
      ts: "2025-01-02T08:04:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("spawn", { ts: "2025-01-02T08:05:00.000Z", taskId: "201" }),
    event("turn", {
      ts: "2025-01-02T08:06:00.000Z",
      taskId: "201",
      turn: 2,
      summary: "Writing the failing test",
    }),
  ]);

  const { projects } = buildLanding([pointerFor("demo", dir)], new Date("2025-01-02T12:00:00.000Z"));
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
      waves: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-02T08:01:00.000Z",
      index: 0,
      tasks: ["101"],
    }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("wave-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-start", {
      ts: "2025-01-02T08:04:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("spawn", { ts: "2025-01-02T08:05:00.000Z", taskId: "201" }),
    // The future, unstarted wave 301 is pruned out — a display ghost, not live work.
    event("prune", {
      ts: "2025-01-02T08:06:00.000Z",
      target: "301",
      removed: ["301"],
      dropped: [],
    }),
  ]);

  const [card] = buildLanding([pointerFor("demo", dir)], new Date("2025-01-02T12:00:00.000Z")).projects;

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
      waves: [["101"], ["201"], ["301"]],
      name: "gateway work",
      slots: 1,
    }),
    event("wave-start", { ts: "2025-01-02T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("green", { ts: "2025-01-02T08:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("wave-done", {
      ts: "2025-01-02T08:03:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-start", { ts: "2025-01-02T08:04:00.000Z", index: 1, tasks: ["201"] }),
    event("spawn", { ts: "2025-01-02T08:05:00.000Z", taskId: "201" }),
    // The future, unstarted wave 301 is pruned out — a display ghost, not live work.
    event("prune", { ts: "2025-01-02T08:06:00.000Z", target: "301", removed: ["301"], dropped: [] }),
    // Two issues grafted into later, unstarted waves — pending work that reads `grafted`.
    event("graft", { ts: "2025-01-02T08:07:00.000Z", ids: ["305", "306"], blockedBy: {}, fileKeys: {} }),
  ]);

  const { counters, projects } = buildLanding([pointerFor("demo", dir)], new Date("2025-01-02T12:00:00.000Z"));
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
      waves: [["101", "102"], ["201"], ["301"]],
      slots: 1,
    }),
    event("green", { ts: "2025-06-14T09:00:00.000Z", taskId: "102", branch: "agent/102", commits: [] }),
    event("green", { ts: "2025-06-15T09:00:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("wave-done", {
      ts: "2025-06-15T09:05:00.000Z",
      index: 0,
      merged: ["101", "102"],
    }),
    event("wave-start", {
      ts: "2025-06-15T09:06:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    event("spawn", { ts: "2025-06-15T09:07:00.000Z", taskId: "201" }),
  ]);
  // Beta has no live run, only an archived campaign — it must read idle with that campaign.
  seedState(betaDir, []);
  mkdirSync(join(betaDir, "logs", "archive"), { recursive: true });
  writeJsonl(join(betaDir, "logs", "archive", "orchestrator-2025-06-10T00-00-00.jsonl"), [
    event("campaign-start", {
      ts: "2025-06-10T00:00:00.000Z",
      waves: [["501"]],
      name: "old work",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2025-06-10T00:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
    event("campaign-done", { ts: "2025-06-10T00:06:00.000Z", waves: 1 }),
  ]);

  const { counters, projects } = buildLanding(
    [pointerFor("alpha", alphaDir), pointerFor("beta", betaDir), pointerFor("ghost", join(base, "gone"))],
    new Date("2025-06-15T12:00:00.000Z"),
  );

  // The stale registration is skipped, never fatal.
  assert.deepEqual(
    projects.map((p) => p.project),
    ["alpha", "beta"],
  );
  // Counters sum across live projects; merged-today counts by the MERGE stamp, not the green
  // (design §2.2). 102 went green yesterday but only banked when the wave merged today, so both
  // 101 and 102 count for today.
  assert.deepEqual(counters, {
    working: 1,
    parked: 0,
    queued: 1,
    mergedToday: 2,
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
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T09:00:00.000Z",
      waves: [["501"], ["502"]],
      name: "shipped",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T09:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
    event("wave-done", {
      ts: "2026-06-15T09:10:00.000Z",
      index: 1,
      merged: ["502"],
    }),
    event("campaign-done", { ts: "2026-06-15T09:11:00.000Z", waves: 2 }),
  ]);

  const { counters, projects } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
  const [card] = projects;
  assert.equal(card.runState, "idle");
  // Both issues merged, so the idle card reads 100% — not the hardcoded 0%.
  assert.equal(card.percentMerged, 100);
  // And both merges count toward "merged today", read from the archived run.
  assert.equal(counters.mergedToday, 2);
});

test("an idle project's card exposes lastRun — its newest archived run's outcome, name and finish time — for the card to open (design §11)", () => {
  const base = join(tmpdir(), `vetinari-landing-lastrun-${Date.now()}`);
  const dir = join(base, "beta");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T09:00:00.000Z",
      waves: [["501"]],
      name: "shipped",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T09:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
    event("campaign-done", { ts: "2026-06-15T09:06:00.000Z", waves: 1 }),
  ]);

  const [card] = buildLanding([pointerFor("beta", dir)], new Date("2026-06-16T12:00:00.000Z")).projects;
  assert.equal(card.runState, "idle");
  // The card carries its newest archived run's facts: the token it links to, the
  // clean/stalled outcome, the campaign name, and the finish time parsed off the token.
  assert.deepEqual(card.lastRun, {
    run: "2026-06-15T00-00-00-000Z",
    outcome: "complete",
    name: "shipped",
    finishedAt: "2026-06-15T00:00:00.000Z",
  });
});

test("a stalled idle run's card lastRun reads its stalled outcome, and an unnamed run falls back to its token name (design §11)", () => {
  const base = join(tmpdir(), `vetinari-landing-lastrun-stalled-${Date.now()}`);
  const dir = join(base, "beta");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  // A run that stopped mid-wave: it logged no campaign-done, so it reads stalled.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-14T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-14T09:00:00.000Z",
      waves: [["601"]],
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-14T09:05:00.000Z",
      index: 0,
      merged: ["601"],
    }),
  ]);

  const [card] = buildLanding([pointerFor("beta", dir)], new Date("2026-06-16T12:00:00.000Z")).projects;
  assert.equal(card.runState, "idle");
  assert.equal(card.lastRun?.outcome, "stalled");
  // No --name on the run, so the name falls back to the run token (as campaignName does).
  assert.equal(card.lastRun?.name, "2026-06-14T00-00-00-000Z");
});

test("a live (running) project's card carries no lastRun — there is no finished run to open", () => {
  const dir = join(tmpdir(), `vetinari-landing-lastrun-live-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101"]], slots: 1 }),
    event("wave-start", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "2026-06-15T08:02:00.000Z", taskId: "101" }),
  ]);
  const [card] = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z")).projects;
  assert.equal(card.runState, "running");
  assert.equal(card.lastRun, undefined);
});

test("an archived run whose parked record survived reads parked, not idle — it still rolls up to the counter, queue, and card (#232)", () => {
  const base = join(tmpdir(), `vetinari-landing-archived-parked-${Date.now()}`);
  const dir = join(base, "beta");
  // Idle path: the live log is empty (the run's log was archived — a process killed
  // before end-of-run, or an out-of-band archive), yet a parked record survived on
  // disk. The archived-card branch must consult the surviving park, not fold to idle.
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T09:00:00.000Z",
      waves: [["501"], ["601"]],
      name: "shipped",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T09:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
  ]);
  writeFileSync(
    join(dir, "parked", "601.json"),
    JSON.stringify({
      taskId: "601",
      parkedAt: "2026-06-15T09:06:00.000Z",
      reason: "question",
      branch: "agent/601",
      question: "Which approach?",
    }),
  );

  const { counters, projects, parked } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
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

// Both surfaces read one rule for which parked records count (#379): the project page's
// `buildStatus(...).parked` and the landing's card tally, counter and queue must agree.
const assertParkedAgree = (project: string, dir: string, expected: string[]) => {
  const status = buildStatus(statusConfigFromPointer(pointerFor(project, dir)));
  const { counters, projects, parked } = buildLanding([pointerFor(project, dir)], new Date("2026-06-15T12:00:00.000Z"));
  const [card] = projects;
  assert.deepEqual(
    status.parked.map((p) => p.issueNumber),
    expected,
  );
  assert.equal(card.runState === "parked", expected.length > 0, `card reads ${card.runState}`);
  assert.equal(card.tally.parked, expected.length);
  assert.equal(counters.parked, expected.length);
  assert.deepEqual(
    parked.map((p) => [p.project, p.issueNumber]),
    expected.map((issue) => [project, issue]),
  );
};

const writeParkedRecord = (dir: string, taskId: string, parkedAt: string) =>
  writeFileSync(
    join(dir, "parked", `${taskId}.json`),
    JSON.stringify({ taskId, parkedAt, reason: "stalled", detail: "no-commit", branch: `agent/${taskId}`, question: "Stalled" }),
  );

test("a record for an issue pruned out of a since-done campaign counts on neither surface (#379)", () => {
  const dir = join(tmpdir(), `vetinari-landing-pruned-parked-${Date.now()}`, "demo");
  // 102 parks, is pruned out of the plan, and the rest of the campaign merges and
  // finishes. Its record still sits on disk; it is outside the plan, so it counts nowhere.
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101", "102"]], name: "work", slots: 2 }),
    event("wave-start", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("parked", { ts: "2026-06-15T08:02:00.000Z", taskId: "102", reason: "stalled", detail: "no-commit" }),
    event("prune", { ts: "2026-06-15T08:03:00.000Z", target: "102", removed: ["102"], dropped: ["102"] }),
    event("wave-done", { ts: "2026-06-15T08:04:00.000Z", index: 0, merged: ["101"] }),
    event("campaign-done", { ts: "2026-06-15T08:05:00.000Z", waves: 1 }),
  ]);
  writeParkedRecord(dir, "102", "2026-06-15T08:02:00.000Z");
  assertParkedAgree("demo", dir, []);
});

test("a record for a member of a closed wave counts on neither surface, even once the run folds to idle (#379)", () => {
  const dir = join(tmpdir(), `vetinari-landing-closed-parked-${Date.now()}`, "demo");
  // 101 merged and its wave logged wave-done; its record survived (a crash before
  // `clearParked`). A closed wave's member is not parked, so neither surface counts it —
  // the deliberate reversal of the old landing-only read of every record on disk.
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101"]], name: "gateway work", slots: 1 }),
    event("wave-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["101"] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 1 }),
  ]);
  writeParkedRecord(dir, "101", "2026-06-15T08:02:00.000Z");
  assertParkedAgree("demo", dir, []);
});

test("a record from a campaign a newer campaign-start superseded counts on neither surface (#379)", () => {
  const dir = join(tmpdir(), `vetinari-landing-superseded-parked-${Date.now()}`, "demo");
  // 348 parked in an earlier campaign; a newer campaign (without 348) then ran to done.
  // The reducer folds only the latest campaign-start onward, so 348 is outside the plan.
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T07:00:00.000Z", waves: [["348"]], name: "earlier", slots: 1 }),
    event("wave-start", { ts: "2026-06-15T07:01:00.000Z", index: 0, tasks: ["348"] }),
    event("parked", { ts: "2026-06-15T07:02:00.000Z", taskId: "348", reason: "stalled", detail: "no-commit" }),
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["875"]], name: "later", slots: 1 }),
    event("wave-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["875"] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 1 }),
  ]);
  writeParkedRecord(dir, "348", "2026-06-15T07:02:00.000Z");
  assertParkedAgree("demo", dir, []);
});

test("with an empty live log every surviving record counts on both surfaces (#232, #379)", () => {
  const dir = join(tmpdir(), `vetinari-landing-empty-parked-${Date.now()}`, "demo");
  seedState(dir, []);
  writeParkedRecord(dir, "601", "2026-06-15T09:06:00.000Z");
  assertParkedAgree("demo", dir, ["601"]);
});

test("a live, in-plan park counts on both surfaces (#379)", () => {
  const dir = join(tmpdir(), `vetinari-landing-live-parked-${Date.now()}`, "demo");
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101", "102"]], name: "work", slots: 2 }),
    event("wave-start", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("spawn", { ts: "2026-06-15T08:01:30.000Z", taskId: "101" }),
    event("parked", { ts: "2026-06-15T08:02:00.000Z", taskId: "102", reason: "stalled", detail: "no-commit" }),
  ]);
  writeParkedRecord(dir, "102", "2026-06-15T08:02:00.000Z");
  assertParkedAgree("demo", dir, ["102"]);
});

test("buildLanding folds a finished campaign still in the live log to idle, display-only, keeping its summary (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-done-live-${Date.now()}`);
  const dir = join(base, "demo");
  // A completed campaign that reached its clean terminal campaign-done but was never
  // archived — the read-only dashboard cannot archive (ADR 0002), so it lingers live.
  seedState(dir, [
    event("campaign-start", {
      ts: "2026-06-15T08:00:00.000Z",
      waves: [["101"], ["201"]],
      name: "gateway work",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T08:03:00.000Z",
      index: 0,
      merged: ["101"],
    }),
    event("wave-done", {
      ts: "2026-06-15T08:05:00.000Z",
      index: 1,
      merged: ["201"],
    }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 2 }),
  ]);
  const logFile = join(dir, "logs", "orchestrator.jsonl");
  const before = readFileSync(logFile);

  const [card] = buildLanding([pointerFor("demo", dir)], new Date("2026-06-15T12:00:00.000Z")).projects;

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

test("a finished campaign lingering in the live log exposes lastRun too, so the idle card has a last-run line and a run link (design §11, #317)", () => {
  const base = join(tmpdir(), `vetinari-landing-done-live-lastrun-${Date.now()}`);
  const dir = join(base, "demo");
  // The same #208 fold-to-idle scenario — a clean campaign-done still in the live log,
  // never archived — but now the idle card must carry its last run's facts (outcome,
  // name, finish time) and a token to link, exactly as the empty-live-log branch does.
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101"], ["201"]], name: "gateway work", slots: 1 }),
    event("wave-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["101"] }),
    event("wave-done", { ts: "2026-06-15T08:05:00.000Z", index: 1, merged: ["201"] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 2 }),
  ]);

  const [card] = buildLanding([pointerFor("demo", dir)], new Date("2026-06-15T12:00:00.000Z")).projects;
  assert.equal(card.runState, "idle");
  // The run's finish stamp (its last event) becomes both the finish time and the run token
  // — the archive-token form of that ISO, the inverse of parseRunTimestamp — so the card links.
  assert.deepEqual(card.lastRun, {
    run: "2026-06-15T08-06-00-000Z",
    outcome: "complete",
    name: "gateway work",
    finishedAt: "2026-06-15T08:06:00.000Z",
  });
  assert.equal(parseRunTimestamp(card.lastRun!.run), card.lastRun!.finishedAt);
});

test("buildLanding folds a finished single-wave live log to idle too (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-done-queue-${Date.now()}`);
  const dir = join(base, "demo");
  seedState(dir, [
    event("campaign-start", { ts: "2026-06-15T07:59:00.000Z", waves: [["101"]], slots: 1 }),
    event("spawn", { ts: "2026-06-15T08:00:00.000Z", taskId: "101" }),
    event("green", { ts: "2026-06-15T08:01:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    // The single wave's green was banked on the base (design §2.2: only a merge finishes it),
    // so the campaign is settled and folds to idle even with no campaign-done marker (#208).
    event("wave-done", { ts: "2026-06-15T08:02:00.000Z", index: 0, merged: ["101"] }),
  ]);

  const [card] = buildLanding([pointerFor("demo", dir)], new Date("2026-06-15T12:00:00.000Z")).projects;
  assert.equal(card.runState, "idle");
  assert.match(card.lastEvent, /^Last run: campaign · 1 issue · complete$/);
});

test("buildLanding does NOT fold a failed, parked, or in-flight live log to idle (#208)", () => {
  const base = join(tmpdir(), `vetinari-landing-nofold-${Date.now()}`);
  // A run with a failed issue (the agent could not make it green) is an attention state, never idle.
  const failedDir = join(base, "failed");
  seedState(failedDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101"]], name: "failed", slots: 1 }),
    event("wave-start", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "2026-06-15T08:02:00.000Z", taskId: "101" }),
    event("failed", { ts: "2026-06-15T08:03:00.000Z", taskId: "101" }),
  ]);
  // A parked question outranks "done and quiet": even a run whose log reached the
  // terminal campaign-done keeps a lingering parked record (archiveIfIdle no-ops
  // while anything is parked), so it must read parked, never fold to idle.
  const parkedDir = join(base, "parked");
  seedState(parkedDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["201"], ["101"]], name: "parked", slots: 1 }),
    event("wave-done", { ts: "2026-06-15T08:03:00.000Z", index: 0, merged: ["201"] }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 2 }),
  ]);
  writeFileSync(
    join(parkedDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "2026-06-15T08:01:00.000Z",
      reason: "question",
      branch: "agent/101",
      question: "Which approach?",
    }),
  );
  // An in-flight run (no terminal event) still reads running.
  const runDir = join(base, "run");
  seedState(runDir, [
    event("campaign-start", { ts: "2026-06-15T08:00:00.000Z", waves: [["101"]], name: "running", slots: 1 }),
    event("wave-start", { ts: "2026-06-15T08:01:00.000Z", index: 0, tasks: ["101"] }),
    event("spawn", { ts: "2026-06-15T08:02:00.000Z", taskId: "101" }),
  ]);

  const { projects } = buildLanding(
    [pointerFor("failed", failedDir), pointerFor("parked", parkedDir), pointerFor("run", runDir)],
    new Date("2026-06-15T12:00:00.000Z"),
  );
  const byProject = Object.fromEntries(projects.map((p) => [p.project, p.runState]));
  assert.equal(byProject.failed, "failed");
  assert.equal(byProject.parked, "parked");
  assert.equal(byProject.run, "running");
});

test("an idle project whose latest archived run merged on an earlier day counts 0 toward merged-today (#70)", () => {
  const base = join(tmpdir(), `vetinari-landing-idle-archive-old-${Date.now()}`);
  const dir = join(base, "beta");
  seedState(dir, []);
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-10T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-10T09:00:00.000Z",
      waves: [["501"]],
      name: "older",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-10T09:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
    event("campaign-done", { ts: "2026-06-10T09:06:00.000Z", waves: 1 }),
  ]);

  const { counters, projects } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
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
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T08:00:00.000Z",
      waves: [["501"]],
      name: "morning",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T08:05:00.000Z",
      index: 0,
      merged: ["501"],
    }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 1 }),
  ]);
  // Later run today (the latest archive) merged 502.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T10-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T10:00:00.000Z",
      waves: [["502"]],
      name: "afternoon",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T10:05:00.000Z",
      index: 0,
      merged: ["502"],
    }),
    event("campaign-done", { ts: "2026-06-15T10:06:00.000Z", waves: 1 }),
  ]);

  const { counters } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
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
      waves: [["601"], ["602"]],
      name: "live",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T11:05:00.000Z",
      index: 0,
      merged: ["601"],
    }),
    event("wave-start", { ts: "2026-06-15T11:06:00.000Z", index: 1, tasks: [] }),
    event("spawn", { ts: "2026-06-15T11:07:00.000Z", taskId: "602" }),
  ]);
  // An earlier completed run today, archived, merged 701.
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T08:00:00.000Z",
      waves: [["701"]],
      name: "earlier",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T08:05:00.000Z",
      index: 0,
      merged: ["701"],
    }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 1 }),
  ]);

  const { counters } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
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
      waves: [["801"]],
      name: "re-run",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T11:05:00.000Z",
      index: 0,
      merged: ["801"],
    }),
    event("campaign-done", { ts: "2026-06-15T11:06:00.000Z", waves: 1 }),
  ]);
  // ...and the same 801 was already merged in an earlier archived run today.
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-06-15T08-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-06-15T08:00:00.000Z",
      waves: [["801"]],
      name: "earlier",
      slots: 1,
    }),
    event("wave-done", {
      ts: "2026-06-15T08:05:00.000Z",
      index: 0,
      merged: ["801"],
    }),
    event("campaign-done", { ts: "2026-06-15T08:06:00.000Z", waves: 1 }),
  ]);

  const { counters } = buildLanding([pointerFor("beta", dir)], new Date("2026-06-15T12:00:00.000Z"));
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
        waves: [["901"]],
        name: "afternoon",
        slots: 1,
      }),
      event("wave-done", {
        ts: "2026-08-23T20:00:00.000Z",
        index: 0,
        merged: ["901"],
      }),
      event("campaign-done", { ts: "2026-08-23T20:01:00.000Z", waves: 1 }),
    ]);

    const { counters } = buildLanding([pointerFor("beta", dir)], new Date("2026-08-24T02:24:00.000Z"));
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
      waves: [["101"]],
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
      reason: "question",
    }),
  ]);

  const feed = buildFeed(
    [pointerFor("alpha", alphaDir), pointerFor("beta", betaDir), pointerFor("ghost", join(base, "gone"))],
    new Date("2025-03-01T09:00:00.000Z"),
  );

  // Newest-first across projects; the stale registration and the machine-noise event are both absent.
  assert.deepEqual(
    feed.map((f) => f.text),
    ["alpha — #101 merged", "beta — #201 parked: question", "alpha — Campaign “alpha work” started"],
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
    assert.deepEqual(feed[0].humanized, {
      time: "00:02:00",
      actor: "acme",
      verb: "",
      spans: [{ text: "#101 merged", kind: "plain" }],
      dot: "merged",
    });
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
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
    event("campaign-start", { ts: "2026-08-24T06:00:00.000Z", waves: [["101"]], name: "recent", slots: 1 }),
    event("green", { ts: "2026-08-24T06:05:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  // A run that finished ~4.5 days ago — past the window, so nothing from it feeds.
  writeJsonl(join(dir, "logs", "archive", "orchestrator-2026-08-20T00-00-00-000Z.jsonl"), [
    event("campaign-start", { ts: "2026-08-20T00:00:00.000Z", waves: [["999"]], name: "ancient", slots: 1 }),
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
    event("campaign-start", { ts: "2026-08-22T11:00:00.000Z", waves: [["777"]], name: "edge", slots: 1 }),
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
      waves: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-06-15T08:00:00.000Z",
      waves: [["301"]],
      slots: 1,
    }),
  ]);
  // Alpha's question was parked more recently than beta's — beta must sort first.
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "2025-06-15T09:00:00.000Z",
      reason: "question",
      branch: "agent/101",
      question: "Should the counter live-update?\n\nOptions:\n- A\n- B",
    }),
  );
  writeFileSync(
    join(betaDir, "parked", "301.json"),
    JSON.stringify({
      taskId: "301",
      parkedAt: "2025-06-14T09:00:00.000Z",
      reason: "question",
      branch: "agent/301",
      question: "Which colour for the badge?",
    }),
  );

  const { parked } = buildLanding([pointerFor("alpha", alphaDir), pointerFor("beta", betaDir)], new Date("2025-06-15T12:00:00.000Z"));

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
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", waves: [["101", "102"]], slots: 1 }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "101" }),
    event("spawn", { ts: "2025-01-01T00:02:00.000Z", taskId: "102" }),
    event("green", { ts: "2025-01-01T00:03:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("parked", { ts: "2025-01-01T00:04:00.000Z", taskId: "101", reason: "conflict", detail: "CONFLICT" }),
    event("parked", { ts: "2025-01-01T00:05:00.000Z", taskId: "102", reason: "question" }),
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({
      taskId: "102",
      parkedAt: "2025-01-01T00:05:00.000Z",
      reason: "question",
      branch: "agent/102",
      question: "Which approach?",
    }),
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

test("cardState folds a card's state, failure outranking parked, completed/none → idle (ADR 0019)", () => {
  const wave = (status: "running" | "parked" | "failed" | "completed" | "unstarted", issues: { issueNumber: string; status: string }[]) => [
    { index: 0, status, issues: issues as any },
  ];
  // failure outranks parked now — the deliberate reversal of the old parked-first order:
  // a broken issue is a louder signal than a held one. A failed wave reads failure even
  // with a surviving parked record.
  assert.equal(
    cardState({
      project: "p",
      waves: wave("failed", [
        { issueNumber: "1", status: "failed" },
        { issueNumber: "2", status: "running" },
      ]),
      parked: [{ issueNumber: "3" }] as any,
    }),
    "failed",
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
      waves: wave("completed", [{ issueNumber: "1", status: "completed" }]),
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
      waves: wave("completed", [{ issueNumber: "1", status: "completed" }]),
      parked: [],
    }),
    "idle",
  );
  // No live run at all reads idle.
  assert.equal(cardState({ project: "p", waves: [], parked: [] }), "idle");
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
  const ts = "2025-01-01T00:00:00.000Z";
  seedState(dir, [
    event("campaign-start", { ts, waves: [["101"], ["201"]], slots: 1, name: "gateway work" }),
    event("wave-start", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["201", "202"] }),
  ]);
  const pointers = [pointerFor("demo", dir)];
  // Off — today's plain narration lists the member ids (no title resolved → `#id`).
  assert.equal(buildLanding(pointers, new Date("2025-01-02T00:00:00.000Z")).projects[0].lastEvent, "Wave 2 — #201, #202 started");
  // On — the wave draws its festive name off the offset derived from the campaign-start ts,
  // and lists the member issue numbers inline.
  const festiveName = festiveWaveName(festiveOffsetFor(ts), 1);
  assert.equal(
    buildLanding(pointers, new Date("2025-01-02T00:00:00.000Z"), undefined, true).projects[0].lastEvent,
    `Wave 2 · ${festiveName} · #201, #202 started`,
  );
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
  assert.equal(parsePruneClosure("prune #201 → nothing to drop\nremaining campaign: (nothing left to run)"), null);
});

test("listArchivedRuns lists a project's archived runs newest-first with summaries, skipping a malformed file", () => {
  const dir = join(tmpdir(), `vetinari-archive-list-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["101"]], slots: 1 }),
    event("campaign-done", { waves: 1 }),
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["201"], ["202"]], slots: 1 }),
    event("campaign-done", { waves: 2 }),
  ]);
  // A malformed archive (no reconstructable run) is skipped, not fatal — even
  // though its timestamp is the newest.
  writeFileSync(join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"), "not json at all\n{broken");

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
  assert.ok(runs[0].file.endsWith("orchestrator-2026-02-01T00-00-00-000Z.jsonl"));
});

test("listArchivedRuns carries a named run's --name for the list's primary label", () => {
  const dir = join(tmpdir(), `vetinari-archive-named-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["101"]], name: "gateway + comms", slots: 1 }),
    event("campaign-done", { waves: 1 }),
  ]);

  const runs = listArchivedRuns(dir);
  assert.equal(runs[0].name, "gateway + comms");
});

test("listArchivedRuns returns nothing when a project has no archive directory", () => {
  assert.deepEqual(listArchivedRuns(join(tmpdir(), `vetinari-archive-none-${Date.now()}`)), []);
});

test("parseRunTimestamp reverses an archive run token to an ISO timestamp, tolerating older tokens", () => {
  // The token `archiveRun` writes: `toISOString().replace(/[:.]/g, "-")`.
  assert.equal(parseRunTimestamp("2026-08-23T22-22-36-267Z"), "2026-08-23T22:22:36.267Z");
  // Older archives were written without milliseconds and/or the trailing Z.
  assert.equal(parseRunTimestamp("2025-06-10T00-00-00"), "2025-06-10T00:00:00.000Z");
  // A token that isn't a timestamp yields undefined, so the row falls back to it verbatim.
  assert.equal(parseRunTimestamp("not-a-stamp"), undefined);
});

test("listArchivedRuns carries each run's state, startedAt and issue count, derived from the log", () => {
  const dir = join(tmpdir(), `vetinari-archive-fields-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  // A clean run that reached campaign-done: complete, three issues.
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["101", "102"], ["201"]], slots: 1 }),
    event("campaign-done", { waves: 2 }),
  ]);
  // A run whose log has a campaign-start but no terminal event — the process was
  // killed mid-wave, so it reads stalled and expands to its partial waves (ADR 0019).
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { waves: [["301"], ["302"]], slots: 1 }),
    event("wave-start", { index: 0, tasks: ["301"] }),
  ]);
  const runs = listArchivedRuns(dir);
  const byRun = Object.fromEntries(runs.map((r) => [r.run, r]));

  assert.equal(byRun["2026-01-01T00-00-00-000Z"].state, "complete");
  assert.equal(byRun["2026-01-01T00-00-00-000Z"].issues, 3);
  assert.equal(byRun["2026-01-01T00-00-00-000Z"].startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].state, "stalled");
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].issues, 2);
});

test("summarizeRun folds an archived log into a one-line mode/issue-count/outcome summary", () => {
  // A finished campaign of two waves (three issues total) that completed.
  assert.equal(
    summarizeRun([event("campaign-start", { waves: [["101", "102"], ["201"]], slots: 1 }), event("campaign-done", { waves: 2 })]),
    "campaign · 3 issues · complete",
  );
  // A campaign whose one issue failed (the agent could not make it green) — singular noun.
  assert.equal(
    summarizeRun([event("campaign-start", { waves: [["101"]], slots: 1 }), event("failed", { taskId: "101" })]),
    "campaign · 1 issue · failed",
  );
  // A run with no campaign frame reads as a queue of its task ids.
  assert.equal(
    summarizeRun([
      event("spawn", { taskId: "101" }),
      event("spawn", { taskId: "102" }),
      event("green", { taskId: "101", branch: "agent/101", commits: [] }),
      event("green", { taskId: "102", branch: "agent/102", commits: [] }),
    ]),
    "queue · 0 issues · complete",
  );
});

test("summarizeRun describes only the last run in a multi-run archive (#69)", () => {
  // An archive whose live log accumulated two campaigns before it was archived: an
  // earlier run failed on #61, then a fresh campaign ran the remainder to completion.
  // The summary must reflect the terminal run — complete, four issues — not fold the
  // stale failure from the superseded earlier run into a false "failed", and its
  // count must be the last run's, not the whole file's.
  const events = [
    event("campaign-start", { waves: [["56", "57"], ["61"]], slots: 1, name: "first" }),
    event("failed", { taskId: "61" }),
    event("campaign-start", { waves: [["63"], ["64"], ["65"], ["67"]], slots: 1, name: "second" }),
    event("wave-done", { index: 0, merged: ["63"] }),
    event("wave-done", { index: 1, merged: ["64"] }),
    event("wave-done", { index: 2, merged: ["65"] }),
    event("wave-done", { index: 3, merged: ["67"] }),
    event("campaign-done", { waves: 4 }),
  ];
  assert.equal(summarizeRun(events), "campaign · 4 issues · complete");
});

test("summarizeRun still reports failed when the last run failed after an earlier one completed (#69)", () => {
  // The mirror case: an earlier run completed, then a fresh campaign failed on an
  // issue. The terminal run failed, so the summary must say failed — the scoping must
  // not swing the other way and hide a genuine failure behind an earlier clean run.
  const events = [
    event("campaign-start", { waves: [["101"]], slots: 1, name: "first" }),
    event("campaign-done", { waves: 1 }),
    event("campaign-start", { waves: [["201"], ["202"]], slots: 1, name: "second" }),
    event("failed", { taskId: "201" }),
  ];
  assert.equal(summarizeRun(events), "campaign · 2 issues · failed");
});

test("appendedEvents returns the whole log and its end offset from a zero offset", () => {
  const log =
    JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n" + JSON.stringify(event("spawn", { taskId: "101" })) + "\n";
  const { events, offset } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start", "spawn"],
  );
  assert.equal(offset, log.length);
});

test("appendedEvents returns only the events appended past a prior offset", () => {
  const first = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
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
  const complete = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
  const partial = '{"event":"turn"';
  const mid = appendedEvents(complete + partial, 0);
  // Only the complete line is consumed; the offset stops before the partial line.
  assert.deepEqual(
    mid.events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(mid.offset, complete.length);
  // Once the line is finished, resuming from the same offset yields it whole.
  const done = appendedEvents(complete + partial + ',"taskId":"101"}\n', mid.offset);
  assert.deepEqual(
    done.events.map((e) => e.event),
    ["turn"],
  );
});

test("appendedEvents re-reads from the start when the log is shorter than the offset (rotated/truncated)", () => {
  const rotated = JSON.stringify(event("campaign-start", { waves: [], slots: 1 })) + "\n";
  const { events, offset } = appendedEvents(rotated, 9999);
  assert.deepEqual(
    events.map((e) => e.event),
    ["campaign-start"],
  );
  assert.equal(offset, rotated.length);
});

test("appendedEvents skips an unparseable line the way readEventLog does", () => {
  const log = "not json\n" + JSON.stringify(event("spawn", { taskId: "101" })) + "\n";
  const { events } = appendedEvents(log, 0);
  assert.deepEqual(
    events.map((e) => e.event),
    ["spawn"],
  );
});

test("viewRelevantEvents drops known machine-noise the live view never shows, fail-open on the rest (#131)", () => {
  const events: OrchestratorEvent[] = [
    event("green", { taskId: "101", branch: "agent/101", commits: [] }),
    noise({ event: "telegram-send-failed", chatId: "42" }),
    event("turn", { taskId: "101", turn: 0, summary: "" }),
    noise({ event: "outbound-enqueued", kind: "wave-start" }),
    event("parked", { taskId: "202", reason: "question" }),
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

test("buildStatus carries the stop pending flag off the event log (#432)", () => {
  const dir = join(tmpdir(), `vetinari-stop-pending-${Date.now()}`);
  const start = event("campaign-start", { waves: [["201"]], slots: 1 });
  const wave = event("wave-start", { index: 0, tasks: ["201"] });
  seedState(dir, [start, wave]);
  assert.equal(buildStatus(cfgFor(dir)).stopPending, false);
  seedState(dir, [start, wave, event("stop-requested", { index: 0 })]);
  assert.equal(buildStatus(cfgFor(dir)).stopPending, true);
});
