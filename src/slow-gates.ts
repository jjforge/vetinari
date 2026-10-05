import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEventLog, type GateResultEvent, type OrchestratorEvent } from "./event-log.ts";

/**
 * Slow-gate detection (CONTEXT.md → Slow gate): a gate whose recent green runs take well over its
 * historical median, or that ran over its budget. Information only — nothing here feeds a verdict,
 * a park, an exit code or a campaign outcome.
 *
 * Pure functions over a project's `gate-result` events, keyed by `cmd` (an edited command is a new
 * series), with agent-run and merged-base results pooled. The reference is the median of **all**
 * earlier results, not the last few, so a creep where each campaign is only a little slower than the
 * one before is still caught.
 */

/** Current ≥ this × earlier, and … */
const SLOW_RATIO = 1.5;
/** … current − earlier ≥ this many seconds, for a history flag. */
const SLOW_FLOOR_SECONDS = 30;
/** Fewest earlier green results a history flag needs. */
const MIN_EARLIER_RUNS = 5;
/** Fewest current green results a history flag needs. */
const MIN_CURRENT_RUNS = 3;

/** A gate whose current-campaign green median is well over the median of all its earlier green runs. */
export interface SlowGateHistory {
  cmd: string;
  earlierMedian: number;
  earlierRuns: number;
  currentMedian: number;
  currentRuns: number;
}

/** A gate with a `budgetSeconds` some of whose runs — green or red — took longer than it. */
export interface SlowGateBudget {
  cmd: string;
  /** the budget the latest of those runs logged. */
  budgetSeconds: number;
  /** how many runs went over. */
  over: number;
  /** how many runs carried a budget. */
  runs: number;
}

export interface SlowGates {
  history: SlowGateHistory[];
  budget: SlowGateBudget[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const gateResults = (events: OrchestratorEvent[]): GateResultEvent[] =>
  events.filter((e): e is GateResultEvent => e.event === "gate-result");

/** Green durations per gate `cmd`, in log order. */
const greenSecondsByCmd = (results: GateResultEvent[]): Map<string, number[]> => {
  const by = new Map<string, number[]>();
  for (const r of results) if (r.exitCode === 0) by.set(r.cmd, [...(by.get(r.cmd) ?? []), r.seconds]);
  return by;
};

/** The history flags for `current` measured against `earlier`. */
function historyFlags(earlier: GateResultEvent[], current: GateResultEvent[]): SlowGateHistory[] {
  const before = greenSecondsByCmd(earlier);
  const flags: SlowGateHistory[] = [];
  for (const [cmd, now] of greenSecondsByCmd(current)) {
    const then = before.get(cmd) ?? [];
    if (then.length < MIN_EARLIER_RUNS || now.length < MIN_CURRENT_RUNS) continue;
    const earlierMedian = median(then);
    const currentMedian = median(now);
    if (currentMedian >= SLOW_RATIO * earlierMedian && currentMedian - earlierMedian >= SLOW_FLOOR_SECONDS)
      flags.push({ cmd, earlierMedian, earlierRuns: then.length, currentMedian, currentRuns: now.length });
  }
  return flags;
}

/** The budget overruns among `results`, read off each result's logged `budgetSeconds` — never config. */
function budgetFlags(results: GateResultEvent[]): SlowGateBudget[] {
  const by = new Map<string, SlowGateBudget>();
  for (const r of results) {
    if (r.budgetSeconds === undefined) continue;
    const f = by.get(r.cmd) ?? { cmd: r.cmd, budgetSeconds: r.budgetSeconds, over: 0, runs: 0 };
    by.set(r.cmd, { ...f, budgetSeconds: r.budgetSeconds, runs: f.runs + 1, over: f.over + (r.seconds > r.budgetSeconds ? 1 : 0) });
  }
  return [...by.values()].filter((f) => f.over > 0);
}

/** The markers a wave settle logs: a wave-done, or a campaign stop (park or failure). */
const SETTLE_EVENTS = new Set(["wave-done", "campaign-parked", "campaign-failed"]);

/**
 * The slow-gate lines a wave settle prints. `events` is the project's whole ordered history — every
 * archive oldest-first, then the live log — whose latest `campaign-start` opens the current campaign
 * and whose latest `wave-start` opens the settling wave.
 *
 * A history flag is reported once per gate per campaign, at the first settle where it trips. "Once"
 * is read off the log, not process memory, so a redrive (a new process appending to the same log)
 * keeps it: a flag is dropped when it already tripped at a settle logged before the settling wave began.
 * A budget overrun is reported at every settle whose wave had one: the settling wave's results only.
 */
export function slowGatesAtSettle(events: OrchestratorEvent[]): SlowGates {
  const start = events.findLastIndex((e) => e.event === "campaign-start");
  const waveStart = events.findLastIndex((e) => e.event === "wave-start");
  const earlier = gateResults(start >= 0 ? events.slice(0, start) : []);
  const currentUpTo = (end: number) => gateResults(events.slice(Math.max(start, 0), end));
  const reported = new Set<string>();
  for (let i = Math.max(start, 0); i < waveStart; i++)
    if (SETTLE_EVENTS.has(events[i].event)) for (const f of historyFlags(earlier, currentUpTo(i))) reported.add(f.cmd);
  return {
    history: historyFlags(earlier, currentUpTo(events.length)).filter((f) => !reported.has(f.cmd)),
    budget: budgetFlags(gateResults(events.slice(Math.max(waveStart, 0)))),
  };
}

/**
 * The slow gates of a project's latest campaign, for the dashboard's project page: every history flag
 * and budget overrun across the whole campaign (the page has no settles to dedupe against). The latest
 * campaign is the live log's, from its latest `campaign-start`; with none there (a settled, archived
 * campaign) it is the newest archive's, measured against everything older. `archives` is oldest-first.
 */
export function latestCampaignSlowGates(archives: OrchestratorEvent[][], live: OrchestratorEvent[]): SlowGates {
  const events = live.some((e) => e.event === "campaign-start") ? [...archives.flat(), ...live] : archives.flat();
  const start = events.findLastIndex((e) => e.event === "campaign-start");
  if (start < 0) return { history: [], budget: [] };
  const current = gateResults(events.slice(start));
  return { history: historyFlags(gateResults(events.slice(0, start)), current), budget: budgetFlags(current) };
}

/**
 * A project's gate history as the detection reads it: every archived `logs/archive/orchestrator-*.jsonl`
 * under `stateDir` oldest-first (archives are never deleted; their ISO-stamped names sort by time), and
 * the live log at `logFile`.
 */
export function readSlowGateLogs(stateDir: string, logFile: string): { archives: OrchestratorEvent[][]; live: OrchestratorEvent[] } {
  const dir = join(stateDir, "logs", "archive");
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^orchestrator-.+\.jsonl$/.test(n))
        .sort()
    : [];
  return { archives: names.map((n) => readEventLog({ logFile: join(dir, n) })), live: readEventLog({ logFile }) };
}
