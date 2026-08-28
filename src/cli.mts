#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline/promises";
import { mkdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, resolveConfigPath, type ResolvedConfig } from "./config.ts";
import {
  applyCollect,
  formatMilestoneDate,
  FRAGMENT_DIR,
} from "./changelog.ts";
import {
  hostLogger,
  hostLogTarget,
  readHostLog,
  readHostLogLines,
  renderHostEvent,
} from "./log.ts";
import { answerPromptFor, runLoop } from "./loop.ts";
import {
  baseline,
  build,
  campaign,
  queue,
  requireTelegram,
  tgTest,
} from "./modes.ts";
import {
  applyTidy,
  computeTidy,
  describeRegistryDedup,
  describeTidy,
  scanTidy,
  tidyIsEmpty,
  type TidyTarget,
} from "./merge.ts";
import { gateway } from "./gateway.ts";
import { runCarve } from "./carve.ts";
import {
  runCampaignPlan,
  type UnderspecifiedDecision,
} from "./plan.ts";
import { runGraft } from "./graft.ts";
import { renderUsage } from "./help.ts";
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
  listParked,
  readParked,
} from "./state.ts";
import {
  autoRegister,
  computeRegistryDedup,
  gatewayConfigDir,
  listProjects,
  removePointer,
} from "./registry.ts";
import { resolveHostCeiling, type HostBudget } from "./host-slots.ts";
import { containerShareWeight } from "./config.ts";
import { serveAllStatus } from "./status.ts";
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

const USAGE = renderUsage();

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

// `host log` is the reader surface for the persistent host log (`host.jsonl`) — the
// host/gateway diagnostics `hostLogger` writes were write-only until now (#169). Like
// gateway/status it is host-level, not per-project, and reads the file directly off
// disk, so it must run BEFORE the strict cwd config load and needs no running daemon —
// the whole point is to reach for it when a host daemon is the thing that's broken.
if (mode === "host") {
  if (rest[0] !== "log") {
    console.error(
      "host needs a subcommand: `vetinari host log [-n <count>] [--tail] [--json]`",
    );
    process.exit(1);
  }
  const opts = rest.slice(1);
  const asJson = opts.includes("--json");
  const follow = opts.includes("--tail") || opts.includes("-f");
  const nIdx = opts.indexOf("-n");
  const limit = nIdx >= 0 ? Number(opts[nIdx + 1]) : 50;
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("host log -n needs a non-negative integer count");

  // Render a batch of raw JSONL lines to stdout: `--json` passes them through
  // untouched (byte-faithful for jq/grep); otherwise each parses to a row and
  // renders as one human line, a junk line skipped the way `readEventLog` skips it.
  const emitLines = (lines: string[]): void => {
    for (const line of lines) {
      if (asJson) {
        console.log(line);
        continue;
      }
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof (row as { event?: unknown }).event !== "string")
        continue;
      console.log(renderHostEvent(row as { ts: string; event: string }));
    }
  };

  if (!follow) {
    // A one-shot dump: newest-first for the human render (the most recent event
    // leads, matching the spec and the dashboard feeds); `--json` stays in on-disk
    // (chronological) order, untouched. A missing/empty host log reads clean.
    if (asJson) {
      emitLines(readHostLogLines(limit));
    } else {
      const rows = readHostLog(limit);
      if (!rows.length) console.log("no host log yet");
      else for (const row of rows) console.log(renderHostEvent(row));
    }
    process.exit(0);
  }

  // `--tail` follows live like `tail -f`: print the recent window in chronological
  // order, then append each newly-written event as it lands. Tracking the count of
  // raw lines already emitted keeps append detection independent of parse skips; a
  // shorter file (a rotation across a restart, #157) rebaselines rather than
  // re-emitting. Watch the logs *directory* (created if absent) so a not-yet-written
  // host.jsonl still arms the watcher — the same pattern the dashboard SSE uses.
  const target = hostLogTarget();
  const logsDir = dirname(target);
  const backlog = readHostLogLines();
  let seen = backlog.length;
  emitLines(limit >= backlog.length ? backlog : backlog.slice(-limit));
  mkdirSync(logsDir, { recursive: true });
  watch(logsDir, () => {
    const lines = readHostLogLines();
    if (lines.length < seen) seen = 0; // rotated/truncated — rebaseline
    if (lines.length <= seen) return;
    const fresh = lines.slice(seen);
    seen = lines.length;
    emitLines(fresh);
  });
  // Follow forever; the process stays up until the operator interrupts it.
  await new Promise<never>(() => {});
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

// `registry remove <name>` deletes one project's pointer from the host registry —
// the explicit counterpart to the auto-register every run performs. It acts on the
// host registry (not this project's slots — that is host-slots' `deregisterProject`),
// so like status/gateway it runs BEFORE the strict cwd config load (no project config
// in cwd is required to prune a stale pointer).
if (mode === "registry") {
  if (rest[0] !== "remove" || !rest[1]) {
    console.error(
      "registry needs a subcommand: `vetinari registry remove <name>`",
    );
    process.exit(1);
  }
  const name = rest[1];
  const removed = removePointer(gatewayConfigDir(), name);
  console.log(
    removed
      ? `removed registry pointer for "${name}" — the dashboard will stop listing it.`
      : `no registry pointer named "${name}" — nothing to remove.`,
  );
  process.exit(0);
}

// tidy reconciles drift a human-in-the-loop resolution leaks (ADR 0013). It reads
// each project's git + parked records + event log and, by default, only PRINTS the
// plan. `--all` sweeps the whole host registry, so — like status/gateway — it runs
// BEFORE the strict cwd config load (no project config in cwd is fine for --all).
if (mode === "tidy") {
  const apply = rest.includes("--apply");
  const all = rest.includes("--all");

  // A TidyTarget carries the absolute paths git + the fragment/parked scans read,
  // resolved against the project's own root (cwd for one project, the registered
  // root under --all) so a config's relative stateDir lands in the right place.
  const targetFor = (c: ResolvedConfig, root: string): TidyTarget => ({
    project: c.project,
    root,
    baseBranch: c.baseBranch,
    branchPrefix: c.branchPrefix,
    parkedDir: resolve(root, c.parkedDir),
    logFile: resolve(root, c.logFile),
    fragmentsDir: resolve(root, FRAGMENT_DIR),
    changelogPath: resolve(root, "CHANGELOG.md"),
  });

  const targets: TidyTarget[] = [];
  if (all) {
    const pointers = listProjects(gatewayConfigDir());
    // Registry dedup is a whole-host-registry concern (issue #164): drop provably-dead
    // duplicate-`projectRoot` pointers, then don't also per-project-tidy a pointer we're
    // deregistering as a duplicate (its canonical twin covers that same repo).
    const registryDrops = computeRegistryDedup(pointers);
    if (registryDrops.length) {
      console.log(describeRegistryDedup(registryDrops));
      if (apply) for (const d of registryDrops) removePointer(gatewayConfigDir(), d.drop);
    }
    const dropped = new Set(registryDrops.map((d) => d.drop));
    for (const p of pointers) {
      if (dropped.has(p.project)) continue;
      const resolved = resolveConfigPath(p.projectRoot);
      if (!resolved) {
        console.warn(`tidy --all: skipping ${p.project} — no vetinari config under ${p.projectRoot}`);
        continue;
      }
      targets.push(targetFor(await loadConfig(resolved.path), p.projectRoot));
    }
    if (!targets.length && !registryDrops.length) {
      console.log("tidy --all: no registered projects to reconcile.");
      process.exit(0);
    }
  } else {
    const resolved = resolveConfigPath(process.cwd());
    if (!resolved)
      throw new Error(
        "tidy needs a vetinari project — run it from a project root, or use `tidy --all` to sweep every registered project.",
      );
    targets.push(targetFor(await loadConfig(resolved.path), process.cwd()));
  }

  for (const target of targets) {
    const plan = computeTidy(scanTidy(target));
    console.log(describeTidy(target.project, plan));
    if (apply && !tidyIsEmpty(plan)) {
      applyTidy(target, plan);
      console.log(plan.fold.length ? "  → applied — review the CHANGELOG.md fold and commit it." : "  → applied.");
    }
  }
  if (!apply) console.log("\n(dry run — nothing changed; pass --apply to act)");
  process.exit(0);
}

const cfg = await loadConfig(cfgPath);

// The host's own logger for the emitters that aren't scoped to this run — the
// registry enrolment below and the host modes' readers. Run-family events go to
// `cfg.log` (the project's real event log); the process-global is gone (ADR 0002).
const hostLog = hostLogger();

// Enroll (or refresh) this project's pointer with the gateway at the start of
// every run, so a project registers itself with no manual step (ADR 0002).
// Pointer-only and best-effort — never fatal to the run.
autoRegister(cfg, process.cwd(), hostLog);

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
  cfg.log.log("archived", {
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
    // `--resume` continues the paused campaign already in the log (a wave-park a human
    // fixed forward, or a carve they resolved) on the current base, from the plan the
    // log reconstructs — no batch args needed (ADR 0013).
    let resume = false;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith("--name=")) name = a.slice("--name=".length);
      else if (a === "--name") name = rest[++i];
      else if (a === "--auto-carve") autoCarve = true;
      else if (a === "--resume") resume = true;
      else positional.push(a);
    }
    const batches = positional
      .map((b) => b.split(/[\s,]+/).filter(Boolean))
      .filter((b) => b.length);
    if (!resume && !batches.length)
      throw new Error(
        'campaign needs at least one batch: campaign "436 611" "623 640" (or --resume to continue a paused campaign)',
      );
    // A resume continues the campaign already in the live log — archiving it aside first
    // would leave `reduceCampaign` no plan to reconstruct (a wave-park leaves no parked
    // record to hold the leftover-archive off), so only a fresh run archives a leftover.
    if (!resume) archiveLeftoverRun();
    // Archive every completed run — failed/halted or clean — so a halt still enters
    // the archived-runs list to inspect (#141). archiveIfIdle no-ops while parked,
    // so a still-waiting run (not finished) stays live as before.
    await campaign(cfg, batches, hostBudget, name, { autoCarve, resume });
    archiveIfIdle();
    break;
  }
  case "carve": {
    // `carve <issue>` prunes the running campaign; `carve <issue> "611 640" …`
    // launches a reduced one. The orchestration lives in `runCarve` (a testable
    // seam mirroring `runGraft`); the command only parses args and renders output.
    const dryRun = rest.includes("--dry-run");
    // `--purge` is the rare true-drop: clear the carved issue's parked record too,
    // discarding its resumable session. Default carve preserves it (ADR 0013).
    const purge = rest.includes("--purge");
    const positional = rest.filter((a) => a !== "--dry-run" && a !== "--purge");
    const [target, ...batchArgs] = positional;
    // A non-empty positional tail = an explicit plan → the fresh-launch path.
    const plan = batchArgs.length
      ? batchArgs.map((b) => b.split(/[\s,]+/).filter(Boolean)).filter((b) => b.length)
      : undefined;

    const result = await runCarve(cfg, target, { dryRun, purge, plan, host: hostBudget });
    const tgt = result.target;

    if (result.mode === "launch") {
      const dependents = result.removed.filter((id) => id !== tgt);
      console.log(
        `carve #${tgt} → removed ${result.removed.map((i) => `#${i}`).join(", ")}` +
          (dependents.length
            ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})`
            : " (no dependents)"),
      );
      console.log(
        `remaining campaign: ${result.remaining.length ? result.remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
      );
      if (!dryRun && !result.remaining.length)
        console.log("nothing left to run after the carve — done.");
      break;
    }

    console.log(
      `carve #${tgt} → ${result.dropped.length ? `dropping ${result.dropped.map((i) => `#${i}`).join(", ")}` : "nothing to drop"}` +
        (result.kept.length
          ? ` (keeping banked ${result.kept.map((i) => `#${i}`).join(", ")})`
          : ""),
    );
    console.log(
      `remaining campaign: ${result.remaining.length ? result.remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
    );
    if (result.parkedDropped.length)
      console.log(
        purge
          ? `purging parked ${result.parkedDropped.map((i) => `#${i}`).join(", ")} — clearing their records and resumable sessions.`
          : `preserving parked ${result.parkedDropped.map((i) => `#${i}`).join(", ")} — branch/worktree/session kept, resumable (--purge to drop).`,
      );
    if (result.closure) {
      // Structured closure alongside the human text, so a consumer (the
      // aggregated dashboard's carve preview) can name the exact closure
      // without re-parsing the prose above.
      console.log(`carve-closure ${JSON.stringify(result.closure)}`);
      break;
    }
    console.log(
      "carve event appended — the running campaign will prune future waves at the next wave boundary.",
    );
    break;
  }
  case "graft": {
    // `graft <ids…>` adds issues to a running (or resumable) campaign — the additive
    // mirror of `carve` (ADR 0014). The orchestration lives in `runGraft` (a testable
    // seam, #176); the command only parses args and renders the console output.
    const dryRun = rest.includes("--dry-run");
    const ids = rest
      .filter((a) => a !== "--dry-run")
      .flatMap((a) => a.split(/[\s,]+/))
      .filter(Boolean);
    const result = await runGraft(cfg, ids, { dryRun });
    console.log(
      `graft ${result.ids.map((i) => `#${i}`).join(", ")} → ` +
        result.placement.map((p) => `#${p.id} in wave ${p.wave}`).join(", "),
    );
    console.log(
      `resulting campaign: ${result.remaining.map((w) => `"${w.join(" ")}"`).join(" ")}`,
    );
    if (result.applied)
      console.log(
        "graft event appended — the running campaign will add these issues to future waves at the next wave boundary.",
      );
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

    // The read-only assembly (resolver composition, prompt wiring, name suggestion)
    // lives in `runCampaignPlan` (#191); the command only parses args, injects the
    // two process globals the prompt branches on, and prints what it returns.
    const report = await runCampaignPlan(
      cfg,
      ids,
      { onUnderspecified },
      { isTTY: Boolean(process.stdin.isTTY), ask: askUnderspecified },
    );

    // The bare wave args, then the human-readable provenance report. Plans only.
    console.log(
      report.waveArgs ||
        "(nothing schedulable — every ticket is unreachable)",
    );
    console.log("");
    console.log(report.report);

    // A suggested --name from the area labels the selected issues span — printed to
    // paste or edit, never stored.
    if (report.suggestedName)
      console.log(`\nsuggested name: --name "${report.suggestedName}"`);
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
    cfg.log.log("archived", {
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
