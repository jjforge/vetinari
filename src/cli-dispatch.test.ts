import test from "node:test";
import assert from "node:assert/strict";
import { dispatch, parseArgs, type Command, type DispatchDeps } from "./cli-dispatch.ts";

// A spy that records each call's arguments and returns a canned value.
function spy<T>(ret?: T) {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return ret as T;
  };
  return Object.assign(fn, { calls });
}

// A DispatchDeps whose every handler is a spy, so a routing test asserts on captured
// calls with no real spawn. `overrides` swaps in a return value or a throwing stub.
function makeDeps(overrides: Partial<DispatchDeps> = {}) {
  const logged: string[] = [];
  const exitCodes: number[] = [];
  const cfg = {
    stateDir: ".vetinari.local",
    listByLabel: () => [],
    log: { log: spy() },
    postComment: spy(Promise.resolve()),
  } as unknown as DispatchDeps["cfg"];
  const deps: DispatchDeps = {
    cfg,
    host: {} as DispatchDeps["host"],
    isTTY: false,
    log: (m: string) => logged.push(m),
    setExitCode: (c: number) => exitCodes.push(c),
    selectAgent: spy(),
    archiveLeftoverRun: spy(),
    archiveIfIdle: spy(),
    askUnderspecified: spy("drop") as unknown as DispatchDeps["askUnderspecified"],
    build: spy(Promise.resolve(true)) as unknown as DispatchDeps["build"],
    baseline: spy(Promise.resolve(true)) as unknown as DispatchDeps["baseline"],
    runLoop: spy(Promise.resolve("green")) as unknown as DispatchDeps["runLoop"],
    campaign: spy(Promise.resolve(true)) as unknown as DispatchDeps["campaign"],
    expandSelection: spy(Promise.resolve([])) as unknown as DispatchDeps["expandSelection"],
    runCampaignPlan: spy(Promise.resolve({ waves: [], waveArgs: "", report: "", suggestedName: "" })) as unknown as DispatchDeps["runCampaignPlan"],
    runPrune: spy(Promise.resolve({ mode: "prune", target: "436", dropped: [], kept: [], remaining: [], parkedDropped: [] })) as unknown as DispatchDeps["runPrune"],
    runGraft: spy(Promise.resolve({ ids: [], rejected: [], placement: [], remaining: [], applied: true })) as unknown as DispatchDeps["runGraft"],
    listParked: spy([]) as unknown as DispatchDeps["listParked"],
    readParked: spy({ sessionId: "sess", question: "q?" }) as unknown as DispatchDeps["readParked"],
    readEventLog: spy([]) as unknown as DispatchDeps["readEventLog"],
    archiveRun: spy({ archivedLog: null, clearedParked: 0, clearedOutbound: 0 }) as unknown as DispatchDeps["archiveRun"],
    agentSelectionFor: spy({ resumable: true }) as unknown as DispatchDeps["agentSelectionFor"],
    requireTelegram: spy({}) as unknown as DispatchDeps["requireTelegram"],
    tgTest: spy(Promise.resolve()) as unknown as DispatchDeps["tgTest"],
    ...overrides,
  };
  return { deps, logged, exitCodes, cfg };
}

test("parseArgs maps `build` to a build command that baselines by default", () => {
  assert.deepEqual(parseArgs(["build"]), { kind: "build", baseline: true });
});

test("parseArgs maps `build --no-baseline` to a build command that skips the baseline", () => {
  assert.deepEqual(parseArgs(["build", "--no-baseline"]), {
    kind: "build",
    baseline: false,
  });
});

test("parseArgs maps the no-argument modes to their bare command", () => {
  assert.deepEqual(parseArgs(["baseline"]), { kind: "baseline" });
  assert.deepEqual(parseArgs(["parked"]), { kind: "parked" });
  assert.deepEqual(parseArgs(["clear"]), { kind: "clear" });
  assert.deepEqual(parseArgs(["tg-test"]), { kind: "tgTest" });
});

test("parseArgs maps an unknown mode, and no mode at all, to usage", () => {
  assert.deepEqual(parseArgs(["wat"]), { kind: "usage" });
  assert.deepEqual(parseArgs([]), { kind: "usage" });
});

test("parseArgs pulls the agent override out of `run`, leaving the task id as the positional", () => {
  assert.deepEqual(parseArgs(["run", "436", "--agent", "codex", "--effort", "high"]), {
    kind: "run",
    agent: { provider: "codex", effort: "high" },
    args: ["436"],
  });
});

test("parseArgs maps `run` with no task id to a run command with empty args (dispatch throws the message)", () => {
  assert.deepEqual(parseArgs(["run"]), { kind: "run", agent: {}, args: [] });
});

test("parseArgs splits `graft` ids on whitespace/commas and reads --dry-run", () => {
  assert.deepEqual(parseArgs(["graft", "436,611", "640", "--dry-run"]), {
    kind: "graft",
    ids: ["436", "611", "640"],
    dryRun: true,
  });
});

test("parseArgs maps `answer` to its task id and the answer text tail", () => {
  assert.deepEqual(parseArgs(["answer", "436", "looks", "good"]), {
    kind: "answer",
    taskId: "436",
    text: ["looks", "good"],
  });
});

test("parseArgs maps a bare `prune <issue>` to a prune of that target", () => {
  assert.deepEqual(parseArgs(["prune", "436"]), {
    kind: "prune",
    target: "436",
    dryRun: false,
    purge: false,
  });
});

test("parseArgs reads `prune` flags and ignores a retired batch tail — only the issue is the target", () => {
  assert.deepEqual(parseArgs(["prune", "436", "611 640", "623", "--dry-run", "--purge"]), {
    kind: "prune",
    target: "436",
    dryRun: true,
    purge: true,
  });
});

test("parseArgs maps a plain `campaign <ids>` to its positional selection with default flags", () => {
  assert.deepEqual(parseArgs(["campaign", "436", "ready-for-agent"]), {
    kind: "campaign",
    agent: {},
    positional: ["436", "ready-for-agent"],
    name: undefined,
    autoPrune: false,
    resume: false,
    dryRun: false,
    override: false,
    onUnderspecified: undefined,
  });
});

test("parseArgs strips the agent and reads every `campaign` flag (both --flag value and --flag= forms)", () => {
  assert.deepEqual(
    parseArgs([
      "campaign",
      "--agent",
      "codex",
      "436",
      "--name=big run",
      "--auto-prune",
      "--dry-run",
      "--override",
      "--on-underspecified",
      "drop",
    ]),
    {
      kind: "campaign",
      agent: { provider: "codex" },
      positional: ["436"],
      name: "big run",
      autoPrune: true,
      resume: false,
      dryRun: true,
      override: true,
      onUnderspecified: "drop",
    },
  );
});

test("parseArgs maps a bare `redrive` to a redrive command with default flags", () => {
  assert.deepEqual(parseArgs(["redrive"]), {
    kind: "redrive",
    agent: {},
    autoPrune: false,
    override: false,
  });
});

test("parseArgs strips the agent and reads redrive's --override/--auto-prune flags", () => {
  assert.deepEqual(parseArgs(["redrive", "--agent", "codex", "--override", "--auto-prune"]), {
    kind: "redrive",
    agent: { provider: "codex" },
    autoPrune: true,
    override: true,
  });
});

test("parseArgs maps `campaign --resume` to a resume with no positional selection", () => {
  assert.deepEqual(parseArgs(["campaign", "--resume"]), {
    kind: "campaign",
    agent: {},
    positional: [],
    name: undefined,
    autoPrune: false,
    resume: true,
    dryRun: false,
    override: false,
    onUnderspecified: undefined,
  });
});

test("dispatch build routes to build with the parsed baseline flag and maps success to exit 0", async () => {
  const { deps, exitCodes } = makeDeps();
  await dispatch({ kind: "build", baseline: false }, deps);
  assert.deepEqual((deps.build as any).calls, [[deps.cfg, { baseline: false }]]);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch build maps a failed build to exit 1", async () => {
  const { deps, exitCodes } = makeDeps({
    build: spy(Promise.resolve(false)) as any,
  });
  await dispatch({ kind: "build", baseline: true }, deps);
  assert.deepEqual(exitCodes, [1]);
});

test("dispatch baseline routes to baseline and maps success to exit 0", async () => {
  const { deps, exitCodes } = makeDeps();
  await dispatch({ kind: "baseline" }, deps);
  assert.deepEqual((deps.baseline as any).calls, [[deps.cfg]]);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch parked lists parked records", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "parked" }, deps);
  assert.deepEqual((deps.listParked as any).calls, [[deps.cfg]]);
});

test("dispatch clear archives the run and reports the reset", async () => {
  const { deps, logged } = makeDeps();
  await dispatch({ kind: "clear" }, deps);
  assert.deepEqual((deps.archiveRun as any).calls, [[deps.cfg]]);
  assert.ok(logged.some((l) => /cleared/.test(l)));
});

test("dispatch tg-test resolves creds and proves the round-trip", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "tgTest" }, deps);
  assert.equal((deps.requireTelegram as any).calls.length, 1);
  assert.equal((deps.tgTest as any).calls.length, 1);
});

test("dispatch usage prints the usage and exits non-zero", async () => {
  const { deps, logged, exitCodes } = makeDeps();
  await dispatch({ kind: "usage" }, deps);
  assert.ok(logged.length >= 1);
  assert.deepEqual(exitCodes, [1]);
});

test("dispatch run selects the agent, archives the leftover, runs the loop, maps green to exit 0", async () => {
  const { deps, exitCodes } = makeDeps();
  await dispatch({ kind: "run", agent: { provider: "codex" }, args: ["436"] }, deps);
  assert.deepEqual((deps.selectAgent as any).calls, [[deps.cfg, { provider: "codex" }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 1);
  assert.deepEqual((deps.runLoop as any).calls, [[deps.cfg, "436"]]);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch run maps a parked outcome to the queue's parked exit code 2", async () => {
  const { deps, exitCodes } = makeDeps({
    runLoop: spy(Promise.resolve("parked")) as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"] }, deps);
  assert.deepEqual(exitCodes, [2]);
});

test("dispatch run with no task id throws the same message the old switch threw, after agent select", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch({ kind: "run", agent: {}, args: [] }, deps),
    /run needs a task id/,
  );
  assert.equal((deps.selectAgent as any).calls.length, 1);
  assert.equal((deps.runLoop as any).calls.length, 0);
});

test("dispatch campaign --resume runs a resume with no selection and never archives a leftover", async () => {
  const { deps } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: "r", autoPrune: true, resume: true, dryRun: false, override: false, onUnderspecified: undefined },
    deps,
  );
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [], deps.host, "r", { autoPrune: true, resume: true, override: false }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 0);
  assert.equal((deps.archiveIfIdle as any).calls.length, 1);
});

test("dispatch campaign --resume --override forwards the failed-member override to the redrive", async () => {
  const { deps } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: true, dryRun: false, override: true, onUnderspecified: undefined },
    deps,
  );
  assert.deepEqual((deps.campaign as any).calls[0][4], { autoPrune: false, resume: true, override: true });
});

test("dispatch redrive selects the agent, redrives the campaign from the log, and archives if idle", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "redrive", agent: { provider: "codex" }, autoPrune: false, override: false }, deps);
  assert.deepEqual((deps.selectAgent as any).calls, [[deps.cfg, { provider: "codex" }]]);
  // Redrive takes no selection and continues the live log — no leftover archive, resume=true.
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [], deps.host, undefined, { autoPrune: false, resume: true, override: false }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 0);
  assert.equal((deps.archiveIfIdle as any).calls.length, 1);
});

test("dispatch redrive --override forwards the failed-member override", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "redrive", agent: {}, autoPrune: false, override: true }, deps);
  assert.deepEqual((deps.campaign as any).calls[0][4], { autoPrune: false, resume: true, override: true });
});

test("dispatch campaign --resume still redrives but prints the one-release alias notice pointing at redrive", async () => {
  const { deps, logged } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: true, dryRun: false, override: false, onUnderspecified: undefined },
    deps,
  );
  assert.equal((deps.campaign as any).calls.length, 1);
  assert.ok(logged.some((l) => /campaign --resume/.test(l) && /redrive/.test(l)), "prints the alias notice");
});

test("dispatch campaign with an empty selection throws the needs-an-issue message", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch(
      { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: undefined },
      deps,
    ),
    /campaign needs at least one issue id or label/,
  );
});

test("dispatch campaign --override runs each positional as a literal wave via expandSelection", async () => {
  const { deps } = makeDeps({
    expandSelection: spy(Promise.resolve(["436", "611"])) as any,
  });
  await dispatch(
    { kind: "campaign", agent: {}, positional: ["436 611"], name: undefined, autoPrune: false, resume: false, dryRun: false, override: true, onUnderspecified: undefined },
    deps,
  );
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [["436", "611"]], deps.host, undefined, { autoPrune: false }]]);
  assert.equal((deps.runCampaignPlan as any).calls.length, 0);
});

test("dispatch campaign default plans the selection then runs the planned waves", async () => {
  const { deps } = makeDeps({
    expandSelection: spy(Promise.resolve(["436"])) as any,
    runCampaignPlan: spy(Promise.resolve({ waves: [["436"]], waveArgs: '"436"', report: "the plan", suggestedName: "" })) as any,
  });
  await dispatch(
    { kind: "campaign", agent: {}, positional: ["436"], name: "n", autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: "drop" },
    deps,
  );
  assert.equal((deps.runCampaignPlan as any).calls.length, 1);
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [["436"]], deps.host, "n", { autoPrune: false }]]);
});

test("dispatch campaign --dry-run plans but runs nothing", async () => {
  const { deps } = makeDeps({
    expandSelection: spy(Promise.resolve(["436"])) as any,
    runCampaignPlan: spy(Promise.resolve({ waves: [["436"]], waveArgs: '"436"', report: "the plan", suggestedName: "big" })) as any,
  });
  await dispatch(
    { kind: "campaign", agent: {}, positional: ["436"], name: undefined, autoPrune: false, resume: false, dryRun: true, override: false, onUnderspecified: undefined },
    deps,
  );
  assert.equal((deps.runCampaignPlan as any).calls.length, 1);
  assert.equal((deps.campaign as any).calls.length, 0);
});

test("dispatch prune routes to runPrune with the parsed target and flags", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "prune", target: "436", dryRun: true, purge: false }, deps);
  assert.deepEqual((deps.runPrune as any).calls, [[deps.cfg, "436", { dryRun: true, purge: false, host: deps.host }]]);
});

test("dispatch graft routes to runGraft with the parsed ids and flag", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "graft", ids: ["436", "611"], dryRun: false }, deps);
  assert.deepEqual((deps.runGraft as any).calls, [[deps.cfg, ["436", "611"], { dryRun: false }]]);
});

test("dispatch answer resumes the parked session for a resumable agent and maps green to exit 0", async () => {
  const { deps, exitCodes } = makeDeps();
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.equal((deps.readParked as any).calls.length, 1);
  assert.equal((deps.runLoop as any).calls.length, 1);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch answer posts a comment and re-enters fresh for a non-resumable agent", async () => {
  const { deps, cfg } = makeDeps({
    agentSelectionFor: spy({ resumable: false }) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.equal(((cfg as any).postComment as any).calls.length, 1);
  assert.equal((deps.runLoop as any).calls.length, 1);
});

// A paused campaign's event log where issue 436 (its only member) parked then, after the
// answer, ran to green — the wave never closed, so a redrive still has work to land.
const pausedCampaignAfterGreen = () => [
  { event: "campaign-start", waves: [["436"]] },
  { event: "wave-start", index: 0, tasks: ["436"] },
  { event: "parked", taskId: "436", reason: "question" },
  { event: "campaign-parked", index: 0, detail: "parked: 436" },
  { event: "green", taskId: "436", branch: "agent/436" },
];

test("dispatch answer redrives the paused campaign after a green answer (ADR 0020)", async () => {
  const { deps } = makeDeps({
    readEventLog: spy(pausedCampaignAfterGreen()) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  // The green answer continued the campaign by itself: a resume redrive was launched.
  assert.equal((deps.campaign as any).calls.length, 1);
  assert.deepEqual((deps.campaign as any).calls[0][4], { resume: true });
});

test("dispatch answer does not redrive a standalone parked issue with no campaign", async () => {
  const { deps, exitCodes } = makeDeps(); // default readEventLog → [] (no campaign started)
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.equal((deps.campaign as any).calls.length, 0);
  assert.deepEqual(exitCodes, [0]); // the standalone green answer still exits 0
});

test("dispatch answer that parks again does not redrive", async () => {
  const { deps, exitCodes } = makeDeps({
    runLoop: spy(Promise.resolve("parked")) as any,
    readEventLog: spy(pausedCampaignAfterGreen()) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  // A second park is not a green, so nothing is redriven; the exit code says parked.
  assert.equal((deps.campaign as any).calls.length, 0);
  assert.deepEqual(exitCodes, [2]);
});

test("dispatch answer with no text throws the needs-a-task-id-and-text message", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch({ kind: "answer", taskId: "436", text: [] }, deps),
    /answer needs a task id and text/,
  );
});
