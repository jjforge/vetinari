import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from "./sandbox.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { answerParked, hasParked, listOutbox, listParked, park } from "./state.ts";
import { projectHasLiveLease, readLeases, type HostBudget } from "./host-slots.ts";
import { BLOCKED, DONE, extractTurnSummary, parkedAnswerComment, runLoop, type LoopDeps } from "./loop.ts";

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
  throwGeneric?: string;
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
      if (s?.throwIdle) {
        const e = new Error("agent stalled without a signal");
        e.name = "IdleTimeoutError";
        throw e;
      }
      if (s?.throwGeneric) throw new Error(s.throwGeneric);
      return { iterations: [{ sessionId: `sess-${turn}` }], commits: [], stdout: "", ...s?.run };
    },
    async exec(cmd) {
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/loop.ts\n", stderr: "", exitCode: 0 };
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
  assert.equal(
    body,
    "> *Parked-question answer relayed by vetinari.*\n**Q:** Which base branch should the prune target?\nUse main.",
  );
});

test("runLoop parks (question) when a turn emits the BLOCKED signal", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([
    { run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } },
  ]);

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
  // The empty-green guard fired — no green event, no success outbound.
  assert.equal(readEventLog(cfg).some((e) => e.event === "green"), false);
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
  assert.equal(readEventLog(cfg).some((e) => e.event === "gate"), false);
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

test("runLoop counts a null commitsAhead (git failed) as a real change, not an empty green", async () => {
  // null means git could not tell — the guard must fall through to green, never park.
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, undefined, depsFor(sbx, { commitsAhead: () => null })));

  assert.equal(outcome, "green");
  assert.ok(readEventLog(cfg).some((e) => e.event === "green"), "null commitsAhead must still be green");
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
  const cfg = harnessCfg({ agent: { provider: "claude" }, fetchTask: async () => { fetched++; return "task text"; } });
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
    postComment: async (taskId: string, body: string) => { posted.push({ taskId, body }); },
    fetchTask: async () => { fetched++; return "task text"; },
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
// the run is holding a slot exactly while the agent works.
const leaseObservingSandbox = (configDir: string, project: string) => {
  const observed: { live: boolean } = { live: false };
  const sbx: Sandbox = {
    branch: "agent/T-1",
    async run() {
      observed.live = projectHasLiveLease(configDir, project);
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

test("a standalone run holds one host slot around the container's life so projectHasLiveLease sees it (design §3 step 1, §8)", async () => {
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

  assert.equal(observed.live, true, "the project holds a live lease while the container runs");
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

  assert.equal(observed.live, false, "a child never registers a second lease beside its parent's");
  assert.deepEqual(readLeases(configDir), [], "no lease is left behind");
});
