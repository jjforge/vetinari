import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GIT_READ_LIMITS, gitRead } from "./git-read.ts";
import { seedRepo } from "./test-support.ts";

/** Run `body` with an executable `git` (a shell script) at the front of `PATH`, restoring it after. */
function withStubGit<T>(script: string, body: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "vetinari-stub-git-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
  try {
    return body();
  } finally {
    process.env.PATH = saved;
  }
}

test("GIT_READ_LIMITS caps a git read at 60 s and 64 MiB of output", () => {
  assert.deepEqual(GIT_READ_LIMITS, { timeout: 60_000, maxBuffer: 67_108_864 });
});

test("gitRead returns git's untrimmed stdout from the given cwd", () => {
  const cwd = seedRepo();
  assert.equal(gitRead(["rev-parse", "--is-inside-work-tree"], { cwd }), "true\n");
});

test("gitRead returns a read larger than Node's old 1 MB default buffer", () => {
  const twoMiB = 2 * 1024 * 1024;
  const out = withStubGit(`head -c ${twoMiB} /dev/zero | tr '\\0' x`, () => gitRead([]));
  assert.equal(out.length, twoMiB);
});

test("gitRead kills and throws on a read that runs past its timeout", () => {
  const started = Date.now();
  assert.throws(() => withStubGit("exec sleep 10", () => gitRead([], { limits: { ...GIT_READ_LIMITS, timeout: 200 } })));
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});
