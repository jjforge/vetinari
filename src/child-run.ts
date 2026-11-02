/**
 * The parent-to-child protocol for a campaign's member runs: the start a campaign hands each child
 * `run`, the process-wide invocation context (campaign child, `--json`, the agent override), the
 * verdict a child's exit decodes to, and the one writer of a `stopped` park. The env transport lives
 * here alone — no other source reads or writes these `VETINARI_*` names.
 */
import { encodeAgentOverride, parseAgentOverride } from "./config.ts";
import { crashResumePrompt, type ReentryEntry, type ResumeEntry } from "./loop.ts";

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

/**
 * How a child `run` enters the loop from its start (design §6, §7): a session to resume, with the
 * conflict prompt when it re-enters or the crash prompt otherwise (a crash redrive); a prompt with no
 * session (a non-resumable provider) is a fresh run on the kept branch with the prompt added to the
 * issue text, as `freshRedReentry` does; a fresh start is a fresh run.
 */
export function childRunEntry(start: ChildStart): ResumeEntry | ReentryEntry | undefined {
  if (start.kind === "resume") return { resumeSessionId: start.session, answerPrompt: crashResumePrompt() };
  if (start.kind === "fresh") return undefined;
  if (start.session) return { resumeSessionId: start.session, answerPrompt: start.prompt };
  return {
    reentry: `---\n\n(Continuing earlier work on this task — a fresh run. Your prior commits are already on this branch.)\n\n${start.prompt}`,
  };
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
