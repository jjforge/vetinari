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
