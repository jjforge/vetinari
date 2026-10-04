// Tests for the names the dashboard-model barrel re-exports from outside the dashboard split —
// the remote parse and the prune-closure parse — reached via the status barrel.
import test from "node:test";
import assert from "node:assert/strict";
import { ownerRepoFromRemote, parsePruneClosure } from "./status.ts";

test("ownerRepoFromRemote parses SSH and HTTPS GitHub remotes to owner/name, and rejects garbage", () => {
  // SSH form, with the .git suffix stripped.
  assert.equal(ownerRepoFromRemote("git@github.com:jjforge/vetinari.git"), "jjforge/vetinari");
  // HTTPS form, with and without the .git suffix.
  assert.equal(ownerRepoFromRemote("https://github.com/jjforge/vetinari.git"), "jjforge/vetinari");
  assert.equal(ownerRepoFromRemote("https://github.com/acme/tidepool"), "acme/tidepool");
  // Trailing whitespace (as `git remote get-url` prints a newline) and a trailing slash.
  assert.equal(ownerRepoFromRemote("https://github.com/acme/tidepool/\n"), "acme/tidepool");
  // Garbage — not a recognizable remote — is undefined so the caller falls back to the bare key.
  assert.equal(ownerRepoFromRemote("not-a-remote"), undefined);
  assert.equal(ownerRepoFromRemote(""), undefined);
});

test("parsePruneClosure reads the structured closure line the dry-run prints", () => {
  // The dry-run prints a `prune-closure {json}` line (E2) carrying the exact
  // closure — target, the dependents that would leave, the banked work kept, and
  // the remaining waves — so the panel names each without re-parsing the prose.
  const structured = {
    target: "201",
    dropped: ["201", "401"],
    keptBanked: ["301"],
    remaining: [["501"]],
  };
  assert.deepEqual(
    parsePruneClosure(
      `prune #201 → dropping #201, #401 (keeping banked #301)\nremaining campaign: "501"\nprune-closure ${JSON.stringify(structured)}`,
    ),
    structured,
  );
  // No structured line (e.g. an install predating E2) → null, so the route can 502
  // rather than half-render a closure it cannot vouch for.
  assert.equal(parsePruneClosure("prune #201 → nothing to drop\nremaining campaign: (nothing left to run)"), null);
});
