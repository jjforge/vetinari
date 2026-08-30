import test from "node:test";
import assert from "node:assert/strict";
import {
  formatComplete,
  formatOutcomes,
  formatPlan,
  formatResume,
  formatResumeNothing,
  formatStop,
  formatWaveDone,
  formatWaveStart,
  issueLabel,
  makeReporter,
} from "./report.ts";

// --- issueLabel: an id, plus its title when the run resolved one ---------------

test("issueLabel prefixes # and appends the resolved title when there is one", () => {
  assert.equal(issueLabel("640", { "640": "Carve drops dependents" }), "#640 Carve drops dependents");
});

test("issueLabel is the bare #id when no title was resolved", () => {
  assert.equal(issueLabel("640", {}), "#640");
});

// --- formatPlan: the waves with ids and titles, named when the run is ----------

test("formatPlan lists each wave with its ids and titles, headed by the name", () => {
  const out = formatPlan([["101", "102"], ["201"]], { "101": "Foo", "201": "Baz" }, "vocab");
  assert.equal(
    out,
    "plan “vocab” · 2 waves\n  wave 1 — #101 Foo, #102\n  wave 2 — #201 Baz",
  );
});

test("formatPlan omits the name segment when the campaign is unnamed", () => {
  const out = formatPlan([["101"]], {}, undefined);
  assert.equal(out, "plan · 1 wave\n  wave 1 — #101");
});

// --- formatWaveStart / formatWaveDone: per-wave progress -----------------------

test("formatWaveStart names the wave, its position, and its issues", () => {
  assert.equal(
    formatWaveStart(0, 2, ["101", "102"], { "101": "Foo" }),
    "▶ wave 1/2 — #101 Foo, #102",
  );
});

test("formatWaveDone reports what merged", () => {
  assert.equal(
    formatWaveDone(0, 2, { merged: ["101"], held: [], quarantined: [], outcomes: {} }),
    "✔ wave 1/2 merged #101",
  );
});

test("formatWaveDone says nothing merged when the wave banked none", () => {
  assert.equal(
    formatWaveDone(0, 1, { merged: [], held: [], quarantined: [], outcomes: {} }),
    "✔ wave 1/1 merged nothing",
  );
});

test("formatWaveDone annotates held and conflict-quarantined issues", () => {
  assert.equal(
    formatWaveDone(0, 2, {
      merged: ["101"],
      held: ["102"],
      quarantined: ["103"],
      outcomes: { "102": "parked" },
    }),
    "✔ wave 1/2 merged #101 · held #102 (parked) · parked on conflict (kept) #103",
  );
});

// --- formatOutcomes: the per-issue outcome, error mapped to the vocabulary -----

test("formatOutcomes prints one line per issue, mapping error(n) to failed", () => {
  assert.equal(
    formatOutcomes(["101", "102", "103"], { "101": "green", "102": "parked", "103": "error(1)" }),
    "  #101 green\n  #102 parked\n  #103 failed",
  );
});

// --- formatComplete / resume ---------------------------------------------------

test("formatComplete names the run and the base it landed on", () => {
  assert.equal(formatComplete(2, "main", "vocab"), "🏆 campaign “vocab” complete · 2 waves onto main");
});

test("formatComplete drops the name segment when unnamed", () => {
  assert.equal(formatComplete(1, "main", undefined), "🏆 campaign complete · 1 wave onto main");
});

test("formatResume announces the wave a redrive re-enters", () => {
  assert.equal(formatResume(1, 3), "↩ redrive · continuing from wave 2/3");
});

test("formatResumeNothing reports an already-merged campaign", () => {
  assert.equal(formatResumeNothing(3), "↩ redrive · nothing to run — all 3 waves already merged");
});

// --- formatStop: the one-line stop reason and the exact recovery command -------

test("a failed stop names the failure and the redrive/prune recovery", () => {
  const out = formatStop({
    kind: "failed",
    index: 0,
    total: 2,
    failed: ["101"],
    merged: ["102"],
  });
  assert.equal(
    out,
    "✖ campaign failed at wave 1/2 — #101 failed; merged #102 kept, 1 wave not started\n" +
      "recover: fix it forward or `vetinari prune 101`, then `vetinari redrive`",
  );
});

test("an issue-parked stop offers answer/prune, then redrive", () => {
  const out = formatStop({
    kind: "issue-parked",
    index: 0,
    total: 2,
    parked: ["102"],
    merged: ["101"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — #102 awaiting a human; merged #101 kept, 1 wave not started\n" +
      'recover: `vetinari answer 102 "…"` (or resolve) or `vetinari prune 102`, then `vetinari redrive`',
  );
});

test("a red-base stop points at fix-forward then redrive", () => {
  const out = formatStop({
    kind: "red-base",
    index: 1,
    total: 3,
    merged: ["201"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 2/3 — merged base is red (red-base); merged #201 kept, 1 wave not started\n" +
      "recover: fix forward on the base, then `vetinari redrive` — or `vetinari prune <id>`",
  );
});

test("a quarantine-stranded stop offers redrive or redrive --auto-prune", () => {
  const out = formatStop({
    kind: "quarantine-stranded",
    index: 0,
    total: 2,
    stranded: ["201"],
    merged: ["101"],
  });
  assert.equal(
    out,
    "🅿 campaign parked at wave 1/2 — conflict stranded #201 in a later wave; merged #101 kept, 1 wave not started\n" +
      "recover: resolve the conflict then `vetinari redrive`, or `vetinari redrive --auto-prune`",
  );
});

// --- makeReporter: the json gate. Human lines only reach stdout without --json --

test("a default reporter prints its line to the sink", () => {
  const lines: string[] = [];
  const r = makeReporter({ json: false, out: (s) => lines.push(s) });
  r.line("hello");
  assert.deepEqual(lines, ["hello"]);
  assert.equal(r.json, false);
});

test("a --json reporter suppresses human lines (raw events go to the log echo instead)", () => {
  const lines: string[] = [];
  const r = makeReporter({ json: true, out: (s) => lines.push(s) });
  r.line("hello");
  assert.deepEqual(lines, []);
  assert.equal(r.json, true);
});
