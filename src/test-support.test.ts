import test from "node:test";
import assert from "node:assert/strict";
import { withEnv } from "./test-support.ts";

const SET = "VETINARI_TEST_SUPPORT_SET";
const DELETED = "VETINARI_TEST_SUPPORT_DELETED";
const ABSENT = "VETINARI_TEST_SUPPORT_ABSENT";

/** Seed the three keys' "before" state: two present, one absent. */
const seed = () => {
  process.env[SET] = "set-before";
  process.env[DELETED] = "deleted-before";
  delete process.env[ABSENT];
};

const over = { [SET]: "set-during", [DELETED]: undefined, [ABSENT]: "absent-during" };

const assertDuring = () => {
  assert.equal(process.env[SET], "set-during");
  assert.equal(DELETED in process.env, false);
  assert.equal(process.env[ABSENT], "absent-during");
};

const assertRestored = () => {
  assert.equal(process.env[SET], "set-before");
  assert.equal(process.env[DELETED], "deleted-before");
  assert.equal(ABSENT in process.env, false);
};

test("withEnv applies its overrides and restores every key after a sync fn returns", () => {
  seed();
  const result = withEnv(over, () => {
    assertDuring();
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(typeof result, "number", "a sync fn's result comes back directly, not as a promise");
  assertRestored();
});

test("withEnv restores every key after a sync fn throws", () => {
  seed();
  assert.throws(
    () =>
      withEnv(over, () => {
        assertDuring();
        throw new Error("boom");
      }),
    /boom/,
  );
  assertRestored();
});

test("withEnv keeps its overrides across an await and restores after an async fn resolves", async () => {
  seed();
  const result = await withEnv(over, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assertDuring();
    return "done";
  });
  assert.equal(result, "done");
  assertRestored();
});

test("withEnv restores every key after an async fn rejects", async () => {
  seed();
  await assert.rejects(
    withEnv(over, async () => {
      await new Promise((r) => setTimeout(r, 1));
      assertDuring();
      throw new Error("async boom");
    }),
    /async boom/,
  );
  assertRestored();
});

test("withEnv leaves no trace of consecutive sync calls on the same key", () => {
  seed();
  withEnv({ [SET]: "first" }, () => assert.equal(process.env[SET], "first"));
  withEnv({ [SET]: undefined }, () => assert.equal(SET in process.env, false));
  assertRestored();
});

test.after(() => {
  for (const k of [SET, DELETED, ABSENT]) delete process.env[k];
});
