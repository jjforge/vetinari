// Tests for the all-repos landing and the cross-project feed (dashboard-landing.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeed, buildLanding, cardState } from "./dashboard-landing.ts";
import { describeEvent, festiveOffsetFor } from "./dashboard-event-text.ts";
import { parseRunTimestamp } from "./dashboard-archived-runs.ts";
import { buildStatus, statusConfigFromPointer } from "./dashboard-status.ts";
import { event } from "./event-log.ts";
import { festiveWaveName } from "./festive-names.ts";
import type { ProjectPointer } from "./registry.ts";

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
