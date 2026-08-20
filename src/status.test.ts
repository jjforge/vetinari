import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { buildStatus, buildStatusWithIssueNames, extractParkedDetails, renderStatusPage, serveStatus } from "./status.ts";

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

test("buildStatus shows campaign waves with issue chips and statuses", () => {
  const dir = join(tmpdir(), `sctdd-status-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-done", outcomes: { "101": "green", "102": "parked" } },
  ]);
  writeFileSync(
    join(dir, "parked", "102.json"),
    JSON.stringify({ taskId: "102", parkedAt: "now", reason: "blocked", branch: "agent/102", sessionId: "s", question: "Need a choice.\n\nOptions:\n- A: do the simple thing\n- B: do the robust thing" }),
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
  assert.deepEqual(status.parked[0].options, ["A: do the simple thing", "B: do the robust thing"]);
});

test("buildStatus marks completed waves as closed", () => {
  const dir = join(tmpdir(), `sctdd-status-closed-wave-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: ["101"], held: [] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
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

test("buildStatus marks active wave issues as running before they finish", () => {
  const dir = join(tmpdir(), `sctdd-status-running-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101", "102"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-start", taskIds: ["101", "102"], slots: 2 },
    { ts: "2025-01-01T00:03:00.000Z", event: "green", taskId: "101" },
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

test("buildStatus does not show parked interaction cards for closed wave issues", () => {
  const dir = join(tmpdir(), `sctdd-status-closed-parked-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101"], ["201"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "campaign-batch", index: 0, tasks: ["101"] },
    { ts: "2025-01-01T00:02:00.000Z", event: "campaign-batch-done", index: 0, merged: [], held: ["101"] },
    { ts: "2025-01-01T00:03:00.000Z", event: "campaign-batch", index: 1, tasks: ["201"] },
  ]);
  for (const taskId of ["101", "201"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({ taskId, parkedAt: "now", reason: "blocked", branch: `agent/${taskId}`, sessionId: "s", question: "Need a choice." }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(status.parked.map((p) => p.issueNumber), ["201"]);
});

test("buildStatus only shows parked cards for issues in the active campaign", () => {
  const dir = join(tmpdir(), `sctdd-status-filter-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["243"]] }]);
  for (const taskId of ["243", "999"]) {
    writeFileSync(
      join(dir, "parked", `${taskId}.json`),
      JSON.stringify({ taskId, parkedAt: "now", reason: "blocked", branch: `agent/${taskId}`, sessionId: "s", question: "Need a choice." }),
    );
  }

  const status = buildStatus(cfgFor(dir));

  assert.deepEqual(status.parked.map((p) => p.issueNumber), ["243"]);
});

test("buildStatus adds rough activity details for issue hover", () => {
  const dir = join(tmpdir(), `sctdd-status-activity-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [
    { ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102", "103"]] },
    { ts: "2025-01-01T00:01:00.000Z", event: "queue-start", taskIds: ["101", "102", "103"], slots: 3 },
    { ts: "2025-01-01T00:02:00.000Z", event: "queue-spawn", taskId: "101", running: 1, left: 2 },
    { ts: "2025-01-01T00:03:00.000Z", event: "turn", taskId: "101", turn: 2, signal: "<promise>COMPLETE</promise>" },
    { ts: "2025-01-01T00:04:00.000Z", event: "green", taskId: "102", branch: "agent/102" },
    { ts: "2025-01-01T00:05:00.000Z", event: "parked", taskId: "103", reason: "blocked" },
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
  const dir = join(tmpdir(), `sctdd-status-issue-names-${Date.now()}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), [{ ts: "2025-01-01T00:00:00.000Z", event: "campaign-start", batches: [["101", "102"]] }]);

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    fetchTask: async (id: string) => (id === "101" ? JSON.stringify({ title: "Add login flow" }) : "no structured title"),
  });

  assert.equal(status.waves[0].issues[0].name, "Add login flow");
  assert.equal(status.waves[0].issues[1].name, undefined);
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
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running", name: "Add login flow", detail: "Agent turn 2 finished; waiting for verification/resume" }] }], parked: [] });

  assert.match(html, /data-detail="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/);
  assert.match(html, /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/resume"/);
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /chip\.addEventListener\("click"/);
});

test("renderStatusPage collapses closed waves into expandable completed wave chips", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "101", status: "completed" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
    ],
    parked: [],
  });

  assert.match(html, /<div class="completed-waves"><span class="completed-label">Completed:<\/span>/);
  assert.match(html, /<details class="completed-wave"><summary class="completed-wave-chip">Wave 1<\/summary>/);
  assert.doesNotMatch(html, /<section class="completed-waves"><h2>Completed waves<\/h2>/);
  assert.match(html, /<section class="wave"><h2>Wave 2 <span class="wave-status running">running<\/span><\/h2>/);
});

test("serveStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(String(serveStatus), /server\.listen\(opts\.port,\s*opts\.host,/);
});

test("renderStatusPage includes a configurable refresh interval control", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "closed", issues: [] }], parked: [] });

  assert.match(html, /<summary class="completed-wave-chip">Wave 1<\/summary>/);
  assert.match(html, /class="refresh" title="Seconds between refreshes; 0 disables auto-refresh"/);
  assert.match(html, /id="refresh-seconds"/);
  assert.match(html, /max="999"/);
  assert.match(html, /\.refresh input \{ width: 3ch;/);
  assert.match(html, /<span>Refresh<\/span>/);
  assert.doesNotMatch(html, /Refresh every/);
  assert.match(html, /<div class="page-top"><h1>demo status<\/h1><div class="refresh"/);
  assert.match(html, /\.page-top \{ display: flex;/);
  assert.doesNotMatch(html, /\.refresh \{ position: (?:sticky|fixed);/);
  assert.match(html, /\.running \{ background: var\(--color-blue\); \}/);
  assert.match(html, /localStorage\.getItem\("sandcastle-status-refresh-seconds"\) \?\? "45"/);
  assert.match(html, /isComposing\(\) \? scheduleRefresh\(\) : location\.reload\(\)/);
  assert.match(html, /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/);
});

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails("I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?");

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, ["Return raw JSON", "Render HTML server-side"]);
});
