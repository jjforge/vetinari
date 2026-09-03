import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import { campaignSettled, campaignStarted } from "./dashboard-model.ts";
import { readEventLog, type OrchestratorEvent } from "./event-log.ts";
import { clearSentOutbound } from "./state.ts";

export interface ArchiveResult {
  /** Path the run's log was moved to, or undefined when there was nothing to archive. */
  archivedLog?: string;
  /** How many already-sent outbound records were cleared (unsent ones are kept). */
  clearedOutbound: number;
}

/**
 * Reset the live state the dashboard and status line read, so a finished run
 * stops showing as if it were current. The orchestrator log is moved aside to a
 * timestamped archive (history is kept, never deleted) and replaced with an empty
 * file. Parked records are deliberately LEFT ALONE (design §2.5): a record that
 * outlives its run keeps the card off idle (§2.4) and the gateway's reply index
 * intact; records are cleared only by a re-admit/redrive run starting, or an
 * explicit `prune --purge`. Pure filesystem work that returns what it did — the
 * caller logs it, so this never touches the log it just reset.
 */
export function archiveRun(cfg: ResolvedConfig): ArchiveResult {
  let archivedLog: string | undefined;
  if (existsSync(cfg.logFile) && statSync(cfg.logFile).size > 0) {
    const dir = `${cfg.stateDir}/logs/archive`;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    archivedLog = `${dir}/orchestrator-${stamp}.jsonl`;
    renameSync(cfg.logFile, archivedLog);
    writeFileSync(cfg.logFile, ""); // fresh, empty — buildStatus reads the log as idle
  }

  const clearedOutbound = clearSentOutbound(cfg);

  return { archivedLog, clearedOutbound };
}

/**
 * Does the live log still hold a prior run that was never archived? True when it
 * carries a run boundary (`campaign-start`, or a `spawn` — a slot took a task) —
 * the mark of real run events, not the lone `archived` marker a clean end-of-run
 * archive leaves behind. Lets a new run archive a leftover before it appends, so an
 * interruption that bypassed the end-of-run archive (crash, kill) can never
 * concatenate the prior run into the new run's log. A missing or empty log reads false.
 */
export function hasUnarchivedRun(cfg: Pick<ResolvedConfig, "logFile">): boolean {
  return readEventLog(cfg).some(
    (e) => e.event === "campaign-start" || e.event === "spawn",
  );
}

/**
 * Should a starting run archive a leftover before it appends? Only a top-level,
 * user-invoked run/queue/campaign should. A **child** `run` spawned by a
 * queue/campaign (`selfSpawn`, marked `VETINARI_CHILD`) shares the project state
 * dir and would otherwise see its own parent's live `campaign-start` as a leftover
 * and archive the campaign's in-flight log mid-run — leaving `reduceCampaign` no
 * plan to re-derive, so the campaign stops after wave 0 (#150). A child never
 * archives; a top-level run archives a genuine leftover as before (#141).
 */
export function shouldArchiveLeftover(
  cfg: Pick<ResolvedConfig, "logFile">,
  opts: { isChild: boolean },
): boolean {
  return !opts.isChild && hasUnarchivedRun(cfg);
}

/**
 * Should the end-of-run reset archive the live log, or is the run still live? The
 * pure decision behind `archiveIfIdle` (`cli.mts`): true only when the run is
 * *truly over*, so the dashboard and status line stop showing it as current.
 *
 * A run is NOT over — keep the log live — while either:
 *   - something is parked (`opts.parked`): an unanswered question/stall/conflict is
 *     still being resumed, not superseded (the existing check); or
 *   - a campaign has started here but not settled: a campaign that stopped short of
 *     `campaign-done` on a `failed` member or a `red-base` merge writes no per-issue
 *     parked record, so "nothing parked" misreads it as idle and archives it before
 *     `redrive` can find it (#383). "Nothing parked" is not the same test as "truly
 *     over"; an unsettled campaign is exactly the state `redrive` must find in the
 *     live log to recover (design §7, ADR 0019).
 *
 * A campaign that reached `campaign-done` folds to *settled* and still archives at
 * once, as before. A standalone `run`/`answer` (never a `campaign-start`) is decided
 * by the parked check alone, unchanged.
 */
export function shouldArchiveIdle(
  events: OrchestratorEvent[],
  opts: { parked: number },
): boolean {
  if (opts.parked > 0) return false;
  if (campaignStarted(events) && !campaignSettled(events)) return false;
  return true;
}
