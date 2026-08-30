/**
 * The pure parse + injected-dispatch seam in front of `cli.mts`'s config-dependent
 * command family (build/baseline/run/campaign/prune/graft/fileset-check/answer/
 * parked/clear/tg-test). `cli.mts` was a 965-line `switch (mode)` welded to
 * `console`, `process.exit` and real spawns, so command routing could only be
 * reached by launching the process. Splitting it in two — `parseArgs` (argv →
 * a discriminated `Command`, no IO) and `dispatch` (a `Command` → its handler
 * through injected `DispatchDeps`) — makes both testable in-process, the same
 * shape `gateway-service.ts` already uses (`gatewayServiceArgv` + a `runGatewayService`
 * over an injected `IO`).
 *
 * The host-level modes that must run BEFORE the strict config load (init, migrate,
 * gateway, host, status, registry, demo, tidy, changelog, statusline) stay inline in
 * `cli.mts`: each already delegates to its own tested seam. This module owns only the
 * post-config `switch`.
 */
import { resolve } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { parseAgentFlags } from "./config.ts";
import { renderUsage } from "./help.ts";
import type { HostBudget } from "./host-slots.ts";
import type { build, baseline, campaign, tgTest, requireTelegram } from "./modes.ts";
import type { runLoop } from "./loop.ts";
import { answerPromptFor, parkedAnswerComment } from "./loop.ts";
import type { agentSelectionFor } from "./sandbox.ts";
import type { listParked, readParked } from "./state.ts";
import type { archiveRun } from "./archive.ts";
import type { UnderspecifiedPrompt } from "./plan.ts";
import type {
  expandSelection,
  runCampaignPlan,
  runFilesetCheck,
} from "./plan.ts";
import { describeFilesetCheck } from "./plan.ts";
import { resumeIndex, type runPrune } from "./prune.ts";
import type { runGraft } from "./graft.ts";
import { describeGraftRejections } from "./graft.ts";
import type { readEventLog } from "./event-log.ts";
import { campaignStarted, reduceCampaign } from "./dashboard-model.ts";

const USAGE = renderUsage();

/** A partial `--agent`/`--model`/`--effort` override, as `parseAgentFlags` yields it. */
export type AgentOverride = { provider?: string; model?: string; effort?: string };

/**
 * One command form, discriminated on `kind`. `parseArgs` maps each subcommand of the
 * post-config family to exactly one of these; anything else (an unknown or garbage
 * mode) becomes `usage`.
 */
export type Command =
  | { kind: "build"; baseline: boolean }
  | { kind: "baseline" }
  | { kind: "run"; agent: AgentOverride; args: string[] }
  | {
      kind: "campaign";
      agent: AgentOverride;
      positional: string[];
      name?: string;
      autoPrune: boolean;
      resume: boolean;
      dryRun: boolean;
      override: boolean;
      onUnderspecified?: string;
    }
  | { kind: "prune"; target?: string; plan?: string[][]; dryRun: boolean; purge: boolean }
  | { kind: "graft"; ids: string[]; dryRun: boolean }
  | { kind: "filesetCheck"; ids: string[] }
  | { kind: "answer"; taskId?: string; text: string[] }
  | { kind: "parked" }
  | { kind: "clear" }
  | { kind: "tgTest" }
  | { kind: "usage" };

/**
 * Parse the post-config argv (`[mode, ...rest]`, already stripped of the global
 * `--config` option) into a `Command`. Pure: no IO, no `process`, no throw — an
 * unknown or empty mode maps to `usage`, and a required-positional check that the
 * old switch threw on is deferred to `dispatch` so its exact message is preserved.
 */
export function parseArgs(argv: string[]): Command {
  const [mode, ...rest] = argv;
  switch (mode) {
    case "build":
      return { kind: "build", baseline: !rest.includes("--no-baseline") };
    case "baseline":
      return { kind: "baseline" };
    case "parked":
      return { kind: "parked" };
    case "clear":
      return { kind: "clear" };
    case "tg-test":
      return { kind: "tgTest" };
    case "run": {
      // Strip the agent selection first, exactly as the old `applyAgentSelection`
      // did, so the task id is the surviving positional (ADR 0016).
      const { override, rest: args } = parseAgentFlags(rest);
      return { kind: "run", agent: override, args };
    }
    case "graft":
      return {
        kind: "graft",
        ids: rest
          .filter((a) => a !== "--dry-run")
          .flatMap((a) => a.split(/[\s,]+/))
          .filter(Boolean),
        dryRun: rest.includes("--dry-run"),
      };
    case "fileset-check":
      return {
        kind: "filesetCheck",
        ids: rest.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean),
      };
    case "answer": {
      const [taskId, ...text] = rest;
      return { kind: "answer", taskId, text };
    }
    case "campaign": {
      // Strip the agent selection before the campaign's own flags, exactly as the
      // old `applyAgentSelection` did (ADR 0016); the remainder is parsed below.
      const { override: agent, rest: campaignArgs } = parseAgentFlags(rest);
      let name: string | undefined;
      let autoPrune = false;
      let resume = false;
      let dryRun = false;
      let override = false;
      let onUnderspecified: string | undefined;
      const positional: string[] = [];
      for (let i = 0; i < campaignArgs.length; i++) {
        const a = campaignArgs[i];
        if (a.startsWith("--name=")) name = a.slice("--name=".length);
        else if (a === "--name") name = campaignArgs[++i];
        else if (a === "--auto-prune") autoPrune = true;
        else if (a === "--resume") resume = true;
        else if (a === "--dry-run") dryRun = true;
        else if (a === "--override") override = true;
        else if (a.startsWith("--on-underspecified="))
          onUnderspecified = a.slice("--on-underspecified=".length);
        else if (a === "--on-underspecified") onUnderspecified = campaignArgs[++i];
        else positional.push(a);
      }
      return {
        kind: "campaign",
        agent,
        positional,
        name,
        autoPrune,
        resume,
        dryRun,
        override,
        onUnderspecified,
      };
    }
    case "prune": {
      const positional = rest.filter((a) => a !== "--dry-run" && a !== "--purge");
      const [target, ...batchArgs] = positional;
      // A non-empty positional tail = an explicit plan → the fresh-launch path.
      const plan = batchArgs.length
        ? batchArgs
            .map((b) => b.split(/[\s,]+/).filter(Boolean))
            .filter((b) => b.length)
        : undefined;
      return {
        kind: "prune",
        target,
        plan,
        dryRun: rest.includes("--dry-run"),
        purge: rest.includes("--purge"),
      };
    }
    default:
      return { kind: "usage" };
  }
}

/**
 * Everything `dispatch` reaches the outside world through. The spawning/IO handlers
 * (`build`, `runLoop`, `campaign`, `runPrune`, …) are injected so a test can assert
 * routing on captured calls with no real container, and `log`/`error`/`setExitCode`
 * replace the direct `console`/`process.exitCode` writes the old switch made. Handler
 * deps are typed by the real function so a signature drift is a compile error, not a
 * silent skew. Context the closures need — the loaded `cfg`, the `host` budget, whether
 * stdin is a TTY, and the run-archive closures — is passed in the same object.
 */
export interface DispatchDeps {
  cfg: ResolvedConfig;
  host: HostBudget;
  isTTY: boolean;
  log: (msg: string) => void;
  setExitCode: (code: number) => void;
  /**
   * Validate + preflight + stamp the agent selection (the effectful half of the old
   * `applyAgentSelection`; the flag-strip half now lives in `parseArgs`). Throws on a
   * bad provider/effort or missing credentials, before any container (ADR 0016).
   */
  selectAgent: (cfg: ResolvedConfig, override: AgentOverride) => void;
  /** Archive a prior run still sitting in the live log before a fresh run appends. */
  archiveLeftoverRun: () => void;
  /** Reset live state once a run is truly over (skipped while anything is parked). */
  archiveIfIdle: () => void;
  /** The planner's not-confident halt prompt (interactive on a TTY). */
  askUnderspecified: UnderspecifiedPrompt;
  build: typeof build;
  baseline: typeof baseline;
  runLoop: typeof runLoop;
  campaign: typeof campaign;
  expandSelection: typeof expandSelection;
  runCampaignPlan: typeof runCampaignPlan;
  runPrune: typeof runPrune;
  runGraft: typeof runGraft;
  runFilesetCheck: typeof runFilesetCheck;
  listParked: typeof listParked;
  readParked: typeof readParked;
  /** Read this project's event log — the source a green `answer` checks to decide
   *  whether the issue belongs to a paused campaign it should redrive (design §7). */
  readEventLog: typeof readEventLog;
  archiveRun: typeof archiveRun;
  agentSelectionFor: typeof agentSelectionFor;
  requireTelegram: typeof requireTelegram;
  tgTest: typeof tgTest;
}

/**
 * Route a parsed `Command` to its handler through injected `deps`. The pure `parseArgs`
 * did the argv work; this owns the effects the old `switch (mode)` welded inline —
 * spawns, archives, exit codes and console output — now all reachable through `deps`.
 */
export async function dispatch(cmd: Command, deps: DispatchDeps): Promise<void> {
  const { cfg } = deps;
  switch (cmd.kind) {
    case "build": {
      // Default builds AND baselines; --no-baseline builds only. False (a build or
      // baseline failure) maps to a non-zero exit; sandcastle's output was inherited.
      deps.setExitCode((await deps.build(cfg, { baseline: cmd.baseline })) ? 0 : 1);
      return;
    }
    case "baseline": {
      deps.setExitCode((await deps.baseline(cfg)) ? 0 : 1);
      return;
    }
    case "run": {
      // Lock in the agent selection first (ADR 0016): validates it and preflights
      // its credentials before the container, and stamps VETINARI_AGENT.
      deps.selectAgent(cfg, cmd.agent);
      if (!cmd.args[0]) throw new Error("run needs a task id");
      deps.archiveLeftoverRun();
      // Exit code is the queue's slot signal: 0 green, 2 parked, other = error.
      deps.setExitCode((await deps.runLoop(cfg, cmd.args[0])) === "green" ? 0 : 2);
      return;
    }
    case "campaign": {
      await dispatchCampaign(cmd, deps);
      return;
    }
    case "prune": {
      await dispatchPrune(cmd, deps);
      return;
    }
    case "graft": {
      await dispatchGraft(cmd, deps);
      return;
    }
    case "filesetCheck": {
      // The resolver-backed pre-campaign check: run the SAME resolution campaign-plan
      // uses over each id and print its verdict. Read-only — plans nothing, writes nothing.
      const results = await deps.runFilesetCheck(cfg, cmd.ids);
      deps.log(describeFilesetCheck(results));
      return;
    }
    case "answer": {
      await dispatchAnswer(cmd, deps);
      return;
    }
    case "parked": {
      const recs = deps.listParked(cfg);
      if (!recs.length) deps.log("nothing parked");
      for (const r of recs)
        deps.log(
          `\n=== ${r.taskId} (${r.reason}, ${r.parkedAt}) branch ${r.branch}\n${r.question}\n`,
        );
      return;
    }
    case "clear": {
      // Force a reset now, even with questions still parked — the manual escape
      // hatch, unlike the automatic archive that waits for an idle queue.
      const r = deps.archiveRun(cfg);
      cfg.log.log("archived", {
        archivedLog: r.archivedLog ?? null,
        clearedParked: r.clearedParked,
        clearedOutbound: r.clearedOutbound,
      });
      deps.log(
        r.archivedLog
          ? `archived run log → ${r.archivedLog}`
          : "no run log to archive",
      );
      deps.log(
        `cleared ${r.clearedParked} parked record(s) — dashboard and status line now read idle`,
      );
      return;
    }
    case "tgTest": {
      // Resolve creds from this project's host.env the way the gateway does, so a
      // green tg-test guarantees the gateway can send (issue #117).
      const conn = deps.requireTelegram(
        "tg-test",
        resolve(process.cwd(), cfg.stateDir),
      );
      await deps.tgTest(cfg, conn);
      return;
    }
    case "usage": {
      deps.log(USAGE);
      deps.setExitCode(1);
      return;
    }
  }
}

/**
 * The campaign command: resume, override (literal waves) and the default plan-then-run,
 * each with a `--dry-run` that prints and runs nothing. A faithful port of the old
 * `switch`'s `campaign` case, its console writes routed through `deps.log`.
 */
async function dispatchCampaign(
  cmd: Extract<Command, { kind: "campaign" }>,
  deps: DispatchDeps,
): Promise<void> {
  const { cfg, host } = deps;
  // Lock in the agent selection first (ADR 0016): validates it and preflights its
  // credentials before any container, and stamps VETINARI_AGENT so every child wave
  // `run` drives the chosen provider, not a silent claude.
  deps.selectAgent(cfg, cmd.agent);

  // Resume reconstructs the plan from the log and takes no issues — no selection,
  // planning, or override applies. It continues the live log, so (unlike a fresh run)
  // it must NOT archive the leftover it would otherwise reconstruct from.
  if (cmd.resume) {
    // Under --resume, --override re-runs a failed member instead of stopping as failed
    // again (design §7); the literal-waves meaning of --override below never applies here
    // (resume takes no batch args and returns before reaching it).
    await deps.campaign(cfg, [], host, cmd.name, {
      autoPrune: cmd.autoPrune,
      resume: true,
      override: cmd.override,
    });
    deps.archiveIfIdle();
    return;
  }

  if (!cmd.positional.length)
    throw new Error(
      "campaign needs at least one issue id or label: campaign 436 611 640, campaign ready-for-agent (or --resume to continue a paused campaign)",
    );

  if (cmd.override) {
    // Each positional is one explicit wave (split on whitespace/commas); the planner
    // is skipped entirely. A label token inside a wave still expands, joining that wave.
    const batches: string[][] = [];
    for (const group of cmd.positional) {
      const tokens = group.split(/[\s,]+/).filter(Boolean);
      const ids = await deps.expandSelection(tokens, cfg.listByLabel);
      if (ids.length) batches.push(ids);
    }
    if (!batches.length)
      throw new Error(
        "campaign --override: no issues to run — every wave expanded to nothing.",
      );
    if (cmd.dryRun) {
      // --dry-run runs nothing, even with the planner skipped: print the literal waves.
      deps.log(batches.map((w) => `"${w.join(" ")}"`).join(" "));
      return;
    }
    deps.archiveLeftoverRun();
    await deps.campaign(cfg, batches, host, cmd.name, { autoPrune: cmd.autoPrune });
    deps.archiveIfIdle();
    return;
  }

  // Default (and --dry-run): expand any labels to a flat id set, then PLAN it into
  // dependency-ordered, file-disjoint waves.
  const tokens = cmd.positional.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
  const ids = await deps.expandSelection(tokens, cfg.listByLabel);
  if (!ids.length) {
    deps.log("campaign: nothing to run — the selection expanded to no open issues.");
    return;
  }
  const report = await deps.runCampaignPlan(
    cfg,
    ids,
    { onUnderspecified: cmd.onUnderspecified },
    { isTTY: deps.isTTY, ask: deps.askUnderspecified },
  );

  if (cmd.dryRun) {
    // The full `campaign-plan` replacement: the bare wave args, the provenance report,
    // and a suggested --name — printed to read or paste, nothing run.
    deps.log(
      report.waveArgs || "(nothing schedulable — every ticket is unreachable)",
    );
    deps.log("");
    deps.log(report.report);
    if (report.suggestedName)
      deps.log(`\nsuggested name: --name "${report.suggestedName}"`);
    return;
  }

  if (!report.waves.length) {
    // Nothing survived planning (every ticket unreachable) — show why, run nothing.
    deps.log("campaign: nothing schedulable — every ticket is unreachable.");
    deps.log("");
    deps.log(report.report);
    return;
  }

  // Show the plan about to run, then run it. Archive any leftover run first, and archive
  // on completion (a halt still enters the archived-runs list, #141).
  deps.log(report.report);
  deps.log("");
  deps.archiveLeftoverRun();
  await deps.campaign(cfg, report.waves, host, cmd.name, { autoPrune: cmd.autoPrune });
  deps.archiveIfIdle();
}

/**
 * The prune command: prune the running campaign, or (with a positional batch tail)
 * launch a reduced one. The orchestration lives in `runPrune`; this only parses (done
 * in `parseArgs`) and renders. A faithful port of the old `switch`'s `prune` case.
 */
async function dispatchPrune(
  cmd: Extract<Command, { kind: "prune" }>,
  deps: DispatchDeps,
): Promise<void> {
  const { cfg, host } = deps;
  const result = await deps.runPrune(cfg, cmd.target!, {
    dryRun: cmd.dryRun,
    purge: cmd.purge,
    plan: cmd.plan,
    host,
  });
  const tgt = result.target;

  if (result.mode === "launch") {
    const dependents = result.removed.filter((id) => id !== tgt);
    deps.log(
      `prune #${tgt} → removed ${result.removed.map((i) => `#${i}`).join(", ")}` +
        (dependents.length
          ? ` (dependents: ${dependents.map((i) => `#${i}`).join(", ")})`
          : " (no dependents)"),
    );
    deps.log(
      `remaining campaign: ${result.remaining.length ? result.remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
    );
    if (!cmd.dryRun && !result.remaining.length)
      deps.log("nothing left to run after the prune — done.");
    return;
  }

  deps.log(
    `prune #${tgt} → ${result.dropped.length ? `dropping ${result.dropped.map((i) => `#${i}`).join(", ")}` : "nothing to drop"}` +
      (result.kept.length
        ? ` (keeping banked ${result.kept.map((i) => `#${i}`).join(", ")})`
        : ""),
  );
  deps.log(
    `remaining campaign: ${result.remaining.length ? result.remaining.map((w) => `"${w.join(" ")}"`).join(" ") : "(nothing left to run)"}`,
  );
  if (result.parkedDropped.length)
    deps.log(
      cmd.purge
        ? `purging parked ${result.parkedDropped.map((i) => `#${i}`).join(", ")} — clearing their records and resumable sessions.`
        : `preserving parked ${result.parkedDropped.map((i) => `#${i}`).join(", ")} — branch/worktree/session kept, resumable (--purge to drop).`,
    );
  if (result.closure) {
    // Structured closure alongside the human text, so a consumer (the aggregated
    // dashboard's prune preview) can name the exact closure without re-parsing the prose.
    deps.log(`prune-closure ${JSON.stringify(result.closure)}`);
    return;
  }
  deps.log(
    "prune event appended — the running campaign will prune future waves at the next wave boundary.",
  );
}

/**
 * The graft command: add issues to a running (or resumable) campaign, the additive
 * mirror of prune (ADR 0014). The orchestration lives in `runGraft`; this renders.
 */
async function dispatchGraft(
  cmd: Extract<Command, { kind: "graft" }>,
  deps: DispatchDeps,
): Promise<void> {
  const result = await deps.runGraft(deps.cfg, cmd.ids, { dryRun: cmd.dryRun });
  if (result.rejected.length) {
    // A `--dry-run` discloses a whole-batch rejection instead of throwing, so the
    // aggregated dashboard's preview can name the offenders off the closure line.
    deps.log(
      `graft rejected — nothing added (${describeGraftRejections(result.rejected)}).`,
    );
  } else {
    deps.log(
      `graft ${result.ids.map((i) => `#${i}`).join(", ")} → ` +
        result.placement.map((p) => `#${p.id} in wave ${p.wave}`).join(", "),
    );
    deps.log(
      `resulting campaign: ${result.remaining.map((w) => `"${w.join(" ")}"`).join(" ")}`,
    );
  }
  if (result.closure) {
    // Structured closure alongside the human text, so the aggregated dashboard's graft
    // preview names the placement (and any rejection) without re-parsing the prose.
    deps.log(`graft-closure ${JSON.stringify(result.closure)}`);
    return;
  }
  if (result.applied)
    deps.log(
      "graft event appended — the running campaign will add these issues to future waves at the next wave boundary.",
    );
}

/**
 * The answer command: deliver a human's answer to a parked task, branching on whether
 * the provider carries a durable session (ADR 0016 / #212). On a green answer to a member
 * of a paused campaign, an answer *is* the continue signal (ADR 0020, design §7): it
 * redrives so the now-green work is integrated and the campaign carries on — the human
 * never has to answer and then separately ask it to continue. A standalone answer (no
 * campaign) or a second park runs exactly as before.
 */
async function dispatchAnswer(
  cmd: Extract<Command, { kind: "answer" }>,
  deps: DispatchDeps,
): Promise<void> {
  const { cfg, host } = deps;
  if (!cmd.taskId || !cmd.text.length)
    throw new Error('answer needs a task id and text: answer <task> "<answer>"');
  const taskId = cmd.taskId;
  // Resumable (claude/pi/codex): resume the session with an answerPrompt. Non-resumable
  // (copilot/cursor/opencode): relay the answer as an issue comment and re-enter FRESH.
  const { resumable } = deps.agentSelectionFor(cfg);
  let outcome: string;
  if (resumable) {
    const parked = deps.readParked(cfg, taskId);
    outcome = await deps.runLoop(cfg, taskId, {
      resumeSessionId: parked.sessionId!,
      answerPrompt: answerPromptFor(cmd.text.join(" ")),
    });
  } else {
    // Fail-loud (issue-only): post the comment BEFORE the run, and never start the run
    // if it cannot be posted — an answer is never silently lost.
    if (!cfg.postComment)
      throw new Error(
        `postComment not configured — cannot relay the answer to ${taskId} for a non-resumable agent (wire githubIssueComment(repo) in your config).`,
      );
    const parked = deps.readParked(cfg, taskId, { requireSession: false });
    await cfg.postComment(
      taskId,
      parkedAnswerComment(parked.question, cmd.text.join(" ")),
    );
    outcome = await deps.runLoop(cfg, taskId);
  }

  // A green answer to a paused campaign's member continues it (ADR 0020): redrive so the
  // green is integrated (the standalone run only logged it) and later waves run. On a
  // second park (outcome !== "green"), or a standalone answer, there is nothing to redrive.
  if (outcome === "green" && issueAwaitsRedrive(deps.readEventLog(cfg), taskId)) {
    const ok = await deps.campaign(cfg, [], host, undefined, { resume: true });
    deps.setExitCode(ok ? 0 : 2);
    return;
  }
  deps.setExitCode(outcome === "green" ? 0 : 2);
}

/**
 * Does `taskId` belong to a campaign that has stopped short of done — the case a green
 * answer should redrive (design §7)? True only when a campaign was launched here
 * (`campaign-start`, so a standalone `run`/`answer` never redrives), the issue is a
 * member of its current plan, and at least one wave has not closed — so an answer to an
 * already-settled campaign is reported and ignored, not re-run.
 */
function issueAwaitsRedrive(events: ReturnType<typeof readEventLog>, taskId: string): boolean {
  if (!campaignStarted(events)) return false;
  const reduced = reduceCampaign(events);
  const norm = taskId.replace(/^#/, "");
  return reduced.waves.flat().includes(norm) && resumeIndex(reduced) < reduced.waves.length;
}
