import { campaignState, type IssueStatus, type WaveStatus } from "./campaign-fold.ts";

/**
 * The one park-reason enum (design §2.3), the reason on the parked record, the
 * `parked` event, the reducer, the gateway and the dashboard. `detail` carries the
 * specifics — which `stalled` (budget / idle / no-commit), the conflict output, the
 * gate tail — so the reason itself stays a small closed set:
 * - `question` — the run loop hit `BLOCKED`; an answer resumes it.
 * - `stalled`  — turn budget, idle timeout, or an empty `COMPLETE`; an answer guides it.
 * - `conflict` — the integrator hit a merge conflict; a human resolves and redrives.
 * - `red-base` — the merged base gated red; fix-forward or prune, then redrive.
 * - `crash`    — reconciliation found a dead run with no stop marker since the latest `wave-start`; redrive.
 * - `stopped`  — a person stopped the run (SIGINT/SIGTERM, or SIGHUP from a closed terminal) before it
 *   reached a verdict; its work is kept. It cannot be answered — `vetinari run <id>` continues a
 *   standalone run, a redrive a campaign.
 * - `outdated-agent` — the agent CLI is too old for the model; update the agent CLI (`vetinari
 *   build` for the default Docker image), then redrive. Like `stopped`, it cannot be answered.
 */
export type ParkReason = "question" | "stalled" | "conflict" | "red-base" | "crash" | "stopped" | "outdated-agent";

/**
 * Everything a surface needs to know about one park reason (glossary **Answerable park** /
 * **Redrive-only park**). Each move is a lower-case phrase with no trailing period, commands in
 * backticks, `<id>` where the issue id belongs; render it with {@link recoverySentence}.
 */
export interface ParkReasonFacts {
  /** a reply resumes it (`question`, `stalled`); every other reason is a redrive-only park. */
  answerable: boolean;
  /** the park asks the human nothing (#444): never announced per issue, no grace wait, and its
   * record is consumed when the run next starts — a redrive (or `vetinari run <id>`) re-runs it. */
  asksNothing: boolean;
  /** the park leaves a per-issue parked record; `red-base`/`crash` write none (`src/archive.ts`),
   * so only the campaign's own fold sees them ({@link campaignParkHold}). */
  writesParkedRecord: boolean;
  /** the move one parked issue asks of the human (user guide park reasons, #578). */
  issueMove: string;
  /** the move when the whole campaign is held and no issue is named (the `parked` listing,
   * `/status`) — so a `stopped` campaign never prints `vetinari run <id>` with a blank id (#403). */
  campaignMove: string;
}

/**
 * The one table of park-reason facts — read by the CLI, the gateway, the run loop, the campaign
 * report, the merge record and the dashboard sheet, so no surface can drift from another. Keyed by
 * `ParkReason`, so a new reason does not compile until every fact is filled in.
 */
export const PARK_REASON_FACTS: Record<ParkReason, ParkReasonFacts> = {
  question: { answerable: true, asksNothing: false, writesParkedRecord: true, issueMove: "answer it", campaignMove: "answer it" },
  stalled: {
    answerable: true,
    asksNothing: false,
    writesParkedRecord: true,
    issueMove: "read the turn log, then answer with guidance or `vetinari prune <id>`",
    campaignMove: "read the turn log, then answer with guidance or `vetinari prune <id>`",
  },
  conflict: {
    answerable: false,
    asksNothing: false,
    writesParkedRecord: true,
    issueMove: "resolve the conflict on the base, then `vetinari redrive`",
    campaignMove: "resolve the conflict on the base, then `vetinari redrive`",
  },
  "red-base": {
    answerable: false,
    asksNothing: false,
    writesParkedRecord: false,
    issueMove: "fix forward on the base, then `vetinari redrive`",
    campaignMove: "fix forward on the base, then `vetinari redrive`",
  },
  crash: {
    answerable: false,
    asksNothing: false,
    writesParkedRecord: false,
    issueMove: "`vetinari redrive`",
    campaignMove: "`vetinari redrive`",
  },
  stopped: {
    answerable: false,
    asksNothing: true,
    writesParkedRecord: true,
    issueMove: "`vetinari redrive` to resume the campaign, or `vetinari run <id>` for a standalone run",
    campaignMove: "`vetinari redrive` to resume it",
  },
  "outdated-agent": {
    answerable: false,
    asksNothing: true,
    writesParkedRecord: true,
    issueMove: "update the agent CLI in the project's sandbox (`vetinari build` for the default Docker image), then `vetinari redrive`",
    campaignMove: "update the agent CLI in the project's sandbox (`vetinari build` for the default Docker image), then `vetinari redrive`",
  },
};

/**
 * A park move as a sentence about one issue: `<id>` replaced by `issue`, the first letter
 * upper-cased (a leading backtick is left as is), and a closing period.
 *
 * Shipped to the dashboard via `.toString()` like `reasonWord`, so it must stay
 * self-contained: no imports, no closures over module scope.
 */
export function recoverySentence(move: string, issue: string): string {
  const named = move.split("<id>").join(issue);
  return named.charAt(0).toUpperCase() + named.slice(1) + ".";
}

/**
 * The campaign as {@link campaignParkHold} reads it: its waves (a pruned one flagged, as the
 * display waves carry it) with each wave's own hold and its members' lifecycles, and the parked
 * records still held in the current plan. A `CampaignStatus` is one as it stands; the CLI builds
 * one from `reduceCampaign`.
 */
export interface ParkHoldCampaign {
  waves: readonly {
    status: WaveStatus;
    reason?: ParkReason;
    pruned?: boolean;
    issues: readonly { status: IssueStatus; reason?: ParkReason }[];
  }[];
  /** the in-plan parked records still held on a human — answered parks a live campaign will
   * re-admit are not among them. Only their presence is read. */
  parked: readonly unknown[];
}

/**
 * The redrive-only reason a parked campaign is held on when no parked record is listed — so a
 * surface that lists only the records (`vetinari parked`, `/status`) can name the hold and its
 * campaign-level move instead of misreporting a parked campaign as idle (#391). `red-base`/`crash`
 * write no record at all; a `conflict`/`stopped`/`outdated-agent` record outside the current plan
 * is not listed either. Reads live waves only — a pruned wave is out of the plan — and returns the
 * parked wave's own redrive-only reason, else the first parked member's. Undefined when the
 * campaign does not fold to `parked`, or when any parked record is listed (it names the hold itself).
 */
export function campaignParkHold(campaign: ParkHoldCampaign): ParkReason | undefined {
  if (campaign.parked.length) return undefined;
  const waves = campaign.waves.filter((wave) => !wave.pruned);
  if (campaignState(waves.map((wave) => wave.status)) !== "parked") return undefined;
  const redriveOnly = (reason: ParkReason | undefined): reason is ParkReason =>
    reason !== undefined && !PARK_REASON_FACTS[reason].answerable;
  const waveReason = waves.find((wave) => redriveOnly(wave.reason))?.reason;
  if (waveReason) return waveReason;
  for (const wave of waves)
    for (const issue of wave.issues) if (issue.status === "parked" && redriveOnly(issue.reason)) return issue.reason;
  return undefined;
}
