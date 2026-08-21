import test from "node:test";
import assert from "node:assert/strict";
import { formatStatusLine } from "./statusline.ts";

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

  assert.match(line, /jjforge/);
  assert.match(line, /wave 2\/3/);
  assert.match(line, /✅2/);
  assert.match(line, /🔄1/);
  assert.match(line, /⏸1/);
  assert.match(line, /⚪1/);
  assert.equal(line.includes("\n"), false, "must be a single line");
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
  assert.match(line, /demo/);
  assert.match(line, /idle/);
});
