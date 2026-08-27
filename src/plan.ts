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
import { computeCarve, normalize, restrictBlockers, type BlockedByOf } from "./carve.ts";
import type { FileSet } from "./fileset.ts";

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

/** What to do about a ticket whose file-set came back `confident: false`. */
export type UnderspecifiedDecision = "drop" | "fail";

/**
 * Asked, when one or more selected tickets resolve to `confident: false`, whether
 * to drop them (and their dependents) and plan the rest, or fail so the requestor
 * can enrich the issues and re-run. Injected so the decision is exercised without
 * a TTY: the CLI builds a real one via `underspecifiedPromptFor`.
 */
export type UnderspecifiedPrompt = (underspecified: string[]) => UnderspecifiedDecision | Promise<UnderspecifiedDecision>;

/** The resolvers `planCampaign` reads the tracker and tree through. */
export interface CampaignPlanDeps {
  /** id -> its OPEN blockers (the same seam as `layerWaves`/`computeCarve`). */
  blockedBy: BlockedByOf;
  /**
   * id -> its resolved file-set. Compose the project's `fileSet` resolver with
   * `fetchTask` at the edge (`id => cfg.fileSet(await cfg.fetchTask(id))`) so this
   * stays pure over one injected function.
   */
  fileSet: (id: string) => FileSet | Promise<FileSet>;
  /** consulted when any scheduled ticket resolves to `confident: false`. */
  onUnderspecified: UnderspecifiedPrompt;
}

/** A `WavePlan` plus the record of any under-specified halt that shaped it. */
export interface CampaignPlan extends WavePlan {
  /** the not-confident tickets that triggered the halt (empty when none did). */
  underspecified: string[];
  /** everything the drop decision removed: the under-specified roots + dependents. */
  carved: string[];
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
 * The precomputed layering inputs a `graft` event carries, resolved by the CLI at
 * append time (ADR 0014) so the fold stays pure (ADR 0012): the added ids, each
 * added id's in-campaign open blockers, and — for every id the placement may share
 * a wave with (the added ids plus the campaign's still-unstarted members) — its
 * basenames. With these `applyGraft` runs the same dependency + file-disjoint
 * placement `campaign-plan` does, with no tracker or filesystem access.
 */
export interface GraftInputs {
  /** the grafted issue ids, in the order given. */
  ids: string[];
  /** grafted id -> its OPEN blockers that are inside this campaign. */
  blockedBy: Record<string, string[]>;
  /** id -> its basenames, for the grafted ids and the still-unstarted members the
   *  placement checks disjointness against. */
  basenames: Record<string, string[]>;
}

/** The result of folding a graft into a running campaign's plan: the extended
 * loop-facing waves, and the ids actually added (skipping any already present). */
export interface AppliedGraft {
  /** the waves with the grafted issues inserted into their placed later wave. */
  remaining: string[][];
  /** the ids that were added, in the order placed. */
  grafted: string[];
}

/**
 * Pure rule folding a graft into a running campaign — the additive mirror of
 * `applyCarve` (ADR 0014). The in-flight and banked waves are pinned; each grafted
 * issue is **stable-inserted** into the earliest *later* wave that satisfies its
 * in-campaign `blockedBy` deps and stays basename-disjoint, appending a new wave
 * only when none fits. Existing wave assignments are never reordered.
 *
 * `firstFree` is the first wave grafted work may enter: past the in-flight wave
 * (`currentWave`) and past every wave that already banked a `completed` member, so
 * a graft can only ever land in future waves. A grafted issue's `blockedBy` blocker
 * still in the plan pushes it after that blocker's wave; a blocker no longer in the
 * plan (already merged) sits behind `firstFree` and imposes no further constraint.
 *
 * Pure over the injected inputs (ADR 0012), so the fold is unit-testable without a
 * tracker or a running campaign. An id already in the plan is skipped (validation
 * lives at the CLI edge), never inserted twice.
 */
export function applyGraft(
  campaign: { waves: string[][]; outcomes: Map<string, string>; currentWave: number },
  graft: GraftInputs,
): AppliedGraft {
  const result = campaign.waves.map((wave) => wave.map(normalize));
  const inPlan = new Set(result.flat());
  const newIds = uniqueOrder(graft.ids).filter((id) => !inPlan.has(id));

  const waveOf = new Map<string, number>();
  result.forEach((wave, i) => wave.forEach((id) => waveOf.set(id, i)));

  // The earliest wave grafted work may enter: after the in-flight wave and after
  // every wave that already banked a merged issue.
  let lastPinned = campaign.currentWave;
  result.forEach((wave, i) => {
    if (wave.some((id) => campaign.outcomes.get(id) === "completed")) lastPinned = Math.max(lastPinned, i);
  });
  const firstFree = lastPinned + 1;

  const namesOf = (id: string) => new Set((graft.basenames[normalize(id)] ?? []).map(normalize));
  // The basenames already committed to each wave, grown as grafts land.
  const waveNames = result.map((wave) => {
    const names = new Set<string>();
    for (const id of wave) for (const n of namesOf(id)) names.add(n);
    return names;
  });

  const grafted: string[] = [];
  for (const id of newIds) {
    let earliest = firstFree;
    for (const b of (graft.blockedBy[id] ?? []).map(normalize)) {
      const bw = waveOf.get(b);
      if (bw !== undefined) earliest = Math.max(earliest, bw + 1);
    }
    const names = namesOf(id);
    let target = Math.max(earliest, 0);
    while (target < result.length && !disjoint(waveNames[target], names)) target++;
    while (result.length <= target) {
      result.push([]);
      waveNames.push(new Set());
    }
    result[target].push(id);
    for (const n of names) waveNames[target].add(n);
    waveOf.set(id, target);
    grafted.push(id);
  }

  return { remaining: result.filter((wave) => wave.length), grafted };
}

/**
 * The area labels a run's name is suggested from — the fixed set the tracker tags
 * issues with. This order is the order a suggestion lists them in, so the same set
 * of areas always yields the same name regardless of the input issue order.
 */
export const AREA_LABELS = ["orchestrator", "gateway", "comms", "dashboard", "layout", "launcher"] as const;

/** id -> the labels on it. Injected so the name suggestion is exercised without a
 * live tracker; the CLI builds a real one over `fetchTask`. */
export type LabelsOf = (id: string) => string[] | Promise<string[]>;

/**
 * Suggest a campaign `--name` from the distinct area labels the selected issues
 * span, in `AREA_LABELS` order and joined with " + " (e.g. "gateway + comms +
 * dashboard") — a paste-or-edit starting point, never stored. Labels outside the
 * area set are ignored; returns undefined when the set spans no area (nothing to
 * suggest). Pure over the injected resolver.
 */
export async function suggestCampaignName(ids: string[], labelsOf: LabelsOf): Promise<string | undefined> {
  const spanned = new Set<string>();
  await Promise.all(uniqueOrder(ids).map(async (id) => {
    for (const label of await labelsOf(id)) spanned.add(label);
  }));
  const areas = AREA_LABELS.filter((area) => spanned.has(area));
  return areas.length ? areas.join(" + ") : undefined;
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
 * against this set — tickets carved for an under-specified file-set as well as
 * tickets unreachable by dependency. Plans only — this describes the plan, it
 * does not run it.
 */
export function describePlan(plan: WavePlan & Partial<Pick<CampaignPlan, "carved" | "underspecified">>): string {
  const scheduled = plan.placements.length;
  const carved = plan.carved ?? [];
  const lines: string[] = [
    `campaign-plan: ${plan.waves.length} wave(s), ${scheduled} ticket(s) scheduled, ${plan.unreachable.length} unreachable` +
      (carved.length ? `, ${carved.length} carved` : "") +
      ".",
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

  if (carved.length) {
    const underspecified = new Set(plan.underspecified ?? []);
    lines.push("", "Carved (dropped — under-specified file-set):");
    for (const id of carved) {
      lines.push(`  #${id}  — ${underspecified.has(id) ? "no confident file-set" : "depends on a carved under-specified ticket"}`);
    }
  }

  return lines.join("\n");
}

/**
 * Plan a selected set end to end: layer it by dependency, resolve each scheduled
 * ticket's file-set, and — when any comes back `confident: false` — halt to the
 * requestor rather than guess. The injected `onUnderspecified` decides: `drop`
 * carves the under-specified tickets AND their transitive dependents (reusing
 * `computeCarve`) and plans the confident remainder; `fail` throws so the missing
 * data is fixed on the issue and the plan re-run. Nothing is ever planned around a
 * `confident: false` ticket silently.
 *
 * File-sets are resolved only for tickets that survive dependency layering — a
 * ticket already dropped as unreachable is not one we could run anyway, so there
 * is nothing to ask about it. Pure over the injected resolvers; the tree read and
 * the interactive prompt live at the edge.
 */
export async function planCampaign(ids: string[], deps: CampaignPlanDeps): Promise<CampaignPlan> {
  const layered = await layerWaves(ids, deps.blockedBy);
  const scheduled = layered.placements.map((p) => p.id);

  const sets = new Map<string, FileSet>();
  await Promise.all(scheduled.map(async (id) => sets.set(id, await deps.fileSet(id))));

  const underspecified = scheduled.filter((id) => !sets.get(id)!.confident);

  let survivorPlan = layered;
  let carved: string[] = [];
  if (underspecified.length) {
    const decision = await deps.onUnderspecified(underspecified);
    if (decision === "fail") {
      const list = underspecified.map((i) => `#${i}`).join(", ");
      const [subj, obj] = underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
      throw new Error(
        `campaign-plan: ${list} ${subj} no confident file-set. Add the file data to the issue(s) ` +
          `and re-run, or pass --on-underspecified=drop to carve ${obj} and plan the rest.`,
      );
    }
    // drop: carve each under-specified ticket and its dependent chain out of the
    // layered waves, threading the shrinking remainder forward. A ticket already
    // gone as another's dependent is skipped — `computeCarve` rejects an absent target.
    let remaining = layered.waves;
    const carvedSet = new Set<string>();
    for (const target of underspecified) {
      if (carvedSet.has(normalize(target))) continue;
      const res = await computeCarve(remaining, target, deps.blockedBy);
      for (const id of res.removed) carvedSet.add(id);
      remaining = res.remaining;
    }
    carved = scheduled.filter((id) => carvedSet.has(id));
    // Re-layer the confident survivors so the returned plan's placements/`after`
    // reflect the reduced set; carving dependents keeps the DAG intact.
    survivorPlan = await layerWaves(remaining.flat(), deps.blockedBy);
  }

  const basenames = new Map(survivorPlan.placements.map((p) => [p.id, new Set(sets.get(p.id)?.files ?? [])]));
  const partitioned = partitionWaves(survivorPlan, basenames);

  return {
    ...partitioned,
    // The unreachable list belongs to the original layering — re-layering the
    // survivors alone would forget the dependency drops from the first pass.
    unreachable: layered.unreachable,
    underspecified,
    carved,
  };
}

/**
 * Build the `onUnderspecified` prompt for a run. An explicit `--on-underspecified`
 * flag pre-decides (`drop`/`fail`) for non-interactive runs; with no flag, an
 * interactive terminal asks (`ask`) and a non-terminal defaults to `fail` — so
 * missing file-set data is never planned around silently. `ask` is injected so the
 * flag/terminal logic is tested without a real TTY.
 */
export function underspecifiedPromptFor(opts: { flag?: string; isTTY: boolean; ask: UnderspecifiedPrompt }): UnderspecifiedPrompt {
  if (opts.flag !== undefined) {
    if (opts.flag !== "drop" && opts.flag !== "fail") {
      throw new Error(`--on-underspecified must be "drop" or "fail" (got "${opts.flag}").`);
    }
    const decided = opts.flag;
    return () => decided;
  }
  if (opts.isTTY) return opts.ask;
  return () => "fail";
}
