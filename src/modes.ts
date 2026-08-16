import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { makeSandbox } from "./sandbox.ts";
import { answerPromptFor, runLoop, type ResumeEntry } from "./loop.ts";
import { clearParked, hasParked, listParked, readParked } from "./state.ts";
import { tgConfigured, tgDrain, tgPoll, tgSend, tgWaitReply } from "./telegram.ts";

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

/** Bounded pool: keeps `slots` runs alive; a park frees its slot immediately. */
export async function queue(cfg: ResolvedConfig, taskIds: string[], slots: number) {
  const pending = [...taskIds];
  const outcomes: Record<string, string> = {};
  let running = 0;
  log("queue-start", { taskIds, slots });
  await tgSend(`🚦 ${cfg.project} queue started: ${taskIds.join(", ")} — ${slots} slots. Run \`dispatch\` to answer parked questions.`);

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
  await tgSend(`🏁 ${cfg.project} queue drained.\n${summary}\nParked tasks stay answerable via dispatch.`);
  console.log(`queue drained:\n${summary}`);
}

/**
 * The ONE Telegram poller for any number of parallel runs: routes each reply to
 * the task whose park message it replies to and spawns that resume as a child,
 * so several answered tasks proceed at once.
 */
export async function dispatch(cfg: ResolvedConfig) {
  const inFlight = new Set<string>();
  const available = () => listParked(cfg).filter((p) => !inFlight.has(p.taskId));

  const resume = (taskId: string, text: string) => {
    inFlight.add(taskId);
    log("dispatch", { taskId, chars: text.length });
    void tgSend(`▶️ Resuming ${taskId} with your answer.`);
    selfSpawn(["answer", taskId, text]).on("exit", (code) => {
      inFlight.delete(taskId);
      log("dispatch-done", { taskId, code });
      // green / re-park messaging is the child's own job.
      if (code !== 0 && code !== 2) void tgSend(`⚠️ Resume of ${taskId} exited with code ${code} — check the orchestrator logs.`);
    });
  };

  const pending = available();
  await tgSend(
    pending.length
      ? `📋 ${cfg.project} dispatcher up. Parked and waiting:\n${pending.map((p) => `${p.taskId} (${p.reason})`).join("\n")}\nReply to a question message to resume it.`
      : `📋 ${cfg.project} dispatcher up. Nothing parked yet — questions will arrive here as runs block.`,
  );

  let offset = await tgDrain();
  for (;;) {
    const r = await tgPoll(offset);
    offset = r.offset;
    for (const m of r.messages) {
      const recs = available();
      const byReply = m.replyToId ? recs.find((p) => p.tgMessageId === m.replyToId) : undefined;
      const target = byReply ?? (!m.replyToId && recs.length === 1 ? recs[0] : undefined);
      if (target) resume(target.taskId, m.text);
      else if (!recs.length) void tgSend(inFlight.size ? "Nothing parked; resumes in flight — hold on." : "Nothing is parked right now.");
      else void tgSend(`Reply directly to one question message to route your answer. Parked: ${recs.map((p) => p.taskId).join(", ")}`);
    }
  }
}

/** Single task, self-answering via Telegram: run → park → reply → resume → … */
export async function attend(cfg: ResolvedConfig, taskId: string) {
  let entry: ResumeEntry | undefined;

  // A record already on disk is a pending question (possibly from a run that
  // parked with Telegram unconfigured): surface it rather than restarting.
  if (hasParked(cfg, taskId)) {
    const parked = readParked(cfg, taskId);
    const msgId = await tgSend(`⏸ ${cfg.project} has a pending question (${parked.reason}) on ${taskId}\n\n${parked.question}\n\nReply to this message to answer and resume.`);
    console.log(`[sctdd] existing parked state for ${taskId} — waiting for a Telegram reply…`);
    entry = { resumeSessionId: parked.sessionId!, answerPrompt: answerPromptFor(await tgWaitReply(msgId)) };
    await tgSend(`▶️ Resuming ${taskId} with your answer.`);
  }

  for (;;) {
    const status = await runLoop(cfg, taskId, entry);
    if (status !== "parked") break;
    const parked = readParked(cfg, taskId);
    console.log(`[sctdd] waiting for a Telegram reply to resume ${taskId}…`);
    const reply = await tgWaitReply(parked.tgMessageId);
    log("telegram-answer", { taskId, chars: reply.length });
    await tgSend(`▶️ Resuming ${taskId} with your answer.`);
    entry = { resumeSessionId: parked.sessionId!, answerPrompt: answerPromptFor(reply) };
  }
}

export async function tgTest(cfg: ResolvedConfig) {
  const msgId = await tgSend(`🔧 ${cfg.project} orchestrator test — reply to this message and I'll echo it back.`);
  if (msgId == null) throw new Error("sendMessage failed — token rejected or chat id wrong (see telegram-send-failed in the log)");
  console.log(`sent (message_id ${msgId}); waiting for your reply…`);
  const reply = await tgWaitReply(msgId);
  await tgSend(`✅ round-trip works — got: "${reply.slice(0, 200)}"`);
  console.log(`got reply: "${reply}" — round-trip verified`);
}

export function requireTelegram(mode: string) {
  if (!tgConfigured()) {
    console.error(`${mode} needs SANDCASTLE_TELEGRAM_BOT_TOKEN and SANDCASTLE_TELEGRAM_CHAT_ID in the orchestrator's environment`);
    process.exit(1);
  }
}

export { clearParked, listParked };
