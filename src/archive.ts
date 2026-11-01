import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import { campaignSettled, campaignStarted } from "./campaign-fold.ts";
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
    // Fresh, empty — buildStatus reads the log as idle. Append mode creates it without
    // truncating, so a row another process appended since the move survives.
    writeFileSync(cfg.logFile, "", { flag: "a" });
  }

  const clearedOutbound = clearSentOutbound(cfg);

  return { archivedLog, clearedOutbound };
}

/** How long a gate, agent, activity or dashboard-action log may go unwritten before an archive sweeps it. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The per-run log names in `logs/` the sweep may delete (`writeGateLog`, `agentLogPath`, `activityLogPath`). */
const SWEPT_RUN_LOG_NAME = /^(gate-.*\.log|agent-.*\.log|activity-.*\.jsonl)$/;
/** The dashboard-action logs in `logs/dashboard/` the sweep may delete (`<verb>-<ts>.log`). */
const SWEPT_DASHBOARD_LOG_NAME = /\.log$/;

/**
 * Delete the project's per-run logs not written for `LOG_RETENTION_MS`, returning how many
 * went. Only `gate-*.log`, `agent-*.log` and `activity-*.jsonl` directly in `logs/`, and
 * `*.log` directly in `logs/dashboard/`, are candidates; `orchestrator.jsonl`,
 * `logs/archive/` (archives are kept forever) and any other file are never touched.
 * Best-effort: a file that can't be stat'ed or unlinked is skipped and a missing directory
 * reads 0, so it never throws and can never fail an archive.
 */
export function sweepOldLogs(stateDir: string, now: number = Date.now()): number {
  const cutoff = now - LOG_RETENTION_MS;
  return (
    sweepLogDir(`${stateDir}/logs`, SWEPT_RUN_LOG_NAME, cutoff) +
    sweepLogDir(`${stateDir}/logs/dashboard`, SWEPT_DASHBOARD_LOG_NAME, cutoff)
  );
}

/** Unlink each file directly in `dir` whose name matches `pattern` and whose mtime is before `cutoff`. */
function sweepLogDir(dir: string, pattern: RegExp, cutoff: number): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = `${dir}/${name}`;
    try {
      const st = statSync(path);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      unlinkSync(path);
      swept++;
    } catch {
      // vanished or unremovable mid-sweep — skip it
    }
  }
  return swept;
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
  return readEventLog(cfg).some((e) => e.event === "campaign-start" || e.event === "spawn");
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
export function shouldArchiveLeftover(cfg: Pick<ResolvedConfig, "logFile">, opts: { isChild: boolean }): boolean {
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
export function shouldArchiveIdle(events: OrchestratorEvent[], opts: { parked: number }): boolean {
  if (opts.parked > 0) return false;
  if (campaignStarted(events) && !campaignSettled(events)) return false;
  return true;
}
