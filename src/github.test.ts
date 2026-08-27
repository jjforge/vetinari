import test from "node:test";
import assert from "node:assert/strict";
import {
  githubBlockedBy,
  githubFetchTask,
  githubFindingReporter,
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
