#!/usr/bin/env -S npx tsx
import { createInterface } from "node:readline/promises";
import { mkdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_ENV_VAR,
  encodeAgentOverride,
  loadConfig,
  missingCredentials,
  parseAgentOverride,
  resolveAgentSelection,
  resolveConfigPath,
  type ResolvedConfig,
} from "./config.ts";
import {
  dispatch,
  parseArgs,
  type AgentOverride,
} from "./cli-dispatch.ts";
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
import { runLoop } from "./loop.ts";
import { agentSelectionFor } from "./sandbox.ts";
import {
  baseline,
  build,
  campaign,
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
import { defaultGatewayServiceIO, isGatewayServiceVerb, runGatewayService } from "./gateway-service.ts";
import { runPrune } from "./prune.ts";
import {
  expandSelection,
  runCampaignPlan,
  runFilesetCheck,
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
import { readEventLog } from "./event-log.ts";
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
import { createDemo, demoRoot, removeDemo } from "./dashboard-demo-fixture.ts";
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
    `\ncampaign: ${list} ${subj} no confident file-set.\n` +
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
  // Service lifecycle: `status|start|stop|restart` wrap `systemctl --user <verb>
  // vetinari-gateway` (the user unit `gateway install` writes), propagating its
  // exit code so scripts can rely on it. Any other first token — including none —
  // falls through to running the daemon in the FOREGROUND, which is what the
  // systemd unit's ExecStart invokes; that path must stay unchanged.
  if (isGatewayServiceVerb(rest[0])) {
    process.exit(await runGatewayService(rest[0], defaultGatewayServiceIO()));
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

// `demo create|remove` seeds (or tears down) the demo dashboard fixture — a set of
// registered projects that between them render every dashboard state, to click
// through the status UI (#225). It acts on the host registry and a demo root under
// $VETINARI_DEMO_DIR, exactly like status/registry, so it runs BEFORE the strict cwd
// config load (no project config in cwd is required). `create` is idempotent
// (clear-then-reseed); `remove` deletes only the demo root and the pointers under it.
if (mode === "demo") {
  const sub = rest[0];
  if (sub !== "create" && sub !== "remove") {
    console.error("demo needs a subcommand: `vetinari demo create | remove`");
    process.exit(1);
  }
  const configDir = gatewayConfigDir();
  const root = demoRoot();
  if (sub === "create") {
    // Idempotent: clear any prior demo first, so a re-run refreshes rather than
    // duplicating or stacking stale state.
    removeDemo(configDir, root);
    const { projects } = createDemo(configDir, root);
    console.log(
      `seeded + registered ${projects.length} demo project(s) under ${root}: ${projects.join(", ")}\n` +
        `registry: ${configDir} — refresh the running dashboard to see them.`,
    );
  } else {
    const { removed } = removeDemo(configDir, root);
    console.log(
      removed.length
        ? `removed ${removed.length} demo project(s) (${removed.join(", ")}) and deleted ${root}`
        : `no demo projects registered under ${root} — nothing to remove.`,
    );
  }
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

/**
 * Resolve and lock in the agent for a run/campaign invocation (ADR 0016) — the effectful
 * half of the old `applyAgentSelection` (the flag-strip half now lives in `parseArgs`,
 * which hands the parsed `--agent`/`--model`/`--effort` override in as `override`). Merge
 * it over one already inherited via `VETINARI_AGENT` (a campaign/queue child inherits its
 * parent's), validate it (an unknown provider or an out-of-vocabulary effort fails fast
 * HERE, before any container), and preflight the selected provider's credentials against
 * the container `.env` so a missing key is a helpful message rather than a death inside
 * the container. Re-stamp `VETINARI_AGENT` so every spawned child wave drives the same
 * agent. This is `dispatch`'s `selectAgent` dep.
 */
function selectAgent(cfg: ResolvedConfig, override: AgentOverride): void {
  const inherited = parseAgentOverride(process.env[AGENT_ENV_VAR]);
  const merged = { ...inherited, ...override };
  const selection = resolveAgentSelection(cfg.agent, merged); // throws on bad provider/effort
  const envPath = resolve(process.cwd(), cfg.stateDir, ".env");
  const missing = missingCredentials(selection.provider, envPath);
  if (missing.length)
    throw new Error(
      `agent provider "${selection.provider}" has no credentials in ${envPath} — ` +
        `set ${missing.join(" or ")} there before launching (preflight, ADR 0016).`,
    );
  if (Object.keys(merged).length)
    process.env[AGENT_ENV_VAR] = encodeAgentOverride(merged);
}

// The post-config command family (build/baseline/run/campaign/prune/graft/fileset-check/
// answer/parked/clear/tg-test) is parsed into a discriminated Command and routed through
// injected deps (src/cli-dispatch.ts) — the pure seam that makes command routing testable
// without spawning the process (#243). The host-level modes above run BEFORE the strict
// config load and stay inline. Console/exit/spawn effects are wired in as deps here.
await dispatch(parseArgs([mode, ...rest]), {
  cfg,
  host: hostBudget,
  isTTY: Boolean(process.stdin.isTTY),
  log: (m) => console.log(m),
  setExitCode: (c) => {
    process.exitCode = c;
  },
  selectAgent,
  archiveLeftoverRun,
  archiveIfIdle,
  askUnderspecified,
  build,
  baseline,
  runLoop,
  campaign,
  expandSelection,
  runCampaignPlan,
  runPrune,
  runGraft,
  runFilesetCheck,
  listParked,
  readParked,
  readEventLog,
  archiveRun,
  agentSelectionFor,
  requireTelegram,
  tgTest,
});

