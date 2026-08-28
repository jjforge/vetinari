import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  ARCHIVE_LIST_SCRIPT,
  DASHBOARD_PALETTE_CSS,
  ISSUE_DETAIL_SHEET_SCRIPT,
  ISSUE_DETAIL_SHEET_STYLES,
  REPO_DROPDOWN_SCRIPT,
  STATE_DOT_CSS,
  stateColor,
  TOP_BAR_STYLES,
} from "./dashboard-assets.ts";
import {
  appendedEvents,
  archiveStatusConfig,
  archivedRunState,
  buildAllStatus,
  buildFeed,
  buildLanding,
  buildStatus,
  buildStatusWithIssueNames,
  campaignRunning,
  cappedRawRows,
  describeEvent,
  event,
  extractParkedDetails,
  formatFeedEvent,
  issueStateFromTask,
  formatStatusText,
  highlightJsonLine,
  issueDetailSheetMarkup,
  isNotableHostEvent,
  lastEventText,
  listArchivedRuns,
  ownerRepoFromRemote,
  parkedReplyFor,
  parseCarveClosure,
  parseRunTimestamp,
  reconcileArchivedStatus,
  reconstructIssueDetail,
  projectRunState,
  reduceCampaign,
  renderLandingShell,
  viewRelevantEvents,
  renderStatusPage,
  renderTopBar,
  selectStatus,
  serveAllStatus,
  summarizeRun,
} from "./status.ts";
import type { CampaignStatus, OrchestratorEvent } from "./status.ts";
import type { AddressInfo } from "node:net";
import { register, type ProjectPointer } from "./registry.ts";
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

test("buildLanding's card counts the live plan, not carved chips", () => {
  const base = join(tmpdir(), `vetinari-landing-carved-${Date.now()}`);
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
    // The future, unstarted wave 301 is carved out — a display ghost, not live work.
    event("carve", {
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

  // Two live waves remain (101 closed, 201 running); the carved-out 301 wave and its
  // chip do not inflate the count, the "queued" tally, or drag down percent merged.
  assert.deepEqual(card.wave, { current: 2, total: 2 });
  assert.deepEqual(card.tally, { running: 1, parked: 0, queued: 0 });
  assert.equal(card.percentMerged, 50);
  assert.equal(card.runState, "running");
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

test("serveAllStatus serves the aggregated site, selecting the project from the query param", async () => {
  const configDir = join(tmpdir(), `vetinari-serve-all-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    // A bare open lands on the all-repos shell; its dropdown lists both projects with All repos current.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);

    const beta = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    assert.match(beta, /<option value="beta" selected>/);
    // Beta's own campaign (issue 201) renders in the body, not alpha's issue 101.
    assert.match(beta, /#201 <small>/);
    assert.doesNotMatch(beta, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("renderLandingShell's card heading shows owner/name, but links and keys on the bare project", () => {
  const html = renderLandingShell(["alpha"]);
  // The card heading reads the card's owner/name, falling back to the bare key when absent.
  assert.match(html, /"card-project", p\.repo \?\? p\.project/);
  // Routing stays keyed on the bare project: the card href is the bare project key.
  assert.match(
    html,
    /card\.href = "\/\?project=" \+ encodeURIComponent\(p\.project\)/,
  );
});

test("renderLandingShell is single-column on mobile with 44px tap targets", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The cards collapse to one column on a phone.
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /\.cards \{ grid-template-columns: 1fr; \}/);
  // The two tappable controls — the project dropdown and each card — are at least 44px.
  assert.match(html, /\.project-picker select \{[^}]*min-height: 44px/);
  assert.match(html, /\.card \{[^}]*min-height: 44px/);
});

// The set of palette tokens defined by a `:root { … }` block, and the set of
// `var(--token)` references anywhere in a page — the two must agree, or a surface
// references a colour that never resolves (the #78 class of bug).
const definedTokens = (css: string) =>
  new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
const referencedTokens = (html: string) =>
  new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));

test("the card/chip colour rules are landed as a normative doc that pins the palette (#83)", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "..", "docs", "dashboard-color-rules.md"),
    "utf8",
  );
  // The doc is the reference: it carries the §1 palette at the exact hexes the code uses.
  for (const hex of [
    "#6cb6ff",
    "#c8a24e",
    "#f85149",
    "#5f6b78",
    "#3fb984",
    "#a371f7",
    "#f79287",
    "#10151b",
    "#0b0e12",
  ]) {
    assert.ok(doc.includes(hex), `the colour-rules doc pins ${hex}`);
  }
  // And it states the derivation precedence and the teal-is-not-a-state rule.
  assert.match(doc, /parked > failure > running > unstarted > completed/);
  assert.match(
    doc,
    /never appear on a status chip or a card edge|never a state/,
  );
});

test("the dashboard palette is one shared source defining every state token at its spec hex (#83)", () => {
  // §1: the six ADR-0007 states plus the carve action, each at its exact hex.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-blue: #6cb6ff/); // running
  assert.match(DASHBOARD_PALETTE_CSS, /--color-yellow: #c8a24e/); // parked
  assert.match(DASHBOARD_PALETTE_CSS, /--color-failure: #f85149/); // failure — distinct red
  assert.match(DASHBOARD_PALETTE_CSS, /--color-dim: #5f6b78/); // unstarted / idle grey
  assert.match(DASHBOARD_PALETTE_CSS, /--color-green: #3fb984/); // completed
  assert.match(DASHBOARD_PALETTE_CSS, /--color-carved: #a371f7/); // carved
  assert.match(DASHBOARD_PALETTE_CSS, /--color-red: #f79287/); // carve action — a control, never a state
  // The carve action and the failure state are deliberately different reds.
  assert.notEqual("#f85149", "#f79287");
  // The teal product accent is present but is not a state colour.
  assert.match(DASHBOARD_PALETTE_CSS, /--color-primary: #3fb9b0/);
});

test("both the landing and the campaign page emit the one shared palette, and every colour they reference resolves (#78, #83)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { carve: true },
  );
  // The palette is included verbatim by both surfaces — one source, not a per-renderer copy.
  assert.ok(
    landing.includes(DASHBOARD_PALETTE_CSS),
    "landing includes the shared palette",
  );
  assert.ok(
    campaign.includes(DASHBOARD_PALETTE_CSS),
    "campaign page includes the shared palette",
  );
  // Every colour token either page references is actually defined — so `--color-carved`
  // (and every other token) resolves identically on `/` and `/?project=…`, not merely
  // referenced (the blind spot #78's original rule-string test had).
  const defined = definedTokens(DASHBOARD_PALETTE_CSS);
  for (const page of [landing, campaign]) {
    for (const token of referencedTokens(page)) {
      assert.ok(
        defined.has(token),
        `${token} is referenced but never defined in the shared palette`,
      );
    }
  }
  // The concrete #78 repro: carved is referenced on the landing (feed, dots, turn log) and resolves.
  assert.ok(
    referencedTokens(landing).has("--color-carved"),
    "landing references --color-carved",
  );
  assert.ok(defined.has("--color-carved"), "--color-carved resolves");
});

// A running-wave campaign page with one issue chip and a parked card — enough
// surface to assert the §4/§6 chip and card rules against.
const chipCampaign = () =>
  renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "1", status: "running" }],
        },
      ],
      parked: [
        {
          issueNumber: "2",
          reason: "blocked",
          parkedAt: "2025-06-15T09:00:00.000Z",
          branch: "agent/2",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { carve: true },
  );

test("cards fill card-grey and chips fill the darker panel with a 40%-alpha state border (§4, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = chipCampaign();
  // The two fills are distinct: cards #10151b, chips the darker #0b0e12 (chips sit on cards).
  assert.match(DASHBOARD_PALETTE_CSS, /--color-card: #10151b/);
  assert.match(DASHBOARD_PALETTE_CSS, /--color-chip: #0b0e12/);
  // Landing project cards and campaign wave cards take the card fill.
  assert.match(landing, /\.card \{[^}]*background: var\(--color-card\)/);
  assert.match(campaign, /\.wave \{[^}]*background: var\(--color-card\)/);
  // The state pill and closed-wave chip take the darker panel fill — never a coloured fill (§4).
  assert.match(
    campaign,
    /\.wave-status, \.completed-wave-chip \{[^}]*background: var\(--color-chip\)/,
  );
  // A member row carries its status class and borders that status at 40% alpha (§4).
  assert.match(campaign, /class="wave-member running"/);
  assert.match(
    campaign,
    /\.wave-member\.running \{ border-color: var\(--color-blue-40\); \}/,
  );
  assert.match(
    campaign,
    /\.wave-member\.parked \{ border-color: var\(--color-yellow-40\); \}/,
  );
  assert.match(
    campaign,
    /\.wave-member\.carved \{ border-color: var\(--color-carved-40\); \}/,
  );
});

test("cards and chips lift only their fill on hover, never recolouring their edge; teal never colours an edge (§6, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = chipCampaign();
  // Card / member row / parked-row hover lifts the fill only — the coloured edge is unchanged.
  assert.match(
    landing,
    /\.card:hover \{ background: var\(--color-card-hover\); \}/,
  );
  assert.match(
    campaign,
    /\.wave-member:hover[^{]*\{ background: var\(--color-chip-hover\); \}/,
  );
  assert.match(
    landing,
    /\.parked-row:hover \{ background: var\(--color-card-hover\); \}/,
  );
  assert.match(
    campaign,
    /\.parked-card:hover \{ background: var\(--color-card-hover\); \}/,
  );
  // No card/row hover recolours a border — the accent must not creep onto an edge.
  assert.doesNotMatch(landing, /\.card:hover \{[^}]*border-color/);
  assert.doesNotMatch(campaign, /\.wave-member:hover[^}]*border-color/);
  assert.doesNotMatch(landing, /\.parked-row:hover[^}]*border-color/);
  // §2: a card carries state colour on exactly one edge — never a coloured bottom or right.
  for (const page of [landing, campaign]) {
    assert.doesNotMatch(
      page,
      /border-(bottom|right)-color: var\(--color-(blue|yellow|green|failure|carved|dim)\)/,
    );
  }
});

test("the issue-detail sheet carries the issue's state on its top edge only (§2, #83)", () => {
  // The sheet is a stateful card, so its state reads on a 2px top border, derived
  // from stateColor — the other three edges stay the neutral 1px.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-sheet \{[^}]*border-top: 2px solid/,
  );
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-sheet\.parked \{ border-top-color: var\(--color-yellow\); \}/,
  );
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-sheet\.completed \{ border-top-color: var\(--color-green\); \}/,
  );
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-sheet\.failure \{ border-top-color: var\(--color-failure\); \}/,
  );
  // The sheet's state class is set from the fetched issue status when the detail renders,
  // and reset while a fresh issue is loading.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /"issue-detail-sheet " \+ d\.status/);
  // The parked-question / reply block is part of the human-action queue, so it carries
  // the 3px amber left edge (§2) — the block only shows for a parked issue.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.issue-detail-reply \{[^}]*border-left: 3px solid var\(--color-yellow\)/,
  );
});

test("motion is a running/stream channel only: green live dots pulse while live, a single root paused flag freezes every pulse (§5, #100)", () => {
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ]) {
    // The green live dots pulse whenever live — they track the stream, so there is no
    // per-element running-gate or live-state rule on the live-indicator any more.
    assert.match(html, /\.live-indicator::before \{[^}]*animation: chip-pulse/);
    assert.doesNotMatch(html, /data-running/);
    assert.doesNotMatch(html, /\.live-indicator\[data-live-state="paused"\]/);
    assert.doesNotMatch(html, /\.live-bar:not\(\[data-running/);
    // One root flag freezes every pulse at once — green live dots and blue running dots —
    // so pause never has to reach each dot per-element (the reworked #100 design).
    assert.match(
      html,
      /\[data-paused="true"\] \.live-indicator::before, \[data-paused="true"\] \.dot\.running \{ animation: none; \}/,
    );
    // The pause-bar dot also goes dim while paused, keyed off that same root flag (not a
    // per-element live-state rule); the event-log dot just goes still.
    assert.match(
      html,
      /\[data-paused="true"\] \.live-bar \.live-indicator \{ color: var\(--color-dim\); \}/,
    );
    // The only colour-bearing animation anywhere is chip-pulse — nothing else animates (§5).
    assert.deepEqual(
      [...new Set([...html.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]))],
      ["chip-pulse"],
    );
  }
});

test("green live dots pulse when live even with zero running — they track the stream, not work (§5, #100)", () => {
  // Regression guard for the misdirected first #100 attempt: it hung a running-gate on the
  // green dot so an idle campaign (0 running) stopped pulsing. The green dots must stay live.
  const idle = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "1", status: "completed" }] }],
    parked: [],
  });
  assert.doesNotMatch(idle, /data-running/);
  assert.match(idle, /\.live-indicator::before \{[^}]*animation: chip-pulse[^}]*infinite/);
});

test("an idle running tally renders a solid blue dot with no pulse; genuinely-running dots still pulse (§5, #100)", () => {
  const html = renderLandingShell(["alpha"]);
  // A card's blue running-dots track work: a "0 running" tally is idle, so its dot is
  // solid blue but must not pulse (the pulse means active work). The idle rule is the
  // pure `tallyDotClass` (dashboard-visual-state.ts) — asserted directly there
  // (count=0 ⇒ "running idle") — single-sourced into this page via `.toString()` and
  // called on the tally dot, so the browser runs the very function the node test pins.
  assert.match(html, /function tallyDotClass/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // CSS: a .dot.running is blue and pulses by default; an idle (zero-count) one is stilled,
  // keeping the blue but dropping the motion.
  assert.match(html, /\.dot\.running \{ background: var\(--color-blue\); \}/);
  assert.match(html, /\.dot\.running\.idle \{ animation: none; \}/);
  // The base running dot still pulses — a wave member with real running work is unaffected.
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
});

test("both pages toggle a root paused flag on the body so one rule freezes every dot (§5, #100)", () => {
  // The pause script owns the single control: it flips data-paused on the body, the common
  // root above both the green live dots and the blue running dots. Nothing else per-element.
  // The single root flag is `freezeIntent(...).bodyPaused` (dashboard-visual-state.ts,
  // asserted directly there: true⇒"true", false⇒"false"), which the glue writes onto the
  // body — the one place pause reaches, never per-element.
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ])
    assert.match(html, /document\.body\.dataset\.paused = intent\.bodyPaused/);
});

test("projectRunState resolves a card's state by the §3 precedence: parked > failure > running > completed (#83)", () => {
  const wave = (issues: { issueNumber: string; status: string }[]) => [
    { index: 0, status: "running" as const, issues: issues as any },
  ];
  // The most human-blocking state wins. A parked question beats a failure and any
  // number of running agents — it is the most direct ask (a change from the old
  // failure-first order).
  assert.equal(
    projectRunState({
      project: "p",
      waves: wave([
        { issueNumber: "1", status: "failure" },
        { issueNumber: "2", status: "running" },
      ]),
      parked: [{ issueNumber: "3" }] as any,
    }),
    "parked",
  );
  // With no parked question, failure ranks next — above work still in flight.
  assert.equal(
    projectRunState({
      project: "p",
      waves: wave([
        { issueNumber: "1", status: "failure" },
        { issueNumber: "2", status: "running" },
      ]),
      parked: [],
    }),
    "failure",
  );
  // Then running, then all-done completed.
  assert.equal(
    projectRunState({
      project: "p",
      waves: wave([{ issueNumber: "1", status: "running" }]),
      parked: [],
    }),
    "running",
  );
  assert.equal(
    projectRunState({
      project: "p",
      waves: wave([{ issueNumber: "1", status: "completed" }]),
      parked: [],
    }),
    "completed",
  );
  // No live run at all reads idle.
  assert.equal(
    projectRunState({ project: "p", waves: [], parked: [] }),
    "idle",
  );
});

test("stateColor is the single state→colour derivation, failure distinct from the carve action (#83)", () => {
  // §3: every state derives its colour here, never a per-instance hex.
  assert.equal(stateColor("running"), "var(--color-blue)");
  assert.equal(stateColor("parked"), "var(--color-yellow)");
  assert.equal(stateColor("completed"), "var(--color-green)");
  assert.equal(stateColor("carved"), "var(--color-carved)");
  // unstarted (and its landing display aliases) are the dim grey, not the muted one.
  assert.equal(stateColor("unstarted"), "var(--color-dim)");
  assert.equal(stateColor("queued"), "var(--color-dim)");
  assert.equal(stateColor("idle"), "var(--color-dim)");
  // failure has its own token, distinct from the carve action's --color-red (§1).
  assert.equal(stateColor("failure"), "var(--color-failure)");
  assert.notEqual(stateColor("failure"), "var(--color-red)");
});

test("both pages share one set of status-dot rules, scoped to .dot so a state never tints a whole card or row (#81, #83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "1", status: "carved" }],
        },
      ],
      parked: [],
    },
    { carve: true },
  );
  // The dot rules are one generated source, included verbatim by both surfaces.
  assert.ok(
    landing.includes(STATE_DOT_CSS),
    "landing includes the shared dot rules",
  );
  assert.ok(
    campaign.includes(STATE_DOT_CSS),
    "campaign page includes the shared dot rules",
  );
  // Every status colour is scoped to `.dot` — the campaign page no longer emits the
  // bare `.completed {…}` / `.carved {…}` rules that leaked colour onto struck-through
  // list rows and other elements sharing the class name (#81).
  assert.match(
    campaign,
    /\.dot\.carved \{ background: var\(--color-carved\); \}/,
  );
  // A bare status-class rule sits at a selector boundary (start of a line, after
  // whitespace) — the shared dot rules are all `.dot.<state>`, never bare. So none of
  // these leak-prone bare rules should appear on the campaign page any more.
  assert.doesNotMatch(campaign, /\n\s*\.carved \{ background/);
  assert.doesNotMatch(campaign, /\n\s*\.completed \{ background/);
  assert.doesNotMatch(campaign, /\n\s*\.parked \{ background/);
});

test("failure renders in its own red on every surface, never the carve action's red (#83)", () => {
  const landing = renderLandingShell(["alpha"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { carve: true },
  );
  // The activity feed, the card highlight, and the run-state pill all read failure
  // in --color-failure; the carve controls keep --color-red.
  assert.match(
    landing,
    /\.feed-kind\.failure::before \{ background: var\(--color-failure\); \}/,
  );
  assert.match(
    landing,
    /\.card\.failure \{ border-top-color: var\(--color-failure\); \}/,
  );
  assert.match(
    landing,
    /\.run-state\.failure \{ border-color: var\(--color-failure\); color: var\(--color-failure\); \}/,
  );
  // The shared turn-log failure number reads --color-failure; carve controls stay --color-red.
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.turn-num\.failure \{ color: var\(--color-failure\); \}/,
  );
  assert.match(
    ISSUE_DETAIL_SHEET_STYLES,
    /\.carve-start[^{]*\{[^}]*var\(--color-red\)/,
  );
  assert.ok(
    campaign.includes(".turn-num.failure { color: var(--color-failure); }"),
  );
});

test("renderLandingShell mounts the cross-project feed under the cards on every width", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The feed container sits after the cards and is client-rendered off /api/feed.
  assert.match(html, /id="feed"/);
  assert.match(html, /\/api\/feed/);
  assert.ok(
    html.indexOf('id="cards"') < html.indexOf('id="feed"'),
    "the feed renders after the cards",
  );
  // The event log now shows on a phone too (#125): the mobile block no longer
  // hides `.feed`, so iOS Safari at an iPhone width renders it under the cards.
  const mobileBlock = html.match(
    /@media \(max-width: 640px\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(mobileBlock, "the landing has a ≤640px mobile media block");
  assert.doesNotMatch(mobileBlock[0], /\.feed \{ display: none; \}/);
});

test("renderLandingShell parked counter expands a cross-repo parked queue in place", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The parked counter is an interactive toggle, unlike the other three counters —
  // a button controlling the queue panel, inert (disabled) until the client learns
  // there is at least one parked question.
  assert.match(
    html,
    /<button[^>]*class="counter counter-toggle"[^>]*data-counter="parked"[^>]*disabled[^>]*aria-controls="parked-queue"/,
  );
  // The queue panel sits between the counters and the cards, so expanding it pushes
  // the cards down while keeping them visible; it starts hidden.
  assert.match(html, /<section id="parked-queue"[^>]*hidden/);
  assert.ok(
    html.indexOf('id="parked-queue"') < html.indexOf('id="cards"'),
    "parked queue renders above the cards",
  );
  // The client renders one row per parked question, oldest first from data.parked,
  // each opening that repo's issue detail, showing repo, issue number, the full
  // question and how long it has waited.
  assert.match(html, /data\.parked/);
  assert.match(html, /\/\?project=/);
  assert.match(html, /fmtWaited/);
  // The counter is inert (disabled, no arrow/cursor) when there are no parked
  // questions, and becomes a working toggle when there are.
  assert.match(html, /\.counter-toggle:disabled/);
  assert.match(html, /aria-expanded/);
  // The parked rows collapse to a readable stack on a phone.
  assert.match(html, /\.parked-row/);
  // `.parked-queue { display: grid }` otherwise defeats the UA `[hidden]` rule, so
  // the collapse rule must be restored explicitly or clicking the counter flips the
  // caret but never hides the panel (#71).
  assert.match(html, /\.parked-queue\[hidden\] \{ display: none;? \}/);
});

test("renderLandingShell opens a parked-queue row's issue detail inline, not by navigating (#74)", () => {
  const html = renderLandingShell(["alpha"]);
  // The landing now hosts the issue-detail sheet (the same one the campaign page has).
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="reply-resume"/);
  assert.match(html, /id="carve-panel"/);
  // openIssue is defined here, and a parked row opens it in place — the click is
  // intercepted so the row never does the full navigation to the campaign page.
  assert.match(html, /const openIssue = async \(project, issue, carvable, run\)/);
  assert.match(
    html,
    /row\.addEventListener\("click", \(event\) => \{ event\.preventDefault\(\); openIssue\(p\.project, p\.issueNumber, true\); \}\)/,
  );
  // The sheet's collapse rules are present so a flex display can't defeat [hidden].
  assert.match(html, /\.issue-detail\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.carve-panel\[hidden\] \{ display: none; \}/);
  // The status dot colours are scoped to .dot so they don't tint the run-state pills.
  assert.match(html, /\.dot\.parked \{ background: var\(--color-yellow\); \}/);
});

test("the issue-detail sheet markup, CSS, and script are defined once and shared by both pages (#76)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  // The campaign page renders the sheet with its carve panel when carve is on and
  // without it otherwise; the landing always hosts the carve-enabled sheet.
  const campaignCarve = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { carve: true },
  );
  const campaignPlain = renderStatusPage({
    project: "beta",
    waves: [],
    parked: [],
  });

  // Markup: one helper, rendered verbatim by both pages. The landing and the
  // carve-enabled campaign page share the carve-panel variant; a plain campaign
  // page shares the no-carve variant.
  assert.ok(landing.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignCarve.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPlain.includes(issueDetailSheetMarkup(false)));
  // The no-carve variant has no carve panel; the carve variant does.
  assert.ok(!issueDetailSheetMarkup(false).includes("carve-panel"));
  assert.ok(issueDetailSheetMarkup(true).includes('id="carve-panel"'));

  // CSS: one definition of the sheet styles, included by both pages verbatim.
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".issue-detail-sheet {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".turn-log {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".sheet-actions {"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_STYLES));
  assert.ok(campaignCarve.includes(ISSUE_DETAIL_SHEET_STYLES));

  // Script: one definition of the sheet behaviour (openIssue/renderDetail/
  // renderReply/closeSheet/carve wiring), included by both pages verbatim.
  assert.ok(
    ISSUE_DETAIL_SHEET_SCRIPT.includes(
      "const openIssue = async (project, issue, carvable, run)",
    ),
  );
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("const closeSheet = () =>"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_SCRIPT));
  assert.ok(campaignCarve.includes(ISSUE_DETAIL_SHEET_SCRIPT));

  // The hand-sync note is gone now that the sheet has a single source.
  assert.ok(!landing.includes("#76"));
  assert.ok(!landing.includes("kept in sync"));
});

test("renderLandingShell reads each event kind's category as a leading dot, label at full strength (#85)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each feed row's kind carries a category class so its dot reads in that colour.
  assert.match(html, /"feed-kind " \+ feedKindClass\(e\.kind\)/);
  // The classifier maps the orchestrator's event kinds to comms categories.
  assert.match(html, /const feedKindClass = /);
  // The label text stays full-strength --color-text — never a mid-tone tint on
  // near-black (which struck out the blue progress kind, #85).
  assert.match(html, /\.feed-kind \{ color: var\(--color-text\);/);
  // The category colour renders full-strength on the small leading-dot surface.
  assert.match(
    html,
    /\.feed-kind::before \{[^}]*background: var\(--color-dim\);/,
  );
  assert.match(
    html,
    /\.feed-kind\.success::before \{ background: var\(--color-green\); \}/,
  );
  assert.match(
    html,
    /\.feed-kind\.attention::before \{ background: var\(--color-yellow\); \}/,
  );
  assert.match(
    html,
    /\.feed-kind\.progress::before \{ background: var\(--color-blue\); \}/,
  );
  assert.match(
    html,
    /\.feed-kind\.failure::before \{ background: var\(--color-failure\); \}/,
  );
  assert.match(
    html,
    /\.feed-kind\.carved::before \{ background: var\(--color-carved\); \}/,
  );
});

test("renderLandingShell's feed caps at 20 rows behind a show-older control and reads the 48h empty state (#101)", () => {
  const html = renderLandingShell(["alpha"]);
  // The empty window reads the feed's own copy, not the live-only "No activity yet".
  assert.match(html, /No activity in the last 48 hours\./);
  assert.ok(!html.includes("No activity yet."), "the live-only empty state is gone from the feed");
  // The newest 20 render; the rest render hidden behind a "show older" control that
  // mirrors the archived-runs list (its `archive-show-older` affordance), revealing
  // the remaining in-window rows in place.
  assert.match(html, /const FEED_CAP = 20;/);
  // The control reuses the archived-runs list's `archive-show-older` affordance.
  assert.match(html, /el\("button", "archive-show-older"/);
  assert.match(html, /older event/);
  // `.feed-row { display: flex }` is an author rule that beats the UA `[hidden]`
  // rule, so a hidden row would still paint (the whole 48h window, ~64,000px tall)
  // unless display is restored explicitly — the archived-runs list guards the same
  // trap with `.archive-row[hidden] { display: none }`. Assert the computed hiding
  // (the CSS rule), not merely that `r.hidden` is set (#101).
  assert.match(html, /\.feed-row\[hidden\] \{ display: none;? \}/);
});

test("renderLandingShell's feed reads as an event log: 'Event log · all repos' header with a live dot (#95)", () => {
  const html = renderLandingShell(["alpha"]);
  // The feed header takes the POC's event-log treatment: the "Event log · all repos"
  // label carrying a live indicator, replacing the old "Recent activity" heading.
  assert.match(html, /<h2[^>]*>[\s\S]*?Event log · all repos[\s\S]*?<\/h2>/);
  assert.ok(!html.includes("Recent activity"), "the old heading is gone");
  // The live indicator (the shared pulsing dot) rides in the feed header.
  assert.match(html, /<h2[^>]*>[\s\S]*?class="live-indicator"[\s\S]*?<\/h2>/);
});

test("renderLandingShell's feed timestamps are compact HH:MM, weekday/date for older entries (#95)", () => {
  const html = renderLandingShell(["alpha"]);
  // fmtTime drops the old full `M/D/YYYY, h:mm:ss AM` (toLocaleString) treatment for
  // the POC's compact time: HH:MM for a same-day event, a weekday label for older.
  assert.ok(!html.includes("toLocaleString()"), "the full date-time is gone");
  // A same-day event reads as a 24h HH:MM slice of the time.
  assert.match(html, /toTimeString\(\)\.slice\(0, 5\)/);
  // An older event falls back to a short weekday label (POC's `Tue`).
  assert.match(html, /weekday: "short"/);
});

test("renderLandingShell's feed relabels the real event kinds as clean lowercase namespace.verb (#95)", () => {
  const html = renderLandingShell(["alpha"]);
  // The row's kind text is the remapped label, not the raw kind; its category class
  // still keys off the real kind so the leading-dot colour (#85) is unchanged.
  assert.match(html, /feedKindLabel\(e\.kind\)/);
  assert.match(html, /"feed-kind " \+ feedKindClass\(e\.kind\)/);
  assert.match(html, /const feedKindLabel = /);
  // The mapping covers only real orchestrator event kinds (dashboard-model's
  // describeEvent) — no fabricated `pr.opened`, no `agent-N` identity (rule 5, #55).
  for (const pair of [
    ["green", "issue.merged"],
    ["parked", "issue.parked"],
    ["carve", "issue.carved"],
    ["campaign-batch", "wave.started"],
    ["campaign-batch-done", "wave.closed"],
    ["campaign-start", "campaign.started"],
    ["queue-start", "campaign.started"],
    ["campaign-done", "campaign.closed"],
    ["queue-done", "campaign.closed"],
    ["campaign-halt", "campaign.halted"],
    ["turn", "agent.turn"],
  ]) {
    assert.ok(
      html.includes(`"${pair[0]}": "${pair[1]}"`) || html.includes(`${pair[0]}: "${pair[1]}"`),
      `feed relabels ${pair[0]} → ${pair[1]}`,
    );
  }
  assert.ok(!html.includes("pr.opened"), "no fabricated pr.opened kind");
  // The label reads as clean lowercase code, so the feed-kind is no longer uppercased.
  assert.doesNotMatch(html, /\.feed-kind \{[^}]*text-transform: uppercase/);
});

test("the card progress-bar selector is scoped so it never boxes the feed's progress kind label (#85)", () => {
  const html = renderLandingShell(["alpha"]);
  // The feed label renders <span class="feed-kind progress">; a bare `.progress {` rule
  // (the card progress bar) would also match it, applying height/background/overflow and
  // squishing it inside a dark box. Scope the bar's selector so no bare `.progress {` exists.
  assert.doesNotMatch(html, /(?<![-\w])\.progress \{/);
});

test("no status/category word is ever a bare top-level CSS class, so a component base can't inherit a modifier's layout (#91)", () => {
  // The convention (docs/dashboard-color-rules.md §8): a status word (ADR 0007's
  // running/parked/failure/completed/unstarted/carved, plus the landing's queued/idle
  // aliases and a wave's closed) and a feed comms category (feedKindClass's
  // success/attention/failure/carved/progress) only ever appear *scoped* — `.dot.running`,
  // `.card.parked`, `.feed-kind.progress` — never as a bare `.running {`/`.progress {`
  // rule. A bare one is a component base (the `.progress` bar, #85) that any element
  // carrying the same word as a modifier would then inherit, boxing/tinting it.
  const words = [
    "running",
    "parked",
    "failure",
    "completed",
    "unstarted",
    "carved",
    "queued",
    "idle",
    "closed",
    "success",
    "attention",
    "progress",
  ];
  const pages = {
    landing: renderLandingShell(["alpha"]),
    campaign: renderStatusPage(
      {
        project: "beta",
        waves: [
          {
            index: 0,
            status: "running",
            issues: [{ issueNumber: "1", status: "carved" }],
          },
        ],
        parked: [],
      },
      { carve: true },
    ),
  };
  for (const [name, html] of Object.entries(pages)) {
    for (const word of words) {
      // A bare rule is `.word {` at a selector boundary — not preceded by a word char or
      // hyphen, so scoped compounds (`.dot.running`, `.progress-fill.running`) don't match.
      assert.doesNotMatch(
        html,
        new RegExp(String.raw`(?<![-\w])\.${word}\s*\{`),
        `${name} emits a bare .${word} { rule — scope it (.dot/.feed-kind/component-prefix)`,
      );
    }
  }
});

test("renderLandingShell colours each project card's highlight by run state (#75)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card element carries its run-state class...
  assert.match(html, /el\("a", "card " \+ p\.runState\)/);
  // ...and per-state border-top-color rules tint the highlight to match the pill.
  assert.match(
    html,
    /\.card\.parked \{ border-top-color: var\(--color-yellow\); \}/,
  );
  assert.match(
    html,
    /\.card\.running \{ border-top-color: var\(--color-blue\); \}/,
  );
  assert.match(
    html,
    /\.card\.idle \{ border-top-color: var\(--color-dim\); \}/,
  );
});

test("renderLandingShell draws each card a run-state-coloured progress bar sized by percent merged (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card renders a progress track with a fill sized to percentMerged and classed by run state,
  // sitting beneath the wave/percent meta line.
  assert.match(html, /el\("div", "progress-fill " \+ p\.runState\)/);
  assert.match(html, /\.style\.width = p\.percentMerged \+ "%"/);
  // The fill is coloured by run state: running blue, parked yellow, completed green; idle stays grey.
  assert.match(
    html,
    /\.progress-fill\.running \{ background: var\(--color-blue\); \}/,
  );
  assert.match(
    html,
    /\.progress-fill\.parked \{ background: var\(--color-yellow\); \}/,
  );
  assert.match(
    html,
    /\.progress-fill\.completed \{ background: var\(--color-green\); \}/,
  );
});

test("renderLandingShell renders the card tally as status-dot chips, not plain text (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The tally builds one pill chip per bucket, each with a status dot scoped to .dot,
  // whose class comes from the shared `tallyDotClass` reducer (dashboard-visual-state.ts).
  assert.match(html, /el\("span", "tally-chip"\)/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // The chip treatment matches the campaign page's chips — a bordered pill.
  assert.match(html, /\.tally-chip \{[^}]*border-radius: 999px/);
  // The queued dot is the dim unstarted grey; running/parked reuse the shared .dot colours.
  assert.match(html, /\.dot\.queued \{ background: var\(--color-dim\); \}/);
  // The old plain-text tally string is gone.
  assert.doesNotMatch(html, /" running · " \+ p\.tally\.parked/);
});

test("renderLandingShell colours the counter values and highlights the parked counter when it has questions (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter value reads in its status colour: working blue, parked yellow, merged-today green; queued stays neutral.
  assert.match(
    html,
    /\[data-counter="working"\] \.counter-value \{ color: var\(--color-blue\); \}/,
  );
  assert.match(
    html,
    /\[data-counter="parked"\] \.counter-value \{ color: var\(--color-yellow\); \}/,
  );
  assert.match(
    html,
    /\[data-counter="mergedToday"\] \.counter-value \{ color: var\(--color-green\); \}/,
  );
  // The parked counter carries a gold border only while it is actionable — enabled, i.e. parked > 0.
  assert.match(
    html,
    /\.counter-toggle\[data-counter="parked"\]:not\(:disabled\) \{[^}]*border-color: var\(--color-yellow\)/,
  );
});

test("renderLandingShell gives each counter a payload-derived sublabel (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter carries a sublabel element the client fills from the payload.
  assert.match(html, /data-counter-sub="working"/);
  assert.match(html, /data-counter-sub="parked"/);
  assert.match(html, /data-counter-sub="queued"/);
  assert.match(html, /data-counter-sub="mergedToday"/);
  // working counts repos with a running agent; parked reads the oldest parked question's wait;
  // queued and merged-today are fixed context lines.
  assert.match(html, /across " \+ /);
  assert.match(html, /oldest " \+ fmtWaited/);
  assert.match(html, /in later waves/);
  // The counter is titled "Merged today" (the metric); its sublabel states the
  // scope — the all-repos aggregate — matching the "across N repos" sibling (#104).
  assert.match(html, /All repos/);
  assert.doesNotMatch(html, /issues merged/);
  assert.doesNotMatch(html, /issues closed/);
});

test("renderLandingShell stacks each counter label on top of an inline value + sublabel row (#94)", () => {
  const html = renderLandingShell(["alpha"]);
  // POC layout: the uppercase label sits on top, then the value and sublabel share
  // one inline row (a .counter-line), rather than value → label → sublabel stacked.
  for (const key of ["working", "parked", "queued", "mergedToday"]) {
    const counter = html.match(
      new RegExp(`data-counter="${key}"[^>]*>(.*?)counter-sub`),
    );
    assert.ok(counter, `counter ${key} present`);
    const body = counter[1];
    // Label markup comes before the value markup for this counter.
    assert.ok(
      body.indexOf("counter-label") < body.indexOf("counter-value"),
      `counter ${key} renders label above value`,
    );
    // The value and sublabel are wrapped together in the inline row.
    assert.ok(
      body.includes("counter-line"),
      `counter ${key} wraps value + sub in an inline row`,
    );
  }
  // The inline row lays value + sublabel out on one baseline-aligned line.
  assert.match(
    html,
    /\.counter-line \{[^}]*display: flex[^}]*align-items: baseline/,
  );
});

test("the updated readout reads 'Paused' while paused and counts up otherwise, on both pages (§5, #100)", () => {
  for (const html of [
    renderLandingShell(["alpha"]),
    renderStatusPage({ project: "beta", waves: [], parked: [] }),
  ]) {
    // While paused the "updated Ns ago" readout reads "Paused" instead of ageing a
    // now-frozen count; it resumes counting on unpause. The mapping is `freezeIntent`'s
    // `updatedText` (dashboard-visual-state.ts, asserted directly there: paused⇒"Paused",
    // live⇒"updated Ns ago"), single-sourced into both pages and written onto the readout.
    assert.match(html, /function freezeIntent/);
    assert.match(
      html,
      /updatedEl\.textContent = freezeIntent\(\{ paused, buffered, lastUpdate, now: Date\.now\(\) \}\)\.updatedText/,
    );
    // Toggling pause re-renders the readout immediately, so "Paused" appears on the click
    // rather than up to a second later on the next interval tick.
    assert.match(html, /renderState\(\);\s*renderUpdated\(\);/);
  }
});

test("renderLandingShell wires live SSE updates, an updated-ago readout, and a buffered pause", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // Subscribes to the one-way SSE stream and re-reads the landing as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // A live/paused indicator and an "updated Ns ago" readout live in the toolbar header.
  assert.match(html, /data-live-state/);
  assert.match(html, /data-updated/);
  // A pause control that freezes presentation while still collecting, flushing on resume.
  assert.match(html, /id="pause"/);
  // Pause must not tear the stream down — it is a client-side presentation freeze (ADR 0008).
  assert.match(html, /paused/);
});

test("serveAllStatus GET / serves the all-repos landing shell, not a server-rendered campaign", async () => {
  const configDir = join(tmpdir(), `vetinari-landing-shell-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const root = await res.text();
    // The dropdown switches All repos ↔ a project; All repos is the landing selection.
    assert.match(root, /<option value="" selected>All repos<\/option>/);
    assert.match(root, /<option value="alpha">/);
    assert.match(root, /<option value="beta">/);
    // The shell is client-rendered: it fetches the landing model and mounts the cards client-side.
    assert.match(root, /\/api\/landing/);
    assert.match(root, /id="cards"/);
    // The old server-rendered campaign body is retired from the landing — no issue chips here.
    assert.doesNotMatch(root, /#101 <small>/);
    assert.doesNotMatch(root, /#201 <small>/);

    // Selecting a project opens that project's campaign view (server-rendered for now).
    const alpha = await (
      await fetch(`http://127.0.0.1:${port}/?project=alpha`)
    ).text();
    assert.match(alpha, /#101 <small>/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/landing serves the all-repos landing model as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-landing-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["201"]],
      name: "alpha work",
      slots: 1,
    }),
    event("queue-start", { ts: "2025-01-01T00:01:00.000Z", taskIds: ["101"], slots: 1 }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["301"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/landing`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const landing = await res.json();
    // One card per registered project, read live off the registry, with the counters summed.
    assert.deepEqual(
      landing.projects.map((p: { project: string }) => p.project),
      ["alpha", "beta"],
    );
    assert.equal(landing.projects[0].campaignName, "alpha work");
    assert.equal(landing.projects[0].runState, "running");
    assert.deepEqual(Object.keys(landing.counters).sort(), [
      "mergedToday",
      "parked",
      "queued",
      "working",
    ]);
    // Alpha's issue 101 is running; alpha's 201 and beta's 301 are still queued — summed.
    assert.equal(landing.counters.working, 1);
    assert.equal(landing.counters.queued, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/feed serves the cross-project event feed as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-feed-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  // The live route reads the feed with a default `now`, so seed within the 48h
  // window (#101): campaign-start oldest, parked next, the merge newest.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  seedState(alphaDir, [
    event("campaign-start", {
      ts: hoursAgo(3),
      batches: [["101"]],
      name: "alpha work",
      slots: 1,
    }),
    event("green", { ts: hoursAgo(1), taskId: "101", branch: "agent/101", commits: [] }),
  ]);
  seedState(betaDir, [
    event("parked", {
      ts: hoursAgo(2),
      taskId: "201",
      reason: "needs a choice",
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/feed`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const feed = await res.json();
    // The feed merges both projects newest-first, each row repo-prefixed.
    assert.deepEqual(
      feed.map((f: { text: string }) => f.text),
      [
        "alpha — #101 merged",
        "beta — #201 parked: needs a choice",
        "alpha — Campaign “alpha work” started",
      ],
    );
    assert.equal(feed[0].kind, "green");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue serves one issue's reconstructed detail as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-endpoint-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      batches: [["101"]],
      titles: { "101": "Wire the parser" },
      name: "parser work",
      slots: 1,
    }),
    event("turn", {
      ts: "2025-05-01T08:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "Sketched the grammar and a red test.",
    }),
    event("parked", {
      ts: "2025-05-01T08:06:00.000Z",
      taskId: "101",
      reason: "needs a decision",
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const detail = await res.json();
    assert.equal(detail.project, "alpha");
    assert.equal(detail.issueNumber, "101");
    assert.equal(detail.status, "parked");
    assert.equal(detail.title, "Wire the parser");
    assert.equal(detail.campaignName, "parser work");
    assert.equal(detail.turns, 1);
    assert.equal(detail.elapsedMs, 5 * 60 * 1000);
    assert.deepEqual(
      detail.turnLog.map((t: { turn: number; summary: string }) => [
        t.turn,
        t.summary,
      ]),
      [[0, "Sketched the grammar and a red test."]],
    );
    // An unknown project is a 404, never a path joined from request input.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/api/issue?project=ghost&issue=101`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue carries the parked question and options for a parked issue", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-parked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      batches: [["101"]],
      titles: { "101": "Wire the parser" },
      slots: 1,
    }),
    event("turn", {
      ts: "2025-05-01T08:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "Sketched the grammar.",
    }),
    event("parked", {
      ts: "2025-05-01T08:06:00.000Z",
      taskId: "101",
      reason: "needs a decision",
    }),
  ]);
  writeFileSync(
    join(alphaDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "now",
      reason: "blocked",
      branch: "agent/101",
      sessionId: "s",
      question:
        "Which parser?\n\nOptions:\n- Recursive descent\n- Parser combinator",
    }),
  );
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)
    ).json();
    assert.equal(detail.status, "parked");
    // The sheet's reply block reads the question (its Options tail split off) and the parsed options.
    assert.deepEqual(detail.parked, {
      question: "Which parser?",
      options: ["Recursive descent", "Parser combinator"],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue omits parked reply data for a non-parked issue", async () => {
  const configDir = join(tmpdir(), `vetinari-issue-unparked-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-05-01T08:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
    event("green", {
      ts: "2025-05-01T08:02:00.000Z",
      taskId: "101",
      branch: "agent/101",
      commits: [],
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const detail = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=alpha&issue=101`)
    ).json();
    assert.equal(detail.status, "completed");
    assert.equal(detail.parked, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/events streams a project's log appends as SSE frames", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // Read from the stream until a full SSE data frame (blank-line terminated) arrives, or time out.
  const nextFrame = async (): Promise<string> => {
    let buf = "";
    while (!buf.includes("\n\n")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for SSE frame")),
            4000,
          ),
        ),
      ]);
      if (chunk.done) throw new Error("stream closed before a frame arrived");
      buf += decoder.decode(chunk.value, { stream: true });
    }
    return buf;
  };
  try {
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // The opening handshake frame flushes headers and, crucially, means the watcher is now armed.
    await nextFrame();
    // A fresh append to alpha's live log is pushed as a data frame carrying the project and the new event.
    appendFileSync(
      join(alphaDir, "logs", "orchestrator.jsonl"),
      JSON.stringify(event("turn", { taskId: "101", turn: 0, summary: "" })) + "\n",
    );
    let frame = "";
    let payload: { project?: string; events?: { event: string }[] } = {};
    // fs.watch can coalesce or emit a bare change with no new bytes; keep reading data frames until one carries the append.
    for (let i = 0; i < 5 && !payload.events?.length; i++) {
      frame = await nextFrame();
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim())
        .join("");
      payload = data ? JSON.parse(data) : {};
    }
    assert.equal(payload.project, "alpha");
    assert.deepEqual(
      (payload.events ?? []).map((e) => e.event),
      ["turn"],
    );
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// A live-stream harness for the filter/debounce tests: connects to /api/events, then
// `collect(ms)` reads for a fixed span and returns every data frame's parsed payload
// (comment/handshake frames carry no `data:` line and are skipped). Reading for a
// fixed span — past the ~300ms debounce window — is how "exactly one frame" and "zero
// frames" are asserted deterministically despite fs.watch's own coalescing.
const openEventStream = async (port: number) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const collect = async (ms: number): Promise<{ project?: string; events?: { event: string; turn?: number }[] }[]> => {
    const payloads: { project?: string; events?: { event: string; turn?: number }[] }[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("done")), remaining)),
        ]);
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice("data:".length).trim())
          .join("");
        if (data) payloads.push(JSON.parse(data));
      }
    }
    return payloads;
  };
  return { reader, collect };
};

test("serveAllStatus GET /api/events debounces a burst of appends into one frame (#131)", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-debounce-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const { reader, collect } = await openEventStream(port);
  try {
    const logPath = join(alphaDir, "logs", "orchestrator.jsonl");
    // One continuous read; the burst is scheduled to land after the watcher has armed but
    // well inside one debounce window (three separate appends, each a distinct fs.watch trigger).
    setTimeout(async () => {
      for (let i = 0; i < 3; i++) {
        appendFileSync(logPath, JSON.stringify(event("turn", { taskId: "101", turn: i, summary: "" })) + "\n");
        await new Promise((r) => setTimeout(r, 30));
      }
    }, 250);
    // Read well past the burst + debounce window so a second frame, if one were emitted, would show.
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "a burst within the debounce window coalesces to a single frame");
    assert.deepEqual((frames[0].events ?? []).map((e) => e.turn), [0, 1, 2], "the single frame carries every appended event, in order");
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/events emits no frame for a pure machine-noise append (#131)", async () => {
  const configDir = join(tmpdir(), `vetinari-sse-noise-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  seedState(alphaDir, [event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"]], slots: 1 })]);
  register(configDir, { project: "alpha", projectRoot: join(configDir, "alpha-root"), baseLocation: alphaDir });
  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const { reader, collect } = await openEventStream(port);
  try {
    const logPath = join(alphaDir, "logs", "orchestrator.jsonl");
    // A noise line then a real one in the same window: the read that the `green` guarantees
    // also sees the noise line, so the surviving frame proves the noise was stripped — a
    // deterministic check that doesn't hinge on whether fs.watch fired for the noise alone.
    setTimeout(async () => {
      appendFileSync(logPath, JSON.stringify(noise({ event: "telegram-send-failed", chatId: "42" })) + "\n");
      await new Promise((r) => setTimeout(r, 30));
      appendFileSync(logPath, JSON.stringify(event("green", { taskId: "101", branch: "agent/101", commits: [] })) + "\n");
    }, 250);
    const frames = (await collect(3000)).filter((p) => p.events?.length);
    assert.equal(frames.length, 1, "only the view-relevant append surfaces a frame");
    assert.deepEqual((frames[0].events ?? []).map((e) => e.event), ["green"], "the denylisted noise event never reaches the client");
  } finally {
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus renders a single registered project as a one-entry dropdown with campaign, wave and parked intact", async () => {
  const configDir = join(tmpdir(), `vetinari-serve-solo-${Date.now()}`);
  const soloDir = join(configDir, "state-solo");
  seedState(soloDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"]],
      slots: 1,
    }),
  ]);
  // A parked issue in the active campaign — the single-project view keeps its parked card.
  writeFileSync(
    join(soloDir, "parked", "101.json"),
    JSON.stringify({
      taskId: "101",
      parkedAt: "now",
      reason: "blocked",
      branch: "agent/101",
      sessionId: "s",
      question: "Need a choice.",
    }),
  );
  register(configDir, {
    project: "solo",
    projectRoot: join(configDir, "solo-root"),
    baseLocation: soloDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    // A no-gateway, single-project user opens that project's campaign view (ADR 0006).
    const solo = await (
      await fetch(`http://127.0.0.1:${port}/?project=solo`)
    ).text();
    assert.match(solo, /<select name="project"/);
    assert.match(solo, /<option value="solo" selected>/);
    // Its own campaign wave and parked card render intact; the reply happens in the
    // sheet, whose /answer form is present.
    assert.match(solo, /#101 <small>/);
    assert.match(solo, /Parked · <span class="parked-count">1<\/span>/);
    assert.match(
      solo,
      /<a class="parked-card"[^>]*data-issue="101" data-project="solo"/,
    );
    assert.match(
      solo,
      /<form method="post" action="\/answer" id="reply-form">/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /carve on confirm shells carve in the selected project's root", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-carve-confirm-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const spawned: { args: string[]; cwd: string }[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (_cmd, args, options) => spawned.push({ args, cwd: options.cwd }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        taskId: "401",
        project: "beta",
        confirm: "1",
      }).toString(),
    });
    // Redirects back to the selected project's dashboard, like the answer control.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/?project=beta");
    // Executes the no-plan carve (ticket B) against the SELECTED project's own root
    // — so the shared install loads beta's config and gates, not alpha's.
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(-2), ["carve", "401"]);
    assert.equal(spawned[0].cwd, join(configDir, "beta-root"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /carve?preview returns the selected project's structured closure as JSON", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-carve-json-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const closures: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  // The structured closure (E2) the confirmation renders: the target and dropped
  // dependents that would leave, the banked work kept, and the remaining waves.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    remaining: [] as string[][],
  };
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the closure to the selected project's own install,
    // which computes it against that project's real blockedBy graph.
    carveClosure: (projectRoot, taskId) => {
      closures.push({ projectRoot, taskId });
      return Promise.resolve(structured);
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/carve?preview&taskId=201&project=beta`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    // The endpoint returns the full structured closure the panel discloses —
    // dropped, kept-banked, and remaining all reach the client verbatim.
    assert.deepEqual(await res.json(), structured);
    // The closure came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(closures, [
      { projectRoot: join(configDir, "beta-root"), taskId: "201" },
    ]);
    // A preview computes nothing destructive — no carve is spawned.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /carve?preview validates params and the project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-carve-json-guard-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    carveClosure: () =>
      Promise.resolve({
        target: "201",
        dropped: ["201"],
        keptBanked: [],
        remaining: [],
      }),
  });
  const { port } = server.address() as AddressInfo;
  try {
    // Missing taskId/project → 400.
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/carve?preview&project=beta`))
        .status,
      400,
    );
    // Unknown project → 404.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/carve?preview&taskId=201&project=ghost`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus POST /carve previews the selected project's closure without executing", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-carve-preview-${Date.now()}`);
  const alphaDir = join(configDir, "state-alpha");
  const betaDir = join(configDir, "state-beta");
  seedState(alphaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101"], ["301"]],
      slots: 1,
    }),
  ]);
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"], ["401"]],
      slots: 1,
    }),
  ]);
  register(configDir, {
    project: "alpha",
    projectRoot: join(configDir, "alpha-root"),
    baseLocation: alphaDir,
  });
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const previews: { projectRoot: string; taskId: string }[] = [];
  const spawned: unknown[] = [];
  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
    spawn: (...a) => spawned.push(a),
    // The dumb router routes the preview to the selected project's own install,
    // which computes the closure against that project's real blockedBy graph.
    carvePreview: (projectRoot, taskId) => {
      previews.push({ projectRoot, taskId });
      return Promise.resolve(
        `carve #201 → dropping #201, #401\nremaining campaign: (nothing left to run)`,
      );
    },
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/carve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ taskId: "201", project: "beta" }).toString(),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    // The preview came from the selected project's install (beta's root), not alpha's.
    assert.deepEqual(previews, [
      { projectRoot: join(configDir, "beta-root"), taskId: "201" },
    ]);
    // It shows the shelled closure and a confirm affordance carrying the project.
    assert.match(html, /#401/);
    assert.match(
      html,
      /<form method="post" action="\/carve"[\s\S]*?name="confirm"/,
    );
    assert.match(html, /name="project" value="beta"/);
    assert.match(html, /name="taskId" value="201"/);
    // Nothing has been carved yet — preview executes nothing.
    assert.equal(spawned.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus flags the selected project's carvable chips with its project", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-carve-control-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A running campaign whose future wave (401) is still carvable.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"], ["401"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["201"],
    }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    // The unstarted future-wave row is flagged carvable and carries beta, so the
    // panel's Carve routes preview and confirm to beta's own install.
    assert.match(
      html,
      /class="wave-member [a-z]+"[^>]*data-issue="401"[^>]*data-project="beta"[^>]*data-carvable="1"/,
    );
    // No inline carve control on the row itself.
    assert.doesNotMatch(html, /✂️/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus lists a project's archived runs and renders one read-only when a run is selected", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-archive-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run still in flight.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["201"]],
      slots: 1,
    }),
  ]);
  // Two archived runs plus a malformed one that must be skipped.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["101"], ["102"]], slots: 1 }),
    event("campaign-done", { batches: 2 }),
  ]);
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["111"]], slots: 1 }),
    event("campaign-halt", { taskId: "111", reason: "gate failed", index: 0 }),
  ]);
  writeFileSync(
    join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"),
    "garbage\n{",
  );
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const root = await (
      await fetch(`http://127.0.0.1:${port}/?project=beta`)
    ).text();
    // The collapsible archived-runs list shows both good runs, newest-first; the live
    // run (201) still renders at the top.
    assert.match(root, /#201 <small>/);
    assert.match(root, /<section class="archived-runs">/);
    // Each row carries its token, state (a halted run reads interrupted — it stopped
    // short) and issue count; unnamed runs fall back to the token as the label.
    assert.match(
      root,
      /<li class="archive-row" data-run="2026-02-01T00-00-00-000Z">/,
    );
    assert.match(root, /interrupted · 1 issue<\/span>/);
    assert.match(
      root,
      /<li class="archive-row" data-run="2026-01-01T00-00-00-000Z">/,
    );
    assert.match(root, /complete · 2 issues<\/span>/);
    assert.ok(
      root.indexOf("2026-02-01") < root.indexOf("2026-01-01"),
      "newest-first",
    );
    // The malformed run is skipped, never listed.
    assert.doesNotMatch(root, /2026-03-01/);
    // No run selected → every row starts collapsed.
    assert.doesNotMatch(root, /class="archive-row open"/);
    // Each row also ships its raw-log pane, keyed to the run for the client fetch.
    assert.match(
      root,
      /data-pane="raw" data-project="beta" data-run="2026-01-01T00-00-00-000Z"/,
    );

    // Selecting a run opens that row on load (a ?run= deep-link).
    const withRun = await (
      await fetch(
        `http://127.0.0.1:${port}/?project=beta&run=2026-01-01T00-00-00-000Z`,
      )
    ).text();
    assert.match(withRun, /#201 <small>/); // live run still on top
    assert.match(
      withRun,
      /<li class="archive-row open" data-run="2026-01-01T00-00-00-000Z">/,
    );
    assert.match(withRun, /#101 <small>/); // the archived run's own issues, in its pane
    // Read-only: the archived run's chips are never carvable (a finished run has
    // nothing to carve).
    assert.doesNotMatch(withRun, /data-issue="101"[^>]*data-carvable/);

    // A run not present in the archive listing is rejected — no row opens.
    const bogus = await fetch(
      `http://127.0.0.1:${port}/?project=beta&run=..%2F..%2Forchestrator`,
    );
    assert.equal(bogus.status, 200);
    assert.doesNotMatch(await bogus.text(), /class="archive-row open"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus reconstructs a carved issue in a selected archived run, read-only", async () => {
  const configDir = join(tmpdir(), `vetinari-agg-archive-carved-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // A live run over an unrelated issue, so the only carved chip on the page is the
  // archived run's.
  seedState(betaDir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["900"]],
      slots: 1,
    }),
  ]);
  // An archived run that carved an unstarted dependent (201) out of its plan: 101
  // banked, 201 dropped by the carve, then the campaign finished.
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-04-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", {
      ts: "2026-04-01T00:00:00.000Z",
      batches: [["101"], ["201"]],
      name: "spring cleanup",
      slots: 1,
    }),
    event("green", {
      ts: "2026-04-01T00:01:00.000Z",
      taskId: "101",
      branch: "agent/101",
      commits: [],
    }),
    event("carve", {
      ts: "2026-04-01T00:02:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: [],
    }),
    event("campaign-done", { ts: "2026-04-01T00:03:00.000Z", batches: 2 }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    const html = await (
      await fetch(
        `http://127.0.0.1:${port}/?project=beta&run=2026-04-01T00-00-00-000Z`,
      )
    ).text();
    // The archived run renders under its --name in the collapsible list…
    assert.match(html, /<span class="archive-name">spring cleanup<\/span>/);
    // …and its campaign pane reconstructs the carved-out 201 as a carved chip in the
    // wave it left, so an operator can see what the run was carved down to (ADR 0007).
    assert.match(
      html,
      /<span class="dot carved"><\/span>#201 <small>carved<\/small>/,
    );
    // Read-only: the archived carved chip is never carvable.
    assert.doesNotMatch(html, /data-carvable="1"[^>]*<span class="dot carved">/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /api/issue reads an archived run's own log when a run token is given", async () => {
  const configDir = join(tmpdir(), `vetinari-api-issue-archive-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  // The live log names 101 nowhere — its detail lives only in the archived run.
  seedState(betaDir, [event("campaign-start", { batches: [["900"]], slots: 1 })]);
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeJsonl(join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["101"]], titles: { "101": "old work" }, slots: 1 }),
    event("turn", {
      ts: "2026-01-01T00:01:00.000Z",
      taskId: "101",
      turn: 0,
      summary: "did the thing",
    }),
    event("green", { ts: "2026-01-01T00:02:00.000Z", taskId: "101", branch: "agent/101", commits: [] }),
    event("campaign-done", { batches: 1 }),
  ]);
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  try {
    // With the run token, the detail is reconstructed from the archived log: its
    // title, completed status, and the archived turn appear, flagged read-only.
    const withRun = await (
      await fetch(
        `http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=2026-01-01T00-00-00-000Z`,
      )
    ).json();
    assert.equal(withRun.status, "completed");
    assert.equal(withRun.title, "old work");
    assert.equal(withRun.archived, true);
    assert.equal(withRun.turnLog.length, 1);
    assert.equal(withRun.turnLog[0].summary, "did the thing");

    // Without a run token it reads the live log, where 101 is unknown → unstarted.
    const live = await (
      await fetch(`http://127.0.0.1:${port}/api/issue?project=beta&issue=101`)
    ).json();
    assert.equal(live.status, "unstarted");
    assert.equal(live.turnLog.length, 0);

    // An unlisted run token is rejected, never a path to traverse.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/api/issue?project=beta&issue=101&run=..%2F..%2Forchestrator`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("serveAllStatus GET /archive/log serves a listed run's raw JSONL as text/plain, and 404s an unlisted run", async () => {
  const configDir = join(tmpdir(), `vetinari-archive-log-${Date.now()}`);
  const betaDir = join(configDir, "state-beta");
  seedState(betaDir, [event("campaign-start", { batches: [["201"]], slots: 1 })]);
  const archiveDir = join(betaDir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const raw =
    [
      event("campaign-start", { batches: [["101"], ["102"]], slots: 1 }),
      event("campaign-done", { batches: 2 }),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
  writeFileSync(
    join(archiveDir, "orchestrator-2026-01-01T00-00-00-000Z.jsonl"),
    raw,
  );
  register(configDir, {
    project: "beta",
    projectRoot: join(configDir, "beta-root"),
    baseLocation: betaDir,
  });

  const server = await serveAllStatus(configDir, {
    port: 0,
    host: "127.0.0.1",
  });
  const { port } = server.address() as AddressInfo;
  try {
    // A listed run returns its log verbatim, as plain text.
    const ok = await fetch(
      `http://127.0.0.1:${port}/archive/log?project=beta&run=2026-01-01T00-00-00-000Z`,
    );
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await ok.text(), raw);

    // A run not in the listing is a 404, never a path to traverse.
    const missing = await fetch(
      `http://127.0.0.1:${port}/archive/log?project=beta&run=2026-09-09T00-00-00-000Z`,
    );
    assert.equal(missing.status, 404);
    const traversal = await fetch(
      `http://127.0.0.1:${port}/archive/log?project=beta&run=..%2F..%2Forchestrator`,
    );
    assert.equal(traversal.status, 404);

    // Params are required, and an unknown project 404s.
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/archive/log?run=2026-01-01T00-00-00-000Z`,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/archive/log?project=nope&run=2026-01-01T00-00-00-000Z`,
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test("describeEvent narrates the operator-facing events in plain words", () => {
  assert.equal(
    describeEvent(event("campaign-start", { batches: [["101"]], slots: 1, name: "gateway work" })),
    "Campaign “gateway work” started",
  );
  assert.equal(describeEvent(event("campaign-start", { batches: [["101"]], slots: 1 })), "Campaign started");
  // A campaign-batch names its run and its wave: the lead issue's title (from `titles[tasks[0]]`)
  // and a "+M" for the rest, matching the status-page wave-card vocabulary.
  assert.equal(
    describeEvent(
      event("campaign-batch", {
        index: 1,
        tasks: ["201", "202"],
        name: "gateway work",
        titles: { "201": "cache eviction", "202": "warm the cache" },
      }),
    ),
    "Campaign “gateway work” — Wave 2 — cache eviction +1 started",
  );
  // Name absent → nameless wording, never `Campaign “” —`; a resolved title still names the wave.
  assert.equal(
    describeEvent(event("campaign-batch", { index: 1, tasks: ["201"], titles: { "201": "cache eviction" } })),
    "Wave 2 — cache eviction started",
  );
  // Neither name nor a resolved title → the bare index, as before.
  assert.equal(
    describeEvent(event("campaign-batch", { index: 1, tasks: ["201"] })),
    "Wave 2 started",
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
    "Wave 1 merged #101, #102",
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
  assert.equal(
    describeEvent(event("campaign-halt", { index: 1, reason: "merge conflict", name: "gateway work" })),
    "Campaign “gateway work” halted at Wave 2: merge conflict",
  );
  assert.equal(
    describeEvent(event("campaign-halt", { index: 0, reason: "merge conflict" })),
    "Campaign halted at Wave 1: merge conflict",
  );
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
    describeEvent(event("carve", { target: "303", removed: ["303", "304"], dropped: ["303", "304"] })),
    "Carved #303, #304",
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
    "#640 quarantined — resolve the conflict",
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

test("reduceCampaign marks a halted issue as a failure", () => {
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
    event("campaign-halt", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      taskId: "101",
      reason: "gate failed",
    }),
  ]);

  assert.equal(reduced.outcomes.get("101"), "failure");
  assert.equal(reduced.details.get("101"), "Campaign halted: gate failed");
  // A halt does not close the wave — it stays the current one.
  assert.deepEqual([...reduced.closedWaves], []);
  assert.equal(reduced.currentWave, 0);
});

test("campaignRunning is true for a started campaign that has not finished or halted", () => {
  assert.equal(
    campaignRunning([
      event("campaign-start", { batches: [["101"], ["201"]], slots: 1 }),
      event("campaign-batch", { index: 0, tasks: ["101"] }),
    ]),
    true,
  );
});

test("campaignRunning is false with no campaign, and once it completes or halts", () => {
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
  assert.equal(
    campaignRunning([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-halt", { index: 0, taskId: "101", reason: "gate failed" }),
    ]),
    false,
    "a halted campaign is not running",
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

test("reduceCampaign folds a carve event, pruning unfinished issues from future waves", () => {
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
    // 202 carved mid-wave: it is running, so it stays; its unstarted dependent 301 goes.
    event("carve", {
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

test("reduceCampaign's carve fold clears an emptied future wave and reindexes", () => {
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
    // Between waves: 201 not yet started, so carving it empties and drops its wave.
    event("carve", {
      ts: "2025-01-01T00:03:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: ["201"],
    }),
  ]);

  assert.deepEqual(reduced.waves, [["101"], ["301"]]);
  assert.deepEqual([...reduced.closedWaves], [0]);
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

  assert.deepEqual(
    status.waves.map((w) => [w.index, w.status]),
    [
      [0, "closed"],
      [1, "running"],
    ],
  );
});

test("buildStatus renders a carved issue as a carved chip in the wave it left", () => {
  const dir = join(tmpdir(), `vetinari-status-carved-${Date.now()}`);
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
    // 201 is a future, unstarted wave: carving it drops it from the running plan…
    event("carve", {
      ts: "2025-01-01T00:03:00.000Z",
      target: "201",
      removed: ["201"],
      dropped: [],
    }),
  ]);

  const status = buildStatus(cfgFor(dir));

  // …but it still renders as a carved chip in the wave it left (ADR 0007), so a
  // browsing operator sees what was carved out — it is not silently gone.
  assert.equal(status.waves.length, 2);
  assert.deepEqual(
    status.waves.map((w) => w.issues.map((i) => [i.issueNumber, i.status])),
    [[["101", "completed"]], [["201", "carved"]]],
  );
  // The carved issue keeps its title on the chip.
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

test("buildStatus marks a wave whose merged base gated red as wave-parked", () => {
  const dir = join(tmpdir(), `vetinari-status-wave-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  // Both greens merged, but the combined base gated red: the wave wave-parks with no
  // batch-done to close it (ADR 0013). Wave 1 (unstarted) still reads as itself.
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
    ["wave-parked", "unstarted"],
  );

  // The same reducer drives an archived run's read (buildStatus at the archive file),
  // so a wave-parked wave renders identically there.
  const archive = join(dir, "logs", "archive", "orchestrator-2025-01-01T00-04-00-000Z.jsonl");
  mkdirSync(join(dir, "logs", "archive"), { recursive: true });
  writeJsonl(archive, events);
  const archived = buildStatus(archiveStatusConfig("demo", archive));
  assert.equal(archived.waves[0].status, "wave-parked");
});

test("buildStatus renders a merge-conflict-quarantined issue as quarantined", () => {
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

  // The quarantine overlay wins over 640's green outcome; 611 stays completed.
  assert.deepEqual(
    status.waves[0].issues.map((i) => [i.issueNumber, i.status]),
    [
      ["611", "completed"],
      ["640", "quarantined"],
    ],
  );
  // Its detail names the human's next move.
  assert.equal(
    status.waves[0].issues.find((i) => i.issueNumber === "640")?.detail,
    "Quarantined on a merge conflict — resolve the conflict",
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

test("wave labels read from tmp-log issue titles, resolved through buildStatusWithIssueNames", async () => {
  const dir = join(tmpdir(), `vetinari-status-wave-names-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102", "103"], ["201"]],
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);
  const titles: Record<string, string> = {
    "101": "config resolution",
    "102": "retry policy",
    "103": "log rotation",
    "201": "cache eviction",
  };

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    // Unique project so the process-lifetime issue-name cache can't collide with
    // another test's "demo:101".
    project: "wave-names",
    fetchTask: async (id: string) => JSON.stringify({ title: titles[id] }),
  });
  const html = renderStatusPage(status);

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("wave labels and chip hovers render from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `vetinari-render-log-titles-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      batches: [["101", "102", "103"], ["201"]],
      titles: {
        "101": "config resolution",
        "102": "retry policy",
        "103": "log rotation",
        "201": "cache eviction",
      },
      slots: 1,
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("campaign-batch-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
      held: [],
      clearedParked: [],
    }),
    event("campaign-batch", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
  ]);

  // buildStatus over cfgFor's id-echoing fetchTask: the only source of titles is
  // the log, exactly as the dumb-router dashboard reads them (ADR 0002).
  const html = renderStatusPage(buildStatus(cfgFor(dir)));

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // Every chip carries its own title on hover — 201 has no status detail yet, so
  // its hover is exactly the resolved title.
  assert.match(html, /<button[^>]*title="cache eviction"[^>]*>/);
  // A chip whose issue also has a status detail carries the title alongside it.
  assert.match(html, /title="config resolution&#10;Merged into base"/);
});

test("renderStatusPage shows a merged/total tally on an open wave card", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "completed" },
          { issueNumber: "202", status: "running" },
        ],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [
          { issueNumber: "301", status: "unstarted" },
          { issueNumber: "302", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });

  // Each open wave card's head carries its merged/total — one of two done in the
  // running wave, none in the unstarted one — ahead of its state pill in the meta group.
  assert.match(
    html,
    /<span class="wave-tally">1\/2<\/span><span class="wave-status running">running<\/span>/,
  );
  assert.match(
    html,
    /<span class="wave-tally">0\/2<\/span><span class="wave-status unstarted">unstarted<\/span>/,
  );
});

test("renderStatusPage renders one stable wave-head row: label · merged/total · state · carved, with the pill outside the label", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          {
            issueNumber: "201",
            status: "completed",
            name: "Guest checkout entry point",
          },
          { issueNumber: "202", status: "running" },
          { issueNumber: "203", status: "carved" },
        ],
      },
    ],
    parked: [],
  });

  // The head is one row: the label in its own element (so a long label can't shove the
  // state pill onto its own line, the Wave 2 vs Wave 3 misalignment), then a meta group
  // ordering merged/total · state pill · carved tally — the carved count folded into the
  // row, not floating in the corner.
  assert.match(
    html,
    /<div class="wave-head"><h2 class="wave-label">Wave 2 — Guest checkout entry point \+2<\/h2><div class="wave-meta"><span class="wave-tally">1\/3<\/span><span class="wave-status running">running<\/span><span class="wave-carved">1 carved<\/span><\/div><\/div>/,
  );
  // The state pill is no longer nested inside the <h2> label.
  assert.doesNotMatch(
    html,
    /<span class="wave-status running">running<\/span><\/h2>/,
  );
});

test("renderStatusPage renders one interactive member row per issue, merging the old chip + title blocks", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [
            {
              issueNumber: "201",
              status: "running",
              name: "wire up the parser",
            },
            { issueNumber: "202", status: "unstarted" },
          ],
        },
      ],
      parked: [],
    },
    { carve: true },
  );

  // One member list, one interactive row per issue: status dot + #NNN + resolved
  // title + status word — no separate chip row and no separate title list.
  assert.match(
    html,
    /<ul class="wave-members"><li><button type="button" class="wave-member running"[^>]*><span class="dot running"><\/span>#201 <span class="wave-member-title">wire up the parser<\/span><small>running<\/small><\/button><\/li>/,
  );
  // An unresolved title falls back to just #NNN (no title span).
  assert.match(
    html,
    /<li><button type="button" class="wave-member unstarted"[^>]*><span class="dot unstarted"><\/span>#202 <small>unstarted<\/small><\/button><\/li>/,
  );
  // The row carries its issue+project so a tap opens the detail sheet, and is flagged
  // carvable when carvable (202 is an unstarted future-wave remainder).
  assert.match(
    html,
    /class="wave-member unstarted" title="[^"]*" data-issue="202" data-project="beta" data-carvable="1"/,
  );
  // The old dual blocks are retired — no chip row (`.chips`/`.chip`) and no title list.
  assert.doesNotMatch(html, /class="chips"/);
  assert.doesNotMatch(html, /class="wave-issues"/);
  assert.doesNotMatch(html, /class="chip /);
});

test("renderStatusPage colours a carved chip and pulses a running one", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "live one" },
          { issueNumber: "202", status: "carved", name: "carved one" },
        ],
      },
    ],
    parked: [],
  });

  // A carved member row carries the carved status dot + title + status word, and its
  // `.wave-member.carved` class reads struck-through…
  assert.match(
    html,
    /<button type="button" class="wave-member carved"[^>]*><span class="dot carved"><\/span>#202 <span class="wave-member-title">carved one<\/span><small>carved<\/small><\/button>/,
  );
  assert.match(
    html,
    /\.wave-member\.carved \{ color: var\(--color-text-light-2\); text-decoration: line-through; \}/,
  );
  // …and the wave it left gains a carved tally in its header, so the carve reads
  // at a glance without counting struck-through chips (one of two issues carved).
  assert.match(html, /<span class="wave-carved">1 carved<\/span>/);
  // …in a distinct carved colour defined in the stylesheet (ADR 0007's sixth state),
  // scoped to .dot so it tints only the dot, never the whole struck-through chip (#81).
  assert.match(html, /--color-carved:/);
  assert.match(html, /\.dot\.carved \{ background: var\(--color-carved\); \}/);
  // A running chip pulses — a keyframed animation on its dot, reduced-motion aware.
  assert.match(html, /@keyframes chip-pulse/);
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
  assert.match(html, /prefers-reduced-motion/);
});

test("renderStatusPage's carve panel discloses kept-banked work and carries a standalone explainer", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "401", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { carve: true },
  );
  // The confirmation is built from the structured closure the endpoint returns:
  // it names the dropped dependents and, separately, states the banked (merged or
  // mergeable) work that is kept — so a confirm never implies banked work leaves.
  assert.match(html, /also drops/);
  assert.match(html, /Keeps banked \(merged or mergeable\)/);
  // A standalone Carve (no Resume beside it) carries a plain-words explainer of
  // what a carve does, keyed to show only when the issue is carvable and unparked.
  assert.match(html, /id="carve-explainer"/);
  assert.match(html, /everything blocked by it/);
});

test("renderStatusPage renders the repo dropdown (with a no-JS select fallback) and the selected project's body", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [
        {
          issueNumber: "201",
          reason: "blocked",
          parkedAt: "now",
          branch: "agent/201",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { projects: ["alpha", "beta", "gamma"], selected: "beta" },
  );

  // The primary control is the repo dropdown trigger stating the current scope.
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  assert.match(html, /<span class="repo-label">beta<\/span>/);
  // The native <select> lives on inside <noscript> as the no-JS switch (posts back to GET /).
  assert.match(
    html,
    /<noscript><form[^>]*method="get"[^>]*action="\/"[^>]*class="project-picker">/,
  );
  assert.match(
    html,
    /<select name="project" onchange="this\.form\.submit\(\)">/,
  );
  assert.match(html, /<option value="">All repos<\/option>/);
  assert.match(html, /<option value="beta" selected>beta<\/option>/);
  assert.match(html, /<option value="gamma">gamma<\/option>/);
  // The selected project's own body still renders exactly as the single-project view.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // The parked card carries the project so the sheet routes its reply/carve to it.
  assert.match(html, /<a class="parked-card"[^>]*data-project="beta"/);
});

test("renderStatusPage's repo dropdown states the current scope as the heading trigger, not a native select", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The trigger is the page heading and the switcher in one control: a button, not a
  // native <select>, carrying the full owner/name scope as its label plus a chevron.
  assert.match(html, /<div class="repo-dropdown" data-repo-dropdown>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger" id="repo-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="repo-menu">/,
  );
  assert.match(html, /<span class="repo-label">acme\/tidepool<\/span>/);
  assert.match(html, /<span class="repo-chevron" aria-hidden="true">▾<\/span>/);
  // The full owner/name is the label — never abbreviated to just the repo name.
  assert.doesNotMatch(html, /<span class="repo-label">tidepool<\/span>/);
});

test("the repo dropdown shows owner/name from repo while data-project stays the bare project key", () => {
  const html = renderStatusPage(
    {
      project: "vetinari",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        {
          project: "vetinari",
          runState: "running",
          repo: "jjforge/vetinari",
        },
        { project: "acme-checkout", runState: "idle" },
      ],
      selected: "vetinari",
    },
  );

  // The trigger heading reads the selected repo's owner/name, not its bare key.
  assert.match(
    html,
    /<span class="repo-label">jjforge\/vetinari<\/span>/,
  );
  // Its row shows owner/name too, but routing stays keyed on the bare project key.
  assert.match(
    html,
    /<li class="repo-option selected"[^>]*data-project="vetinari"[^>]*><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">jjforge\/vetinari<\/span>/,
  );
  // A project with no remote falls back to its bare key for the label.
  assert.match(
    html,
    /data-project="acme-checkout"[^>]*><span class="repo-dot idle"[^>]*><\/span><span class="repo-optlabel">acme-checkout<\/span>/,
  );
});

test("renderLandingShell's repo dropdown is the All-repos heading, replacing the h1 + native select", () => {
  const html = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate scope reads "All repos" as the trigger label — the heading itself.
  assert.match(html, /<span class="repo-label">All repos<\/span>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  // The old separate <h1>All repos</h1> title is gone — the trigger is the heading now.
  assert.doesNotMatch(html, /<h1>All repos<\/h1>/);
});

test("the repo dropdown menu rows carry a run-state dot, the owner/name label, and a note", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The menu is a listbox; each repo is an option with a dot in its run-state colour,
  // the full owner/name label, and its run state as the note.
  assert.match(
    html,
    /<ul class="repo-menu" id="repo-menu" role="listbox" aria-label="Switch repo" tabindex="-1" hidden>/,
  );
  assert.match(
    html,
    /<li class="repo-option" role="option" aria-selected="false" data-project="jjforge\/tidepool" tabindex="-1"><span class="repo-dot parked" aria-hidden="true"><\/span><span class="repo-optlabel">jjforge\/tidepool<\/span><span class="repo-note">parked<\/span><\/li>/,
  );
  // The current scope's row is filled (aria-selected + a .selected class), no checkmark.
  // The current scope's row is the fill (a .selected class + aria-selected), with no
  // checkmark glyph inside the row — the fill alone marks it.
  assert.match(
    html,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="acme\/tidepool" tabindex="-1"><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">acme\/tidepool<\/span><span class="repo-note">running<\/span><\/li>/,
  );
});

test("the repo dropdown's All-repos row uses the teal accent dot and the repo count as its note", () => {
  const landing = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate has no run state of its own: its dot is the teal accent (`all`), its
  // note the repo count, and on the landing it is the selected (current) scope.
  assert.match(
    landing,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="" tabindex="-1"><span class="repo-dot all" aria-hidden="true"><\/span><span class="repo-optlabel">All repos<\/span><span class="repo-note">2 repos<\/span><\/li>/,
  );
  // The teal accent is the product accent, so the `all` dot reads --color-primary.
  assert.match(
    landing,
    /\.repo-dot\.all \{ background: var\(--color-primary\); \}/,
  );
});

test("the repo dropdown's CSS matches the spec: mono heading, borderless trigger, popover menu, touch rows", () => {
  // The CSS is shared by both pages via TOP_BAR_STYLES, so assert it there once.
  const css = TOP_BAR_STYLES;
  // Trigger: no border, no background, no padding — just text + chevron.
  assert.match(
    css,
    /\.repo-trigger \{[^}]*border: 0;[^}]*background: none;[^}]*padding: 0;/,
  );
  // Label: system-monospace stack (no web font), 600, 17px, tight tracking, truncates, never wraps.
  assert.match(
    css,
    /\.repo-label \{[^}]*font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;[^}]*font-weight: 600;[^}]*font-size: 17px;[^}]*letter-spacing: -0.01em;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
  );
  // No IBM Plex Mono (the POC face) is added or referenced anywhere.
  assert.doesNotMatch(css, /Plex Mono/i);
  // Hover turns the label teal; the chevron is 13px, muted, and rotates 180° over 180ms when open.
  assert.match(
    css,
    /\.repo-trigger:hover \.repo-label \{ color: var\(--color-primary\); \}/,
  );
  assert.match(
    css,
    /\.repo-chevron \{[^}]*font-size: 13px;[^}]*color: var\(--color-text-light-2\);[^}]*transition: transform 180ms;/,
  );
  assert.match(
    css,
    /\.repo-trigger\[aria-expanded="true"\] \.repo-chevron \{ transform: rotate\(180deg\); \}/,
  );
  // A visible focus ring — the trigger has no border to hang one on.
  assert.match(
    css,
    /\.repo-trigger:focus-visible, \.repo-option:focus-visible \{ outline: 2px solid var\(--color-primary\);/,
  );
  // The menu is a popover: 8px below the trigger, 260px min, layered above cards (z 5)
  // but below the issue sheet (z 10), on the box surface with the spec border/radius/shadow.
  assert.match(
    css,
    /\.repo-menu \{[^}]*top: calc\(100% \+ 8px\);[^}]*z-index: 5;[^}]*min-width: 260px;[^}]*background: var\(--color-box-body\);[^}]*border: 1px solid var\(--color-secondary\);[^}]*border-radius: var\(--border-radius-medium\);[^}]*box-shadow: 0 14px 40px #0009;/,
  );
  // Never z-index 30, and never above the sheet's z-index 10 (the sheet must cover the menu).
  assert.doesNotMatch(css, /\.repo-menu \{[^}]*z-index: 30/);
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.issue-detail \{[^}]*z-index: 10/);
  // Rows: flex, selected and hovered share the fill; the note is muted, the label mono.
  assert.match(css, /\.repo-option \{[^}]*display: flex;/);
  assert.match(
    css,
    /\.repo-option:hover, \.repo-option\.selected \{ background: var\(--color-chip-hover\); \}/,
  );
  assert.match(
    css,
    /\.repo-note \{[^}]*font-size: 11px;[^}]*color: var\(--color-dim\);/,
  );
  // Touch rows are ≥44px; the label steps to 15px on a phone.
  assert.match(
    css,
    /@media \(pointer: coarse\) \{ \.repo-option \{ min-height: 44px; \} \}/,
  );
  assert.match(
    css,
    /@media \(max-width: 640px\) \{ \.repo-label \{ font-size: 15px; \} \}/,
  );
});

test("both pages wire the repo dropdown's keyboard, scope-switch, and scoped click-outside behavior (#88)", () => {
  const landing = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
  ]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      projects: [
        { project: "alpha", runState: "idle" },
        { project: "beta", runState: "running" },
      ],
      selected: "beta",
    },
  );
  // One shared script, emitted by both pages so they can't drift.
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(REPO_DROPDOWN_SCRIPT),
      "every page includes the shared repo-dropdown script",
    );

  const js = REPO_DROPDOWN_SCRIPT;
  // Trigger toggles the menu (aria-expanded + hidden).
  assert.match(
    js,
    /repoTrigger\.addEventListener\("click", \(\) => \(repoIsOpen\(\) \? repoClose\(\) : repoOpen\(\)\)\)/,
  );
  assert.match(
    js,
    /setAttribute\("aria-expanded", "true"\); repoMenu\.hidden = false;/,
  );
  // Choosing a different scope navigates (the switch); the current scope is a no-op that just closes.
  assert.match(
    js,
    /if \(option\.getAttribute\("aria-selected"\) === "true"\) \{ repoClose\(\); return; \}/,
  );
  assert.match(
    js,
    /location\.href = project \? "\/\?project=" \+ encodeURIComponent\(project\) : "\/";/,
  );
  // Keyboard: Enter/Space/↑↓ open+move, Enter selects, Escape closes and restores focus to the trigger, Tab is trapped.
  assert.match(js, /event\.key === "Escape".*repoClose\(\);/);
  assert.match(js, /event\.key === "ArrowDown".*repoFocus\(repoActive \+ 1\)/);
  assert.match(js, /event\.key === "ArrowUp".*repoFocus\(repoActive - 1\)/);
  assert.match(
    js,
    /event\.key === "Tab".*repoFocus\(repoActive \+ \(event\.shiftKey \? -1 : 1\)\)/,
  );
  assert.match(js, /if \(restore !== false\) repoTrigger\.focus\(\);/);
  // Click-outside closes, scoped to the dropdown's own subtree — not "any non-button".
  assert.match(
    js,
    /if \(repoIsOpen\(\) && !repoRoot\.contains\(event\.target\)\) repoClose\(false\);/,
  );
});

test("switching scope resets the view: it navigates (fresh sheet) and closed-wave state is per-repo", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "alpha", runState: "idle" },
        { project: "beta", runState: "running" },
      ],
      selected: "beta",
    },
  );
  // A scope switch is a navigation, so the target page loads fresh — the issue sheet
  // starts hidden and nothing is pre-opened.
  assert.match(
    REPO_DROPDOWN_SCRIPT,
    /location\.href = project \? "\/\?project=" \+ encodeURIComponent\(project\) : "\/";/,
  );
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  // Expanded closed-waves are persisted per-repo, so a different scope reads its own
  // (collapsed) set — wave labels aren't unique across repos, so this can't expand the wrong wave.
  assert.match(
    html,
    /const storeKey = "vetinari:closed-waves:" \+ waveBar\.dataset\.project;/,
  );
});

// A minimal reconstructed run status for an archived row's campaign pane — a
// single closed wave holding one completed issue chip.
const archStatus = (issue: string): CampaignStatus => ({
  project: "beta",
  waves: [
    {
      index: 0,
      status: "closed",
      issues: [{ issueNumber: issue, status: "completed" }],
    },
  ],
  parked: [],
});

test("renderStatusPage renders archived runs as a collapsible list with per-row state, time and a joined mode control", () => {
  // Pin the timezone so the local-rendered when-clock is deterministic here (the
  // dedicated #102 test covers the divergent-tz case); UTC keeps `22:22:36`.
  const origTZ = process.env.TZ;
  process.env.TZ = "UTC";
  try {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T22-22-36-267Z",
          name: "comms + dashboard",
          startedAt: "2026-02-01T22:22:36.267Z",
          state: "complete",
          issues: 3,
          status: archStatus("101"),
        },
        {
          run: "2026-01-01T00-00-00-000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          state: "interrupted",
          issues: 1,
          status: archStatus("111"),
        },
      ],
    },
  );

  assert.match(html, /<section class="archived-runs"><h2>Archived runs<\/h2>/);
  assert.match(html, /<ul class="archive-list" data-project="beta">/);
  // A collapsed row carries its run token, name label, the runId parsed to a UTC
  // clock, and a state dot with `state · N issues`.
  assert.match(
    html,
    /<li class="archive-row" data-run="2026-02-01T22-22-36-267Z">/,
  );
  assert.match(html, /<span class="archive-name">comms \+ dashboard<\/span>/);
  assert.match(
    html,
    /<span class="archive-when">Feb 1, 2026 · 22:22:36<\/span>/,
  );
  assert.match(
    html,
    /<span class="archive-state complete"><span class="archive-dot complete"><\/span>complete · 3 issues<\/span>/,
  );
  // An unnamed run falls back to its token as the label; issue count pluralizes.
  assert.match(html, /<span class="archive-name">2026-01-01T00-00-00-000Z<\/span>/);
  assert.match(
    html,
    /<span class="archive-state interrupted"><span class="archive-dot interrupted"><\/span>interrupted · 1 issue<\/span>/,
  );
  // The joined campaign/raw-log control, campaign the active (pressed) side by default.
  assert.match(
    html,
    /<button type="button" class="archive-mode active" data-mode="campaign" aria-pressed="true">campaign<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" class="archive-mode" data-mode="raw" aria-pressed="false">raw log<\/button>/,
  );
  // Campaign mode reuses the live wave renderer — the run's own issue chip renders.
  assert.match(
    html,
    /<div class="archive-pane archive-campaign" data-pane="campaign">[\s\S]*#101 <small>/,
  );
  // Raw mode ships a scaffold the client fills: filename header + a text filter.
  assert.match(
    html,
    /<div class="archive-pane archive-raw" data-pane="raw" data-project="beta" data-run="2026-02-01T22-22-36-267Z" hidden>/,
  );
  assert.match(
    html,
    /<div class="archive-raw-header">orchestrator-2026-02-01T22-22-36-267Z\.jsonl<\/div>/,
  );
  assert.match(html, /<input type="text" class="archive-raw-filter"/);
  // Bodies start collapsed (hidden) and rows render newest-first (order preserved).
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T22-22-36-267Z" hidden>/,
  );
  assert.ok(
    html.indexOf("2026-02-01T22-22-36-267Z") <
      html.indexOf("2026-01-01T00-00-00-000Z"),
    "newest-first",
  );
  // A short list has no show-older control.
  assert.doesNotMatch(html, /<button[^>]*class="archive-show-older"/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("renderStatusPage renders an archived run's when-time in the operator's LOCAL timezone, no UTC suffix (#102)", () => {
  // The gateway runs in the operator's timezone, so the displayed clock localizes.
  // PST is UTC−8 in February: `2026-02-01T22:22:36.267Z` reads `14:22:36` local,
  // and the hardcoded " UTC" suffix is gone (raw-log content, not this chrome, keeps UTC).
  const origTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const html = renderStatusPage(
      { project: "beta", waves: [], parked: [] },
      {
        selected: "beta",
        archivedRuns: [
          {
            run: "2026-02-01T22-22-36-267Z",
            name: "comms + dashboard",
            startedAt: "2026-02-01T22:22:36.267Z",
            state: "complete",
            issues: 1,
            status: archStatus("101"),
          },
        ],
      },
    );
    assert.match(
      html,
      /<span class="archive-when">Feb 1, 2026 · 14:22:36<\/span>/,
    );
    assert.doesNotMatch(html, /archive-when">[^<]*UTC/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

test("renderStatusPage shows an interrupted run as interrupted and still expands it to its partial waves", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      // A run cut short: wave 1 merged, wave 2 was in flight when it stopped.
      archivedRun: "2026-05-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-05-01T00-00-00-000Z",
          startedAt: "2026-05-01T00:00:00.000Z",
          state: "interrupted",
          issues: 2,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
              {
                // The route reconciles an interrupted run's in-flight wave to the
                // terminal `interrupted` — an archived run never reads as live (#152).
                index: 1,
                status: "interrupted",
                issues: [{ issueNumber: "201", status: "interrupted" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The row reads interrupted…
  assert.match(
    html,
    /<span class="archive-state interrupted"><span class="archive-dot interrupted"><\/span>interrupted · 2 issues<\/span>/,
  );
  // …and, opened, its campaign pane still shows the partial waves it did run — the
  // in-flight wave/issue reconciled to the terminal `interrupted`, never `running`.
  const paneStart = html.indexOf('class="archive-pane archive-campaign"');
  const pane = html.slice(
    paneStart,
    html.indexOf('class="archive-pane archive-raw"', paneStart),
  );
  assert.match(pane, /#101 <small>completed<\/small>/);
  assert.match(pane, /#201 <small>interrupted<\/small>/);
  assert.doesNotMatch(pane, /<small>running<\/small>/);
});

test("reconcileArchivedStatus maps an interrupted run's live `running` statuses to terminal `interrupted`, leaving a complete run untouched (#152)", () => {
  const live: CampaignStatus = {
    project: "beta",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "101", status: "completed" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
    ],
    parked: [],
  };
  // A complete run finished clean — it has no in-flight status to reconcile, so it
  // passes through unchanged.
  assert.deepEqual(reconcileArchivedStatus(live, "complete"), live);
  // An interrupted run's in-flight `running` wave and issue become the terminal
  // `interrupted`; the banked closed wave and its completed issue are untouched.
  const fixed = reconcileArchivedStatus(live, "interrupted");
  assert.equal(fixed.waves[0].status, "closed");
  assert.equal(fixed.waves[0].issues[0].status, "completed");
  assert.equal(fixed.waves[1].status, "interrupted");
  assert.equal(fixed.waves[1].issues[0].status, "interrupted");
});

test("an archived non-terminal log renders a terminal status, not `running`, while the live log still derives `running` (#152)", () => {
  // The issue's self-contained reproducer: a campaign that logged its first wave's
  // spawn and then stopped — no campaign-done / campaign-halt / queue-done.
  const events = [
    event("campaign-start", { ts: "2026-08-26T23:27:59.174Z", batches: [["101"], ["202"]], slots: 8, name: "interrupted run" }),
    event("campaign-batch", { ts: "2026-08-26T23:28:00.000Z", index: 0, tasks: ["101"] }),
    event("queue-start", { ts: "2026-08-26T23:28:01.000Z", taskIds: ["101"], slots: 8 }),
    event("queue-spawn", { ts: "2026-08-26T23:28:02.000Z", taskId: "101", running: 1, left: 0 }),
  ];
  // The live-log path is unchanged: an in-flight issue with no terminal event reduces
  // to `running`, exactly as today (no regression).
  assert.equal(reduceCampaign(events).outcomes.get("101"), "running");

  // The archived path reconciles. The log has no terminal event, so the run is
  // interrupted; its rendered status must carry no `running` — the in-flight wave and
  // issue read the terminal `interrupted` instead.
  const dir = join(tmpdir(), `vetinari-status-152-${Date.now()}`);
  const archiveDir = join(dir, "logs", "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archive = join(archiveDir, "orchestrator-2026-08-26T23-27-59-684Z.jsonl");
  writeJsonl(archive, events);

  assert.equal(archivedRunState(events), "interrupted");
  const status = reconcileArchivedStatus(buildStatus(archiveStatusConfig("demo", archive)), "interrupted");
  const statuses = status.waves.flatMap((w) => [w.status as string, ...w.issues.map((i) => i.status as string)]);
  assert.ok(!statuses.includes("running"), `an archived run must show no live status; got ${statuses.join(", ")}`);
  assert.equal(status.waves[0].status, "interrupted");
  assert.equal(status.waves[0].issues[0].status, "interrupted");
  // The never-reached second wave stays honestly unstarted — that is not a live status.
  assert.equal(status.waves[1].status, "unstarted");
  assert.equal(status.waves[1].issues[0].status, "unstarted");
});

test("renderStatusPage opens the archived row named by archivedRun, in the requested mode", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedMode: "raw",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // The named row opens: its toggle expanded, its body shown.
  assert.match(
    html,
    /<li class="archive-row open" data-run="2026-02-01T00-00-00-000Z">/,
  );
  assert.match(
    html,
    /<button type="button" class="archive-toggle" aria-expanded="true"/,
  );
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T00-00-00-000Z">/,
  );
  // Raw is the pressed side; the raw pane shows and the campaign pane hides.
  assert.match(
    html,
    /<button type="button" class="archive-mode active" data-mode="raw" aria-pressed="true">raw log<\/button>/,
  );
  assert.match(
    html,
    /<div class="archive-pane archive-campaign" data-pane="campaign" hidden>/,
  );
  assert.match(
    html,
    /<div class="archive-pane archive-raw" data-pane="raw" data-project="beta" data-run="2026-02-01T00-00-00-000Z">/,
  );
});

test("renderStatusPage drops the raw-log pane and mode toggle on phone-width, showing only the campaign view (#153)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      // Deep-linked in raw mode: the campaign pane carries `hidden`, the raw pane
      // does not — on a phone that must invert so the wave summary shows.
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedMode: "raw",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // A ≤640px media block on the campaign page hides the campaign/raw toggle, drops
  // the raw pane, and forces the campaign (wave) pane even for a run deep-linked in
  // raw mode (whose campaign pane carries `hidden`). The raw JSONL log is a
  // desktop/debugging surface; a phone wants the wave summary.
  assert.match(
    html,
    /@media \(max-width: 640px\) \{\s*\.archive-modes \{ display: none; \}\s*\.archive-pane\.archive-raw \{ display: none; \}\s*\.archive-pane\.archive-campaign\[hidden\] \{ display: block; \}\s*\}/,
  );
});

test("renderStatusPage ships the archived-list client wiring: toggle, mode switch, raw fetch, filter, deep-link, show-older", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );
  // The page embeds the archived-list script…
  assert.ok(html.includes(ARCHIVE_LIST_SCRIPT), "page includes ARCHIVE_LIST_SCRIPT");
  // …one row open at a time (opening closes the others)…
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /for \(const other of archiveRows\) if \(other !== row && other\.classList\.contains\("open"\)\) closeRow\(other\);/,
  );
  // …raw mode fetches the existing /archive/log endpoint, no second endpoint…
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /fetch\("\/archive\/log\?project=" \+ encodeURIComponent\(pane\.dataset\.project\) \+ "&run=" \+ encodeURIComponent\(pane\.dataset\.run\)\)/,
  );
  // …renders one line per row with a #L<n> anchor that the browser puts in the URL…
  assert.match(ARCHIVE_LIST_SCRIPT, /a\.href = "#L" \+ n;/);
  assert.match(ARCHIVE_LIST_SCRIPT, /el\.id = "L" \+ n;/);
  // …colours each line through the shared, tested highlighter…
  assert.match(ARCHIVE_LIST_SCRIPT, /code\.innerHTML = highlightJsonLine\(line\);/);
  // …caps the render through the shared, tested cappedRawRows helper so a huge
  // log can't build an unbounded DOM, with a "show more" control for the rest…
  assert.match(ARCHIVE_LIST_SCRIPT, /const RAW_CAP = 500;/);
  assert.match(ARCHIVE_LIST_SCRIPT, /cappedRawRows\(pane\._lines \|\| \[\], needle, RAW_CAP, pane\._expanded \|\| 0\)/);
  assert.match(ARCHIVE_LIST_SCRIPT, /more\.className = "archive-raw-more"/);
  assert.match(ARCHIVE_LIST_SCRIPT, /pane\._expanded = \(pane\._expanded \|\| 0\) \+ RAW_CAP/);
  // …reports "showing X of Y lines" honestly (cap- and filter-aware)…
  assert.match(ARCHIVE_LIST_SCRIPT, /footer\.textContent = "showing " \+ rows\.length \+ " of " \+ total \+ " lines";/);
  // …expands the cap to include a deep-linked line past it before scrolling…
  assert.match(ARCHIVE_LIST_SCRIPT, /pane\._expanded = n - RAW_CAP/);
  // …shows an empty-result state rather than a blank pane…
  assert.match(ARCHIVE_LIST_SCRIPT, /archive-raw-empty/);
  // …and reveals the older rows behind the cap on demand.
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /showOlder\.addEventListener\("click", \(\) => \{ for \(const row of archiveRows\) row\.hidden = false;/,
  );
});

test("renderStatusPage makes archived campaign chips open the issue sheet against the archived run, read-only", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );
  // The chip carries its issue, project and the run token, so the shared sheet reads
  // the archived run's own log (its turn log lives there, not in the live log).
  assert.match(
    html,
    /data-issue="101" data-project="beta" data-run="2026-02-01T00-00-00-000Z"/,
  );
  // Read-only: an archived chip is never carvable (a finished run has nothing to carve).
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-carvable/);
  // The shared sheet forwards a run token to /api/issue so it can read the archive.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /run \? "&run=" \+ encodeURIComponent\(run\) : ""/,
  );
});

test("renderStatusPage caps the archived-runs list at 20 with a show-older control", () => {
  const runs = Array.from({ length: 22 }, (_, i) => {
    const day = String(22 - i).padStart(2, "0");
    return {
      run: `2026-01-${day}T00-00-00-000Z`,
      startedAt: `2026-01-${day}T00:00:00.000Z`,
      state: "complete" as const,
      issues: 1,
      status: archStatus(String(100 + i)),
    };
  });
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { selected: "beta", archivedRuns: runs },
  );

  // All 22 rows are in the DOM, but the two oldest render hidden behind the control.
  assert.equal(
    [...html.matchAll(/<li class="archive-row(?: open)?" data-run=/g)].length,
    22,
  );
  assert.equal(
    [...html.matchAll(/<li class="archive-row[^"]*" data-run="[^"]*" hidden>/g)]
      .length,
    2,
  );
  assert.match(
    html,
    /<button type="button" class="archive-show-older">Show 2 older runs<\/button>/,
  );
});

test("renderStatusPage omits the campaign name from the meta line for an unnamed run", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });
  assert.doesNotMatch(html, /class="run-name"/);
  assert.doesNotMatch(html, /class="campaign-name"/);
  // The counts still render — an unnamed campaign is still a campaign.
  assert.match(html, /<p class="campaign-meta">0 issues · 1 wave<\/p>/);
});

test("renderStatusPage renders no archived-runs section when a project has none", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { selected: "demo" },
  );
  assert.doesNotMatch(html, /class="archived-runs"/);
  assert.doesNotMatch(html, /class="archived-run"/);
});

test("renderStatusPage omits the project dropdown when no project list is given", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /class="repo-dropdown"/);
  assert.doesNotMatch(html, /class="project-picker"/);
  assert.doesNotMatch(html, /<select name="project"/);
  // A single-project view with no repo list falls back to a plain <h1> heading.
  assert.match(html, /<h1>demo<\/h1>/);
});

test("renderStatusPage uses the jjforge dark palette", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.match(html, /--color-body: #090c10/);
  assert.match(html, /--color-primary: #3fb9b0/);
  assert.match(html, /--color-box-header: #10151b/);
  assert.match(html, /--color-text: #e6edf3/);
  assert.match(html, /background: var\(--color-body\)/);
  assert.doesNotMatch(html, /radial-gradient/);
});

test("renderStatusPage does not render the color legend under the heading", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /Green completed · Yellow parked · Red failure/);
});

test("renderStatusPage makes issue chips tap-friendly for touch devices", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "Add login flow",
            detail: "Agent turn 2 finished; waiting for verification/resume",
          },
        ],
      },
    ],
    parked: [],
  });

  // The chip keeps its hover title and now carries the ids the sheet fetches with.
  assert.match(
    html,
    /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="101"[^>]*data-project="demo"/,
  );
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /el\.addEventListener\("click"/);
});

test("renderStatusPage opens the issue-detail sheet from a chip, fetching /api/issue", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "101", status: "running", name: "Add login flow" },
        ],
      },
    ],
    parked: [],
  });

  // A dismissible sheet, hidden until an issue is opened.
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="issue-detail-close"/);
  // A sticky header (number, status, title, repo · campaign), meta tiles, and the turn log.
  assert.match(html, /class="issue-detail-header"/);
  assert.match(html, /\.issue-detail-header \{[^}]*position: sticky;/);
  assert.match(html, /class="issue-detail-title"/);
  assert.match(html, /class="issue-detail-context"/);
  assert.match(html, /id="issue-detail-turns"/);
  assert.match(html, /id="issue-detail-turnlog"/);
  // Chips open the sheet, which fetches the reconstructed detail.
  assert.match(html, /openIssue\(/);
  assert.match(html, /fetch\("\/api\/issue\?project="/);
  // Dismissible, and reveal keys off a `show` class over the hidden default.
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  assert.match(
    html,
    /getElementById\("issue-detail-close"\)\.addEventListener\("click"/,
  );
});

test("renderStatusPage gives the sheet a WORKTREE tile and turns-with-duration meta (#90)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // A third meta tile carrying the agent's real worktree path — hidden until a
  // fetched detail carries one, so a run without a preserved worktree shows nothing.
  assert.match(
    html,
    /<div class="meta-tile[^"]*" id="issue-detail-worktree-tile" hidden>/,
  );
  assert.match(html, /<span class="meta-label">Worktree<\/span>/);
  assert.match(html, /id="issue-detail-worktree"/);
  // A meta-tile is a flex box, so its display would defeat the UA [hidden] rule;
  // restore the collapse so the worktree tile can hide when the path is absent.
  assert.match(html, /\.meta-tile\[hidden\][^{]*\{ display: none;? \}/);
  // The script reveals the tile only when the detail carries a worktree path…
  assert.match(html, /d\.worktree/);
  // …and presents turns with their working duration (N turns · Mm), not a bare count.
  assert.match(html, /" turn" \+ \(.*\? "" : "s"\) \+ " · "/);
});

test("renderStatusPage renders the turn log newest-first with each turn number in its status colour", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Each turn's number carries the issue's status class, so it reads in the status colour.
  assert.match(html, /"turn-num " \+ .*\bstatus\b/);
  // The turn log region is an ordered list the script fills from the fetched turnLog.
  assert.match(html, /id="issue-detail-turnlog"/);
  assert.match(html, /turnLog/);
  // The status dot palette is shared, so a turn number reuses the same status colours.
  assert.match(
    html,
    /\.turn-num\.completed \{ color: var\(--color-green\); \}/,
  );
});

test("renderStatusPage makes the issue-detail sheet a full-width bottom sheet on mobile", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Desktop: a centred sheet. Mobile: pinned full-width to the bottom.
  assert.match(
    html,
    /@media \(max-width: [^)]+\) \{[^}]*\.issue-detail-sheet \{[^}]*width: 100%;/,
  );
  assert.match(html, /\.issue-detail-sheet/);
});

test("renderStatusPage hosts the carve affordance and inline confirm in the tap-detail panel", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "301", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { carve: true },
  );

  // The panel — not the chip — carries a Carve button and a hidden inline confirm.
  assert.match(
    html,
    /<button type="button" id="carve-start" class="carve-start">Carve<\/button>/,
  );
  assert.match(
    html,
    /<form method="post" action="\/carve" id="carve-confirm"[^>]*hidden>/,
  );
  assert.match(html, /<span class="carve-confirm-text"><\/span>/);
  // The confirm POSTs the existing /carve with confirm=1, carrying taskId+project.
  assert.match(
    html,
    /id="carve-confirm"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?name="confirm" value="1"/,
  );
  assert.match(
    html,
    /<button type="submit" class="carve-confirm-btn">Confirm<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" id="carve-cancel" class="carve-cancel">Cancel<\/button>/,
  );
  // The script keys off the carve data: it fetches the JSON preview, discloses the
  // removed list, POSTs the confirm, then shows a transient "carving…".
  assert.match(html, /\/carve\?preview/);
  assert.match(html, /carve-confirm-text/);
  assert.match(html, /data-carvable/);
  assert.match(html, /method: "POST"/);
  assert.match(html, /carving/);
});

test("renderStatusPage hosts a parked reply block with a Resume button in the tap-detail sheet", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The sheet carries a reply block, hidden until the opened issue is parked.
  assert.match(
    html,
    /<div id="issue-detail-reply" class="issue-detail-reply" hidden>/,
  );
  assert.match(html, /id="reply-question"/);
  assert.match(html, /id="reply-options"/);
  // A free-text reply field posts through the existing /answer path, carrying taskId+project.
  assert.match(html, /<form method="post" action="\/answer" id="reply-form">/);
  assert.match(
    html,
    /id="reply-form"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?<textarea name="text"/,
  );
  // Resume submits that form; it is associated by `form=` so it can sit outside the form, beside Carve.
  assert.match(
    html,
    /<button type="submit" form="reply-form" id="reply-resume" class="reply-resume" hidden>Resume<\/button>/,
  );
});

test("renderStatusPage caps the reply textarea so it stays within the sheet/card (#73)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });
  // A width:100% textarea with padding still spilled past the right edge of the sheet
  // and the parked card; max-width:100% caps it against its padded content box so it
  // never overflows and introduces no horizontal scroll on the sheet.
  assert.match(html, /\btextarea \{[^}]*max-width: 100%/);
});

test("renderStatusPage places Resume beside Carve in one sheet-actions row, sized for touch", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { carve: true },
  );

  // Both controls live in the same actions row so they are reachable one-handed together.
  assert.match(
    html,
    /<div class="sheet-actions"><button type="submit" form="reply-form" id="reply-resume"[^>]*>Resume<\/button><div id="carve-panel"/,
  );
  // A 44px tap target for the primary Resume action on a phone.
  assert.match(html, /\.reply-resume \{[^}]*min-height: 44px;/);
  // The actions row is a flex box, so it needs [hidden] restored explicitly or an
  // empty foot (no reply, no carve) would always show its border and padding.
  assert.match(html, /\.sheet-actions\[hidden\][^{]*\{ display: none; \}/);
  // The carve panel is likewise a flex box whose display would defeat the UA
  // [hidden] rule; restore its collapse rule so a non-carvable issue can hide it (#72).
  assert.match(html, /\.carve-panel\[hidden\][^{]*\{ display: none;? \}/);
  // …and the confirm form inside it: its own `display: flex` would defeat the UA
  // [hidden] rule too, so Confirm/Cancel showed by default beside Resume+Carve —
  // four buttons at once. Restore the collapse so they reveal only in the carve
  // step and the default action row is Resume + Carve alone (#90).
  assert.match(html, /\.carve-confirm\[hidden\][^{]*\{ display: none;? \}/);
});

test("renderStatusPage wires the parked reply block: shown when parked, options fill the field", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The reply block reveals only for a parked issue, carrying its ids for /answer.
  assert.match(html, /d\.status === "parked"/);
  assert.match(html, /d\.parked/);
  // Options render as buttons that fill the reply field without submitting it.
  assert.match(html, /"reply-option"/);
  assert.match(html, /replyText\.value = /);
});

test("renderStatusPage gives the parked block a directive heading and labels the turn log (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The parked block leads with a directive heading, not the flat "Reply & resume".
  assert.match(html, /class="reply-heading">PARKED — NEEDS YOUR ANSWER</);
  assert.doesNotMatch(html, /Reply &amp; resume/);
  // The turn log is its own labeled section ("Agent turns"), distinct from the meta tiles.
  assert.match(html, /class="turn-log-heading">Agent turns</);
});

test("renderStatusPage shows the duration once and pluralizes the turn count (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // TURNS now carries the working duration (N turns · Mm), so the separate ELAPSED
  // tile is redundant and gone — no tile, no script ref, no formatter output for it.
  assert.doesNotMatch(html, /id="issue-detail-elapsed"/);
  assert.doesNotMatch(html, /<span class="meta-label">Elapsed<\/span>/);
  assert.doesNotMatch(html, /detailElapsed/);
  // The count pluralizes: "1 turn", "N turns" — never the "1 turns" the POC flags.
  assert.match(html, /" turn" \+ \(.*=== 1 \? "" : "s"\)/);
  assert.match(html, /" · "/);
});

test("renderStatusPage renders reply options as full-width lettered rows (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The options stack one per line as full-width rows, not inline wrapping pills.
  assert.match(
    html,
    /\.reply-options \{[^}]*flex-direction: column;/,
  );
  // Each row is a flex row: a fixed letter margin on the left, the label filling the rest.
  assert.match(html, /\.reply-option \{[^}]*display: flex;/);
  assert.match(html, /\.reply-option-letter \{/);
  // An "A:"/"B)"-style marker in the option is pulled into the letter margin; an
  // option with no marker falls back to a positional A/B/C letter from the index.
  assert.match(html, /option\.match\(\/\^\(\[A-Za-z\]\)\[\.\):\]/);
  assert.match(html, /String\.fromCharCode\(65 \+ /);
  assert.match(html, /"reply-option-letter"/);
  assert.match(html, /"reply-option-label"/);
  // Clicking a row still fills the reply field with the full original option text.
  assert.match(html, /replyText\.value = option/);
});

test("renderStatusPage falls back to a no-JS carve form per carvable issue", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 1,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { carve: true },
  );

  // Progressive enhancement: a plain server-side form per carvable issue, inside
  // <noscript>, still reaches POST /carve → the preview page → confirm with no JS.
  assert.match(
    html,
    /<noscript>[\s\S]*<form method="post" action="\/carve"[\s\S]*?name="taskId" value="301"[\s\S]*?name="project" value="demo"[\s\S]*<\/noscript>/,
  );
  assert.match(
    html,
    /<noscript>[\s\S]*name="taskId" value="302"[\s\S]*<\/noscript>/,
  );
  // Never a fallback form for a running (in-flight) issue.
  assert.doesNotMatch(html, /name="taskId" value="201"/);
});

test("renderStatusPage omits the carve panel and no-JS fallback unless carve is opted in", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /id="carve-start"/);
  assert.doesNotMatch(html, /<noscript>/);
});

test("renderStatusPage leads with parked issues above the waves when any are parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  assert.match(
    html,
    /<section class="parked-issues"><h2>Parked · <span class="parked-count">1<\/span><\/h2>/,
  );
  // Parked section comes before the wave grid.
  assert.ok(
    html.indexOf('class="parked-issues"') < html.indexOf('class="waves-grid"'),
    "parked should render above the waves",
  );
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
});

test("renderStatusPage opens the issue-detail sheet from a parked row too", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // The whole parked card is a clickable question card carrying the ids the sheet
  // fetches with; its href is the no-JS fallback, and the same wiring opens the sheet
  // from a member row or a parked card (the anchor's default click is prevented).
  assert.match(
    html,
    /<a class="parked-card" href="\/\?project=demo" data-issue="102" data-project="demo"><div class="parked-card-title"><span class="parked-issue">#102<\/span> Need a choice\.<\/div>/,
  );
  assert.match(
    html,
    /querySelectorAll\("\.wave-member\[data-issue\], \.parked-card\[data-issue\]"\)/,
  );
  assert.match(html, /event\.preventDefault\(\); openIssue\(/);
});

test("renderStatusPage omits the parked section entirely when nothing is parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });

  assert.doesNotMatch(html, /Parked issues/);
  assert.doesNotMatch(html, /Nothing parked/);
  assert.doesNotMatch(html, /class="parked-issues"/);
});

test("renderStatusPage orders the top of the page: Parked → campaign-meta → waves (#81)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // Top→bottom order per the design (#81): the Parked section leads, then the
  // campaign-meta line, then the waves — the meta line no longer sits above Parked.
  assert.ok(
    html.indexOf('class="parked-issues"') <
      html.indexOf('class="campaign-meta"'),
    "Parked should render above the campaign-meta line",
  );
  assert.ok(
    html.indexOf('class="campaign-meta"') < html.indexOf('class="waves-grid"'),
    "campaign-meta should render above the waves",
  );
});

test("renderStatusPage collapses closed waves into expandable completed wave chips", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<div class="completed-waves"><div class="completed-wave-bar" data-project="demo">/,
  );
  assert.doesNotMatch(html, /Completed:/);
  // The chip is a toggle button, not a native <details>/<summary>.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">1\/1<\/span><\/button>/,
  );
  assert.match(
    html,
    /\.completed-wave-chip \.check \{ color: var\(--color-green\);/,
  );
  // The closed-wave toggle bar must not stretch: the first wrapped line was rendering
  // taller in Safari.
  assert.match(
    html,
    /\.completed-wave-bar \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/,
  );
  // The open wave still renders its own card in the grid.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span><\/div><\/div>/,
  );
});

test("renderStatusPage labels a single-issue wave with that issue's resolved title, keeping the index", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — config resolution<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage labels a multi-issue wave with its lead issue's title + the extra count", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
          { issueNumber: "202", status: "unstarted", name: "retry policy" },
          { issueNumber: "203", status: "unstarted", name: "log rotation" },
          { issueNumber: "204", status: "unstarted", name: "cache eviction" },
        ],
      },
    ],
    parked: [],
  });

  // Lead title names the wave; the rest collapse to a "+N" (all four still carry
  // their own titles on their chips).
  assert.match(
    html,
    /<h2 class="wave-label">Wave 2 — config resolution \+3<\/h2><div class="wave-meta"><span class="wave-tally">0\/4<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage keeps a closed wave's chip compact and puts the issue titles on its card", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          {
            issueNumber: "101",
            status: "completed",
            name: "config resolution",
          },
          { issueNumber: "102", status: "completed", name: "retry policy" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The compact chip carries only "Wave N" + the merged tally — no lead title.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
  // The lead title + "+N" reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+1<\/h2><div class="wave-meta"><span class="wave-tally">2\/2<\/span><span class="wave-status closed">closed<\/span>/,
  );
});

test("renderStatusPage escapes a wave name derived from an issue title", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "fix <script> & things",
          },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1 — fix &lt;script&gt; &amp; things<\/h2>/,
  );
});

test("renderStatusPage keeps the bare wave index when no issue title is resolved yet", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});

test("renderStatusPage renders a campaign meta line of name · issues · waves, omitted with no campaign (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running" },
          { issueNumber: "202", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });
  // Three issues across two waves, under the named campaign.
  assert.match(
    html,
    /<p class="campaign-meta"><span class="campaign-name">gateway work<\/span> · 3 issues · 2 waves<\/p>/,
  );

  // With no campaign at all (no waves), the meta line is omitted entirely.
  const empty = renderStatusPage({ project: "demo", waves: [], parked: [] });
  assert.doesNotMatch(empty, /class="campaign-meta"/);
});

test("renderStatusPage lays open waves out in a grid, accenting the running wave (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });
  // Open wave cards sit in a responsive grid.
  assert.match(html, /<div class="waves-grid"><section class="wave running">/);
  assert.match(
    html,
    /\.waves-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(20rem, 1fr\)\);/,
  );
  // A running wave carries the status-coloured (blue) top accent; an unstarted one the dim default (§3).
  assert.match(html, /\.wave \{[^}]*border-top: 3px solid var\(--color-dim\);/);
  assert.match(
    html,
    /\.wave\.running \{ border-top-color: var\(--color-blue\); \}/,
  );
  assert.match(html, /<section class="wave unstarted">/);
});

test("renderStatusPage's parked card carries no inline reply form — the reply is in the sheet (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "blocked",
        parkedAt: "2025-06-15T09:00:00.000Z",
        branch: "agent/102",
        description: "Need a choice.",
        options: ["A", "B"],
      },
    ],
  });
  // The card is a single clickable anchor with a meta line — no <form>, no <textarea>,
  // no per-issue "Send response" button. The only /answer form on the page is the sheet's.
  const card = html.slice(
    html.indexOf('class="parked-card"'),
    html.indexOf("</a>", html.indexOf('class="parked-card"')),
  );
  assert.doesNotMatch(card, /<form|<textarea|Send response/);
  assert.match(
    html,
    /waiting <span class="parked-waited" data-parked-at="2025-06-15T09:00:00.000Z">…<\/span> · blocked/,
  );
  // Exactly one /answer form remains — the sheet's reply-form.
  assert.equal(html.match(/action="\/answer"/g)?.length, 1);
});

test("serveAllStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(
    String(serveAllStatus),
    /server\.listen\(opts\.port,\s*opts\.host,/,
  );
});

test("formatStatusText summarizes waves, issue chips (with names), and the parked section", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          {
            issueNumber: "436",
            status: "completed",
            name: "Fix login redirect",
          },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "640", status: "running", name: "Add carve-out" },
          { issueNumber: "655", status: "parked" },
        ],
      },
    ],
    parked: [
      {
        issueNumber: "655",
        reason: "blocked",
        parkedAt: "now",
        branch: "agent/655",
        description: "?",
        options: [],
      },
    ],
  });

  assert.match(text, /jjforge — status/);
  assert.match(text, /Wave 1\/2 ✅ closed/);
  assert.match(text, /✅ #436 Fix login redirect/);
  assert.match(text, /Wave 2\/2 ▶️ running/);
  assert.match(text, /🔄 #640 Add carve-out/);
  // No name available → chip is just the status + number.
  assert.match(text, /⏸ #655$/m);
  assert.match(text, /1 awaiting your reply/);
  assert.match(text, /#655 — blocked/);
});

test("formatStatusText labels a wave-parked wave and a quarantined issue (ADR 0013)", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "wave-parked",
        issues: [
          { issueNumber: "611", status: "completed", name: "Fix parser" },
          { issueNumber: "640", status: "quarantined", name: "Add carve-out" },
        ],
      },
    ],
    parked: [],
  });

  // The held wave reads its own label, distinct from an issue parked.
  assert.match(text, /Wave 1\/1 ⏸ wave-parked/);
  // The quarantined issue carries its own emoji + status word.
  assert.match(text, /🚧 #640 Add carve-out/);
});

test("formatStatusText reports when nothing is running", () => {
  const text = formatStatusText({ project: "demo", waves: [], parked: [] });
  assert.match(text, /demo — status/);
  assert.match(text, /No active run/);
});

test("formatStatusText omits the parked section when nothing is parked", () => {
  const text = formatStatusText({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "1", status: "running" }],
      },
    ],
    parked: [],
  });
  assert.doesNotMatch(text, /awaiting your reply/);
});

test("renderStatusPage renders the landing live-bar top-right, not the old refresh widget (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "closed", issues: [] }],
    parked: [],
  });

  // The live-bar replaces the fixed-interval Refresh widget: a dot-only live/paused
  // indicator, an "updated Ns ago" readout, and an icon Pause button — the same shared
  // control the landing renders (#81). The indicator shows no visible "Live" text (its
  // state is an accessible label); the pause control carries no "Pause" text word.
  assert.match(
    html,
    /<div class="live-bar"[^>]*><span class="live-indicator" data-live-state="live" aria-label="Live"><\/span><span class="updated" data-updated>[^<]*<\/span><button type="button" id="pause" class="pause" data-paused="false" aria-label="Pause"><\/button><\/div>/,
  );
  // Paused, the pause-bar live indicator goes dim (not amber) and still — keyed off the
  // root paused flag now, never a per-element live-state rule (§5, #100).
  assert.match(
    html,
    /\[data-paused="true"\] \.live-bar \.live-indicator \{ color: var\(--color-dim\); \}/,
  );
  // The old interval widget is gone entirely.
  assert.doesNotMatch(html, /id="refresh-seconds"/);
  assert.doesNotMatch(html, /id="refresh-enabled"/);
  assert.doesNotMatch(html, /class="refresh"/);
  assert.doesNotMatch(html, /sandcastle-status-refresh/);
  // The h1 drops the " status" wording; with no dropdown it is just the project name.
  assert.match(
    html,
    /<div class="page-top"><h1>demo<\/h1><div class="live-bar"/,
  );
  assert.match(html, /\.page-top \{ display: flex;/);
});

test("both pages render one shared top-bar control: a dot-only live indicator and an icon pause (#81)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  const campaign = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { projects: ["alpha", "beta"], selected: "beta" },
  );

  // The live-bar is one shared definition, emitted verbatim by every page so the two
  // can no longer drift (the "Live"-word vs LIVE, pause-word vs icon divergence).
  const liveBar = renderTopBar("").match(
    /<div class="live-bar".*<\/div>/s,
  )?.[0];
  assert.ok(liveBar, "renderTopBar emits a live-bar");
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(liveBar),
      "every page includes the shared live-bar",
    );

  // The indicator is a dot only — no visible "Live"/"Paused" word; its state is an
  // accessible label instead. The pause control is an icon button with no "Pause" word.
  for (const page of [landing, campaign]) {
    assert.doesNotMatch(page, /<span class="live-indicator"[^>]*>Live<\/span>/);
    assert.doesNotMatch(page, /<button[^>]*class="pause"[^>]*>Pause<\/button>/);
    assert.match(
      page,
      /<span class="live-indicator" data-live-state="live" aria-label="Live"><\/span>/,
    );
    assert.match(
      page,
      /<button type="button" id="pause" class="pause" data-paused="false" aria-label="Pause"><\/button>/,
    );
  }

  // The pause icon lives in the shared CSS, flipped by a data attribute, so the two
  // pages' scripts never re-author it: two bars while live, a triangle once paused.
  // It is drawn in CSS with currentColor — never an emoji codepoint (⏸/▶ render as a
  // colourful gradient glyph on Apple platforms), so it stays monotone (#96).
  assert.doesNotMatch(TOP_BAR_STYLES, /⏸|▶/);
  assert.match(
    TOP_BAR_STYLES,
    /\.pause::before, \.pause::after \{ content: ""; [^}]*background: currentColor;[^}]*\}/,
  );
  assert.match(
    TOP_BAR_STYLES,
    /\.pause\[data-paused="true"\]::before \{[^}]*border-color: transparent transparent transparent currentColor;[^}]*\}/,
  );
  for (const page of [landing, campaign])
    assert.ok(
      page.includes(TOP_BAR_STYLES),
      "every page includes the shared top-bar styles",
    );
});

test("renderStatusPage updates live off /api/events, soft-refreshing on a ping unless composing (#79, #131)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // One SSE stream drives updates as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // Soft-refresh, not a full reload (#131): a live tick re-fetches this page and swaps only
  // the #live-region, so the issue sheet, its open compose, and scroll survive — worst over
  // the tailnet, where a full reload blanked the page.
  assert.doesNotMatch(html, /location\.reload\(\)/);
  assert.match(html, /id="live-region"/);
  assert.match(html, /fetch\(location\.href/);
  assert.match(html, /DOMParser/);
  assert.match(html, /getElementById\("live-region"\)/);
  assert.match(html, /softRefresh\(\)/);
  // Guarded: a reply being composed in any textarea freezes the refresh so it is never lost.
  assert.match(html, /const isComposing = \(\) =>/);
  assert.match(
    html,
    /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/,
  );
  assert.match(html, /if \(paused \|\| isComposing\(\)\) \{ buffered\+\+;/);
  // Pause is a presentation freeze that flushes on resume, exactly as the landing's is.
  assert.match(html, /pauseBtn\.addEventListener\("click"/);
  // The "updated Ns ago" readout is `freezeIntent`'s `updatedText` (dashboard-visual-state.ts,
  // asserted directly there), single-sourced into this page and written onto the readout.
  assert.match(html, /function freezeIntent/);
  assert.match(
    html,
    /updatedEl\.textContent = freezeIntent\(\{ paused, buffered, lastUpdate, now: Date\.now\(\) \}\)\.updatedText/,
  );
});

test("renderStatusPage marks carvable chips with carve data and never puts a carve control on a chip", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "101", status: "completed" }],
        },
        {
          index: 1,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 2,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { carve: true },
  );

  // Each member row carries its issue and project; only a still-carvable one is flagged
  // carvable, so the tap-detail panel knows whether to offer a Carve button.
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="301"[^>]*data-project="demo"[^>]*data-carvable="1"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="302"[^>]*data-project="demo"[^>]*data-carvable="1"/,
  );
  // The completed (banked) and current-wave-in-flight (running) rows are not carvable.
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-carvable/);
  assert.doesNotMatch(html, /data-issue="201"[^>]*data-carvable/);
  // Carve moved off the rows entirely: no inline ✂️ and no per-row carve form.
  assert.doesNotMatch(html, /✂️/);
  assert.doesNotMatch(html, /class="carve-form"/);
  assert.doesNotMatch(html, /class="chip-group"/);
  assert.doesNotMatch(html, /class="carve-btn"/);
});

test("renderStatusPage omits the carve control unless the page opts into it", () => {
  // The control is opt-in: both the standalone and the aggregated server pass
  // `carve: true`, but a bare render (e.g. the empty-registry page) shows none.
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /action="\/carve"/);
});

test("parseCarveClosure reads the structured closure line the dry-run prints", () => {
  // The dry-run prints a `carve-closure {json}` line (E2) carrying the exact
  // closure — target, the dependents that would leave, the banked work kept, and
  // the remaining waves — so the panel names each without re-parsing the prose.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    remaining: [["501"]],
  };
  assert.deepEqual(
    parseCarveClosure(
      `carve #201 → dropping #201, #401 (keeping banked #301)\nremaining campaign: "501"\ncarve-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
  // No structured line (e.g. an install predating E2) → null, so the route can 502
  // rather than half-render a closure it cannot vouch for.
  assert.equal(
    parseCarveClosure(
      "carve #201 → nothing to drop\nremaining campaign: (nothing left to run)",
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

test("highlightJsonLine colours JSON keys, strings, numbers and literals distinctly, escaping content", () => {
  const html = highlightJsonLine(
    '{"event":"green","turn":3,"ok":true,"x":null}',
  );
  // A key (string followed by a colon) reads distinct from a plain string value;
  // the quote characters are HTML-escaped in the source.
  assert.match(html, /<span class="jkey">&quot;event&quot;<\/span>:/);
  assert.match(html, /<span class="jstr">&quot;green&quot;<\/span>/);
  assert.match(html, /<span class="jnum">3<\/span>/);
  assert.match(html, /<span class="jbool">true<\/span>/);
  assert.match(html, /<span class="jnull">null<\/span>/);
  // HTML inside string content is escaped, never injected as live markup.
  const esc = highlightJsonLine('{"t":"<b>&x</b>"}');
  assert.match(
    esc,
    /<span class="jstr">&quot;&lt;b&gt;&amp;x&lt;\/b&gt;&quot;<\/span>/,
  );
  assert.doesNotMatch(esc, /<b>/);
});

test("cappedRawRows caps the rendered rows and reports the hidden remainder, keeping 1-based line numbers", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `{"n":${i}}`);
  const { rows, total, hidden } = cappedRawRows(lines, "", 500, 0);
  assert.equal(rows.length, 500, "renders only the cap");
  assert.equal(total, 1200, "total counts every line");
  assert.equal(hidden, 700, "hidden is the un-rendered remainder");
  // Line numbers are the original 1-based indices, in order.
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].line, '{"n":0}');
  assert.equal(rows[499].n, 500);
});

test("cappedRawRows filters before the cap and lets expandedCount reveal more", () => {
  // Every 10th line matches "gate"; the rest don't.
  const lines = Array.from({ length: 1200 }, (_, i) =>
    i % 10 === 0 ? `{"event":"gate","i":${i}}` : `{"event":"turn","i":${i}}`,
  );
  // Filter narrows to 120 matches — fewer than the cap, so all show, nothing hidden.
  const filtered = cappedRawRows(lines, "gate", 500, 0);
  assert.equal(filtered.total, 120, "total is the filtered match count");
  assert.equal(filtered.rows.length, 120, "all matches render under the cap");
  assert.equal(filtered.hidden, 0);
  assert.equal(filtered.rows[0].n, 1, "first match keeps its original index");
  assert.equal(filtered.rows[1].n, 11);
  // Expanding raises the render count by the expanded amount.
  const expanded = cappedRawRows(lines, "", 500, 300);
  assert.equal(expanded.rows.length, 800, "cap + expandedCount rows render");
  assert.equal(expanded.hidden, 400);
});

test("isNotableHostEvent flags a fail/error kind or a row carrying error/ok:false, and passes routine rows", () => {
  // A kind matching /fail|error/i is notable — an SSE watch failure, a registry read error.
  assert.equal(isNotableHostEvent({ ts: "t", event: "dashboard-events-watch-failed" }), true);
  assert.equal(isNotableHostEvent({ ts: "t", event: "registry-read-error" }), true);
  // Case-insensitive on the kind.
  assert.equal(isNotableHostEvent({ ts: "t", event: "TelegramSendFailure" }), true);
  // A row carrying an `error` field is notable even when its kind reads routine.
  assert.equal(isNotableHostEvent({ ts: "t", event: "telegram-send", error: "429 Too Many Requests" }), true);
  // An `ok: false` field is notable; `ok: true` is not, on its own.
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", ok: false }), true);
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", ok: true }), false);
  // A routine host event with no error signal is not notable.
  assert.equal(isNotableHostEvent({ ts: "t", event: "gateway-routed", project: "acme" }), false);
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
  // killed mid-wave, so it reads interrupted and expands to its partial waves.
  writeJsonl(join(archiveDir, "orchestrator-2026-02-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["301"], ["302"]], slots: 1 }),
    event("campaign-batch", { index: 0, tasks: ["301"] }),
  ]);
  // A halted run stopped short — later waves never ran — so it too reads interrupted.
  writeJsonl(join(archiveDir, "orchestrator-2026-03-01T00-00-00-000Z.jsonl"), [
    event("campaign-start", { batches: [["401"], ["402"]], slots: 1 }),
    event("campaign-halt", { taskId: "401", reason: "gate failed", index: 0 }),
  ]);

  const runs = listArchivedRuns(dir);
  const byRun = Object.fromEntries(runs.map((r) => [r.run, r]));

  assert.equal(byRun["2026-01-01T00-00-00-000Z"].state, "complete");
  assert.equal(byRun["2026-01-01T00-00-00-000Z"].issues, 3);
  assert.equal(
    byRun["2026-01-01T00-00-00-000Z"].startedAt,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].state, "interrupted");
  assert.equal(byRun["2026-02-01T00-00-00-000Z"].issues, 2);
  assert.equal(byRun["2026-03-01T00-00-00-000Z"].state, "interrupted");
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
  // A campaign that halted on a failing issue — one issue, halted, singular noun.
  assert.equal(
    summarizeRun([
      event("campaign-start", { batches: [["101"]], slots: 1 }),
      event("campaign-halt", { index: 0, taskId: "101", reason: "gate failed" }),
    ]),
    "campaign · 1 issue · halted",
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
  // earlier run halted on #61, then a fresh campaign ran the remainder to completion
  // (this is the shape of the real vetinari archive that read as "halted").
  // The summary must reflect the terminal run — complete, four issues — not fold the
  // stale campaign-halt from the superseded earlier run into a false "halted", and
  // its count must be the last run's, not the whole file's.
  const events = [
    event("campaign-start", { batches: [["56", "57"], ["61"]], slots: 1, name: "first" }),
    event("campaign-halt", { index: 1, taskId: "61", reason: "merge conflict" }),
    event("campaign-start", { batches: [["63"], ["64"], ["65"], ["67"]], slots: 1, name: "second" }),
    event("campaign-batch-done", { index: 0, merged: ["63"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 1, merged: ["64"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 2, merged: ["65"], held: [], clearedParked: [] }),
    event("campaign-batch-done", { index: 3, merged: ["67"], held: [], clearedParked: [] }),
    event("campaign-done", { batches: 4 }),
  ];
  assert.equal(summarizeRun(events), "campaign · 4 issues · complete");
});

test("summarizeRun still reports halted when the last run halted after an earlier one completed (#69)", () => {
  // The mirror case: an earlier run completed, then a fresh campaign halted. The
  // terminal run halted, so the summary must say halted — the scoping must not swing
  // the other way and hide a genuine halt behind an earlier clean run.
  const events = [
    event("campaign-start", { batches: [["101"]], slots: 1, name: "first" }),
    event("campaign-done", { batches: 1 }),
    event("campaign-start", { batches: [["201"], ["202"]], slots: 1, name: "second" }),
    event("campaign-halt", { index: 0, taskId: "201", reason: "gate failed" }),
  ];
  assert.equal(summarizeRun(events), "campaign · 2 issues · halted");
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

test("renderStatusPage renders closed waves as a compact toggle row of chip buttons", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          { issueNumber: "101", status: "completed" },
          { issueNumber: "102", status: "completed" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave is a toggle button (no native <details>/<summary>), carrying the
  // compact "Wave N" label + its merged/total tally + a chevron affordance, wired to
  // its card via aria-controls and defaulting to collapsed (aria-expanded="false").
  assert.doesNotMatch(html, /<details class="completed-wave"/);
  assert.doesNotMatch(html, /<summary/);
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
});

test("renderStatusPage renders each expanded closed wave's full card in the grid before the open waves", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [
          { issueNumber: "101", status: "completed", name: "cart persists" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave gets the SAME wave-card treatment as an open wave — a CLOSED pill,
  // its merged/total, and the merged member list — living in the waves-grid under a
  // stable id, hidden until its chip toggles it open.
  assert.match(
    html,
    /<section class="wave closed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — cart persists<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status closed">closed<\/span><\/div><\/div>/,
  );
  // The closed card renders inside the same grid, positioned before the open running wave.
  const grid = html.match(
    /<div class="waves-grid">([\s\S]*?)<\/div>\s*(?:<section class="archived|<div id="issue-detail"|<noscript|<script)/,
  );
  assert.ok(grid, "expected a waves-grid");
  assert.ok(
    grid[1].indexOf('id="closed-wave-0"') < grid[1].indexOf("Wave 2"),
    "closed card should precede the open wave",
  );
});

test("renderStatusPage gives the closed-wave chip a chevron and a green accent when expanded", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The chevron is CSS keyed off aria-expanded (collapsed › → expanded ⌄), and an
  // expanded chip takes a green accent border.
  assert.match(html, /\.completed-wave-chip::after \{[^}]*content: "›"/);
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\]::after \{[^}]*content: "⌄"/,
  );
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\] \{[^}]*border-color: var\(--color-green\)/,
  );
});

test("renderStatusPage persists the expanded closed-wave set across a live reload", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The toggle row carries its project so the client can key the persisted open-set
  // per repo, and the script reads/writes it through storage so a /api/events reload
  // does not silently collapse everything the user opened.
  assert.match(html, /<div class="completed-wave-bar" data-project="beta">/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /completed-wave-chip/);
});

test("renderStatusPage degrades the closed-wave toggle without JS", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "closed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // Without JS the cards can never be toggled open, so a <noscript> reveals every
  // closed card in the grid and hides the inert toggle bar — the content stays reachable.
  assert.match(
    html,
    /<noscript><style>[^<]*\.completed-wave-bar \{ display: none;[^<]*\.wave\.closed\[hidden\] \{ display: block;/,
  );
});

test("renderStatusPage renders an archived run's closed waves as full cards, not colliding toggle ids", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "closed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          // A finished run — every wave is closed.
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "closed",
                issues: [
                  { issueNumber: "101", status: "completed", name: "old work" },
                ],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The live run's closed wave still uses the toggle (chip + hidden card, id closed-wave-0).
  assert.match(html, /aria-controls="closed-wave-0"/);
  // The archived row's campaign pane renders its closed wave as a full, always-expanded
  // card — no second toggle bar and no duplicated id="closed-wave-0" that would hijack
  // the live card.
  const paneStart = html.indexOf('class="archive-pane archive-campaign"');
  const pane = html.slice(paneStart, html.indexOf('class="archive-pane archive-raw"', paneStart));
  assert.doesNotMatch(pane, /completed-wave-bar/);
  assert.doesNotMatch(pane, /id="closed-wave-0"/);
  assert.match(
    pane,
    /<section class="wave closed"><div class="wave-head"><h2 class="wave-label">Wave 1 — old work<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status closed">closed<\/span>/,
  );
  // Exactly one element carries the toggle id across the whole page (no duplicate ids).
  assert.equal(html.split('id="closed-wave-0"').length - 1, 1);
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

test("buildStatus renders a grafted issue as `grafted` while unstarted, then running on pickup (#166)", () => {
  const dir = join(tmpdir(), `vetinari-status-graft-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", { ts: "2025-01-01T00:00:00.000Z", batches: [["101"], ["201"]], slots: 1 }),
    event("campaign-batch", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101"] }),
    event("graft", { ts: "2025-01-01T00:02:00.000Z", ids: ["301"], blockedBy: {}, basenames: {} }),
  ]);

  const status = buildStatus(cfgFor(dir));
  // 301 joined wave 1 (index 1) and reads `grafted` while it waits there.
  const graftedChip = status.waves.flatMap((w) => w.issues).find((i) => i.issueNumber === "301");
  assert.equal(graftedChip?.status, "grafted");
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
  // A wave-parked run is not done/halted, so graft is allowed against it.
  assert.equal(campaignRunning(log), true);
  const reduced = reduceCampaign(log);
  // 301 re-layers into a future wave; the parked wave 0 (101) is untouched.
  assert.ok(reduced.waves.flat().includes("301"));
  assert.deepEqual(reduced.waves[0], ["101"]);
  assert.equal(reduced.grafted.has("301"), true);
});
