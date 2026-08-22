/**
 * `campaign-plan`: turn a selected set of ticket ids into dependency-ordered
 * wave arguments (ready to paste after `campaign`) plus a provenance report.
 *
 * Waves come from the `blockedBy` graph restricted to the selected set (the
 * shared `restrictBlockers` foundation `carve` also uses): wave 0 is the tickets
 * with no OPEN in-set blocker, and a ticket enters wave W once all its blockers
 * sit in earlier waves. A closed blocker never reaches the resolver, so it does
 * not gate. An OPEN blocker outside the selected set makes its dependent
 * unreachable — it is reported and dropped (along with everything that in turn
 * depends on it), never scheduled silently.
 *
 * This plans only: it computes waves, it never runs `campaign` and never pushes.
 * Pure over the injected `blockedByOf`, so it stays testable with no live tracker.
 */
import { normalize, restrictBlockers, type BlockedByOf } from "./carve.ts";

export interface Placement {
  id: string;
  /** the wave this ticket lands in (0-based). */
  wave: number;
  /** its in-set open blockers — all in earlier waves; empty in wave 0. */
  after: string[];
  /**
   * the earlier tickets in this ticket's dependency layer it shares a file with
   * — the crossover that spilled it into a later sub-wave. Empty (or absent
   * before `partitionWaves`) when no file collision moved it.
   */
  sharesFilesWith?: string[];
}

export interface UnreachableTicket {
  id: string;
  /** open blockers outside the selected set — the direct cause, if any. */
  external: string[];
  /** in-set blockers that were themselves dropped — the transitive cause, if any. */
  via: string[];
}

export interface WavePlan {
  /** dependency-ordered waves of ids (normalized, no leading #). */
  waves: string[][];
  /** one entry per scheduled ticket, in wave-then-input order. */
  placements: Placement[];
  /** tickets dropped because they cannot run against this set. */
  unreachable: UnreachableTicket[];
}

/** Dedup while preserving first-seen order. */
const uniqueOrder = (ids: string[]) => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const raw of ids) {
    const id = normalize(raw);
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order;
};

export async function layerWaves(ids: string[], blockedByOf: BlockedByOf): Promise<WavePlan> {
  const order = uniqueOrder(ids);
  const { inSet, external } = await restrictBlockers(order, blockedByOf);

  // Unreachable closure. Seed with any ticket held by an open blocker outside the
  // set, then drop anything whose in-set blocker was itself dropped, to a fixpoint
  // — the same dependent-chain logic as carve: a ticket cannot run until every
  // prerequisite can, so an unreachable prerequisite takes its dependents with it.
  const dropped = new Set<string>();
  for (const id of order) if (external.get(id)!.size) dropped.add(id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of order) {
      if (dropped.has(id)) continue;
      for (const b of inSet.get(id)!) {
        if (dropped.has(b)) {
          dropped.add(id);
          changed = true;
          break;
        }
      }
    }
  }

  // Layer the survivors: a ticket enters a wave once all its in-set blockers have
  // been placed in earlier waves. Survivors' in-set blockers are all survivors
  // too (the closure above guaranteed it), so this always makes progress.
  const survivors = order.filter((id) => !dropped.has(id));
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  let remaining = survivors;
  while (remaining.length) {
    const layer = remaining.filter((id) => [...inSet.get(id)!].every((b) => waveOf.has(b)));
    if (!layer.length) {
      throw new Error(`campaign-plan: blockedBy cycle among ${remaining.map((i) => `#${i}`).join(", ")}.`);
    }
    for (const id of layer) waveOf.set(id, waves.length);
    waves.push(layer);
    remaining = remaining.filter((id) => !waveOf.has(id));
  }

  const placements: Placement[] = survivors
    .map((id) => ({ id, wave: waveOf.get(id)!, after: [...inSet.get(id)!] }))
    .sort((a, b) => a.wave - b.wave || order.indexOf(a.id) - order.indexOf(b.id));
  const unreachable: UnreachableTicket[] = order
    .filter((id) => dropped.has(id))
    .map((id) => ({
      id,
      external: [...external.get(id)!],
      via: [...inSet.get(id)!].filter((b) => dropped.has(b)),
    }));

  return { waves, placements, unreachable };
}

const disjoint = (a: Set<string>, b: Set<string>) => {
  for (const x of b) if (a.has(x)) return false;
  return true;
};

/**
 * Split each dependency layer of a `layerWaves` plan into basename-disjoint
 * sub-waves, so no two tickets in a wave touch the same file (user story 5).
 * Cross-layer pairs are already serialized by the DAG, so crossover only has to
 * be resolved *within* a layer.
 *
 * Greedy first-fit: walk the layer in order and drop each ticket into the
 * earliest sub-wave that shares none of its basenames; if every existing sub-wave
 * collides, it spills into a new one. Spilling can add a wave or two — the
 * intended trade for a wave that never collides at integration. Collisions are
 * judged by basename (`basenamesOf`), never by cited path.
 *
 * A ticket with no known basenames (empty set) collides with nothing and stays on
 * the frontier of its layer. The DAG ordering is preserved: a ticket's blockers
 * sit in strictly earlier layers, hence in strictly earlier sub-waves.
 */
export function partitionWaves(plan: WavePlan, basenamesOf: Map<string, Set<string>>): WavePlan {
  const namesOf = (id: string) => basenamesOf.get(id) ?? new Set<string>();
  const afterOf = new Map(plan.placements.map((p) => [p.id, p.after]));

  const waves: string[][] = [];
  const placements: Placement[] = [];
  for (const layer of plan.waves) {
    const subWaves: { ids: string[]; names: Set<string> }[] = [];
    for (const id of layer) {
      const names = namesOf(id);

      let idx = subWaves.findIndex((sw) => disjoint(sw.names, names));
      if (idx === -1) {
        idx = subWaves.push({ ids: [], names: new Set() }) - 1;
      }
      const slot = subWaves[idx];
      slot.ids.push(id);
      for (const n of names) slot.names.add(n);

      // Why it landed here and not earlier: the already-placed tickets in strictly
      // earlier sub-waves it shares a file with. Empty when it stayed on the
      // frontier — greedy first-fit means every earlier sub-wave holds a collider.
      const sharesFilesWith = subWaves.slice(0, idx).flatMap((sw) => sw.ids).filter((prior) => !disjoint(namesOf(prior), names));

      placements.push({ id, wave: waves.length + idx, after: afterOf.get(id) ?? [], sharesFilesWith });
    }
    for (const sw of subWaves) waves.push(sw.ids);
  }

  return { waves, placements, unreachable: plan.unreachable };
}

/**
 * The bare quoted wave arguments, ready to paste straight after `campaign`:
 * one quoted, space-joined group per wave (e.g. `"611 623" "640" "701"`).
 * Empty when nothing is schedulable.
 */
export function waveArgs(plan: WavePlan): string {
  return plan.waves.map((wave) => `"${wave.join(" ")}"`).join(" ");
}

/**
 * A human-readable provenance report: each scheduled ticket with its wave and
 * why it is there, then every dropped ticket with the reason it cannot run
 * against this set. Plans only — this describes the plan, it does not run it.
 */
export function describePlan(plan: WavePlan): string {
  const scheduled = plan.placements.length;
  const lines: string[] = [
    `campaign-plan: ${plan.waves.length} wave(s), ${scheduled} ticket(s) scheduled, ${plan.unreachable.length} unreachable.`,
    "",
  ];

  for (const p of plan.placements) {
    const reasons = [p.after.length ? `after ${p.after.map((b) => `#${b}`).join(", ")}` : "no open blocker in the selected set"];
    if (p.sharesFilesWith?.length) {
      reasons.push(`spilled — shares a file with ${p.sharesFilesWith.map((b) => `#${b}`).join(", ")}`);
    }
    lines.push(`  wave ${p.wave}  #${p.id}  — ${reasons.join("; ")}`);
  }

  if (plan.unreachable.length) {
    lines.push("", "Unreachable (dropped — cannot run against this set):");
    for (const u of plan.unreachable) {
      const reason = u.external.length
        ? `open blocker ${u.external.map((b) => `#${b}`).join(", ")} is outside the selected set`
        : `depends on dropped ${u.via.map((b) => `#${b}`).join(", ")}`;
      lines.push(`  #${u.id}  — ${reason}`);
    }
  }

  return lines.join("\n");
}
