import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from "./sandbox.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { answerParked, hasParked, listOutbox, listParked, park } from "./state.ts";
import { projectHasLiveCampaign, readLeases, type HostBudget } from "./host-slots.ts";
import { BLOCKED, DONE, defaultLoopDeps, extractTurnSummary, parkedAnswerComment, runLoop, type LoopDeps } from "./loop.ts";
import { HARVEST_PROMPT, type Finding, type FindingContext } from "./findings.ts";
import { Refusal } from "./refusal.ts";

// A temp-dir `cfg` mirroring graft.test/modes.test's `harnessCfg`: a real on-disk
// event log, parked dir and outbox under a throwaway state dir, driven by a real
// logger — so `park`/`enqueueOutbound`/`cfg.log` are exercised for real and their
// effects asserted on disk. Only the container-and-git edges are injected via LoopDeps.
const harnessCfg = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-loop-"));
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return {
    project: "harness",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    gates: [{ cmd: "run-tests" }],
    log: loggerForRun({ logFile }),
    fetchTask: async () => "task text",
    ...overrides,
  } as unknown as ResolvedConfig;
};

// One turn's script: the `run()` result the fake returns for that turn, whether its
// gate goes green (via the fake `exec` exit code), and whether `run()` instead dies
// on an Idle-named error (the no-signal stall).
interface TurnScript {
  run?: Partial<SandboxRunResult>;
  green?: boolean;
  throwIdle?: boolean;
  throwIdleSession?: string;
  throwGeneric?: string;
  // What `git status --porcelain` reports in the worktree after this turn (default clean),
  // and whether that read fails (non-zero exit).
  status?: string;
  statusFails?: boolean;
}

// A scriptable fake sandbox: `run()` shifts through `script` (one entry per turn),
// and `exec()` answers the gate's command with turn N's green/red. The `git diff`
// probe `runGates` runs first always reports a change so the (un-scoped) gate fires.
type FakeSandbox = Sandbox & { runCalls: SandboxRunOptions[] };
const fakeSandbox = (script: TurnScript[], branch = "agent/T-1"): FakeSandbox => {
  let turn = -1;
  const runCalls: SandboxRunOptions[] = [];
  return {
    branch,
    runCalls,
    async run(opts) {
      runCalls.push(opts);
      turn++;
      const s = script[turn];
      if (s?.throwIdle || s?.throwIdleSession) {
        const e = new Error("agent stalled without a signal");
        e.name = "IdleTimeoutError";
        if (s.throwIdleSession) (e as any).sessionId = s.throwIdleSession;
        throw e;
      }
      if (s?.throwGeneric) throw new Error(s.throwGeneric);
      return { iterations: [{ sessionId: `sess-${turn}` }], commits: [], stdout: "", ...s?.run };
    },
    async exec(cmd) {
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/loop.ts\n", stderr: "", exitCode: 0 };
      if (cmd.startsWith("git status --porcelain"))
        return script[turn]?.statusFails
          ? { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }
          : { stdout: script[turn]?.status ?? "", stderr: "", exitCode: 0 };
      const green = script[turn]?.green ?? true;
      return { stdout: "gate output", stderr: "gate errors", exitCode: green ? 0 : 1 };
    },
    async close() {
      return undefined;
    },
  };
};

// LoopDeps over a given fake sandbox: git reads default to "one commit ahead" and an
// empty file list; a test overrides `commitsAhead` for the empty-green cases.
const depsFor = (sbx: Sandbox, over: Partial<LoopDeps> = {}): LoopDeps => ({
  makeSandbox: async () => sbx,
  commitsAhead: () => 1,
  filesInCommit: () => [],
  // No stop by default: the handler installs but is never fired (returns a no-op unsubscribe).
  onStop: () => () => {},
  ...over,
});

// runLoop echoes GREEN/PARKED banners and the logger echoes every row; silence the
// console so a test reads its result off disk, not off a wall of run output.
const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = real;
  }
};

test("extractTurnSummary pulls the one-line summary the agent authored this turn", () => {
  const stdout = `working on the slice...\n<turn-summary>Added a failing test for the summary extractor and made it green.</turn-summary>\n<promise>COMPLETE</promise>`;
  assert.equal(extractTurnSummary(stdout), "Added a failing test for the summary extractor and made it green.");
});

test("extractTurnSummary trims surrounding whitespace", () => {
  const stdout = `<turn-summary>\n  Parked: the seam is genuinely ambiguous.\n</turn-summary>`;
  assert.equal(extractTurnSummary(stdout), "Parked: the seam is genuinely ambiguous.");
});

test("extractTurnSummary returns undefined for output predating the contract", () => {
  // Logs written before the summary contract simply carry no tag; the turn
  // event must reconstruct with no summary rather than inventing one.
  assert.equal(extractTurnSummary("no tags here\n<promise>COMPLETE</promise>"), undefined);
});

test("extractTurnSummary does not mistake the <summary> nested in a <question> for the turn summary", () => {
  // A blocked turn's stdout carries a <summary> inside <question>. That is the
  // question's headline, not the turn's account — the turn summary is its own tag.
  const stdout = `<turn-summary>Parked to ask which base branch the prune should target.</turn-summary>
<question>
  <summary>Which base branch?</summary>
  <detail>The task names two.</detail>
</question>
<promise>BLOCKED</promise>`;
  assert.equal(extractTurnSummary(stdout), "Parked to ask which base branch the prune should target.");
});

test("parkedAnswerComment marks the relay, echoes the parked question, then carries the answer", () => {
  const body = parkedAnswerComment("Which base branch should the prune target?", "Use main.");
  assert.equal(body, "> *Parked-question answer relayed by vetinari.*\n**Q:** Which base branch should the prune target?\nUse main.");
});

test("runLoop parks (question) when a turn emits the BLOCKED signal", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "question");
  assert.match(parked[0].question, /Which base\?/);
});

test("runLoop parks (stalled: no-commit) when the gate passes but the branch has no commit beyond base", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "no-commit");
  // A clean worktree keeps the no-op wording.
  assert.equal(
    parked[0].question,
    "COMPLETE but agent/T-1 has no commit beyond base — the agent produced no change. Likely a no-op, or the task needs clarification before it can be done.",
  );
  // The empty-green guard fired — no green event, no success outbound.
  assert.equal(
    readEventLog(cfg).some((e) => e.event === "green"),
    false,
  );
});

test("runLoop's no-commit park precedes the gates (design §3 step 6): a COMPLETE with nothing ahead parks stalled/no-commit without spending a gate run", async () => {
  const cfg = harnessCfg();
  // The gate would go RED this turn, but there is no commit ahead of base — the
  // no-commit check (step 6) runs before the gates (step 7), so it parks first and
  // the gate never runs.
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, green: false }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "no-commit");
  // No gate run was spent — the no-commit check short-circuits ahead of step 7.
  assert.equal(
    readEventLog(cfg).some((e) => e.event === "gate"),
    false,
  );
});

test("runLoop nudges a no-signal turn once on the same session instead of parking it no-commit", async () => {
  const cfg = harnessCfg();
  // Turn 0 hit its iteration limit mid-work: no signal, nothing committed yet. The nudge
  // turn commits and signals DONE.
  const sbx = fakeSandbox([{ run: {} }, { run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);
  const commitsAhead = () => (sbx.runCalls.length >= 2 ? 1 : 0);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead })));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls.length, 2);
  assert.equal(sbx.runCalls[1].resumeSession, "sess-0");
  assert.equal(sbx.runCalls[1].maxIterations, 1);
  assert.match(sbx.runCalls[1].prompt ?? "", /ended before you committed or signalled/);
  assert.match(sbx.runCalls[1].prompt ?? "", /<turn-summary>/);
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop nudges a non-resumable provider's no-signal turn as a fresh run carrying the issue text and the nudge", async () => {
  const cfg = harnessCfg({ agent: { provider: "copilot" }, promptFile: "/prompts/tdd.md", postComment: async () => {} });
  const sbx = fakeSandbox([{ run: {} }, { run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls.length, 2);
  assert.equal(sbx.runCalls[1].resumeSession, undefined);
  assert.equal(sbx.runCalls[1].promptFile, "/prompts/tdd.md");
  const task = sbx.runCalls[1].promptArgs?.TASK ?? "";
  assert.match(task, /task text/);
  assert.match(task, /ended before you committed or signalled/);
});

test("runLoop nudges a no-signal turn even with commits ahead — it is gated only after the nudge turn", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { commits: [{ sha: "abc123" }] } }, { run: { completionSignal: DONE }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls.length, 2);
  assert.match(sbx.runCalls[1].prompt ?? "", /ended before you committed or signalled/);
  const events = readEventLog(cfg) as { event: string; turn?: number }[];
  const gates = events.flatMap((e, i) => (e.event === "gate" ? [i] : []));
  assert.equal(gates.length, 1);
  const turn1 = events.findIndex((e) => e.event === "turn" && e.turn === 1);
  assert.ok(turn1 >= 0 && gates[0] > turn1, "the only gate runs after the nudge turn");
});

test("runLoop sends no nudge when the no-signal turn is the last of the budget (maxTurns 1)", async () => {
  const cfg = harnessCfg({ maxTurns: 1 });
  const sbx = fakeSandbox([{ run: {} }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 1);
});

test("runLoop's no-commit park names the uncommitted worktree changes instead of claiming no change", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, status: " M src/loop.ts\n?? changelog.d/25.md\n" }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  const [rec] = listParked(cfg);
  assert.equal(rec.reason, "stalled");
  assert.equal(rec.detail, "no-commit");
  assert.match(rec.question, /^COMPLETE but agent\/T-1 has no commit beyond base/);
  assert.match(rec.question, /worktree has uncommitted changes: src\/loop\.ts, changelog\.d\/25\.md/);
  assert.doesNotMatch(rec.question, /produced no change/);
});

test("runLoop's no-commit park names only the first five uncommitted paths, then counts the rest", async () => {
  const cfg = harnessCfg();
  const status = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"].map((f) => ` M ${f}`).join("\n") + "\n";
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, status }]);

  await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  const [rec] = listParked(cfg);
  assert.match(rec.question, /uncommitted changes: a\.ts, b\.ts, c\.ts, d\.ts, e\.ts \+2 more\./);
  assert.doesNotMatch(rec.question, /f\.ts/);
});

test("runLoop nudges at most once: a second no-signal turn with nothing ahead parks no-commit without claiming COMPLETE", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: {} }, { run: {}, status: " M src/loop.ts\n" }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 2, "only one nudge was sent");
  const [rec] = listParked(cfg);
  assert.equal(rec.detail, "no-commit");
  assert.match(rec.question, /without a completion signal/);
  assert.match(rec.question, /uncommitted changes: src\/loop\.ts/);
  assert.doesNotMatch(rec.question, /COMPLETE/);
  assert.doesNotMatch(rec.question, /produced no change/);
});

test("runLoop's no-commit park after a no-signal turn on a clean worktree claims neither COMPLETE nor no change", async () => {
  const cfg = harnessCfg({ maxTurns: 1 });
  const sbx = fakeSandbox([{ run: {} }]);

  await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  const [rec] = listParked(cfg);
  assert.equal(rec.detail, "no-commit");
  assert.equal(rec.question, "The turn ended without a completion signal and agent/T-1 has no commit beyond base; the worktree is clean.");
});

test("runLoop's no-commit park says the worktree state could not be read when git status fails", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, statusFails: true }]);

  await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  const [rec] = listParked(cfg);
  assert.equal(rec.detail, "no-commit");
  assert.match(rec.question, /worktree state could not be read/);
  assert.doesNotMatch(rec.question, /produced no change/);
});

test("runLoop logs a failed verdict and returns failed when a turn throws a non-Idle error (design §3 step 9)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwGeneric: "container vanished" }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "failed");
  const failed = readEventLog(cfg).find((e) => e.event === "failed") as { taskId: string; detail: string } | undefined;
  assert.ok(failed, "a standalone run that throws leaves a failed verdict on the log");
  assert.equal(failed!.taskId, "T-1");
  assert.match(failed!.detail, /container vanished/);
  // A failed verdict is a terminal outcome, not a park — no parked record is written.
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop logs a failed verdict when the sandbox cannot be created — a throw before the container (design §3 step 9)", async () => {
  // A worktree-preflight throw in makeSandbox happens before the inner container try, so the
  // old catch never saw it: the run exited with a stack trace and no verdict on the log. Now
  // an outer catch logs one `failed` for every path before/around the container.
  const cfg = harnessCfg();
  const sbx = fakeSandbox([]);
  const deps = depsFor(sbx, {
    makeSandbox: async () => {
      throw new Error("worktree preflight: base branch missing");
    },
  });

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, deps));

  assert.equal(outcome, "failed");
  const failed = readEventLog(cfg).find((e) => e.event === "failed") as { taskId: string; detail: string } | undefined;
  assert.ok(failed, "a pre-sandbox throw leaves a failed verdict on the log");
  assert.equal(failed!.taskId, "T-1");
  assert.match(failed!.detail, /worktree preflight/);
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop folds a Refusal to a failed verdict and returns failed — the loop does not re-throw a refusal (#354)", async () => {
  // A refusal reached only through the run loop (e.g. sandbox's already-checked-out
  // worktree) still becomes a logged `failed` verdict and the run's exit 1 — nothing
  // changes for the operator inside the loop; the Refusal is not re-thrown to the CLI handler.
  const cfg = harnessCfg();
  const sbx = fakeSandbox([]);
  const deps = depsFor(sbx, {
    makeSandbox: async () => {
      throw new Refusal(
        "agent/T-1 is already checked out at /somewhere — remove that worktree before running this issue (one run per issue).",
      );
    },
  });

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, deps));

  assert.equal(outcome, "failed", "a run-loop refusal folds to failed, not re-thrown");
  const failed = readEventLog(cfg).find((e) => e.event === "failed") as { taskId: string; detail: string } | undefined;
  assert.ok(failed, "the refusal leaves a failed verdict on the log");
  assert.match(failed!.detail, /already checked out/);
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop logs a failed verdict when fetchTask throws — a throw before the container (design §3 step 9)", async () => {
  const cfg = harnessCfg({
    fetchTask: async () => {
      throw new Error("tracker unreachable");
    },
  });
  const sbx = fakeSandbox([]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "failed");
  const failed = readEventLog(cfg).find((e) => e.event === "failed") as { taskId: string; detail: string } | undefined;
  assert.ok(failed, "a fetchTask throw leaves a failed verdict on the log");
  assert.match(failed!.detail, /tracker unreachable/);
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop returns green when the gate passes on a real change", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  const green = readEventLog(cfg).find((e) => e.event === "green") as { branch: string; commits: string[] } | undefined;
  assert.ok(green, "expected a green event on the log");
  assert.deepEqual(green!.commits, ["abc123"]);
  const outbox = listOutbox(cfg);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].category, "success");
  assert.equal(outbox[0].event, "green");
  assert.equal(listParked(cfg).length, 0);
});

// Capture the human banner console.log emits (the logger only echoes under --json, off here),
// so a test can read exactly what a standalone run prints on green.
const captureLog = async <T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
  const realLog = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = realLog;
  }
};

test("a standalone green run's banner says the commits are not merged and names campaign <id> as what integrates them (#339)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }], "agent/T-1");

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "green");
  const banner = captured.lines.join("\n");
  assert.match(banner, /agent\/T-1/, "still names the branch");
  assert.match(banner, /not merged/i, "says the work is not merged");
  assert.match(banner, /campaign T-1/, "names campaign <id> as what integrates it");
});

test("a campaign child's green run does not tell the operator to run campaign — the child marker suppresses the guidance (#339)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }], "agent/T-1");

  const prevChild = process.env.VETINARI_CHILD;
  process.env.VETINARI_CHILD = "1";
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "green");
  const banner = captured.lines.join("\n");
  assert.match(banner, /agent\/T-1/, "the branch line still prints for a child");
  assert.doesNotMatch(banner, /campaign T-1/, "a wave member never tells the operator to run campaign");
  assert.doesNotMatch(banner, /not merged/i, "the not-merged guidance is suppressed for a child");
});

test("under --json neither the green banner nor the new not-merged guidance reaches stdout (#339, #299)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }], "agent/T-1");

  const prevJson = process.env.VETINARI_JSON;
  const prevChild = process.env.VETINARI_CHILD;
  process.env.VETINARI_JSON = "1";
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevJson === undefined) delete process.env.VETINARI_JSON;
    else process.env.VETINARI_JSON = prevJson;
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "green");
  const banner = captured.lines.join("\n");
  assert.doesNotMatch(banner, /\*\*\* GREEN/, "no human GREEN banner under --json");
  assert.doesNotMatch(banner, /not merged/i, "no not-merged guidance under --json — the JSONL stays clean");
});

// --- Verdict banners: a run's failed/parked outcomes print on the terminal like green (#355) ------

test("a run whose sandbox creation throws prints a FAILED banner and the re-run line, outcome still failed (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([]);
  const deps = depsFor(sbx, {
    makeSandbox: async () => {
      throw new Error("agent/T-1 is already checked out at /somewhere — remove that worktree");
    },
  });

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, deps));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "failed");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* FAILED — agent\/T-1 is already checked out at \/somewhere — remove that worktree/);
  assert.match(banner, /Fix that, then re-run: vetinari run T-1/);
});

test("a parked (question) run prints a PARKED banner with the question and the answer line (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } }]);

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "parked");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* PARKED \(question\) — .*Which base\?/);
  assert.match(banner, /Answer with: vetinari answer T-1/);
});

test("a stall park (no-commit) prints a PARKED (stalled) banner carrying the record's question (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE } }], "agent/T-1");

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 0 })));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "parked");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* PARKED \(stalled\) — COMPLETE but agent\/T-1 has no commit beyond base/);
  assert.match(banner, /Answer with: vetinari answer T-1/);
});

test("a park prints exactly one PARKED line — park() itself prints nothing (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } }]);

  const { lines } = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  const parkedLines = lines.filter((l) => l.includes("*** PARKED"));
  assert.equal(parkedLines.length, 1, "exactly one PARKED banner — the run loop prints it, park() does not");
});

test("under --json no FAILED/PARKED or next-step line prints, though the JSONL event lines are still captured (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } }]);

  const prevJson = process.env.VETINARI_JSON;
  process.env.VETINARI_JSON = "1";
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevJson === undefined) delete process.env.VETINARI_JSON;
    else process.env.VETINARI_JSON = prevJson;
  }

  assert.equal(captured.result, "parked");
  const banner = captured.lines.join("\n");
  assert.doesNotMatch(banner, /\*\*\* PARKED/, "no human PARKED banner under --json");
  assert.doesNotMatch(banner, /Answer with/, "no next-step line under --json");
  assert.ok(
    captured.lines.some((l) => l.includes('"event":"parked"')),
    "the JSONL parked event still reaches stdout under --json",
  );
});

test("a FAILED banner under --json prints neither the *** line nor the re-run line (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwGeneric: "container vanished" }]);

  const prevJson = process.env.VETINARI_JSON;
  process.env.VETINARI_JSON = "1";
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevJson === undefined) delete process.env.VETINARI_JSON;
    else process.env.VETINARI_JSON = prevJson;
  }

  assert.equal(captured.result, "failed");
  const banner = captured.lines.join("\n");
  assert.doesNotMatch(banner, /\*\*\* FAILED/, "no human FAILED banner under --json");
  assert.doesNotMatch(banner, /Fix that/, "no re-run line under --json");
});

test("a campaign child prints the *** verdict line but suppresses the next-step line (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwGeneric: "container vanished" }]);

  const prevChild = process.env.VETINARI_CHILD;
  process.env.VETINARI_CHILD = "1";
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "failed");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* FAILED — container vanished/, "the reason line prints for a child");
  assert.doesNotMatch(banner, /Fix that/, "the next-step line is suppressed for a campaign child");
});

test("a child's parked verdict prints the *** line but suppresses the answer line (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } }]);

  const prevChild = process.env.VETINARI_CHILD;
  process.env.VETINARI_CHILD = "1";
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "parked");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* PARKED \(question\)/, "the reason line prints for a child");
  assert.doesNotMatch(banner, /Answer with/, "the answer line is suppressed for a campaign child");
});

test("a FAILED banner collapses a multi-line detail to its first non-empty line (#355)", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwGeneric: "first line of the failure\nsecond line with more detail" }]);

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "failed");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* FAILED — first line of the failure/);
  assert.doesNotMatch(banner, /second line with more detail/, "only the first non-empty line is on the *** line");
});

test("runLoop counts a null commitsAhead (git failed) as a real change, not an empty green", async () => {
  // null means git could not tell — the guard must fall through to green, never park.
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => null })));

  assert.equal(outcome, "green");
  assert.ok(
    readEventLog(cfg).some((e) => e.event === "green"),
    "null commitsAhead must still be green",
  );
  assert.equal(listParked(cfg).length, 0);
});

test("runLoop resumes a red gate on the same session and reaches green next turn", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE, commits: [{ sha: "def456" }] }, green: true },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  // The second run is a resume of turn 0's session — the same path park→answer uses.
  assert.equal(sbx.runCalls.length, 2);
  assert.equal(sbx.runCalls[1].resumeSession, "sess-0");
});

// Capture console.warn for the preflight-warning assertions, silencing console.log too.
const captureWarn = async <T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> => {
  const realWarn = console.warn;
  const realLog = console.log;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  console.log = () => {};
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
};

test("runLoop preflight warns once when a non-resumable provider has no postComment (a park could not be answered)", async () => {
  const cfg = harnessCfg({ agent: { provider: "copilot" }, promptFile: "/prompts/tdd.md" });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);

  const { warnings } = await captureWarn(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  const preflight = warnings.filter((w) => /postComment/.test(w));
  assert.equal(preflight.length, 1, "the preflight warning is printed exactly once");
  assert.match(preflight[0], /copilot/);
  assert.match(preflight[0], /park/);
});

test("runLoop preflight does not warn when a non-resumable provider HAS postComment configured (the answer path works)", async () => {
  const cfg = harnessCfg({ agent: { provider: "copilot" }, promptFile: "/prompts/tdd.md", postComment: async () => {} });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);

  const { warnings } = await captureWarn(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(warnings.filter((w) => /postComment/.test(w)).length, 0);
});

test("runLoop preflight does not warn for a resumable provider (its park→answer resumes the session)", async () => {
  const cfg = harnessCfg({ agent: { provider: "claude" } });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);

  const { warnings } = await captureWarn(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(warnings.filter((w) => /postComment/.test(w)).length, 0);
});

test("runLoop drives a non-resumable provider by a FRESH re-run each red turn — no resumeSession, no 'no session id' throw", async () => {
  let fetched = 0;
  const cfg = harnessCfg({
    agent: { provider: "copilot" },
    promptFile: "/prompts/tdd.md",
    fetchTask: async () => {
      fetched++;
      return "task text";
    },
  });
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE, stdout: "<turn-summary>Wrote a failing test for the parser.</turn-summary>" }, green: false },
    { run: { completionSignal: DONE, commits: [{ sha: "def456" }] }, green: true },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls.length, 2);
  // The second turn is a fresh run through the promptFile path — NOT a session resume.
  assert.equal(sbx.runCalls[1].resumeSession, undefined);
  assert.equal(sbx.runCalls[1].promptFile, "/prompts/tdd.md");
  // It re-reads the issue (fetchTask again) and carries the gate report + most-recent turn summary.
  assert.equal(fetched, 2);
  const reentryTask = sbx.runCalls[1].promptArgs?.TASK ?? "";
  assert.match(reentryTask, /task text/);
  assert.match(reentryTask, /gate output/); // the verification/gate report
  assert.match(reentryTask, /Wrote a failing test for the parser\./); // the prior turn summary
});

test("runLoop's fresh re-run carries only the most-recent turn summary, not the full history", async () => {
  const cfg = harnessCfg({ agent: { provider: "copilot" }, promptFile: "/prompts/tdd.md" });
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE, stdout: "<turn-summary>First slice.</turn-summary>" }, green: false },
    { run: { completionSignal: DONE, stdout: "<turn-summary>Second slice.</turn-summary>" }, green: false },
    { run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true },
  ]);

  await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  const thirdTask = sbx.runCalls[2].promptArgs?.TASK ?? "";
  assert.match(thirdTask, /Second slice\./);
  assert.doesNotMatch(thirdTask, /First slice\./);
});

test("runLoop parks (stalled: budget) for a one-shot non-resumable run (maxTurns 1) whose only turn is red", async () => {
  const cfg = harnessCfg({ agent: { provider: "copilot" }, maxTurns: 1, promptFile: "/prompts/tdd.md" });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, green: false }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 1);
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "budget:1");
});

test("runLoop parks (stalled: budget) when every turn stays red through maxTurns", async () => {
  const cfg = harnessCfg({ maxTurns: 2 });
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "budget:2");
});

test("runLoop parks (stalled: idle) when the agent dies on an Idle-named error", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwIdle: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "idle");
});

// A reporter that records every (finding, ctx) it is handed, so a test can assert both
// what was filed and whether it carried a non-green `source` mark.
const capturingReporter = () => {
  const calls: { finding: Finding; ctx: FindingContext }[] = [];
  const reportFinding = (finding: Finding, ctx: FindingContext) => {
    calls.push({ finding, ctx });
    return `https://example/issues/${calls.length}`;
  };
  return { calls, reportFinding };
};

const ONE_FINDING =
  "<finding><summary>Cache extracted corrupt</summary><location>vendor/hex</location></finding><promise>COMPLETE</promise>";

test("runLoop harvests a budget-exhausted park on the still-live session, filing findings marked with the exit", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ maxTurns: 2, reportFinding: rep.reportFinding });
  // Two red turns, an (ungated) final resume, then the harvest turn returns one finding.
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
    { run: { stdout: ONE_FINDING } },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  // The park itself is unaffected — same reason, detail and resumability as without a harvest.
  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "budget:2");
  // The harvest ran on the very session the park carries — not a fresh one.
  const harvestCall = sbx.runCalls.find((c) => c.prompt === HARVEST_PROMPT);
  assert.ok(harvestCall, "the harvest turn ran before teardown");
  assert.equal(harvestCall!.resumeSession, parked[0].sessionId);
  // The filed finding is marked with the exit that produced it, so triage can weigh it.
  assert.equal(rep.calls.length, 1);
  assert.equal(rep.calls[0].ctx.source, "budget:2");
  assert.match(rep.calls[0].finding.summary, /budget:2/);
  assert.match(rep.calls[0].finding.summary, /Cache extracted corrupt/);
});

test("runLoop's budget park with no findings files nothing and leaves the park unchanged", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ maxTurns: 2, reportFinding: rep.reportFinding });
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
    { run: { stdout: "<finding>none</finding><promise>COMPLETE</promise>" } },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  assert.equal(rep.calls.length, 0, "nothing observed means nothing filed");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "budget:2");
});

test("runLoop harvests an idle stall when the error carries a recoverable session, marking findings idle", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ reportFinding: rep.reportFinding });
  const sbx = fakeSandbox([{ throwIdleSession: "sess-idle" }, { run: { stdout: ONE_FINDING } }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "idle");
  const harvestCall = sbx.runCalls.find((c) => c.prompt === HARVEST_PROMPT);
  assert.ok(harvestCall, "the idle stall harvested on the recoverable session");
  assert.equal(harvestCall!.resumeSession, "sess-idle");
  assert.equal(rep.calls.length, 1);
  assert.equal(rep.calls[0].ctx.source, "idle");
  assert.match(rep.calls[0].finding.summary, /idle/);
});

test("runLoop's idle stall with no recoverable session skips the harvest cleanly", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ reportFinding: rep.reportFinding });
  const sbx = fakeSandbox([{ throwIdle: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  assert.equal(listParked(cfg)[0].detail, "idle");
  // No session to resume, so no harvest turn ran and nothing was filed — silently skipped.
  assert.equal(
    sbx.runCalls.some((c) => c.prompt === HARVEST_PROMPT),
    false,
  );
  assert.equal(rep.calls.length, 0);
});

test("runLoop does not harvest a thrown terminal failure", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ reportFinding: rep.reportFinding });
  const sbx = fakeSandbox([{ throwGeneric: "container vanished" }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "failed");
  assert.equal(
    sbx.runCalls.some((c) => c.prompt === HARVEST_PROMPT),
    false,
    "a thrown failure never harvests",
  );
  assert.equal(rep.calls.length, 0);
});

test("runLoop's green harvest is unmarked — a verified finding carries no source", async () => {
  const rep = capturingReporter();
  const cfg = harnessCfg({ reportFinding: rep.reportFinding });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }, { run: { stdout: ONE_FINDING } }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  assert.equal(rep.calls.length, 1);
  assert.equal(rep.calls[0].ctx.source, undefined, "a green finding carries no source");
  assert.doesNotMatch(rep.calls[0].finding.summary, /unverified/, "a green finding's filed form is unchanged");
  assert.equal(rep.calls[0].finding.summary, "Cache extracted corrupt");
});

test("runLoop resumes the parked session on the answer path without re-fetching the task", async () => {
  let fetched = 0;
  const cfg = harnessCfg({
    fetchTask: async () => {
      fetched++;
      return "task text";
    },
  });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() =>
    runLoop(cfg, "T-1", undefined, { resumeSessionId: "prev-sess", answerPrompt: "the human's answer" }, depsFor(sbx)),
  );

  assert.equal(outcome, "green");
  // The answer path resumes the human-answered session; it never fetches the task.
  assert.equal(fetched, 0);
  assert.equal(sbx.runCalls[0].resumeSession, "prev-sess");
  assert.equal(sbx.runCalls[0].prompt, "the human's answer");
});

test("runLoop consumes an answered parked record for a resumable provider — resumes the session with the answer and clears the record", async () => {
  let fetched = 0;
  const cfg = harnessCfg({
    agent: { provider: "claude" },
    fetchTask: async () => {
      fetched++;
      return "task text";
    },
  });
  await park(cfg, { taskId: "T-1", reason: "question", sessionId: "prev-sess", branch: "agent/T-1", question: "Which approach?" });
  answerParked(cfg, "T-1", "use approach A");
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  // The answered record drove a session resume carrying the human's answer — not a fresh fetch.
  assert.equal(fetched, 0, "an answered resume never re-fetches the task");
  assert.equal(sbx.runCalls[0].resumeSession, "prev-sess");
  assert.match(String(sbx.runCalls[0].prompt), /use approach A/);
  // The record is consumed when the run starts, so the member is never re-admitted twice.
  assert.equal(hasParked(cfg, "T-1"), false, "the answered record is cleared once the run starts");
});

test("runLoop consumes an answered parked record for a non-resumable provider — posts the answer as a comment and re-enters fresh", async () => {
  const posted: { taskId: string; body: string }[] = [];
  let fetched = 0;
  const cfg = harnessCfg({
    agent: { provider: "copilot" },
    promptFile: "/prompts/tdd.md",
    postComment: async (taskId: string, body: string) => {
      posted.push({ taskId, body });
    },
    fetchTask: async () => {
      fetched++;
      return "task text";
    },
  });
  await park(cfg, { taskId: "T-1", reason: "question", branch: "agent/T-1", question: "Which approach?" });
  answerParked(cfg, "T-1", "use approach A");
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  // Non-resumable: the answer is relayed as an issue comment and the run re-enters fresh (re-reads the issue).
  assert.equal(posted.length, 1, "the answer is posted as a comment");
  assert.match(posted[0].body, /use approach A/);
  assert.equal(sbx.runCalls[0].resumeSession, undefined, "no session resume — a fresh run");
  assert.ok(fetched >= 1, "the fresh run re-reads the issue");
  assert.equal(hasParked(cfg, "T-1"), false, "the answered record is cleared once the run starts");
});

// A fake sandbox whose `run()` observes the host lease mid-container, so a test can assert
// the run is holding a slot exactly while the agent works. It records both the run's own
// held lease and whether the project reads as a live *campaign* — a standalone run holds a
// slot but is never a campaign (design §8).
const leaseObservingSandbox = (configDir: string, project: string) => {
  const observed: { runHeld: number; liveCampaign: boolean } = { runHeld: 0, liveCampaign: false };
  const sbx: Sandbox = {
    branch: "agent/T-1",
    async run() {
      observed.runHeld = readLeases(configDir)
        .filter((l) => l.project === project)
        .reduce((s, l) => s + l.held, 0);
      observed.liveCampaign = projectHasLiveCampaign(configDir, project);
      return { iterations: [{ sessionId: "s" }], commits: [{ sha: "abc123" }], completionSignal: DONE, stdout: "" };
    },
    async exec(cmd) {
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/loop.ts\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async close() {
      return undefined;
    },
  };
  return { sbx, observed };
};

test("a standalone run holds one host slot around the container's life, but is not a live campaign (design §3 step 1, §8)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-loop-slots-"));
  const host: HostBudget = { configDir, ceiling: 4, weight: 1 };
  const cfg = harnessCfg({ project: "solo" });
  const { sbx, observed } = leaseObservingSandbox(configDir, "solo");

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  try {
    const outcome = await silence(() => runLoop(cfg, "T-1", host, undefined, depsFor(sbx)));
    assert.equal(outcome, "green");
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(observed.runHeld, 1, "the run holds one slot while the container runs");
  assert.equal(observed.liveCampaign, false, "a standalone run's lease is not a live campaign");
  assert.deepEqual(readLeases(configDir), [], "the slot is released and the project deregistered once the run finishes");
});

test("a campaign child run takes no host slot — its parent already holds one for it (design §8)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-loop-slots-"));
  const host: HostBudget = { configDir, ceiling: 4, weight: 1 };
  const cfg = harnessCfg({ project: "solo" });
  const { sbx, observed } = leaseObservingSandbox(configDir, "solo");

  const prevChild = process.env.VETINARI_CHILD;
  process.env.VETINARI_CHILD = "1";
  try {
    await silence(() => runLoop(cfg, "T-1", host, undefined, depsFor(sbx)));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(observed.runHeld, 0, "a child never registers a second lease beside its parent's");
  assert.deepEqual(readLeases(configDir), [], "no lease is left behind");
});

// --- The per-run stop handler (SIGINT/SIGTERM → park `stopped`, exit 2) ---------------------

// A controllable stop seam: capture the handler `runLoop` installs, fire it on demand, and report
// whether the run unsubscribed it. Tests drive a stop through this rather than a real signal.
const makeStopControl = () => {
  let cb: ((s: "SIGINT" | "SIGTERM") => void) | undefined;
  let unsubscribed = false;
  const onStop: LoopDeps["onStop"] = (c) => {
    cb = c;
    return () => {
      unsubscribed = true;
    };
  };
  return {
    onStop,
    fire: (s: "SIGINT" | "SIGTERM" = "SIGINT") => cb?.(s),
    get unsubscribed() {
      return unsubscribed;
    },
  };
};

// One scripted turn for the stop-capable fake: fire the stop as this `run()` is called, never
// settle (an in-flight agent call), reject the pending run when `close()` lands, or just return a
// result (optionally driving its gate green/red).
interface StopTurn {
  fireStop?: "SIGINT" | "SIGTERM";
  neverSettles?: boolean;
  rejectOnClose?: boolean;
  run?: Partial<SandboxRunResult>;
  green?: boolean;
}

// A fake sandbox that can fire a stop mid-`run` and, optionally, never settle that run — so a
// test can drive a signal that lands while the agent call is in flight. `close()` counts its
// calls and, for a `rejectOnClose` turn, rejects the abandoned run so the "run rejects once the
// sandbox closes" path is exercised.
const stopSandbox = (script: StopTurn[], control: ReturnType<typeof makeStopControl>, branch = "agent/T-1") => {
  let turn = -1;
  const runCalls: SandboxRunOptions[] = [];
  const state = { closeCalled: 0 };
  let rejectPending: ((e: Error) => void) | undefined;
  const sbx: Sandbox & { runCalls: SandboxRunOptions[]; state: typeof state } = {
    branch,
    runCalls,
    state,
    async run(opts) {
      runCalls.push(opts);
      turn++;
      const s = script[turn];
      if (s?.fireStop) control.fire(s.fireStop);
      if (s?.neverSettles)
        return new Promise<SandboxRunResult>((_res, rej) => {
          if (s.rejectOnClose) rejectPending = rej;
        });
      return { iterations: [{ sessionId: `sess-${turn}` }], commits: [], stdout: "", ...s?.run } as SandboxRunResult;
    },
    async exec(cmd) {
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/loop.ts\n", stderr: "", exitCode: 0 };
      const green = script[turn]?.green ?? true;
      return { stdout: "gate output", stderr: "gate errors", exitCode: green ? 0 : 1 };
    },
    async close() {
      state.closeCalled++;
      rejectPending?.(new Error("run abandoned when the sandbox closed"));
      return undefined;
    },
  };
  return sbx;
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("a stop mid-turn parks `stopped` (signal detail + branch), one parked event, no failed, closes the sandbox", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopSandbox([{ fireStop: "SIGINT", neverSettles: true }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stopped");
  assert.equal(parked[0].detail, "SIGINT");
  assert.equal(parked[0].branch, "agent/T-1");
  const events = readEventLog(cfg);
  assert.equal(events.filter((e) => e.event === "parked" && (e as any).reason === "stopped").length, 1);
  assert.equal(
    events.some((e) => e.event === "failed"),
    false,
    "a stop is a park, never a failed verdict",
  );
  assert.ok(sbx.state.closeCalled >= 1, "the sandbox was closed");
  assert.ok(control.unsubscribed, "the stop handler is removed when runLoop returns");
});

test("a stopped run's banner prints from the run loop and names `vetinari run <id>` as the resume move (#355)", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopSandbox([{ fireStop: "SIGINT", neverSettles: true }], control);

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  let captured: { result: string; lines: string[] };
  try {
    captured = await captureLog(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(captured.result, "parked");
  const parkedLines = captured.lines.filter((l) => l.includes("*** PARKED"));
  assert.equal(parkedLines.length, 1, "exactly one PARKED banner — printed from the run loop, not park()");
  const banner = captured.lines.join("\n");
  assert.match(banner, /\*\*\* PARKED \(stopped\) — The run was stopped before it reached a verdict\./);
  assert.match(banner, /Continue it with: vetinari run T-1/);
});

test("a stop whose abandoned run rejects once the sandbox closes still logs exactly one parked{stopped}, no failed", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopSandbox([{ fireStop: "SIGINT", neverSettles: true, rejectOnClose: true }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  const events = readEventLog(cfg);
  assert.equal(events.filter((e) => e.event === "parked" && (e as any).reason === "stopped").length, 1);
  assert.equal(
    events.some((e) => e.event === "failed"),
    false,
  );
});

test("a `stopped` park records the most recent finished-turn session — turn 0 red (sess-0), stop during turn 1", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopSandbox([{ green: false }, { fireStop: "SIGINT", neverSettles: true }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  assert.equal(listParked(cfg)[0].sessionId, "sess-0", "the record carries turn 0's session, the most recent finished turn");
});

test("a stop while fetchTask is still pending parks `stopped`; makeSandbox is never reached", async () => {
  const control = makeStopControl();
  const cfg = harnessCfg({
    fetchTask: () => {
      control.fire("SIGTERM");
      return new Promise<string>(() => {});
    },
  });
  let madeSandbox = false;
  const sbx = stopSandbox([], control);
  const outcome = await silence(() =>
    runLoop(
      cfg,
      "T-1",
      undefined,
      undefined,
      depsFor(sbx, {
        onStop: control.onStop,
        makeSandbox: async () => {
          madeSandbox = true;
          return sbx;
        },
      }),
    ),
  );

  assert.equal(outcome, "parked");
  assert.equal(madeSandbox, false, "a stop before the container never creates a sandbox");
  const rec = listParked(cfg)[0];
  assert.equal(rec.reason, "stopped");
  assert.equal(rec.detail, "SIGTERM");
  assert.equal(rec.branch, "agent/T-1", "the branch is the conventional <branchPrefix><id> when no container exists");
});

test("a stop during the budget harvest parks `stopped`, not `stalled` — exactly one parked event", async () => {
  const cfg = harnessCfg({ maxTurns: 1, reportFinding: async () => ({ url: "x" }) as any });
  const control = makeStopControl();
  // run#0 (turn 0) goes red → resume (run#1) → loop exits (maxTurns=1) → budget harvest (run#2),
  // which fires the stop and resolves. The stalled budget park must never be logged.
  const sbx = stopSandbox([{ green: false }, { green: false }, { fireStop: "SIGINT" }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  const parkedEvents = readEventLog(cfg).filter((e) => e.event === "parked");
  assert.equal(parkedEvents.length, 1, "exactly one parked event");
  assert.equal((parkedEvents[0] as any).reason, "stopped");
  assert.equal(
    parkedEvents.some((e) => (e as any).reason === "stalled"),
    false,
    "no budget stall park",
  );
});

test("a standalone run signalled while waiting first-come for a slot parks `stopped`, takes no slot, deregisters its lease", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-loop-stop-slots-"));
  // A blocker lease held by pid 1 (always alive) fills the ceiling, so this run can never acquire.
  mkdirSync(join(configDir, "slots"), { recursive: true });
  writeFileSync(join(configDir, "slots", "1.json"), JSON.stringify({ project: "solo", weight: 1, held: 1, want: 1, pid: 1, kind: "run" }));
  const host: HostBudget = { configDir, ceiling: 1, weight: 1 };
  const cfg = harnessCfg({ project: "solo" });
  const control = makeStopControl();
  let madeSandbox = false;
  const sbx = stopSandbox([], control);

  const prevChild = process.env.VETINARI_CHILD;
  delete process.env.VETINARI_CHILD;
  try {
    const p = silence(() =>
      runLoop(
        cfg,
        "T-1",
        host,
        undefined,
        depsFor(sbx, {
          onStop: control.onStop,
          makeSandbox: async () => {
            madeSandbox = true;
            return sbx;
          },
        }),
      ),
    );
    await sleepMs(150); // let the run enter the first-come slot wait
    control.fire("SIGINT");
    const outcome = await p;
    assert.equal(outcome, "parked");
  } finally {
    if (prevChild === undefined) delete process.env.VETINARI_CHILD;
    else process.env.VETINARI_CHILD = prevChild;
  }

  assert.equal(madeSandbox, false, "a run that never acquired a slot never created a sandbox");
  assert.equal(listParked(cfg)[0].reason, "stopped");
  assert.equal(
    readLeases(configDir).some((l) => l.pid === process.pid),
    false,
    "the waiting run deregistered its own lease on the way out",
  );
});

test("a stop while makeSandbox is still pending waits for it, then closes the sandbox without starting a turn", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopSandbox([], control);
  const outcome = await silence(() =>
    runLoop(
      cfg,
      "T-1",
      undefined,
      undefined,
      depsFor(sbx, {
        onStop: control.onStop,
        makeSandbox: async () => {
          control.fire("SIGINT");
          return sbx;
        },
      }),
    ),
  );

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 0, "no turn is started — run is never called");
  assert.ok(sbx.state.closeCalled >= 1, "the created sandbox is closed at once");
  assert.equal(listParked(cfg)[0].reason, "stopped");
});

test("a stop after green (inside the harvest) adds no parked event and the run resolves green", async () => {
  const cfg = harnessCfg({ reportFinding: async () => ({ url: "x" }) as any });
  const control = makeStopControl();
  // run#0 goes green; the harvest (run#1) fires the stop and resolves. A post-verdict stop is a no-op.
  const sbx = stopSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }, { fireStop: "SIGINT" }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "green");
  assert.equal(
    readEventLog(cfg).some((e) => e.event === "parked"),
    false,
    "a stop after a verdict adds nothing",
  );
  assert.ok(control.unsubscribed, "the handler is removed on a green return too");
});

test("defaultLoopDeps.onStop adds exactly one SIGINT and one SIGTERM listener for the run's life", async () => {
  const cfg = harnessCfg();
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  let duringInt = -1;
  let duringTerm = -1;
  const sbx: Sandbox = {
    branch: "agent/T-1",
    async run() {
      duringInt = process.listenerCount("SIGINT");
      duringTerm = process.listenerCount("SIGTERM");
      return { iterations: [{ sessionId: "s" }], commits: [{ sha: "abc" }], completionSignal: DONE, stdout: "" };
    },
    async exec(cmd) {
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/loop.ts\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async close() {
      return undefined;
    },
  };

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: defaultLoopDeps.onStop })));

  assert.equal(outcome, "green");
  assert.equal(duringInt, beforeInt + 1, "one SIGINT listener added during the run");
  assert.equal(duringTerm, beforeTerm + 1, "one SIGTERM listener added during the run");
  assert.equal(process.listenerCount("SIGINT"), beforeInt, "the SIGINT listener is removed after runLoop returns");
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm, "the SIGTERM listener is removed after runLoop returns");
});

// A stop-capable sandbox whose gate fires the stop while it runs, then takes `gateMs` to finish.
const stopInGateSandbox = (script: StopTurn[], control: ReturnType<typeof makeStopControl>, gateMs: number) => {
  const sbx = stopSandbox(script, control);
  const exec = sbx.exec.bind(sbx);
  sbx.exec = async (cmd) => {
    if (cmd.startsWith("git ")) return exec(cmd);
    control.fire("SIGTERM");
    await sleepMs(gateMs);
    return exec(cmd);
  };
  return sbx;
};

test("a stop during a green gate parks `stopped`: the gate is not awaited and no green is logged (#462)", async () => {
  const cfg = harnessCfg();
  const control = makeStopControl();
  const sbx = stopInGateSandbox([{ run: { completionSignal: "<promise>COMPLETE</promise>" }, green: true }], control, 2000);

  const t0 = Date.now();
  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  assert.ok(Date.now() - t0 < 1500, "the stop did not wait out the gate");
  const events = readEventLog(cfg);
  assert.equal(
    events.some((e) => e.event === "green"),
    false,
    "a stopped run never logs green",
  );
  assert.equal(events.filter((e) => e.event === "parked" && (e as any).reason === "stopped").length, 1);
  assert.ok(sbx.state.closeCalled >= 1, "the sandbox was closed");
});

test("a stop during a red gate starts no further turn (#462)", async () => {
  const cfg = { ...harnessCfg(), maxTurns: 6 };
  const control = makeStopControl();
  const sbx = stopInGateSandbox([{ run: { completionSignal: "<promise>COMPLETE</promise>" }, green: false }], control, 0);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 1, "no turn started after the stop");
  const events = readEventLog(cfg);
  assert.equal(events.filter((e) => e.event === "turn").length, 1);
  assert.equal(events.filter((e) => e.event === "parked" && (e as any).reason === "stopped").length, 1);
});

test("a gate abandoned by a stop runs no further check and logs no gate-result after the stopped park (#474)", async () => {
  const cfg = harnessCfg({ gates: [{ cmd: "g1" }, { cmd: "g2" }] } as any);
  const control = makeStopControl();
  const sbx = stopInGateSandbox([{ run: { completionSignal: "<promise>COMPLETE</promise>" }, green: true }], control, 100);
  const execCalls: string[] = [];
  const exec = sbx.exec.bind(sbx);
  sbx.exec = async (cmd) => {
    execCalls.push(cmd);
    return exec(cmd);
  };

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));
  // Let the abandoned gate settle — the bug logged its results after `runLoop` had returned.
  await sleepMs(300);

  assert.equal(outcome, "parked");
  const events = readEventLog(cfg);
  const parkedAt = events.findIndex((e) => e.event === "parked" && (e as any).reason === "stopped");
  assert.ok(parkedAt >= 0, "the run parked stopped");
  assert.deepEqual(
    events.slice(parkedAt + 1).map((e) => e.event),
    [],
    "nothing is logged after the stopped park",
  );
  assert.equal(execCalls.includes("g2"), false, "the second gate never runs");
});

test("a stop during a no-signal turn sends no nudge (#462)", async () => {
  const cfg = { ...harnessCfg(), maxTurns: 6 };
  const control = makeStopControl();
  const sbx = stopSandbox([{ fireStop: "SIGTERM", run: { completionSignal: undefined } }], control);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { onStop: control.onStop })));

  assert.equal(outcome, "parked");
  assert.equal(sbx.runCalls.length, 1, "the nudge turn was never started");
  assert.equal(listParked(cfg)[0].reason, "stopped");
});

test("a `stopped` record resumes its session (crashResumePrompt) when resumable + sessionId + commitsAhead>0", async () => {
  const cfg = harnessCfg({ agent: { provider: "claude" }, promptFile: "/prompts/tdd.md" } as any);
  await park(cfg, { taskId: "T-1", reason: "stopped", detail: "SIGINT", sessionId: "prev-sess", branch: "agent/T-1", question: "stopped" });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => 1 })));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls[0].resumeSession, "prev-sess", "the recorded session is resumed");
  assert.match(String(sbx.runCalls[0].prompt), /interrupted/, "the crash-resume prompt is carried");
  assert.equal(hasParked(cfg, "T-1"), false, "the stopped record is consumed and cleared");
});

test("a `stopped` record runs fresh on the kept branch when commitsAhead is 0 at the resume check", async () => {
  const cfg = harnessCfg({ agent: { provider: "claude" }, promptFile: "/prompts/tdd.md" } as any);
  await park(cfg, { taskId: "T-1", reason: "stopped", detail: "SIGINT", sessionId: "prev-sess", branch: "agent/T-1", question: "stopped" });
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc" }] }, green: true }]);
  // 0 for the resume check (run fresh), 1 for the loop's later no-commit check (a real change).
  let calls = 0;
  const commitsAhead = () => (calls++ === 0 ? 0 : 1);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead })));

  assert.equal(outcome, "green");
  assert.equal(sbx.runCalls[0].resumeSession, undefined, "no session resume — a fresh run");
  assert.equal(sbx.runCalls[0].promptFile, "/prompts/tdd.md", "a fresh promptFile run on the kept branch");
  assert.equal(hasParked(cfg, "T-1"), false, "no stopped record remains");
});
