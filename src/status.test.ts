import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { buildStatus, buildStatusWithIssueNames, extractParkedDetails, formatStatusText, renderStatusPage, serveStatus } from "./status.ts";
import { isStatusCommand } from "./modes.ts";

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

test("renderStatusPage pins the tapped-issue detail to a dismissible bottom bar", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Fixed to the bottom of the viewport and hidden until a chip is tapped.
  assert.match(html, /\.issue-detail \{ position: fixed;[^}]*bottom: 0;/);
  assert.match(html, /\.issue-detail \{[^}]*display: none;/);
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  // Text lives in its own span so the close button can sit beside it.
  assert.match(html, /<span class="issue-detail-text"><\/span><button type="button" id="issue-detail-close"/);
  assert.match(html, /showDetail\(issueDetailText\.textContent === text \? "" : text\)/);
  assert.match(html, /getElementById\("issue-detail-close"\)\.addEventListener\("click", \(\) => showDetail\(""\)\)/);
});

test("renderStatusPage leads with parked issues above the waves when any are parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "101", status: "running" }] }],
    parked: [{ issueNumber: "102", reason: "blocked", parkedAt: "now", branch: "agent/102", description: "Need a choice.", options: [] }],
  });

  assert.match(html, /<section class="parked-issues"><h2>Parked issues <span class="parked-count">1 awaiting you<\/span>/);
  // Parked section comes before the first wave section.
  assert.ok(html.indexOf('class="parked-issues"') < html.indexOf('class="wave"'), "parked should render above the waves");
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
});

test("renderStatusPage omits the parked section entirely when nothing is parked", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "running", issues: [] }], parked: [] });

  assert.doesNotMatch(html, /Parked issues/);
  assert.doesNotMatch(html, /Nothing parked/);
  assert.doesNotMatch(html, /class="parked-issues"/);
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

  assert.match(html, /<div class="completed-waves"><div class="completed-wave-bar">/);
  assert.doesNotMatch(html, /Completed:/);
  assert.match(html, /<details class="completed-wave"><summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1<\/summary>/);
  assert.match(html, /\.completed-wave-chip \.check \{ color: var\(--color-green\);/);
  // Expanded summary is block-level (no inline line-box leading) and spaced from its chips.
  assert.match(html, /\.completed-wave\[open\] > \.completed-wave-chip \{ display: flex; width: max-content; margin-bottom: \.6rem; \}/);
  // Chip rows must not stretch: the first wrapped line was rendering taller in Safari.
  assert.match(html, /\.completed-wave-bar, \.chips \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/);
  assert.match(html, /<section class="wave"><h2>Wave 2 <span class="wave-status running">running<\/span><\/h2>/);
});

test("serveStatus can bind to a non-localhost host for tailnet access", () => {
  assert.match(String(serveStatus), /server\.listen\(opts\.port,\s*opts\.host,/);
});

test("formatStatusText summarizes waves, issue chips (with names), and the parked section", () => {
  const text = formatStatusText({
    project: "jjforge",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "436", status: "completed", name: "Fix login redirect" }] },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "640", status: "running", name: "Add carve-out" },
          { issueNumber: "655", status: "parked" },
        ],
      },
    ],
    parked: [{ issueNumber: "655", reason: "blocked", parkedAt: "now", branch: "agent/655", description: "?", options: [] }],
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

test("formatStatusText reports when nothing is running", () => {
  const text = formatStatusText({ project: "demo", waves: [], parked: [] });
  assert.match(text, /demo — status/);
  assert.match(text, /No active run/);
});

test("formatStatusText omits the parked section when nothing is parked", () => {
  const text = formatStatusText({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "1", status: "running" }] }],
    parked: [],
  });
  assert.doesNotMatch(text, /awaiting your reply/);
});

test("isStatusCommand recognizes status queries and ignores answers", () => {
  for (const t of ["/status", "status", "/status@my_bot", "  Status ", "STATUS"]) assert.equal(isStatusCommand(t), true, t);
  for (const t of ["A", "use option B", "status of the world is fine", "", "s"]) assert.equal(isStatusCommand(t), false, t);
});

test("renderStatusPage includes a configurable refresh interval control", () => {
  const html = renderStatusPage({ project: "demo", waves: [{ index: 0, status: "closed", issues: [] }], parked: [] });

  assert.match(html, /<summary class="completed-wave-chip"><span class="check" aria-hidden="true">✓<\/span> Wave 1<\/summary>/);
  assert.match(html, /class="refresh" title="Auto-refresh the page every N seconds"/);
  assert.match(html, /<input id="refresh-enabled" type="checkbox" checked \/> <span>Refresh<\/span>/);
  assert.doesNotMatch(html, /Auto-refresh<\/span>|>every<|>s<\/span>/);
  // No pill/chip background around the control.
  assert.doesNotMatch(html, /\.refresh \{[^}]*border-radius: 999px/);
  assert.match(html, /id="refresh-seconds"/);
  assert.match(html, /max="999"/);
  assert.match(html, /\.refresh input\[type="number"\] \{ width: 3ch;/);
  assert.match(html, /<div class="page-top"><h1>demo status<\/h1><div class="refresh"/);
  assert.match(html, /\.page-top \{ display: flex;/);
  assert.doesNotMatch(html, /\.refresh \{ position: (?:sticky|fixed);/);
  assert.match(html, /\.running \{ background: var\(--color-blue\); \}/);
  assert.match(html, /localStorage\.getItem\("sandcastle-status-refresh-seconds"\) \?\? "45"/);
  assert.match(html, /isComposing\(\) \? scheduleRefresh\(\) : location\.reload\(\)/);
  assert.match(html, /el === document\.activeElement \|\| el\.value\.trim\(\) !== ""/);
});

test("renderStatusPage auto-refresh checkbox gates and persists the timer", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Checkbox toggles auto-refresh, defaults on unless previously disabled.
  assert.match(html, /refreshEnabled\.checked = localStorage\.getItem\("sandcastle-status-refresh-enabled"\) !== "false"/);
  assert.match(html, /localStorage\.setItem\("sandcastle-status-refresh-enabled", String\(refreshEnabled\.checked\)\)/);
  // Timer only arms when the box is checked; the interval field disables when off.
  assert.match(html, /refreshInput\.disabled = !refreshEnabled\.checked/);
  assert.match(html, /if \(refreshEnabled\.checked && Number\.isFinite\(seconds\) && seconds > 0\)/);
  assert.match(html, /refreshEnabled\.addEventListener\("change", scheduleRefresh\)/);
});

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails("I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?");

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, ["Return raw JSON", "Render HTML server-side"]);
});
