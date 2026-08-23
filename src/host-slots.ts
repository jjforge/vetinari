import { existsSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The host slot budget (ADR 0010): a cooperative filesystem lease every
 * `campaign`/`queue` run reads and writes directly so the sum of live containers
 * across every project stays within a host-side ceiling. Split into a pure
 * fair-share computation and the impure lease edge; the gateway never allocates.
 */

/**
 * One active run's record in the lease directory: the project it belongs to, its
 * declared weight, how many live containers it currently holds, and the pid that
 * owns it (so a dead run's slots can be reclaimed on contention). Keyed on disk by
 * pid, so two runs of the same project never clobber each other.
 */
export interface SlotLease {
  project: string;
  weight: number;
  held: number;
  pid: number;
}

/** Optional seams: the pid this call acts as, and how it tests liveness. */
export interface LeaseOpts {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

/**
 * A resolved, enabled host slot budget a run carries into `queue`/`campaign`:
 * where the lease lives, the host ceiling, and this project's weight. Absent
 * (undefined) means the budget is unset and the run coordinates with no one.
 */
export interface HostBudget {
  configDir: string;
  budget: number;
  weight: number;
}

/** The host-level directory the lease files live in, under the gateway config dir. */
export function slotsDir(configDir: string): string {
  return join(configDir, "slots");
}

/**
 * The host slot budget setting, or `undefined` when it is unset — the opt-in
 * signal that leaves today's uncoordinated behavior untouched (each run bounded
 * only by its own `QUEUE_SLOTS`). `SANDCASTLE_HOST_SLOTS` wins over the
 * `<configDir>/host-slots` file; a missing, non-numeric, or non-positive value is
 * treated as unset.
 */
export function readHostBudget(configDir: string): number | undefined {
  const parse = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const fromEnv = parse(process.env.SANDCASTLE_HOST_SLOTS);
  if (fromEnv !== undefined) return fromEnv;
  const file = join(configDir, "host-slots");
  if (!existsSync(file)) return undefined;
  try {
    return parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Is `pid` a live process? `kill(pid, 0)` throws ESRCH when it is gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `fn` while holding a host-level exclusive lock, so the read-modify-write on
 * the shared lease directory is atomic across processes. The lock is an
 * exclusively-created file (`wx`); a crashed holder can't wedge it, because a lock
 * whose recorded pid is dead is reclaimed on the next contender's spin.
 */
function withLock<T>(dir: string, isAlive: (pid: number) => boolean, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Reclaim a lock left by a dead holder; otherwise wait briefly and retry.
      let holder = NaN;
      try {
        holder = Number(readFileSync(lock, "utf8").trim());
      } catch {
        // The holder released between our open and read — just retry.
      }
      if (Number.isInteger(holder) && !isAlive(holder)) {
        try {
          unlinkSync(lock);
        } catch {
          // Someone else reclaimed it first — retry.
        }
        continue;
      }
      if (attempt > 2000) throw new Error(`host-slots: could not acquire lock ${lock} (holder pid ${holder} still alive)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Best-effort — a reclaim by another process already removed it.
    }
  }
}

const leaseFile = (dir: string, pid: number) => join(slotsDir(dir), `${pid}.json`);

/**
 * Every lease file currently on disk, parsed. Malformed or vanished files are
 * skipped, never fatal. Does not reclaim dead holders — acquire does that under
 * the lock; this is the read view a run or the dashboard can take at any time.
 */
export function readLeases(configDir: string): SlotLease[] {
  const dir = slotsDir(configDir);
  if (!existsSync(dir)) return [];
  const leases: SlotLease[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const l = JSON.parse(readFileSync(join(dir, name), "utf8")) as SlotLease;
      if (l && typeof l.project === "string" && typeof l.pid === "number") leases.push(l);
    } catch {
      // A half-written or malformed file is ignored, not fatal.
    }
  }
  return leases;
}

/** Read the live leases, unlinking any whose pid is dead so their slots return. */
function liveLeases(configDir: string, isAlive: (pid: number) => boolean): SlotLease[] {
  const live: SlotLease[] = [];
  for (const l of readLeases(configDir)) {
    if (isAlive(l.pid)) {
      live.push(l);
    } else {
      try {
        unlinkSync(leaseFile(configDir, l.pid));
      } catch {
        // Already gone — fine.
      }
    }
  }
  return live;
}

/**
 * Announce this run as active by writing its lease at held zero (idempotent). A
 * run registers before it acquires so other projects see it as active and drain
 * toward their smaller share, even while it is waiting first-come at zero held.
 */
export function registerProject(configDir: string, project: string, weight: number, opts: LeaseOpts = {}): void {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  withLock(slotsDir(configDir), isAlive, () => {
    const file = leaseFile(configDir, pid);
    const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SlotLease).held : 0;
    writeFileSync(file, JSON.stringify({ project, weight, held: existing || 0, pid }));
  });
}

/** Remove this run's lease entirely — called when the run finishes or dies cleanly. */
export function deregisterProject(configDir: string, opts: LeaseOpts = {}): void {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  withLock(slotsDir(configDir), isAlive, () => {
    try {
      unlinkSync(leaseFile(configDir, pid));
    } catch {
      // Never registered, or already reclaimed — nothing to do.
    }
  });
}

/**
 * Try to take one host slot for this run. Succeeds only when, over the currently
 * live leases (dead holders reclaimed first), the run is under its own
 * `QUEUE_SLOTS`, its project is under its current `fairShare`, and the host budget
 * is not already full. On success the run's held count is incremented on disk and
 * `true` is returned; otherwise nothing changes and `false` is returned. The whole
 * check-and-write happens under the host lock, so two runs cannot both take the
 * last slot.
 */
export function acquireSlot(configDir: string, budget: number, project: string, weight: number, slots: number, opts: LeaseOpts = {}): boolean {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  return withLock(slotsDir(configDir), isAlive, () => {
    const live = liveLeases(configDir, isAlive);
    const activeWeights: Record<string, number> = { [project]: weight };
    for (const l of live) activeWeights[l.project] = l.weight;

    const total = live.reduce((s, l) => s + l.held, 0);
    const mine = live.find((l) => l.pid === pid);
    const myRunHeld = mine?.held ?? 0;
    const myProjectHeld = live.filter((l) => l.project === project).reduce((s, l) => s + l.held, 0);
    const share = fairShare(budget, activeWeights, project);

    if (myRunHeld >= slots || myProjectHeld >= share || total >= budget) return false;

    writeFileSync(leaseFile(configDir, pid), JSON.stringify({ project, weight, held: myRunHeld + 1, pid }));
    return true;
  });
}

/** Give one held slot back — called when a container parks or finishes. Never drops below zero. */
export function releaseSlot(configDir: string, opts: LeaseOpts = {}): void {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  withLock(slotsDir(configDir), isAlive, () => {
    const file = leaseFile(configDir, pid);
    if (!existsSync(file)) return;
    const l = JSON.parse(readFileSync(file, "utf8")) as SlotLease;
    writeFileSync(file, JSON.stringify({ ...l, held: Math.max(0, l.held - 1) }));
  });
}

/**
 * A project's currently-allowed slot count under a `budget`, given the weights of
 * every currently-active project: a floor of one slot per active project plus a
 * weight-proportional cut of the remainder. Pure — no filesystem. A project alone
 * gets the whole budget; each active project always gets at least one while the
 * budget can seat them all.
 */
export function fairShare(budget: number, activeWeights: Record<string, number>, project: string): number {
  const projects = Object.keys(activeWeights);
  const n = projects.length;
  if (budget <= 0 || n === 0 || !(project in activeWeights)) return 0;

  // Over-subscription: the machine cannot seat one slot for every active project,
  // so the floor is best-effort — the heaviest `budget` projects get their one
  // slot and the rest get none (they wait first-come for a freed slot). Ties
  // broken by name so every run agrees on who is seated.
  if (budget < n) {
    const seated = [...projects]
      .sort((x, y) => activeWeights[y] - activeWeights[x] || (x < y ? -1 : 1))
      .slice(0, budget);
    return seated.includes(project) ? 1 : 0;
  }

  // Everyone gets a floor of one, then the remainder is cut weight-proportionally
  // by the largest-remainder (Hamilton) method: each project's base is the floor
  // of its ideal cut, and the leftover slots go to the largest fractional parts,
  // ties broken by project name so every run computes the identical split.
  const remainder = budget - n;
  const totalWeight = projects.reduce((s, p) => s + activeWeights[p], 0) || 1;
  const ideal = (p: string) => (remainder * activeWeights[p]) / totalWeight;
  const base = (p: string) => Math.floor(ideal(p));
  let leftover = remainder - projects.reduce((s, p) => s + base(p), 0);
  const byFraction = [...projects].sort((x, y) => {
    const fx = ideal(x) - base(x);
    const fy = ideal(y) - base(y);
    return fy - fx || (x < y ? -1 : 1);
  });
  const bonus = new Set(byFraction.slice(0, leftover));
  return 1 + base(project) + (bonus.has(project) ? 1 : 0);
}
