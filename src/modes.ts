import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type {
  CampaignDoneEvent,
  CampaignStartEvent,
  WaveDoneEvent,
  WaveStartEvent,
} from "./event-log.ts";
import { runGates } from "./gate.ts";
import { agentSelectionFor, makeSandbox } from "./sandbox.ts";
import {
  branchHasCommits,
  collectWaveChangelog,
  currentBranch,
  integrateGreens,
} from "./merge.ts";
import {
  clearParked,
  enqueueOutbound,
  hasParked,
  isAnswered,
  listParked,
  type ParkReason,
} from "./state.ts";
import { strandedByConflict, resumeIndex, type StrandedImpact } from "./prune.ts";
import { notice, type Notice } from "./notice.ts";
import { tgSend, tgWaitReply, type TgConn } from "./telegram.ts";
import { hostSecretsPath, tgConnForBaseLocation } from "./registry.ts";
import { issueNameFromTask, readEventLog, reduceCampaign } from "./status.ts";
import {
  formatComplete,
  formatOutcomes,
  formatPlan,
  formatResume,
  formatResumeNothing,
  formatStop,
  formatWaveDone,
  formatWaveStart,
  makeReporter,
  type Reporter,
} from "./report.ts";
import {
  acquireSlot,
  deregisterProject,
  registerProject,
  releaseSlot,
  type HostBudget,
} from "./host-slots.ts";

/**
 * A campaign's terminal verdict (design §5 step 6, §15): `done` only when the last wave
 * closed and `campaign-done` was logged, `parked` when a wave boundary paused it
 * (`campaign-parked` — a red base, an unresolved issue park, or a stranded conflict), and
 * `failed` when a member the agent could not make green stopped it (`campaign-failed`,
 * failure outranks a park — ADR 0019). cli-dispatch maps these to the exit codes 0 / 2 / 1;
 * modes.ts carries no exit-code logic of its own.
 */
export type CampaignOutcome = "done" | "parked" | "failed";

/**
 * How often a run blocked by the host budget re-checks for a freed slot. A run
 * that cannot acquire right now (the host is full, or it is already at its share)
 * has no event of its own to wake on — another project's container may free a slot
 * at any time — so it polls until one does.
 */
const HOST_SLOT_POLL_MS = 1000;

/**
 * The optional-name suffix a campaign notice header carries — ` “<name>”` when the
 * campaign was named, empty otherwise. One place so every header renders the name
 * identically (`docs/operations.md`, the comms skeleton).
 */
const named = (name?: string): string => (name ? ` “${name}”` : "");

/**
 * The terminal reporter for a run/campaign's human lines (design §11): human-readable by
 * default, and silent under `--json` — the same `VETINARI_JSON` env the logger's raw-JSONL
 * echo keys on, so the screen is one or the other, never both. Read at call time so a child
 * spawn (which inherits the env) reports the same way its parent does (#299).
 */
const envReporter = (): Reporter =>
  makeReporter({ json: process.env.VETINARI_JSON === "1" });

/**
 * Resolve each issue's title through the orchestrator's `fetchTask`, keyed by
 * normalized id, so a run can record an id→title map on its start event for the
 * dumb-router dashboard to read with no live lookup of its own (ADR 0002).
 * Best-effort: an id whose task cannot be fetched or carries no structured title
 * is simply absent from the map — its chip then falls back to `number:status` and
 * its wave to the bare index, and the whole run still starts (no throw).
 */
export async function resolveTitles(
  cfg: Pick<ResolvedConfig, "fetchTask">,
  ids: string[],
): Promise<Record<string, string>> {
  const titles: Record<string, string> = {};
  await Promise.all(
    [...new Set(ids.map((id) => id.replace(/^#/, "")))].map(async (id) => {
      try {
        const title = issueNameFromTask(String(await cfg.fetchTask(id)));
        if (title) titles[id] = title;
      } catch {
        // best-effort — a title we cannot fetch just isn't recorded
      }
    }),
  );
  return titles;
}

/**
 * The env a `selfSpawn`ed child gets: the parent's, plus `VETINARI_CHILD` so the
 * child `run` knows it was spawned by a queue/campaign and must not archive the
 * parent's in-flight log as if it were a leftover (`shouldArchiveLeftover`, #150).
 */
export function childSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, VETINARI_CHILD: "1" };
}

/**
 * Re-invoke this CLI as a child, preserving however it was launched (the tsx
 * loader flags live in execArgv). Spawning a bare `node` would fail on TS.
 */
const selfSpawn = (args: string[], extraEnv?: NodeJS.ProcessEnv) =>
  spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...childSpawnEnv(process.env), ...extraEnv },
  });

/**
 * How `queue` runs one task: spawn a child `run` and resolve to its exit code
 * (`null` when the child was killed without one). Injected so the wave-loop can be
 * driven Docker-free in a test with a fake child that never touches a container —
 * the default spawns the real containerized `run` (#151). The exit-code contract is
 * `run`'s: `0` green, `2` parked, anything else an error.
 *
 * `resumeSession` is the crashed session a redrive re-enters this member on (design §7): when
 * set, the child `run` resumes that session on its existing branch instead of a fresh start.
 */
export type RunSpawner = (taskId: string, resumeSession?: string) => Promise<number | null>;

/** The production spawner: a real child `run`, resolving on its exit. A crash redrive passes the
 * crashed session id through to the child as `VETINARI_RESUME_SESSION` so it resumes (design §7). */
const selfSpawnRun: RunSpawner = (taskId, resumeSession) =>
  new Promise((resolve) => {
    selfSpawn(["run", taskId], resumeSession ? { VETINARI_RESUME_SESSION: resumeSession } : undefined).on(
      "exit",
      (code) => resolve(code),
    );
  });

/**
 * The project's Dockerfile, fixed by the committed `vetinari/` layout (init
 * writes it here). `build` reads it so the image name and Dockerfile never have
 * to be repeated on the CLI.
 */
export const DOCKERFILE = "vetinari/Dockerfile";

/**
 * The sandcastle argv that builds `image` from `dockerfile` — `docker
 * build-image` with both passed by flag. Pure, so the one place that names the
 * image and the Dockerfile on the CLI is checkable without a Docker daemon.
 */
export function buildImageArgs(image: string, dockerfile: string): string[] {
  return [
    "docker",
    "build-image",
    "--dockerfile",
    dockerfile,
    "--image-name",
    image,
  ];
}

/**
 * Prove the image can run the gates before trusting any agent result: a
 * toolchain probe, then every gate unconditionally. No agent, no cost.
 */
export async function baseline(cfg: ResolvedConfig) {
  const sbx = await makeSandbox(cfg, "baseline");
  try {
    if (cfg.toolchainProbe) {
      const probe = await sbx.exec(cfg.toolchainProbe);
      cfg.log.log("toolchain", {
        exitCode: probe.exitCode,
        out: (probe.stdout ?? "").trim(),
      });
      if (probe.exitCode !== 0)
        throw new Error(`toolchain probe failed: ${probe.stderr}`);
    }
    const { green, report } = await runGates(cfg, sbx, { all: true });
    cfg.log.log("baseline", { green });
    if (!green) console.log(report);
    return green;
  } finally {
    await sbx.close();
  }
}

/**
 * The two effects `build` orchestrates, injected so its wiring — build first,
 * then baseline unless skipped, non-zero on either failure — is testable without
 * a Docker daemon. `buildImage` resolves to sandcastle's exit code; `baseline`
 * is the same probe the `baseline` mode runs.
 */
export interface BuildDeps {
  buildImage: (image: string, dockerfile: string) => Promise<number>;
  baseline: (cfg: ResolvedConfig) => Promise<boolean>;
}

/**
 * Shell sandcastle's `docker build-image` for `image`/`dockerfile`, inheriting
 * stdio so its progress and any error stay visible, and resolve to its exit code
 * (a launch failure counts as non-zero). The real effect behind `BuildDeps`.
 */
const runBuildImage = (image: string, dockerfile: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["sandcastle", ...buildImageArgs(image, dockerfile)],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", (err) => {
      console.error(`build: could not launch sandcastle — ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

const defaultBuildDeps: BuildDeps = { buildImage: runBuildImage, baseline };

/**
 * Build the agent image the same way the run modes name it — `cfg.image` from
 * the project's Dockerfile, neither repeated on the CLI — then, unless
 * `--no-baseline` was passed (`opts.baseline === false`), prove it with the
 * baseline probe. Returns false on a build failure (baseline is skipped) or a
 * red baseline; the CLI maps that to a non-zero exit.
 */
export async function build(
  cfg: ResolvedConfig,
  opts: { baseline: boolean },
  deps: BuildDeps = defaultBuildDeps,
): Promise<boolean> {
  const code = await deps.buildImage(cfg.image, DOCKERFILE);
  cfg.log.log("build", { image: cfg.image, dockerfile: DOCKERFILE, exitCode: code });
  if (code !== 0) return false;
  if (!opts.baseline) return true;
  return deps.baseline(cfg);
}

/**
 * Surface an un-notifiable project at the moment work starts. Resolve this
 * project's Telegram connection the way the gateway will — from its base location's
 * `host.env`, never `process.env` (issue #117's resolver) — and when it resolves
 * nothing, the project is registered-but-unreachable: a parked question persists to
 * disk and is never announced, and nothing an operator would recognize is logged
 * (issue #116). So log a `telegram-unconfigured` event (the dashboard narrates it)
 * and warn on stderr, naming the file to fix. Warn and continue — the run is still
 * useful; the operator is simply told parks won't ping.
 */
export function warnIfTelegramUnconfigured(
  cfg: Pick<ResolvedConfig, "project" | "stateDir" | "log">,
): void {
  const baseLocation = resolve(process.cwd(), cfg.stateDir);
  if (tgConnForBaseLocation(baseLocation)) return;
  cfg.log.log("telegram-unconfigured", { project: cfg.project, baseLocation });
  console.error(
    `⚠ ${cfg.project} has no Telegram connection — parked questions will NOT be announced (no VETINARI_TELEGRAM_* in ${hostSecretsPath(baseLocation)})`,
  );
}

/**
 * Fair-share pool: spawns runs up to this project's current fair share of the
 * host container ceiling (ADR 0011) — there is no per-run cap, so a lone project
 * fills the whole ceiling. A park frees its slot immediately. Returns the per-task
 * outcome map so a caller (campaign) can act on the greens without re-deriving
 * them from the log.
 */
export async function queue(
  cfg: ResolvedConfig,
  taskIds: string[],
  host: HostBudget,
  titles?: Record<string, string>,
  spawnRun: RunSpawner = selfSpawnRun,
  reporter: Reporter = envReporter(),
  resumeSessions: Record<string, string> = {},
): Promise<Record<string, string>> {
  const pending = [...taskIds];
  const outcomes: Record<string, string> = {};
  // Members that settled `parked` with an on-disk record present. When that record is later
  // *answered* (the answer delivered into it) while the wave is still draining, the member is
  // re-admitted: re-queued to spawn when a slot frees with the answer as its prompt, its earlier
  // `parked` outcome discarded (design §5 step 3). A member is only tracked once it genuinely
  // parked-with-record, so a member that never wrote a record is never re-admitted — no
  // self-respawn loop; the re-admitted child consumes and clears the record when it starts.
  const parkedWithRecord = new Set<string>();
  let running = 0;
  // Only a standalone queue warns here; inside a campaign the caller passes `titles`
  // and has already warned once at campaign start, so we don't repeat it per wave.
  if (titles === undefined) warnIfTelegramUnconfigured(cfg);
  // No `queue-start`/`queue-done` outbound (design §2.1, §10): the campaign's own
  // `wave-start`/`wave-done` frame the wave and each task announces itself with a
  // `spawn`. The issue titles the dashboard names chips by were recorded once on
  // `campaign-start` by the caller, so this drain records and announces nothing itself.

  // The host container ceiling (ADR 0010/0011) is always in effect: the run marks
  // itself active so other projects drain toward their share, and every spawn is
  // gated on a cooperative lease so the sum of live containers across all projects
  // stays within the ceiling and within this project's current fair share.
  registerProject(host.configDir, cfg.project, host.weight, "campaign");
  try {
    await new Promise<void>((done) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      const stopPoll = () => {
        if (poll) {
          clearInterval(poll);
          poll = undefined;
        }
      };
      // Re-queue any parked-with-record member whose record has since been answered: discard its
      // `parked` outcome and let `fill` spawn it as a slot frees — the child consumes the answer
      // and clears the record. Runs at the head of every `fill`, so a sibling's exit (or the
      // ceiling poll) is what drives a mid-drain re-admission (design §5 step 3).
      const readmit = () => {
        for (const id of [...parkedWithRecord]) {
          if (isAnswered(cfg, id)) {
            parkedWithRecord.delete(id);
            delete outcomes[id];
            pending.push(id);
          }
        }
      };
      const fill = () => {
        readmit();
        // No per-run cap: spawn as long as work remains and the cooperative lease
        // grants a slot — the fair share (and the ceiling) is the only bound.
        while (
          pending.length &&
          acquireSlot(host.configDir, host.ceiling, cfg.project, host.weight)
        ) {
          const next = pending.shift()!;
          running++;
          cfg.log.log("spawn", { taskId: next, running, left: pending.length });
          // A crash redrive passes the crashed session id so the child resumes on its existing
          // branch (design §7); every other spawn (fresh, answered re-admit) passes none.
          spawnRun(next, resumeSessions[next]).then((code) => {
            running--;
            releaseSlot(host.configDir);
            outcomes[next] =
              code === 0 ? "green" : code === 2 ? "parked" : `error(${code})`;
            // A member the agent could not make green (a non-zero, non-park exit) is a terminal
            // failure (design §2.1): record it so the reducer folds the wave to `failed` even
            // though the run itself logged no verdict.
            if (outcomes[next].startsWith("error"))
              cfg.log.log("failed", { taskId: next, detail: outcomes[next] });
            // A park with a live record is re-admittable if that record is later answered.
            if (outcomes[next] === "parked" && hasParked(cfg, next))
              parkedWithRecord.add(next);
            fill();
          });
        }
        // Blocked by the ceiling or the fair share with work still queued: poll for
        // a slot another project frees (we have no event for that). Otherwise an
        // exit callback re-drives fill, so no poll is needed.
        if (pending.length) {
          if (!poll) poll = setInterval(fill, HOST_SLOT_POLL_MS);
        } else if (running === 0) {
          stopPoll();
          done();
        } else {
          stopPoll();
        }
      };
      fill();
    });
  } finally {
    deregisterProject(host.configDir);
  }

  reporter.line(formatOutcomes(taskIds, outcomes));
  return outcomes;
}

/**
 * Advance each merged issue to the first hop of the merge→`pending-verify`→close
 * lifecycle by notifying the configured `onIssueMerged` seam — the state right
 * after a local merge with a green merged-base gate. The core names no labels
 * (the seam's handler does), so this is a no-op when `onIssueMerged` is
 * unconfigured, keeping the core tracker-agnostic.
 *
 * Best-effort, like the outbox: the orchestrator runs locally and may be offline,
 * so a failing write is logged and swallowed per issue — it never throws, never
 * fails, and never rolls back the campaign, and one bad write never blocks the
 * rest. Only the green `merged` set is passed in, so parked/pruned/failed issues
 * are excluded by construction.
 */
export async function markMergedIssues(
  cfg: Pick<ResolvedConfig, "onIssueMerged" | "log">,
  merged: string[],
): Promise<void> {
  if (!cfg.onIssueMerged) return;
  for (const taskId of merged) {
    try {
      await cfg.onIssueMerged(taskId);
    } catch (error) {
      cfg.log.log("issue-merged-hook-failed", {
        taskId,
        error: String((error as any)?.message ?? error),
      });
    }
  }
}

/**
 * The operator-facing notice a campaign-park enqueues (ADR 0013). The merged base gated red
 * with no attributable culprit — every issue passed alone — so the wave's greens stay
 * merged on the base and the campaign pauses for a human to resolve: fix forward and
 * resume, or prune a suspect. `category: "failure"` routes it to the same alert channel
 * the old halt used, since a paused red base demands attention; the gate-report `detail`
 * tail rides along so the human sees why it went red. Also carries a member-park's detail
 * for the plain question/stall hold. Pure, so the wording and routing are checkable without
 * running a campaign.
 */
export function campaignParkedNotice(
  project: string,
  waveNumber: number,
  merged: string[],
  baseBranch: string,
  detail: string,
): Notice {
  return notice({
    emoji: "🅿️",
    project,
    state: "PARKED",
    context: `wave ${waveNumber}`,
    signal: `Base gated red, no attributable culprit — greens (${merged.join(", ") || "none"}) kept on ${baseBranch}, campaign paused.`,
    recover: "`vetinari redrive` (after fix-forward) or `prune <issue>`",
    detail,
    category: "failure",
    event: "campaign-parked",
  });
}

/**
 * The operator-facing notice a campaign-failure enqueues (design §5 step 5). A wave drained with a
 * member the agent could not make green (its child `run` exited non-zero); the wave's greens were still
 * integrated, then the campaign stopped as failed — failure outranks parked (ADR 0019). `category:
 * "failure"` routes it to the alert channel a wave-park uses, since a failed campaign demands attention.
 * The failed issue's branch and worktree are kept (only the merged greens were cleaned up), so the human
 * can fix it forward or prune it. Pure, so the wording and routing are checkable without a campaign.
 */
export function campaignFailedNotice(
  project: string,
  waveNumber: number,
  merged: string[],
  failed: string[],
  baseBranch: string,
): Notice {
  return notice({
    emoji: "❌",
    project,
    state: "FAILED",
    context: `wave ${waveNumber}`,
    signal: `${failed.join(", ")} failed — greens (${merged.join(", ") || "none"}) kept merged on ${baseBranch}, campaign stopped. The failed branch/worktree are kept.`,
    recover: "fix it forward then `vetinari redrive`, or `prune <issue>`",
    category: "failure",
    event: "campaign-failed",
  });
}

/**
 * Render each conflicted issue and the dependents it stranded as `#640 → #701, #702`,
 * one per line — the shared body both conflict notices show so a human reads the same
 * blast radius whether the campaign paused or pruned on.
 */
function describeConflictImpacts(impacts: StrandedImpact[]): string {
  return impacts
    .map((i) => `  #${i.target} → ${i.dropped.map((d) => `#${d}`).join(", ")}`)
    .join("\n");
}

/**
 * The operator-facing notice a stranded-conflict pause enqueues (ADR 0013). A merge conflict
 * parked an issue whose dependents sit in later, unstarted waves — a blast-radius
 * call that belongs to a human — so the campaign pauses at the wave boundary with the
 * greens already merged left in place. `category: "failure"` routes it to the alert
 * channel a red base uses. The human has two moves: resolve the conflict-parked issue's
 * conflict and resume, or re-run with `--auto-prune` to prune the stranded dependents
 * and continue. Pure, so the wording and routing are checkable without a campaign.
 */
export function strandedConflictNotice(
  project: string,
  waveNumber: number,
  impacts: StrandedImpact[],
  baseBranch: string,
): Notice {
  return notice({
    emoji: "🅿️",
    project,
    state: "PARKED",
    context: `wave ${waveNumber}`,
    signal: `A merge conflict stranded dependents in later waves — greens kept on ${baseBranch}, campaign paused.`,
    detail: `Conflicted → orphaned:\n${describeConflictImpacts(impacts)}`,
    recover: "`vetinari redrive` (after resolving the conflict) or `campaign --auto-prune` to prune and continue",
    category: "failure",
    event: "campaign-parked",
  });
}

/**
 * The operator-facing notice a merge-conflict park enqueues when it holds the wave
 * (design §5 step 5). One or more greens conflicted at merge and are parked as `conflict`,
 * their branches/worktrees/sessions intact; the wave's other greens stay merged on the base
 * and the campaign parks for a human to resolve the conflict on the branch and redrive.
 * `category: "failure"` routes it to the alert channel a red base uses. Pure, so the wording
 * and routing are checkable without a campaign.
 */
export function conflictParkedNotice(
  project: string,
  waveNumber: number,
  conflictParked: string[],
  merged: string[],
  baseBranch: string,
): Notice {
  return notice({
    emoji: "🅿️",
    project,
    state: "PARKED",
    context: `wave ${waveNumber}`,
    signal: `Merge conflict on ${conflictParked.map((q) => `#${q}`).join(", ")} — greens (${merged.join(", ") || "none"}) kept on ${baseBranch}, campaign paused.`,
    recover: "resolve the conflict on the branch then `vetinari redrive` (or `prune <issue>`)",
    category: "failure",
    event: "campaign-parked",
  });
}

/**
 * The wave-level reason a `campaign-parked` carries when a member holds the wave (design §2.1
 * rule 2 — written, never inferred): a held member's own `question`/`stalled` reason wins over a
 * conflict (an answerable hold is the more actionable one to surface), else `conflict` for a
 * conflict-only hold. Reads the reason off the on-disk parked records; a member with no record
 * (a stub, or a race) defaults to `question`, the answerable hold. Pure over the record set.
 */
export function waveParkReason(
  parkedTasks: string[],
  conflictParked: string[],
  records: { taskId: string; reason: ParkReason }[],
): ParkReason {
  const norm = (id: string) => id.replace(/^#/, "");
  for (const t of parkedTasks) {
    const rec = records.find((r) => norm(r.taskId) === norm(t));
    if (rec?.reason === "stalled") return "stalled";
    if (rec?.reason === "question") return "question";
  }
  if (parkedTasks.length) return "question";
  return "conflict";
}

/**
 * The notice `campaign --auto-prune` enqueues when it prunes a stranded conflict's
 * dependents and runs on (ADR 0013). Informational — the campaign continued — so it
 * rides the `progress` channel, naming each conflict-parked issue and the dependents its
 * prune pruned. Pure, checkable without a campaign.
 */
export function autoPruneNotice(
  project: string,
  waveNumber: number,
  impacts: StrandedImpact[],
): Notice {
  return notice({
    emoji: "✂️",
    project,
    state: "PRUNED",
    context: `wave ${waveNumber}`,
    signal: "A merge conflict stranded dependents — closure pruned, campaign ran on.",
    detail: `Conflicted → pruned:\n${describeConflictImpacts(impacts)}`,
    category: "progress",
    event: "prune",
  });
}

/**
 * The container- and git-bound effects `campaign` orchestrates, injected so the
 * wave-loop itself — the per-wave `reduceCampaign(readEventLog(cfg))` re-derive
 * that is the ADR 0005 single-source-of-truth loop — is drivable end-to-end with
 * no Docker and no real merges (#151). The defaults are the production effects, so
 * the injected path never changes behaviour: `spawnRun` spawns a real child `run`,
 * `integrate` runs the real merge+gate, `collectChangelog` folds the real
 * fragments, and `currentBranch` reads the real checked-out branch.
 */
/** How often {@link graceWaitForAnswer} re-checks the parked records while the window runs. */
const GRACE_POLL_MS = 1000;

/**
 * Wait up to `seconds` for an answer to land for one of `parkedIds` — its on-disk parked
 * record vanishing — resolving as soon as one does, or when the window elapses. Injected on
 * `CampaignDeps` so the wave-boundary grace window (design §5 step 5) is drivable without real
 * time; the default polls the records. The caller re-checks the records afterwards to decide
 * which members to re-admit, so this resolves `void` whichever way the window ended.
 */
export type GraceWaiter = (
  cfg: ResolvedConfig,
  parkedIds: string[],
  seconds: number,
) => Promise<void>;

/** The production grace waiter: poll `parkedIds`' records until one is answered or the window ends. */
export const graceWaitForAnswer: GraceWaiter = (cfg, parkedIds, seconds) =>
  new Promise((resolve) => {
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      if (parkedIds.some((id) => isAnswered(cfg, id))) return resolve();
      const left = deadline - Date.now();
      if (left <= 0) return resolve();
      setTimeout(tick, Math.min(GRACE_POLL_MS, left));
    };
    tick();
  });

export interface CampaignDeps {
  spawnRun: RunSpawner;
  integrate: typeof integrateGreens;
  collectChangelog: typeof collectWaveChangelog;
  currentBranch: typeof currentBranch;
  grace: GraceWaiter;
  /** Does a member's agent branch carry committed work (design §7)? A redrive reads it to tell a
   * crashed member with banked commits (resume its session) from one that never started (fresh).
   * Optional so a partial test-`CampaignDeps` may omit it; absent falls back to the real git read. */
  branchHasCommits?: (cfg: ResolvedConfig, taskId: string) => boolean;
}
const defaultCampaignDeps: CampaignDeps = {
  spawnRun: selfSpawnRun,
  integrate: integrateGreens,
  collectChangelog: collectWaveChangelog,
  currentBranch,
  grace: graceWaitForAnswer,
  branchHasCommits,
};

/**
 * The redrive reconciliation of the resume wave (design §7): classify each member of
 * the first not-fully-completed wave into work to spawn versus outcomes already decided
 * by the log, so re-entering a parked wave lands its banked work rather than redoing it.
 *
 * Per member (its status as `reduceCampaign` reconstructs it):
 * - `completed` (merged) or a **pending green** (green but not yet merged — an answered park
 *   that went green outside its wave, a resolved conflict) → a `green`: handed to integration,
 *   which lands a still-unmerged green and skips an already-merged one — never a respawn
 *   (integration is idempotent, `merge.ts`). A pending green reads `running` in the reducer
 *   (design §2.2), so `pendingGreen` — not the status word — is what marks banked-but-unmerged
 *   work apart from a genuinely in-flight/crashed `running` member.
 * - `parked` → re-run when its record is answered (the answer delivered into it — the child
 *   consumes and clears it) OR gone (a crash left no record), else a `parked` outcome that
 *   leaves the member unspawned and re-parks the wave — the un-answered park holds it (design
 *   §5 step 3, §7). A `crash` (§7) is the recordless shape — reconciled to `parked{crash}`. A
 *   live redrive reads the same crashed member as `running` (the process is now alive), which
 *   the `else` below also re-runs; either way a crash re-runs, never left parked.
 * - `failed` → re-run only under `override` (the operator's explicit choice); otherwise
 *   an `error(...)` outcome that stops the campaign as failed again (design §7).
 * - anything else (`running`/`unstarted`/grafted) → run.
 *
 * A crashed member (a recordless park or a `running` member the process left behind) is *resumed*
 * on its recorded session rather than re-run fresh when `resumeSessionFor(id)` yields one — the
 * caller returns a session id only for a resumable provider whose branch carries committed work
 * (design §7's "else resume the session"); no commits, or a non-resumable provider, yields none
 * and the member runs fresh. The resolver is consulted only on the crash/unstarted spawn paths,
 * never on an answered park (its record carries the answer) or a `--override` re-run of a failed
 * member (an explicit fresh re-run). The chosen session id rides out in `resume`, keyed by member.
 *
 * Pure over the outcome map + a parked-record predicate + the session resolver, so the
 * reconciliation is unit-testable and, fed back through the wave's ordinary resolve logic, needs
 * no new park/fail/merge paths. `pre` is keyed exactly as `queue` reports an outcome.
 */
export function reconcileResumeWave(
  members: string[],
  outcomes: ReadonlyMap<string, string>,
  parkHoldsWave: (id: string) => boolean,
  override: boolean,
  pendingGreen: ReadonlySet<string> = new Set(),
  resumeSessionFor: (id: string) => string | undefined = () => undefined,
): { toRun: string[]; pre: Record<string, string>; resume: Record<string, string> } {
  const toRun: string[] = [];
  const pre: Record<string, string> = {};
  const resume: Record<string, string> = {};
  // Spawn `id`, resuming its crashed session when the resolver yields one (design §7).
  const run = (id: string) => {
    toRun.push(id);
    const sid = resumeSessionFor(id);
    if (sid) resume[id] = sid;
  };
  for (const id of members) {
    const status = outcomes.get(id) ?? "unstarted";
    // Banked green — merged (`completed`) or green-but-unmerged (`pendingGreen`, which reads
    // `running`, design §2.2) — is handed to integration, never re-run. `pendingGreen` is
    // checked explicitly so a genuinely in-flight/crashed `running` member still re-runs below.
    if (status === "completed" || pendingGreen.has(id)) pre[id] = "green";
    else if (status === "failed") {
      // A `--override` re-run of a failed member is an explicit fresh re-run — never a resume.
      if (override) toRun.push(id);
      else pre[id] = "error(failed on a prior run — prune it or redrive with --override)";
    } else if (status === "parked") {
      // An un-answered on-disk record holds the wave; an answered one (consumed by the child) or
      // a recordless crash re-runs — the crash resuming its session when the resolver yields one.
      if (parkHoldsWave(id)) pre[id] = "parked";
      else run(id);
    } else run(id);
  }
  return { toRun, pre, resume };
}

/**
 * Drain each batch, then merge its greens into the base, re-verify the merged
 * base, clean up the merged branches/worktrees, and only then start the next
 * batch — the manual merge→test→next-queue chain, automated.
 *
 * Green-only by design: only green branches are merged. Once a wave is over,
 * parked records for its non-green tasks are cleared so stale questions do not
 * bleed into the next wave. Integration is non-atomic (ADR 0013): a merge conflict
 * parks just the conflicting green and the wave carries on with the rest,
 * while a red merged base — with no single culprit — parks the campaign: the wave's greens
 * stay merged on the base and the campaign pauses for a human, with no changelog fold
 * and no `pending-verify` labels (a red base verifies nothing).
 *
 * A conflict that strands dependents in later, unstarted waves is a blast-radius
 * call for a human, so by default the campaign pauses at the wave boundary (ADR 0013);
 * `opts.autoPrune` opts into pruning the stranded closure and running on. A conflict
 * that orphans nothing never stops the campaign.
 *
 * `opts.resume` continues a *paused* campaign on the current base rather than starting a
 * fresh one (ADR 0013): it reconstructs the existing plan from the event log (no new
 * `campaign-start`, no re-resolved titles), resumes at the first wave that did not close
 * (`resumeIndex`), and reconciles that wave before running it (design §7,
 * `reconcileResumeWave`) — landing a green-but-unmerged member without a rerun, re-running
 * an answered park (its record gone), re-parking one whose record remains, and stopping as
 * failed again on a failed member unless `opts.override` re-runs it. Every later wave runs
 * fresh. The supplied `batches`/`name` are ignored under resume; the plan comes from the
 * log. A resume with nothing left to run reports so and returns `done`.
 */
export async function campaign(
  cfg: ResolvedConfig,
  batches: string[][],
  host: HostBudget,
  name?: string,
  opts: { autoPrune?: boolean; resume?: boolean; override?: boolean } = {},
  deps: CampaignDeps = defaultCampaignDeps,
): Promise<CampaignOutcome> {
  // Every green branch merges into whatever the main tree has checked out, and
  // each batch's agents cut their branch from that same HEAD. If it is not the
  // base branch the campaign would merge into, and build on, the wrong place.
  const branch = deps.currentBranch();
  if (branch !== cfg.baseBranch) {
    throw new Error(
      `campaign merges into the checked-out branch, but the working tree is on "${branch}", not baseBranch "${cfg.baseBranch}". Run \`git checkout ${cfg.baseBranch}\` first (a clean tree — the merges land here).`,
    );
  }

  // Surface an un-notifiable project once, at the start of the whole campaign — the
  // per-wave `queue` calls below pass `titles` and so stay silent (no per-wave repeat).
  warnIfTelegramUnconfigured(cfg);

  // The terminal view (design §11): human-readable plan/progress/stop lines, or nothing
  // under `--json` (where the logger streams raw events instead). Threaded into every
  // `queue` call so the per-issue outcomes report the same way.
  const reporter = envReporter();

  // Where the wave loop starts, the id→title map the per-wave `queue` calls carry, and the run's
  // human name — stamped onto every wave event and operator note so a resumed or mid-campaign run
  // never renders nameless (#174). Under resume the `--name` param is ignored, so the name is read
  // back from the log's `campaign-start` alongside the plan; otherwise it is the supplied param.
  let index = 0;
  let titles: Record<string, string>;
  let campaignName: string | undefined;
  // Set to the resume wave's index while a `redrive` event is owed: it is logged once that wave
  // integrates, carrying the `landed`/`skipped` counts the reconciliation produced (design §2.1, §7).
  let pendingRedriveFromWave: number | undefined;

  if (opts.resume) {
    // Resume a paused campaign (ADR 0013): reconstruct the existing plan from the log —
    // no new `campaign-start`, no re-resolved titles — and skip every wave that already
    // banked work so no merged issue is redone. The supplied `batches`/`name` are ignored;
    // the plan is whatever the running campaign's `campaign-start` (minus any prune) reduced to.
    const reduced = reduceCampaign(readEventLog(cfg));
    if (!reduced.waves.length)
      throw new Error(
        "redrive: no campaign found in the event log to pick up. Launch one with `campaign <ids…>`.",
      );
    titles = Object.fromEntries(reduced.titles);
    campaignName = reduced.name;
    index = resumeIndex(reduced);
    if (index >= reduced.waves.length) {
      // Nothing left to run — every wave already banked. The redrive landed and skipped nothing.
      cfg.log.log("redrive", { fromWave: index, landed: 0, skipped: 0 });
      enqueueOutbound(cfg, notice({
        emoji: "↩️",
        project: cfg.project,
        state: "REDRIVE",
        context: `${reduced.waves.length} waves`,
        signal: `nothing to run — all ${reduced.waves.length} waves already merged`,
        category: "progress",
        event: "redrive",
      }));
      reporter.line(formatResumeNothing(reduced.waves.length));
      return "done";
    }
    // The structured `redrive` event carries `landed`/`skipped` (design §2.1), known only once
    // the resume wave integrates — so it is logged there (see `pendingRedriveFromWave`). The
    // operator notice and terminal line go out now, at pickup.
    pendingRedriveFromWave = index;
    enqueueOutbound(cfg, notice({
      emoji: "↩️",
      project: cfg.project,
      state: "REDRIVE",
      context: `wave ${index + 1}/${reduced.waves.length}`,
      signal: `on ${cfg.baseBranch} — continuing unrun waves`,
      category: "progress",
      event: "redrive",
    }));
    reporter.line(formatResume(index, reduced.waves.length));
  } else {
    // Resolve the run's issue titles up front (the orchestrator has `fetchTask`) and
    // record them on the start event, so the dumb-router dashboard names every wave
    // and chip — live and archived — with no lookup of its own (ADR 0002). `name` is
    // still recorded only when given; a run whose titles could not be resolved simply
    // omits them and degrades to `number:status`.
    titles = await resolveTitles(cfg, batches.flat());
    campaignName = name;
    // Record the plan, the slot budget, and — once — the optional `--name` and the id→title
    // map, so the dumb-router dashboard names every wave and chip with no lookup of its own
    // (design §2.1, ADR 0002). No presentation state is written: the festive wave name is
    // derived at render from this event's timestamp, not a cursor stamped here.
    const startEvent: Omit<CampaignStartEvent, "ts" | "event"> = {
      waves: batches,
      slots: host.ceiling,
    };
    if (name) startEvent.name = name;
    if (Object.keys(titles).length) startEvent.titles = titles;
    cfg.log.log("campaign-start", startEvent);
    enqueueOutbound(cfg, notice({
      emoji: "🎬",
      project: cfg.project,
      state: "CAMPAIGN",
      context: `${batches.length} waves${named(name)}`,
      signal: batches.map((b) => b.join(",")).join(" | "),
      category: "progress",
      event: "campaign-start",
    }));
    // The plan, on the terminal: the waves with their ids and titles (design §11).
    reporter.line(formatPlan(batches, titles, campaignName));
  }

  // Only the first wave a redrive re-enters is reconciled against the log (design §7);
  // every later wave was never started, so it runs fresh.
  let reconcileResume = !!opts.resume;

  // The plan is re-derived from the log at each wave boundary rather than
  // iterated from the in-memory array: a `prune` event appended mid-campaign
  // prunes future waves here, while the in-flight wave (already past this point)
  // finishes as-is — the single-source-of-truth loop of ADR 0005.
  for (; ; index++) {
    const reduced = reduceCampaign(readEventLog(cfg));
    const waves = reduced.waves;
    if (index >= waves.length) break;
    const tasks = waves[index];
    const total = waves.length;
    const waveEvent: Omit<WaveStartEvent, "ts" | "event"> = { index, tasks };
    cfg.log.log("wave-start", waveEvent);
    enqueueOutbound(cfg, notice({
      emoji: "▶️",
      project: cfg.project,
      state: "WAVE",
      context: `${index + 1}/${total}${named(campaignName)}`,
      signal: tasks.join(", "),
      category: "progress",
      event: "wave-start",
    }));
    reporter.line(formatWaveStart(index, total, tasks, titles));

    let outcomes: Record<string, string>;
    // A wave whose stop was `red-base` must be re-gated on re-entry even though nothing new
    // merges (design §7): the fix-forward that resolves it lands on the base, not on any member
    // branch, so `redBase` being set for this reconciled wave is the signal to force the gate.
    let regate = false;
    if (reconcileResume) {
      // Redrive reconciliation (design §7): re-entering the parked wave, decide each
      // member's outcome from the log — a banked/green member is landed by integration
      // below without a rerun, an unanswered park re-parks the wave, a failed member
      // (unless `--override`) stops the campaign as failed again — and spawn only the
      // members that genuinely need to run. Fed back through the wave's ordinary resolve
      // logic below, so no park/fail/merge path is special-cased for a redrive.
      reconcileResume = false;
      regate = reduced.redBase.size > 0 && reduced.parkedWave === index;
      // A crashed member is resumed on its recorded session rather than re-run fresh only when the
      // provider keeps a durable session AND its branch carries committed work (design §7's "else
      // resume the session"); no commits, non-resumable, or an answered park (which re-runs via its
      // own record) → no session, so the member runs fresh.
      const { resumable } = agentSelectionFor(cfg);
      const branchHasCommitsFor = deps.branchHasCommits ?? branchHasCommits;
      const resumeSessionFor = (id: string): string | undefined => {
        if (!resumable || hasParked(cfg, id)) return undefined;
        const sid = reduced.sessions.get(id);
        if (!sid) return undefined;
        return branchHasCommitsFor(cfg, id) ? sid : undefined;
      };
      const { toRun, pre, resume } = reconcileResumeWave(
        tasks,
        reduced.outcomes,
        // A park holds the wave only while its record is present AND un-answered; an answered
        // record re-runs (the child consumes the answer), and a recordless park (a crash) re-runs
        // too — design §5 step 3, §7.
        (id) => hasParked(cfg, id) && !isAnswered(cfg, id),
        !!opts.override,
        reduced.pendingGreen,
        resumeSessionFor,
      );
      const ran = toRun.length ? await queue(cfg, toRun, host, titles, deps.spawnRun, reporter, resume) : {};
      outcomes = { ...ran, ...pre };
    } else {
      outcomes = await queue(cfg, tasks, host, titles, deps.spawnRun, reporter);
    }

    // Grace window at the wave boundary (design §5 step 5): a member parked as question/stalled
    // may still be answered. Hold the drained wave open up to `parkGraceSeconds`; an answer that
    // lands (its parked record cleared) re-admits the member so it re-runs and merges in THIS
    // wave, and expiry falls through to the normal park-and-stop below. `conflict`/`red-base`
    // parks are integration-time states, decided after this point, so they never wait here.
    const graceSeconds = cfg.parkGraceSeconds ?? 0;
    const parkedNow = tasks.filter((t) => outcomes[t] === "parked");
    if (parkedNow.length && graceSeconds > 0) {
      cfg.log.log("grace-wait", { seconds: graceSeconds, tasks: parkedNow });
      await deps.grace(cfg, parkedNow, graceSeconds);
      const revived = parkedNow.filter((t) => isAnswered(cfg, t));
      if (revived.length)
        outcomes = { ...outcomes, ...(await queue(cfg, revived, host, titles, deps.spawnRun, reporter)) };
    }

    const greens = tasks.filter((t) => outcomes[t] === "green");

    const { merged, alreadyMerged = [], conflictParked, parked } = await deps.integrate(cfg, greens, undefined, index, { regate });

    // The reconciled resume wave has now integrated its banked greens — log the `redrive`
    // stop-to-continue event with what it landed (freshly merged) vs skipped (already on the
    // base), design §2.1, §7. Logged once, for the first wave a redrive re-enters.
    if (pendingRedriveFromWave === index) {
      cfg.log.log("redrive", { fromWave: index, landed: merged.length, skipped: alreadyMerged.length });
      pendingRedriveFromWave = undefined;
    }

    // The base gated red (an emergent, unattributable failure): `integrateGreens` left the greens
    // merged (never a rollback). A red base verifies nothing, so the green-path steps below (fold
    // the changelog, advance labels) are skipped while it is parked.
    const baseRed = !!parked;
    if (!baseRed) {
      // Green path only: fold this wave's merged `changelog.d/` fragments into CHANGELOG.md and
      // commit on the base in one commit (issue #123). Agents write per-task fragments instead of
      // editing the shared changelog, so co-wave branches never conflict on it.
      const collected = deps.collectChangelog(index, cfg.log);
      if (collected.committed)
        reporter.line(
          `wave ${index + 1}/${total}: collected changelog fragments — ${collected.collected.join(", ")}`,
        );
      // Green path only: advance each merged issue to `pending-verify` via the configured
      // `onIssueMerged` seam (issue #103). Best-effort — a failing write is logged and never
      // touches a stop path. Only the green `merged` set is passed.
      await markMergedIssues(cfg, merged);
    }

    // Resolve, in the exact §5 step 5 order: failed → red base → any parked member → wave-done.

    // (1) Failure outranks everything (§2.4, ADR 0019). A member the agent could not make green
    // (its child `run` exited non-zero → `error(n)`) is a terminal failure; its greens were still
    // integrated (and got the green-path steps above when the base gated green), and the failed
    // branch/worktree are kept for a fix-forward or prune. The wave holds — no `wave-done`, no
    // succeeding wave. The per-task `failed` events were logged in `queue`; here the campaign
    // records the `campaign-failed` stop marker (which `reduceCampaign` reads to hold the wave).
    const failed = tasks.filter((t) => outcomes[t]?.startsWith("error"));
    if (failed.length) {
      cfg.log.log("campaign-failed", { index, detail: `${failed.join(", ")} failed` });
      enqueueOutbound(cfg, campaignFailedNotice(cfg.project, index + 1, merged, failed, cfg.baseBranch));
      reporter.line(formatStop({ kind: "failed", index, total, failed, merged }));
      return "failed";
    }

    // (2) A red merged base (§2.3): everything stays merged, the base sits red (never pushed or
    // built on while paused), and the campaign parks. The wave's reason is `red-base`, written on
    // the stop marker (§2.1 rule 2), so a redrive re-gates this wave rather than stepping over it.
    if (baseRed) {
      cfg.log.log("campaign-parked", { index, reason: "red-base", detail: parked!.detail });
      enqueueOutbound(cfg, campaignParkedNotice(cfg.project, index + 1, merged, cfg.baseBranch, parked!.detail));
      reporter.line(formatStop({ kind: "red-base", index, total, merged }));
      return "parked";
    }

    // The base gated green from here. The wave boundary clears NO parked records (design §2.5):
    // a record is cleared only when its issue goes back to running (a re-admit/redrive run
    // consuming it) or by an explicit `prune --purge`. A held member's record — a question, a
    // stall, or a conflict-parked green's conflict — survives the boundary so it stays answerable,
    // dashboard-visible, and resumable until a human resolves it.
    const parkedTasks = tasks.filter((t) => outcomes[t] === "parked");

    // (3) Any parked member holds the wave (design §5 step 5): a question, a stall, or a merge
    // conflict (`conflictParked` — a green pulled from integration, its work preserved). A conflict
    // that strands nothing no longer slips through to `wave-done` (#310, this issue absorbs it);
    // it is unresolved work awaiting a human, so it parks the campaign like any other park. The
    // stranded-dependents check + `--auto-prune` decide the DEPENDENTS' fate on top of this —
    // never whether the campaign stops.
    if (parkedTasks.length || conflictParked.length) {
      const reason = waveParkReason(parkedTasks, conflictParked, listParked(cfg));

      // A merge conflict that strands dependents in later, unstarted waves is a blast-radius call.
      // `--auto-prune` prunes the stranded closure (ADR 0005) so a later redrive skips the doomed
      // dependents; without it, the notice names them. Either way the conflict holds the wave.
      let orphaning: StrandedImpact[] = [];
      if (conflictParked.length && cfg.blockedBy) {
        const plan = reduceCampaign(readEventLog(cfg));
        orphaning = (await strandedByConflict(plan, conflictParked, cfg.blockedBy)).filter((i) => i.dropped.length);
      }
      const autoPruned = orphaning.length > 0 && !!opts.autoPrune;
      if (autoPruned) {
        for (const impact of orphaning)
          cfg.log.log("prune", { target: impact.target, removed: impact.removed, dropped: impact.dropped });
        enqueueOutbound(cfg, autoPruneNotice(cfg.project, index + 1, orphaning));
        reporter.line(
          `wave ${index + 1}/${total}: auto-pruned ${orphaning.map((i) => `#${i.target}→${i.dropped.map((d) => `#${d}`).join(",")}`).join("; ")}.`,
        );
      }
      const stranded = autoPruned ? [] : orphaning.flatMap((i) => i.dropped);

      // Record the stop marker with the wave's reason (§2.1 rule 2). The notice and terminal line
      // take the shape of the hold: a stranded conflict, a plain conflict, or a member park.
      if (reason === "conflict" && stranded.length) {
        const detail = `stranded conflict: a merge conflict stranded ${stranded.map((d) => `#${d}`).join(", ")} in later waves`;
        cfg.log.log("campaign-parked", { index, reason, detail });
        enqueueOutbound(cfg, strandedConflictNotice(cfg.project, index + 1, orphaning, cfg.baseBranch));
        reporter.line(formatStop({ kind: "stranded-conflict", index, total, stranded, merged }));
      } else if (reason === "conflict") {
        const detail = `merge conflict: ${conflictParked.join(", ")} parked, awaiting a human`;
        cfg.log.log("campaign-parked", { index, reason, detail });
        enqueueOutbound(cfg, conflictParkedNotice(cfg.project, index + 1, conflictParked, merged, cfg.baseBranch));
        reporter.line(formatStop({ kind: "conflict", index, total, conflicted: conflictParked, merged }));
      } else {
        const detail = `parked, awaiting a human: ${parkedTasks.join(", ")}`;
        cfg.log.log("campaign-parked", { index, reason, detail });
        enqueueOutbound(cfg, campaignParkedNotice(cfg.project, index + 1, merged, cfg.baseBranch, detail));
        reporter.line(formatStop({ kind: "issue-parked", index, total, parked: parkedTasks, merged }));
      }
      return "parked";
    }

    // (4) Every member merged and the base is green: the wave closes (design §5 step 5). The event
    // carries `{ index, merged }` only (§2.1) — a wave-done means every member merged, so there is
    // no held or conflict-parked member to record.
    const waveDoneEvent: Omit<WaveDoneEvent, "ts" | "event"> = { index, merged };
    cfg.log.log("wave-done", waveDoneEvent);
    enqueueOutbound(cfg, notice({
      emoji: "✅",
      project: cfg.project,
      state: "WAVE",
      context: `${index + 1} merged${named(campaignName)}`,
      signal: merged.join(", ") || "nothing",
      category: "success",
      event: "wave-done",
    }));
    reporter.line(formatWaveDone(index, total, { merged }));
  }

  const doneEvent: Omit<CampaignDoneEvent, "ts" | "event"> = { waves: index };
  if (campaignName) doneEvent.name = campaignName;
  cfg.log.log("campaign-done", doneEvent);
  enqueueOutbound(cfg, notice({
    emoji: "🏆",
    project: cfg.project,
    state: "COMPLETE",
    context: `campaign${named(campaignName)}`,
    signal: `${index} waves merged onto ${cfg.baseBranch}`,
    category: "success",
    event: "campaign-done",
  }));
  reporter.line(formatComplete(index, cfg.baseBranch, campaignName));
  return "done";
}

export async function tgTest(cfg: ResolvedConfig, conn: TgConn) {
  const msgId = await tgSend(
    conn,
    `🔧 ${cfg.project} orchestrator test — reply to this message and I'll echo it back.`,
  );
  if (msgId == null)
    throw new Error(
      "sendMessage failed — token rejected or chat id wrong (see telegram-send-failed in the log)",
    );
  console.log(`sent (message_id ${msgId}); waiting for your reply…`);
  const reply = await tgWaitReply(conn, msgId);
  await tgSend(conn, `✅ round-trip works — got: "${reply.slice(0, 200)}"`);
  console.log(`got reply: "${reply}" — round-trip verified`);
}

/**
 * Resolve this project's Telegram connection the way the gateway does — from the
 * base location's `host.env`, never `process.env` — so a green `tg-test`
 * guarantees the gateway can send (issue #117). The single guard in front of
 * `tg-test`, the only mode that needs live creds. Throws (naming the file to
 * fix) when they are absent; the caller lets that exit the process non-zero.
 */
export function requireTelegram(mode: string, baseLocation: string): TgConn {
  const conn = tgConnForBaseLocation(baseLocation);
  if (!conn) {
    throw new Error(
      `${mode} needs VETINARI_TELEGRAM_BOT_TOKEN and VETINARI_TELEGRAM_CHAT_ID in ${hostSecretsPath(baseLocation)}`,
    );
  }
  return conn;
}

export { clearParked, listParked };
