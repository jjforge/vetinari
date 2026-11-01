import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitReadyBarrier } from "./spawn-barrier.test-support.ts";

// A child that signals ready, then waits for `go` and exits zero.
const READY_THEN_GO = `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[1];
writeFileSync(join(dir, "ready." + process.pid), "");
setInterval(() => existsSync(join(dir, "go")) && process.exit(0), 5);
`;
// A child that never signals ready and never exits on its own.
const NEVER_READY = `setInterval(() => {}, 1000);`;

const freshDir = () => mkdtempSync(join(tmpdir(), "vetinari-spawn-barrier-"));
const node = (script: string, dir: string) => spawn(process.execPath, ["-e", script, dir], { stdio: "ignore" });
const exitOf = (child: ReturnType<typeof node>) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );

test("children that each signal ready open the barrier: it resolves and writes go", { timeout: 30_000 }, async () => {
  const dir = freshDir();
  const children = [node(READY_THEN_GO, dir), node(READY_THEN_GO, dir), node(READY_THEN_GO, dir)];
  const exits = children.map(exitOf);

  await awaitReadyBarrier(dir, children);

  assert.equal(existsSync(join(dir, "go")), true);
  assert.deepEqual(await Promise.all(exits), [
    { code: 0, signal: null },
    { code: 0, signal: null },
    { code: 0, signal: null },
  ]);
});

test("a child that exits before signalling ready fails the barrier at once, naming its exit code", { timeout: 30_000 }, async () => {
  const dir = freshDir();
  const waiting = node(NEVER_READY, dir);
  const crashed = node(`process.exit(3)`, dir);
  const waitingExit = exitOf(waiting);
  const started = Date.now();

  await assert.rejects(awaitReadyBarrier(dir, [waiting, crashed]), /child 1 exited before ready: code 3/);

  assert.ok(Date.now() - started < 5_000, "rejects well inside the test timeout");
  assert.equal(existsSync(join(dir, "go")), false, "the barrier never opened");
  assert.equal((await waitingExit).signal, "SIGTERM", "the still-waiting child is stopped, not left spinning");
});

test("a child killed by a signal before signalling ready fails the barrier, naming the signal", { timeout: 30_000 }, async () => {
  const dir = freshDir();
  const killed = node(NEVER_READY, dir);
  killed.kill("SIGKILL");

  await assert.rejects(awaitReadyBarrier(dir, [killed]), /child 0 exited before ready: signal SIGKILL/);

  assert.equal(existsSync(join(dir, "go")), false, "the barrier never opened");
});
