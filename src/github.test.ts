import test from "node:test";
import assert from "node:assert/strict";
import { githubBlockedBy, githubFindingReporter, githubMarkPendingVerify } from "./github.ts";

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

  assert.deepEqual(calls, [["api", "repos/jjforge/jjforge/issues/782/dependencies/blocked_by"]]);
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
      { number: 191, state: "open", repository: { full_name: "jjforge/jjforge" } },
      { number: 200, state: "closed", repository: { full_name: "jjforge/jjforge" } },
    ]);

  assert.deepEqual(githubBlockedBy("jjforge/jjforge", run)("782"), ["191"]);
});

test("githubFindingReporter creates a labeled issue cross-referenced to the task", () => {
  let captured: string[] = [];
  const run = (args: string[]) => {
    captured = args;
    return "https://github.com/jjforge/jjforge/issues/901\n";
  };

  const url = githubFindingReporter("jjforge/jjforge", { labels: ["P2", "bug", "needs-triage"] }, run)(
    { summary: "Sidecar leaks a file handle", location: "sidecar/src/db.rs", repro: "start then SIGTERM" },
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

test("githubMarkPendingVerify relabels ready-for-agent → pending-verify on the issue", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return "";
  };

  githubMarkPendingVerify("jjforge/jjforge", run)("#640");

  assert.deepEqual(calls, [
    ["issue", "edit", "640", "--repo", "jjforge/jjforge", "--add-label", "pending-verify", "--remove-label", "ready-for-agent"],
  ]);
});
