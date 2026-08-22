import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";
import { currentBranch, integrateGreens } from "./merge.ts";
import { clearParked, clearParkedForTasks, enqueueOutbound, listParked } from "./state.ts";
import { tgConfigured, tgEnvConn, tgSend, tgWaitReply } from "./telegram.ts";
import { issueNameFromTask, readEvents, reduceCampaign } from "./status.ts";

/**
 * Resolve each issue's title through the orchestrator's `fetchTask`, keyed by
 * normalized id, so a run can record an id→title map on its start event for the
 * dumb-router dashboard to read with no live lookup of its own (ADR 0002).
 * Best-effort: an id whose task cannot be fetched or carries no structured title
 * is simply absent from the map — its chip then falls back to `number:status` and
 * its wave to the bare index, and the whole run still starts (no throw).
 */
export async function resolveTitles(cfg: Pick<ResolvedConfig, "fetchTask">, ids: string[]): Promise<Record<string, string>> {
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
  spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], { stdio: ["ignore", "inherit", "inherit"] });

/**
 * Prove the image can run the gates before trusting any agent result: a
 * toolchain probe, then every gate unconditionally. No agent, no cost.
 */
export async function baseline(cfg: ResolvedConfig) {
  const sbx = await makeSandbox(cfg, "baseline");
  try {
    if (cfg.toolchainProbe) {
      const probe = await sbx.exec(cfg.toolchainProbe);
      log("toolchain", { exitCode: probe.exitCode, out: (probe.stdout ?? "").trim() });
      if (probe.exitCode !== 0) throw new Error(`toolchain probe failed: ${probe.stderr}`);
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
 * Bounded pool: keeps `slots` runs alive; a park frees its slot immediately.
 * Returns the per-task outcome map so a caller (campaign) can act on the greens
 * without re-deriving them from the log.
 */
export async function queue(cfg: ResolvedConfig, taskIds: string[], slots: number, titles?: Record<string, string>): Promise<Record<string, string>> {
  const pending = [...taskIds];
  const outcomes: Record<string, string> = {};
  let running = 0;
  // A standalone queue run records its own issue titles on the start event so the
  // dashboard names them with no lookup (ADR 0002); inside a campaign the caller
  // already wrote them onto `campaign-start` and passes them here, so we neither
  // re-resolve nor re-log them.
  const startTitles = titles === undefined ? await resolveTitles(cfg, taskIds) : undefined;
  log("queue-start", startTitles && Object.keys(startTitles).length ? { taskIds, slots, titles: startTitles } : { taskIds, slots });
  enqueueOutbound(cfg, {
    category: "progress",
    event: "queue-start",
    text: `🚦 ${cfg.project} queue started: ${taskIds.join(", ")} — ${slots} slots. The gateway announces parked questions; reply to resume.`,
  });

  await new Promise<void>((done) => {
    const fill = () => {
      while (running < slots && pending.length) {
        const next = pending.shift()!;
        running++;
        log("queue-spawn", { taskId: next, running, left: pending.length });
        selfSpawn(["run", next]).on("exit", (code) => {
          running--;
          outcomes[next] = code === 0 ? "green" : code === 2 ? "parked" : `error(${code})`;
          log("queue-slot-freed", { taskId: next, outcome: outcomes[next] });
          if (pending.length) fill();
          else if (running === 0) done();
        });
      }
    };
    fill();
  });

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
export async function campaign(cfg: ResolvedConfig, batches: string[][], slots: number, name?: string): Promise<boolean> {
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
  const startEvent: Record<string, unknown> = { batches, slots };
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
    const waves = reduceCampaign(readEvents(cfg)).waves;
    if (index >= waves.length) break;
    const tasks = waves[index];
    const total = waves.length;
    log("campaign-batch", { index, tasks });
    enqueueOutbound(cfg, {
      category: "progress",
      event: "wave-start",
      text: `▶️ ${cfg.project} campaign batch ${index + 1}/${total}: ${tasks.join(", ")}`,
    });

    const outcomes = await queue(cfg, tasks, slots, titles);
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
      console.log(`campaign halted (${halt.reason}${where}) — base rolled back, ${total - index - 1} batch(es) not started.`);
      return false;
    }

    if (held.length) clearParkedForTasks(cfg, held);
    const note = held.length ? ` — cleared parked records for completed wave: ${held.map((t) => `${t}(${outcomes[t]})`).join(", ")}` : "";
    log("campaign-batch-done", { index, merged, held, clearedParked: held });
    enqueueOutbound(cfg, {
      category: "success",
      event: "wave-merged",
      text: `✅ ${cfg.project} campaign batch ${index + 1} merged: ${merged.join(", ") || "nothing"}${note}`,
    });
    console.log(`batch ${index + 1}/${total}: merged ${merged.join(", ") || "nothing"}${note}`);
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

export async function tgTest(cfg: ResolvedConfig) {
  // Guaranteed non-null: tgTest is only reachable behind requireTelegram.
  const conn = tgEnvConn()!;
  const msgId = await tgSend(conn, `🔧 ${cfg.project} orchestrator test — reply to this message and I'll echo it back.`);
  if (msgId == null) throw new Error("sendMessage failed — token rejected or chat id wrong (see telegram-send-failed in the log)");
  console.log(`sent (message_id ${msgId}); waiting for your reply…`);
  const reply = await tgWaitReply(conn, msgId);
  await tgSend(conn, `✅ round-trip works — got: "${reply.slice(0, 200)}"`);
  console.log(`got reply: "${reply}" — round-trip verified`);
}

export function requireTelegram(mode: string) {
  if (!tgConfigured()) {
    console.error(`${mode} needs SANDCASTLE_TELEGRAM_BOT_TOKEN and SANDCASTLE_TELEGRAM_CHAT_ID in the orchestrator's environment`);
    process.exit(1);
  }
}

export { clearParked, listParked };
