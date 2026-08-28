/**
 * "Carve out" an issue and its dependent chain from a campaign.
 *
 * Removing an issue means removing everything that cannot proceed without it:
 * the transitive closure of its DEPENDENTS (issues blocked by it), across every
 * branch and diamond. An issue is dropped as soon as ANY of its blockers is
 * dropped — a second, still-present blocker does not rescue it.
 *
 * The graph is computed over the campaign's OWN issues only. A blocker that
 * lives outside the named campaign is out of scope (presumed already merged or
 * handled elsewhere), which keeps resolution bounded to the issues you named.
 *
 * Pure: the only outside knowledge is `blockedByOf`, injected so the GitHub call
 * lives at the edge and this stays trivially testable.
 */

import type { ResolvedConfig } from "./config.ts";
import type { HostBudget } from "./host-slots.ts";
import { campaignRunning, reduceCampaign } from "./dashboard-model.ts";
import { readEventLog } from "./event-log.ts";
import { clearParkedForTasks, enqueueOutbound } from "./state.ts";
// `campaign` is referenced by type only and lazy-imported in `defaultCarveDeps`
// (see below): a static value import would close the `modes → carve → modes`
// cycle at module-eval time and hit `modes`'s `defaultCampaignDeps` before its
// `currentBranch` const is initialized (a TDZ crash).
type Campaign = typeof import("./modes.ts").campaign;

export const normalize = (id: string) => id.replace(/^#/, "").trim();

/**
 * id -> the ids of its OPEN blockers (its prerequisites still in flight). Closed
 * blockers are filtered at the edge — an already-merged prerequisite does not
 * gate — so every id this returns names a blocker that is genuinely pending.
 */
export type BlockedByOf = (id: string) => string[] | Promise<string[]>;

/**
 * Each id's open blockers, split by whether they fall inside a selected set of
 * ids or outside it. This is the shared DAG step under both `carve` and
 * `campaign-plan`: the edges that matter to a run are the ones that stay inside
 * the set you named. `inSet` edges are the real graph; `external` names the
 * out-of-set blockers that make a dependent unreachable.
 *
 * Pure: `blockedByOf` is injected so the tracker call lives at the edge.
 */
export interface RestrictedBlockers {
  /** id -> its open blockers that are inside the selected set (real edges). */
  inSet: Map<string, Set<string>>;
  /** id -> its open blockers that fall outside the set (unreachability roots). */
  external: Map<string, Set<string>>;
}

export async function restrictBlockers(ids: string[], blockedByOf: BlockedByOf): Promise<RestrictedBlockers> {
  const set = new Set(ids.map(normalize));
  const inSet = new Map<string, Set<string>>();
  const external = new Map<string, Set<string>>();
  await Promise.all(
    [...set].map(async (id) => {
      const raw = (await blockedByOf(id)).map(normalize);
      inSet.set(id, new Set(raw.filter((b) => set.has(b))));
      external.set(id, new Set(raw.filter((b) => !set.has(b))));
    }),
  );
  return { inSet, external };
}

export interface CarveResult {
  target: string;
  /** target plus its transitive dependents, in campaign order. */
  removed: string[];
  /** the campaign with `removed` stripped and emptied waves dropped. */
  remaining: string[][];
}

/**
 * What actually happens to `computeCarve`'s closure once it meets the running
 * campaign's current outcomes. Carve **prunes the unfinished remainder without
 * discarding banked work** (ADR 0005): a merged/green member is kept (already
 * banked or allowed to merge), and only the parked or not-yet-started members
 * leave the plan. A merged/green *target* is kept too, but its unfinished
 * dependents are still dropped — carve is a human's forward-looking "remove
 * this subtree" decision, evaluated per member.
 */
export interface AppliedCarve {
  /** the waves with `dropped` stripped and emptied waves removed. */
  remaining: string[][];
  /** the closure members that actually leave the plan (parked or unstarted). */
  dropped: string[];
  /** parked members whose record to clear — empty unless `purge` was set (ADR 0013). */
  parkedToClear: string[];
}

/**
 * Pure rule applying a carve to a running campaign. `outcomes` is a member's
 * current status (as `reduceCampaign` reconstructs it); a member with no entry
 * is treated as not-yet-started. Only `parked`/`unstarted` members are dropped —
 * `completed` (merged or green) stays, and anything in-flight (`running`) or
 * failed is left for the wave it is in to resolve.
 *
 * A dropped parked member leaves the plan either way, but its parked record is
 * kept by default so its branch/worktree/session stay resumable (ADR 0013);
 * `purge` is the rare true-drop that flags the record for clearing.
 */
export function applyCarve(
  campaign: { waves: string[][]; outcomes: Map<string, string> },
  removed: string[],
  opts: { purge?: boolean } = {},
): AppliedCarve {
  const dropped: string[] = [];
  const parkedToClear: string[] = [];
  for (const id of removed.map(normalize)) {
    const status = campaign.outcomes.get(id) ?? "unstarted";
    if (status === "unstarted" || status === "parked") {
      dropped.push(id);
      if (status === "parked" && opts.purge) parkedToClear.push(id);
    }
  }
  const drop = new Set(dropped);
  const remaining = campaign.waves
    .map((wave) => wave.map(normalize).filter((id) => !drop.has(id)))
    .filter((wave) => wave.length);
  return { remaining, dropped, parkedToClear };
}

/**
 * A carve dry-run's closure in structured form: the target, the dependent issues
 * that would be dropped, the banked (merged/mergeable) work kept, and the waves
 * that remain. Lets a consumer name the exact closure without re-parsing the
 * CLI's human text.
 */
export interface StructuredCarveClosure {
  /** the carved issue itself. */
  target: string;
  /** the closure members that leave the plan (parked or unstarted). */
  dropped: string[];
  /** the closure members kept because they are already merged or mergeable. */
  keptBanked: string[];
  /** the waves with `dropped` stripped and emptied waves removed. */
  remaining: string[][];
}

/**
 * Assemble the structured closure from `computeCarve`'s `removed` closure and the
 * `applyCarve` result it was run through: kept-banked is the closure minus what
 * was dropped, in campaign order. Pure so the CLI's structured dry-run output is
 * unit-tested at the seam rather than by re-parsing its own prose.
 */
export function carveClosure(target: string, removed: string[], applied: AppliedCarve): StructuredCarveClosure {
  const dropped = new Set(applied.dropped);
  return {
    target: normalize(target),
    dropped: applied.dropped,
    keptBanked: removed.map(normalize).filter((id) => !dropped.has(id)),
    remaining: applied.remaining,
  };
}

/**
 * What a single quarantined issue strands in the remaining campaign (ADR 0013). A
 * merge conflict quarantines one issue mid-wave; its transitive dependents in the
 * unstarted later waves cannot proceed without it. Each impact reuses `computeCarve`
 * (the same graph `carve` walks) for the closure, then `applyCarve` to name the
 * members a carve would actually drop now — the orphaned dependents (`dropped`). A
 * quarantined issue that drops nothing orphans nothing; the campaign need not stop.
 *
 * Pure over the injected `blockedByOf`, so the campaign's pause-vs-`--auto-carve`
 * decision is testable without a tracker or a running campaign. A quarantined id no
 * longer in the plan (an earlier carve already took it) is skipped, not an error.
 */
export interface QuarantineImpact {
  /** the quarantined issue. */
  target: string;
  /** its transitive dependent closure over the plan (the target plus its dependents). */
  removed: string[];
  /** the closure members a carve would drop now — the orphaned dependents. */
  dropped: string[];
}

/**
 * Where `campaign --resume` picks up: the index of the first wave that still has
 * unrun work, given a reconstructed plan (ADR 0013). Resume continues a paused
 * campaign on the fixed base, so it must skip every wave that already banked work —
 * a closed wave merged its whole batch, a wave-park left its greens merged on the
 * base — and never redo a merged issue. The resume point is therefore one past the
 * last wave holding a `completed` member: a plan with no merged work resumes from
 * the top, and an index at or past `waves.length` means nothing is left to run.
 *
 * Pure over the reduced plan (`waves` + `outcomes`, exactly the shape `applyCarve`
 * takes), so the resume boundary is unit-testable without a running campaign — the
 * same reconstruction `carve` reuses (ADR 0005).
 */
export function resumeIndex(campaign: { waves: string[][]; outcomes: Map<string, string> }): number {
  let lastRun = -1;
  campaign.waves.forEach((wave, i) => {
    if (wave.some((id) => campaign.outcomes.get(normalize(id)) === "completed")) lastRun = i;
  });
  return lastRun + 1;
}

export async function quarantineImpacts(
  campaign: { waves: string[][]; outcomes: Map<string, string> },
  quarantined: string[],
  blockedByOf: BlockedByOf,
): Promise<QuarantineImpact[]> {
  const inPlan = new Set(campaign.waves.flat().map(normalize));
  const impacts: QuarantineImpact[] = [];
  for (const target of quarantined.map(normalize)) {
    if (!inPlan.has(target)) continue;
    const { removed } = await computeCarve(campaign.waves, target, blockedByOf);
    const { dropped } = applyCarve(campaign, removed);
    impacts.push({ target, removed, dropped: dropped.filter((id) => id !== target) });
  }
  return impacts;
}

/**
 * The impure module edges `runCarve` leans on, injected so the running-campaign
 * prune orchestration is drivable with stubs (mirroring `defaultGraftDeps` in
 * `graft.ts` and `defaultCampaignDeps` in `modes.ts`). The tracker edge —
 * `blockedBy` — stays on `cfg`, exactly as `runGraft` reads it off `cfg`. These
 * are the functions that touch the on-disk event log and outbox, clear a parked
 * record, and launch the fresh reduced campaign.
 */
export interface CarveDeps {
  readEventLog: typeof readEventLog;
  enqueueOutbound: typeof enqueueOutbound;
  clearParkedForTasks: typeof clearParkedForTasks;
  /** the fresh-launch path's campaign runner (`carve <issue> "611 640" …`). */
  launchCampaign: Campaign;
}
export const defaultCarveDeps: CarveDeps = {
  readEventLog,
  enqueueOutbound,
  clearParkedForTasks,
  // Lazy-import to keep `modes` out of the static graph — see the `Campaign` note.
  launchCampaign: (cfg, batches, host, name, opts) =>
    import("./modes.ts").then((m) => m.campaign(cfg, batches, host, name, opts)),
};

export interface CarveOptions {
  /** preview the carve but change nothing — no event, no enqueue, no launch. */
  dryRun?: boolean;
  /** the rare true-drop: clear a dropped parked member's record too (ADR 0013). */
  purge?: boolean;
  /** explicit waves supplied on the CLI → launch a fresh reduced campaign instead
   *  of pruning the running one. Absent/empty → prune the running campaign. */
  plan?: string[][];
  /** host budget threaded to the fresh-launch path's `campaign()`. */
  host?: HostBudget;
}

/** Pruning the running campaign: the closure met the current outcomes (ADR 0005). */
export interface PruneCarveResult {
  mode: "prune";
  /** the carved issue. */
  target: string;
  /** the target plus its transitive dependents, in campaign order. */
  removed: string[];
  /** the closure members that actually leave the plan (parked or unstarted). */
  dropped: string[];
  /** the closure members kept because they are already merged or mergeable. */
  kept: string[];
  /** the resulting loop-facing waves after the carve. */
  remaining: string[][];
  /** the dropped members that were parked (the ones the parked-message describes). */
  parkedDropped: string[];
  /** whether `--purge` was set — the parked-message is worded off it. */
  purge: boolean;
  /** false for a `--dry-run` (previewed, nothing written); true once appended. */
  applied: boolean;
  /** the structured dry-run closure — present only on a `--dry-run`. */
  closure?: StructuredCarveClosure;
}

/** Launching a fresh reduced campaign from an explicit plan (unchanged behavior). */
export interface LaunchCarveResult {
  mode: "launch";
  /** the carved issue. */
  target: string;
  /** the target plus its transitive dependents, in plan order. */
  removed: string[];
  /** the reduced plan the campaign runs (empty when nothing survives). */
  remaining: string[][];
  /** true once the reduced campaign was actually launched (false on dry-run or empty). */
  launched: boolean;
}

export type RunCarveResult = PruneCarveResult | LaunchCarveResult;

/**
 * The impure orchestration around `carve`, lifted out of `cli.mts`'s inline switch
 * so it is drivable with stubs (the direct mirror of `runGraft`, #176). Two paths:
 *
 * - No `plan` → **prune the running campaign**: read the event log, guard that one
 *   is open, reduce it to its current plan, compute the dependent closure, apply the
 *   keep-banked-work rule (ADR 0005), clear any purged parked records (ADR 0013),
 *   append a `carve` event the loop honors at its next wave boundary, and enqueue a
 *   `progress:carve` note.
 * - A `plan` → **launch a fresh reduced campaign**: compute the closure over the
 *   supplied waves, enqueue a `progress:carve` note, and run `campaign()` on the
 *   remainder.
 *
 * Returns a structured result so the CLI renders the console output and a test
 * asserts the observable effects without re-parsing prose. The pure
 * `computeCarve`/`applyCarve`/`carveClosure` core is untouched.
 */
export async function runCarve(
  cfg: ResolvedConfig,
  target: string,
  opts: CarveOptions = {},
  deps: CarveDeps = defaultCarveDeps,
): Promise<RunCarveResult> {
  if (!target)
    throw new Error(
      'carve needs an issue: `carve 640` prunes the running campaign, `carve 640 "611 640" "623 701"` launches a reduced one.',
    );
  if (!cfg.blockedBy)
    throw new Error(
      'carve needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").',
    );
  const blockedBy = cfg.blockedBy;
  const tgt = normalize(target);

  // Explicit plan → launch a fresh reduced campaign (unchanged behavior).
  if (opts.plan) {
    const { removed, remaining } = await computeCarve(opts.plan, target, blockedBy);
    if (opts.dryRun) return { mode: "launch", target: tgt, removed, remaining, launched: false };

    // A carve had no notification before E4 — emit a progress:carve record so it
    // is announced and routable like any other outbound message (ADR 0002).
    deps.enqueueOutbound(cfg, {
      category: "progress",
      event: "carve",
      text: carveLaunchNote(cfg.project, tgt, removed, remaining),
    });
    if (!remaining.length) return { mode: "launch", target: tgt, removed, remaining, launched: false };
    await deps.launchCampaign(cfg, remaining, opts.host!);
    return { mode: "launch", target: tgt, removed, remaining, launched: true };
  }

  // No plan → prune the RUNNING campaign: reduce the log to its current plan,
  // compute the closure, apply the keep-banked-work rule, then append a carve
  // event the loop honors at its next wave boundary (ADR 0005).
  const events = deps.readEventLog(cfg);
  if (!campaignRunning(events))
    throw new Error(
      "carve <issue> prunes a running campaign, but none is running. To launch a reduced campaign from a plan you supply, pass the waves: " +
        'carve <issue> "611 640" "623 701".',
    );
  const reduced = reduceCampaign(events);
  const { removed } = await computeCarve(reduced.waves, target, blockedBy);
  const applied = applyCarve(reduced, removed, { purge: opts.purge });
  const { remaining, dropped, parkedToClear } = applied;
  const kept = removed.filter((id) => !dropped.includes(id));
  const parkedDropped = dropped.filter((id) => reduced.outcomes.get(id) === "parked");

  if (opts.dryRun) {
    return {
      mode: "prune",
      target: tgt,
      removed,
      dropped,
      kept,
      remaining,
      parkedDropped,
      purge: !!opts.purge,
      applied: false,
      closure: carveClosure(target, removed, applied),
    };
  }

  // Preserve carved work by default: the dropped issue leaves the plan but its
  // parked record (branch/worktree/session) stays so it can be investigated and
  // resumed (ADR 0013). Only `--purge` clears it — the rare true-drop — and
  // `applyCarve` reflects that in `parkedToClear`.
  if (parkedToClear.length) deps.clearParkedForTasks(cfg, parkedToClear);
  // Append the carve event — the running loop re-reads it at the next wave
  // boundary; `removed` is the closure so the fold replays the same rule.
  cfg.log.log("carve", { target: tgt, removed, dropped });
  deps.enqueueOutbound(cfg, {
    category: "progress",
    event: "carve",
    text: carvePruneNote(cfg.project, tgt, dropped, kept, remaining),
  });
  return {
    mode: "prune",
    target: tgt,
    removed,
    dropped,
    kept,
    remaining,
    parkedDropped,
    purge: !!opts.purge,
    applied: true,
  };
}

const renderWaves = (waves: string[][], empty: string) =>
  waves.length ? waves.map((w) => `"${w.join(" ")}"`).join(" ") : empty;

/** The `progress:carve` note for the running-campaign prune path. */
function carvePruneNote(
  project: string,
  tgt: string,
  dropped: string[],
  kept: string[],
  remaining: string[][],
): string {
  return (
    `✂️ ${project} carved #${tgt} from the running campaign — ` +
    (dropped.length ? `dropped ${dropped.map((i) => `#${i}`).join(", ")}` : "nothing to drop") +
    (kept.length ? ` (kept banked ${kept.map((i) => `#${i}`).join(", ")})` : "") +
    `. Remaining: ${renderWaves(remaining, "nothing left to run")}.`
  );
}

/** The `progress:carve` note for the fresh-launch path. */
function carveLaunchNote(project: string, tgt: string, removed: string[], remaining: string[][]): string {
  const dependents = removed.filter((id) => id !== tgt);
  return (
    `✂️ ${project} carved #${tgt} — dropped ${removed.map((i) => `#${i}`).join(", ")}` +
    (dependents.length ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})` : "") +
    `. Remaining: ${renderWaves(remaining, "nothing left to run")}.`
  );
}

export async function computeCarve(waves: string[][], target: string, blockedByOf: BlockedByOf): Promise<CarveResult> {
  const normWaves = waves.map((wave) => wave.map(normalize));
  const order = normWaves.flat();
  const campaign = new Set(order);
  const tgt = normalize(target);

  if (!campaign.has(tgt)) {
    throw new Error(`carve target #${tgt} is not in the campaign (${[...campaign].map((i) => `#${i}`).join(", ")}).`);
  }

  // Each issue's blockers, restricted to the campaign — edges to issues we are
  // not running here are irrelevant to what this campaign can and cannot do.
  const { inSet: blockers } = await restrictBlockers([...campaign], blockedByOf);

  // Fixpoint: drop the target, then anything with a dropped blocker, until stable.
  const removed = new Set<string>([tgt]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of campaign) {
      if (removed.has(id)) continue;
      for (const b of blockers.get(id)!) {
        if (removed.has(b)) {
          removed.add(id);
          changed = true;
          break;
        }
      }
    }
  }

  return {
    target: tgt,
    removed: order.filter((id) => removed.has(id)),
    remaining: normWaves.map((wave) => wave.filter((id) => !removed.has(id))).filter((wave) => wave.length),
  };
}
