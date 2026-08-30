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

test("githubBlockedBy queries the blocked_by endpoint and returns blocker numbers", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([
      { number: 191, repository: { full_name: "jjforge/jjforge" } },
      { number: 200, repository: { full_name: "jjforge/jjforge" } },
    ]);
  };

  const blockers = githubBlockedBy("jjforge/jjforge", run)("#782");

  assert.deepEqual(calls, [
    ["api", "repos/jjforge/jjforge/issues/782/dependencies/blocked_by"],
  ]);
  assert.deepEqual(blockers, ["191", "200"]);
});

test("githubBlockedBy drops cross-repo blockers", () => {
  const run = () =>
    JSON.stringify([
      { number: 191, repository: { full_name: "jjforge/jjforge" } },
      { number: 5, repository: { full_name: "someone/other" } },
    ]);

  assert.deepEqual(githubBlockedBy("jjforge/jjforge", run)("782"), ["191"]);
});

test("githubBlockedBy handles an empty dependency list", () => {
  assert.deepEqual(githubBlockedBy("jjforge/jjforge", () => "[]")("782"), []);
});

test("githubBlockedBy drops closed blockers — only OPEN prerequisites gate", () => {
  const run = () =>
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

  assert.deepEqual(githubBlockedBy("jjforge/jjforge", run)("782"), ["191"]);
});

test("githubIssuesByLabel lists the OPEN issues carrying a label and returns their numbers", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 436 }, { number: 611 }, { number: 640 }]);
  };

  const ids = githubIssuesByLabel("jjforge/vetinari", run)("ready-for-agent");

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
      "--json",
      // issueType so an Epic — a container that owns no work — is never scheduled (#322).
      "number,issueType",
    ],
  ]);
  assert.deepEqual(ids, ["436", "611", "640"]);
});

test("githubIssuesByLabel returns an empty list when no open issue carries the label", () => {
  assert.deepEqual(
    githubIssuesByLabel("jjforge/vetinari", () => "[]")("nonexistent"),
    [],
  );
});

test("githubIssuesByLabel drops an Epic carrying the label — it owns no work, is never scheduled (#322)", () => {
  const logs: string[] = [];
  const run = () =>
    JSON.stringify([
      { number: 282, issueType: { name: "Epic" } },
      { number: 611, issueType: { name: "Task" } },
    ]);

  const ids = githubIssuesByLabel(
    "jjforge/vetinari",
    run,
    (line) => logs.push(line),
  )("campaign:vocabulary");

  // the task stays; the epic is gone.
  assert.deepEqual(ids, ["611"]);
  // one line naming the excluded epic, so the operator sees why the count shrank.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /#282 — epic, not work/);
});

test("githubIssuesByLabel matches the Epic type case-insensitively", () => {
  const run = () =>
    JSON.stringify([
      { number: 282, issueType: { name: "EPIC" } },
      { number: 283, issueType: { name: "epic" } },
      { number: 611, issueType: { name: "Bug" } },
    ]);

  assert.deepEqual(
    githubIssuesByLabel("jjforge/vetinari", run, () => {})("campaign:vocabulary"),
    ["611"],
  );
});

test("githubIssuesByLabel keeps a row with no issueType — an untyped issue is work", () => {
  const logs: string[] = [];
  const run = () =>
    JSON.stringify([
      { number: 611, issueType: null },
      { number: 640 },
    ]);

  const ids = githubIssuesByLabel(
    "jjforge/vetinari",
    run,
    (line) => logs.push(line),
  )("campaign:vocabulary");

  assert.deepEqual(ids, ["611", "640"]);
  assert.deepEqual(logs, []);
});

test("githubFetchTask fetches an issue asking for state and closedAt, not just title/body/comments/labels", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      title: "t",
      body: "b",
      comments: [],
      labels: [],
      state: "OPEN",
    });
  };

  githubFetchTask("jjforge/vetinari", run)("#165");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["issue", "view", "165", "--repo"]);
  const fields = calls[0][calls[0].indexOf("--json") + 1].split(",");
  // state is the whole point — without it, issueStateFromTask always reads open (#175).
  assert.ok(
    fields.includes("state"),
    `--json fields must include state, got ${fields.join(",")}`,
  );
  assert.ok(
    fields.includes("closedAt"),
    `--json fields must include closedAt, got ${fields.join(",")}`,
  );
});

test("githubFetchTask surfaces closed state so issueStateFromTask resolves a closed issue to closed (#175)", () => {
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
  const run = (args: string[]) => {
    const fields = args[args.indexOf("--json") + 1].split(",");
    const projected: Record<string, unknown> = {};
    for (const f of fields) if (f in closed) projected[f] = closed[f];
    return JSON.stringify(projected);
  };

  const task = githubFetchTask("jjforge/vetinari", run)("165");

  assert.equal(issueStateFromTask(task), "closed");
});

test("githubFindingReporter creates a labeled issue cross-referenced to the task", () => {
  let captured: string[] = [];
  const run = (args: string[]) => {
    captured = args;
    return "https://github.com/jjforge/jjforge/issues/901\n";
  };

  const url = githubFindingReporter(
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
  assert.deepEqual(captured.slice(0, 6), [
    "issue",
    "create",
    "--repo",
    "jjforge/jjforge",
    "--title",
    "Sidecar leaks a file handle",
  ]);
  const body = captured[captured.indexOf("--body") + 1];
  assert.match(body, /Repro:.*start then SIGTERM/);
  assert.match(body, /Location:.*sidecar\/src\/db\.rs/);
  assert.match(body, /working on #640/);
  assert.deepEqual(
    captured.filter((_, i) => captured[i - 1] === "--label"),
    ["P2", "bug", "needs-triage"],
  );
});

test("githubMarkPendingVerify relabels ready-for-agent → pending-verify on the issue", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return "";
  };

  githubMarkPendingVerify("jjforge/jjforge", run)("#640");

  assert.deepEqual(calls, [
    [
      "issue",
      "edit",
      "640",
      "--repo",
      "jjforge/jjforge",
      "--add-label",
      "pending-verify",
      "--remove-label",
      "ready-for-agent",
    ],
  ]);
});

test("githubIssueComment posts a comment body to the given issue, stripping a leading #", async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
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
