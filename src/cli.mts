#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import {
  applyCollect,
  formatMilestoneDate,
  FRAGMENT_DIR,
} from "./changelog.ts";
import { log, setLogFile } from "./log.ts";
import { answerPromptFor, runLoop } from "./loop.ts";
import {
  baseline,
  build,
  campaign,
  queue,
  requireTelegram,
  tgTest,
} from "./modes.ts";
import { gateway } from "./gateway.ts";
import { applyCarve, carveClosure, computeCarve, normalize } from "./carve.ts";
import {
  describePlan,
  planCampaign,
  suggestCampaignName,
  underspecifiedPromptFor,
  waveArgs,
  type UnderspecifiedDecision,
} from "./plan.ts";
import { defaultFileSet, ticketProse } from "./fileset.ts";
import {
  applyLayoutMigration,
  computeLayoutMigration,
  describeMigration,
  resolvedGatewayUnit,
  scanLayout,
  systemdUnitPath,
  writeGatewayUnit,
} from "./migrate.ts";
import { applyInit, computeInit, describeInit, scanInit } from "./init.ts";
import { archiveRun, shouldArchiveLeftover } from "./archive.ts";
import {
  clearParkedForTasks,
  enqueueOutbound,
  listParked,
  readParked,
} from "./state.ts";
import { autoRegister, gatewayConfigDir } from "./registry.ts";
import { resolveHostCeiling, type HostBudget } from "./host-slots.ts";
import { containerShareWeight } from "./config.ts";
import {
  campaignRunning,
  readEventLog,
  reduceCampaign,
  serveAllStatus,
} from "./status.ts";
import { runStatusLine } from "./statusline.ts";
import {
  computeInstall,
  computeUninstall,
  DEFAULT_RUN_COMMAND,
  describeInstall,
  describeUninstall,
  localStatusLineShadows,
  readInheritedStatusLine,
  readSettings,
  SETTINGS_REL,
  writeSettings,
} from "./statusline-install.ts";

const USAGE = `vetinari <mode> [args]

  build [--no-baseline]    build the agent image (cfg.image from vetinari/Dockerfile,
                           neither repeated on the CLI) via sandcastle, then run
                           baseline on success. --no-baseline builds only. A build or
                           baseline failure exits non-zero with sandcastle's output shown
  baseline                 prove the image runs every gate green — no agent, no cost
  run <task>               the TDD loop: agent turn → gate → resume on red
  queue <task…>            fair-share pool over several tasks (bounded by the host
                           ceiling and this project's containerShare — no per-run cap)
  campaign [--name "…"] [--auto-carve] <batch…>
                           queue each batch, then merge greens → gate base → next batch.
                           --name labels the run in the dashboard + archived-runs list.
                           If a merge-conflict quarantine strands dependents in later
                           waves the campaign pauses for a human by default; --auto-carve
                           prunes the stranded closure and runs on (ADR 0013)
  carve <issue>            prune <issue> + everything blocked by it from the RUNNING
                           campaign: appends a carve event the loop honors at the next
                           wave boundary (the in-flight wave finishes; only future waves
                           shrink). Banked work stays — a merged/green member is kept,
                           only parked/not-yet-started ones leave. A carved issue's
                           parked record (branch/worktree/session) is preserved so it
                           stays resumable; --purge is the rare true-drop that clears
                           it. Needs a running campaign (--dry-run to only preview).
  carve <issue> <batch…>   drop <issue> + everything blocked by it, then run the rest
                           as a fresh reduced campaign from the plan you supply
                           (--dry-run to only print the reduced plan)
  campaign-plan <ids…>     layer a selected set into dependency-ordered, file-
                           disjoint wave args (paste after \`campaign\`) + a
                           provenance report, and a suggested \`--name\` from the
                           area labels the selected issues span. Plans only — never
                           runs campaign, never pushes. A ticket whose file-set can't be resolved
                           confidently halts and asks; --on-underspecified=drop|fail
                           pre-decides for non-interactive runs (no flag, no
                           terminal defaults to fail).
  init [--dry-run]         scaffold a NEW project onto the layout: create the committed
                           vetinari/ (a defineConfig skeleton + a Dockerfile template),
                           the excluded .vetinari.local/, and add .vetinari.local/ to
                           .gitignore. Idempotent and non-clobbering — an existing
                           vetinari/ config is never overwritten (--dry-run to print the
                           plan and write nothing). Installs and vendors nothing
  migrate [--dry-run]      move this project onto the vetinari/ + .vetinari.local/
                           layout: config → vetinari/, old .sandcastle/ state →
                           .vetinari.local/, .gitignore updated, the host-side
                           orchestrator.env renamed to host.env, a stale gateway.env
                           deleted, the systemd unit rewritten into the host-level
                           gateway service, VETINARI_TELEGRAM_* stripped from the
                           container gate .env (rotate any token exposed there), a
                           numeric hostWeight translated to a containerShare tier, and
                           the host-slots ceiling file renamed max-concurrent-containers
                           (--dry-run to print the plan and change nothing)
  changelog collect [--title "…"]
                           fold this repo's changelog.d/*.md fragments into
                           CHANGELOG.md under today's milestone (append to the top
                           milestone if it is dated today, else start one), then
                           delete the consumed fragments. What the orchestrator runs
                           per wave at merge; a human may run it directly. --title
                           sets a fresh milestone's title (default: "Collected changes")
  answer <task> <text>     resume a parked task with a human answer
  gateway                  the host daemon fronting every registered project: the
                           sole Telegram consumer and sender — announces parked
                           questions, routes replies to the right project+task,
                           and resumes them concurrently via the shared install.
                           Also recognizes \`carve <issue>\` (and \`carve <project>
                           <issue>\` when several campaigns run on one bot):
                           previews the closure and carves the resolved project on
                           a \`yes\` reply to the preview
  gateway install [--dry-run]
                           write the host-level systemd unit for THIS install to
                           ~/.config/systemd/user/vetinari-gateway.service, with a
                           fully absolute node + tsx-loader + cli ExecStart — no
                           bash -lc, env, npx, or PATH dependency, so it starts under
                           systemd's clean environment (fixes the nvm/fnm/mise/asdf
                           crash-loop). Re-run after a node/tsx upgrade (--dry-run to
                           print the unit and write nothing)
  parked                   list parked tasks and their questions
  clear                    archive the run log + clear parked, resetting the
                           dashboard/status line to idle (automatic on clean
                           campaign/queue completion; this forces it now)
  status [--port <port>] [--host <host>]
                           one dashboard over the host registry: campaign/wave and
                           parked status for every registered project, a dropdown to
                           switch between them (a single project is one entry). Reads
                           the registry, so no gateway daemon is required
  statusline               one compact line for the Claude Code status bar (reads
                           Claude Code's JSON on stdin; wire into settings.json)
  statusline install [--run-command "<cmd>"] [--dry-run]
                           wire the status line into the project's committed
                           .claude/settings.json. A status line already configured
                           there is kept as line 1 with the 🏰 campaign line added
                           under it (never replaced). Idempotent. --run-command sets
                           how the CLI is invoked (default: npx vetinari statusline)
  statusline uninstall [--dry-run]
                           remove it, restoring whatever status line it wrapped
  tg-test                  prove the Telegram round-trip

Options: --config <path>   (default: vetinari/config.mts in cwd)

Host container ceiling: set MAX_CONCURRENT_CONTAINERS (or a max-concurrent-containers
file in the gateway config dir) to cap live containers across ALL projects; every
queue/campaign cooperates through a filesystem lease to stay within it. Unset resolves
to a machine-derived default (never unbounded). There is no per-run cap: a lone project
fills the ceiling. A project's cut when projects contend is its \`containerShare\`
(high | medium | low, default medium). See ADR 0010 and ADR 0011.`;

/**
 * The interactive under-specified halt: shown only on a terminal (the flag/TTY
 * gate lives in `underspecifiedPromptFor`). Offers the two choices from the spec —
 * drop the under-specified tickets and their dependents and plan the rest, or stop
 * so the requestor can put the file data on the issue and re-run.
 */
async function askUnderspecified(
  underspecified: string[],
): Promise<UnderspecifiedDecision> {
  const list = underspecified.map((i) => `#${i}`).join(", ");
  const [subj, obj] =
    underspecified.length === 1 ? ["has", "it"] : ["have", "them"];
  console.log(
    `\ncampaign-plan: ${list} ${subj} no confident file-set.\n` +
      `  [d] drop ${obj} and ${underspecified.length === 1 ? "its" : "their"} dependents, and plan the rest\n` +
      `  [s] stop so you can add the file data to the issue(s) and re-run`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("drop or stop? [d/s] "))
        .trim()
        .toLowerCase();
      if (answer === "d" || answer === "drop") return "drop";
      if (answer === "s" || answer === "stop") return "fail";
      console.log('please answer "d" (drop) or "s" (stop).');
    }
  } finally {
    rl.close();
  }
}

/**
 * The label names on a fetched task, read from the tracker JSON `fetchTask`
 * returns (GitHub's `--json labels` yields `{ labels: [{ name }] }`). Best-effort:
 * anything that does not parse as labelled JSON has no labels. `suggestCampaignName`
 * filters these down to the known area set.
 */
const labelsFromTask = (task: string): string[] => {
  try {
    const parsed = JSON.parse(task) as { labels?: unknown };
    const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
    return labels
      .map((l) => (typeof l === "string" ? l : (l as { name?: unknown })?.name))
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
};

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
  const sub = rest[0];

  // `statusline install|uninstall` edits the project's committed .claude/settings.json,
  // wrapping (never replacing) any status line already configured there. Pure planner
  // + edge IO, like init/migrate; runs before the strict config load (a project need
  // not be a Vetinari project yet to wire the bar).
  if (sub === "install" || sub === "uninstall") {
    const dryRun = rest.includes("--dry-run");
    const rcIdx = rest.indexOf("--run-command");
    const runCommand =
      rcIdx >= 0 && rest[rcIdx + 1] ? rest[rcIdx + 1] : DEFAULT_RUN_COMMAND;
    const dir = process.cwd();
    const settings = readSettings(dir);
    // The line the project inherits from ~/.claude/settings.json — wrapped as line 1
    // when the project has none of its own, so installing does not shadow (and blank
    // the colours of) the user's configured status line.
    const inheritedBase = readInheritedStatusLine();
    // A statusLine in the higher-precedence .claude/settings.local.json owns the
    // rendered block, so writing here would be inert — the planner turns that into
    // a warning-and-skip rather than a shadowed write (see docs/statusline.md).
    const shadowedByLocal = localStatusLineShadows(dir);
    if (sub === "install") {
      const plan = computeInstall(settings, {
        runCommand,
        inheritedBase,
        shadowedByLocal,
      });
      console.log(describeInstall(plan, SETTINGS_REL));
      if (dryRun) console.log("\n(dry run — nothing was written)");
      else if (!plan.alreadyInstalled && !plan.shadowedByLocal)
        writeSettings(dir, plan.settings);
    } else {
      const plan = computeUninstall(settings, {
        inheritedBase,
        shadowedByLocal,
      });
      console.log(describeUninstall(plan, SETTINGS_REL));
      if (dryRun) console.log("\n(dry run — nothing was written)");
      else if (plan.wasInstalled) writeSettings(dir, plan.settings);
    }
    process.exit(0);
  }

  // The status bar renderer. An optional `--base-b64` carries the wrapped base
  // command (a status line that was already configured when we installed), which
  // install encodes into the command string; we run it for line 1.
  const bIdx = rest.indexOf("--base-b64");
  const baseCommand =
    bIdx >= 0 && rest[bIdx + 1]
      ? Buffer.from(rest[bIdx + 1], "base64").toString("utf8")
      : undefined;
  await runStatusLine(cfgPath, { baseCommand });
  process.exit(0);
}

// init scaffolds a project's layout onto cwd — it must run BEFORE the strict
// config load, since a greenfield project has no config yet (init is what lays
// the config down).
if (mode === "init") {
  const dryRun = rest.includes("--dry-run");
  const plan = computeInit(scanInit(process.cwd()));
  console.log(describeInit(plan));
  if (dryRun) {
    console.log("\n(dry run — nothing was written)");
    process.exit(0);
  }
  const result = applyInit(process.cwd(), plan);
  const did: string[] = [];
  if (result.created.length)
    did.push(`created ${result.created.length} file(s)`);
  if (result.dirsCreated.length)
    did.push(`created ${result.dirsCreated.length} dir(s)`);
  if (result.gitignoreUpdated) did.push("updated .gitignore");
  if (did.length) console.log(`\nDone: ${did.join(", ")}.`);
  process.exit(0);
}

// changelog collect folds this repo's changelog.d/ fragments into CHANGELOG.md.
// It operates on cwd's files (like init/migrate) and needs no project config, so it
// runs BEFORE the strict config load — the orchestrator calls the same edge
// (applyCollect) directly per wave; this is the human-facing entry point.
if (mode === "changelog") {
  if (rest[0] !== "collect") {
    console.error(
      'changelog needs a subcommand: `vetinari changelog collect [--title "…"]`',
    );
    process.exit(1);
  }
  const titleIdx = rest.indexOf("--title");
  const title =
    titleIdx >= 0 && rest[titleIdx + 1]
      ? rest[titleIdx + 1]
      : "Collected changes";
  const dir = process.cwd();
  const { collected } = applyCollect({
    fragmentsDir: join(dir, FRAGMENT_DIR),
    changelogPath: join(dir, "CHANGELOG.md"),
    today: formatMilestoneDate(new Date()),
    title,
  });
  console.log(
    collected.length
      ? `collected ${collected.length} fragment(s) into CHANGELOG.md: ${collected.join(", ")}`
      : `nothing to collect — ${FRAGMENT_DIR}/ has no fragments.`,
  );
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
  const did: string[] = [];
  if (result.moved.length) did.push(`moved ${result.moved.length} path(s)`);
  if (result.gitignoreUpdated) did.push("updated .gitignore");
  if (result.gatewayEnvDeleted) did.push("deleted the stale gateway.env");
  if (result.unitRewritten)
    did.push("rewrote the systemd unit into the gateway service");
  if (result.envRewritten)
    did.push("stripped host-side secrets from the container gate .env");
  if (result.configRewritten)
    did.push("translated hostWeight → containerShare");
  if (result.hostCeilingRenamed)
    did.push("renamed the host-ceiling file to max-concurrent-containers");
  if (did.length) console.log(`\nMigrated: ${did.join(", ")}.`);
  process.exit(0);
}

// The gateway is a HOST-level daemon fronting every registered project, not a
// per-project mode — it reads each project's config and secrets live from the
// registry, so it must run BEFORE the strict cwd config load (which the gateway's
// own directory need not satisfy).
if (mode === "gateway") {
  // `gateway install` writes THIS host's resolved unit — a fully absolute node +
  // tsx-loader + cli invocation — to systemdUnitPath(). The unit can't be a static
  // committed file: the per-host absolute launch chain (and the crash-loop it fixes,
  // #133) is what a static `bash -lc 'exec vetinari …'` unit could never carry.
  if (rest[0] === "install") {
    const dryRun = rest.includes("--dry-run");
    const path = systemdUnitPath();
    const content = resolvedGatewayUnit();
    console.log(`vetinari gateway install → ${path}\n\n${content}`);
    if (dryRun) {
      console.log("(dry run — nothing was written)");
    } else {
      writeGatewayUnit(path, content);
      console.log(
        `Wrote ${path}. Reload and start it:\n` +
          `  systemctl --user daemon-reload\n` +
          `  systemctl --user enable --now vetinari-gateway   # start now + at every login\n` +
          `  loginctl enable-linger "$USER"                       # and at boot\n` +
          `Re-run \`vetinari gateway install\` after a node or tsx upgrade — the unit pins their absolute paths.`,
      );
    }
    process.exit(0);
  }
  await gateway();
  process.exit(0);
}

// status is one dashboard over the host registry, not a per-project mode (ADR
// 0006): auto-register always populates the registry, so `serveAllStatus` fronts
// every registered project — a single, no-gateway project is just a one-entry
// dropdown. Like the gateway, it reads the host registry live and must run BEFORE
// the strict cwd config load (no project config in cwd is fine).
if (mode === "status") {
  const portIdx = rest.indexOf("--port");
  const hostIdx = rest.indexOf("--host");
  const port =
    portIdx >= 0
      ? Number(rest[portIdx + 1])
      : Number(process.env.VETINARI_STATUS_PORT ?? 8765);
  const host =
    hostIdx >= 0
      ? rest[hostIdx + 1]
      : (process.env.VETINARI_STATUS_HOST ?? "127.0.0.1");
  if (!Number.isInteger(port) || port < 0)
    throw new Error("status --port needs a non-negative integer");
  if (!host)
    throw new Error("status --host needs a host, e.g. 127.0.0.1 or 0.0.0.0");
  await serveAllStatus(gatewayConfigDir(), { port, host });
  // serveAllStatus resolves once it is listening; the process must then stay up
  // to serve, so park here instead of exiting (an exit would kill the server the
  // instant it bound). We never fall through to the strict cwd config load.
  await new Promise<never>(() => {});
}

const cfg = await loadConfig(cfgPath);
setLogFile(cfg.logFile);

// Enroll (or refresh) this project's pointer with the gateway at the start of
// every run, so a project registers itself with no manual step (ADR 0002).
// Pointer-only and best-effort — never fatal to the run.
autoRegister(cfg);

// Resolve the host container ceiling once (ADR 0011): always in effect —
// MAX_CONCURRENT_CONTAINERS (or the max-concurrent-containers file) when set, else
// a machine-derived default. Every queue/campaign carries it and this project's
// containerShare-derived weight into the cooperative filesystem lease; there is no
// per-run cap.
const hostBudget: HostBudget = {
  configDir: gatewayConfigDir(),
  ceiling: resolveHostCeiling(gatewayConfigDir()),
  weight: containerShareWeight(cfg.containerShare),
};

// Reset the live state the dashboard and status line read once a run is truly
// over, so a finished run stops showing as current. Skip while anything is still
// parked — an unanswered question means the run is not finished.
const archiveIfIdle = () => {
  if (listParked(cfg).length) return;
  const r = archiveRun(cfg);
  log("archived", {
    archivedLog: r.archivedLog ?? null,
    clearedParked: r.clearedParked,
    clearedOutbound: r.clearedOutbound,
  });
  if (r.archivedLog) console.log(`archived run log → ${r.archivedLog}`);
};

// Before a new run appends to the live log, archive any prior run still sitting in
// it — an interruption that bypassed the end-of-run archive (crash, kill) would
// otherwise concatenate the old run ahead of the new one, and the run-summary fold
// would report only the terminal run, burying the earlier one. No-ops on a fresh or
// marker-only log (nothing to archive) and, via archiveIfIdle, while anything is
// parked (a parked run is being resumed, not superseded). A child `run` spawned by a
// queue/campaign (VETINARI_CHILD) never archives — the "leftover" it would see is its
// own parent's in-flight log (#150).
const archiveLeftoverRun = () => {
  const isChild = !!process.env.VETINARI_CHILD;
  if (shouldArchiveLeftover(cfg, { isChild })) archiveIfIdle();
};

switch (mode) {
  case "build": {
    // Default builds AND baselines; --no-baseline builds only. False (a build or
    // baseline failure) maps to a non-zero exit; sandcastle's output was inherited.
    const runBaseline = !rest.includes("--no-baseline");
    process.exitCode = (await build(cfg, { baseline: runBaseline })) ? 0 : 1;
    break;
  }
  case "baseline": {
    process.exitCode = (await baseline(cfg)) ? 0 : 1;
    break;
  }
  case "run": {
    if (!rest[0]) throw new Error("run needs a task id");
    archiveLeftoverRun();
    // Exit code is the queue's slot signal: 0 green, 2 parked, other = error.
    process.exitCode = (await runLoop(cfg, rest[0])) === "green" ? 0 : 2;
    break;
  }
  case "queue": {
    if (!rest.length) throw new Error("queue needs at least one task id");
    archiveLeftoverRun();
    await queue(cfg, rest, hostBudget);
    archiveIfIdle();
    break;
  }
  case "campaign": {
    // Each positional arg is one batch: `campaign "436 611 623" "640 655" "701"`;
    // an optional `--name "…"` labels the run in the dashboard and archive.
    let name: string | undefined;
    // `--auto-carve` opts into pruning a quarantine's stranded dependents and running
    // on; the default pauses at the wave boundary for a human (ADR 0013).
    let autoCarve = false;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith("--name=")) name = a.slice("--name=".length);
      else if (a === "--name") name = rest[++i];
      else if (a === "--auto-carve") autoCarve = true;
      else positional.push(a);
    }
    const batches = positional
      .map((b) => b.split(/[\s,]+/).filter(Boolean))
      .filter((b) => b.length);
    if (!batches.length)
      throw new Error(
        'campaign needs at least one batch: campaign "436 611" "623 640"',
      );
    archiveLeftoverRun();
    // Archive every completed run — failed/halted or clean — so a halt still enters
    // the archived-runs list to inspect (#141). archiveIfIdle no-ops while parked,
    // so a still-waiting run (not finished) stays live as before.
    await campaign(cfg, batches, hostBudget, name, { autoCarve });
    archiveIfIdle();
    break;
  }
  case "carve": {
    const dryRun = rest.includes("--dry-run");
    // `--purge` is the rare true-drop: clear the carved issue's parked record too,
    // discarding its resumable session. Default carve preserves it (ADR 0013).
    const purge = rest.includes("--purge");
    const positional = rest.filter((a) => a !== "--dry-run" && a !== "--purge");
    const [target, ...batchArgs] = positional;
    if (!target)
      throw new Error(
        'carve needs an issue: `carve 640` prunes the running campaign, `carve 640 "611 640" "623 701"` launches a reduced one.',
      );
    if (!cfg.blockedBy)
      throw new Error(
        'carve needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").',
      );

    const tgt = normalize(target);
    const describe = (removed: string[], remaining: string[][]) => {
      const dependents = removed.filter((id) => id !== tgt);
      console.log(
        `carve #${tgt} → removed ${removed.map((i) => `#${i}`).join(", ")}` +
          (dependents.length
            ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})`
            : " (no dependents)"),
      );
      console.log(
        `remaining campaign: ${remaining.length ? remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
      );
    };
    const carveNote = (removed: string[], remaining: string[][]) => {
      const dependents = removed.filter((id) => id !== tgt);
      return (
        `✂️ ${cfg.project} carved #${tgt} — dropped ${removed.map((i) => `#${i}`).join(", ")}` +
        (dependents.length
          ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})`
          : "") +
        `. Remaining: ${remaining.length ? remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "nothing left to run"}.`
      );
    };

    // No plan → prune the RUNNING campaign: reduce the log to its current plan,
    // compute the closure, apply the keep-banked-work rule, then append a carve
    // event the loop honors at its next wave boundary (ADR 0005).
    if (!batchArgs.length) {
      const events = readEventLog(cfg);
      if (!campaignRunning(events)) {
        throw new Error(
          "carve <issue> prunes a running campaign, but none is running. To launch a reduced campaign from a plan you supply, pass the waves: " +
            'carve <issue> "611 640" "623 701".',
        );
      }
      const reduced = reduceCampaign(events);
      const { removed } = await computeCarve(
        reduced.waves,
        target,
        cfg.blockedBy,
      );
      const applied = applyCarve(reduced, removed, { purge });
      const { remaining, dropped, parkedToClear } = applied;
      const kept = removed.filter((id) => !dropped.includes(id));
      console.log(
        `carve #${tgt} → ${dropped.length ? `dropping ${dropped.map((i) => `#${i}`).join(", ")}` : "nothing to drop"}` +
          (kept.length
            ? ` (keeping banked ${kept.map((i) => `#${i}`).join(", ")})`
            : ""),
      );
      console.log(
        `remaining campaign: ${remaining.length ? remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
      );
      const parkedDropped = dropped.filter((id) => reduced.outcomes.get(id) === "parked");
      if (parkedDropped.length)
        console.log(
          purge
            ? `purging parked ${parkedDropped.map((i) => `#${i}`).join(", ")} — clearing their records and resumable sessions.`
            : `preserving parked ${parkedDropped.map((i) => `#${i}`).join(", ")} — branch/worktree/session kept, resumable (--purge to drop).`,
        );
      if (dryRun) {
        // Structured closure alongside the human text, so a consumer (the
        // aggregated dashboard's carve preview) can name the exact closure
        // without re-parsing the prose above.
        console.log(
          `carve-closure ${JSON.stringify(carveClosure(target, removed, applied))}`,
        );
        break;
      }

      // Preserve carved work by default: the dropped issue leaves the plan but its
      // parked record (branch/worktree/session) stays so it can be investigated and
      // resumed (ADR 0013). Only `--purge` clears it — the rare true-drop — and
      // `applyCarve` reflects that in `parkedToClear`.
      if (parkedToClear.length) clearParkedForTasks(cfg, parkedToClear);
      // Append the carve event — the running loop re-reads it at the next wave
      // boundary; `removed` is the closure so the fold replays the same rule.
      log("carve", { target: tgt, removed, dropped });
      enqueueOutbound(cfg, {
        category: "progress",
        event: "carve",
        text:
          `✂️ ${cfg.project} carved #${tgt} from the running campaign — ` +
          (dropped.length
            ? `dropped ${dropped.map((i) => `#${i}`).join(", ")}`
            : "nothing to drop") +
          (kept.length
            ? ` (kept banked ${kept.map((i) => `#${i}`).join(", ")})`
            : "") +
          `. Remaining: ${remaining.length ? remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "nothing left to run"}.`,
      });
      console.log(
        "carve event appended — the running campaign will prune future waves at the next wave boundary.",
      );
      break;
    }

    // Explicit plan → launch a fresh reduced campaign (unchanged behavior).
    const batches = batchArgs
      .map((b) => b.split(/[\s,]+/).filter(Boolean))
      .filter((b) => b.length);
    const { removed, remaining } = await computeCarve(
      batches,
      target,
      cfg.blockedBy,
    );
    describe(removed, remaining);

    if (dryRun) break;

    // A carve had no notification before E4 — emit a progress:carve record so it
    // is announced and routable like any other outbound message (ADR 0002).
    enqueueOutbound(cfg, {
      category: "progress",
      event: "carve",
      text: carveNote(removed, remaining),
    });

    if (!remaining.length) {
      console.log("nothing left to run after the carve — done.");
      break;
    }
    await campaign(cfg, remaining, hostBudget);
    break;
  }
  case "campaign-plan": {
    // A flat selected set of ids: `campaign-plan 436 611 623 640 701`.
    // `--on-underspecified=drop|fail` pre-decides the halt for non-interactive runs.
    let onUnderspecified: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith("--on-underspecified="))
        onUnderspecified = a.slice("--on-underspecified=".length);
      else if (a === "--on-underspecified") onUnderspecified = rest[++i];
      else positional.push(a);
    }
    const ids = positional.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
    if (!ids.length)
      throw new Error(
        "campaign-plan needs at least one ticket id: campaign-plan 436 611 640",
      );
    if (!cfg.blockedBy)
      throw new Error(
        'campaign-plan needs a "blockedBy" resolver in your config — e.g. blockedBy: githubBlockedBy("owner/repo").',
      );

    // Which files each ticket touches: the project's resolver, or the shipped
    // cites-from-body default, validated against the current tree at plan time.
    // `ticketProse` narrows what the resolver scans to the author's title+body,
    // so a stray filename-shaped token in any comment cannot poison confidence.
    const resolveFileSet = cfg.fileSet ?? defaultFileSet();
    const plan = await planCampaign(ids, {
      blockedBy: cfg.blockedBy,
      fileSet: async (id) =>
        resolveFileSet(ticketProse(await cfg.fetchTask(id))),
      onUnderspecified: underspecifiedPromptFor({
        flag: onUnderspecified,
        isTTY: Boolean(process.stdin.isTTY),
        ask: askUnderspecified,
      }),
    });

    // The bare wave args, then the human-readable provenance report. Plans only.
    console.log(
      waveArgs(plan) || "(nothing schedulable — every ticket is unreachable)",
    );
    console.log("");
    console.log(describePlan(plan));

    // A suggested --name from the area labels the selected issues span — printed to
    // paste or edit, never stored. The label resolver reads each issue's labels off
    // the same fetchTask the plan uses.
    const suggestedName = await suggestCampaignName(ids, async (id) =>
      labelsFromTask(String(await cfg.fetchTask(id))),
    );
    if (suggestedName)
      console.log(`\nsuggested name: --name "${suggestedName}"`);
    break;
  }
  case "answer": {
    const [taskId, ...text] = rest;
    if (!taskId || !text.length)
      throw new Error(
        'answer needs a task id and text: answer <task> "<answer>"',
      );
    const parked = readParked(cfg, taskId);
    process.exitCode =
      (await runLoop(cfg, taskId, {
        resumeSessionId: parked.sessionId!,
        answerPrompt: answerPromptFor(text.join(" ")),
      })) === "green"
        ? 0
        : 2;
    break;
  }
  case "parked": {
    const recs = listParked(cfg);
    if (!recs.length) console.log("nothing parked");
    for (const r of recs)
      console.log(
        `\n=== ${r.taskId} (${r.reason}, ${r.parkedAt}) branch ${r.branch}\n${r.question}\n`,
      );
    break;
  }
  case "clear": {
    // Force a reset now, even with questions still parked — the manual escape
    // hatch, unlike the automatic archive that waits for an idle queue.
    const r = archiveRun(cfg);
    log("archived", {
      archivedLog: r.archivedLog ?? null,
      clearedParked: r.clearedParked,
      clearedOutbound: r.clearedOutbound,
    });
    console.log(
      r.archivedLog
        ? `archived run log → ${r.archivedLog}`
        : "no run log to archive",
    );
    console.log(
      `cleared ${r.clearedParked} parked record(s) — dashboard and status line now read idle`,
    );
    break;
  }
  case "tg-test": {
    // Resolve creds from this project's host.env the way the gateway does, so a
    // green tg-test guarantees the gateway can send (issue #117) — not from the
    // invoking shell's env, which the gateway never reads.
    const conn = requireTelegram(
      "tg-test",
      resolve(process.cwd(), cfg.stateDir),
    );
    await tgTest(cfg, conn);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(1);
}
