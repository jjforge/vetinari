/**
 * The **overlap replay** behind `/review-logs`' config lens: for each file key that tickets in
 * one campaign both declared, how often their real changes actually conflicted. A port of the
 * 2026-10-30 `scripts/replay/collide/` analysis, parametrised to one project.
 *
 * For every campaign in the project's archived event logs, it pairs the scheduled tickets
 * whose **declared** file keys overlap (pre-waive, so a waived file can still be measured),
 * finds each ticket's real change in git from its `campaign: merge <branchPrefix><id>` commit,
 * and test-merges the pair's two changes on a common base, as if they had run in one wave.
 * Each pair then counts, per shared key, as **clean**, **collides** (a conflicted path falls
 * under that key) or **indeterminate** (the changes cannot be test-merged on a common base).
 *
 * Read-only toward the project: git is only read there, and every test-merge runs in a
 * temporary `git clone --shared` under the OS temp dir, removed when the run ends.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEventLogText, type OrchestratorEvent } from "./event-log.ts";
import { ticketProse, type FileSetOf } from "./fileset.ts";
import { gitRead } from "./git-read.ts";
import { normalize } from "./issue-id.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** The tracker reads the replay makes, all read-only. */
export interface OverlapTracker {
  /** the issue as `gh issue view --json title,body,comments` prints it — fed to `ticketProse`. */
  issueText(id: string): Promise<string>;
  /** every native `blocked_by` blocker of the issue, open or closed. */
  blockedBy(id: string): Promise<string[]>;
}

export interface OverlapReplayOptions {
  /** the project root: its `.vetinari.local/logs/` and its git repo. */
  root: string;
  /** the project's file-set resolver, **without** `waiveFileSet`. */
  fileSet: FileSetOf;
  tracker: OverlapTracker;
  /** agent branches are `${branchPrefix}${id}`; default `agent/`. */
  branchPrefix?: string;
  /** where the temporary clone goes; default the OS temp dir. */
  tmpRoot?: string;
}

/** One declared file key's pairs: how many shared it, and how their test-merges came out. */
export interface OverlapKeyTally {
  key: string;
  pairs: number;
  clean: number;
  collides: number;
  indeterminate: number;
  /** collides ÷ (clean + collides) — indeterminate pairs left out; null when none was measured. */
  rate: number | null;
}

export interface OverlapReplay {
  keys: OverlapKeyTally[];
  /** tickets whose keys came from today's issue text but whose cites no longer all resolve
   *  against today's tree (or cite nothing): they count with the keys that did resolve. */
  staleCiteTickets: string[];
}

/** A campaign as the logs record it: when it started and the tickets it scheduled. */
interface ReplayCampaign {
  start: number;
  tickets: string[];
  /** the pre-waive keys `campaign-start` recorded, when it did. */
  fileKeys?: Record<string, string[]>;
}

/** A ticket's landed change: its merge commit, the pre-merge base and the branch tip. */
interface Landed {
  merge: string;
  base: string;
  tip: string;
  at: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Every campaign in the project's live and archived orchestrator logs, oldest first. */
function readCampaigns(root: string): ReplayCampaign[] {
  const logs = join(root, ".vetinari.local", "logs");
  const archive = join(logs, "archive");
  const files = [
    ...(existsSync(archive)
      ? readdirSync(archive)
          .filter((f) => /^orchestrator-.*\.jsonl$/.test(f))
          .map((f) => join(archive, f))
      : []),
    join(logs, "orchestrator.jsonl"),
  ].filter((f) => existsSync(f));
  const campaigns: ReplayCampaign[] = [];
  for (const file of files) {
    let current: ReplayCampaign | undefined;
    for (const e of parseEventLogText(readFileSync(file, "utf8")) as OrchestratorEvent[]) {
      if (e.event === "campaign-start") {
        // `fileKeys` is read untyped: older logs never carry it.
        const fileKeys = (e as unknown as { fileKeys?: Record<string, string[]> }).fileKeys;
        current = { start: Date.parse(e.ts), tickets: (e.waves ?? []).flat().map(String).map(normalize), fileKeys };
        campaigns.push(current);
      } else if (e.event === "graft" && current) {
        current.tickets.push(...e.ids.map(String).map(normalize));
      }
    }
  }
  return campaigns.sort((a, b) => a.start - b.start);
}

/** Every `campaign: merge <prefix><id>` merge commit reachable from any ref, by ticket id. */
function landedMerges(root: string, branchPrefix: string): Map<string, Landed[]> {
  const out = gitRead(["log", "--all", "--merges", "--format=%H %P %cI %s"], { cwd: root });
  const subject = new RegExp(`^campaign: merge ${branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\S+)$`);
  const byId = new Map<string, Landed[]>();
  for (const line of out.split("\n")) {
    const [merge, base, tip, date, ...rest] = line.split(" ");
    const m = subject.exec(rest.join(" "));
    if (!m || !/^[0-9a-f]{40,}$/.test(tip ?? "")) continue;
    const id = normalize(m[1]);
    (byId.get(id) ?? byId.set(id, []).get(id)!).push({ merge, base, tip, at: Date.parse(date) });
  }
  return byId;
}

/** The temporary clone the test-merges write into, and its git runner. */
function scratchClone(root: string, tmpRoot: string) {
  const dir = mkdtempSync(join(tmpRoot, "vetinari-overlap-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "overlap-replay",
    GIT_AUTHOR_EMAIL: "overlap-replay@localhost",
    GIT_COMMITTER_NAME: "overlap-replay",
    GIT_COMMITTER_EMAIL: "overlap-replay@localhost",
  };
  const git = (args: string[], okCodes = [0]) => {
    const r = spawnSync("git", ["-C", join(dir, "repo.git"), ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    if (!okCodes.includes(r.status ?? -1)) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return { code: r.status, out: r.stdout };
  };
  const r = spawnSync("git", ["clone", "-q", "--bare", "--shared", root, join(dir, "repo.git")], { encoding: "utf8" });
  if (r.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone --shared ${root}: ${r.stderr}`);
  }
  return { dir, git };
}

type Git = ReturnType<typeof scratchClone>["git"];

/**
 * Test-merge `ours` and `theirs` over `base`: the merged tree and its conflicted paths. Each side
 * is re-parented onto `base` first, so `base` is their only merge base — `merge-tree --merge-base`
 * without needing a git that has it.
 */
function mergeOver(git: Git, base: string, ours: string, theirs: string): { tree: string; conflicts: string[] } {
  const onBase = (rev: string) => git(["commit-tree", `${rev}^{tree}`, "-p", base, "-m", "overlap-replay"]).out.trim();
  const { code, out } = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", onBase(ours), onBase(theirs)], [0, 1]);
  const [tree, ...paths] = out.split("\n").filter(Boolean);
  return { tree, conflicts: code === 1 ? [...new Set(paths)] : [] };
}

const commitTree = (git: Git, tree: string, parent: string) => git(["commit-tree", tree, "-p", parent, "-m", "overlap-replay"]).out.trim();

/** A pair's outcome: the paths it conflicted on, or clean, or indeterminate. */
type PairVerdict = { kind: "conflict"; paths: string[] } | { kind: "clean" } | { kind: "indeterminate" };

/**
 * Would B's change, merged second, have conflicted with A's (merged first) had they run in one
 * wave? Two counterfactuals, as `collide.py` tries them:
 *   - **primary:** B's change re-applied onto A's pre-merge base, then merged with A's merge;
 *   - **alternative:** everything as it really happened, only A reverted out of B's base, then
 *     B's change re-applied there and merged with B's real base.
 * A conflict in either wins, then a clean one; a pair neither can test-merge is indeterminate.
 */
function classifyPair(git: Git, a: Landed, b: Landed): PairVerdict {
  const baseB = git(["merge-base", b.base, b.tip]).out.trim();
  const results: PairVerdict[] = [];

  const applied = mergeOver(git, baseB, a.base, b.tip);
  if (applied.conflicts.length) results.push({ kind: "indeterminate" });
  else {
    const merged = mergeOver(git, a.base, a.merge, commitTree(git, applied.tree, a.base));
    results.push(merged.conflicts.length ? { kind: "conflict", paths: merged.conflicts } : { kind: "clean" });
  }

  const reverted = mergeOver(git, a.merge, b.base, a.base);
  if (reverted.conflicts.length) results.push({ kind: "indeterminate" });
  else {
    const without = commitTree(git, reverted.tree, b.base);
    const reapplied = mergeOver(git, baseB, without, b.tip);
    if (reapplied.conflicts.length) results.push({ kind: "indeterminate" });
    else {
      const merged = mergeOver(git, without, b.base, commitTree(git, reapplied.tree, without));
      results.push(merged.conflicts.length ? { kind: "conflict", paths: merged.conflicts } : { kind: "clean" });
    }
  }

  const paths = results.flatMap((r) => (r.kind === "conflict" ? r.paths : []));
  if (results.some((r) => r.kind === "conflict")) return { kind: "conflict", paths: [...new Set(paths)] };
  if (results.some((r) => r.kind === "clean")) return { kind: "clean" };
  return { kind: "indeterminate" };
}

/** True when a conflicted `path` falls under file key `key`: the path itself, a path under a
 *  directory key, or any file of a bare key's name. */
export function keyCoversPath(key: string, path: string): boolean {
  if (key.startsWith("*/")) return path === key.slice(2) || path.endsWith(`/${key.slice(2)}`);
  return path === key || path.startsWith(`${key}/`);
}

/** The repo-relative paths a landed change touched. */
const changedPaths = (git: Git, l: Landed) =>
  new Set(git(["diff", "--name-only", "--no-renames", l.base, l.merge]).out.split("\n").filter(Boolean));

/**
 * The campaign's in-campaign dependency closure: for a ticket, every scheduled ticket it is
 * transitively blocked by through other scheduled tickets, per native `blocked_by`.
 */
async function campaignBlockers(tickets: string[], blockedBy: (id: string) => Promise<string[]>): Promise<(id: string) => Set<string>> {
  const scheduled = new Set(tickets);
  const direct = new Map<string, string[]>();
  for (const id of scheduled)
    direct.set(
      id,
      (await blockedBy(id)).map(normalize).filter((b) => b !== id && scheduled.has(b)),
    );
  const closure = new Map<string, Set<string>>();
  const of = (id: string): Set<string> => {
    let seen = closure.get(id);
    if (seen) return seen;
    closure.set(id, (seen = new Set()));
    for (const b of direct.get(id) ?? []) for (const x of [b, ...of(b)]) seen.add(x);
    return seen;
  };
  return of;
}

/** Replay the project's campaigns and tally, per declared file key, how its shared pairs merged. */
export async function replayOverlap(opts: OverlapReplayOptions): Promise<OverlapReplay> {
  const { root, fileSet, tracker, branchPrefix = "agent/", tmpRoot = tmpdir() } = opts;
  const campaigns = readCampaigns(root);
  const merges = landedMerges(root, branchPrefix);
  const tallies = new Map<string, Omit<OverlapKeyTally, "rate">>();
  const tally = (key: string) => tallies.get(key) ?? tallies.set(key, { key, pairs: 0, clean: 0, collides: 0, indeterminate: 0 }).get(key)!;

  const staleCiteTickets = new Set<string>();
  const blockedByCache = new Map<string, Promise<string[]>>();
  const blockedBy = (id: string) => blockedByCache.get(id) ?? blockedByCache.set(id, tracker.blockedBy(id)).get(id)!;

  const clone = scratchClone(root, tmpRoot);
  try {
    for (const [i, c] of campaigns.entries()) {
      const lo = c.start - MINUTE;
      const hi = Math.min(campaigns[i + 1]?.start ?? Infinity, c.start + 4 * DAY);
      const landed = new Map<string, Landed>();
      for (const id of new Set(c.tickets)) {
        const inWindow = (merges.get(id) ?? []).filter((l) => l.at >= lo && l.at < hi).sort((x, y) => x.at - y.at);
        if (inWindow.length) landed.set(id, inWindow[0]);
      }
      const keys = new Map<string, Set<string>>();
      for (const id of landed.keys()) {
        const recorded = c.fileKeys?.[id];
        if (recorded) {
          keys.set(id, new Set(recorded));
          continue;
        }
        const { files, confident } = await fileSet(ticketProse(await tracker.issueText(id)));
        if (!confident) staleCiteTickets.add(id);
        keys.set(id, new Set(files));
      }
      let blockers: ((id: string) => Set<string>) | undefined;
      const ids = [...landed.keys()].sort();
      for (const [n, x] of ids.entries()) {
        for (const y of ids.slice(n + 1)) {
          const shared = [...keys.get(x)!].filter((k) => keys.get(y)!.has(k));
          // A dependent pair never shares a wave, whatever is waived: nothing to measure.
          if (!shared.length) continue;
          blockers ??= await campaignBlockers(c.tickets, blockedBy);
          if (blockers(x).has(y) || blockers(y).has(x)) continue;
          let [a, b] = [landed.get(x)!, landed.get(y)!];
          if (a.at > b.at) [a, b] = [b, a];
          const realOverlap = [...changedPaths(clone.git, a)].some((p) => changedPaths(clone.git, b).has(p));
          const verdict: PairVerdict = realOverlap ? classifyPair(clone.git, a, b) : { kind: "clean" };
          for (const key of shared) {
            const t = tally(key);
            t.pairs++;
            if (verdict.kind === "indeterminate") t.indeterminate++;
            else if (verdict.kind === "conflict" && verdict.paths.some((p) => keyCoversPath(key, p))) t.collides++;
            else t.clean++;
          }
        }
      }
    }
  } finally {
    rmSync(clone.dir, { recursive: true, force: true });
  }
  const keys = [...tallies.values()].map((t) => ({ ...t, rate: t.clean + t.collides ? t.collides / (t.clean + t.collides) : null }));
  return { keys: keys.sort((a, b) => a.key.localeCompare(b.key)), staleCiteTickets: [...staleCiteTickets].sort() };
}
