import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface FileLockOpts {
  /** Wait between attempts while the lock is held, in milliseconds. */
  retryMs: number;
  /** How many waits before giving up with a "could not acquire" error. */
  maxAttempts: number;
  /** The error prefix, naming the caller (`host-slots`, `findings`). */
  label: string;
  /** Is the holder `pid` alive? Defaults to `pidAlive`. */
  isAlive?: (pid: number) => boolean;
}

/** Is `pid` a live process? `kill(pid, 0)` throws ESRCH when it is gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * May a lock holding `content` be reclaimed? Its holder is the leading integer, so a
 * legacy plain `<pid>` lock and a `<pid>:<nonce>` token both read. Empty content is
 * stale — only a pre-link writer killed between create and write leaves one. Content
 * that does not parse, or a pid <= 0, is never reclaimed: the contender just waits.
 */
function reclaimable(content: string, isAlive: (pid: number) => boolean): boolean {
  if (content === "") return true;
  const pid = Number(/^\d+/.exec(content)?.[0]);
  return pid > 0 && !isAlive(pid);
}

/** Read a file's content, or `undefined` when it does not exist. */
function readContent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Create `path` holding `content`, atomically and exclusively: write a temp beside it,
 * then hard-link the temp into place (`link` fails with EEXIST when `path` exists), so
 * `path` never exists with partial content. The temp is removed either way.
 */
function linkExclusive(path: string, content: string, nonce: string): boolean {
  const temp = `${path}.${nonce}.tmp`;
  writeFileSync(temp, content);
  try {
    linkSync(temp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(temp);
  }
}

/** Delete `path` only if it still holds `content` byte-for-byte — never another holder's lock. */
function releaseIf(path: string, content: string): void {
  if (readContent(path) === content) unlinkIfPresent(path);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * A reclaim guard older than this is stale — its holder crashed or stalled — and is
 * cleared with no pid check. A real guard is held for microseconds.
 */
export const RECLAIM_GUARD_STALE_MS = 5000;

function guardStale(guard: string): boolean {
  try {
    return Date.now() - statSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

interface Acquisition {
  lock: string;
  nonce: string;
  token: string;
  isAlive: (pid: number) => boolean;
}

/**
 * One acquisition attempt: `held` when we took the lock, `again` when the lock changed
 * under us (released, or a dead holder's lock reclaimed) and an immediate retry is due,
 * `wait` when it is held by a live holder — or another contender is mid-reclaim.
 *
 * A dead holder's lock is reclaimed under a guard (`<lock>.reclaim`), and only if it
 * still holds byte-for-byte the content we judged dead: two contenders that both read
 * the same dead holder can then never both delete — the second would delete the live
 * lock the first just took.
 */
function attempt(a: Acquisition): "held" | "again" | "wait" {
  if (linkExclusive(a.lock, a.token, a.nonce)) return "held";
  const seen = readContent(a.lock);
  if (seen === undefined) return "again";
  if (!reclaimable(seen, a.isAlive)) return "wait";
  const guard = `${a.lock}.reclaim`;
  if (!linkExclusive(guard, a.token, a.nonce)) {
    if (!guardStale(guard)) return "wait";
    unlinkIfPresent(guard);
    return "again";
  }
  try {
    releaseIf(a.lock, seen);
  } finally {
    releaseIf(guard, a.token);
  }
  return "again";
}

function begin(lock: string, opts: FileLockOpts): Acquisition {
  mkdirSync(dirname(lock), { recursive: true });
  const nonce = randomBytes(8).toString("hex");
  return { lock, nonce, token: `${process.pid}:${nonce}`, isAlive: opts.isAlive ?? pidAlive };
}

const giveUp = (lock: string, opts: FileLockOpts) => new Error(`${opts.label}: could not acquire lock ${lock} (held by a live process)`);

/**
 * Run `fn` while holding the exclusive lock file at `lock`, so a read-modify-write is
 * atomic across processes. The lock holds `<pid>:<nonce>`, unique to this acquisition;
 * a lock whose holder is dead is reclaimed, and release deletes only our own lock.
 */
export function withFileLockSync<T>(lock: string, fn: () => T, opts: FileLockOpts): T {
  const a = begin(lock, opts);
  for (let waits = 0; ;) {
    const step = attempt(a);
    if (step === "held") break;
    if (step === "again") continue;
    if (waits++ >= opts.maxAttempts) throw giveUp(lock, opts);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, opts.retryMs);
  }
  try {
    return fn();
  } finally {
    releaseIf(lock, a.token);
  }
}

/** `withFileLockSync` for an async `fn`: waits yield to the event loop instead of blocking. */
export async function withFileLockAsync<T>(lock: string, fn: () => Promise<T>, opts: FileLockOpts): Promise<T> {
  const a = begin(lock, opts);
  for (let waits = 0; ;) {
    const step = attempt(a);
    if (step === "held") break;
    if (step === "again") continue;
    if (waits++ >= opts.maxAttempts) throw giveUp(lock, opts);
    await new Promise((r) => setTimeout(r, opts.retryMs));
  }
  try {
    return await fn();
  } finally {
    releaseIf(lock, a.token);
  }
}
