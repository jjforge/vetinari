/**
 * The campaign planner: turn a selected set of ticket ids into dependency-ordered
 * waves plus a provenance report. `campaign` runs the planner then executes the
 * waves; `campaign --dry-run` stops after and prints the plan.
 *
 * Waves come from the `blockedBy` graph restricted to the selected set (the
 * shared `restrictBlockers` foundation `prune` also uses) and the tickets' file
 * keys: a ticket goes in the earliest wave after all its blockers' waves that
 * shares no file key with it, most-colliding tickets placed first. A closed blocker never reaches the resolver, so it does
 * not gate. An OPEN blocker outside the selected set makes its dependent
 * unreachable — it is reported and dropped (along with everything that in turn
 * depends on it), never scheduled silently.
 *
 * This plans only: it computes waves, it never runs `campaign` and never pushes.
 * Pure over the injected `blockedByOf`, so it stays testable with no live tracker.
 */
import { computePrune, restrictBlockers, type BlockedByOf } from "./prune.ts";
import { isIssueToken, normalize } from "./issue-id.ts";
import { BARE_KEY_MARKER, defaultFileSet, ticketProse, waiveFileSet, type FileSet, type FileSetOf } from "./fileset.ts";
import { Refusal } from "./refusal.ts";
import type { FileOverlap } from "./config.ts";

export interface Placement {
  id: string;
  /** the wave this ticket lands in (0-based). */
  wave: number;
  /** its in-set open blockers — all in earlier waves; empty in wave 0. */
  after: string[];
  /**
   * the already-placed tickets it shares a file with in the waves from its floor
   * (the wave after its last in-set blocker, or wave 0) up to its own — the
   * crossover that spilled it past its floor. Empty (or absent on a `layerWaves`
   * plan) when it landed at its floor.
   */
  sharesFilesWith?: string[];
  /**
   * the same collisions grouped by the file they were on: each of this ticket's own
   * fileKeys that collided, with the earlier tickets (input order) it collided with
   * there. Most tickets first; ties keep the order the keys first collided. A ticket
   * colliding on several keys is listed under each.
   */
  sharedFiles?: { file: string; with: string[] }[];
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
  listByLabel?: (label: string, onExcluded?: (e: Exclusion) => void) => string[] | Promise<string[]>,
  onExcluded?: (e: Exclusion) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (const token of tokens) {
    if (isIssueId(token)) {
      ids.push(token);
      continue;
    }
    if (!listByLabel)
      throw new Refusal(
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
type ExcludingBlockedBy = (id: string, onExcluded?: (e: Exclusion) => void) => string[] | Promise<string[]>;

export async function layerWaves(ids: string[], blockedByOf: BlockedByOf): Promise<WavePlan> {
  const order = uniqueOrder(ids);
  // Collect the edge exclusions the resolver reports while restricting — a
  // pending-verify blocker is dropped inside the resolver, so the only way it reaches
  // the provenance is the resolver naming it here (§4 step 2). Wrapping keeps
  // `restrictBlockers` (shared with `prune`) untouched: it still calls a one-arg fn.
  const excluded: Exclusion[] = [];
  const collecting: BlockedByOf = (id) => (blockedByOf as ExcludingBlockedBy)(id, (e) => excluded.push(e));
  const { inSet, external } = await restrictBlockers(order, collecting);

  // Unreachable closure. Seed with any ticket held by an open blocker outside the
  // set, then drop anything whose in-set blocker was itself dropped, to a fixpoint
  // — the same dependent-chain logic as prune: a ticket cannot run until every
  // prerequisite can, so an unreachable prerequisite takes its dependents with it.
  const dropped = new Set<string>();
  for (const id of order) if (external.get(id)!.size) dropped.add(id);
  for (let changed = true; changed;) {
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
      throw new Refusal(`campaign: blockedBy cycle among ${remaining.map((i) => `#${i}`).join(", ")}.`);
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
  /** the project's file-overlap mode (ADR 0025); absent reads as `strict`. Under `allow`
   *  file-sets are still resolved and checked, but the waves are the dependency layering alone. */
  fileOverlap?: FileOverlap;
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
  /**
   * selected issues skipped before planning because their campaign merge commit is already
   * on the base (design §4) — merged work whose label has not caught up. Each carries the
   * merge commit's sha so the provenance can name the proof. Absent/empty when none was.
   */
  alreadyMerged?: { id: string; sha: string }[];
  /**
   * each waived file (`waivedFiles`) a scheduled ticket cited, with how many scheduled
   * tickets cited it — counted after any under-specified prune. Absent when nothing was
   * waived (and on a one-issue selection, which resolves no file-sets).
   */
  waived?: Record<string, number>;
  /**
   * each scheduled ticket's fileKeys exactly as the partition judged collisions on (less
   * any waived files), so the report's lower bound and most-shared files match the waves.
   * Absent on a one-issue selection, which resolves no file-sets.
   */
  fileKeys?: Record<string, string[]>;
  /**
   * each scheduled ticket's resolved fileKeys **before** `waivedFiles` is applied — its
   * `fileKeys` plus the waived files it cited — so a replay of the run can still measure
   * already-waived files. Absent on a one-issue selection, which resolves no file-sets.
   */
  preWaiveFileKeys?: Record<string, string[]>;
  /** `allow` when the plan was layered by dependencies alone, its file overlaps left to merge
   *  (ADR 0025), so the report lists them and bounds by dependency depth. Absent under `strict`. */
  fileOverlap?: "allow";
}

/** A fileKey is a **bare key** — names a file only by its name, because its cite could not
 *  be pinned to one path — when it carries the `*\/` marker ({@link BARE_KEY_MARKER}). A key
 *  with no `/` and no marker (a repo-root file, a top-level package) is an exact path. */
const isBareKey = (k: string) => k.startsWith(BARE_KEY_MARKER);
const keyBasename = (k: string) => k.slice(k.lastIndexOf("/") + 1);

/**
 * Whether two fileKeys collide. Two exact paths collide only when equal — distinct files
 * at `a/b/c/foo.md` and `a/c/foo.md` do not, nor do a repo-root `foo.md` and `docs/foo.md`,
 * nor top-level package `pkg` and `internal/pkg`. A bare key `*\/<name>` — an ambiguous
 * `Touches:`/`Files:` or whole-body cite, a `Creates:` cite whose directory matches several
 * tree directories, or a bare `Creates:` cite — collides with every key of that name,
 * bare or not, since it names no one path.
 */
const keysCollide = (a: string, b: string) => a === b || (keyBasename(a) === keyBasename(b) && (isBareKey(a) || isBareKey(b)));

/** True when no fileKey in `a` collides with any in `b`. */
const disjoint = (a: Set<string>, b: Set<string>) => {
  for (const x of a) for (const y of b) if (keysCollide(x, y)) return false;
  return true;
};

/**
 * The one placement rule the planner and `applyGraft` share: put `id` into the
 * earliest wave at or after `floor` whose fileKeys are disjoint from its own,
 * appending a wave when none fits. Existing members are never moved. Grows `waves`
 * and the parallel `waveKeys` in place and returns the wave it landed in.
 */
function placeEarliestDisjoint(waves: string[][], waveKeys: Set<string>[], id: string, keys: Set<string>, floor: number): number {
  let target = floor;
  while (target < waves.length && !disjoint(waveKeys[target], keys)) target++;
  while (waves.length <= target) {
    waves.push([]);
    waveKeys.push(new Set());
  }
  waves[target].push(id);
  for (const k of keys) waveKeys[target].add(k);
  return target;
}

/**
 * Place a `layerWaves` plan's tickets into file-disjoint waves, so no two tickets in
 * a wave touch the same file (user story 5), with no layer barrier: a dependent may
 * share a wave with a ticket of an earlier dependency layer.
 *
 * Walk in dependency order: among the tickets whose in-set blockers are all placed,
 * take the one that collides with the most others in the selection (ties keep `order`,
 * the selection order), and place it by `placeEarliestDisjoint` from its floor — the
 * wave after its last in-set blocker, or wave 0. Placing the most-colliding first
 * keeps the colliders from each claiming a wave of their own late in the walk.
 * Collisions are judged by fileKey (`keysCollide`); a ticket with no known fileKeys
 * collides with nothing. The walk decides placement only: each wave, and
 * `placements`, list ids in wave-then-`order` order.
 */
export function placeByCollisions(plan: WavePlan, order: string[], fileKeysOf: Map<string, Set<string>>): WavePlan {
  const keysOf = (id: string) => fileKeysOf.get(id) ?? new Set<string>();
  const afterOf = new Map(plan.placements.map((p) => [p.id, p.after]));
  const ids = order.filter((id) => afterOf.has(id));
  const rank = new Map(ids.map((id, i) => [id, i]));
  const collisions = new Map(ids.map((id) => [id, ids.filter((o) => o !== id && !disjoint(keysOf(o), keysOf(id))).length]));

  const waves: string[][] = [];
  const waveKeys: Set<string>[] = [];
  const waveOf = new Map<string, number>();
  const placements: Placement[] = [];
  for (let unplaced = ids; unplaced.length;) {
    // `layerWaves` already refused a cycle, so some unplaced ticket is always ready.
    const ready = unplaced.filter((id) => afterOf.get(id)!.every((b) => waveOf.has(b)));
    const id = ready.reduce((best, c) => (collisions.get(c)! > collisions.get(best)! ? c : best));
    unplaced = unplaced.filter((u) => u !== id);

    const keys = keysOf(id);
    const floor = Math.max(0, ...afterOf.get(id)!.map((b) => waveOf.get(b)! + 1));
    const wave = placeEarliestDisjoint(waves, waveKeys, id, keys, floor);
    waveOf.set(id, wave);

    // Why it did not land at its floor: the already-placed tickets in the waves from
    // its floor up to its own that it shares a file with. Empty when it landed there.
    const sharesFilesWith = ids.filter((prior) => {
      const w = waveOf.get(prior);
      return prior !== id && w !== undefined && w >= floor && w < wave && !disjoint(keysOf(prior), keys);
    });

    const byFile = new Map<string, string[]>();
    for (const prior of sharesFilesWith) {
      for (const k of keys) {
        if (![...keysOf(prior)].some((pk) => keysCollide(k, pk))) continue;
        byFile.set(k, [...(byFile.get(k) ?? []), prior]);
      }
    }
    const sharedFiles = [...byFile].map(([file, ids]) => ({ file, with: ids })).sort((a, b) => b.with.length - a.with.length);

    placements.push({ id, wave, after: afterOf.get(id)!, sharesFilesWith, sharedFiles });
  }

  const byInput = (a: string, b: string) => rank.get(a)! - rank.get(b)!;
  for (const wave of waves) wave.sort(byInput);
  placements.sort((a, b) => a.wave - b.wave || byInput(a.id, b.id));
  return { waves, placements, unreachable: plan.unreachable, excluded: plan.excluded };
}

/**
 * The precomputed layering inputs a `graft` event carries, resolved by the CLI at
 * append time (ADR 0014) so the fold stays pure (ADR 0012): the added ids, each
 * added id's in-campaign open blockers, and — for every id the placement may share
 * a wave with (the added ids plus the campaign's still-unstarted members) — its
 * fileKeys. With these `applyGraft` runs the same dependency + file-disjoint
 * placement `campaign-plan` does, with no tracker or filesystem access.
 *
 * The persisted `GraftEvent.fileKeys` wire field maps straight into `fileKeys`
 * here; a log written before the rename carried the same value under `basenames`,
 * which the reducer's reader still accepts (preferring `fileKeys`).
 */
export interface GraftInputs {
  /** the grafted issue ids, in the order given. */
  ids: string[];
  /** grafted id -> its OPEN blockers that are inside this campaign. */
  blockedBy: Record<string, string[]>;
  /** id -> its fileKeys, for the grafted ids and the still-unstarted members the
   *  placement checks disjointness against. */
  fileKeys: Record<string, string[]>;
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
 * in-campaign `blockedBy` deps and stays fileKey-disjoint, appending a new wave
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

  const keysOf = (id: string) => new Set((graft.fileKeys[normalize(id)] ?? []).map(normalize));
  // The fileKeys already committed to each wave, grown as grafts land.
  const waveKeys = result.map((wave) => {
    const keys = new Set<string>();
    for (const id of wave) for (const k of keysOf(id)) keys.add(k);
    return keys;
  });

  const grafted: string[] = [];
  for (const id of newIds) {
    let earliest = firstFree;
    for (const b of (graft.blockedBy[id] ?? []).map(normalize)) {
      const bw = waveOf.get(b);
      if (bw !== undefined) earliest = Math.max(earliest, bw + 1);
    }
    // `earliest` is at least `firstFree` (>= 0), so it never indexes a pinned wave.
    waveOf.set(id, placeEarliestDisjoint(result, waveKeys, id, keysOf(id), earliest));
    grafted.push(id);
  }

  return { remaining: result.filter((wave) => wave.length), grafted };
}

/**
 * Pure rule folding a `replan` into a running campaign (ADR 0022): the first `started`
 * waves — every wave that has had a `wave-start` — stay at their index, since the
 * `campaign` loop is index-based, and the tail after them is replaced by the re-planned
 * waves. The race rule keeps the fold honest about what changed since the replan read the
 * log: a re-planned id that has started by now, or is no longer in the plan (pruned since),
 * is skipped; an unstarted member the replan does not name (grafted since) goes in a
 * trailing wave of its own. Waves left empty are dropped. Never adds or removes a member.
 */
export function applyReplan(campaign: { waves: string[][]; started: number }, replanned: string[][]): string[][] {
  const prefix = campaign.waves.slice(0, campaign.started);
  const tail = campaign.waves.slice(campaign.started).flat();
  const unstarted = new Set(tail);
  const named = new Set<string>();
  const waves = replanned.map((wave) =>
    wave.map(normalize).filter((id) => {
      if (!unstarted.has(id) || named.has(id)) return false;
      named.add(id);
      return true;
    }),
  );
  waves.push(tail.filter((id) => !named.has(id)));
  return [...prefix, ...waves.filter((wave) => wave.length)];
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
  await Promise.all(
    uniqueOrder(ids).map(async (id) => {
      for (const label of await labelsOf(id)) spanned.add(label);
    }),
  );
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

/** The number of dependency layers the placements form: the tickets in the longest
 *  in-set blocker chain. Placements list every blocker in an earlier wave, so one pass. */
function dependencyDepth(placements: Placement[]): number {
  const depth = new Map<string, number>();
  for (const p of placements) depth.set(p.id, 1 + Math.max(0, ...p.after.map((b) => depth.get(b) ?? 0)));
  return Math.max(0, ...depth.values());
}

/**
 * The file groups a plan cannot beat: per cited fileKey, how many tickets cite a key that
 * collides with it (`keysCollide`) — every pair in a group collides, so each needs its own
 * wave. A resolved path's group takes in bare cites of its basename; a bare key stands as
 * its own group only when no resolved path of that basename is cited. Largest first; ties
 * keep the order the keys were first cited.
 */
function fileGroups(fileKeys: Record<string, string[]>): { file: string; tickets: number }[] {
  const keySets = Object.values(fileKeys);
  const cited = [...new Set(keySets.flat())];
  return cited
    .filter((k) => !isBareKey(k) || !cited.some((o) => o !== k && keysCollide(o, k)))
    .map((file) => ({ file, tickets: keySets.filter((keys) => keys.some((k) => keysCollide(k, file))).length }))
    .sort((a, b) => b.tickets - a.tickets);
}

/** Each pair of co-wave tickets whose fileKeys collide (`keysCollide`) — the overlaps a plan
 *  under `fileOverlap: "allow"` did not enforce (ADR 0025) — with the first ticket's colliding keys. */
function unenforcedOverlaps(waves: string[][], fileKeys: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const wave of waves) {
    wave.forEach((a, i) => {
      for (const b of wave.slice(i + 1)) {
        const shared = (fileKeys[a] ?? []).filter((k) => (fileKeys[b] ?? []).some((o) => keysCollide(k, o)));
        if (shared.length) lines.push(`overlap allowed: #${a} and #${b} share ${shared.join(", ")}`);
      }
    });
  }
  return lines;
}

/**
 * A human-readable provenance report: each scheduled ticket with its wave and
 * why it is there, then every dropped ticket with the reason it cannot run
 * against this set — tickets pruned for an under-specified file-set as well as
 * tickets unreachable by dependency. Plans only — this describes the plan, it
 * does not run it.
 */
export function describePlan(
  plan: WavePlan &
    Partial<
      Pick<CampaignPlan, "pruned" | "underspecified" | "filesetCheckSkipped" | "alreadyMerged" | "waived" | "fileKeys" | "fileOverlap">
    >,
): string {
  const scheduled = plan.placements.length;
  const pruned = plan.pruned ?? [];
  const alreadyMerged = plan.alreadyMerged ?? [];
  const lines: string[] = [
    `campaign: ${plan.waves.length} wave(s), ${scheduled} ticket(s) scheduled, ${plan.unreachable.length} unreachable` +
      (pruned.length ? `, ${pruned.length} pruned` : "") +
      (alreadyMerged.length ? `, ${alreadyMerged.length} already merged` : "") +
      ".",
    // The waived files the planner left out of its collision checks — provenance, not a drop.
    ...Object.entries(plan.waived ?? {}).map(([file, n]) => `\`${file}\` waived for ${n} ticket${n === 1 ? "" : "s"}`),
    "",
  ];

  for (const p of plan.placements) {
    const reasons = [p.after.length ? `after ${p.after.map((b) => `#${b}`).join(", ")}` : "no open blocker in the selected set"];
    const tags = (ids: string[]) => ids.map((b) => `#${b}`).join(", ");
    if (p.sharedFiles?.length) {
      reasons.push(`spilled — shares ${p.sharedFiles.map((g) => `${g.file} with ${tags(g.with)}`).join("; ")}`);
    } else if (p.sharesFilesWith?.length) {
      reasons.push(`spilled — shares a file with ${tags(p.sharesFilesWith)}`);
    }
    lines.push(`  wave ${p.wave}  #${p.id}  — ${reasons.join("; ")}`);
  }

  const allow = plan.fileOverlap === "allow";
  const overlaps = allow ? unenforcedOverlaps(plan.waves, plan.fileKeys ?? {}) : [];
  if (overlaps.length) lines.push("", ...overlaps);

  // How close the wave count is to the fewest possible, and which files hold it there:
  // the larger of the dependency depth and the largest file group (a file wins a tie).
  // Under `allow` no file group holds a wave apart, so the bound is the dependency depth.
  if (scheduled) {
    const depth = dependencyDepth(plan.placements);
    const groups = fileGroups(plan.fileKeys ?? {}).filter((g) => g.tickets >= 2);
    const top = allow ? undefined : groups[0];
    const waves = (n: number) => `${n} wave${n === 1 ? "" : "s"}`;
    lines.push(
      "",
      top && top.tickets >= depth
        ? `lower bound: ${waves(top.tickets)} — ${top.tickets} tickets share ${top.file} (dependency depth ${depth})`
        : `lower bound: ${waves(depth)} — set by the dependency chain, ${depth} ticket${depth === 1 ? "" : "s"} deep` +
            (top ? ` (largest file group: ${top.tickets} tickets share ${top.file})` : ""),
    );
    const mostShared = groups.filter((g) => g.tickets * 4 >= scheduled);
    if (mostShared.length) lines.push("", "Most-shared files:", ...mostShared.map((g) => `  ${g.file}  ${g.tickets} tickets`));
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

  if (alreadyMerged.length) {
    lines.push("", "Already merged (skipped — its campaign merge commit is on the base):");
    for (const m of alreadyMerged) {
      lines.push(`  #${m.id} looks already merged (merge commit ${m.sha}) — skipped; --include-merged to include`);
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
      // The non-interactive fail (an explicit `--on-underspecified=fail`, or a non-terminal
      // run that defaults to fail): a refusal whose message names the flag. The interactive
      // stop raises its OWN refusal from `makeAskUnderspecified` before it ever returns here.
      const list = underspecified.map((i) => `#${i}`).join(", ");
      const [subj, obj] = underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
      throw new Refusal(
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

  const fileKeys = new Map(survivorPlan.placements.map((p) => [p.id, new Set(sets.get(p.id)?.files ?? [])]));
  // Under `allow` (ADR 0025) the waves are the dependency layering alone: file overlaps are
  // reported, not enforced, and a collision is left to the merge-time retry.
  const allow = deps.fileOverlap === "allow";
  const partitioned = allow ? survivorPlan : placeByCollisions(survivorPlan, uniqueOrder(ids), fileKeys);

  const waived: Record<string, number> = {};
  for (const p of survivorPlan.placements) for (const k of sets.get(p.id)?.waived ?? []) waived[k] = (waived[k] ?? 0) + 1;

  return {
    ...partitioned,
    // The unreachable list and the edge exclusions both belong to the original
    // layering — re-layering the survivors alone would forget the dependency drops
    // from the first pass (and re-layering never re-reports the same exclusions).
    unreachable: layered.unreachable,
    excluded: layered.excluded,
    underspecified,
    pruned,
    ...(Object.keys(waived).length ? { waived } : {}),
    fileKeys: Object.fromEntries([...fileKeys].map(([id, keys]) => [id, [...keys]])),
    preWaiveFileKeys: Object.fromEntries(
      survivorPlan.placements.map((p) => [p.id, [...(sets.get(p.id)?.files ?? []), ...(sets.get(p.id)?.waived ?? [])]]),
    ),
    ...(allow && { fileOverlap: "allow" as const }),
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
      throw new Refusal(`--on-underspecified must be "drop" or "fail" (got "${opts.flag}").`);
    }
    const decided = opts.flag;
    return () => decided;
  }
  if (opts.isTTY) return opts.ask;
  return () => "fail";
}

/** The terminal IO `makeAskUnderspecified` drives — injected so the choice is driven without a real TTY. */
export interface UnderspecifiedPromptIO {
  log: (msg: string) => void;
  ask: (question: string) => Promise<string>;
}

/**
 * The interactive under-specified halt (terminal only — the flag/TTY gate is
 * `underspecifiedPromptFor`, which hands this in as its `ask`). Prints the two choices,
 * then reads the answer through the injected `ask`: `d`/`drop` returns `"drop"` (prune the
 * under-specified tickets and their dependents, plan the rest); `s`/`stop` is the operator's
 * *chosen* outcome, so it is raised as a `Refusal` that names the tickets and the fix — add
 * `Touches:`/`Creates:` lines and re-run — with no `--on-underspecified` hint (that belongs to
 * the non-interactive path, where no prompt was shown). The interactive path never returns
 * `"fail"`; `UnderspecifiedDecision` is unchanged. This is the ONE place that knows a prompt
 * was shown, so the stop wording lives here and not in `planCampaign`.
 */
export function makeAskUnderspecified(io: UnderspecifiedPromptIO): UnderspecifiedPrompt {
  return async (underspecified: string[]): Promise<UnderspecifiedDecision> => {
    const list = underspecified.map((i) => `#${i}`).join(", ");
    const [subj, obj] = underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
    io.log(
      `\ncampaign: ${list} ${subj} no confident file-set.\n` +
        `  [d] drop ${obj} and ${underspecified.length === 1 ? "its" : "their"} dependents, and plan the rest\n` +
        `  [s] stop so you can add the file data to the issue(s) and re-run`,
    );
    for (;;) {
      const answer = (await io.ask("drop or stop? [d/s] ")).trim().toLowerCase();
      if (answer === "d" || answer === "drop") return "drop";
      if (answer === "s" || answer === "stop") throw new Refusal(`stopped — add Touches:/Creates: lines to ${list} and re-run`);
      io.log('please answer "d" (drop) or "s" (stop).');
    }
  };
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
  /** the project's waived files — left out of collision checks via `waiveFileSet`. */
  waivedFiles?: string[];
  /** the project's file-overlap mode (ADR 0025); absent reads as `strict`. */
  fileOverlap?: FileOverlap;
}

/** The parsed `--on-underspecified` flag, if the caller passed one. */
export interface CampaignPlanOptions {
  onUnderspecified?: string;
  /** `--include-merged`: plan a selected issue even when its merge commit is on the base. */
  includeMerged?: boolean;
}

/**
 * The two process globals the under-specified prompt branches on, injected so the
 * flag/TTY/ask wiring is driven without a real terminal (mirroring how
 * `underspecifiedPromptFor` takes `isTTY`/`ask` directly).
 */
export interface CampaignPlanRunDeps {
  isTTY: boolean;
  ask: UnderspecifiedPrompt;
  /**
   * id -> the sha of its campaign merge commit on the base, or undefined (the CLI passes
   * `findMergeCommit`). When given, a selected id that has one is skipped as already merged
   * (design §4); when absent, nothing is skipped.
   */
  mergeCommitOf?: (id: string) => string | undefined;
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
  /** the selected issues skipped as already merged, with their merge commit sha (design §4). */
  alreadyMerged: { id: string; sha: string }[];
  /** each waived file a scheduled ticket cited and how many cited it — absent when none was. */
  waived?: Record<string, number>;
  /**
   * each scheduled ticket's resolved fileKeys before `waivedFiles` is applied, for the
   * `campaign-start` event — absent when the plan resolved no file-sets (a one-issue selection).
   */
  fileKeys?: Record<string, string[]>;
}

/**
 * The planning assembly `campaign` runs before it executes (and `campaign --dry-run`
 * stops after), lifted out of `cli.mts`'s inline switch so the composition is drivable
 * with stubs. It builds the file-set resolver (`cfg.fileSet ?? defaultFileSet()`, less
 * the waived files via `waiveFileSet`, composed with `ticketProse ∘ fetchTask`), wires the under-specified prompt off the
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
  if (!ids.length) throw new Refusal("campaign needs at least one issue id or label: campaign 436 611 640");

  // Skip a selected issue whose campaign merge commit is already on the base (design §4):
  // its label may not have caught up (a red-base park never relabels; a green relabel can
  // race the next launch), so the merge commit, not the label, says it is done. Reported,
  // never silent; `--include-merged` plans it anyway (a reopened issue).
  const alreadyMerged: { id: string; sha: string }[] = [];
  let planIds = uniqueOrder(ids);
  if (deps.mergeCommitOf && !opts.includeMerged) {
    const mergeCommitOf = deps.mergeCommitOf;
    planIds = planIds.filter((id) => {
      const sha = mergeCommitOf(id);
      if (sha) alreadyMerged.push({ id, sha });
      return !sha;
    });
  }

  // A selection that resolves to a single issue layers into one trivial wave, so the
  // blockedBy *requirement* guards nothing — stand it down (§356). The check itself is
  // not skipped: a configured resolver still runs below and still drops a lone ticket
  // held by an open blocker outside the selection; only the "no resolver configured"
  // throw is lifted, so bare `campaign <id>` runs without a resolver wired in.
  const single = planIds.length <= 1;
  if (!cfg.blockedBy && !single)
    throw new Refusal(
      'campaign needs a "blockedBy" resolver in your config to plan waves — e.g. blockedBy: githubBlockedBy("owner/repo") (or pass --override to run hand-crafted waves).',
    );

  // Which files each ticket touches: the project's resolver, or the shipped
  // cites-from-body default, over the ticket's ticketProse'd text — less its waived files.
  const resolveFileSet = waiveFileSet(cfg.fileSet ?? defaultFileSet(), cfg.waivedFiles);
  // A skipped issue is a satisfied blocker, like a merged (pending-verify) one: it is still
  // open, so the resolver still returns it — strip it so it never gates or strands a
  // dependent. The resolver's `onExcluded` sink is forwarded so its own drops still report.
  const skipped = new Set(alreadyMerged.map((m) => m.id));
  const resolveBlockedBy = cfg.blockedBy as ExcludingBlockedBy | undefined;
  const blockedBy: ExcludingBlockedBy | undefined =
    resolveBlockedBy && skipped.size
      ? async (id, onExcluded) => (await resolveBlockedBy(id, onExcluded)).filter((b) => !skipped.has(normalize(b)))
      : resolveBlockedBy;
  const plan = await planCampaign(planIds, {
    blockedBy: blockedBy ?? (() => []),
    fileSet: async (id) => resolveFileSet(ticketProse(String(await cfg.fetchTask(id)))),
    onUnderspecified: underspecifiedPromptFor({
      flag: opts.onUnderspecified,
      isTTY: deps.isTTY,
      ask: deps.ask,
    }),
    fileOverlap: cfg.fileOverlap,
  });

  // A suggested --name from the area labels the selected issues span — the same
  // fetchTask the plan uses, read for its labels.
  const suggestedName = await suggestCampaignName(planIds, async (id) => labelsFromTask(String(await cfg.fetchTask(id))));

  // Fold the label-expansion exclusions in front of the planner's own so the
  // provenance's Excluded section names every edge drop, expansion then layering.
  const report = describePlan({ ...plan, excluded: [...expandExcluded, ...plan.excluded], alreadyMerged });
  return {
    waves: plan.waves,
    waveArgs: waveArgs(plan),
    report,
    suggestedName,
    alreadyMerged,
    ...(plan.waived && { waived: plan.waived }),
    ...(plan.preWaiveFileKeys && { fileKeys: plan.preWaiveFileKeys }),
  };
}

/** One ticket's resolver verdict, as `campaign --dry-run` reports it. */
export interface FilesetCheckResult {
  /** the ticket id (normalized, no leading #). */
  id: string;
  /** the resolver's `confident` verdict — false is exactly what `campaign-plan` halts on. */
  confident: boolean;
  /** the fileKeys the resolver pinned down (may be partial when not confident). */
  files: string[];
}

/**
 * Resolve each ticket's file-set through the **same** path `campaign-plan` uses —
 * `cfg.fileSet ?? defaultFileSet()` less its waived files (`waiveFileSet`), over
 * `ticketProse ∘ fetchTask` — and report the
 * resolver's verdict per id. Because it calls the identical resolver rather than a
 * restatement of it, `campaign --dry-run` and the planner agree by construction: a ticket
 * this reports `confident: false` is exactly one the planner would halt on. Used by
 * the `/fileset` sweep to decide "already marked" (skip) only when the marker truly
 * resolves. Pure over the injected `fetchTask`/`fileSet`; the tree read lives in the
 * resolver.
 */
export async function runFilesetCheck(cfg: CampaignPlanConfig, ids: string[]): Promise<FilesetCheckResult[]> {
  if (!ids.length) throw new Refusal("campaign --dry-run needs at least one ticket id: campaign --dry-run 201 173");
  const resolveFileSet = waiveFileSet(cfg.fileSet ?? defaultFileSet(), cfg.waivedFiles);
  return Promise.all(
    uniqueOrder(ids).map(async (id) => {
      const { files, confident } = await resolveFileSet(ticketProse(String(await cfg.fetchTask(id))));
      return { id, confident, files };
    }),
  );
}

/**
 * Render `runFilesetCheck`'s results one line per ticket: a confident ticket lists
 * the fileKeys the resolver pinned down; a not-confident one says `campaign-plan`
 * would halt on it (naming any partial cites resolved so far). A one-issue selection
 * (a single result) says the check is skipped instead, since `planCampaign` runs a
 * lone ticket without it. Plain text for the terminal and for the `/fileset` sweep to
 * read.
 */
export function describeFilesetCheck(results: FilesetCheckResult[]): string {
  const unconfident =
    results.length === 1 ? "check skipped for a one-issue selection (would halt beside other tickets)" : "campaign would halt (planning)";
  return results
    .map((r) => {
      const cites = r.files.map((f) => `\`${f}\``).join(", ");
      return r.confident
        ? `#${r.id}  confident — ${cites}`
        : `#${r.id}  NOT confident — ${unconfident}` + (r.files.length ? ` (resolved so far: ${cites})` : "");
    })
    .join("\n");
}
