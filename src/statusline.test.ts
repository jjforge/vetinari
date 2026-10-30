import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./config.ts";
import { event } from "./event-log.ts";
import { registerProject } from "./host-slots.ts";
import { campaignStatusLine, formatContextLine, formatStatusLine, trimModelName } from "./statusline.ts";

test("formatStatusLine summarizes the running wave and status counts on one line", () => {
  const line = formatStatusLine({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [
          { issueNumber: "436", status: "completed" },
          { issueNumber: "611", status: "completed" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "640", status: "running" },
          { issueNumber: "655", status: "parked" },
        ],
      },
      { index: 2, status: "unstarted", issues: [{ issueNumber: "720", status: "unstarted" }] },
    ],
    parked: [],
  });

  assert.doesNotMatch(line, /jjforge/); // project name is omitted — line 1 already shows the directory
  assert.match(line, /wave 2\/3/);
  assert.match(line, /✅2/);
  assert.match(line, /🔄1/);
  assert.match(line, /⏸1/);
  assert.match(line, /⚪1/);
  assert.equal(line.includes("\n"), false, "must be a single line");
});

test("formatStatusLine numbers the running wave by its display index past a pruned wave", () => {
  // A wave whose every member was pruned stays a display wave, so the running wave behind it
  // reads as wave 2 of 2 — the number the dashboard and event log give it.
  const line = formatStatusLine({
    project: "jjforge",
    waves: [
      { index: 0, status: "unstarted", pruned: true, issues: [{ issueNumber: "1", status: "unstarted", membership: "pruned" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "2", status: "running" }] },
    ],
    parked: [],
  });

  assert.match(line, /wave 2\/2/);
});

test("formatStatusLine counts a grafted issue by its lifecycle (unstarted ⚪) — the reported graft case", () => {
  // A grafted issue is `unstarted` on the lifecycle axis with a `grafted` membership badge
  // (ADR 0019), so the compact bar counts it as ⚪ queued work, not a separate glyph.
  const line = formatStatusLine({
    project: "jjforge",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "186", status: "running" },
          { issueNumber: "171", status: "running" },
        ],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [
          { issueNumber: "168", status: "unstarted" },
          { issueNumber: "193", status: "unstarted" },
        ],
      },
      {
        index: 2,
        status: "unstarted",
        issues: [
          { issueNumber: "195", status: "unstarted", membership: "grafted" },
          { issueNumber: "196", status: "unstarted", membership: "grafted" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(line, /🔄2/);
  assert.match(line, /⚪4/); // 2 unstarted + 2 grafted (both `unstarted` lifecycle), not ⚪2
});

test("formatStatusLine counts each chip by its clean lifecycle and excludes a pruned member (ADR 0019)", () => {
  // With the two-axis split the status is already a clean bucket: a merge-conflict or a
  // stalled hold reads `parked`, and a `pruned` member (its badge on the membership axis)
  // counts in no bucket — so nothing needs an overlay→base fold any more.
  const line = formatStatusLine({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "parked",
        issues: [
          { issueNumber: "1", status: "unstarted" },
          { issueNumber: "2", status: "parked", reason: "stalled" },
          { issueNumber: "3", status: "parked", reason: "conflict" },
          { issueNumber: "5", status: "unstarted", membership: "pruned" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(line, /⚪1/); // the one live unstarted; the pruned member is excluded
  assert.match(line, /⏸2/); // the stalled + conflict holds both read parked
  assert.doesNotMatch(line, /❌/); // no failure present
});

test("formatStatusLine prints the settled park-reason words for held members and a red base (#295)", () => {
  // Beyond the five state counts, the line names why work is parked, in the settled reason
  // vocabulary: a member's own reason (conflict/question/…) and the wave-level `red-base`
  // hold, which reads as two words. One line, no newline.
  const line = formatStatusLine({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "parked",
        reason: "red-base",
        issues: [
          { issueNumber: "1", status: "completed" },
          { issueNumber: "2", status: "completed" },
        ],
      },
      {
        index: 1,
        status: "parked",
        issues: [
          { issueNumber: "3", status: "parked", reason: "conflict" },
          { issueNumber: "4", status: "parked", reason: "question" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(line, /⏸2/); // the two held members
  assert.match(line, /conflict/);
  assert.match(line, /question/);
  assert.match(line, /red base/); // the wave-level red-base hold, spelled as two words
  assert.equal(line.includes("\n"), false, "must be a single line");
});

test("formatStatusLine drops zero-count segments and omits the wave when none is running", () => {
  const line = formatStatusLine({
    project: "demo",
    waves: [{ index: 0, status: "completed", issues: [{ issueNumber: "1", status: "completed" }] }],
    parked: [],
  });

  assert.match(line, /✅1/);
  assert.doesNotMatch(line, /🔄/);
  assert.doesNotMatch(line, /⏸/);
  assert.doesNotMatch(line, /wave/);
});

test("formatStatusLine shows an idle marker when no run is active", () => {
  const line = formatStatusLine({ project: "demo", waves: [], parked: [] });
  assert.equal(line, "🏰 idle");
});

test("formatContextLine joins model, dir, branch, and context% and rounds the percent", () => {
  assert.equal(
    formatContextLine({ model: "Opus 4.8", dir: "jjforge", branch: "develop", contextPct: 23.5 }),
    "Opus 4.8 · jjforge · develop · 24%",
  );
});

test("formatContextLine drops any part that is absent", () => {
  assert.equal(formatContextLine({ model: "Opus 4.8", dir: "jjforge" }), "Opus 4.8 · jjforge");
  assert.equal(formatContextLine({ model: "Opus 4.8", branch: "main", contextPct: 0 }), "Opus 4.8 · main · 0%");
  assert.equal(formatContextLine({}), "");
});

test("trimModelName drops a trailing context-window parenthetical", () => {
  assert.equal(trimModelName("Opus 4.8 (1M context)"), "Opus 4.8");
  assert.equal(trimModelName("Opus 4.8 (200K context)"), "Opus 4.8");
  assert.equal(trimModelName("Opus 4.8"), "Opus 4.8");
  assert.equal(trimModelName("Sonnet 4.5 (Beta)"), "Sonnet 4.5 (Beta)"); // only context parentheticals are stripped
  assert.equal(trimModelName(undefined), undefined);
});

// Spawn the real CLI: `runStatusLine` reads `process.stdin` directly, and Claude Code
// blanks the status bar on a non-zero exit, so the exit status is the contract.
const STATUSLINE_CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const STATUSLINE_TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function runStatuslineCli(input: string, opts: { cwd?: string; args?: string[] } = {}) {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "vetinari-statusline-"));
  return spawnSync(STATUSLINE_TSX, [STATUSLINE_CLI, "statusline", ...(opts.args ?? [])], { cwd, input, encoding: "utf8" });
}

test("statusline exits 0 when the model name is not a string", () => {
  const run = runStatuslineCli(`{"model":{"display_name":5}}`);
  assert.equal(run.status, 0, run.stderr);
});

test("statusline still trims a real model name to line 1", () => {
  const run = runStatuslineCli(`{"model":{"display_name":"Opus 4.8 (1M context)"}}`);
  assert.equal(run.status, 0, run.stderr);
  const line1 = run.stdout.split("\n")[0];
  assert.match(line1, /Opus 4\.8/);
  assert.doesNotMatch(line1, /1M context/);
});

test("statusline exits 0 on malformed or hostile stdin", () => {
  const inputs = [
    `{}`,
    `not json`,
    `null`,
    `[]`,
    `{"model":null}`,
    `{"workspace":{"current_dir":42}}`,
    `{"cwd":"/nonexistent/dir"}`,
    `{"context_window":{"used_percentage":"x"}}`,
  ];
  for (const input of inputs) {
    const run = runStatuslineCli(input);
    assert.equal(run.status, 0, `stdin ${input}: ${run.stderr}`);
  }
});

test("statusline exits 0 when the project's config fails to load", () => {
  const cwd = mkdtempSync(join(tmpdir(), "vetinari-statusline-"));
  mkdirSync(join(cwd, "vetinari"));
  writeFileSync(join(cwd, "vetinari", "config.mts"), "export default {{{ not valid typescript\n");
  const run = runStatuslineCli(`{"model":{"display_name":"Opus"}}`, { cwd });
  assert.equal(run.status, 0, run.stderr);
});

test("statusline exits 0 and falls back to its own line 1 when the wrapped base command fails", () => {
  const base = Buffer.from("exit 3").toString("base64");
  const run = runStatuslineCli(`{"model":{"display_name":"Opus"}}`, { args: ["--base-b64", base] });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.split("\n")[0], "Opus");
});

// Line 2 off a real log: a `parked` question then `answered` for 801, with 802 still running.
const answeredParkCfg = (): { cfg: ResolvedConfig; configDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-statusline-answered-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  const events = [
    event("campaign-start", { ts: "2026-09-02T04:00:00.000Z", waves: [["801", "802"], ["803"]], slots: 2 }),
    event("wave-start", { ts: "2026-09-02T04:01:00.000Z", index: 0, tasks: ["801", "802"] }),
    event("spawn", { ts: "2026-09-02T04:02:00.000Z", taskId: "801", running: 1, left: 1 }),
    event("spawn", { ts: "2026-09-02T04:02:01.000Z", taskId: "802", running: 2, left: 0 }),
    event("parked", { ts: "2026-09-02T04:10:00.000Z", taskId: "801", reason: "question", detail: "Which?" }),
    event("answered", { ts: "2026-09-02T04:20:00.000Z", taskId: "801", source: "ui" }),
  ];
  writeFileSync(join(dir, "logs", "orchestrator.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(
    join(dir, "parked", "801.json"),
    JSON.stringify({
      taskId: "801",
      parkedAt: "2026-09-02T04:10:00.000Z",
      reason: "question",
      branch: "agent/801",
      question: "Which?",
      answer: "Redis",
      answeredAt: "2026-09-02T04:20:00.000Z",
    }),
  );
  const cfg = {
    project: "demo",
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
  } as ResolvedConfig;
  return { cfg, configDir: join(dir, "gw-home") };
};

test("campaignStatusLine reads an answered park as running while a live campaign owns its re-admit", () => {
  const { cfg, configDir } = answeredParkCfg();
  registerProject(configDir, cfg.project, 1, "campaign", 0, { pid: process.pid });

  const line = campaignStatusLine(cfg, configDir);
  assert.match(line, /🔄2/);
  assert.doesNotMatch(line, /⏸/);
  assert.doesNotMatch(line, /question/);
});

test("campaignStatusLine keeps an answered park parked, and a running issue running, with no live campaign lease", () => {
  const { cfg, configDir } = answeredParkCfg();

  // `alive` is left undefined, never `false`: 802 still reads 🔄, not crash-folded to parked.
  assert.equal(campaignStatusLine(cfg, configDir), "🏰 🔄1 ⏸1 ⚪1 · question");
});

test("campaignStatusLine does not count a standalone run's lease as a live campaign", () => {
  const { cfg, configDir } = answeredParkCfg();
  registerProject(configDir, cfg.project, 1, "run", 0, { pid: process.pid });

  assert.equal(campaignStatusLine(cfg, configDir), "🏰 🔄1 ⏸1 ⚪1 · question");
});
