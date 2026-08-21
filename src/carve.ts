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

const normalize = (id: string) => id.replace(/^#/, "").trim();

/** id -> the ids that block it (its prerequisites). */
export type BlockedByOf = (id: string) => string[] | Promise<string[]>;

export interface CarveResult {
  target: string;
  /** target plus its transitive dependents, in campaign order. */
  removed: string[];
  /** the campaign with `removed` stripped and emptied waves dropped. */
  remaining: string[][];
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
  const blockers = new Map<string, Set<string>>();
  await Promise.all(
    [...campaign].map(async (id) => {
      const raw = await blockedByOf(id);
      blockers.set(id, new Set(raw.map(normalize).filter((b) => campaign.has(b))));
    }),
  );

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
