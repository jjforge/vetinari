import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { agentFor, makeSandbox } from "./sandbox.ts";
import { clearParked, park } from "./state.ts";
import { tgSend } from "./telegram.ts";

export const DONE = "<promise>COMPLETE</promise>";
export const BLOCKED = "<promise>BLOCKED</promise>";

export type Outcome = "green" | "parked";

export interface ResumeEntry {
  resumeSessionId: string;
  answerPrompt: string;
}

export const answerPromptFor = (text: string) =>
  `Answer from the human to your question:\n\n${text}\n\nContinue the work. The signal contract is unchanged: ${DONE} when done, ${BLOCKED} if blocked again.`;

const extractQuestion = (stdout: string) => {
  const m = stdout.match(/<question>([\s\S]*?)<\/question>/);
  if (m) return m[1].trim();
  // A malformed tag must still reach the human — park with the tail and let
  // them read it, rather than failing the run over a missing bracket.
  return `(no <question> tag found; stdout tail)\n${stdout.split("\n").slice(-40).join("\n")}`;
};

const usageOf = (r: any) =>
  (r.iterations ?? []).reduce(
    (acc: any, it: any) => {
      const u = it.usage ?? {};
      acc.input += u.inputTokens ?? 0;
      acc.output += u.outputTokens ?? 0;
      acc.cacheRead += u.cacheReadInputTokens ?? 0;
      acc.cacheCreate += u.cacheCreationInputTokens ?? 0;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  );

/**
 * One task, one container: agent turn → orchestrator gate → resume with the
 * failures → repeat. Both entry points share this loop; only the first call
 * differs, so an answered question re-enters exactly where a fresh run does.
 *
 * `resumeSession` is incompatible with maxIterations > 1 (it throws before the
 * sandbox is created), so iterations are always driven from here.
 */
export async function runLoop(cfg: ResolvedConfig, taskId: string, entry?: ResumeEntry): Promise<Outcome> {
  const task = entry ? "" : await cfg.fetchTask(taskId);
  const sbx = await makeSandbox(cfg, taskId);
  try {
    const common = {
      agent: agentFor(cfg),
      completionSignal: [DONE, BLOCKED],
      idleTimeoutSeconds: cfg.idleTimeoutSeconds,
    };
    let r: any;
    try {
      r = entry
        ? await sbx.run({ ...common, maxIterations: 1, resumeSession: entry.resumeSessionId, prompt: entry.answerPrompt })
        : await sbx.run({ ...common, promptFile: cfg.promptFile, promptArgs: { TASK: task, PROJECT: cfg.project } });

      for (let turn = 0; turn < cfg.maxTurns; turn++) {
        const sessionId = r.iterations.at(-1)?.sessionId;
        log("turn", { taskId, turn, signal: r.completionSignal, sessionId, usage: usageOf(r), commits: r.commits?.length ?? 0 });

        if (r.completionSignal === BLOCKED) {
          await park(cfg, { taskId, reason: "blocked", sessionId, branch: sbx.branch, question: extractQuestion(r.stdout ?? "") });
          return "parked";
        }

        const { green, report } = await runGates(cfg, sbx);
        if (green) {
          log("green", { taskId, branch: sbx.branch, commits: (r.commits ?? []).map((c: any) => c.sha) });
          console.log(`\n*** GREEN — commits on ${sbx.branch}\n`);
          await tgSend(`✅ ${cfg.project} agent GREEN on ${taskId} — orchestrator-verified, commits on ${sbx.branch}`);
          clearParked(cfg, taskId);
          return "green";
        }

        if (!r.resume) throw new Error("provider is not resumable — cannot drive the TDD loop");
        r = await r.resume(
          `The orchestrator ran the verification suite and it is red. Fix the implementation — do not weaken the tests.\n\n${report}\n\nWhen you believe it is fixed, emit ${DONE} again.`,
        );
      }

      await park(cfg, { taskId, reason: "budget", sessionId: r.iterations.at(-1)?.sessionId, branch: sbx.branch, question: `Turn budget exhausted (${cfg.maxTurns} gate cycles).` });
      return "parked";
    } catch (err: any) {
      // An agent that emits NEITHER signal dies on the idle timeout as a thrown
      // error, not a result. Without this catch the slot leaves no parked
      // record and the work is unrecoverable.
      if (String(err?.name ?? err?.constructor?.name).includes("Idle")) {
        await park(cfg, { taskId, reason: "idle-timeout", sessionId: err?.sessionId, branch: sbx.branch, question: "Agent stalled without emitting a signal." });
        return "parked";
      }
      throw err;
    }
  } finally {
    const closed = await sbx.close();
    if (closed?.preservedWorktreePath) log("worktree-preserved", { taskId, path: closed.preservedWorktreePath });
  }
}
