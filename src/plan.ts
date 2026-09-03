/**
 * The campaign planner: turn a selected set of ticket ids into dependency-ordered
 * waves plus a provenance report. `campaign` runs the planner then executes the
 * waves; `campaign --dry-run` stops after and prints the plan.
 *
 * Waves come from the `blockedBy` graph restricted to the selected set (the
 * shared `restrictBlockers` foundation `prune` also uses): wave 0 is the tickets
 * with no OPEN in-set blocker, and a ticket enters wave W once all its blockers
 * sit in earlier waves. A closed blocker never reaches the resolver, so it does
 * not gate. An OPEN blocker outside the selected set makes its dependent
 * unreachable — it is reported and dropped (along with everything that in turn
 * depends on it), never scheduled silently.
 *
 * This plans only: it computes waves, it never runs `campaign` and never pushes.
 * Pure over the injected `blockedByOf`, so it stays testable with no live tracker.
 */
import { computePrune, restrictBlockers, type BlockedByOf } from "./prune.ts";
import { isIssueToken, normalize } from "./issue-id.ts";
import { defaultFileSet, ticketProse, type FileSet, type FileSetOf } from "./fileset.ts";

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

/**
 * An issue a resolver dropped at the tracker edge before it reached the plan — an
 * `Epic` (owns no work) or a `pending-verify` issue/blocker (merged, awaiting close),
 * design §4 steps 1–2. Carried as data on the plan so `describePlan` names it in the
 * provenance rather than the drop surfacing only as a stderr edge log.
 */
export interface Exclusion {
  /** the excluded issue's number (normalized, no leading #). */
  id: string;
  /** why it was excluded — the human phrase the provenance shows. */
  reason: string;
}

export interface WavePlan {
  /** dependency-ordered waves of ids (normalized, no leading #). */
  waves: string[][];
  /** one entry per scheduled ticket, in wave-then-input order. */
  placements: Placement[];
  /** tickets dropped because they cannot run against this set. */
  unreachable: UnreachableTicket[];
  /** issues a resolver dropped at the edge (epic / pending-verify), design §4. */
  excluded: Exclusion[];
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

/** Whether a positional token is an issue id (all digits, optional leading `#`)
 * rather than a label. A campaign token that is not an id is treated as a label. */
export const isIssueId = (token: string): boolean => /^#?\d+$/.test(token);

/**
 * Expand a campaign's positional tokens into a flat, de-duplicated id set: a numeric
 * token is an issue id (kept, `#` stripped); a non-numeric token is a **label**,
 * expanded to the open issues carrying it *that are work* via the `listByLabel` seam
 * — an issue typed `Epic` owns no work, and a `pending-verify` issue is merged work
 * awaiting close, so `listByLabel` drops both and never schedules them (design §4
 * step 1). Each such drop is reported to the optional `onExcluded` sink — the resolver
 * knows why (epic / pending-verify), so it names it there as data the planner threads
 * into the plan's provenance rather than the issue vanishing silently. The readiness
 * axis is label-expansion only: an explicitly named id is passed straight through, so an
 * operator who names such an id keeps it. Tokens may be mixed; the result is normalized
 * and de-duplicated in first-seen order, so it feeds straight into the planner (or into
 * an `--override` wave).
 *
 * A label token with no `listByLabel` resolver configured fails fast, naming the
 * missing seam — a campaign cannot select by label without wiring the tracker in.
 * Pure over the injected resolver; the CLI passes `cfg.listByLabel`.
 */
export async function expandSelection(
  tokens: string[],
  listByLabel?: (
    label: string,
    onExcluded?: (e: Exclusion) => void,
  ) => string[] | Promise<string[]>,
  onExcluded?: (e: Exclusion) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const token of tokens) {
    if (isIssueId(token)) {
      ids.push(token);
      continue;
    }
    if (!listByLabel)
      throw new Error(
        `campaign: "${token}" is a label, but no "listByLabel" resolver is configured — ` +
          `add e.g. listByLabel: githubIssuesByLabel("owner/repo") to your config to select issues by label.`,
      );
    ids.push(...(await listByLabel(token, onExcluded)));
  }
  return uniqueOrder(ids);
}

/**
 * A `blockedBy` resolver that also reports the blockers it drops at the edge (a
 * `pending-verify` prerequisite treated as satisfied, §4 step 2) to an optional sink.
 * `githubBlockedBy` implements this; a plain `BlockedByOf` that ignores the second
 * argument is assignable to it, so the wrap below is a no-op for resolvers that never
 * exclude anything.
 */
type ExcludingBlockedBy = (
  id: string,
  onExcluded?: (e: Exclusion) => void,
) => string[] | Promise<string[]>;

export async function layerWaves(ids: string[], blockedByOf: BlockedByOf): Promise<WavePlan> {
  const order = uniqueOrder(ids);
  // Collect the edge exclusions the resolver reports while restricting — a
  // pending-verify blocker is dropped inside the resolver, so the only way it reaches
  // the provenance is the resolver naming it here (§4 step 2). Wrapping keeps
  // `restrictBlockers` (shared with `prune`) untouched: it still calls a one-arg fn.
  const excluded: Exclusion[] = [];
  const collecting: BlockedByOf = (id) =>
    (blockedByOf as ExcludingBlockedBy)(id, (e) => excluded.push(e));
  const { inSet, external } = await restrictBlockers(order, collecting);

  // Unreachable closure. Seed with any ticket held by an open blocker outside the
  // set, then drop anything whose in-set blocker was itself dropped, to a fixpoint
  // — the same dependent-chain logic as prune: a ticket cannot run until every
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
      throw new Error(`campaign: blockedBy cycle among ${remaining.map((i) => `#${i}`).join(", ")}.`);
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

  return { waves, placements, unreachable, excluded };
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
  /** id -> its OPEN blockers (the same seam as `layerWaves`/`computePrune`). */
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
  pruned: string[];
  /**
   * true when the selection resolved to one issue and the file-set disjointness check
   * was skipped as vacuous — there is no co-wave to collide with, so nothing was
   * resolved, pruned, or prompted (§356). A *skipped* check, never a dropped ticket.
   */
  filesetCheckSkipped?: boolean;
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

  return { waves, placements, unreachable: plan.unreachable, excluded: plan.excluded };
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
 * `applyPrune` (ADR 0014). The in-flight and banked waves are pinned; each grafted
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
    // `earliest` is at least `firstFree` (>= 0), so it never indexes a pinned wave.
    let target = earliest;
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

/** Why a candidate graft id was rejected: it does not look like an issue id at all
 * (`malformed`, decided from the input before any tracker fetch), it names no open
 * issue (`unknown` / `closed`), or it is already part of this campaign
 * (`already-in-campaign`). */
export interface GraftRejection {
  id: string;
  reason: "malformed" | "unknown" | "closed" | "already-in-campaign";
}

/**
 * Validate a graft's candidate ids all-or-nothing (ADR 0014): return every id that
 * cannot be grafted — unknown or closed by the injected `state` resolver, or already
 * in the campaign (`inCampaign`, its remaining ∪ completed members) — in input order,
 * so the CLI can reject the whole graft naming the offenders rather than half-apply.
 * An empty result means every id is a new, open issue. Pure over the injected inputs;
 * the CLI builds `state` from `fetchTask` + `issueStateFromTask` at the edge.
 */
export function validateGraftTargets(
  ids: string[],
  opts: { inCampaign: Set<string>; state: (id: string) => "open" | "closed" | "unknown" },
): GraftRejection[] {
  const inCampaign = new Set([...opts.inCampaign].map(normalize));
  const rejections: GraftRejection[] = [];
  for (const raw of ids) {
    const id = normalize(raw);
    // A token that does not look like an issue id is decided malformed from the input
    // alone — the pure verdict every rejection should carry, so `state` (which lies
    // "unknown" on a garbage token that names a real issue elsewhere) is never asked.
    if (!isIssueToken(id)) {
      rejections.push({ id, reason: "malformed" });
      continue;
    }
    if (inCampaign.has(id)) {
      rejections.push({ id, reason: "already-in-campaign" });
      continue;
    }
    const state = opts.state(id);
    if (state !== "open") rejections.push({ id, reason: state });
  }
  return rejections;
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
 * against this set — tickets pruned for an under-specified file-set as well as
 * tickets unreachable by dependency. Plans only — this describes the plan, it
 * does not run it.
 */
export function describePlan(plan: WavePlan & Partial<Pick<CampaignPlan, "pruned" | "underspecified" | "filesetCheckSkipped">>): string {
  const scheduled = plan.placements.length;
  const pruned = plan.pruned ?? [];
  const lines: string[] = [
    `campaign: ${plan.waves.length} wave(s), ${scheduled} ticket(s) scheduled, ${plan.unreachable.length} unreachable` +
      (pruned.length ? `, ${pruned.length} pruned` : "") +
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

  if (plan.filesetCheckSkipped) {
    // A note, not a section: the file-disjointness check was *skipped* as vacuous for a
    // one-issue selection (no co-wave to collide with), never a ticket that was dropped.
    lines.push("", "Skipped the file-set check — a one-issue selection has no co-wave to collide with.");
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

  if (pruned.length) {
    const underspecified = new Set(plan.underspecified ?? []);
    lines.push("", "Pruned (dropped — under-specified file-set):");
    for (const id of pruned) {
      lines.push(`  #${id}  — ${underspecified.has(id) ? "no confident file-set" : "depends on a pruned under-specified ticket"}`);
    }
  }

  if (plan.excluded?.length) {
    lines.push("", "Excluded (dropped at the tracker edge — not work for this campaign):");
    for (const e of plan.excluded) {
      lines.push(`  #${e.id}  — ${e.reason}`);
    }
  }

  return lines.join("\n");
}

/**
 * Plan a selected set end to end: layer it by dependency, resolve each scheduled
 * ticket's file-set, and — when any comes back `confident: false` — halt to the
 * requestor rather than guess. The injected `onUnderspecified` decides: `drop`
 * prunes the under-specified tickets AND their transitive dependents (reusing
 * `computePrune`) and plans the confident remainder; `fail` throws so the missing
 * data is fixed on the issue and the plan re-run. Nothing is ever planned around a
 * `confident: false` ticket silently.
 *
 * File-sets are resolved only for tickets that survive dependency layering — a
 * ticket already dropped as unreachable is not one we could run anyway, so there
 * is nothing to ask about it. A selection that resolves to a single issue skips the
 * file-set step entirely (no co-wave to collide with, §356) — the reachability
 * layering above still runs, so a lone blocked ticket is still dropped. Pure over
 * the injected resolvers; the tree read and the interactive prompt live at the edge.
 */
export async function planCampaign(ids: string[], deps: CampaignPlanDeps): Promise<CampaignPlan> {
  const layered = await layerWaves(ids, deps.blockedBy);

  // A selection that resolves to a single issue has no co-wave, so the file-set
  // disjointness check guards nothing (§356): skip it whole — resolve no file-sets,
  // prune nothing, never prompt — and record the skip so the provenance names it as a
  // *skipped* check. Reachability already ran in `layerWaves` above, so a lone ticket
  // held by an open out-of-set blocker is still dropped and reported, unaffected.
  if (uniqueOrder(ids).length === 1) {
    return { ...layered, underspecified: [], pruned: [], filesetCheckSkipped: true };
  }

  const scheduled = layered.placements.map((p) => p.id);

  const sets = new Map<string, FileSet>();
  await Promise.all(scheduled.map(async (id) => sets.set(id, await deps.fileSet(id))));

  const underspecified = scheduled.filter((id) => !sets.get(id)!.confident);

  let survivorPlan = layered;
  let pruned: string[] = [];
  if (underspecified.length) {
    const decision = await deps.onUnderspecified(underspecified);
    if (decision === "fail") {
      const list = underspecified.map((i) => `#${i}`).join(", ");
      const [subj, obj] = underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
      throw new Error(
        `campaign: ${list} ${subj} no confident file-set. Add the file data to the issue(s) ` +
          `and re-run, or pass --on-underspecified=drop to prune ${obj} and plan the rest.`,
      );
    }
    // drop: prune each under-specified ticket and its dependent chain out of the
    // layered waves, threading the shrinking remainder forward. A ticket already
    // gone as another's dependent is skipped — `computePrune` rejects an absent target.
    let remaining = layered.waves;
    const prunedSet = new Set<string>();
    for (const target of underspecified) {
      if (prunedSet.has(normalize(target))) continue;
      const res = await computePrune(remaining, target, deps.blockedBy);
      for (const id of res.removed) prunedSet.add(id);
      remaining = res.remaining;
    }
    pruned = scheduled.filter((id) => prunedSet.has(id));
    // Re-layer the confident survivors so the returned plan's placements/`after`
    // reflect the reduced set; pruning dependents keeps the DAG intact.
    survivorPlan = await layerWaves(remaining.flat(), deps.blockedBy);
  }

  const basenames = new Map(survivorPlan.placements.map((p) => [p.id, new Set(sets.get(p.id)?.files ?? [])]));
  const partitioned = partitionWaves(survivorPlan, basenames);

  return {
    ...partitioned,
    // The unreachable list and the edge exclusions both belong to the original
    // layering — re-layering the survivors alone would forget the dependency drops
    // from the first pass (and re-layering never re-reports the same exclusions).
    unreachable: layered.unreachable,
    excluded: layered.excluded,
    underspecified,
    pruned,
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

/**
 * The label names on a fetched task, read from the tracker JSON `fetchTask` returns
 * (GitHub's `--json labels` yields `{ labels: [{ name }] }`). Best-effort: anything
 * that does not parse as labelled JSON has no labels. `suggestCampaignName` filters
 * these down to the known area set.
 */
export const labelsFromTask = (task: string): string[] => {
  try {
    const parsed = JSON.parse(task) as { labels?: unknown };
    const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
    return labels
      .map((l) => (typeof l === "string" ? l : (l as { name?: unknown })?.name))
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
};

/**
 * The tracker/tree edges `runCampaignPlan` reads a selected set through — the same
 * `fetchTask`/`blockedBy`/`fileSet` config seams `campaign` and `graft` use. A narrow
 * structural view (not the full `ResolvedConfig`) so `plan.ts` stays pure over its
 * injected resolvers.
 */
export interface CampaignPlanConfig {
  fetchTask: (id: string) => string | Promise<string>;
  blockedBy?: (id: string) => string[] | Promise<string[]>;
  fileSet?: FileSetOf;
}

/** The parsed `--on-underspecified` flag, if the caller passed one. */
export interface CampaignPlanOptions {
  onUnderspecified?: string;
}

/**
 * The two process globals the under-specified prompt branches on, injected so the
 * flag/TTY/ask wiring is driven without a real terminal (mirroring how
 * `underspecifiedPromptFor` takes `isTTY`/`ask` directly).
 */
export interface CampaignPlanRunDeps {
  isTTY: boolean;
  ask: UnderspecifiedPrompt;
}

/** The rendered-but-not-printed plan: the CLI case prints these three, in order. */
export interface CampaignPlanReport {
  /** the dependency-ordered, file-disjoint waves the set layered into — what the
   *  default `campaign` path runs, and what `waveArgs` renders. */
  waves: string[][];
  /** the bare quoted wave args (`waveArgs`) — empty when nothing is schedulable. */
  waveArgs: string;
  /** the human-readable provenance report (`describePlan`). */
  report: string;
  /** the suggested `--name` value, or undefined when the set spans no area label. */
  suggestedName?: string;
}

/**
 * The planning assembly `campaign` runs before it executes (and `campaign --dry-run`
 * stops after), lifted out of `cli.mts`'s inline switch so the composition is drivable
 * with stubs. It builds the file-set resolver (`cfg.fileSet ?? defaultFileSet()`,
 * composed with `ticketProse ∘ fetchTask`), wires the under-specified prompt off the
 * injected `isTTY`/`ask`, runs `planCampaign`, and returns the layered waves alongside
 * the rendered wave args, provenance report, and suggested `--name`. No side effects:
 * it reads the tracker and computes the plan; running the waves is the caller's job.
 *
 * `expandExcluded` carries the drops `expandSelection` already made when it turned the
 * label tokens into ids (epic / pending-verify, §4 step 1) — they happened before this
 * call, so the CLI passes them here for the provenance to name alongside the blocker
 * exclusions the planner itself discovers (§4 step 2).
 */
export async function runCampaignPlan(
  cfg: CampaignPlanConfig,
  ids: string[],
  opts: CampaignPlanOptions,
  deps: CampaignPlanRunDeps,
  expandExcluded: Exclusion[] = [],
): Promise<CampaignPlanReport> {
  if (!ids.length)
    throw new Error(
      "campaign needs at least one issue id or label: campaign 436 611 640",
    );
  // A selection that resolves to a single issue layers into one trivial wave, so the
  // blockedBy *requirement* guards nothing — stand it down (§356). The check itself is
  // not skipped: a configured resolver still runs below and still drops a lone ticket
  // held by an open blocker outside the selection; only the "no resolver configured"
  // throw is lifted, so bare `campaign <id>` runs without a resolver wired in.
  const single = uniqueOrder(ids).length === 1;
  if (!cfg.blockedBy && !single)
    throw new Error(
      'campaign needs a "blockedBy" resolver in your config to plan waves — e.g. blockedBy: githubBlockedBy("owner/repo") (or pass --override to run hand-crafted waves).',
    );

  // Which files each ticket touches: the project's resolver, or the shipped
  // cites-from-body default, over the ticket's ticketProse'd text.
  const resolveFileSet = cfg.fileSet ?? defaultFileSet();
  const plan = await planCampaign(ids, {
    blockedBy: cfg.blockedBy ?? (() => []),
    fileSet: async (id) => resolveFileSet(ticketProse(String(await cfg.fetchTask(id)))),
    onUnderspecified: underspecifiedPromptFor({
      flag: opts.onUnderspecified,
      isTTY: deps.isTTY,
      ask: deps.ask,
    }),
  });

  // A suggested --name from the area labels the selected issues span — the same
  // fetchTask the plan uses, read for its labels.
  const suggestedName = await suggestCampaignName(ids, async (id) =>
    labelsFromTask(String(await cfg.fetchTask(id))),
  );

  // Fold the label-expansion exclusions in front of the planner's own so the
  // provenance's Excluded section names every edge drop, expansion then layering.
  const report = describePlan({ ...plan, excluded: [...expandExcluded, ...plan.excluded] });
  return { waves: plan.waves, waveArgs: waveArgs(plan), report, suggestedName };
}

/** One ticket's resolver verdict, as `fileset-check` reports it. */
export interface FilesetCheckResult {
  /** the ticket id (normalized, no leading #). */
  id: string;
  /** the resolver's `confident` verdict — false is exactly what `campaign-plan` halts on. */
  confident: boolean;
  /** the basenames the resolver pinned down (may be partial when not confident). */
  files: string[];
}

/**
 * Resolve each ticket's file-set through the **same** path `campaign-plan` uses —
 * `cfg.fileSet ?? defaultFileSet()` over `ticketProse ∘ fetchTask` — and report the
 * resolver's verdict per id. Because it calls the identical resolver rather than a
 * restatement of it, `fileset-check` and the planner agree by construction: a ticket
 * this reports `confident: false` is exactly one the planner would halt on. Used by
 * the `/fileset` sweep to decide "already marked" (skip) only when the marker truly
 * resolves. Pure over the injected `fetchTask`/`fileSet`; the tree read lives in the
 * resolver.
 */
export async function runFilesetCheck(
  cfg: CampaignPlanConfig,
  ids: string[],
): Promise<FilesetCheckResult[]> {
  if (!ids.length)
    throw new Error(
      "fileset-check needs at least one ticket id: fileset-check 201 173",
    );
  const resolveFileSet = cfg.fileSet ?? defaultFileSet();
  return Promise.all(
    uniqueOrder(ids).map(async (id) => {
      const { files, confident } = await resolveFileSet(
        ticketProse(String(await cfg.fetchTask(id))),
      );
      return { id, confident, files };
    }),
  );
}

/**
 * Render `runFilesetCheck`'s results one line per ticket: a confident ticket lists
 * the basenames the resolver pinned down; a not-confident one says `campaign-plan`
 * would halt on it (naming any partial cites resolved so far). Plain text for the
 * terminal and for the `/fileset` sweep to read.
 */
export function describeFilesetCheck(results: FilesetCheckResult[]): string {
  return results
    .map((r) => {
      const cites = r.files.map((f) => `\`${f}\``).join(", ");
      return r.confident
        ? `#${r.id}  confident — ${cites}`
        : `#${r.id}  NOT confident — campaign would halt (planning)` +
            (r.files.length ? ` (resolved so far: ${cites})` : "");
    })
    .join("\n");
}
