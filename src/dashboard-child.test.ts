import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runChild } from "./dashboard-child.ts";

// A throwaway node fixture standing in for the project's own CLI: `runChild` shells
// `process.argv[1]` (the vetinari entry), so a test points that at this script instead.
// Its first arg selects a behaviour — clean exit, non-zero with stderr, or a slow child
// that outlives the timeout and writes a marker once it finally finishes.
const FIXTURE = `
const mode = process.argv[2];
if (mode === "ok") { process.stdout.write("clean stdout"); process.exit(0); }
if (mode === "fail") { process.stderr.write("first noise\\nthe actionable last line\\n"); process.exit(3); }
if (mode === "slow") {
  const marker = process.argv[3];
  setTimeout(() => { require("node:fs").writeFileSync(marker, "landed"); process.exit(0); }, 300);
}
`;

const fixtureEntry = () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-child-"));
  const entry = join(dir, "fixture.cjs");
  writeFileSync(entry, FIXTURE);
  return { dir, entry };
};

// Shell the fixture as if it were the project's own CLI by pointing `process.argv[1]` at
// it for the duration of the call (restored after), so the real spawn/capture path runs.
const withEntry = async <T>(entry: string, fn: () => Promise<T>): Promise<T> => {
  const orig = process.argv[1];
  process.argv[1] = entry;
  try {
    return await fn();
  } finally {
    process.argv[1] = orig;
  }
};

test("runChild captures a clean child's stdout and zero exit code", async () => {
  const { dir, entry } = fixtureEntry();
  const result = await withEntry(entry, () => runChild(dir, ["ok"], { timeoutMs: 5_000 }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "clean stdout");
  assert.equal(result.timedOut, false);
});

test("runChild captures a broken child's stderr and its non-zero exit code", async () => {
  const { dir, entry } = fixtureEntry();
  const result = await withEntry(entry, () => runChild(dir, ["fail"], { timeoutMs: 5_000 }));
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  // The whole stderr is captured (decision 5) — the route surfaces the last non-empty line.
  assert.match(result.stderr, /the actionable last line/);
});

test("runChild caps the wait at timeoutMs and does NOT kill the still-running child", async () => {
  const { dir, entry } = fixtureEntry();
  const marker = join(dir, "marker");
  const started = Date.now();
  const result = await withEntry(entry, () => runChild(dir, ["slow", marker], { timeoutMs: 50 }));
  // It gave up waiting at ~50ms, long before the child's 300ms runtime.
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - started < 250, "resolved at the cap, not the child's full runtime");
  // The marker is absent now — the child is still running, not killed. It appears once the
  // child finishes on its own, proving `runChild` left it alone (decision 6).
  assert.equal(existsSync(marker), false, "the child had not finished when the cap fired");
  await delay(400);
  assert.equal(existsSync(marker), true, "the un-killed child ran to completion after the cap");
});
