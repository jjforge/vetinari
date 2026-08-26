import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";
import type { CampaignStartEvent, QueueStartEvent } from "./event-log.ts";
import { log } from "./log.ts";
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
import { tgSend, tgWaitReply, type TgConn } from "./telegram.ts";
import { hostSecretsPath, tgConnForBaseLocation } from "./registry.ts";
import { issueNameFromTask, readEventLog, reduceCampaign } from "./status.ts";
import {
  acquireSlot,
  deregisterProject,
  registerProject,
  releaseSlot,
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
 * Re-invoke this CLI as a child, preserving however it was launched (the tsx
 * loader flags live in execArgv). Spawning a bare `node` would fail on TS.
 */
const selfSpawn = (args: string[]) =>
  spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    stdio: ["ignore", "inherit", "inherit"],
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
      log("toolchain", {
        exitCode: probe.exitCode,
        out: (probe.stdout ?? "").trim(),
      });
      if (probe.exitCode !== 0)
        throw new Error(`toolchain probe failed: ${probe.stderr}`);
    }
    const { green, report } = await runGates(cfg, sbx, { all: true });
    log("baseline", { green });
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
  log("build", { image: cfg.image, dockerfile: DOCKERFILE, exitCode: code });
  if (code !== 0) return false;
  if (!opts.baseline) return true;
  return deps.baseline(cfg);
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
  const startLog: Omit<QueueStartEvent, "ts" | "event"> = {
    taskIds,
    slots: host.ceiling,
    hostBudget: host.ceiling,
  };
  if (startTitles && Object.keys(startTitles).length)
    startLog.titles = startTitles;
  log("queue-start", startLog);
  enqueueOutbound(cfg, {
    category: "progress",
    event: "queue-start",
    text: `🚦 ${cfg.project} queue started: ${taskIds.join(", ")} — up to ${host.ceiling} containers. The gateway announces parked questions; reply to resume.`,
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
          log("queue-spawn", { taskId: next, running, left: pending.length });
          selfSpawn(["run", next]).on("exit", (code) => {
            running--;
            releaseSlot(host.configDir);
            outcomes[next] =
              code === 0 ? "green" : code === 2 ? "parked" : `error(${code})`;
            log("queue-slot-freed", { taskId: next, outcome: outcomes[next] });
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
  log("queue-done", { outcomes });
  enqueueOutbound(cfg, {
    category: "progress",
    event: "queue-done",
    text: `🏁 ${cfg.project} queue drained.\n${summary}\nParked tasks stay answerable — the gateway routes your replies.`,
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
 * rest. Only the green `merged` set is passed in, so parked/carved/failed issues
 * are excluded by construction.
 */
export async function markMergedIssues(
  cfg: Pick<ResolvedConfig, "onIssueMerged">,
  merged: string[],
): Promise<void> {
  if (!cfg.onIssueMerged) return;
  for (const taskId of merged) {
    try {
      await cfg.onIssueMerged(taskId);
    } catch (error) {
      log("issue-merged-hook-failed", {
        taskId,
        error: String((error as any)?.message ?? error),
      });
    }
  }
}

/**
 * Drain each batch, then merge its greens into the base, re-verify the merged
 * base, clean up the merged branches/worktrees, and only then start the next
 * batch — the manual merge→test→next-queue chain, automated.
 *
 * Green-only by design: only green branches are merged. Once a wave is over,
 * parked records for its non-green tasks are cleared so stale questions do not
 * bleed into the next wave. A merge conflict or a red
 * merged base halts the whole campaign with the base rolled back to where the
 * batch began — no later batch runs on a broken or half-merged base.
 */
export async function campaign(
  cfg: ResolvedConfig,
  batches: string[][],
  host: HostBudget,
  name?: string,
): Promise<boolean> {
  // Every green branch merges into whatever the main tree has checked out, and
  // each batch's agents cut their branch from that same HEAD. If it is not the
  // base branch the campaign would merge into, and build on, the wrong place.
  const branch = currentBranch();
  if (branch !== cfg.baseBranch) {
    throw new Error(
      `campaign merges into the checked-out branch, but the working tree is on "${branch}", not baseBranch "${cfg.baseBranch}". Run \`git checkout ${cfg.baseBranch}\` first (a clean tree — the merges land here).`,
    );
  }

  // Resolve the run's issue titles up front (the orchestrator has `fetchTask`) and
  // record them on the start event, so the dumb-router dashboard names every wave
  // and chip — live and archived — with no lookup of its own (ADR 0002). `name` is
  // still recorded only when given; a run whose titles could not be resolved simply
  // omits them and degrades to `number:status`.
  const titles = await resolveTitles(cfg, batches.flat());
  const startEvent: Omit<CampaignStartEvent, "ts" | "event"> = {
    batches,
    slots: host.ceiling,
  };
  if (name) startEvent.name = name;
  if (Object.keys(titles).length) startEvent.titles = titles;
  log("campaign-start", startEvent);
  enqueueOutbound(cfg, {
    category: "progress",
    event: "campaign-start",
    text: `🎬 ${cfg.project} campaign${name ? ` “${name}”` : ""}: ${batches.length} batch(es) — ${batches.map((b) => b.join(",")).join(" | ")}`,
  });

  // The plan is re-derived from the log at each wave boundary rather than
  // iterated from the in-memory array: a `carve` event appended mid-campaign
  // prunes future waves here, while the in-flight wave (already past this point)
  // finishes as-is — the single-source-of-truth loop of ADR 0005.
  let index = 0;
  for (; ; index++) {
    const waves = reduceCampaign(readEventLog(cfg)).waves;
    if (index >= waves.length) break;
    const tasks = waves[index];
    const total = waves.length;
    log("campaign-batch", { index, tasks });
    enqueueOutbound(cfg, {
      category: "progress",
      event: "wave-start",
      text: `▶️ ${cfg.project} campaign batch ${index + 1}/${total}: ${tasks.join(", ")}`,
    });

    const outcomes = await queue(cfg, tasks, host, titles);
    const greens = tasks.filter((t) => outcomes[t] === "green");
    const held = tasks.filter((t) => outcomes[t] !== "green");

    const { merged, halt } = await integrateGreens(cfg, greens);
    if (halt) {
      const where = halt.taskId ? ` on ${halt.taskId}` : "";
      log("campaign-halt", { index, reason: halt.reason, taskId: halt.taskId });
      enqueueOutbound(cfg, {
        category: "failure",
        event: "halt",
        text: `🛑 ${cfg.project} campaign HALTED at batch ${index + 1} — ${halt.reason}${where}. Base rolled back; branches kept for you.\n\n${halt.detail}`,
      });
      console.log(
        `campaign halted (${halt.reason}${where}) — base rolled back, ${total - index - 1} batch(es) not started.`,
      );
      return false;
    }

    // Green path only: fold this wave's merged changelog.d/ fragments into
    // CHANGELOG.md and commit on the base in one commit (issue #123). Agents write
    // per-task fragments instead of editing the shared changelog, so co-wave
    // branches never conflict on it; the orchestrator collects at merge. A halted
    // wave (handled above) rolls back and leaves its fragments for the retry.
    const collected = collectWaveChangelog(index);
    if (collected.committed)
      console.log(
        `batch ${index + 1}/${total}: collected changelog fragments — ${collected.collected.join(", ")}`,
      );

    // Green path only: advance each merged issue to `pending-verify` via the
    // configured `onIssueMerged` seam (issue #103). Best-effort — a failing write
    // is logged and never touches the halt/rollback path, which already returned
    // above on a red gate. Only the green `merged` set is passed.
    await markMergedIssues(cfg, merged);

    if (held.length) clearParkedForTasks(cfg, held);
    const note = held.length
      ? ` — cleared parked records for completed wave: ${held.map((t) => `${t}(${outcomes[t]})`).join(", ")}`
      : "";
    log("campaign-batch-done", { index, merged, held, clearedParked: held });
    enqueueOutbound(cfg, {
      category: "success",
      event: "wave-merged",
      text: `✅ ${cfg.project} campaign batch ${index + 1} merged: ${merged.join(", ") || "nothing"}${note}`,
    });
    console.log(
      `batch ${index + 1}/${total}: merged ${merged.join(", ") || "nothing"}${note}`,
    );
  }

  log("campaign-done", { batches: index });
  enqueueOutbound(cfg, {
    category: "success",
    event: "campaign-complete",
    text: `🏆 ${cfg.project} campaign complete — ${index} batch(es) merged onto ${cfg.baseBranch}.`,
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
