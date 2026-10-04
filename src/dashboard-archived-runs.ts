import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostLogger, type Logger } from "./log.ts";
import { readEventLog, type OrchestratorEvent } from "./event-log.ts";
import { reduceCampaign } from "./dashboard-lifecycle.ts";

/** An archived run's terminal disposition for the archived-runs list: `complete`
 * when its latest campaign reached the terminal `campaign-done`/`queue-done` (a
 * full, clean finish), else `stalled` — the run stopped with no terminal event
 * (killed mid-wave, a crash), the coarse run-level word for the archived list. A
 * stalled run still expands to the waves that did run; its in-flight issues, dead with
 * no verdict, fold to `parked{crash}` when read back (`buildStatus({ dead: true })`,
 * design §7). */
export type ArchivedRunState = "complete" | "stalled";

/**
 * A run's terminal disposition, scoped to the latest `campaign-start` like the
 * rest of the reducer (#69) so a superseded earlier run never decides it — a run
 * is `complete` once it lands its `campaign-done` marker.
 */
export function archivedRunState(events: OrchestratorEvent[]): ArchivedRunState {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = start >= 0 ? events.slice(start) : events;
  return relevant.some((e) => e.event === "campaign-done") ? "complete" : "stalled";
}

/**
 * The ISO timestamp a run token encodes, or undefined when it doesn't parse.
 * `archiveRun` writes the token as `new Date().toISOString().replace(/[:.]/g, "-")`,
 * so `2026-08-23T22-22-36-267Z` reverses to `2026-08-23T22:22:36.267Z` — only the
 * time's `:`/`.` were flattened to `-`, the date keeps its own. An older token
 * written without the milliseconds or the trailing `Z` still parses (ms → `.000`).
 */
export function parseRunTimestamp(run: string): string | undefined {
  const m = run.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z?$/);
  if (!m) return undefined;
  const [, date, h, mi, s, ms] = m;
  const iso = `${date}T${h}:${mi}:${s}.${ms ?? "000"}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** The archive-token form of an ISO timestamp — the inverse of {@link parseRunTimestamp}:
 * flatten only the time's `:`/`.` to `-`, exactly as `archiveRun` writes a run's token
 * (`new Date().toISOString().replace(/[:.]/g, "-")`). The date keeps its own `-`. Used to
 * mint a `lastRun` token for a finished campaign still living in the live log — never
 * archived, so with no token of its own (design §11). */
export const runTokenFor = (iso: string): string => iso.replace(/[:.]/g, "-");

/** The latest event timestamp in a log — the finish stamp of the run it records. Undefined
 * when no event carries a `ts`. */
export const lastEventStamp = (events: OrchestratorEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) if (typeof events[i].ts === "string") return events[i].ts as string;
  return undefined;
};

/** An archived run addressable in the dashboard: its timestamp token (`run`), the
 * resolved log path, and a one-line summary of what it did. The token is the only
 * thing a request supplies; `file` is resolved from the listing, never joined from
 * request input, so there is no path to traverse. */
export interface ArchivedRun {
  run: string;
  file: string;
  summary: string;
  /** the run's `--name`, when it was launched with one — the list's primary label
   * (it falls back to the `run` timestamp token when absent). */
  name?: string;
  /** whether the run finished clean (`complete`) or was cut short (`stalled`);
   * a stalled row still expands to the partial waves recorded before it stopped. */
  state: ArchivedRunState;
  /** the run's start time as an ISO timestamp, parsed from its `run` token; undefined
   * for a token that doesn't parse (so the row falls back to the token verbatim). */
  startedAt?: string;
  /** how many issues the run's plan spanned (its full pre-prune membership, so a
   * pruned-out issue still counts — it renders as a chip in the expanded view). */
  issues: number;
}

/** The directory a project's finished-run logs are archived into (mirrors
 * `archiveRun`'s own `logs/archive` layout). */
const archiveDirOf = (baseLocation: string) => join(baseLocation, "logs", "archive");

/**
 * List a project's archived runs newest-first, each with the one-line summary
 * `summarizeRun` folds from its log. The timestamp token is read off the
 * `orchestrator-<timestamp>.jsonl` filename `archiveRun` wrote, so it sorts
 * lexicographically into newest-first (ISO stamps are zero-padded). A malformed
 * archive — one no run can be reconstructed from — is skipped with a log line,
 * never fatal: one bad file must not take the whole list down.
 */
export function listArchivedRuns(baseLocation: string, logger: Logger = hostLogger()): ArchivedRun[] {
  const dir = archiveDirOf(baseLocation);
  if (!existsSync(dir)) return [];
  const runs: ArchivedRun[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(/^orchestrator-(.+)\.jsonl$/);
    if (!match) continue;
    const file = join(dir, name);
    const events = readEventLog({ logFile: file });
    const { waves, layout, name: runName } = reduceCampaign(events);
    if (!waves.length) {
      logger.log("status-archive-skipped", { file });
      continue;
    }
    runs.push({
      run: match[1],
      file,
      summary: summarizeRun(events),
      name: runName,
      state: archivedRunState(events),
      startedAt: parseRunTimestamp(match[1]),
      issues: layout.flat().length,
    });
  }
  return runs.sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0));
}

/**
 * Fold one run's event log into a one-line summary for the archived-runs list:
 * its mode (a `campaign` frame vs a bare `queue` run), how many issues it spanned,
 * and whether it finished clean or failed. Failure is derived from an issue reaching
 * `failure` (the agent could not make it green, ADR 0019) — the same `reduceCampaign`
 * plan the dashboard renders, so the summary can never disagree with the run's
 * reconstructed wave/issue view (ADR 0005).
 */
export function summarizeRun(events: OrchestratorEvent[]): string {
  // Everything derives from the run `reduceCampaign` reconstructs (the latest
  // `campaign-start` onward), so a multi-run archive summarizes its terminal run —
  // a failure in a superseded earlier run in the same log no longer reads a
  // completed run as failed (#69).
  const { waves, outcomes } = reduceCampaign(events);
  const mode = events.some((e) => e.event === "campaign-start") ? "campaign" : "queue";
  const count = waves.flat().length;
  const failed = [...outcomes.values()].includes("failed");
  return `${mode} · ${count} issue${count === 1 ? "" : "s"} · ${failed ? "failed" : "complete"}`;
}
