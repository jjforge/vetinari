// Tests for the dashboard's archived-run listing — listing a project's archived runs, their
// one-line summaries, terminal state and run-token timestamps (dashboard-archived-runs.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArchivedRuns, parseRunTimestamp, summarizeRun } from "./dashboard-archived-runs.ts";
import { event } from "./event-log.ts";

const writeJsonl = (path: string, events: unknown[]) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

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
