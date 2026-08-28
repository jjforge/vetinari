import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCWORLD_NAMES, festiveWaveName } from "./festive-names.ts";

test("festiveWaveName is pure — the same offset+index always yields the same name", () => {
  assert.equal(festiveWaveName(0, 0), festiveWaveName(0, 0));
  assert.equal(festiveWaveName(12, 3), festiveWaveName(12, 3));
});

test("festiveWaveName walks the pool by offset+index", () => {
  const pool = ["a", "b", "c", "d"];
  assert.equal(festiveWaveName(0, 0, pool), "a");
  assert.equal(festiveWaveName(0, 1, pool), "b");
  assert.equal(festiveWaveName(1, 2, pool), "d");
  // offset and index are interchangeable — only their sum matters.
  assert.equal(festiveWaveName(2, 1, pool), festiveWaveName(1, 2, pool));
});

test("festiveWaveName wraps modulo the pool length", () => {
  const pool = ["a", "b", "c"];
  assert.equal(festiveWaveName(2, 1, pool), "a"); // (2+1)%3 = 0
  assert.equal(festiveWaveName(3, 2, pool), "c"); // (3+2)%3 = 2
});

test("consecutive campaign blocks never collide until the pool wraps", () => {
  // A campaign of W waves reserves offsets [c, c+W); the next reserves [c+W, …).
  // Every name in one block differs from every name in the next until the whole
  // pool has been drawn — that is the cooling-off guarantee.
  const N = DISCWORLD_NAMES.length;
  const seen = new Set<string>();
  for (let i = 0; i < N; i++) {
    const name = festiveWaveName(0, i);
    assert.equal(seen.has(name), false, `name repeated before wrap at index ${i}: ${name}`);
    seen.add(name);
  }
  // Only on the wrap does the first name recur.
  assert.equal(festiveWaveName(0, N), festiveWaveName(0, 0));
});

test("the Discworld pool is a non-empty, unique, fixed-order roster", () => {
  assert.ok(DISCWORLD_NAMES.length > 100);
  assert.equal(new Set(DISCWORLD_NAMES).size, DISCWORLD_NAMES.length, "names must be unique so cooling-off holds");
  // Fixed order — the roster leads with Samuel Vimes (the anchor of the pool order).
  assert.equal(DISCWORLD_NAMES[0], "Samuel Vimes");
});
