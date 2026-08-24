import { execFileSync } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { runGates } from "./gate.ts";
import { agentFor, makeSandbox } from "./sandbox.ts";
import { clearParked, enqueueOutbound, park } from "./state.ts";
import { HARVEST_PROMPT, parseFindings, reportFindings } from "./findings.ts";

/**
 * Commits on `branch` not reachable from `base`, in the host repo. Returns null
 * if it cannot be determined (e.g. git errors) — callers must not treat null as
 * zero, or a transient git failure would swallow a real green.
 */
function commitsAhead(base: string, branch: string): number | null {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", `${base}..${branch}`], { encoding: "utf8" }).trim());
  } catch (e: any) {
    log("commits-ahead-failed", { base, branch, error: String(e?.message ?? e) });
    return null;
  }
}

export const DONE = "<promise>COMPLETE</promise>";
export const BLOCKED = "<promise>BLOCKED</promise>";

export type Outcome = "green" | "parked";

export interface ResumeEntry {
  resumeSessionId: string;
  answerPrompt: string;
}

export const answerPromptFor = (text: string) =>
  `Answer from the human to your question:\n\n${text}\n\nContinue the work. The signal contract is unchanged: ${DONE} when done, ${BLOCKED} if blocked again — and end this turn with a <turn-summary> line as before.`;

/**
 * The one-line, agent-authored account of what happened this turn, pulled from
 * its own `<turn-summary>` tag (ADR 0009). Distinct from the `<summary>` nested
 * inside a `<question>` — that is the question's headline, not the turn's. Old
 * logs predating the contract carry no tag and yield undefined, so their `turn`
 * events reconstruct with no summary rather than an invented one.
 */
export const extractTurnSummary = (stdout: string): string | undefined => {
  const m = stdout.match(/<turn-summary>([\s\S]*?)<\/turn-summary>/);
  return m ? m[1].trim() : undefined;
};

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
 * A green run's last act, before the container is destroyed: ask the agent, on
 * its own live session, for any defect it noticed but did not fix, and file each
 * through the configured reporter. Self-contained and never throws — a failed
 * harvest must not turn a real green into an error. No-op unless a reporter is
 * configured.
 */
async function harvestFindings(cfg: ResolvedConfig, sbx: any, sessionId: string | undefined, common: any, taskId: string) {
  if (!cfg.reportFinding || !sessionId) return;
  try {
    const hr = await sbx.run({ ...common, maxIterations: 1, resumeSession: sessionId, prompt: HARVEST_PROMPT });
    const findings = parseFindings(hr.stdout ?? "");
    log("findings", { taskId, count: findings.length });
    if (!findings.length) return;

    const results = await reportFindings(cfg.reportFinding, findings, { taskId, project: cfg.project });
    for (const r of results) {
      if (r.error) log("finding-report-failed", { taskId, summary: r.finding.summary, error: r.error });
      else log("finding-filed", { taskId, summary: r.finding.summary, url: r.url });
    }
    const filed = results.filter((r) => !r.error).length;
    if (filed)
      enqueueOutbound(cfg, {
        category: "finding",
        text: `🔎 ${cfg.project} ${taskId}: filed ${filed} incidental finding(s)${filed !== results.length ? ` (${results.length - filed} failed — see log)` : ""}.`,
      });
  } catch (e: any) {
    log("harvest-failed", { taskId, error: String(e?.message ?? e) });
  }
}

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
        log("turn", { taskId, turn, signal: r.completionSignal, sessionId, usage: usageOf(r), commits: r.commits?.length ?? 0, summary: extractTurnSummary(r.stdout ?? "") ?? "" });

        if (r.completionSignal === BLOCKED) {
          await park(cfg, { taskId, reason: "blocked", sessionId, branch: sbx.branch, question: extractQuestion(r.stdout ?? "") });
          return "parked";
        }

        const { green, report } = await runGates(cfg, sbx);
        if (green) {
          // Empty-green guard (#1): a `when`-scoped gate does not fire on an
          // empty diff, so a no-op agent that emits DONE gets a trivial green on
          // a branch it never advanced. Green must mean "the gate passed on a
          // real change" — require a commit beyond the base. null (git couldn't
          // tell) is NOT zero, so a transient failure never falsely parks.
          const ahead = commitsAhead(cfg.baseBranch, sbx.branch);
          if (ahead === 0) {
            log("empty-green", { taskId, branch: sbx.branch });
            await park(cfg, {
              taskId,
              reason: "no-commit",
              sessionId,
              branch: sbx.branch,
              question: `The gate passed but ${sbx.branch} has no commit beyond ${cfg.baseBranch} — the agent produced no change. Likely a no-op, or the task needs clarification before it can be done.`,
            });
            return "parked";
          }
          log("green", { taskId, branch: sbx.branch, commits: (r.commits ?? []).map((c: any) => c.sha) });
          console.log(`\n*** GREEN — commits on ${sbx.branch}\n`);
          enqueueOutbound(cfg, {
            category: "success",
            event: "green",
            text: `✅ ${cfg.project} agent GREEN on ${taskId} — orchestrator-verified, commits on ${sbx.branch}`,
          });
          clearParked(cfg, taskId);
          // Harvest incidental findings on the still-live session before teardown.
          await harvestFindings(cfg, sbx, sessionId, common, taskId);
          return "green";
        }

        // Resume via resumeSession + inline prompt — the SAME path the park→answer
        // resume uses (above). `r.resume()` inherits the turn-0 promptArgs, which the
        // library rejects alongside an inline prompt ("promptArgs is only supported
        // with promptFile"), so a red gate errored instead of resuming (#3).
        const resumeSessionId = r.iterations.at(-1)?.sessionId;
        if (!resumeSessionId) throw new Error("no session id to resume — cannot drive the TDD loop");
        r = await sbx.run({
          ...common,
          maxIterations: 1,
          resumeSession: resumeSessionId,
          prompt: `The orchestrator ran the verification suite and it is red. Fix the implementation — do not weaken the tests.\n\n${report}\n\nWhen you believe it is fixed, emit ${DONE} again, and end this turn with a <turn-summary> line as before.`,
        });
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
