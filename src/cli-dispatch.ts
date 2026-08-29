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
import { parseAgentFlags } from "./config.ts";
import { renderUsage } from "./help.ts";

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
