/**
 * The `replan` command seam: recompute the waves of a running (or resumable) campaign's
 * **unstarted** members from the current config and tracker, and record the result as a
 * `replan` event (ADR 0022) — the way `graft` records a graft (ADR 0014). Every started wave
 * (any wave that has had a `wave-start`) keeps its index; the in-flight wave is never touched.
 * It never adds or removes a member: adding stays `graft`'s job, removing stays `prune`'s.
 *
 * Placement reuses the planner's pieces (`layerWaves`, then `placeByCollisions`) rather than
 * `planCampaign`, which drops unreachable and under-specified issues silently, words its
 * refusals for `campaign`, and skips the file-set check for one issue. A re-plan instead
 * refuses whole, naming every offender, and logs nothing.
 *
 * The event stores the result, not the inputs, so replaying an old log after a future planner
 * change still folds the plan the campaign ran (ADR 0012). A live loop picks it up when it
 * re-folds the log at the next wave boundary; a stopped campaign's next `redrive` runs it.
 */
import type { ResolvedConfig } from "./config.ts";
import { Refusal } from "./refusal.ts";
import { normalize } from "./issue-id.ts";
import { layerWaves, placeByCollisions } from "./plan.ts";
import { campaignRunning, reduceCampaign } from "./dashboard-model.ts";
import { readEventLog } from "./event-log.ts";
import { defaultFileSet, ticketProse, waiveFileSet } from "./fileset.ts";

/** The events that change the plan a re-plan was computed against. */
const PLAN_CHANGING: ReadonlySet<string> = new Set(["graft", "prune", "wave-start", "replan"]);

export interface ReplanOptions {
  /** print the current and new remaining waves but append nothing. */
  dryRun?: boolean;
}

/** The impure edge `runReplan` leans on — the on-disk event log read — injected so the
 * write-time check is drivable with a stub. The tracker edges stay on `cfg`, as in `graft`. */
export interface ReplanDeps {
  readEventLog: typeof readEventLog;
}
export const defaultReplanDeps: ReplanDeps = { readEventLog };

export interface ReplanResult {
  /** how many leading waves have started — the fixed prefix; the new waves number after it. */
  started: number;
  /** the unstarted remainder as it was planned before this re-plan. */
  current: string[][];
  /** the re-planned unstarted remainder — what the `replan` event carries. */
  next: string[][];
  /** true when the re-plan equals the current remainder: nothing is logged. */
  unchanged: boolean;
  /** true once the `replan` event is appended; false on a `--dry-run` or an unchanged plan. */
  applied: boolean;
}

/**
 * Re-plan the unstarted remainder of the open campaign. Throws a `Refusal` (nothing logged)
 * when no campaign is unfinished, when any unstarted issue's file set is no longer confident
 * or it has an open blocker outside the campaign, when unstarted issues' blockers form a cycle, or
 * when the plan changed while re-planning.
 */
export async function runReplan(
  cfg: ResolvedConfig,
  opts: ReplanOptions = {},
  deps: ReplanDeps = defaultReplanDeps,
): Promise<ReplanResult> {
  if (!cfg.blockedBy)
    throw new Refusal('replan needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").');
  const events = deps.readEventLog(cfg);
  if (!campaignRunning(events))
    throw new Refusal(
      "replan re-plans an unfinished campaign, but there is no unfinished campaign here. " +
        "Launch one with `campaign <ids…>`; a stopped or parked one can be re-planned before its `redrive`.",
    );
  const reduced = reduceCampaign(events);
  const started = reduced.startedWaves;
  const current = reduced.waves.slice(started);
  const unstarted = current.flat();

  // A blocker that has started (or merged) in this campaign is satisfied — every unstarted
  // wave runs after it — so strip it before layering, or it would read as external.
  const startedIds = new Set(reduced.waves.slice(0, started).flat());
  const blockedBy = cfg.blockedBy;
  // `layerWaves`' only Refusal is a blocker cycle, worded for `campaign`; re-word it as replan's.
  const layered = await layerWaves(unstarted, async (id) => (await blockedBy(id)).filter((b) => !startedIds.has(normalize(b)))).catch(
    (err: unknown) => {
      if (!(err instanceof Refusal)) throw err;
      throw new Refusal(`replan refused — nothing logged:\n  ${err.message.replace(/^campaign: /, "").replace(/\.$/, "")}`);
    },
  );

  const resolveFileSet = waiveFileSet(cfg.fileSet ?? defaultFileSet(), cfg.waivedFiles);
  const fileKeys = new Map<string, Set<string>>();
  const underspecified = new Set<string>();
  await Promise.all(
    unstarted.map(async (id) => {
      const set = await resolveFileSet(ticketProse(String(await cfg.fetchTask(id))));
      fileKeys.set(id, new Set(set.files));
      if (!set.confident) underspecified.add(id);
    }),
  );

  // All-or-nothing: name every offender and log nothing, never re-plan around one.
  const offenders = [
    ...unstarted
      .filter((id) => underspecified.has(id))
      .map((id) => `#${id} has no confident file set — fix its Touches:/Creates: marker, or \`prune ${id}\``),
    ...layered.unreachable
      .filter((u) => u.external.length)
      .map(
        (u) =>
          `#${u.id} is blocked by ${u.external.map((b) => `#${b}`).join(", ")}, open and outside the campaign — ` +
          `\`graft ${u.external.join(" ")}\`, or \`prune ${u.id}\``,
      ),
  ];
  if (offenders.length) throw new Refusal(`replan refused — nothing logged:\n  ${offenders.join("\n  ")}`);

  const next = placeByCollisions(layered, unstarted, fileKeys).waves;
  const unchanged = JSON.stringify(next) === JSON.stringify(current);
  if (unchanged || opts.dryRun) return { started, current, next, unchanged, applied: false };

  // Write-time check: the re-plan was computed off the log as it stood when read. Any event
  // that changed the plan since — a graft, a prune, a wave starting, another replan — makes
  // it stale, so refuse rather than fold a plan computed against a campaign that moved on.
  if (
    deps
      .readEventLog(cfg)
      .slice(events.length)
      .some((e) => PLAN_CHANGING.has(e.event))
  )
    throw new Refusal("the campaign changed while re-planning; run it again");
  cfg.log.log("replan", { waves: next, was: current.length });
  return { started, current, next, unchanged, applied: true };
}

/**
 * The report `replan` prints — the same for a `--dry-run` and an applied re-plan: the current
 * and new remaining plans' wave counts, every issue whose wave changed, and the new remainder.
 * Waves are numbered as the dashboard numbers them: the started waves keep theirs, and the
 * remainder numbers after them. An unchanged plan says only `plan unchanged`.
 */
export function describeReplan(result: ReplanResult): string[] {
  if (result.unchanged) return ["plan unchanged"];
  const span = (waves: string[][]) => {
    const count = `${waves.length} wave${waves.length === 1 ? "" : "s"} remaining`;
    if (!waves.length) return count;
    const first = result.started + 1;
    const last = result.started + waves.length;
    return `${count} (${first === last ? `wave ${first}` : `waves ${first}–${last}`})`;
  };
  const waveOf = (waves: string[][]) => new Map(waves.flatMap((wave, i) => wave.map((id) => [id, result.started + i + 1] as const)));
  const before = waveOf(result.current);
  const after = waveOf(result.next);
  const moved = [...after]
    .filter(([id, wave]) => before.get(id) !== wave)
    .map(([id, wave]) => `  #${id} wave ${before.get(id)} → wave ${wave}`);
  return [
    `current: ${span(result.current)}`,
    `new: ${span(result.next)}`,
    ...moved,
    `remaining campaign: ${result.next.map((wave) => `"${wave.join(" ")}"`).join(" ")}`,
  ];
}
