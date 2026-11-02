/**
 * The launch tail every command that starts agents shares (#690): `campaign`, `redrive` (and its
 * `campaign --resume` alias), `answer`'s two re-admits and `run`. Each command still owns its own
 * head — its refusals, agent selection, `--json` and the pre-launch checks — and then hands one
 * row of `LAUNCH_TABLE` to `launch`, which runs the steps no command may reorder: archive the
 * leftover run, start, handle a lost lease race, archive once idle, and exit on the verdict.
 */
import type { ResolvedConfig } from "./config.ts";
import { LiveCampaignRefusal, type HostCeiling } from "./lease.ts";
import type { campaign, CampaignOutcome } from "./modes.ts";
import type { runLoop, Outcome, ReentryEntry, ResumeEntry } from "./loop.ts";
import type { listParked } from "./state.ts";
import { normalize } from "./issue-id.ts";
import { Refusal } from "./refusal.ts";

/** The effects the launch tail reaches the outside world through — a narrow slice `DispatchDeps` satisfies. */
export interface LaunchEffects {
  cfg: ResolvedConfig;
  host: HostCeiling;
  log: (msg: string) => void;
  error: (msg: string) => void;
  setExitCode: (code: number) => void;
  exit: (code: number) => void;
  archiveLeftoverRun: () => void;
  archiveIfIdle: () => void;
  campaign: typeof campaign;
  runLoop: typeof runLoop;
  listParked: typeof listParked;
}

/** The `campaign()` options a fresh launch starts with — the `--override` and planned starts differ. */
type CampaignStartOptions = NonNullable<Parameters<typeof campaign>[4]>;

/** One launch: which row of `LAUNCH_TABLE` to run, and the arguments its start takes. */
export type Launch =
  | { path: "campaign"; waves: string[][]; name: string | undefined; options: CampaignStartOptions }
  /** `redrive`, and its `campaign --resume` alias, which carries its `--name`. */
  | { path: "redrive"; name: string | undefined; autoPrune: boolean; override: boolean }
  /** `answer` on a member of a paused campaign: the redrive re-admits it with the answer. */
  | { path: "answer-redrive"; taskId: string }
  | { path: "run"; taskId: string; entry: ResumeEntry | ReentryEntry | undefined }
  | { path: "answer-run"; taskId: string };

/**
 * The verdict→exit-code map both the run loop and the campaign share (design §3, §5 step 6,
 * user-guide "Where you see things"): 0 green/done, 2 parked, 1 failed. The loop returns the
 * outcome; the exit-code decision lives HERE (never in modes.ts/loop.ts). `green` and `done`
 * are the same success code so `run` and `campaign` speak one exit vocabulary.
 */
const exitCodeFor = (outcome: Outcome | CampaignOutcome): number =>
  outcome === "green" || outcome === "done" ? 0 : outcome === "parked" ? 2 : 1;

/**
 * The command a live campaign stops (design §8): each reacts in its own words, whether its early
 * liveness probe found the campaign or its start lost the lease race to one (#527).
 */
export type LiveCampaignCaller =
  { command: "campaign" } | { command: "redrive" } | { command: "run" } | { command: "answer"; taskId: string };

/**
 * React to a live campaign for this project: it owns the project's work, so no second process may
 * start beside it. A fresh `campaign` is refused; a `redrive` (or the alias) says the live campaign
 * will pick the work up and exits clean; a standalone `run` is refused on stderr with exit 4; an
 * `answer`, already delivered, leaves the re-admit to the live campaign.
 */
export function reactToLiveCampaign(caller: LiveCampaignCaller, fx: Pick<LaunchEffects, "cfg" | "log" | "error" | "setExitCode">): void {
  const { project } = fx.cfg;
  switch (caller.command) {
    case "campaign":
      throw new Refusal(`a campaign is already running for ${project} — campaign refused.`);
    case "redrive":
      fx.log(`a campaign is already running for ${project} — it will pick up the work; redrive refused.`);
      return;
    case "run":
      fx.error(`a campaign is already running for ${project} — it owns this issue; run refused.`);
      fx.setExitCode(4);
      return;
    case "answer":
      fx.log(`${caller.taskId} answered — the live campaign will re-admit it.`);
      return;
  }
}

/** One launch path's tail. */
interface LaunchRow<L extends Launch> {
  /** Archive a prior run still sitting in the live log before starting. */
  archiveLeftover: boolean;
  start: (l: L, fx: LaunchEffects) => Promise<Outcome | CampaignOutcome>;
  /** Reset the live state once the start returns (skipped while anything is parked), so a halt still
   *  enters the archived-runs list (#141). */
  archiveIfIdle: boolean;
  /**
   * Who reacts when the start loses the lease race to a live campaign (#527): the early liveness
   * probe reads without the host lock, so a campaign that started since makes `campaign()` refuse at
   * registration. The row then reacts as its early check would and runs no further step — no
   * archive of the live campaign's log, no exit code. Absent: the refusal surfaces as it is.
   */
  onLostRace?: (l: L) => LiveCampaignCaller;
  /**
   * The issue whose `stopped` park (a signalled run) force-exits 2 at once rather than returning and
   * waiting for the abandoned agent call to let go of its handles. Keyed on the issue's own record
   * reason read back through `listParked`, so a question/stall park exits normally.
   */
  forceExitOnStop?: (l: L) => string;
}

const LAUNCH_TABLE: { [P in Launch["path"]]: LaunchRow<Extract<Launch, { path: P }>> } = {
  // A fresh `campaign` — the `--override` literal waves or the planned ones, each with its own options.
  campaign: {
    archiveLeftover: true,
    start: (l, fx) => fx.campaign(fx.cfg, l.waves, fx.host, l.name, l.options),
    archiveIfIdle: true,
  },
  // `redrive` reconstructs the plan from the log and continues it (design §7), so it never archives
  // the leftover it reconstructs from; `--override` re-runs a failed member.
  redrive: {
    archiveLeftover: false,
    start: (l, fx) => fx.campaign(fx.cfg, [], fx.host, l.name, { autoPrune: l.autoPrune, resume: true, override: l.override }),
    onLostRace: () => ({ command: "redrive" }),
    archiveIfIdle: true,
  },
  // `answer` on a member of a paused campaign (design §7): the redrive reconciles the answered park
  // into a re-run-with-answer and integrates it, carrying the campaign's own verdict out.
  "answer-redrive": {
    archiveLeftover: false,
    start: (_l, fx) => fx.campaign(fx.cfg, [], fx.host, undefined, { resume: true }),
    onLostRace: (l) => ({ command: "answer", taskId: l.taskId }),
    archiveIfIdle: true,
  },
  // A standalone `run` (or a campaign's child): the loop holds one host slot around the container
  // (design §3 step 1, §8); a campaign child skips the slot itself (its parent holds one for it).
  run: {
    archiveLeftover: true,
    start: (l, fx) => fx.runLoop(fx.cfg, l.taskId, fx.host, l.entry),
    archiveIfIdle: false,
    forceExitOnStop: (l) => l.taskId,
  },
  // `answer` on a standalone park (no campaign): the loop consumes the answered record (resume the
  // session with the answer, or post it and re-enter fresh) and holds one host slot like any run.
  "answer-run": { archiveLeftover: false, start: (l, fx) => fx.runLoop(fx.cfg, l.taskId, fx.host), archiveIfIdle: false },
};

/** Run one launch path's tail, from the archive step to the exit code. */
export async function launch(l: Launch, fx: LaunchEffects): Promise<void> {
  const row = LAUNCH_TABLE[l.path] as LaunchRow<Launch>;
  if (row.archiveLeftover) fx.archiveLeftoverRun();
  let outcome: Outcome | CampaignOutcome;
  try {
    outcome = await row.start(l, fx);
  } catch (e) {
    const caller = e instanceof LiveCampaignRefusal ? row.onLostRace?.(l) : undefined;
    if (!caller) throw e;
    reactToLiveCampaign(caller, fx);
    return;
  }
  if (row.archiveIfIdle) fx.archiveIfIdle();
  fx.setExitCode(exitCodeFor(outcome));
  const stoppable = row.forceExitOnStop?.(l);
  if (
    stoppable !== undefined &&
    outcome === "parked" &&
    fx.listParked(fx.cfg).some((r) => normalize(r.taskId) === normalize(stoppable) && r.reason === "stopped")
  )
    fx.exit(2);
}
