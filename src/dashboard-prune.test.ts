import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRUNE_PREVIEW_TIMEOUT_MS, shellPruneClosure, shellPrunePreview } from "./dashboard-prune.ts";

// The prune preview shells the project's own `prune --dry-run` through `runChild`. Point
// `process.argv[1]` at a fixture CLI to exercise the shell, its cap, and the closure parse.
const withFixtureCli = async <T>(script: string, fn: () => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-prune-preview-"));
  const entry = join(dir, "cli.cjs");
  writeFileSync(entry, script);
  const orig = process.argv[1];
  process.argv[1] = entry;
  try {
    return await fn();
  } finally {
    process.argv[1] = orig;
  }
};

const closure = { target: "301", dependents: ["302"], kept: [], remaining: [["101"]] };
const closureCli = `process.stdout.write('prune #301 → drops #302\\nprune-closure ' + ${JSON.stringify(JSON.stringify(closure))} + '\\n'); process.exit(0);`;

test("shellPrunePreview resolves the dry-run's output, and shellPruneClosure parses its closure line", async () => {
  const preview = await withFixtureCli(closureCli, () => shellPrunePreview("/tmp", "301", { json: true }));
  assert.equal(preview, `prune #301 → drops #302\nprune-closure ${JSON.stringify(closure)}`);
  assert.deepEqual(await withFixtureCli(closureCli, () => shellPruneClosure("/tmp", "301")), closure);
});

test("shellPrunePreview resolves null when the child exits non-zero", async () => {
  const result = await withFixtureCli(`process.stderr.write('no campaign running\\n'); process.exit(1);`, () =>
    shellPrunePreview("/tmp", "301"),
  );
  assert.equal(result, null);
});

test("shellPrunePreview gives up at its cap rather than waiting on a hung child", async () => {
  // The fixture exits on its own after ~1 s: runChild never kills a timed-out child.
  const started = Date.now();
  const result = await withFixtureCli(`setTimeout(() => { process.stdout.write('late'); process.exit(0); }, 1000);`, () =>
    shellPrunePreview("/tmp", "301", { timeoutMs: 200 }),
  );
  assert.equal(result, null);
  assert.ok(Date.now() - started < 900, "resolved before the child exited");
});

test("the prune preview is capped at the same 60 s as the graft preview", () => {
  assert.equal(PRUNE_PREVIEW_TIMEOUT_MS, 60_000);
});
