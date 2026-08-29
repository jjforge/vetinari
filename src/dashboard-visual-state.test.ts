import test from "node:test";
import assert from "node:assert/strict";
import {
  dotClass,
  freezeIntent,
  paneActivity,
  tallyDotClass,
} from "./dashboard-visual-state.ts";

test("dotClass maps a status to its dot state-class fragment (verbatim today)", () => {
  assert.equal(dotClass("running"), "running");
  assert.equal(dotClass("parked"), "parked");
  assert.equal(dotClass("pruned"), "pruned");
});

test("tallyDotClass stills a 0-running tally dot with idle but keeps the blue (§5, #100)", () => {
  // A running dot pulses to signal work; a "0 running" tally has none, so it reads
  // idle (no pulse) while staying the running blue.
  assert.equal(tallyDotClass({ kind: "running", count: 0 }), "running idle");
  assert.equal(tallyDotClass({ kind: "running", count: 1 }), "running");
  // Only running-at-zero is idle — parked/queued never pulse, so a zero of those is plain.
  assert.equal(tallyDotClass({ kind: "parked", count: 0 }), "parked");
  assert.equal(tallyDotClass({ kind: "queued", count: 0 }), "queued");
  assert.equal(tallyDotClass({ kind: "parked", count: 3 }), "parked");
});


test("freezeIntent ages the 'updated Ns ago' readout from now (#210)", () => {
  const intent = freezeIntent({ lastUpdate: 1000, now: 6000 });
  assert.equal(intent.updatedText, "updated 5s ago");
});

test("freezeIntent reads 'waiting for updates' before the first refresh (null lastUpdate)", () => {
  // The landing opens with no lastUpdate; the campaign page seeds it to now instead.
  const intent = freezeIntent({ lastUpdate: null, now: 5000 });
  assert.equal(intent.updatedText, "waiting for updates");
});

test("paneActivity counts a visible append — new lines, pane open and following (#198)", () => {
  // A live-tail/host-log frame that visibly adds lines is a co-equal update: it resets
  // the live-bar's freshness clock, just like a wave/feed refresh.
  assert.equal(paneActivity({ appended: 3, open: true, following: true }), true);
  assert.equal(paneActivity({ appended: 1, open: true, following: true }), true);
});

test("paneActivity ignores a frame that adds no visible lines (#198)", () => {
  // No fresh lines is not an update.
  assert.equal(paneActivity({ appended: 0, open: true, following: true }), false);
});

test("paneActivity ignores appends the pane doesn't show — collapsed or follow-paused (#198)", () => {
  // A collapsed pane, or one whose own follow is paused so frames only buffer, presents
  // nothing new — presentation is frozen, so freshness is too.
  assert.equal(paneActivity({ appended: 5, open: false, following: true }), false);
  assert.equal(paneActivity({ appended: 5, open: true, following: false }), false);
  assert.equal(paneActivity({ appended: 5, open: false, following: false }), false);
});
