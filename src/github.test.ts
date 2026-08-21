import test from "node:test";
import assert from "node:assert/strict";
import { githubBlockedBy } from "./github.ts";

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
