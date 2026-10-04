// Tests for the dashboard's event text — the narration, wave labels, festive helpers,
// tracker-task and parked-question parsers (dashboard-event-text.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeEvent,
  extractParkedDetails,
  festiveFromCookie,
  formatFeedEvent,
  issueStateFromTask,
  lastEventText,
  parkedReplyFor,
  waveLabel,
} from "./dashboard-event-text.ts";
import { event, type OrchestratorEvent } from "./event-log.ts";
import type { ParkedRecord } from "./state.ts";

// A raw orchestrator-log row of a kind the dashboard does not narrate — the machine
// noise `readEventLog` carries as a cast-and-trusted `OrchestratorEvent` (event-log.ts).
// The narrators skip it (their `default`/unmatched branch); tests model it the same way.
const noise = (row: Record<string, unknown> & { event: string }): OrchestratorEvent => row as unknown as OrchestratorEvent;

test("describeEvent narrates a campaign-failed stop marker so the feed shows why it stopped (#285)", () => {
  assert.equal(
    describeEvent(event("campaign-failed", { index: 0, detail: "#102 could not be made green" })),
    "Campaign failed — #102 could not be made green",
  );
  // The stop marker echoes its detail verbatim — the per-task failures are carried on
  // their own `failed` rows now (the marker is just the campaign-level stop).
  assert.equal(
    describeEvent(event("campaign-failed", { index: 0, detail: "#102, #103 could not be made green" })),
    "Campaign failed — #102, #103 could not be made green",
  );
});

test("festiveFromCookie reads the toggle out of the request's Cookie header (#193)", () => {
  // Absent header → the fallback (the config default; false at the host dashboard).
  assert.equal(festiveFromCookie(undefined, false), false);
  assert.equal(festiveFromCookie("", false), false);
  assert.equal(festiveFromCookie("theme=dark", false), false);
  // `festiveWaveNames=1` turns it on; `=0` turns it off — the cookie wins over the fallback.
  assert.equal(festiveFromCookie("festiveWaveNames=1", false), true);
  assert.equal(festiveFromCookie("festiveWaveNames=0", true), false);
  // Found among other cookies, with the usual "; " separators and stray whitespace.
  assert.equal(festiveFromCookie("theme=dark; festiveWaveNames=1; tz=UTC", false), true);
  // No cookie present → the fallback decides, so a config default of true still reads on.
  assert.equal(festiveFromCookie("theme=dark", true), true);
});

test("waveLabel's festive input names the wave through the one derivation (#193)", () => {
  // Off (no festive input) — exactly today's wording, card and bare.
  assert.equal(waveLabel(1, undefined, 0), "Wave 2");
  assert.equal(waveLabel(1, "cache eviction", 2), "Wave 2 — cache eviction +2");
  // Card surface — `index · name`; the lead title + "+M" is dropped (the card's member
  // rows already carry the titles), so only the index and the festive name show.
  assert.equal(waveLabel(1, "cache eviction", 2, { name: "Granny Weatherwax", surface: "card" }), "Wave 2 · Granny Weatherwax");
  // Line surface — `index · name · #num, #num, …`; the single-line narration has no member
  // rows, so it lists the member issue numbers inline.
  assert.equal(
    waveLabel(1, undefined, 0, { name: "Granny Weatherwax", surface: "line", numbers: ["1234", "145", "234"] }),
    "Wave 2 · Granny Weatherwax · #1234, #145, #234",
  );
  // A member-less wave degrades the line to just `index · name`.
  assert.equal(waveLabel(1, undefined, 0, { name: "Death", surface: "line", numbers: [] }), "Wave 2 · Death");
});

test("describeEvent narrates festively when given a campaign's reserved offset (#193)", () => {
  // festive offset 11 → wave 1 (index 0) draws pool[11] = "Granny Weatherwax". The one-line
  // narration lists the member issue numbers inline (no member rows on a line).
  assert.equal(
    describeEvent(event("wave-start", { index: 0, tasks: ["1234", "145", "234"] }), { festive: { offset: 11 } }),
    "Wave 1 · Granny Weatherwax · #1234, #145, #234 started",
  );
  // wave-done carries just its merged list (every member merged, design §2.1), names
  // the wave festively, and keeps the merged-hashes tail.
  assert.equal(
    describeEvent(event("wave-done", { index: 1, merged: ["101", "102"] }), { festive: { offset: 11 } }),
    "Wave 2 · Nanny Ogg · #101, #102 merged #101, #102",
  );
  // Same event with no festive input → the plain-words narration; a resolved title
  // (threaded in via `titles`) names the member.
  assert.equal(
    describeEvent(event("wave-start", { index: 0, tasks: ["1234"] }), { titles: new Map([["1234", "a"]]) }),
    "Wave 1 — a started",
  );
});

test("describeEvent narrates the operator-facing events in plain words", () => {
  assert.equal(
    describeEvent(event("campaign-start", { waves: [["101"]], slots: 1, name: "gateway work" })),
    "Campaign “gateway work” started",
  );
  assert.equal(describeEvent(event("campaign-start", { waves: [["101"]], slots: 1 })), "Campaign started");
  // A wave-start names its wave: unlike the card, the one-line narration lists *every*
  // member issue by title (issue #179), not the lead title + "+M" collapse. Titles are
  // threaded in via `titles` (recorded once on campaign-start), not carried on the event.
  assert.equal(
    describeEvent(event("wave-start", { index: 1, tasks: ["201", "202"] }), {
      titles: new Map([
        ["201", "cache eviction"],
        ["202", "warm the cache"],
      ]),
    }),
    "Wave 2 — cache eviction, warm the cache started",
  );
  // A resolved title names the wave member.
  assert.equal(
    describeEvent(event("wave-start", { index: 1, tasks: ["201"] }), { titles: new Map([["201", "cache eviction"]]) }),
    "Wave 2 — cache eviction started",
  );
  // An id whose title hasn't resolved still shows, as its `#id`, so every member appears.
  assert.equal(describeEvent(event("wave-start", { index: 1, tasks: ["201"] })), "Wave 2 — #201 started");
  assert.equal(
    describeEvent(event("wave-done", { index: 1, merged: ["101"] }), { titles: new Map([["101", "cache eviction"]]) }),
    "Wave 2 — cache eviction merged #101",
  );
  assert.equal(describeEvent(event("wave-done", { index: 0, merged: ["101", "102"] })), "Wave 1 — #101, #102 merged #101, #102");
  assert.equal(describeEvent(event("wave-done", { index: 2, merged: [] })), "Wave 3 merged nothing");
  assert.equal(describeEvent(event("campaign-done", { waves: 3, name: "gateway work" })), "Campaign “gateway work” complete (3 waves)");
  assert.equal(describeEvent(event("campaign-done", { waves: 1 })), "Campaign complete (1 wave)");
  assert.equal(describeEvent(event("green", { taskId: "#101", branch: "agent/101", commits: [] })), "#101 merged");
  // A parked event narrates its one-enum reason (design §2.3).
  assert.equal(describeEvent(event("parked", { taskId: "202", reason: "question" })), "#202 parked: question");
  assert.equal(describeEvent(event("prune", { target: "303", removed: ["303", "304"], dropped: ["303", "304"] })), "Pruned #303, #304");
  assert.equal(describeEvent(event("graft", { ids: ["305", "306"], blockedBy: {}, fileKeys: {} })), "Grafted #305, #306");
  // A turn renders its agent-authored summary verbatim (ADR 0009), falling back when absent.
  assert.equal(
    describeEvent(event("turn", { taskId: "101", turn: 3, summary: "Added a failing test for the counter" })),
    "Added a failing test for the counter",
  );
  // An empty summary is the pre-summary case: the mechanical fallback line stands in.
  assert.equal(describeEvent(event("turn", { taskId: "101", turn: 3, summary: "" })), "#101 — turn 3");
  // An un-notifiable project reads as a plain-words warning (issue #116), not machine noise.
  assert.equal(
    describeEvent(event("telegram-unconfigured", { project: "myapp", baseLocation: "/x/.vetinari.local" })),
    "⚠ Telegram not configured — parked questions won't be announced",
  );
  // A merge conflict parked one issue mid-wave (reason conflict); it reads as an attention
  // line whose detail is the human's next move (ADR 0013).
  assert.equal(
    describeEvent(event("parked", { taskId: "640", reason: "conflict", detail: "CONFLICT (content)" })),
    "#640 parked — merge conflict, resolve it",
  );
  // A red merged base parked the campaign at the wave boundary — a run-level held state,
  // narrated from its detail (ADR 0013).
  assert.equal(describeEvent(event("campaign-parked", { index: 0, detail: "npm test failed" })), "Campaign parked — npm test failed");
});

test("formatFeedEvent prefixes an event's plain-words sentence with its repo, and drops machine noise", () => {
  // A narratable event reads as one repo-prefixed sentence.
  assert.equal(formatFeedEvent("alpha", event("green", { taskId: "101", branch: "agent/101", commits: [] })), "alpha — #101 merged");
  assert.equal(
    formatFeedEvent("beta", event("turn", { taskId: "201", turn: 2, summary: "Wrote a failing test" })),
    "beta — Wrote a failing test",
  );
  // An event describeEvent can't narrate (machine noise) yields no feed line.
  assert.equal(formatFeedEvent("alpha", noise({ event: "sandbox", taskId: "102" })), "");
});

test("lastEventText picks the most recent operator-facing event, ignoring machine noise", () => {
  const events: OrchestratorEvent[] = [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101"]],
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

test("extractParkedDetails separates description from Options section", () => {
  const details = extractParkedDetails(
    "I am parked on the API choice.\n\nOptions:\n1. Return raw JSON\n2. Render HTML server-side\n\nWhat do you prefer?",
  );

  assert.equal(details.description, "I am parked on the API choice.");
  assert.deepEqual(details.options, ["Return raw JSON", "Render HTML server-side"]);
});

test("parkedReplyFor returns the matching record's question and parsed options for the issue-detail sheet", () => {
  const records: ParkedRecord[] = [
    {
      taskId: "#102",
      parkedAt: "now",
      reason: "question",
      branch: "agent/102",
      question: "Which store?\n\nOptions:\n- Postgres\n- SQLite",
    },
    {
      taskId: "201",
      parkedAt: "now",
      reason: "question",
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

test("extractParkedDetails parses the XML question shape agents emit (summary/detail/options)", () => {
  // The run loop strips the outer <question> wrapper and stores the inner content
  // verbatim (prompts/tdd.md), so a parked question can arrive as this XML shape.
  const details = extractParkedDetails(
    "<summary>Wiring the GHCR delete needs a credential decision.</summary>\n" +
      "<detail>The decision function is done and tested; only the deploy.yml wiring remains.</detail>\n" +
      "<options>\n" +
      "  <option>Dry-run wiring first (my recommendation): log what would be deleted.</option>\n" +
      "  <option>Best-effort real prune now: delete on every deploy.</option>\n" +
      "  <option>Leave deploy.yml untouched: ship the function only.</option>\n" +
      "</options>",
  );

  // Summary is the headline, detail the body — no visible tag characters.
  assert.equal(
    details.description,
    "Wiring the GHCR delete needs a credential decision.\n\n" +
      "The decision function is done and tested; only the deploy.yml wiring remains.",
  );
  assert.deepEqual(details.options, [
    "Dry-run wiring first (my recommendation): log what would be deleted.",
    "Best-effort real prune now: delete on every deploy.",
    "Leave deploy.yml untouched: ship the function only.",
  ]);
});

test("extractParkedDetails XML shape tolerates a missing detail and still lists options", () => {
  const details = extractParkedDetails(
    "<summary>Pick a store.</summary><options><option>Postgres</option><option>SQLite</option></options>",
  );
  assert.equal(details.description, "Pick a store.");
  assert.deepEqual(details.options, ["Postgres", "SQLite"]);
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
