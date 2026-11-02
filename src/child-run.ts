/**
 * The parent-to-child protocol for a campaign's member runs: the start a campaign hands each child
 * `run`, the process-wide invocation context (campaign child, `--json`, the agent override), the
 * verdict a child's exit decodes to, and the one writer of a `stopped` park. The env transport lives
 * here alone — no other source reads or writes these `VETINARI_*` names.
 */
import { encodeAgentOverride, parseAgentOverride, type ResolvedConfig } from "./config.ts";
import { park } from "./state.ts";

/**
 * How a campaign starts a member's child `run` (design §6, §7): `fresh`; `resume` a crashed session
 * on its existing branch (a crash redrive); or `reenter` with a merge-conflict retry's prompt — on
 * its session when it has one, else fresh on the kept branch (a non-resumable provider).
 */
export type ChildStart = { kind: "fresh" } | { kind: "resume"; session: string } | { kind: "reenter"; prompt: string; session?: string };

/** The start for a member given the crashed `session` and conflict `prompt` it carries, either unset. */
export function childStart(session: string | undefined, prompt: string | undefined): ChildStart {
  if (prompt) return session ? { kind: "reenter", prompt, session } : { kind: "reenter", prompt };
  return session ? { kind: "resume", session } : { kind: "fresh" };
}

/** The env a child `run` is spawned with for `start`: the child marker, plus the resume pair when set. */
export function encodeChildStart(start: ChildStart): NodeJS.ProcessEnv {
  const session = start.kind === "fresh" ? undefined : start.session;
  const prompt = start.kind === "reenter" ? start.prompt : undefined;
  return {
    VETINARI_CHILD: "1",
    ...(session ? { VETINARI_RESUME_SESSION: session } : {}),
    ...(prompt ? { VETINARI_RESUME_PROMPT: prompt } : {}),
  };
}

/** Read the start a campaign spawned this process with back out of `env`; an empty value is unset. */
export function decodeChildStart(env: NodeJS.ProcessEnv): ChildStart {
  return childStart(env.VETINARI_RESUME_SESSION, env.VETINARI_RESUME_PROMPT);
}

/** Was this process spawned as a campaign/queue child `run`? Every encoded start carries the marker. */
export function isCampaignChildRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.VETINARI_CHILD;
}

/**
 * Is `--json` on: the raw event JSONL streamed to stdout for tooling, in place of the human lines
 * (design §11, #299)? Read live, since `enableJsonOutput` turns it on mid-run during dispatch.
 */
export function isJsonOutput(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VETINARI_JSON === "1";
}

/** Turn `--json` on for this process and, by inheritance, every child `run` it spawns. */
export function enableJsonOutput(env: NodeJS.ProcessEnv = process.env): void {
  env.VETINARI_JSON = "1";
}

/**
 * The env var a `run`/`campaign` invocation stamps its CLI agent override onto, so campaign/queue
 * CHILD `run`s inherit it and drive the SAME agent as the parent instead of silently falling back to
 * the config default (ADR 0016).
 */
export const AGENT_ENV_VAR = "VETINARI_AGENT";

/** The CLI agent override this process was launched or spawned with (ADR 0016); unset or junk → `{}`. */
export function readAgentOverride(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof parseAgentOverride> {
  return parseAgentOverride(env[AGENT_ENV_VAR]);
}

/** Stamp a non-empty agent override on this process, so every child `run` it spawns inherits it. */
export function stampAgentOverride(over: Parameters<typeof encodeAgentOverride>[0], env: NodeJS.ProcessEnv = process.env): void {
  if (Object.keys(over).length) env[AGENT_ENV_VAR] = encodeAgentOverride(over);
}

/** A child `run`'s settled verdict, as the campaign deals in it: green, parked, or failed with its `detail`. */
export type ChildVerdict = { kind: "green" } | { kind: "parked" } | { kind: "failed"; detail: string };

/** How a child `run` ended: a verdict, or — killed by a signal under a stop — not yet one (#464). */
export type ChildExit = ChildVerdict | { kind: "stopped"; signal: NodeJS.Signals };

/** A failure's detail — `error(<cause>)`, the text a `failed` event carries. */
export const failedVerdict = (cause: string | number): ChildVerdict => ({ kind: "failed", detail: `error(${cause})` });

/**
 * Decode a child `run`'s exit — its code, or the signal that killed it — by `run`'s contract: `0`
 * green, `2` parked, any other code failed. A signal while the campaign is `halted` is `stopped`, for
 * the campaign to settle (#464); otherwise it is a failure named by the signal.
 */
export function decodeChildExit(exit: number | NodeJS.Signals, halted: boolean): ChildExit {
  if (typeof exit === "string") return halted ? { kind: "stopped", signal: exit } : failedVerdict(exit);
  return exit === 0 ? { kind: "green" } : exit === 2 ? { kind: "parked" } : failedVerdict(exit);
}

/** A spawn or stop-handling that threw: that member's failure, carrying the error's message. */
export function decodeChildRejection(err: unknown): ChildVerdict {
  return failedVerdict(err instanceof Error ? err.message : String(err));
}

/** The campaign's outcome string for a verdict: `green`, `parked`, or the failure's `error(…)` detail. */
export function verdictOutcome(verdict: ChildVerdict): string {
  return verdict.kind === "failed" ? verdict.detail : verdict.kind;
}

/** Is this campaign outcome a failure — a member the agent could not make green, or whose merge failed? */
export function isFailedOutcome(outcome: string | undefined): boolean {
  return !!outcome?.startsWith("error");
}

/** The question a `stopped` park carries: redrive-only, there is nothing to answer. */
export const STOPPED_RUN_QUESTION = "The run was stopped before it reached a verdict.";

/**
 * Park a run that a stop signal ended before it reached a verdict: reason `stopped`, the signal as
 * its `detail`, and the branch and session a later `run <id>` resumes. The one writer of this record —
 * the run parking itself (`runLoop`'s `parkStopped`) and the campaign parking a child killed before it
 * could (`stoppedRunOutcome`, #464) both call it. `park()` logs the `parked{stopped}` event.
 */
export async function parkStoppedRun(
  cfg: ResolvedConfig,
  run: { taskId: string; branch: string; sessionId?: string; signal?: NodeJS.Signals; question: string },
): Promise<void> {
  await park(cfg, {
    taskId: run.taskId,
    reason: "stopped",
    detail: run.signal,
    sessionId: run.sessionId,
    branch: run.branch,
    question: run.question,
  });
}
