import { existsSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { cpus } from "node:os";
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
 * The resolved host container ceiling a run carries into `queue`/`campaign`:
 * where the lease lives, the host ceiling, and this project's fair-share weight
 * (mapped from its `containerShare` tier). Always present — the ceiling is in
 * effect for every run (ADR 0011), machine-derived when nothing is set.
 */
export interface HostBudget {
  configDir: string;
  ceiling: number;
  weight: number;
}

/** The host-level directory the lease files live in, under the gateway config dir. */
export function slotsDir(configDir: string): string {
  return join(configDir, "slots");
}

/** The host-ceiling file's name under the gateway config dir (ADR 0011). */
const CEILING_FILE = "max-concurrent-containers";

/**
 * The machine-derived container ceiling used when nothing is set explicitly
 * (ADR 0011): the CPU count less one core reserved for the host/orchestrator, so
 * a lone project runs several containers without swamping the machine — never
 * below one. Pure and tunable.
 */
export function machineDefaultCeiling(cpuCount: number): number {
  return Math.max(1, cpuCount - 1);
}

/**
 * The host's ceiling on live containers across every project (ADR 0011):
 * `MAX_CONCURRENT_CONTAINERS` wins over the `<configDir>/max-concurrent-containers`
 * file, and when neither is a positive integer it resolves to a machine-derived
 * default rather than "unbounded" — so the ceiling is always in effect and a lone
 * project fills it while the host is never swamped.
 */
export function resolveHostCeiling(configDir: string): number {
  const parse = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const fromEnv = parse(process.env.MAX_CONCURRENT_CONTAINERS);
  if (fromEnv !== undefined) return fromEnv;
  const file = join(configDir, CEILING_FILE);
  if (existsSync(file)) {
    try {
      const fromFile = parse(readFileSync(file, "utf8"));
      if (fromFile !== undefined) return fromFile;
    } catch {
      // Unreadable file — fall through to the machine-derived default.
    }
  }
  return machineDefaultCeiling(cpus().length);
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

/**
 * Whether `project` currently holds a live host slot — the crash probe the dashboard
 * injects into `reduceCampaign` (design §8). A run writes its lease when it registers
 * and holds it (even at held zero, waiting first-come) until it finishes or dies; a
 * crashed run's lease lingers on disk but its pid is gone, so a project with no live
 * lease has no run on it. Read-only — it never reclaims a dead lease (acquire does that
 * under the lock); this is a probe any read path can take at any time.
 */
export function projectHasLiveLease(configDir: string, project: string, opts: LeaseOpts = {}): boolean {
  const isAlive = opts.isAlive ?? pidAlive;
  return readLeases(configDir).some((l) => l.project === project && isAlive(l.pid));
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
 * live leases (dead holders reclaimed first), the run's project is under its
 * current `fairShare` and the host ceiling is not already full. There is no
 * per-run cap (ADR 0011): a run fills up to its fair share, and a lone project
 * fills the whole ceiling. On success the run's held count is incremented on disk
 * and `true` is returned; otherwise nothing changes and `false` is returned. The
 * whole check-and-write happens under the host lock, so two runs cannot both take
 * the last slot.
 */
export function acquireSlot(configDir: string, ceiling: number, project: string, weight: number, opts: LeaseOpts = {}): boolean {
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
    const share = fairShare(ceiling, activeWeights, project);

    if (myProjectHeld >= share || total >= ceiling) return false;

    writeFileSync(leaseFile(configDir, pid), JSON.stringify({ project, weight, held: myRunHeld + 1, pid }));
    return true;
  });
}

/** The host-level festive-name cursor file (#193): one integer, the next unreserved
 * offset into the festive roster. Lives beside the ceiling file under the config dir. */
const FESTIVE_CURSOR_FILE = "festive-cursor";

/**
 * Reserve a contiguous block of `count` festive-name offsets from the host cursor
 * (#193), returning the block's start and advancing the persisted cursor by `count` —
 * all under the host lock, so two campaigns starting at once get disjoint blocks and
 * never share a name. The cursor is a single integer persisted across campaigns, so
 * sequential runs keep walking the roster and a name does not recur until it wraps. A
 * fresh host (or an unreadable/negative cursor) starts at zero; `count` of zero
 * reserves nothing and leaves the cursor put.
 */
export function reserveFestiveBlock(configDir: string, count: number, opts: LeaseOpts = {}): number {
  const isAlive = opts.isAlive ?? pidAlive;
  return withLock(slotsDir(configDir), isAlive, () => {
    const file = join(configDir, FESTIVE_CURSOR_FILE);
    let cursor = 0;
    if (existsSync(file)) {
      const parsed = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(parsed) && parsed >= 0) cursor = parsed;
    }
    writeFileSync(file, String(cursor + Math.max(0, count)));
    return cursor;
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
 * A project's currently-allowed slot count under a host `ceiling`, given the
 * weights of every currently-active project: a floor of one slot per active
 * project plus a weight-proportional cut of the remainder. Pure — no filesystem. A
 * project alone gets the whole ceiling; each active project always gets at least
 * one while the ceiling can seat them all.
 */
export function fairShare(ceiling: number, activeWeights: Record<string, number>, project: string): number {
  const projects = Object.keys(activeWeights);
  const n = projects.length;
  if (ceiling <= 0 || n === 0 || !(project in activeWeights)) return 0;

  // Over-subscription: the machine cannot seat one slot for every active project,
  // so the floor is best-effort — the heaviest `ceiling` projects get their one
  // slot and the rest get none (they wait first-come for a freed slot). Ties
  // broken by name so every run agrees on who is seated.
  if (ceiling < n) {
    const seated = [...projects]
      .sort((x, y) => activeWeights[y] - activeWeights[x] || (x < y ? -1 : 1))
      .slice(0, ceiling);
    return seated.includes(project) ? 1 : 0;
  }

  // Everyone gets a floor of one, then the remainder is cut weight-proportionally
  // by the largest-remainder (Hamilton) method: each project's base is the floor
  // of its ideal cut, and the leftover slots go to the largest fractional parts,
  // ties broken by project name so every run computes the identical split.
  const remainder = ceiling - n;
  const totalWeight = projects.reduce((s, p) => s + activeWeights[p], 0) || 1;
  const ideal = (p: string) => (remainder * activeWeights[p]) / totalWeight;
  const base = (p: string) => Math.floor(ideal(p));
  const leftover = remainder - projects.reduce((s, p) => s + base(p), 0);
  const byFraction = [...projects].sort((x, y) => {
    const fx = ideal(x) - base(x);
    const fy = ideal(y) - base(y);
    return fy - fx || (x < y ? -1 : 1);
  });
  const bonus = new Set(byFraction.slice(0, leftover));
  return 1 + base(project) + (bonus.has(project) ? 1 : 0);
}
