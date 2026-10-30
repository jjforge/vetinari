// Tests for the shared POST body reader (dashboard-http.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { BodyTooLargeError, readBody } from "./dashboard-http.ts";

test("readBody resolves a body of exactly 64 KiB unchanged", async () => {
  const body = "a".repeat(65536);
  assert.equal(await readBody(Readable.from([body.slice(0, 40000), body.slice(40000)])), body);
});

test("readBody rejects a body over 64 KiB with BodyTooLargeError", async () => {
  await assert.rejects(readBody(Readable.from(["a".repeat(40000), "a".repeat(25537)])), BodyTooLargeError);
});

test("readBody counts bytes, not characters, against the limit", async () => {
  // 32769 two-byte characters: under the limit in characters, over it in bytes.
  await assert.rejects(readBody(Readable.from(["é".repeat(32769)])), BodyTooLargeError);
});
