import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { MessageCategory, ResolvedConfig } from "./config.ts";
import type {
  CampaignBatchDoneEvent,
  CampaignBatchEvent,
  CampaignDoneEvent,
  CampaignStartEvent,
  QueueStartEvent,
} from "./event-log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";
import {
  collectWaveChangelog,
  currentBranch,
  integrateGreens,
} from "./merge.ts";
import {
  clearParked,
  clearParkedForTasks,
  enqueueOutbound,
  listParked,
} from "./state.ts";
import { quarantineImpacts, resumeIndex, type QuarantineImpact } from "./prune.ts";
import { tgSend, tgWaitReply, type TgConn } from "./telegram.ts";
import { hostSecretsPath, tgConnForBaseLocation } from "./registry.ts";
import { issueNameFromTask, readEventLog, reduceCampaign } from "./status.ts";
import {
  acquireSlot,
  deregisterProject,
  registerProject,
  releaseSlot,
  reserveFestiveBlock,
  type HostBudget,
} from "./host-slots.ts";

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
 * identically (`docs/gateway.md`, the comms skeleton).
 */
const named = (name?: string): string => (name ? ` “${name}”` : "");

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
const selfSpawn = (args: string[]) =>
  spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: childSpawnEnv(process.env),
  });

/**
 * How `queue` runs one task: spawn a child `run` and resolve to its exit code
 * (`null` when the child was killed without one). Injected so the wave-loop can be
 * driven Docker-free in a test with a fake child that never touches a container —
 * the default spawns the real containerized `run` (#151). The exit-code contract is
 * `run`'s: `0` green, `2` parked, anything else an error.
 */
export type RunSpawner = (taskId: string) => Promise<number | null>;

/** The production spawner: a real child `run`, resolving on its exit. */
const selfSpawnRun: RunSpawner = (taskId) =>
  new Promise((resolve) => {
    selfSpawn(["run", taskId]).on("exit", (code) => resolve(code));
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
): Promise<Record<string, string>> {
  const pending = [...taskIds];
  const outcomes: Record<string, string> = {};
  let running = 0;
  // A standalone queue run records its own issue titles on the start event so the
  // dashboard names them with no lookup (ADR 0002); inside a campaign the caller
  // already wrote them onto `campaign-start` and passes them here, so we neither
  // re-resolve nor re-log them.
  const startTitles =
    titles === undefined ? await resolveTitles(cfg, taskIds) : undefined;
  // Only a standalone queue warns here; inside a campaign the caller passes `titles`
  // and has already warned once at campaign start, so we don't repeat it per wave.
  if (titles === undefined) warnIfTelegramUnconfigured(cfg);
  const startLog: Omit<QueueStartEvent, "ts" | "event"> = {
    taskIds,
    slots: host.ceiling,
    hostBudget: host.ceiling,
  };
  if (startTitles && Object.keys(startTitles).length)
    startLog.titles = startTitles;
  cfg.log.log("queue-start", startLog);
  enqueueOutbound(cfg, {
    category: "progress",
    event: "queue-start",
    text: `🚦 ${cfg.project} · QUEUE STARTED · ${taskIds.length} tasks, ≤${host.ceiling} containers\n${taskIds.join(", ")}\nReply to a parked question to resume it.`,
  });

  // The host container ceiling (ADR 0010/0011) is always in effect: the run marks
  // itself active so other projects drain toward their share, and every spawn is
  // gated on a cooperative lease so the sum of live containers across all projects
  // stays within the ceiling and within this project's current fair share.
  registerProject(host.configDir, cfg.project, host.weight);
  try {
    await new Promise<void>((done) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      const stopPoll = () => {
        if (poll) {
          clearInterval(poll);
          poll = undefined;
        }
      };
      const fill = () => {
        // No per-run cap: spawn as long as work remains and the cooperative lease
        // grants a slot — the fair share (and the ceiling) is the only bound.
        while (
          pending.length &&
          acquireSlot(host.configDir, host.ceiling, cfg.project, host.weight)
        ) {
          const next = pending.shift()!;
          running++;
          cfg.log.log("queue-spawn", { taskId: next, running, left: pending.length });
          spawnRun(next).then((code) => {
            running--;
            releaseSlot(host.configDir);
            outcomes[next] =
              code === 0 ? "green" : code === 2 ? "parked" : `error(${code})`;
            cfg.log.log("queue-slot-freed", { taskId: next, outcome: outcomes[next] });
            if (pending.length) fill();
            else if (running === 0) {
              stopPoll();
              done();
            }
          });
        }
        // Blocked by the ceiling or the fair share with work still queued: poll for
        // a slot another project frees (we have no event for that). Otherwise an
        // exit callback re-drives fill, so no poll is needed.
        if (pending.length) {
          if (!poll) poll = setInterval(fill, HOST_SLOT_POLL_MS);
        } else {
          stopPoll();
        }
      };
      fill();
    });
  } finally {
    deregisterProject(host.configDir);
  }

  const summary = taskIds.map((i) => `${i}: ${outcomes[i] ?? "?"}`).join("\n");
  cfg.log.log("queue-done", { outcomes });
  enqueueOutbound(cfg, {
    category: "progress",
    event: "queue-done",
    text: `🏁 ${cfg.project} · QUEUE DRAINED\n${summary}\nParked tasks stay answerable.`,
  });
  console.log(`queue drained:\n${summary}`);
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
 * The operator-facing notice a wave-park enqueues (ADR 0013). The merged base gated red
 * with no attributable culprit — every issue passed alone — so the wave's greens stay
 * merged on the base and the campaign pauses for a human to resolve: fix forward and
 * resume, or prune a suspect. `category: "failure"` routes it to the same alert channel
 * the old halt used, since a paused red base demands attention; the gate-report `detail`
 * tail rides along so the human sees why it went red. Pure, so the wording and routing
 * are checkable without running a campaign.
 */
export function waveParkedNotice(
  project: string,
  batchNumber: number,
  merged: string[],
  baseBranch: string,
  detail: string,
): { category: MessageCategory; event: string; text: string } {
  return {
    category: "failure",
    event: "wave-parked",
    text: `🅿️ ${project} · WAVE-PARKED · batch ${batchNumber}\nBase gated red, no attributable culprit — greens (${merged.join(", ") || "none"}) kept on ${baseBranch}, campaign paused.\nRecover: \`campaign --resume\` (after fix-forward) or \`prune <issue>\`\n\n${detail}`,
  };
}

/**
 * Render each quarantined issue and the dependents it stranded as `#640 → #701, #702`,
 * one per line — the shared body both quarantine notices show so a human reads the same
 * blast radius whether the campaign paused or pruned on.
 */
function describeQuarantineImpacts(impacts: QuarantineImpact[]): string {
  return impacts
    .map((i) => `  #${i.target} → ${i.dropped.map((d) => `#${d}`).join(", ")}`)
    .join("\n");
}

/**
 * The operator-facing notice a quarantine-pause enqueues (ADR 0013). A merge conflict
 * quarantined an issue whose dependents sit in later, unstarted waves — a blast-radius
 * call that belongs to a human — so the campaign pauses at the wave boundary with the
 * greens already merged left in place. `category: "failure"` routes it to the alert
 * channel a wave-park uses. The human has two moves: resolve the quarantined issue's
 * conflict and resume, or re-run with `--auto-prune` to prune the stranded dependents
 * and continue. Pure, so the wording and routing are checkable without a campaign.
 */
export function quarantinePauseNotice(
  project: string,
  batchNumber: number,
  impacts: QuarantineImpact[],
  baseBranch: string,
): { category: MessageCategory; event: string; text: string } {
  return {
    category: "failure",
    event: "quarantine-paused",
    text: `🅿️ ${project} · QUARANTINE-PAUSED · batch ${batchNumber}\nMerge-conflict quarantine stranded dependents in later waves — greens kept on ${baseBranch}, campaign paused.\nQuarantined → orphaned:\n${describeQuarantineImpacts(impacts)}\nRecover: \`campaign --resume\` (after resolving the conflict) or \`campaign --auto-prune\` to prune and continue`,
  };
}

/**
 * The notice `campaign --auto-prune` enqueues when it prunes a quarantine's stranded
 * dependents and runs on (ADR 0013). Informational — the campaign continued — so it
 * rides the `progress` channel, naming each quarantined issue and the dependents its
 * prune pruned. Pure, checkable without a campaign.
 */
export function autoPruneNotice(
  project: string,
  batchNumber: number,
  impacts: QuarantineImpact[],
): { category: MessageCategory; event: string; text: string } {
  return {
    category: "progress",
    event: "auto-prune",
    text: `✂️ ${project} · AUTO-PRUNE · batch ${batchNumber}\nQuarantine stranded dependents — closure pruned, campaign ran on.\nQuarantined → pruned:\n${describeQuarantineImpacts(impacts)}`,
  };
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
export interface CampaignDeps {
  spawnRun: RunSpawner;
  integrate: typeof integrateGreens;
  collectChangelog: typeof collectWaveChangelog;
  currentBranch: typeof currentBranch;
}
const defaultCampaignDeps: CampaignDeps = {
  spawnRun: selfSpawnRun,
  integrate: integrateGreens,
  collectChangelog: collectWaveChangelog,
  currentBranch,
};

/**
 * Drain each batch, then merge its greens into the base, re-verify the merged
 * base, clean up the merged branches/worktrees, and only then start the next
 * batch — the manual merge→test→next-queue chain, automated.
 *
 * Green-only by design: only green branches are merged. Once a wave is over,
 * parked records for its non-green tasks are cleared so stale questions do not
 * bleed into the next wave. Integration is non-atomic (ADR 0013): a merge conflict
 * quarantines just the conflicting green and the wave carries on with the rest,
 * while a red merged base — with no single culprit — wave-parks: the wave's greens
 * stay merged on the base and the campaign pauses for a human, with no changelog fold
 * and no `pending-verify` labels (a red base verifies nothing).
 *
 * A quarantine that strands dependents in later, unstarted waves is a blast-radius
 * call for a human, so by default the campaign pauses at the wave boundary (ADR 0013);
 * `opts.autoPrune` opts into pruning the stranded closure and running on. A quarantine
 * that orphans nothing never stops the campaign.
 *
 * `opts.resume` continues a *paused* campaign on the current base rather than starting a
 * fresh one (ADR 0013): it reconstructs the existing plan from the event log (no new
 * `campaign-start`, no re-resolved titles), skips every wave that already banked work
 * (`resumeIndex`), and runs the remainder — so a wave-park a human has fixed forward, or
 * a prune they resolved, picks up where it left off without redoing a merged issue. The
 * supplied `batches`/`name` are ignored under resume; the plan comes from the log. A
 * resume with nothing left to run reports so and returns green.
 */
export async function campaign(
  cfg: ResolvedConfig,
  batches: string[][],
  host: HostBudget,
  name?: string,
  opts: { autoPrune?: boolean; resume?: boolean } = {},
  deps: CampaignDeps = defaultCampaignDeps,
): Promise<boolean> {
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

  // Where the wave loop starts, the id→title map the per-wave `queue` calls carry, and the run's
  // human name — stamped onto every wave event and operator note so a resumed or mid-campaign run
  // never renders nameless (#174). Under resume the `--name` param is ignored, so the name is read
  // back from the log's `campaign-start` alongside the plan; otherwise it is the supplied param.
  let index = 0;
  let titles: Record<string, string>;
  let campaignName: string | undefined;

  if (opts.resume) {
    // Resume a paused campaign (ADR 0013): reconstruct the existing plan from the log —
    // no new `campaign-start`, no re-resolved titles — and skip every wave that already
    // banked work so no merged issue is redone. The supplied `batches`/`name` are ignored;
    // the plan is whatever the running campaign's `campaign-start` (minus any prune) reduced to.
    const reduced = reduceCampaign(readEventLog(cfg));
    if (!reduced.waves.length)
      throw new Error(
        "campaign --resume: no campaign found in the event log to resume. Launch one with `campaign <batch…>`.",
      );
    titles = Object.fromEntries(reduced.titles);
    campaignName = reduced.name;
    index = resumeIndex(reduced);
    if (index >= reduced.waves.length) {
      cfg.log.log("campaign-resume", { fromIndex: index, waves: reduced.waves.length, nothingLeft: true });
      enqueueOutbound(cfg, {
        category: "progress",
        event: "campaign-resume",
        text: `↩️ ${cfg.project} · RESUME · nothing to run — all ${reduced.waves.length} waves already merged`,
      });
      console.log("campaign --resume: nothing left to run — all waves already merged.");
      return true;
    }
    cfg.log.log("campaign-resume", { fromIndex: index, waves: reduced.waves.length });
    enqueueOutbound(cfg, {
      category: "progress",
      event: "campaign-resume",
      text: `↩️ ${cfg.project} · RESUME · wave ${index + 1}/${reduced.waves.length} on ${cfg.baseBranch} — continuing unrun waves`,
    });
    console.log(`campaign --resume: continuing from wave ${index + 1}/${reduced.waves.length}.`);
  } else {
    // Resolve the run's issue titles up front (the orchestrator has `fetchTask`) and
    // record them on the start event, so the dumb-router dashboard names every wave
    // and chip — live and archived — with no lookup of its own (ADR 0002). `name` is
    // still recorded only when given; a run whose titles could not be resolved simply
    // omits them and degrades to `number:status`.
    titles = await resolveTitles(cfg, batches.flat());
    campaignName = name;
    // Reserve this campaign's festive-name block from the host cursor (#193): the plan's
    // wave count is known now, so stamp the reserved offset onto `campaign-start` (read
    // back on resume alongside the name) and let the cursor advance past it — concurrent
    // campaigns draw disjoint blocks. The reservation is unconditional (a cheap integer):
    // the "Festive Wave Names" toggle only decides whether the dashboard renders the names.
    const startEvent: Omit<CampaignStartEvent, "ts" | "event"> = {
      batches,
      slots: host.ceiling,
      festiveOffset: reserveFestiveBlock(host.configDir, batches.length),
    };
    if (name) startEvent.name = name;
    if (Object.keys(titles).length) startEvent.titles = titles;
    cfg.log.log("campaign-start", startEvent);
    enqueueOutbound(cfg, {
      category: "progress",
      event: "campaign-start",
      text: `🎬 ${cfg.project} · CAMPAIGN${named(name)} · ${batches.length} batches\n${batches.map((b) => b.join(",")).join(" | ")}`,
    });
  }

  // The plan is re-derived from the log at each wave boundary rather than
  // iterated from the in-memory array: a `prune` event appended mid-campaign
  // prunes future waves here, while the in-flight wave (already past this point)
  // finishes as-is — the single-source-of-truth loop of ADR 0005.
  for (; ; index++) {
    const waves = reduceCampaign(readEventLog(cfg)).waves;
    if (index >= waves.length) break;
    const tasks = waves[index];
    const total = waves.length;
    const batchEvent: Omit<CampaignBatchEvent, "ts" | "event"> = { index, tasks };
    if (campaignName) batchEvent.name = campaignName;
    if (Object.keys(titles).length) batchEvent.titles = titles;
    cfg.log.log("campaign-batch", batchEvent);
    enqueueOutbound(cfg, {
      category: "progress",
      event: "wave-start",
      text: `▶️ ${cfg.project} · BATCH ${index + 1}/${total}${named(campaignName)}\n${tasks.join(", ")}`,
    });

    const outcomes = await queue(cfg, tasks, host, titles, deps.spawnRun);
    const greens = tasks.filter((t) => outcomes[t] === "green");
    const held = tasks.filter((t) => outcomes[t] !== "green");

    const { merged, quarantined, parked } = await deps.integrate(cfg, greens);
    if (parked) {
      // Wave-park (ADR 0013): the merged base gated red with no attributable culprit, so
      // `integrateGreens` left the greens merged (never a rollback) and logged the
      // `wave-parked` event. Draw a human's attention and pause the campaign — no
      // changelog fold and no `pending-verify` labels for this wave, since a red base
      // verifies nothing; those wait for the human to resolve it green and resume.
      enqueueOutbound(cfg, waveParkedNotice(cfg.project, index + 1, merged, cfg.baseBranch, parked.detail));
      console.log(
        `campaign wave-parked (${parked.reason}) at batch ${index + 1}/${total} — greens left merged, base paused, ${total - index - 1} batch(es) not started. Fix forward and \`campaign --resume\`, or \`prune <issue>\`.`,
      );
      return false;
    }

    // Green path only: fold this wave's merged changelog.d/ fragments into
    // CHANGELOG.md and commit on the base in one commit (issue #123). Agents write
    // per-task fragments instead of editing the shared changelog, so co-wave
    // branches never conflict on it; the orchestrator collects at merge. A halted
    // wave (handled above) rolls back and leaves its fragments for the retry.
    const collected = deps.collectChangelog(index, cfg.log);
    if (collected.committed)
      console.log(
        `batch ${index + 1}/${total}: collected changelog fragments — ${collected.collected.join(", ")}`,
      );

    // Green path only: advance each merged issue to `pending-verify` via the
    // configured `onIssueMerged` seam (issue #103). Best-effort — a failing write
    // is logged and never touches the halt/rollback path, which already returned
    // above on a red gate. Only the green `merged` set is passed.
    await markMergedIssues(cfg, merged);

    // Gate 1 (ADR 0017): a per-issue park escalates to a wave-park. A parked issue is
    // unfinished work awaiting a human, so — like a quarantined green (below) and unlike
    // the rest of `held` — its record is spared the wave-boundary clear: clearing it would
    // take the question dark (off the dashboard, unanswerable on Telegram) and leave the
    // issue unresumable.
    const parkedTasks = tasks.filter((t) => outcomes[t] === "parked");
    const toClear = held.filter((t) => outcomes[t] !== "parked");
    if (toClear.length) clearParkedForTasks(cfg, toClear);
    if (parkedTasks.length) {
      // The wave drained and its greens merged under Gate 2 above, but an issue parked, so
      // the wave is not fully resolved. Escalate to the existing wave-park state — no new
      // event — rather than folding the park into `held` and advancing: record it before any
      // batch-done (so it reads as the in-flight parked wave, not a closed one), draw a
      // human, and stop the campaign at the wave boundary so no succeeding wave builds on
      // unresolved work. Recovery is answer/resolve or prune, then `campaign --resume`.
      const detail = `parked, awaiting a human: ${parkedTasks.join(", ")}`;
      cfg.log.log("wave-parked", { merged, detail });
      enqueueOutbound(cfg, waveParkedNotice(cfg.project, index + 1, merged, cfg.baseBranch, detail));
      console.log(
        `campaign wave-parked (issue parked) at batch ${index + 1}/${total} — greens (${merged.join(", ") || "none"}) left merged, base paused, ${total - index - 1} batch(es) not started. Answer/resolve the park and \`campaign --resume\`, or \`prune <issue>\`.`,
      );
      return false;
    }
    const note = held.length
      ? ` — cleared parked records for completed wave: ${held.map((t) => `${t}(${outcomes[t]})`).join(", ")}`
      : "";
    // A merge conflict quarantined these greens (ADR 0013): their work is preserved
    // and resumable, so — unlike `held` — their parked records are left untouched.
    const qNote = quarantined.length
      ? ` — quarantined on merge conflict (kept for you): ${quarantined.join(", ")}`
      : "";
    const batchDoneEvent: Omit<CampaignBatchDoneEvent, "ts" | "event"> = { index, merged, held, clearedParked: held, quarantined };
    if (campaignName) batchDoneEvent.name = campaignName;
    if (Object.keys(titles).length) batchDoneEvent.titles = titles;
    cfg.log.log("campaign-batch-done", batchDoneEvent);
    enqueueOutbound(cfg, {
      category: "success",
      event: "wave-merged",
      text: `✅ ${cfg.project} · BATCH ${index + 1} MERGED${named(campaignName)}\n${merged.join(", ") || "nothing"}${note}${qNote}`,
    });
    console.log(
      `batch ${index + 1}/${total}: merged ${merged.join(", ") || "nothing"}${note}${qNote}`,
    );

    // Quarantine blast-radius (ADR 0013): a merge conflict pulled an issue from this
    // wave, so its transitive dependents in later, unstarted waves cannot proceed. We
    // walk the same dependency graph `prune` uses (via `blockedBy`); without that
    // resolver the campaign declares no dependencies, so nothing can be orphaned. Only
    // a quarantine that actually strands later-wave work forces the decision below.
    if (quarantined.length && cfg.blockedBy) {
      const plan = reduceCampaign(readEventLog(cfg));
      const orphaning = (
        await quarantineImpacts(plan, quarantined, cfg.blockedBy)
      ).filter((i) => i.dropped.length);
      if (orphaning.length) {
        if (opts.autoPrune) {
          // Prune each stranded closure by appending a prune event the loop honors at
          // the next wave boundary (ADR 0005), exactly as `prune <issue>` does, then
          // run on. The quarantined issue itself (banked green) is kept; only its
          // unstarted dependents leave the plan.
          for (const impact of orphaning)
            cfg.log.log("prune", { target: impact.target, removed: impact.removed, dropped: impact.dropped });
          enqueueOutbound(cfg, autoPruneNotice(cfg.project, index + 1, orphaning));
          console.log(
            `batch ${index + 1}/${total}: --auto-prune pruned ${orphaning.map((i) => `#${i.target}→${i.dropped.map((d) => `#${d}`).join(",")}`).join("; ")} and continued.`,
          );
        } else {
          // Default: the blast-radius call belongs to a human. Pause at the wave
          // boundary with the greens left merged; a human resolves the quarantine and
          // resumes, or re-runs with --auto-prune to prune and continue. Log an explicit
          // `wave-parked` (like the red-base and per-issue-park pauses) so the log carries
          // a terminal park marker — a stranded quarantine is never indistinguishable
          // from a crash (ADR 0019).
          const detail = `stranded conflict: quarantine stranded ${orphaning
            .flatMap((i) => i.dropped)
            .map((d) => `#${d}`)
            .join(", ")} in later waves`;
          cfg.log.log("wave-parked", { merged, detail });
          enqueueOutbound(cfg, quarantinePauseNotice(cfg.project, index + 1, orphaning, cfg.baseBranch));
          console.log(
            `campaign paused after batch ${index + 1}/${total} — quarantine stranded ${orphaning.flatMap((i) => i.dropped).map((d) => `#${d}`).join(", ")} in later waves; ${total - index - 1} batch(es) not started. Resolve and \`campaign --resume\`, or re-run with \`campaign --auto-prune\`.`,
          );
          return false;
        }
      }
    }
  }

  const doneEvent: Omit<CampaignDoneEvent, "ts" | "event"> = { batches: index };
  if (campaignName) doneEvent.name = campaignName;
  cfg.log.log("campaign-done", doneEvent);
  enqueueOutbound(cfg, {
    category: "success",
    event: "campaign-complete",
    text: `🏆 ${cfg.project} · CAMPAIGN COMPLETE${named(campaignName)} · ${index} batches onto ${cfg.baseBranch}`,
  });
  console.log("campaign complete.");
  return true;
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
