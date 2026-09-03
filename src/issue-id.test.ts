import test from "node:test";
import assert from "node:assert/strict";
import { normalize, isIssueToken } from "./issue-id.ts";

test("normalize strips a single leading # and trims surrounding whitespace", () => {
  assert.equal(normalize("#640"), "640");
  assert.equal(normalize("640"), "640");
  assert.equal(normalize(" 640 "), "640");
  // The `#` is stripped only when it leads the raw string (before trim); a `#`
  // behind whitespace is left, then trimmed to a still-#-prefixed token.
  assert.equal(normalize("  #640  "), "#640");
  // Only the leading # is stripped — an interior one is left alone.
  assert.equal(normalize("#6#40"), "6#40");
});

test("isIssueToken accepts a bare or #-prefixed number and rejects anything else", () => {
  assert.equal(isIssueToken("640"), true);
  assert.equal(isIssueToken("#640"), true);
  assert.equal(isIssueToken("vetinari"), false);
  assert.equal(isIssueToken("#"), false);
  assert.equal(isIssueToken("64a"), false);
  assert.equal(isIssueToken(""), false);
});
