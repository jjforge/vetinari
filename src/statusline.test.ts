import test from "node:test";
import assert from "node:assert/strict";
import { formatContextLine, formatStatusLine, trimModelName } from "./statusline.ts";

test("formatStatusLine summarizes the running wave and status counts on one line", () => {
  const line = formatStatusLine({
    project: "jjforge",
    waves: [
      { index: 0, status: "closed", issues: [{ issueNumber: "436", status: "completed" }, { issueNumber: "611", status: "completed" }] },
      { index: 1, status: "running", issues: [{ issueNumber: "640", status: "running" }, { issueNumber: "655", status: "parked" }] },
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

test("formatStatusLine counts a grafted issue by its lifecycle (unstarted ⚪) — the reported graft case", () => {
  // A grafted issue is `unstarted` on the lifecycle axis with a `grafted` membership badge
  // (ADR 0019), so the compact bar counts it as ⚪ queued work, not a separate glyph.
  const line = formatStatusLine({
    project: "jjforge",
    waves: [
      { index: 0, status: "running", issues: [{ issueNumber: "186", status: "running" }, { issueNumber: "171", status: "running" }] },
      { index: 1, status: "unstarted", issues: [{ issueNumber: "168", status: "unstarted" }, { issueNumber: "193", status: "unstarted" }] },
      { index: 2, status: "unstarted", issues: [{ issueNumber: "195", status: "unstarted", membership: "grafted" }, { issueNumber: "196", status: "unstarted", membership: "grafted" }] },
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

test("formatStatusLine drops zero-count segments and omits the wave when none is running", () => {
  const line = formatStatusLine({
    project: "demo",
    waves: [{ index: 0, status: "closed", issues: [{ issueNumber: "1", status: "completed" }] }],
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
