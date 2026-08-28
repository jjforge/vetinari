import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { Sandbox, SandboxRunOptions, SandboxRunResult } from "./sandbox.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { listOutbox, listParked } from "./state.ts";
import { BLOCKED, DONE, extractTurnSummary, runLoop, type LoopDeps } from "./loop.ts";

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

test("runLoop parks (blocked) when a turn emits the BLOCKED signal", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([
    { run: { completionSignal: BLOCKED, stdout: "<question><summary>Which base?</summary></question>" } },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "blocked");
  assert.match(parked[0].question, /Which base\?/);
});

test("runLoop parks (no-commit) when the gate passes but the branch has no commit beyond base", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx, { commitsAhead: () => 0 })));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "no-commit");
  // The empty-green guard fired — no green event, no success outbound.
  assert.equal(readEventLog(cfg).some((e) => e.event === "green"), false);
});

test("runLoop returns green when the gate passes on a real change", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ run: { completionSignal: DONE, commits: [{ sha: "abc123" }] }, green: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx)));

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

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx, { commitsAhead: () => null })));

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

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx)));

  assert.equal(outcome, "green");
  // The second run is a resume of turn 0's session — the same path park→answer uses.
  assert.equal(sbx.runCalls.length, 2);
  assert.equal(sbx.runCalls[1].resumeSession, "sess-0");
});

test("runLoop parks (budget) when every turn stays red through maxTurns", async () => {
  const cfg = harnessCfg({ maxTurns: 2 });
  const sbx = fakeSandbox([
    { run: { completionSignal: DONE }, green: false },
    { run: { completionSignal: DONE }, green: false },
  ]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "budget");
});

test("runLoop parks (idle-timeout) when the agent dies on an Idle-named error", async () => {
  const cfg = harnessCfg();
  const sbx = fakeSandbox([{ throwIdle: true }]);

  const outcome = await silence(() => runLoop(cfg, "T-1", undefined, depsFor(sbx)));

  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "idle-timeout");
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
    runLoop(cfg, "T-1", { resumeSessionId: "prev-sess", answerPrompt: "the human's answer" }, depsFor(sbx)),
  );

  assert.equal(outcome, "green");
  // The answer path resumes the human-answered session; it never fetches the task.
  assert.equal(fetched, 0);
  assert.equal(sbx.runCalls[0].resumeSession, "prev-sess");
  assert.equal(sbx.runCalls[0].prompt, "the human's answer");
});
