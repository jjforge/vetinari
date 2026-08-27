/**
 * The `graft` command seam: add issues to a running (or resumable) campaign — the
 * additive mirror of `carve` (ADR 0014). Lifted out of `cli.mts`'s inline switch so
 * the orchestration (both guards, the `--dry-run` no-append, the event write, the
 * `progress:graft` enqueue, and the `fetchTask → issueStateFromTask` state chain) is
 * drivable with stubs, exactly as `campaign` is via `CampaignDeps` (#176). The pure
 * placement/validation core already lives in `plan.ts`; this is only the impure
 * orchestration around it.
 *
 * `runGraft` appends a graft event carrying the resolved layering inputs (ADR 0012),
 * which the wave-loop's per-boundary re-derive folds into future waves; the in-flight
 * wave finishes untouched. It returns a structured result (the placement preview plus
 * the event/outbound payloads) so the CLI renders the console output and a test asserts
 * the observable effects without re-parsing prose.
 */
import type { ResolvedConfig } from "./config.ts";
import { normalize } from "./carve.ts";
import {
  applyGraft,
  validateGraftTargets,
  type GraftRejection,
} from "./plan.ts";
import {
  campaignRunning,
  issueStateFromTask,
  reduceCampaign,
} from "./dashboard-model.ts";
import { readEventLog } from "./event-log.ts";
import { enqueueOutbound } from "./state.ts";
import { defaultFileSet, ticketProse } from "./fileset.ts";

export interface GraftOptions {
  /** preview the placement but append nothing — no event, no outbound. */
  dryRun?: boolean;
}

/**
 * The impure module edges `runGraft` leans on, injected so the seam is drivable
 * with stubs (mirroring `defaultCampaignDeps`). The tracker edges — `fetchTask`,
 * `blockedBy`, `fileSet` — stay on `cfg`, exactly as `campaign` reads `fetchTask`
 * off `cfg`; these are the two functions that touch the on-disk event log and outbox.
 */
export interface GraftDeps {
  readEventLog: typeof readEventLog;
  enqueueOutbound: typeof enqueueOutbound;
}
export const defaultGraftDeps: GraftDeps = { readEventLog, enqueueOutbound };

export interface GraftResult {
  /** the grafted ids, normalized, in input order. */
  ids: string[];
  /** each grafted id and the 1-based wave it lands in, in input order. */
  placement: { id: string; wave: number }[];
  /** the resulting loop-facing waves after the graft. */
  remaining: string[][];
  /** the graft event payload (ADR 0012 layering inputs) — written unless `dryRun`. */
  event: { ids: string[]; blockedBy: Record<string, string[]>; basenames: Record<string, string[]> };
  /** the `progress:graft` outbound message — enqueued unless `dryRun`. */
  outbound: { category: "progress"; event: "graft"; text: string };
  /** false for a `--dry-run` (previewed, nothing written); true once appended. */
  applied: boolean;
}

/**
 * Fold a graft into the running campaign. Throws (nothing added) when there are no
 * ids, when no campaign is open, or when any candidate is unknown/closed/already in
 * the campaign — all-or-nothing, never half-applied. On success it previews the
 * placement and, unless `dryRun`, appends the graft event and enqueues a
 * `progress:graft` note.
 */
export async function runGraft(
  cfg: ResolvedConfig,
  ids: string[],
  opts: GraftOptions = {},
  deps: GraftDeps = defaultGraftDeps,
): Promise<GraftResult> {
  const normalized = ids.map(normalize).filter(Boolean);
  if (!normalized.length)
    throw new Error("graft needs at least one issue id: graft 640 655");
  if (!cfg.blockedBy)
    throw new Error(
      'graft needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").',
    );

  const events = deps.readEventLog(cfg);
  if (!campaignRunning(events))
    throw new Error(
      "graft adds to a live-or-resumable campaign, but none is open (it has finished, or none has run). " +
        "Launch one with `campaign <batch…>`, or resume a paused one with `campaign --resume`.",
    );

  const reduced = reduceCampaign(events);
  // "Already in the campaign" = a member of the remaining plan or a completed one —
  // exactly the ids the reduced `waves` still carry (closed waves stay in the plan).
  const inCampaign = new Set(reduced.waves.flat());

  // Resolve each candidate id's task text once, reused for its open/closed state and
  // its file-set. A `fetchTask` that throws (no such issue) reads `unknown`.
  const resolveFileSet = cfg.fileSet ?? defaultFileSet();
  const taskText = new Map<string, string | undefined>();
  await Promise.all(
    normalized.map(async (id) => {
      try {
        taskText.set(id, String(await cfg.fetchTask(id)));
      } catch {
        taskText.set(id, undefined);
      }
    }),
  );
  const stateOf = (id: string): "open" | "closed" | "unknown" => {
    const text = taskText.get(id);
    return text === undefined ? "unknown" : issueStateFromTask(text);
  };

  // All-or-nothing: reject the whole graft naming the offenders, never half-apply.
  const rejections = validateGraftTargets(normalized, { inCampaign, state: stateOf });
  if (rejections.length) {
    const group = (reason: GraftRejection["reason"], label: string) => {
      const hit = rejections.filter((r) => r.reason === reason).map((r) => `#${r.id}`);
      return hit.length ? `${label}: ${hit.join(", ")}` : "";
    };
    const parts = [
      group("unknown", "unknown/missing"),
      group("closed", "closed"),
      group("already-in-campaign", "already in the campaign"),
    ].filter(Boolean);
    throw new Error(`graft rejected — nothing added (${parts.join("; ")}).`);
  }

  // The layering inputs the pure reducer folds with (ADR 0012): each grafted id's
  // in-campaign (or co-grafted) open blockers, and the basenames of the grafted ids
  // plus the campaign's still-unstarted members it places disjointly against.
  const campaignPlusGrafted = new Set([...inCampaign, ...normalized]);
  const blockedBy: Record<string, string[]> = {};
  await Promise.all(
    normalized.map(async (id) => {
      const raw = (await cfg.blockedBy!(id)).map(normalize);
      blockedBy[id] = raw.filter((b) => campaignPlusGrafted.has(b));
    }),
  );
  const unstarted = reduced.waves.flat().filter((m) => !reduced.outcomes.has(m));
  const basenames: Record<string, string[]> = {};
  await Promise.all(
    [...new Set([...normalized, ...unstarted])].map(async (id) => {
      const text = taskText.get(id) ?? String(await cfg.fetchTask(id));
      basenames[id] = (await resolveFileSet(ticketProse(text))).files;
    }),
  );

  // Preview the placement off the same pure fold the loop will run.
  const applied = applyGraft(
    { waves: reduced.waves, outcomes: reduced.outcomes, currentWave: reduced.currentWave },
    { ids: normalized, blockedBy, basenames },
  );
  const placeOf = new Map<string, number>();
  applied.remaining.forEach((wave, i) => wave.forEach((m) => placeOf.set(m, i)));
  const placement = normalized.map((id) => ({ id, wave: placeOf.get(id)! + 1 }));

  const event = { ids: normalized, blockedBy, basenames };
  const outbound = {
    category: "progress" as const,
    event: "graft" as const,
    text:
      `🌱 ${cfg.project} grafted ${normalized.map((i) => `#${i}`).join(", ")} onto the running campaign — ` +
      `landing in ${placement.map((p) => `#${p.id}→wave ${p.wave}`).join(", ")}.`,
  };

  const result: GraftResult = {
    ids: normalized,
    placement,
    remaining: applied.remaining,
    event,
    outbound,
    applied: !opts.dryRun,
  };

  if (opts.dryRun) return result;

  // Append the graft event — the running loop re-reads it at the next wave boundary
  // and re-layers the added issues into future waves (ADR 0014).
  cfg.log.log("graft", event);
  deps.enqueueOutbound(cfg, outbound);
  return result;
}
