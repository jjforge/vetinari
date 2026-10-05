import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ResolvedConfig } from "./config.ts";
import { hostLogger, type Logger } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord, type ParkReason } from "./state.ts";
import { projectHasLiveCampaign } from "./host-slots.ts";
import { readEventLog, type OrchestratorEvent } from "./event-log.ts";
import { normalize } from "./issue-id.ts";
import { extractParkedDetails, issueNameFromTask } from "./dashboard-event-text.ts";
import {
  type DisplayStatus,
  type IssuePhase,
  type Membership,
  type WaveStatus,
  issueLifecycle,
  issueMembership,
  issuePhase,
  parkReasonFromEvent,
  reduceCampaign,
  waveState,
} from "./dashboard-lifecycle.ts";

/**
 * The base branch a redrive would land on, read live from the project checkout's current
 * branch (design §7, §11) — the impure git edge the Redrive confirm dialog names. The dumb
 * router (ADR 0002) holds no project config to read `baseBranch` from, so it reads the tree:
 * a stopped campaign — the only time Redrive enables — sits on its base (the loop merges onto
 * and refuses off base, §5), so HEAD is the base at rest. A non-repo root or a detached/failed
 * read yields `undefined` (the git call is silenced and never throws), and the dialog then
 * says "the base branch" rather than a broken value.
 */
export function baseBranchForProject(projectRoot: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface StatusIssue {
  issueNumber: string;
  /** the issue's lifecycle state — the dot/word the chip paints (ADR 0019). */
  status: DisplayStatus;
  /** why it is `parked`, when it is — selects the recovery affordance, not a word. */
  reason?: ParkReason;
  /** the orthogonal membership axis — the badge the chip carries. Absent reads as a
   * plain `member` (the common case), so only a `grafted`/`pruned` chip sets it. */
  membership?: Membership;
  /** true when this `running` chip is a green awaiting merge (design §2.2): it went green but
   * has not banked on the base, so its agent slot is already freed — the live tail must not
   * follow it as an in-flight runner. Absent for a genuinely slot-holding `running` chip. */
  pendingGreen?: boolean;
  /** the step this `running` issue is currently in (design §11, {@link issuePhase}) — the word
   * shown in place of `running` on the row, and whether the dot holds steady. Set only for a
   * live `running` chip; absent for every other lifecycle (they keep their word and no phase). */
  phase?: IssuePhase;
  name?: string;
  detail?: string;
}

export interface StatusWave {
  index: number;
  status: WaveStatus;
  /** why the wave is `parked`, when the hold is a wave-level one: `red-base`, the
   * combined-gate park on a red merged base (design §2.3). It is the *wave's* reason,
   * not any member's — the members keep their own lifecycle. Absent otherwise; a wave
   * parked only because a member is held carries no wave reason (the member has it). */
  reason?: ParkReason;
  /** whether the wave has actually *closed* — the reducer's `closedWaves` membership,
   * carried onto the display wave (derived at render from the event log, so §2.1's
   * no-stored-presentation-state rule is untouched). Set only by `wave-done` and only when
   * no member is conflict-parked, so it lags `status === "completed"`: a wave whose last
   * member merged reads `completed` while its wave-level gates still run, but stays `closed:
   * false` until `wave-done` lands. The renderer keys the collapse-into-chip affordance on
   * this, not on the status word, so a still-integrating wave stays an expanded card. Absent
   * on a hand-built status (reads as not-closed). */
  closed?: boolean;
  issues: StatusIssue[];
}

export interface ParkedIssue {
  issueNumber: string;
  reason: string;
  parkedAt: string;
  branch: string;
  description: string;
  options: string[];
}

export interface CampaignStatus {
  project: string;
  /** the run's optional `--name`, shown as the header label; absent when unnamed. */
  name?: string;
  /** the festive-name offset for this campaign (#193), derived at render from its
   * `campaign-start` timestamp ({@link festiveOffsetFor}); wave `i` renders as
   * `festiveWaveName(festiveOffset, i)` when festive wave names are on. Absent for a run
   * with no `campaign-start`, which then renders nameless under festive. */
  festiveOffset?: number;
  waves: StatusWave[];
  parked: ParkedIssue[];
  /** the issue ids of the wave currently in flight — the reducer's `currentWave` (design §11):
   * what the live tail follows so it lists the slot-holders of the one wave the loop is draining,
   * never a member still reading `running` in a wave that has advanced or one not yet in flight (a
   * racy/partial log leaves such ghosts). An empty array means no wave is in flight; the field is
   * absent only on a hand-built status, where {@link inFlightRunning} falls back to every runner. */
  inFlight?: string[];
  /** whether a stop is pending on the latest campaign ({@link stopPending}) — `vetinari stop` asked
   * it to stop after the wave in flight and it has not yet parked. Absent reads as false, like
   * `inFlight` on a hand-built status. */
  stopPending?: boolean;
}

// Issue titles rarely change during a campaign, so we cache them for the process
// lifetime; a rename won't surface until the status server restarts.
const issueNameCache = new Map<string, string | undefined>();

/**
 * The one rule for which parked records count (#379) — the project page (`buildStatus`) and
 * the landing (its card and cross-repo queue, off `status.parked`) both read it, so the two
 * surfaces never disagree. A record counts when its issue is in the current campaign's plan
 * (the reducer's pruned loop-facing `waves`, folded from the latest `campaign-start` only, so a
 * superseded campaign's records drop out), not in a closed wave, and its issue has not merged —
 * `completed` is terminal (design §2.2), so a record that outlived a since-merged issue is a
 * stale straggler, not a park (#465). An empty plan — the live
 * log archived or emptied — keeps every surviving record, so a park that outlived its log
 * still counts (#232).
 */
const parkedInCurrentPlan = (
  records: ParkedRecord[],
  plan: { waves: string[][]; closedWaves: Set<number>; outcomes: Map<string, string> },
): ParkedRecord[] => {
  const activeIssueNumbers = new Set(plan.waves.flat());
  const closedIssueNumbers = new Set([...plan.closedWaves].flatMap((index) => plan.waves[index] ?? []));
  return records.filter((parked) => {
    const issueNumber = normalize(parked.taskId);
    return (
      (!activeIssueNumbers.size || activeIssueNumbers.has(issueNumber)) &&
      !closedIssueNumbers.has(issueNumber) &&
      plan.outcomes.get(issueNumber) !== "completed"
    );
  });
};

/**
 * Reconstruct a project's live campaign status off its event log (ADR 0005/0019).
 * Each chip composes the two orthogonal axes — its `issueLifecycle` (the dot/word) and
 * `issueMembership` (the badge) — and each wave's status is the pure `waveState` fold of
 * its members, so a wave with a red member reads `failed` and a held wave reads `parked`
 * by construction (no render-time precedence). Liveness feeds crash detection (design §7):
 * `dead` marks a run whose process is gone (an archived read) and `alive` carries the live
 * host-slot probe (`projectHasLiveCampaign`); either way an `alive === false` run with no
 * terminal stop marker since the latest `wave-start` reconciles its still-`running` issues
 * to `parked{crash}` inside the
 * reducer. Omitting both leaves the live default — `running` stays `running`.
 */
export function buildStatus(cfg: ResolvedConfig, opts: { dead?: boolean; alive?: boolean } = {}): CampaignStatus {
  const events = readEventLog(cfg);
  // An archived read is dead by definition; a live read passes the slot-lease probe. The
  // reducer folds an in-flight `running` issue of a dead run to `parked{crash}` (§7, §15).
  const alive = opts.dead ? false : opts.alive;
  const reduced = reduceCampaign(events, { alive });
  const { waves, layout, name, festiveOffset, outcomes, details, titles, closedWaves } = reduced;

  const closedIssueNumbers = new Set([...closedWaves].flatMap((index) => waves[index] ?? []));
  const parkedRecords = parkedInCurrentPlan(listParked(cfg), { waves, closedWaves, outcomes });
  for (const parked of parkedRecords) {
    const taskId = normalize(parked.taskId);
    outcomes.set(taskId, "parked");
    reduced.parkReasons.set(taskId, parkReasonFromEvent(parked.reason));
    details.set(taskId, `Parked: ${parked.reason}`);
  }

  // Display waves render off `layout` (the pre-prune membership) so a pruned issue still
  // shows as a chip in the wave it left (ADR 0007). Each chip carries both axes; the wave's
  // own status is the pure fold of its members (`waveState`), pruned members excluded. A
  // crashed run's in-flight issues already read `parked{crash}` off the reducer above.
  const displayWaves = layout.map((wave, index) => {
    const issues = wave.map((issueNumber): StatusIssue => {
      const life = issueLifecycle(reduced, issueNumber);
      // A live `running` issue carries its phase (design §11, #359) — the step it is in, derived
      // from its latest event. An archived read (`dead`) renders no phases, so it is skipped there.
      const phase = !opts.dead && life.state === "running" ? issuePhase(events, issueNumber) : undefined;
      return {
        issueNumber,
        status: life.state,
        ...(life.reason ? { reason: life.reason } : {}),
        membership: issueMembership(reduced, issueNumber),
        ...(reduced.pendingGreen.has(issueNumber) ? { pendingGreen: true } : {}),
        ...(phase ? { phase } : {}),
        name: titles.get(issueNumber),
        detail: details.get(issueNumber),
      };
    });
    // A red-base wave-park is the wave's own reason (design §2.3): its members keep their
    // lifecycle (a merged member stays completed), so the hold shows only on the wave.
    const redBase = wave.some((issueNumber) => reduced.redBase.has(issueNumber));
    // An operator stop is likewise the wave's own hold, shown only on the wave.
    const stopped = wave.some((issueNumber) => reduced.stopped.has(issueNumber));
    const waveReason: ParkReason | undefined = redBase ? "red-base" : stopped ? "stopped" : undefined;
    // `closed` is the reducer's `closedWaves` membership carried onto the display wave —
    // the wave actually closed (its gates ran and `wave-done` logged, with no conflict-parked
    // member), which lags the `completed` fold. Keyed on member id (via `closedIssueNumbers`)
    // rather than `wave.index`, because `closedWaves` indexes the pruned loop-facing `waves`
    // while these display waves index `layout` — a mid-campaign prune that empties a wave
    // makes the two indices diverge, but the member ids never lie. The renderer collapses
    // on this, never on the status word. A pruned member left the loop-facing plan and so
    // never appears in `closedWaves`; skip it, exactly as `waveState` does, or a wave whose
    // surviving members all closed could never satisfy the fold (ADR 0007, #363).
    const live = issues.filter((i) => i.membership !== "pruned");
    const closed = live.length > 0 && live.every((i) => closedIssueNumbers.has(i.issueNumber));
    return { index, status: waveState(issues, { redBase, stopped }), ...(waveReason ? { reason: waveReason } : {}), closed, issues };
  });

  return {
    project: cfg.project,
    name,
    festiveOffset,
    waves: displayWaves,
    parked: parkedRecords.map(toParkedIssue),
    // The wave in flight is the reducer's `currentWave` (design §11); its members are what the
    // live tail follows. Always an array (empty when none is in flight) so the tail scopes rather
    // than falling back to every runner across the plan.
    inFlight: reduced.currentWave >= 0 ? [...(reduced.waves[reduced.currentWave] ?? [])] : [],
    stopPending: stopPending(events),
  };
}

/**
 * Is a stop already pending on the latest campaign? One is when the log carries a `stop-requested`
 * after the latest `campaign-start` with no stop marker (`campaign-parked`/`-failed`/`-done`) after
 * it — the campaign took the request and has not yet parked on it. Pure over the event log; the
 * CLI's `stop` and the dashboard's Stop control both read it.
 */
export function stopPending(events: OrchestratorEvent[]): boolean {
  const start = events.findLastIndex((e) => e.event === "campaign-start");
  const request = events.findLastIndex((e) => e.event === "stop-requested");
  if (request < 0 || request < start) return false;
  return !events.slice(request).some((e) => e.event === "campaign-parked" || e.event === "campaign-failed" || e.event === "campaign-done");
}

export async function buildStatusWithIssueNames(cfg: ResolvedConfig): Promise<CampaignStatus> {
  const status = buildStatus(cfg);
  const issues = status.waves.flatMap((wave) => wave.issues);
  await Promise.all(
    issues.map(async (issue) => {
      const cacheKey = `${cfg.project}:${issue.issueNumber}`;
      if (!issueNameCache.has(cacheKey)) {
        try {
          issueNameCache.set(cacheKey, issueNameFromTask(String(await cfg.fetchTask(issue.issueNumber))));
        } catch {
          issueNameCache.set(cacheKey, undefined);
        }
      }
      issue.name = issueNameCache.get(cacheKey);
    }),
  );
  return status;
}

/** The orchestrator event log inside a project's base location — the file the
 * gateway reads to reconstruct a project's campaign without its TS config. */
export const logFileOf = (baseLocation: string) => join(baseLocation, "logs", "orchestrator.jsonl");

/**
 * The `ResolvedConfig` slice `buildStatus` needs to render one archived run: its
 * log is the archive file, and its `parkedDir` points at the archive directory —
 * which holds only `orchestrator-*.jsonl`, never parked `*.json` — so `listParked`
 * reads empty and the archived render carries no parked cards (read-only).
 */
export const archiveStatusConfig = (project: string, archiveFile: string): ResolvedConfig =>
  ({
    project,
    stateDir: dirname(archiveFile),
    parkedDir: dirname(archiveFile),
    logFile: archiveFile,
  }) as ResolvedConfig;

/** The `ResolvedConfig` slice a registry pointer resolves to — the paths a full config's
 * `loadConfig` would derive from its base location (ADR 0002). The gateway never imports a
 * project's TS config; it reads the same state files (`logs/`, `parked/`) the run wrote under
 * the base location. Exported so the live-update
 * route can build a project's `buildLiveTail`/`buildStatus` off its pointer without its TS
 * config, exactly as `buildAllStatus` does internally. */
export const statusConfigFromPointer = (pointer: ProjectPointer): ResolvedConfig =>
  ({
    project: pointer.project,
    stateDir: pointer.baseLocation,
    parkedDir: parkedDirOf(pointer.baseLocation),
    logFile: logFileOf(pointer.baseLocation),
  }) as ResolvedConfig;

/**
 * Build the campaign status for every registered project, reading each project's
 * state live from its base location. A project whose base location is missing
 * (moved or deleted since it registered) is skipped with a log line, never
 * throwing — one stale registration must not take the whole dashboard down (ADR
 * 0002). Uses the pure `buildStatus`, so issue names are not resolved here (that
 * needs the project's own `fetchTask`); the aggregated view is names-free. `configDir`
 * (the gateway config dir) enables live crash detection (design §7): each project's
 * host-slot lease is probed for liveness so a run that died with no verdict folds to
 * `parked{crash}`. Omitted (a pure caller with no lease to reach), the live default holds.
 */
export function buildAllStatus(pointers: ProjectPointer[], logger: Logger = hostLogger(), configDir?: string): CampaignStatus[] {
  const statuses: CampaignStatus[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const alive = configDir !== undefined ? projectHasLiveCampaign(configDir, pointer.project) : undefined;
    statuses.push(buildStatus(statusConfigFromPointer(pointer), { alive }));
  }
  return statuses;
}

const toParkedIssue = (rec: ParkedRecord): ParkedIssue => {
  const details = extractParkedDetails(rec.question);
  return {
    issueNumber: normalize(rec.taskId),
    reason: rec.reason,
    parkedAt: rec.parkedAt,
    branch: rec.branch,
    ...details,
  };
};

/**
 * Which project the aggregated view shows: the one named in the request, or the
 * first registered project when none is named (or the name is stale). Never
 * undefined given at least one project — the page always shows something useful
 * on a bare open. Callers guard the empty-registry case before calling.
 */
export function selectStatus(statuses: CampaignStatus[], requested?: string): CampaignStatus {
  return statuses.find((s) => s.project === requested) ?? statuses[0];
}
