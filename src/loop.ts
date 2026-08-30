import { execFileSync } from "node:child_process";
import { nonResumableAnswerWarning, type ResolvedConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { runGates } from "./gate.ts";
import { agentFor, agentSelectionFor, makeSandbox, type Sandbox } from "./sandbox.ts";
import { clearParked, enqueueOutbound, hasParked, park, readParked } from "./state.ts";
import { HARVEST_PROMPT, parseFindings, reportFindings } from "./findings.ts";
import { activityLoggingSink, appendActivity, initActivityLog } from "./activity.ts";
import { event } from "./event-log.ts";

/**
 * The files a single commit touched, from the host repo (the agent branch's objects share the host
 * object store). Best-effort: a git failure yields `[]` and a diagnostic rather than aborting a real
 * green over a `commit` event's file list.
 */
function filesInCommit(sha: string, log: Logger): string[] {
  try {
    return execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch (e: any) {
    log.log("commit-files-failed", { sha, error: String(e?.message ?? e) });
    return [];
  }
}

/**
 * Commits on `branch` not reachable from `base`, in the host repo. Returns null
 * if it cannot be determined (e.g. git errors) — callers must not treat null as
 * zero, or a transient git failure would swallow a real green.
 */
function commitsAhead(base: string, branch: string, log: Logger): number | null {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", `${base}..${branch}`], { encoding: "utf8" }).trim());
  } catch (e: any) {
    log.log("commits-ahead-failed", { base, branch, error: String(e?.message ?? e) });
    return null;
  }
}

export const DONE = "<promise>COMPLETE</promise>";
export const BLOCKED = "<promise>BLOCKED</promise>";

export type Outcome = "green" | "parked" | "failed";

export interface ResumeEntry {
  resumeSessionId: string;
  answerPrompt: string;
}

/**
 * The effectful edges `runLoop` leans on that escape a temp-dir harness — the
 * container factory and the two host-repo git reads — injected so the loop is
 * drivable with a fake sandbox and stubbed git, mirroring `CampaignDeps`/`GraftDeps`.
 * The defaults are the production effects, so the injected path never changes
 * behaviour. `runGates`, `park`, `enqueueOutbound` and `cfg.log` are deliberately
 * NOT here: they run for real against the temp-dir cfg and are asserted on disk,
 * and the fake sandbox's `exec` already controls the gate's green/red.
 */
export interface LoopDeps {
  makeSandbox: (cfg: ResolvedConfig, taskId: string) => Promise<Sandbox>;
  commitsAhead: (base: string, branch: string, log: Logger) => number | null;
  filesInCommit: (sha: string, log: Logger) => string[];
}
export const defaultLoopDeps: LoopDeps = { makeSandbox, commitsAhead, filesInCommit };

/**
 * The verification/gate report the orchestrator hands a red turn. Its resumable
 * form is an inline resume prompt on the live session; its non-resumable form is a
 * block appended to the re-read issue text so a FRESH run picks up where the last
 * left off — its own prior work already committed on the branch, plus the report and
 * the most-recent turn summary (bounded: most-recent only, never the full history).
 */
const redResumePrompt = (report: string) =>
  `The orchestrator ran the verification suite and it is red. Fix the implementation — do not weaken the tests.\n\n${report}\n\nWhen you believe it is fixed, emit ${DONE} again, and end this turn with a <turn-summary> line as before.`;

const freshRedReentry = (report: string, priorSummary: string) =>
  `---\n\n(Continuing earlier work on this task — a fresh run. Your prior turn's commits are already on this branch.)\n\n` +
  `The orchestrator ran the verification suite and it is red. Fix the implementation — do not weaken the tests.` +
  (priorSummary ? `\n\nYour most recent turn summary:\n${priorSummary}` : "") +
  `\n\nVerification report:\n${report}`;

export const answerPromptFor = (text: string) =>
  `Answer from the human to your question:\n\n${text}\n\nContinue the work. The signal contract is unchanged: ${DONE} when done, ${BLOCKED} if blocked again — and end this turn with a <turn-summary> line as before.`;

/**
 * The GitHub-issue comment a non-resumable park→answer relays (this issue / #212):
 * a marked disclaimer so it is never mistaken for spec, the agent's parked question
 * echoed for context, then the human's answer. The fresh run's `fetchTask` re-reads
 * the issue including this comment, so the answer is delivered purely through
 * "read the issue" — no session resume, no `answerPrompt` injection.
 */
export const parkedAnswerComment = (question: string, answer: string) =>
  `> *Parked-question answer relayed by vetinari.*\n**Q:** ${question}\n${answer}`;

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
async function harvestFindings(cfg: ResolvedConfig, sbx: Sandbox, sessionId: string | undefined, common: any, taskId: string) {
  if (!cfg.reportFinding || !sessionId) return;
  try {
    const hr = await sbx.run({ ...common, maxIterations: 1, resumeSession: sessionId, prompt: HARVEST_PROMPT });
    const findings = parseFindings(hr.stdout ?? "");
    cfg.log.log("findings", { taskId, count: findings.length });
    if (!findings.length) return;

    const results = await reportFindings(cfg.reportFinding, findings, { taskId, project: cfg.project });
    for (const r of results) {
      if (r.error) cfg.log.log("finding-report-failed", { taskId, summary: r.finding.summary, error: r.error });
      else cfg.log.log("finding-filed", { taskId, summary: r.finding.summary, url: r.url });
    }
    const filed = results.filter((r) => !r.error).length;
    if (filed)
      enqueueOutbound(cfg, {
        category: "finding",
        text: `🔎 ${cfg.project} ${taskId}: filed ${filed} incidental finding(s)${filed !== results.length ? ` (${results.length - filed} failed — see log)` : ""}.`,
      });
  } catch (e: any) {
    cfg.log.log("harvest-failed", { taskId, error: String(e?.message ?? e) });
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
export async function runLoop(cfg: ResolvedConfig, taskId: string, entry?: ResumeEntry, deps: LoopDeps = defaultLoopDeps): Promise<Outcome> {
  // Whether the loop resumes a session between turns (claude/pi/codex) or re-enters each
  // turn as a fresh run (copilot/cursor/opencode carry no durable session) — ADR 0016 / #212.
  const { resumable, provider } = agentSelectionFor(cfg);

  // An answered parked record re-admits this member with the human's answer (design §5 step 3,
  // §7): consume it here, as the run starts — resume the session with the answer (resumable) or
  // relay it as an issue comment and re-enter fresh (non-resumable) — then clear the record so the
  // gateway never re-announces and no re-admit fires twice. An explicit `entry` (a direct resume)
  // already carries its prompt and skips this.
  if (!entry && hasParked(cfg, taskId)) {
    const rec = readParked(cfg, taskId, { requireSession: false });
    if (rec.answer != null) {
      if (resumable) {
        if (!rec.sessionId)
          throw new Error(`parked record for ${taskId} has no sessionId — cannot resume the answer`);
        entry = { resumeSessionId: rec.sessionId, answerPrompt: answerPromptFor(rec.answer) };
      } else {
        if (!cfg.postComment) throw new Error(nonResumableAnswerWarning(provider));
        await cfg.postComment(taskId, parkedAnswerComment(rec.question, rec.answer));
      }
      clearParked(cfg, taskId);
    }
  }

  const task = entry ? "" : await cfg.fetchTask(taskId);
  // Preflight (design §3 step 1): a non-resumable provider with no `postComment` cannot have
  // a parked question answered — surface it up front rather than only when a park is stranded.
  if (!resumable && !cfg.postComment) console.warn(nonResumableAnswerWarning(provider));
  const sbx = await deps.makeSandbox(cfg, taskId);
  // Start the per-task activity stream fresh — live-only scratch, overwritten per run (ADR 0015).
  initActivityLog(cfg.stateDir, taskId);
  try {
    const common = {
      agent: agentFor(cfg),
      completionSignal: [DONE, BLOCKED],
      idleTimeoutSeconds: cfg.idleTimeoutSeconds,
      // Additive to the human-readable agent log: projects the raw run stream into
      // activity-<taskId>.jsonl per tool-use, so the live-tail pane has a structured source (ADR 0015).
      logging: activityLoggingSink(cfg.stateDir, taskId),
    };
    let r: any;
    try {
      r = entry
        ? await sbx.run({ ...common, maxIterations: 1, resumeSession: entry.resumeSessionId, prompt: entry.answerPrompt })
        : await sbx.run({ ...common, promptFile: cfg.promptFile, promptArgs: { TASK: task, PROJECT: cfg.project } });

      for (let turn = 0; turn < cfg.maxTurns; turn++) {
        const sessionId = r.iterations.at(-1)?.sessionId;
        const turnFields = { taskId, turn, signal: r.completionSignal, sessionId, usage: usageOf(r), commits: r.commits?.length ?? 0, summary: extractTurnSummary(r.stdout ?? "") ?? "" };
        cfg.log.log("turn", turnFields);
        // Fold the loop's own events into the per-task activity stream so the pane tails one merged
        // record (ADR 0015): the turn, then a per-`commit` line for each commit this turn landed.
        appendActivity(cfg.stateDir, taskId, event("turn", turnFields));
        for (const c of r.commits ?? [])
          appendActivity(cfg.stateDir, taskId, event("commit", { taskId, branch: sbx.branch, sha: c.sha, files: deps.filesInCommit(c.sha, cfg.log) }));

        if (r.completionSignal === BLOCKED) {
          await park(cfg, { taskId, reason: "question", sessionId, branch: sbx.branch, question: extractQuestion(r.stdout ?? "") });
          return "parked";
        }

        // No-commit park (design §3 step 6): a COMPLETE that left no commit beyond the
        // base is not green — a no-op agent that says done and changed nothing. This runs
        // BEFORE the gates (step 7), so nothing-ahead parks `stalled/no-commit` without
        // spending a gate run or a turn — and a `when`-scoped gate never trivially greens
        // an empty diff. null (git couldn't tell) is NOT zero, so a transient failure falls
        // through to the gate rather than falsely parking.
        const ahead = deps.commitsAhead(cfg.baseBranch, sbx.branch, cfg.log);
        if (ahead === 0) {
          cfg.log.log("empty-green", { taskId, branch: sbx.branch });
          await park(cfg, {
            taskId,
            reason: "stalled",
            detail: "no-commit",
            sessionId,
            branch: sbx.branch,
            question: `COMPLETE but ${sbx.branch} has no commit beyond ${cfg.baseBranch} — the agent produced no change. Likely a no-op, or the task needs clarification before it can be done.`,
          });
          return "parked";
        }

        const { green, report } = await runGates(cfg, sbx, { taskId });
        if (green) {
          cfg.log.log("green", { taskId, branch: sbx.branch, commits: (r.commits ?? []).map((c: any) => c.sha) });
          // The human GREEN banner is the terminal view (design §11); under --json the screen is
          // the raw event stream alone, so keep it out to leave the JSONL clean for tooling (#299).
          if (process.env.VETINARI_JSON !== "1") console.log(`\n*** GREEN — commits on ${sbx.branch}\n`);
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

        if (resumable) {
          // Resume via resumeSession + inline prompt — the SAME path the park→answer
          // resume uses (above). `r.resume()` inherits the turn-0 promptArgs, which the
          // library rejects alongside an inline prompt ("promptArgs is only supported
          // with promptFile"), so a red gate errored instead of resuming (#3).
          const resumeSessionId = r.iterations.at(-1)?.sessionId;
          if (!resumeSessionId) throw new Error("no session id to resume — cannot drive the TDD loop");
          r = await sbx.run({ ...common, maxIterations: 1, resumeSession: resumeSessionId, prompt: redResumePrompt(report) });
        } else {
          // Non-resumable provider: there is no session to resume, so the next turn is a
          // FRESH run through the same promptFile path turn 0 uses — re-reading the issue
          // via fetchTask, its prior work visible as commits already on the branch, with the
          // gate report + most-recent turn summary carried in the prompt (#212). Don't spin a
          // fresh run on the final turn: it would never be gated. Fall through to the budget park.
          if (turn + 1 >= cfg.maxTurns) break;
          const freshTask = await cfg.fetchTask(taskId);
          r = await sbx.run({
            ...common,
            promptFile: cfg.promptFile,
            promptArgs: { TASK: `${freshTask}\n\n${freshRedReentry(report, turnFields.summary)}`, PROJECT: cfg.project },
          });
        }
      }

      // Budget park (design §3 step 8): `detail` carries the specifics (`budget:<maxTurns>`)
      // per §2.3, not the bare reason.
      await park(cfg, { taskId, reason: "stalled", detail: `budget:${cfg.maxTurns}`, sessionId: r.iterations.at(-1)?.sessionId, branch: sbx.branch, question: `Turn budget exhausted (${cfg.maxTurns} gate cycles).` });
      return "parked";
    } catch (err: any) {
      // An agent that emits NEITHER signal dies on the idle timeout as a thrown
      // error, not a result. Without this catch the slot leaves no parked
      // record and the work is unrecoverable.
      if (String(err?.name ?? err?.constructor?.name).includes("Idle")) {
        await park(cfg, { taskId, reason: "stalled", detail: "idle", sessionId: err?.sessionId, branch: sbx.branch, question: "Agent stalled without emitting a signal." });
        return "parked";
      }
      // Anything else thrown is a terminal failure, not a park (design §3 step 9): log a
      // `failed` verdict — with the detail — so even a standalone run leaves one on the log,
      // then return `failed`. cli-dispatch maps that to exit 1; under a campaign the child's
      // non-zero exit is what the parent folds to `campaign-failed`.
      cfg.log.log("failed", { taskId, detail: String(err?.message ?? err) });
      return "failed";
    }
  } finally {
    const closed = await sbx.close();
    if (closed?.preservedWorktreePath) cfg.log.log("worktree-preserved", { taskId, path: closed.preservedWorktreePath });
  }
}
