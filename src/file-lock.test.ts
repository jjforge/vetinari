import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECLAIM_GUARD_STALE_MS, withFileLockAsync, withFileLockSync } from "./file-lock.ts";

const freshLock = () => join(mkdtempSync(join(tmpdir(), "vetinari-file-lock-")), "test.lock");
const opts = { retryMs: 1, maxAttempts: 5, label: "test" };

test("a holder's lock carries its pid and a per-acquisition token, and a normal release leaves nothing beside it", () => {
  const lock = freshLock();
  let content = "";
  const out = withFileLockSync(
    lock,
    () => {
      content = readFileSync(lock, "utf8");
      return 42;
    },
    opts,
  );
  assert.equal(out, 42);
  assert.match(content, new RegExp(`^${process.pid}:.+$`));
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(join(lock, "..")), []);
});

test("release leaves alone a lock that another holder now owns — after fn returns and after it throws", () => {
  const other = "99999:someone-else";
  const lock = freshLock();
  withFileLockSync(lock, () => writeFileSync(lock, other), opts);
  assert.equal(readFileSync(lock, "utf8"), other);

  const lock2 = freshLock();
  assert.throws(
    () =>
      withFileLockSync(
        lock2,
        () => {
          writeFileSync(lock2, other);
          throw new Error("boom");
        },
        opts,
      ),
    /boom/,
  );
  assert.equal(readFileSync(lock2, "utf8"), other);
});

test("async release leaves alone a lock that another holder now owns — after fn resolves and after it rejects", async () => {
  const other = "99999:someone-else";
  const lock = freshLock();
  await withFileLockAsync(lock, async () => writeFileSync(lock, other), opts);
  assert.equal(readFileSync(lock, "utf8"), other);

  const lock2 = freshLock();
  await assert.rejects(
    withFileLockAsync(
      lock2,
      async () => {
        writeFileSync(lock2, other);
        throw new Error("boom");
      },
      opts,
    ),
    /boom/,
  );
  assert.equal(readFileSync(lock2, "utf8"), other);
});

const DEAD = 424242;
const LIVE = 434343;
const isAlive = (pid: number) => pid === LIVE;

test("a legacy plain-pid lock whose holder is dead is reclaimed and fn runs", () => {
  const lock = freshLock();
  writeFileSync(lock, String(DEAD));
  let ran = false;
  withFileLockSync(lock, () => (ran = true), { ...opts, isAlive });
  assert.equal(ran, true);
  assert.equal(existsSync(lock), false);
});

test("an empty lock left by a holder killed mid-write is reclaimed — sync variant", () => {
  const lock = freshLock();
  writeFileSync(lock, "");
  let ran = false;
  withFileLockSync(lock, () => (ran = true), { ...opts, isAlive: () => true });
  assert.equal(ran, true);
});

for (const content of [String(LIVE), `${LIVE}:token`, "garbage", "0", "-3"]) {
  test(`a lock holding ${JSON.stringify(content)} is not reclaimed: the contender times out and the file is unchanged`, () => {
    const lock = freshLock();
    writeFileSync(lock, content);
    let ran = false;
    assert.throws(() => withFileLockSync(lock, () => (ran = true), { ...opts, isAlive }), /^Error: test: could not acquire lock/);
    assert.equal(ran, false);
    assert.equal(readFileSync(lock, "utf8"), content);
  });
}

test("a contender that read a dead holder does not delete the live lock a faster contender already took in its place", () => {
  const lock = freshLock();
  writeFileSync(lock, `${DEAD}:old`);
  const live = `${LIVE}:token`;
  const racingIsAlive = (pid: number) => {
    // A second contender reclaims the dead lock while we are still checking it.
    if (pid === DEAD) writeFileSync(lock, live);
    return pid === LIVE;
  };
  let ran = false;
  assert.throws(() => withFileLockSync(lock, () => (ran = true), { ...opts, isAlive: racingIsAlive }), /could not acquire lock/);
  assert.equal(ran, false);
  assert.equal(readFileSync(lock, "utf8"), live);
});

test("while another contender holds a fresh reclaim guard, a dead holder's lock is not reclaimed and both files are unchanged", () => {
  const lock = freshLock();
  const guard = `${lock}.reclaim`;
  writeFileSync(lock, `${DEAD}:old`);
  writeFileSync(guard, `${LIVE}:guard`);
  let ran = false;
  assert.throws(() => withFileLockSync(lock, () => (ran = true), { ...opts, isAlive }), /could not acquire lock/);
  assert.equal(ran, false);
  assert.equal(readFileSync(lock, "utf8"), `${DEAD}:old`);
  assert.equal(readFileSync(guard, "utf8"), `${LIVE}:guard`);
});

test("a reclaim guard older than the stale limit is cleared, and the dead holder's lock is reclaimed", () => {
  const lock = freshLock();
  const guard = `${lock}.reclaim`;
  writeFileSync(lock, `${DEAD}:old`);
  writeFileSync(guard, `${LIVE}:guard`);
  const past = (Date.now() - RECLAIM_GUARD_STALE_MS - 1000) / 1000;
  utimesSync(guard, past, past);
  let ran = false;
  withFileLockSync(lock, () => (ran = true), { ...opts, isAlive });
  assert.equal(ran, true);
  assert.deepEqual(readdirSync(join(lock, "..")), []);
});

test("an empty lock left by a holder killed mid-write is reclaimed — async variant", async () => {
  const lock = freshLock();
  writeFileSync(lock, "");
  let content = "";
  const out = await withFileLockAsync(
    lock,
    async () => {
      content = readFileSync(lock, "utf8");
      return 7;
    },
    { ...opts, isAlive: () => true },
  );
  assert.equal(out, 7);
  assert.match(content, new RegExp(`^${process.pid}:.+$`));
  assert.deepEqual(readdirSync(join(lock, "..")), []);
});

test("the async variant waits for a live holder and gives up with its could-not-acquire error", async () => {
  const lock = freshLock();
  writeFileSync(lock, `${LIVE}:token`);
  await assert.rejects(
    withFileLockAsync(lock, async () => {}, { ...opts, isAlive }),
    /^Error: test: could not acquire lock/,
  );
  assert.equal(readFileSync(lock, "utf8"), `${LIVE}:token`);
});

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FILE_LOCK = pathToFileURL(fileURLToPath(new URL("./file-lock.ts", import.meta.url))).href;

// Each child waits at a start barrier, then loops sync acquisitions using the real
// pidAlive. In its critical section it creates a sentinel exclusively: EEXIST means two
// holders overlapped, and the child exits non-zero.
const CHILD = `
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from ${JSON.stringify(FILE_LOCK)};
const [dir, lock] = process.argv.slice(2);
writeFileSync(join(dir, "ready." + process.pid), "");
while (!existsSync(join(dir, "go"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const sentinel = join(dir, "sentinel");
for (let i = 0; i < 40; i++) {
  withFileLockSync(lock, () => {
    try {
      closeSync(openSync(sentinel, "wx"));
    } catch (e) {
      console.error("two holders overlapped:", e.code);
      process.exit(1);
    }
    unlinkSync(sentinel);
  }, { retryMs: 1, maxAttempts: 5000, label: "child" });
}
`;

test("several processes contending one lock, seeded with a dead holder's lock, never hold it at once", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-file-lock-procs-"));
  const lock = join(dir, "test.lock");
  const script = join(dir, "child.mts");
  writeFileSync(script, CHILD);
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeFileSync(lock, `${deadPid}:crashed`);

  const N = 5;
  const children = Array.from({ length: N }, () => {
    const child = spawn(TSX, [script, dir, lock], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    return new Promise<{ code: number | null; stderr: string }>((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  });
  while (readdirSync(dir).filter((f) => f.startsWith("ready.")).length < N) await new Promise((r) => setTimeout(r, 10));
  writeFileSync(join(dir, "go"), "");

  for (const { code, stderr } of await Promise.all(children)) assert.equal(code, 0, stderr);
  assert.equal(existsSync(lock), false);
});
