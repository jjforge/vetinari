/**
 * The pure parse + injected-dispatch seam in front of `cli.mts`'s config-dependent
 * command family (build/baseline/run/campaign/redrive/prune/graft/answer/
 * parked/clear/tg-test). `cli.mts` was a 965-line `switch (mode)` welded to
 * `console`, `process.exit` and real spawns, so command routing could only be
 * reached by launching the process. Splitting it in two — `parseArgs` (argv →
 * a discriminated `Command`, no IO) and `dispatch` (a `Command` → its handler
 * through injected `DispatchDeps`) — makes both testable in-process, the same
 * shape `gateway-service.ts` already uses (`gatewayServiceArgv` + a `runGatewayService`
 * over an injected `IO`).
 *
 * The host-level modes that must run BEFORE the strict config load (init, migrate,
 * gateway, host, status, registry, tidy, changelog, statusline) stay inline in
 * `cli.mts`: each already delegates to its own tested seam. This module owns only the
 * post-config `switch`.
 */
import { resolve } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { parseAgentFlags } from "./config.ts";
import { renderUsage } from "./help.ts";
import type { HostBudget, projectHasLiveCampaign } from "./host-slots.ts";
import type { build, baseline, campaign, tgTest, requireTelegram, CampaignOutcome } from "./modes.ts";
import type { runTgConnect } from "./tg-connect.ts";
import type { tgSend } from "./telegram.ts";
import { crashResumePrompt, type runLoop, type Outcome } from "./loop.ts";
import type { answerParked, hasParked, listParked } from "./state.ts";
import type { archiveRun } from "./archive.ts";
import type { Exclusion, UnderspecifiedPrompt } from "./plan.ts";
import type {
  expandSelection,
  runCampaignPlan,
} from "./plan.ts";
import { resumeIndex, type runPrune } from "./prune.ts";
import { isIssueToken } from "./issue-id.ts";
import type { runGraft } from "./graft.ts";
import { GraftRejectedError, describeGraftRejections } from "./graft.ts";
import type { readEventLog } from "./event-log.ts";
import { campaignStarted, reduceCampaign } from "./dashboard-model.ts";
import { makeReporter } from "./report.ts";

const USAGE = renderUsage();

/**
 * The line `prune`/`graft` lead with so a human recognizes what they are acting on:
 * `vetinari · jjforge/vetinari#42 — "…"`. A repo that could not be derived degrades to
 * project and id (`vetinari #42`); a title that could not be fetched drops the `— "…"`
 * tail. The title is what a human recognizes as belonging to the wrong repo.
 */
export const identityLine = (project: string, repo: string | undefined, id: string, title?: string): string => {
  const base = repo ? `${project} · ${repo}#${id}` : `${project} #${id}`;
  return title ? `${base} — "${title}"` : base;
};

/**
 * Turn on `--json` for the raw-event stream: set the `VETINARI_JSON` env the run logger keys its
 * stdout echo on (`log.ts`) — and which child wave `run`s inherit — so `campaign`/`run`/`redrive`
 * stream JSONL to stdout for tooling. Left unset, no JSON reaches stdout: the terminal view is the
 * `report.ts` human lines alone (design §11, #299).
 */
const enableJson = (on: boolean): void => {
  if (on) process.env.VETINARI_JSON = "1";
};

/** A partial `--agent`/`--model`/`--effort` override, as `parseAgentFlags` yields it. */
export type AgentOverride = { provider?: string; model?: string; effort?: string };

/**
 * The verdict→exit-code map both the run loop and the campaign share (design §3, §5 step 6,
 * user-guide "Where you see things"): 0 green/done, 2 parked, 1 failed. The loop returns the
 * outcome; the exit-code decision lives HERE (never in modes.ts/loop.ts). `green` and `done`
 * are the same success code so `run` and `campaign` speak one exit vocabulary.
 */
const exitCodeFor = (outcome: Outcome | CampaignOutcome): number =>
  outcome === "green" || outcome === "done" ? 0 : outcome === "parked" ? 2 : 1;

/**
 * One command form, discriminated on `kind`. `parseArgs` maps each subcommand of the
 * post-config family to exactly one of these; anything else (an unknown or garbage
 * mode) becomes `usage`.
 */
export type Command =
  | { kind: "build"; baseline: boolean }
  | { kind: "baseline" }
  | { kind: "run"; agent: AgentOverride; args: string[]; json: boolean }
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
      json: boolean;
    }
  | { kind: "redrive"; agent: AgentOverride; autoPrune: boolean; override: boolean; json: boolean }
  | { kind: "prune"; project?: string; target?: string; dryRun: boolean; purge: boolean; json: boolean }
  | { kind: "graft"; project?: string; ids: string[]; dryRun: boolean; json: boolean }
  | { kind: "answer"; taskId?: string; text: string[] }
  | { kind: "parked" }
  | { kind: "clear" }
  | { kind: "tgTest" }
  | { kind: "tgConnect"; token?: string; chat?: string; noVerify: boolean; force: boolean }
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
    case "tg-connect": {
      // Collect a project's bot connection into its host.env. `--token`/`--chat` supply the
      // two values a scripted run needs (both `--flag value` and `--flag=` forms); `--no-verify`
      // skips the verification send and `--force` replaces an already-configured connection.
      let token: string | undefined;
      let chat: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--token") token = rest[++i];
        else if (a.startsWith("--token=")) token = a.slice("--token=".length);
        else if (a === "--chat") chat = rest[++i];
        else if (a.startsWith("--chat=")) chat = a.slice("--chat=".length);
      }
      return {
        kind: "tgConnect",
        token,
        chat,
        noVerify: rest.includes("--no-verify"),
        force: rest.includes("--force"),
      };
    }
    case "run": {
      // Strip the agent selection first, exactly as the old `applyAgentSelection`
      // did, so the task id is the surviving positional (ADR 0016). `--json` streams
      // the raw event log to stdout for tooling; strip it too so the task id survives.
      const { override, rest: args } = parseAgentFlags(rest);
      return {
        kind: "run",
        agent: override,
        args: args.filter((a) => a !== "--json"),
        json: args.includes("--json"),
      };
    }
    case "graft": {
      const tokens = rest
        .filter((a) => a !== "--dry-run" && a !== "--json")
        .flatMap((a) => a.split(/[\s,]+/))
        .filter(Boolean);
      // `graft <project> <ids…>`: a leading non-issue token FOLLOWED BY an issue token
      // is the project qualifier — the spelling the gateway accepts, and prune's rule
      // verbatim (`:246`), so the two sibling commands parse alike. Demanding the issue
      // token after it stops a malformed id (`"875"`) in lead position being read as a
      // bogus qualifier; every token then reaches validation as an id.
      const qualified = tokens.length >= 2 && !isIssueToken(tokens[0]) && isIssueToken(tokens[1]);
      return {
        kind: "graft",
        project: qualified ? tokens[0] : undefined,
        ids: qualified ? tokens.slice(1) : tokens,
        dryRun: rest.includes("--dry-run"),
        // `--json` gates the machine `graft-closure {json}` line so no JSON reaches stdout
        // without it; the dashboard's preview shell passes it (design §11).
        json: rest.includes("--json"),
      };
    }
    case "redrive": {
      // Redrive picks an unfinished campaign back up (design §7) — the umbrella verb
      // (ADR 0020). It takes no issue selection; strip the agent, then read only its
      // two forwarded flags. `--override` re-runs a failed member; stray tokens are ignored.
      const { override: agent, rest: redriveArgs } = parseAgentFlags(rest);
      return {
        kind: "redrive",
        agent,
        autoPrune: redriveArgs.includes("--auto-prune"),
        override: redriveArgs.includes("--override"),
        json: redriveArgs.includes("--json"),
      };
    }
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
      let json = false;
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
        else if (a === "--json") json = true;
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
        json,
      };
    }
    case "prune": {
      // `prune <issue>` prunes the RUNNING campaign at the next wave boundary; the
      // fresh-reduced-launch batch form is retired (design §12). `prune <project> <issue>`
      // — a leading non-issue token followed by an issue — carries a project qualifier, the
      // spelling the gateway accepts; a leading issue token is the bare form and any tail is
      // ignored (the retired batch args).
      const positional = rest.filter((a) => a !== "--dry-run" && a !== "--purge" && a !== "--json");
      const qualified = positional.length >= 2 && !isIssueToken(positional[0]) && isIssueToken(positional[1]);
      return {
        kind: "prune",
        project: qualified ? positional[0] : undefined,
        target: qualified ? positional[1] : positional[0],
        dryRun: rest.includes("--dry-run"),
        purge: rest.includes("--purge"),
        // `--json` gates the machine `prune-closure {json}` line so no JSON reaches stdout
        // without it; the dashboard's preview shell passes it (design §11).
        json: rest.includes("--json"),
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
  /**
   * Was this process spawned as a campaign/queue child `run` (VETINARI_CHILD)? A child is
   * exempt from `run`'s live-campaign refusal: its parent campaign holds the project lease
   * FOR it, so it must run rather than refuse against its own parent (design §5 step 3, §8).
   */
  isCampaignChild: boolean;
  /**
   * The crashed session id a campaign redrive spawned this child to resume (design §7,
   * `VETINARI_RESUME_SESSION`): when set, a `run` re-enters the loop on that session on the
   * existing branch instead of a fresh start. Undefined for a fresh run or an answered re-admit.
   */
  resumeSession?: string;
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
  listParked: typeof listParked;
  /** Is the issue parked (a record on disk)? An `answer` delivers to it; an unparked
   *  issue is reported and ignored (design §7). */
  hasParked: typeof hasParked;
  /** Deliver a human's answer into the parked record — the answer is delivered, not run
   *  (design §5 step 3). */
  answerParked: typeof answerParked;
  /** Does a live campaign process hold this project's lease (design §8)? When it does, an
   *  `answer` only delivers and a `redrive` refuses — the live campaign owns the re-admit,
   *  so no second process runs the member beside it. */
  projectHasLiveCampaign: typeof projectHasLiveCampaign;
  /** Read this project's event log — the source a green `answer` checks to decide
   *  whether the issue belongs to a paused campaign it should redrive (design §7). */
  readEventLog: typeof readEventLog;
  archiveRun: typeof archiveRun;
  requireTelegram: typeof requireTelegram;
  tgTest: typeof tgTest;
  /** Collect a project's Telegram bot connection into its host.env (the `tg-connect` mode). */
  runTgConnect: typeof runTgConnect;
  /** A readline prompt, TTY-gated by the collector — the same seam `askUnderspecified` uses. */
  ask: (question: string) => Promise<string>;
  /** One `sendMessage`, the collector's verification of a bot connection before it writes. */
  tgSend: typeof tgSend;
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
      // A standalone `run` refuses while a campaign process for the project is live
      // (design §5 step 3, §8): that campaign owns the issue and its worktree, so a second
      // process must not run it — it would archive the campaign's live log out from under it
      // and start a second sandbox on the same issue. Refuse BEFORE any destructive step —
      // before the leftover-archive and the container — with one line and a non-zero exit,
      // so a later reordering that archives first is caught by the test rather than shipping.
      // A campaign's OWN child `run` (VETINARI_CHILD) is exempt: its parent holds the lease
      // FOR it, so it must run (the archive-leftover step already skips children too).
      if (!deps.isCampaignChild && deps.projectHasLiveCampaign(deps.host.configDir, cfg.project)) {
        deps.log(`a campaign is already running for ${cfg.project} — it owns this issue; run refused.`);
        deps.setExitCode(1);
        return;
      }
      enableJson(cmd.json);
      deps.archiveLeftoverRun();
      // A crash redrive spawned this child to resume a crashed session on the existing branch
      // (design §7, `VETINARI_RESUME_SESSION`): re-enter the loop on that session with a
      // continue-where-you-left-off prompt rather than a fresh fetch. Absent → a fresh run.
      const resumeEntry = deps.resumeSession
        ? { resumeSessionId: deps.resumeSession, answerPrompt: crashResumePrompt() }
        : undefined;
      // Exit code is the queue's slot signal (design §3): 0 green, 2 parked, 1 failed. The loop
      // holds one host slot around the container (design §3 step 1, §8) — `deps.host` carries the
      // budget; a campaign child skips the slot itself (its parent holds one for it).
      deps.setExitCode(exitCodeFor(await deps.runLoop(cfg, cmd.args[0], deps.host, resumeEntry)));
      return;
    }
    case "campaign": {
      await dispatchCampaign(cmd, deps);
      return;
    }
    case "redrive": {
      // A redrive refuses while a campaign process for the project is live (design §7): that
      // process owns the re-admit, so a second one must not run over it. Report one line and stop.
      if (deps.projectHasLiveCampaign(deps.host.configDir, cfg.project)) {
        deps.log(`a campaign is already running for ${cfg.project} — it will pick up the work; redrive refused.`);
        return;
      }
      // The umbrella verb (ADR 0020, design §7): reconstruct the plan from the log and
      // re-enter the first unclosed wave. Lock in the agent first (ADR 0016); take no
      // selection and continue the live log, so — like `campaign --resume` — never archive
      // the leftover it would reconstruct from, only archive once idle.
      deps.selectAgent(cfg, cmd.agent);
      enableJson(cmd.json);
      const outcome = await deps.campaign(cfg, [], deps.host, undefined, {
        autoPrune: cmd.autoPrune,
        resume: true,
        override: cmd.override,
      });
      deps.archiveIfIdle();
      // Exit with the campaign's verdict (design §5 step 6): 0 done, 2 parked, 1 failed.
      deps.setExitCode(exitCodeFor(outcome));
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
      // Force a reset of the live log now, even mid-run — the manual escape hatch,
      // unlike the automatic archive that waits for an idle queue. Parked records are
      // left intact (design §2.5): a surviving record keeps its card parked until the
      // issue is answered/redriven or explicitly dropped with `prune --purge`.
      const r = deps.archiveRun(cfg);
      cfg.log.log("archived", {
        archivedLog: r.archivedLog ?? null,
        clearedOutbound: r.clearedOutbound,
      });
      deps.log(
        r.archivedLog
          ? `archived run log → ${r.archivedLog}`
          : "no run log to archive",
      );
      deps.log(
        "live log reset — any parked records are kept (answer/redrive to resume, or `prune --purge` to drop)",
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
    case "tgConnect": {
      // Collect this project's bot connection into its own host.env — the same base
      // location tg-test resolves from cfg.stateDir (ADR 0002). The pure planner/apply and
      // the collect loop live in tg-connect.ts; the prompt and the verification send are
      // wired from deps here, TTY-gated inside the collector. `ok` false → non-zero exit.
      const baseLocation = resolve(process.cwd(), cfg.stateDir);
      const result = await deps.runTgConnect(
        baseLocation,
        { token: cmd.token, chat: cmd.chat, noVerify: cmd.noVerify, force: cmd.force },
        { isTTY: deps.isTTY, ask: deps.ask, send: deps.tgSend, log: deps.log, label: cfg.project },
      );
      if (!result.ok) deps.setExitCode(1);
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
 * each with a `--dry-run` that prints and runs nothing. Human lines route through a
 * `report.ts` reporter that falls silent under `--json` (where the run logger streams the
 * raw events instead); the `--dry-run` previews stay on `deps.log`, as they run nothing.
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

  // `--json` streams raw events to stdout (below, via the run logger) and — through this
  // reporter — silences every human line, so tooling reads clean JSONL. Without it the
  // pre-run plan lines print and no JSON reaches stdout (design §11, #299).
  enableJson(cmd.json);
  const reporter = makeReporter({ json: cmd.json, out: deps.log });

  // Resume reconstructs the plan from the log and takes no issues — no selection,
  // planning, or override applies. It continues the live log, so (unlike a fresh run)
  // it must NOT archive the leftover it would otherwise reconstruct from.
  if (cmd.resume) {
    // `campaign --resume` is the retained one-release alias for `redrive` (ADR 0020, design
    // §7): still honoured, but point the operator at the verb the docs now use.
    reporter.line(
      "note: `campaign --resume` is now `redrive` — run `vetinari redrive` instead (this alias is kept for one release).",
    );
    // Under --resume, --override re-runs a failed member instead of stopping as failed
    // again (design §7); the literal-waves meaning of --override below never applies here
    // (resume takes no batch args and returns before reaching it).
    const outcome = await deps.campaign(cfg, [], host, cmd.name, {
      autoPrune: cmd.autoPrune,
      resume: true,
      override: cmd.override,
    });
    deps.archiveIfIdle();
    deps.setExitCode(exitCodeFor(outcome));
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
    const outcome = await deps.campaign(cfg, batches, host, cmd.name, { autoPrune: cmd.autoPrune });
    deps.archiveIfIdle();
    deps.setExitCode(exitCodeFor(outcome));
    return;
  }

  // Default (and --dry-run): expand any labels to a flat id set, then PLAN it into
  // dependency-ordered, file-disjoint waves. The epic/pending-verify drops the label
  // expansion makes are collected here so the planner names them in the provenance (#343).
  const tokens = cmd.positional.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
  const excluded: Exclusion[] = [];
  const ids = await deps.expandSelection(tokens, cfg.listByLabel, (e) => excluded.push(e));
  if (!ids.length) {
    reporter.line("campaign: nothing to run — the selection expanded to no open issues.");
    return;
  }
  const report = await deps.runCampaignPlan(
    cfg,
    ids,
    { onUnderspecified: cmd.onUnderspecified },
    { isTTY: deps.isTTY, ask: deps.askUnderspecified },
    excluded,
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
    reporter.line("campaign: nothing schedulable — every ticket is unreachable.");
    reporter.line("");
    reporter.line(report.report);
    return;
  }

  // Show the plan provenance about to run (its titled plan follows from `campaign` itself),
  // then run it. Archive any leftover run first, and archive on completion (a halt still
  // enters the archived-runs list, #141).
  reporter.line(report.report);
  reporter.line("");
  deps.archiveLeftoverRun();
  const outcome = await deps.campaign(cfg, report.waves, host, cmd.name, { autoPrune: cmd.autoPrune });
  deps.archiveIfIdle();
  deps.setExitCode(exitCodeFor(outcome));
}

/**
 * The prune command: prune `<issue>` + everything blocked by it from the RUNNING campaign
 * (the from-scratch reduced-launch batch form is retired — design §12). The orchestration
 * lives in `runPrune`; this only parses (done in `parseArgs`) and renders.
 */
async function dispatchPrune(
  cmd: Extract<Command, { kind: "prune" }>,
  deps: DispatchDeps,
): Promise<void> {
  const { cfg, host } = deps;
  const result = await deps.runPrune(cfg, cmd.target!, {
    project: cmd.project,
    dryRun: cmd.dryRun,
    purge: cmd.purge,
    host,
  });
  const tgt = result.target;
  // The CLI only drives the running-campaign path now; `runPrune`'s retired launch mode
  // is never reached without a `plan`.
  if (result.mode !== "prune") return;

  // Lead with the identity so a human recognizes what is being pruned — the project, the
  // derived repo, and the issue title (dry-run and applied alike).
  deps.log(identityLine(result.project, result.repo, tgt, result.title));
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
    // Dry-run preview: the human prose already printed above. Emit the structured closure
    // — which the aggregated dashboard's prune preview parses — only under `--json`, so a
    // bare `prune --dry-run` leaves no JSON on stdout (design §11). The dashboard's shell
    // passes `--json`. A dry-run appends no event, so return either way.
    if (cmd.json) deps.log(`prune-closure ${JSON.stringify(result.closure)}`);
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
  let result;
  try {
    result = await deps.runGraft(deps.cfg, cmd.ids, { project: cmd.project, dryRun: cmd.dryRun });
  } catch (err) {
    if (err instanceof GraftRejectedError) {
      // A real graft rejects whole (ADR 0014). Print the human prose the dry-run also
      // prints, emit the machine `graft-closure {json}` line only under `--json` (design
      // §11 — a bare `graft` leaves no JSON on stdout), and exit non-zero. The awaiting
      // dashboard route reads that same closure off the child's stdout to 422.
      deps.log(err.message);
      if (cmd.json) deps.log(`graft-closure ${JSON.stringify(err.closure)}`);
      deps.setExitCode(1);
      return;
    }
    throw err;
  }
  if (result.rejected.length) {
    // A `--dry-run` discloses a whole-batch rejection instead of throwing, so the
    // aggregated dashboard's preview can name the offenders off the closure line.
    deps.log(
      `graft rejected — nothing added (${describeGraftRejections(result.rejected)}).`,
    );
  } else {
    // Lead with the identity of each grafted id — the project, the derived repo, and the
    // issue title — so a human recognizes an id that belongs to the wrong repo.
    for (const id of result.ids)
      deps.log(identityLine(result.project, result.repo, id, result.titles[id]));
    deps.log(
      `graft ${result.ids.map((i) => `#${i}`).join(", ")} → ` +
        result.placement.map((p) => `#${p.id} in wave ${p.wave}`).join(", "),
    );
    deps.log(
      `resulting campaign: ${result.remaining.map((w) => `"${w.join(" ")}"`).join(" ")}`,
    );
  }
  if (result.closure) {
    // Dry-run preview: the human prose already printed above. Emit the structured closure
    // — which the aggregated dashboard's graft preview parses — only under `--json`, so a
    // bare `graft --dry-run` leaves no JSON on stdout (design §11). The dashboard's shell
    // passes `--json`. A dry-run appends no event, so return either way.
    if (cmd.json) deps.log(`graft-closure ${JSON.stringify(result.closure)}`);
    return;
  }
  if (result.applied)
    deps.log(
      "graft event appended — the running campaign will add these issues to future waves at the next wave boundary.",
    );
}

/**
 * The answer command: an answer is *delivered*, not run (design §5 step 3, §7). It writes the
 * text into the parked record and marks it answered; whoever re-admits the member consumes it
 * (resume the session with the answer, or post it and re-enter fresh — `runLoop` does this). Who
 * re-admits depends on liveness: a live campaign owns the re-admit (the answer only delivers, so
 * no second process runs the member beside it); with no live campaign, a member of a paused
 * campaign is re-admitted by the redrive, and a standalone park (no campaign) re-runs directly.
 * An answer for an issue that is not parked is reported and ignored — idempotent (§7).
 */
async function dispatchAnswer(
  cmd: Extract<Command, { kind: "answer" }>,
  deps: DispatchDeps,
): Promise<void> {
  const { cfg, host } = deps;
  if (!cmd.taskId || !cmd.text.length)
    throw new Error('answer needs a task id and text: answer <task> "<answer>"');
  const taskId = cmd.taskId;

  // Same preflight as `run` (design §3 step 1, §15): validate the provider and check its
  // credentials before anything, so a gateway-spawned answer fails fast with a helpful line
  // rather than dying inside a container. `answer` carries no `--agent` flags, so the selection
  // is the project default with any inherited `VETINARI_AGENT` layered on.
  deps.selectAgent(cfg, {});

  // Not parked → nothing to deliver to. Report one line and exit clean, idempotent against a
  // double answer or an answer a prune already removed (design §7).
  if (!deps.hasParked(cfg, taskId)) {
    deps.log(`${taskId} is not parked — nothing to answer.`);
    return;
  }

  // Deliver: write the answer into the parked record and mark it answered. The record and its
  // `tgMessageId` are kept so the gateway does not re-announce; the re-admit consumes it.
  deps.answerParked(cfg, taskId, cmd.text.join(" "));

  // A live campaign owns the re-admit (design §5 step 3, §8): stop here so no second process
  // runs the member beside it — the campaign's drain/grace picks up the answered record next tick.
  if (deps.projectHasLiveCampaign(host.configDir, cfg.project)) {
    deps.log(`${taskId} answered — the live campaign will re-admit it.`);
    return;
  }

  // No live campaign. A member of a paused campaign is re-admitted by the redrive (design §7):
  // it reconciles the answered park into a re-run-with-answer and integrates it, then archives
  // once idle. The redrive carries the campaign's own verdict out (0 done / 2 parked / 1 failed).
  if (issueAwaitsRedrive(deps.readEventLog(cfg), taskId)) {
    const outcome = await deps.campaign(cfg, [], host, undefined, { resume: true });
    deps.archiveIfIdle();
    deps.setExitCode(exitCodeFor(outcome));
    return;
  }

  // A standalone park (no campaign): run the loop directly — it consumes the answered record
  // (resume the session with the answer, or post it and re-enter fresh) and exits on its own
  // verdict: 0 green, 2 parked, 1 failed. Like any run it holds one host slot (design §8).
  deps.setExitCode(exitCodeFor(await deps.runLoop(cfg, taskId, host)));
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
