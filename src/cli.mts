#!/usr/bin/env -S npx tsx
import { loadConfig } from "./config.ts";
import { setLogFile } from "./log.ts";
import { answerPromptFor, runLoop } from "./loop.ts";
import { attend, baseline, campaign, dispatch, queue, requireTelegram, tgTest } from "./modes.ts";
import { listParked, readParked } from "./state.ts";
import { serveStatus } from "./status.ts";

const USAGE = `sandcastle-tdd <mode> [args]

  baseline                 prove the image runs every gate green — no agent, no cost
  run <task>               the TDD loop: agent turn → gate → resume on red
  queue <task…>            bounded pool over several tasks (QUEUE_SLOTS, default 3)
  campaign <batch…>        queue each batch, then merge greens → gate base → next batch
  answer <task> <text>     resume a parked task with a human answer
  attend <task>            one task, answering itself via Telegram replies
  dispatch                 the ONE Telegram poller; routes replies to parked tasks
  parked                   list parked tasks and their questions
  status [--port <port>] [--host <host>]
                           local web page for campaign/wave and parked status
  tg-test                  prove the Telegram round-trip

Options: --config <path>   (default: sandcastle-tdd.config.mts in cwd)`;

const argv = process.argv.slice(2);
const cfgIdx = argv.indexOf("--config");
const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined;
if (cfgIdx >= 0) argv.splice(cfgIdx, 2);
const [mode, ...rest] = argv;

if (!mode) {
  console.log(USAGE);
  process.exit(1);
}

const cfg = await loadConfig(cfgPath);
setLogFile(cfg.logFile);

switch (mode) {
  case "baseline": {
    process.exitCode = (await baseline(cfg)) ? 0 : 1;
    break;
  }
  case "run": {
    if (!rest[0]) throw new Error("run needs a task id");
    // Exit code is the queue's slot signal: 0 green, 2 parked, other = error.
    process.exitCode = (await runLoop(cfg, rest[0])) === "green" ? 0 : 2;
    break;
  }
  case "queue": {
    if (!rest.length) throw new Error("queue needs at least one task id");
    await queue(cfg, rest, Math.max(1, Number(process.env.QUEUE_SLOTS ?? 3)));
    break;
  }
  case "campaign": {
    // Each arg is one batch: `campaign "436 611 623" "640 655" "701"`.
    const batches = rest.map((b) => b.split(/[\s,]+/).filter(Boolean)).filter((b) => b.length);
    if (!batches.length) throw new Error('campaign needs at least one batch: campaign "436 611" "623 640"');
    await campaign(cfg, batches, Math.max(1, Number(process.env.QUEUE_SLOTS ?? 3)));
    break;
  }
  case "answer": {
    const [taskId, ...text] = rest;
    if (!taskId || !text.length) throw new Error('answer needs a task id and text: answer <task> "<answer>"');
    const parked = readParked(cfg, taskId);
    process.exitCode = (await runLoop(cfg, taskId, { resumeSessionId: parked.sessionId!, answerPrompt: answerPromptFor(text.join(" ")) })) === "green" ? 0 : 2;
    break;
  }
  case "attend": {
    if (!rest[0]) throw new Error("attend needs a task id");
    requireTelegram("attend");
    await attend(cfg, rest[0]);
    break;
  }
  case "dispatch": {
    requireTelegram("dispatch");
    await dispatch(cfg);
    break;
  }
  case "parked": {
    const recs = listParked(cfg);
    if (!recs.length) console.log("nothing parked");
    for (const r of recs) console.log(`\n=== ${r.taskId} (${r.reason}, ${r.parkedAt}) branch ${r.branch}\n${r.question}\n`);
    break;
  }
  case "status": {
    const portIdx = rest.indexOf("--port");
    const hostIdx = rest.indexOf("--host");
    const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : Number(process.env.SANDCASTLE_STATUS_PORT ?? 8765);
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : process.env.SANDCASTLE_STATUS_HOST ?? "127.0.0.1";
    if (!Number.isInteger(port) || port < 0) throw new Error("status --port needs a non-negative integer");
    if (!host) throw new Error("status --host needs a host, e.g. 127.0.0.1 or 0.0.0.0");
    await serveStatus(cfg, { port, host, configPath: cfgPath });
    break;
  }
  case "tg-test": {
    requireTelegram("tg-test");
    await tgTest(cfg);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(1);
}
