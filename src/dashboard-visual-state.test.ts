import test from "node:test";
import assert from "node:assert/strict";
import {
  dotClass,
  freezeIntent,
  graftCarry,
  issueMoves,
  paneActivity,
  reasonWord,
  redriveAllowed,
  tallyDotClass,
} from "./dashboard-visual-state.ts";
import { reconstructIssueDetail } from "./dashboard-model.ts";

test("reasonWord maps each ParkReason from the single enum to its display word (#295)", () => {
  // The one mapping from the `ParkReason` enum to the word every surface prints beside
  // `parked` — no reason-string regexes, just the enum. `red-base` reads as two words;
  // the rest are their enum value verbatim.
  assert.equal(reasonWord("question"), "question");
  assert.equal(reasonWord("stalled"), "stalled");
  assert.equal(reasonWord("conflict"), "conflict");
  assert.equal(reasonWord("crash"), "crash");
  assert.equal(reasonWord("red-base"), "red base");
});

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

test("redriveAllowed allows a redrive only for a stopped campaign whose lease is dead (design §7, §11, #325)", () => {
  // The whole-campaign safety rule: redrive is safe only when the campaign's fold is
  // stopped (parked or failed — a crash folds its in-flight members to parked{crash})
  // AND no campaign process for the project still holds the host lease.
  assert.deepEqual(redriveAllowed("parked", false), { allowed: true, reason: "" });
  assert.deepEqual(redriveAllowed("failed", false), { allowed: true, reason: "" });
});

test("redriveAllowed refuses while a campaign process still holds the lease, with a one-line reason (#325)", () => {
  // The observed bug: redrive fired on a draining wave started a second campaign process
  // over the live one. A live lease is the strongest signal there is a process to collide with.
  assert.deepEqual(redriveAllowed("parked", true), { allowed: false, reason: "a campaign process is still running" });
  assert.deepEqual(redriveAllowed("failed", true), { allowed: false, reason: "a campaign process is still running" });
  // A running fold reads as a live process too, whatever the lease probe returned.
  assert.deepEqual(redriveAllowed("running", false), { allowed: false, reason: "a campaign process is still running" });
});

test("redriveAllowed refuses a settled or never-run campaign — nothing to pick back up (#325)", () => {
  // A completed campaign is settled (every wave closed); an unstarted/empty one has no
  // stopped campaign to resume. Neither is a redrive target, so each greys with its reason.
  assert.deepEqual(redriveAllowed("completed", false), { allowed: false, reason: "the campaign is settled — nothing to redrive" });
  assert.deepEqual(redriveAllowed("unstarted", false), { allowed: false, reason: "no campaign to redrive" });
});

test("paneActivity counts a visible append — new lines, pane open and following (#198)", () => {
  // A live-tail/host-log frame that visibly adds lines is a co-equal update: it resets
  // the live-bar's freshness clock, just like a wave/feed refresh.
  assert.equal(paneActivity({ appended: 3, open: true, following: true }), true);
  assert.equal(paneActivity({ appended: 1, open: true, following: true }), true);
});

test("issueMoves offers reply and prune for a question or stalled park — redrive is a campaign move, not an issue one (#325)", () => {
  // A question or a stall wants a human answer, so both carry reply + prune. Redrive picks up
  // the whole campaign (design §7, §11), so it is a project-page control, never an issue move.
  assert.deepEqual(issueMoves({ status: "parked", reason: "question" }), { reply: true, prune: true });
  assert.deepEqual(issueMoves({ status: "parked", reason: "stalled" }), { reply: true, prune: true });
});

test("issueMoves reads a reasonless legacy park as a question (#307)", () => {
  // A park written before the reason enum existed still reads as an answerable question.
  assert.deepEqual(issueMoves({ status: "parked" }), { reply: true, prune: true });
});

test("issueMoves drops reply for a conflict, red-base or crash park — prune only (#325)", () => {
  // These are fixed forward on the base and redriven, never answered per-issue: no reply,
  // just prune (the fix-forward instruction rides the sheet notice; redrive is on the page).
  for (const reason of ["conflict", "red-base", "crash"] as const) {
    assert.deepEqual(issueMoves({ status: "parked", reason }), { reply: false, prune: true });
  }
});

test("issueMoves offers prune for a failed issue (#325)", () => {
  // The wire status is `failed` (the `IssueStatus` enum), the string `/api/issue` ships and the
  // sheet's move rule keys on — one word now (design §13.1), so a failed issue gets its Prune move.
  assert.deepEqual(issueMoves({ status: "failed" }), { reply: false, prune: true });
});

test("issueMoves keys on the exact status /api/issue emits for a failed issue, so its sheet renders Prune (#317)", () => {
  // The single shared fixture: a member the agent could not make green. The status
  // `reconstructIssueDetail` folds is precisely what `/api/issue` serializes and the sheet
  // feeds back into `issueMoves` — assert the two agree so the wire word and the rule can't drift.
  const events = [
    { event: "campaign-start", ts: "2026-08-01T00:00:00.000Z", waves: [["101"]] },
    { event: "spawn", ts: "2026-08-01T00:01:00.000Z", taskId: "101" },
    { event: "failed", ts: "2026-08-01T00:05:00.000Z", taskId: "101" },
  ] as unknown as Parameters<typeof reconstructIssueDetail>[0];
  const wireStatus = reconstructIssueDetail(events, "101").status;
  assert.equal(wireStatus, "failed");
  assert.deepEqual(issueMoves({ status: wireStatus }), { reply: false, prune: true });
});

test("issueMoves offers only prune for a running or unstarted issue (#307)", () => {
  assert.deepEqual(issueMoves({ status: "running" }), { reply: false, prune: true });
  assert.deepEqual(issueMoves({ status: "unstarted" }), { reply: false, prune: true });
});

test("issueMoves offers nothing for a completed issue (#307)", () => {
  assert.deepEqual(issueMoves({ status: "completed" }), { reply: false, prune: false });
});

test("issueMoves offers nothing for an archived (read-only) issue, whatever its state (#307)", () => {
  // An archived run is read-only — no move mutates a finished campaign's log.
  assert.deepEqual(issueMoves({ status: "parked", reason: "question", archived: true }), { reply: false, prune: false });
  assert.deepEqual(issueMoves({ status: "failed", archived: true }), { reply: false, prune: false });
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

test("graftCarry carries ids typed but not yet submitted across the swap (#329)", () => {
  // The soft-refresh swaps #live-region whole and the server renders the ids input with no
  // value, so the fresh node arrives empty; graftCarry decides that the typed ids are put back.
  assert.deepEqual(graftCarry({ ids: "101 102", error: "", busy: false }), {
    ids: "101 102",
    error: "",
    invalid: false,
    busy: false,
  });
});

test("graftCarry carries the value captured at replace-time, so ids typed during the fetch window win (#329)", () => {
  // The refresh re-fetches the page, then swaps the node. If ids are captured before the
  // fetch, an id typed while it was in flight is clobbered; captured immediately before the
  // swap, the later value is what graftCarry is handed — and it carries exactly that. The
  // reducer is a faithful function of its input, so the later capture wins over the earlier.
  const earlier = graftCarry({ ids: "101 102", error: "", busy: false });
  const later = graftCarry({ ids: "101 102 103", error: "", busy: false });
  assert.equal(earlier.ids, "101 102");
  assert.equal(later.ids, "101 102 103");
  assert.notEqual(later.ids, earlier.ids);
});

test("graftCarry carries an inline error alongside its ids and keeps the submit disabled (#329)", () => {
  // A blur validation showing an error for the typed ids survives the swap with the same
  // text, and invalid is set so the fresh submit stays disabled for the same reason.
  assert.deepEqual(graftCarry({ ids: "101 999", error: "#999 — not found", busy: false }), {
    ids: "101 999",
    error: "#999 — not found",
    invalid: true,
    busy: false,
  });
});

test("graftCarry carries the in-flight state so a shelling graft still reads as busy after the swap (#329, #327)", () => {
  // While a graft POST is shelling the form is aria-busy and the button reads "grafting…";
  // a refresh landing then must not reset it to an at-rest form — the operator loses the
  // only signal their graft was accepted. busy is carried whether or not ids remain.
  assert.deepEqual(graftCarry({ ids: "101 102", error: "", busy: true }), {
    ids: "101 102",
    error: "",
    invalid: false,
    busy: true,
  });
  assert.deepEqual(graftCarry({ ids: "", error: "", busy: true }), {
    ids: "",
    error: "",
    invalid: false,
    busy: true,
  });
});

test("graftCarry carries nothing for an empty, untouched field (#329)", () => {
  // An empty field with no graft in flight is left exactly as the server rendered it —
  // nothing is restored that was not there. Whitespace-only counts as empty.
  assert.deepEqual(graftCarry({ ids: "", error: "", busy: false }), {
    ids: "",
    error: "",
    invalid: false,
    busy: false,
  });
  assert.deepEqual(graftCarry({ ids: "   ", error: "", busy: false }), {
    ids: "",
    error: "",
    invalid: false,
    busy: false,
  });
});
