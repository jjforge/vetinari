import test from "node:test";
import assert from "node:assert/strict";
import {
  githubBlockedBy,
  githubFetchTask,
  githubFindingReporter,
  githubIssueComment,
  githubIssuesByLabel,
  githubMarkPendingVerify,
} from "./github.ts";
import { issueStateFromTask } from "./dashboard-model.ts";
import { expandSelection, layerWaves } from "./plan.ts";
import { restrictBlockers } from "./prune.ts";

/**
 * An injectable `run` that resolves after a real (short) delay while tracking how
 * many calls are in flight at once — the peak is the proof the fan-out overlaps.
 * Returns whatever `reply(args)` yields for each call.
 */
function concurrencyProbe(reply: (args: string[]) => string) {
  const state = { inFlight: 0, maxInFlight: 0 };
  const run = async (args: string[]): Promise<string> => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 10));
    state.inFlight--;
    return reply(args);
  };
  return { run, state };
}

test("githubBlockedBy queries the blocked_by endpoint and returns blocker numbers", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 191, repository: { full_name: "jjforge/jjforge" } },
      { number: 200, repository: { full_name: "jjforge/jjforge" } },
    ]);
  };

  const blockers = await githubBlockedBy("jjforge/jjforge", run)("#782");

  assert.deepEqual(calls, [["api", "repos/jjforge/jjforge/issues/782/dependencies/blocked_by"]]);
  assert.deepEqual(blockers, ["191", "200"]);
});

test("githubBlockedBy drops cross-repo blockers", async () => {
  const run = async () =>
    JSON.stringify([
      { number: 191, repository: { full_name: "jjforge/jjforge" } },
      { number: 5, repository: { full_name: "someone/other" } },
    ]);

  assert.deepEqual(await githubBlockedBy("jjforge/jjforge", run)("782"), ["191"]);
});

test("githubBlockedBy handles an empty dependency list", async () => {
  assert.deepEqual(await githubBlockedBy("jjforge/jjforge", async () => "[]")("782"), []);
});

test("githubBlockedBy drops closed blockers — only OPEN prerequisites gate", async () => {
  const run = async () =>
    JSON.stringify([
      {
        number: 191,
        state: "open",
        repository: { full_name: "jjforge/jjforge" },
      },
      {
        number: 200,
        state: "closed",
        repository: { full_name: "jjforge/jjforge" },
      },
    ]);

  assert.deepEqual(await githubBlockedBy("jjforge/jjforge", run)("782"), ["191"]);
});

test("githubBlockedBy drops a pending-verify blocker and names it — merged-but-unclosed work is satisfied (#326)", async () => {
  const logs: string[] = [];
  const run = async () =>
    JSON.stringify([
      {
        number: 314,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
        repository: { full_name: "jjforge/vetinari" },
      },
      {
        number: 313,
        state: "open",
        labels: [{ name: "pending-verify" }],
        repository: { full_name: "jjforge/vetinari" },
      },
    ]);

  const blockers = await githubBlockedBy("jjforge/vetinari", run, (line) => logs.push(line))("#316");

  // the still-open, merely-ready blocker gates; the pending-verify one — merged on
  // the base, awaiting only a human close — is treated as satisfied and dropped.
  assert.deepEqual(blockers, ["314"]);
  // named, never silently: the dependent and the satisfied blocker both appear.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /#316 — blocker #313 pending-verify, treated as satisfied/);
});

test("githubBlockedBy keeps an open ready-for-agent blocker — an untouched prerequisite still gates (#326)", async () => {
  const run = async () => JSON.stringify([{ number: 314, state: "open", labels: [{ name: "ready-for-agent" }] }]);

  assert.deepEqual(await githubBlockedBy("jjforge/vetinari", run, () => {})("316"), ["314"]);
});

test("githubBlockedBy fans out concurrently under restrictBlockers — every id's gh call is in flight at once (#368)", async () => {
  const ids = ["611", "640", "701", "712"];
  const { run, state } = concurrencyProbe(() => "[]");

  await restrictBlockers(ids, githubBlockedBy("jjforge/vetinari", run));

  // A synchronous resolver would run the ids one after another (peak 1); the async
  // resolver lets Promise.all overlap them, so all four gh calls are live together.
  assert.equal(state.maxInFlight, ids.length);
});

test("restrictBlockers works with a hand-written synchronous blockedBy — the config seam is unchanged (#368)", async () => {
  // A project that wired a plain, non-promise blockedBy keeps working: restrictBlockers
  // awaits a value just the same, so the restricted graph is identical.
  const syncBlockedBy = (id: string): string[] => ({ "701": ["640"], "640": ["611"] })[id] ?? [];

  const { inSet, external } = await restrictBlockers(["611", "640", "701"], syncBlockedBy);

  assert.deepEqual(inSet.get("701"), new Set(["640"]));
  assert.deepEqual(inSet.get("640"), new Set(["611"]));
  assert.deepEqual(external.get("701"), new Set());
});

test("layerWaves works with a hand-written synchronous blockedBy — same waves as before (#368)", async () => {
  const syncBlockedBy = (id: string): string[] => ({ "701": ["640"], "640": ["611"] })[id] ?? [];

  const plan = await layerWaves(["611", "640", "701"], syncBlockedBy);

  assert.deepEqual(plan.waves, [["611"], ["640"], ["701"]]);
  assert.deepEqual(plan.unreachable, []);
});

test("githubIssuesByLabel lists the OPEN issues carrying a label and returns their numbers", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 436 }, { number: 611 }, { number: 640 }]);
  };

  const ids = await githubIssuesByLabel("jjforge/vetinari", run)("ready-for-agent");

  assert.deepEqual(calls, [
    [
      "issue",
      "list",
      "--repo",
      "jjforge/vetinari",
      "--label",
      "ready-for-agent",
      "--state",
      "open",
      // gh lists only 30 by default, which silently dropped the oldest work (#434).
      "--limit",
      "1000",
      "--json",
      // issueType so an Epic — a container that owns no work — is never scheduled (#322);
      // labels so a pending-verify issue — merged work awaiting close — is dropped (#322).
      "number,issueType,labels",
    ],
  ]);
  assert.deepEqual(ids, ["436", "611", "640"]);
});

test("githubIssuesByLabel drops a pending-verify row — merged work awaiting close is not work (#322)", async () => {
  const logs: string[] = [];
  const run = async () =>
    JSON.stringify([
      { number: 322, labels: [{ name: "pending-verify" }] },
      { number: 611, labels: [{ name: "ready-for-agent" }] },
    ]);

  const ids = await githubIssuesByLabel("jjforge/vetinari", run, (line) => logs.push(line))("campaign:audit");

  // the still-open work stays; the merged, pending-verify issue is gone.
  assert.deepEqual(ids, ["611"]);
  // one line naming the excluded issue, so the operator sees why the count shrank.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /#322 — pending-verify, already merged/);
});

test("the readiness axis is label-expansion only — an explicitly named pending-verify id is kept (#322)", async () => {
  // The same seam a real campaign wires: a stub gh returning #322 as pending-verify.
  const run = async () => JSON.stringify([{ number: 322, labels: [{ name: "pending-verify" }] }]);
  const listByLabel = githubIssuesByLabel("jjforge/vetinari", run, () => {});

  // Via label expansion: #322 is dropped as merged-already work.
  assert.deepEqual(await expandSelection(["campaign:audit"], listByLabel), []);
  // Named explicitly: the operator chose it, so it is kept — the resolver is bypassed.
  assert.deepEqual(await expandSelection(["322"], listByLabel), ["322"]);
});

test("githubIssuesByLabel warns when a label fills the fetch limit — a shortfall is never silent (#434)", async () => {
  const logs: string[] = [];
  const rows = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 }));

  const ids = await githubIssuesByLabel(
    "jjforge/vetinari",
    async () => JSON.stringify(rows),
    (line) => logs.push(line),
  )("ready-for-agent");

  // every fetched issue is still returned…
  assert.equal(ids.length, 1000);
  // …and one line tells the operator the label may hold more than was fetched.
  assert.deepEqual(logs, [`[vetinari] label "ready-for-agent" returned 1000 issues — the fetch limit; some may be missing`]);
});

test("githubIssuesByLabel logs nothing for a label under the fetch limit (#434)", async () => {
  const logs: string[] = [];
  const run = async () => JSON.stringify([{ number: 436 }, { number: 611 }, { number: 640 }]);

  await githubIssuesByLabel("jjforge/vetinari", run, (line) => logs.push(line))("ready-for-agent");

  assert.deepEqual(logs, []);
});

test("githubIssuesByLabel returns an empty list when no open issue carries the label", async () => {
  assert.deepEqual(await githubIssuesByLabel("jjforge/vetinari", async () => "[]")("nonexistent"), []);
});

test("githubIssuesByLabel drops an Epic carrying the label — it owns no work, is never scheduled (#322)", async () => {
  const logs: string[] = [];
  const run = async () =>
    JSON.stringify([
      { number: 282, issueType: { name: "Epic" } },
      { number: 611, issueType: { name: "Task" } },
    ]);

  const ids = await githubIssuesByLabel("jjforge/vetinari", run, (line) => logs.push(line))("campaign:vocabulary");

  // the task stays; the epic is gone.
  assert.deepEqual(ids, ["611"]);
  // one line naming the excluded epic, so the operator sees why the count shrank.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /#282 — epic, not work/);
});

test("githubIssuesByLabel matches the Epic type case-insensitively", async () => {
  const run = async () =>
    JSON.stringify([
      { number: 282, issueType: { name: "EPIC" } },
      { number: 283, issueType: { name: "epic" } },
      { number: 611, issueType: { name: "Bug" } },
    ]);

  assert.deepEqual(await githubIssuesByLabel("jjforge/vetinari", run, () => {})("campaign:vocabulary"), ["611"]);
});

test("githubIssuesByLabel keeps a row with no issueType — an untyped issue is work", async () => {
  const logs: string[] = [];
  const run = async () => JSON.stringify([{ number: 611, issueType: null }, { number: 640 }]);

  const ids = await githubIssuesByLabel("jjforge/vetinari", run, (line) => logs.push(line))("campaign:vocabulary");

  assert.deepEqual(ids, ["611", "640"]);
  assert.deepEqual(logs, []);
});

test("githubFetchTask fetches an issue asking for state and closedAt, not just title/body/comments/labels", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      title: "t",
      body: "b",
      comments: [],
      labels: [],
      state: "OPEN",
    });
  };

  await githubFetchTask("jjforge/vetinari", run)("#165");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["issue", "view", "165", "--repo"]);
  const fields = calls[0][calls[0].indexOf("--json") + 1].split(",");
  // state is the whole point — without it, issueStateFromTask always reads open (#175).
  assert.ok(fields.includes("state"), `--json fields must include state, got ${fields.join(",")}`);
  assert.ok(fields.includes("closedAt"), `--json fields must include closedAt, got ${fields.join(",")}`);
});

test("githubFetchTask surfaces closed state so issueStateFromTask resolves a closed issue to closed (#175)", async () => {
  // A gh stub that behaves like the real `gh issue view --json <fields>`: it projects
  // ONLY the requested fields. So a resolver that forgets to ask for `state` never
  // hands the closed signal to issueStateFromTask — the exact pre-fix blind spot.
  const closed: Record<string, unknown> = {
    title: "Old bug",
    body: "…",
    comments: [],
    labels: [],
    state: "CLOSED",
    closedAt: "2026-08-01T00:00:00Z",
  };
  const run = async (args: string[]) => {
    const fields = args[args.indexOf("--json") + 1].split(",");
    const projected: Record<string, unknown> = {};
    for (const f of fields) if (f in closed) projected[f] = closed[f];
    return JSON.stringify(projected);
  };

  const task = await githubFetchTask("jjforge/vetinari", run)("165");

  assert.equal(issueStateFromTask(task), "closed");
});

test("githubFetchTask fans out concurrently under Promise.all — every id's gh call is in flight at once (#368)", async () => {
  const ids = ["611", "640", "701", "712"];
  const { run, state } = concurrencyProbe(() => JSON.stringify({ title: "t", state: "OPEN" }));
  const fetchTask = githubFetchTask("jjforge/vetinari", run);

  await Promise.all(ids.map((id) => fetchTask(id)));

  // Serial under a sync resolver (peak 1); overlapped once the resolver awaits gh.
  assert.equal(state.maxInFlight, ids.length);
});

test("githubFindingReporter creates a labeled issue cross-referenced to the task", async () => {
  let captured: string[] = [];
  const run = async (args: string[]) => {
    captured = args;
    return "https://github.com/jjforge/jjforge/issues/901\n";
  };

  const url = await githubFindingReporter(
    "jjforge/jjforge",
    { labels: ["P2", "bug", "needs-triage"] },
    run,
  )(
    {
      summary: "Sidecar leaks a file handle",
      location: "sidecar/src/db.rs",
      repro: "start then SIGTERM",
    },
    { taskId: "640", project: "jjforge" },
  );

  assert.equal(url, "https://github.com/jjforge/jjforge/issues/901");
  assert.deepEqual(captured.slice(0, 6), ["issue", "create", "--repo", "jjforge/jjforge", "--title", "Sidecar leaks a file handle"]);
  const body = captured[captured.indexOf("--body") + 1];
  assert.match(body, /Repro:.*start then SIGTERM/);
  assert.match(body, /Location:.*sidecar\/src\/db\.rs/);
  assert.match(body, /working on #640/);
  assert.deepEqual(
    captured.filter((_, i) => captured[i - 1] === "--label"),
    ["P2", "bug", "needs-triage"],
  );
});

test("githubMarkPendingVerify relabels ready-for-agent → pending-verify on the issue", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return "";
  };

  await githubMarkPendingVerify("jjforge/jjforge", run)("#640");

  assert.deepEqual(calls, [
    ["issue", "edit", "640", "--repo", "jjforge/jjforge", "--add-label", "pending-verify", "--remove-label", "ready-for-agent"],
  ]);
});

test("githubIssueComment posts a comment body to the given issue, stripping a leading #", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return "";
  };

  await githubIssueComment("jjforge/jjforge", run)(
    "#226",
    "> *Parked-question answer relayed by vetinari.*\n**Q:** which format?\nuse JSON",
  );

  assert.deepEqual(calls, [
    [
      "issue",
      "comment",
      "226",
      "--repo",
      "jjforge/jjforge",
      "--body",
      "> *Parked-question answer relayed by vetinari.*\n**Q:** which format?\nuse JSON",
    ],
  ]);
});

test("githubIssueComment rejects when the gh write fails — a lost tracker write is never swallowed (#368)", async () => {
  const run = async () => {
    throw new Error("gh issue comment: not found");
  };

  await assert.rejects(() => githubIssueComment("jjforge/jjforge", run)("#226", "the answer"), /not found/);
});
