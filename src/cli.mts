#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.ts";
import { log, setLogFile } from "./log.ts";
import { answerPromptFor, runLoop } from "./loop.ts";
import { baseline, campaign, queue, requireTelegram, tgTest } from "./modes.ts";
import { gateway } from "./gateway.ts";
import { computeCarve } from "./carve.ts";
import { describePlan, planCampaign, underspecifiedPromptFor, waveArgs, type UnderspecifiedDecision } from "./plan.ts";
import { defaultFileSet } from "./fileset.ts";
import { applyLayoutMigration, computeLayoutMigration, describeMigration, scanLayout } from "./migrate.ts";
import { archiveRun } from "./archive.ts";
import { listParked, readParked } from "./state.ts";
import { autoRegister } from "./registry.ts";
import { serveStatus } from "./status.ts";
import { runStatusLine } from "./statusline.ts";

const USAGE = `sandcastle-tdd <mode> [args]

  baseline                 prove the image runs every gate green — no agent, no cost
  run <task>               the TDD loop: agent turn → gate → resume on red
  queue <task…>            bounded pool over several tasks (QUEUE_SLOTS, default 3)
  campaign <batch…>        queue each batch, then merge greens → gate base → next batch
  carve <issue> <batch…>   drop <issue> + everything blocked by it, then run the rest
                           as a campaign (--dry-run to only print the reduced plan)
  campaign-plan <ids…>     layer a selected set into dependency-ordered, file-
                           disjoint wave args (paste after \`campaign\`) + a
                           provenance report. Plans only — never runs campaign,
                           never pushes. A ticket whose file-set can't be resolved
                           confidently halts and asks; --on-underspecified=drop|fail
                           pre-decides for non-interactive runs (no flag, no
                           terminal defaults to fail).
  migrate [--dry-run]      move this project onto the sandcastle/ + .sandcastle.local/
                           layout: config → sandcastle/, old .sandcastle/ state →
                           .sandcastle.local/, .gitignore updated (--dry-run to print
                           the plan and change nothing)
  answer <task> <text>     resume a parked task with a human answer
  gateway                  the host daemon fronting every registered project: the
                           sole Telegram consumer and sender — announces parked
                           questions, routes replies to the right project+task,
                           and resumes them concurrently via the shared install
  parked                   list parked tasks and their questions
  clear                    archive the run log + clear parked, resetting the
                           dashboard/status line to idle (automatic on clean
                           campaign/queue completion; this forces it now)
  status [--port <port>] [--host <host>]
                           local web page for campaign/wave and parked status
  statusline               one compact line for the Claude Code status bar (reads
                           Claude Code's JSON on stdin; wire into settings.json)
  tg-test                  prove the Telegram round-trip

Options: --config <path>   (default: sandcastle-tdd.config.mts in cwd)`;

/**
 * The interactive under-specified halt: shown only on a terminal (the flag/TTY
 * gate lives in `underspecifiedPromptFor`). Offers the two choices from the spec —
 * drop the under-specified tickets and their dependents and plan the rest, or stop
 * so the requestor can put the file data on the issue and re-run.
 */
async function askUnderspecified(underspecified: string[]): Promise<UnderspecifiedDecision> {
  const list = underspecified.map((i) => `#${i}`).join(", ");
  const [subj, obj] = underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
  console.log(
    `\ncampaign-plan: ${list} ${subj} no confident file-set.\n` +
      `  [d] drop ${obj} and ${underspecified.length === 1 ? "its" : "their"} dependents, and plan the rest\n` +
      `  [s] stop so you can add the file data to the issue(s) and re-run`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("drop or stop? [d/s] ")).trim().toLowerCase();
      if (answer === "d" || answer === "drop") return "drop";
      if (answer === "s" || answer === "stop") return "fail";
      console.log('please answer "d" (drop) or "s" (stop).');
    }
  } finally {
    rl.close();
  }
}

const argv = process.argv.slice(2);
const cfgIdx = argv.indexOf("--config");
const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined;
if (cfgIdx >= 0) argv.splice(cfgIdx, 2);
const [mode, ...rest] = argv;

if (!mode) {
  console.log(USAGE);
  process.exit(1);
}

// The Claude Code status bar runs this on every refresh, in any directory, and
// blanks the line on a non-zero exit — so it must stay lenient (no config here
// is fine) and never fall through to the strict config load below.
if (mode === "statusline") {
  await runStatusLine(cfgPath);
  process.exit(0);
}

// migrate operates purely on the filesystem layout of cwd — it must run BEFORE
// the strict config load, since a not-yet-migrated project's config lives in a
// deprecated location (or is what we are about to move into place).
if (mode === "migrate") {
  const dryRun = rest.includes("--dry-run");
  const plan = computeLayoutMigration(scanLayout(process.cwd()));
  console.log(describeMigration(plan));
  if (plan.conflicts.length) process.exit(1);
  if (dryRun) {
    console.log("\n(dry run — nothing was changed)");
    process.exit(0);
  }
  const result = applyLayoutMigration(process.cwd(), plan);
  if (result.moved.length || result.gitignoreUpdated) {
    console.log(`\nMigrated: moved ${result.moved.length} path(s)${result.gitignoreUpdated ? ", updated .gitignore" : ""}.`);
  }
  process.exit(0);
}

// The gateway is a HOST-level daemon fronting every registered project, not a
// per-project mode — it reads each project's config and secrets live from the
// registry, so it must run BEFORE the strict cwd config load (which the gateway's
// own directory need not satisfy).
if (mode === "gateway") {
  await gateway();
  process.exit(0);
}

const cfg = await loadConfig(cfgPath);
setLogFile(cfg.logFile);

// Enroll (or refresh) this project's pointer with the gateway at the start of
// every run, so a project registers itself with no manual step (ADR 0002).
// Pointer-only and best-effort — never fatal to the run.
autoRegister(cfg);

// Reset the live state the dashboard and status line read once a run is truly
// over, so a finished run stops showing as current. Skip while anything is still
// parked — an unanswered question means the run is not finished.
const archiveIfIdle = () => {
  if (listParked(cfg).length) return;
  const r = archiveRun(cfg);
  log("archived", { archivedLog: r.archivedLog ?? null, clearedParked: r.clearedParked });
  if (r.archivedLog) console.log(`archived run log → ${r.archivedLog}`);
};

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
    archiveIfIdle();
    break;
  }
  case "campaign": {
    // Each arg is one batch: `campaign "436 611 623" "640 655" "701"`.
    const batches = rest.map((b) => b.split(/[\s,]+/).filter(Boolean)).filter((b) => b.length);
    if (!batches.length) throw new Error('campaign needs at least one batch: campaign "436 611" "623 640"');
    // Archive only a clean run — a halt leaves state deliberately, to inspect.
    if (await campaign(cfg, batches, Math.max(1, Number(process.env.QUEUE_SLOTS ?? 3)))) archiveIfIdle();
    break;
  }
  case "carve": {
    const dryRun = rest.includes("--dry-run");
    const positional = rest.filter((a) => a !== "--dry-run");
    const [target, ...batchArgs] = positional;
    if (!target || !batchArgs.length) throw new Error('carve needs an issue and a campaign: carve 640 "611 640" "623 701"');
    if (!cfg.blockedBy) throw new Error('carve needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").');

    const batches = batchArgs.map((b) => b.split(/[\s,]+/).filter(Boolean)).filter((b) => b.length);
    const { removed, remaining } = await computeCarve(batches, target, cfg.blockedBy);

    const dependents = removed.filter((id) => id !== target.replace(/^#/, "").trim());
    console.log(`carve #${target.replace(/^#/, "")} → removed ${removed.map((i) => `#${i}`).join(", ")}` + (dependents.length ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})` : " (no dependents)"));
    console.log(`remaining campaign: ${remaining.length ? remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`);

    if (dryRun) break;
    if (!remaining.length) {
      console.log("nothing left to run after the carve — done.");
      break;
    }
    await campaign(cfg, remaining, Math.max(1, Number(process.env.QUEUE_SLOTS ?? 3)));
    break;
  }
  case "campaign-plan": {
    // A flat selected set of ids: `campaign-plan 436 611 623 640 701`.
    // `--on-underspecified=drop|fail` pre-decides the halt for non-interactive runs.
    let onUnderspecified: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith("--on-underspecified=")) onUnderspecified = a.slice("--on-underspecified=".length);
      else if (a === "--on-underspecified") onUnderspecified = rest[++i];
      else positional.push(a);
    }
    const ids = positional.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
    if (!ids.length) throw new Error("campaign-plan needs at least one ticket id: campaign-plan 436 611 640");
    if (!cfg.blockedBy) throw new Error('campaign-plan needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").');

    // Which files each ticket touches: the project's resolver, or the shipped
    // cites-from-body default, validated against the current tree at plan time.
    const resolveFileSet = cfg.fileSet ?? defaultFileSet();
    const plan = await planCampaign(ids, {
      blockedBy: cfg.blockedBy,
      fileSet: async (id) => resolveFileSet(await cfg.fetchTask(id)),
      onUnderspecified: underspecifiedPromptFor({ flag: onUnderspecified, isTTY: Boolean(process.stdin.isTTY), ask: askUnderspecified }),
    });

    // The bare wave args, then the human-readable provenance report. Plans only.
    console.log(waveArgs(plan) || "(nothing schedulable — every ticket is unreachable)");
    console.log("");
    console.log(describePlan(plan));
    break;
  }
  case "answer": {
    const [taskId, ...text] = rest;
    if (!taskId || !text.length) throw new Error('answer needs a task id and text: answer <task> "<answer>"');
    const parked = readParked(cfg, taskId);
    process.exitCode = (await runLoop(cfg, taskId, { resumeSessionId: parked.sessionId!, answerPrompt: answerPromptFor(text.join(" ")) })) === "green" ? 0 : 2;
    break;
  }
  case "parked": {
    const recs = listParked(cfg);
    if (!recs.length) console.log("nothing parked");
    for (const r of recs) console.log(`\n=== ${r.taskId} (${r.reason}, ${r.parkedAt}) branch ${r.branch}\n${r.question}\n`);
    break;
  }
  case "clear": {
    // Force a reset now, even with questions still parked — the manual escape
    // hatch, unlike the automatic archive that waits for an idle queue.
    const r = archiveRun(cfg);
    log("archived", { archivedLog: r.archivedLog ?? null, clearedParked: r.clearedParked });
    console.log(r.archivedLog ? `archived run log → ${r.archivedLog}` : "no run log to archive");
    console.log(`cleared ${r.clearedParked} parked record(s) — dashboard and status line now read idle`);
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
