import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import { readEventLog } from "./event-log.ts";
import { clearParked, clearSentOutbound, listParked } from "./state.ts";

export interface ArchiveResult {
  /** Path the run's log was moved to, or undefined when there was nothing to archive. */
  archivedLog?: string;
  clearedParked: number;
  /** How many already-sent outbound records were cleared (unsent ones are kept). */
  clearedOutbound: number;
}

/**
 * Reset the live state the dashboard and status line read, so a finished run
 * stops showing as if it were current. The orchestrator log is moved aside to a
 * timestamped archive (history is kept, never deleted) and replaced with an
 * empty file; parked records are cleared. Pure filesystem work that returns what
 * it did — the caller logs it, so this never touches the log it just reset.
 */
export function archiveRun(cfg: ResolvedConfig): ArchiveResult {
  let archivedLog: string | undefined;
  if (existsSync(cfg.logFile) && statSync(cfg.logFile).size > 0) {
    const dir = `${cfg.stateDir}/logs/archive`;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    archivedLog = `${dir}/orchestrator-${stamp}.jsonl`;
    renameSync(cfg.logFile, archivedLog);
    writeFileSync(cfg.logFile, ""); // fresh, empty — buildStatus now reads idle
  }

  const parked = listParked(cfg);
  for (const p of parked) clearParked(cfg, p.taskId);

  const clearedOutbound = clearSentOutbound(cfg);

  return { archivedLog, clearedParked: parked.length, clearedOutbound };
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
