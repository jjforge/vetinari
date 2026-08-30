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
    project: "demo",
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
    campaign: spy(Promise.resolve("done")) as unknown as DispatchDeps["campaign"],
    expandSelection: spy(Promise.resolve([])) as unknown as DispatchDeps["expandSelection"],
    runCampaignPlan: spy(Promise.resolve({ waves: [], waveArgs: "", report: "", suggestedName: "" })) as unknown as DispatchDeps["runCampaignPlan"],
    runPrune: spy(Promise.resolve({ mode: "prune", target: "436", dropped: [], kept: [], remaining: [], parkedDropped: [] })) as unknown as DispatchDeps["runPrune"],
    runGraft: spy(Promise.resolve({ ids: [], rejected: [], placement: [], remaining: [], applied: true })) as unknown as DispatchDeps["runGraft"],
    listParked: spy([]) as unknown as DispatchDeps["listParked"],
    hasParked: spy(true) as unknown as DispatchDeps["hasParked"],
    answerParked: spy() as unknown as DispatchDeps["answerParked"],
    projectHasLiveLease: spy(false) as unknown as DispatchDeps["projectHasLiveLease"],
    readEventLog: spy([]) as unknown as DispatchDeps["readEventLog"],
    archiveRun: spy({ archivedLog: null, clearedOutbound: 0 }) as unknown as DispatchDeps["archiveRun"],
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
    json: false,
  });
});

test("parseArgs maps `run` with no task id to a run command with empty args (dispatch throws the message)", () => {
  assert.deepEqual(parseArgs(["run"]), { kind: "run", agent: {}, args: [], json: false });
});

test("parseArgs reads `run --json` and keeps the task id as the surviving positional (#299)", () => {
  assert.deepEqual(parseArgs(["run", "436", "--json"]), {
    kind: "run",
    agent: {},
    args: ["436"],
    json: true,
  });
});

test("parseArgs splits `graft` ids on whitespace/commas and reads --dry-run", () => {
  assert.deepEqual(parseArgs(["graft", "436,611", "640", "--dry-run"]), {
    kind: "graft",
    ids: ["436", "611", "640"],
    dryRun: true,
    json: false,
  });
});

test("parseArgs reads graft --json and keeps it out of the ids", () => {
  assert.deepEqual(parseArgs(["graft", "436", "--dry-run", "--json"]), {
    kind: "graft",
    ids: ["436"],
    dryRun: true,
    json: true,
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
    json: false,
  });
});

test("parseArgs reads prune --json and keeps it out of the target", () => {
  assert.deepEqual(parseArgs(["prune", "436", "--dry-run", "--json"]), {
    kind: "prune",
    target: "436",
    dryRun: true,
    purge: false,
    json: true,
  });
});

test("parseArgs reads `prune` flags and ignores a retired batch tail — only the issue is the target", () => {
  assert.deepEqual(parseArgs(["prune", "436", "611 640", "623", "--dry-run", "--purge"]), {
    kind: "prune",
    target: "436",
    dryRun: true,
    purge: true,
    json: false,
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
    json: false,
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
      "--json",
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
      json: true,
    },
  );
});

test("parseArgs maps a bare `redrive` to a redrive command with default flags", () => {
  assert.deepEqual(parseArgs(["redrive"]), {
    kind: "redrive",
    agent: {},
    autoPrune: false,
    override: false,
    json: false,
  });
});

test("parseArgs strips the agent and reads redrive's --override/--auto-prune/--json flags", () => {
  assert.deepEqual(parseArgs(["redrive", "--agent", "codex", "--override", "--auto-prune", "--json"]), {
    kind: "redrive",
    agent: { provider: "codex" },
    autoPrune: true,
    override: true,
    json: true,
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
    json: false,
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
  // The reset is reported; parked records are kept (design §2.5), so the line says so.
  assert.ok(logged.some((l) => /reset/.test(l) && /parked records are kept/.test(l)));
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
  await dispatch({ kind: "run", agent: { provider: "codex" }, args: ["436"], json: false }, deps);
  assert.deepEqual((deps.selectAgent as any).calls, [[deps.cfg, { provider: "codex" }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 1);
  assert.deepEqual((deps.runLoop as any).calls, [[deps.cfg, "436"]]);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch run maps a parked outcome to the queue's parked exit code 2", async () => {
  const { deps, exitCodes } = makeDeps({
    runLoop: spy(Promise.resolve("parked")) as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  assert.deepEqual(exitCodes, [2]);
});

test("dispatch run maps a failed outcome to exit 1 (run distinguishes failed)", async () => {
  const { deps, exitCodes } = makeDeps({
    runLoop: spy(Promise.resolve("failed")) as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  assert.deepEqual(exitCodes, [1]);
});

// The campaign/redrive exit codes follow the outcome the loop returns (design §5 step 6,
// §15): 0 only for `done`, 2 for `parked`, 1 for `failed` — no exit-code logic in modes.ts.
for (const [outcome, code] of [["done", 0], ["parked", 2], ["failed", 1]] as const) {
  test(`dispatch campaign exits ${code} on a ${outcome} campaign`, async () => {
    const { deps, exitCodes } = makeDeps({
      expandSelection: spy(Promise.resolve(["436"])) as any,
      runCampaignPlan: spy(Promise.resolve({ waves: [["436"]], waveArgs: '"436"', report: "the plan", suggestedName: "" })) as any,
      campaign: spy(Promise.resolve(outcome)) as any,
    });
    await dispatch(
      { kind: "campaign", agent: {}, positional: ["436"], name: undefined, autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: undefined, json: false },
      deps,
    );
    assert.deepEqual(exitCodes, [code]);
  });

  test(`dispatch campaign --resume exits ${code} on a ${outcome} campaign`, async () => {
    const { deps, exitCodes } = makeDeps({
      campaign: spy(Promise.resolve(outcome)) as any,
    });
    await dispatch(
      { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: true, dryRun: false, override: false, onUnderspecified: undefined, json: false },
      deps,
    );
    assert.deepEqual(exitCodes, [code]);
  });

  test(`dispatch redrive exits ${code} on a ${outcome} campaign`, async () => {
    const { deps, exitCodes } = makeDeps({
      campaign: spy(Promise.resolve(outcome)) as any,
    });
    await dispatch({ kind: "redrive", agent: {}, autoPrune: false, override: false, json: false }, deps);
    assert.deepEqual(exitCodes, [code]);
  });

  test(`dispatch answer's implicit redrive exits ${code} on a ${outcome} campaign`, async () => {
    const { deps, exitCodes } = makeDeps({
      readEventLog: spy(pausedCampaignAfterGreen()) as any,
      campaign: spy(Promise.resolve(outcome)) as any,
    });
    await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
    assert.deepEqual(exitCodes, [code]);
  });
}

test("dispatch run with no task id throws the same message the old switch threw, after agent select", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch({ kind: "run", agent: {}, args: [], json: false }, deps),
    /run needs a task id/,
  );
  assert.equal((deps.selectAgent as any).calls.length, 1);
  assert.equal((deps.runLoop as any).calls.length, 0);
});

test("dispatch campaign --resume runs a resume with no selection and never archives a leftover", async () => {
  const { deps } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: "r", autoPrune: true, resume: true, dryRun: false, override: false, onUnderspecified: undefined, json: false },
    deps,
  );
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [], deps.host, "r", { autoPrune: true, resume: true, override: false }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 0);
  assert.equal((deps.archiveIfIdle as any).calls.length, 1);
});

test("dispatch campaign --resume --override forwards the failed-member override to the redrive", async () => {
  const { deps } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: true, dryRun: false, override: true, onUnderspecified: undefined, json: false },
    deps,
  );
  assert.deepEqual((deps.campaign as any).calls[0][4], { autoPrune: false, resume: true, override: true });
});

test("dispatch redrive selects the agent, redrives the campaign from the log, and archives if idle", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "redrive", agent: { provider: "codex" }, autoPrune: false, override: false, json: false }, deps);
  assert.deepEqual((deps.selectAgent as any).calls, [[deps.cfg, { provider: "codex" }]]);
  // Redrive takes no selection and continues the live log — no leftover archive, resume=true.
  assert.deepEqual((deps.campaign as any).calls, [[deps.cfg, [], deps.host, undefined, { autoPrune: false, resume: true, override: false }]]);
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 0);
  assert.equal((deps.archiveIfIdle as any).calls.length, 1);
});

test("dispatch redrive refuses with one line when a campaign lease for the project is live (§7)", async () => {
  const { deps, logged } = makeDeps({
    projectHasLiveLease: spy(true) as any,
  });
  await dispatch({ kind: "redrive", agent: {}, autoPrune: false, override: false, json: false }, deps);
  assert.equal((deps.campaign as any).calls.length, 0, "no second process redrives over a live campaign");
  assert.equal((deps.archiveIfIdle as any).calls.length, 0);
  assert.ok(logged.some((l) => /live|running|campaign/i.test(l)), "it says why it refused");
});

test("dispatch redrive --override forwards the failed-member override", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "redrive", agent: {}, autoPrune: false, override: true, json: false }, deps);
  assert.deepEqual((deps.campaign as any).calls[0][4], { autoPrune: false, resume: true, override: true });
});

test("dispatch campaign --resume still redrives but prints the one-release alias notice pointing at redrive", async () => {
  const { deps, logged } = makeDeps();
  await dispatch(
    { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: true, dryRun: false, override: false, onUnderspecified: undefined, json: false },
    deps,
  );
  assert.equal((deps.campaign as any).calls.length, 1);
  assert.ok(logged.some((l) => /campaign --resume/.test(l) && /redrive/.test(l)), "prints the alias notice");
});

test("dispatch campaign with an empty selection throws the needs-an-issue message", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch(
      { kind: "campaign", agent: {}, positional: [], name: undefined, autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: undefined, json: false },
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
    { kind: "campaign", agent: {}, positional: ["436 611"], name: undefined, autoPrune: false, resume: false, dryRun: false, override: true, onUnderspecified: undefined, json: false },
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
    { kind: "campaign", agent: {}, positional: ["436"], name: "n", autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: "drop", json: false },
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
    { kind: "campaign", agent: {}, positional: ["436"], name: undefined, autoPrune: false, resume: false, dryRun: true, override: false, onUnderspecified: undefined, json: false },
    deps,
  );
  assert.equal((deps.runCampaignPlan as any).calls.length, 1);
  assert.equal((deps.campaign as any).calls.length, 0);
});

test("dispatch campaign default prints the plan provenance and streams no JSON without --json (#299)", async () => {
  const { deps, logged } = makeDeps({
    expandSelection: spy(Promise.resolve(["436"])) as any,
    runCampaignPlan: spy(Promise.resolve({ waves: [["436"]], waveArgs: '"436"', report: "the plan", suggestedName: "" })) as any,
  });
  const prev = process.env.VETINARI_JSON;
  delete process.env.VETINARI_JSON;
  await dispatch(
    { kind: "campaign", agent: {}, positional: ["436"], name: "n", autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: undefined, json: false },
    deps,
  );
  const json = process.env.VETINARI_JSON;
  if (prev === undefined) delete process.env.VETINARI_JSON;
  else process.env.VETINARI_JSON = prev;
  assert.ok(logged.includes("the plan"), "prints the plan provenance");
  assert.notEqual(json, "1", "does not switch on the JSON event stream");
});

test("dispatch campaign --json switches on the raw event stream and suppresses the plan provenance (#299)", async () => {
  const { deps, logged } = makeDeps({
    expandSelection: spy(Promise.resolve(["436"])) as any,
    runCampaignPlan: spy(Promise.resolve({ waves: [["436"]], waveArgs: '"436"', report: "the plan", suggestedName: "" })) as any,
  });
  const prev = process.env.VETINARI_JSON;
  delete process.env.VETINARI_JSON;
  await dispatch(
    { kind: "campaign", agent: {}, positional: ["436"], name: "n", autoPrune: false, resume: false, dryRun: false, override: false, onUnderspecified: undefined, json: true },
    deps,
  );
  const json = process.env.VETINARI_JSON;
  if (prev === undefined) delete process.env.VETINARI_JSON;
  else process.env.VETINARI_JSON = prev;
  assert.equal(json, "1", "sets VETINARI_JSON so the run logger streams raw events to stdout");
  assert.ok(!logged.includes("the plan"), "the human plan provenance is suppressed under --json");
});

test("dispatch run --json switches on the raw event stream for the single loop (#299)", async () => {
  const { deps } = makeDeps();
  const prev = process.env.VETINARI_JSON;
  delete process.env.VETINARI_JSON;
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: true }, deps);
  const json = process.env.VETINARI_JSON;
  if (prev === undefined) delete process.env.VETINARI_JSON;
  else process.env.VETINARI_JSON = prev;
  assert.equal(json, "1");
});

test("dispatch prune routes to runPrune with the parsed target and flags", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "prune", target: "436", dryRun: true, purge: false, json: false }, deps);
  assert.deepEqual((deps.runPrune as any).calls, [[deps.cfg, "436", { dryRun: true, purge: false, host: deps.host }]]);
});

test("dispatch graft routes to runGraft with the parsed ids and flag", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "graft", ids: ["436", "611"], dryRun: false, json: false }, deps);
  assert.deepEqual((deps.runGraft as any).calls, [[deps.cfg, ["436", "611"], { dryRun: false }]]);
});

// No JSON reaches stdout without `--json` (design §11): a `--dry-run` closure emits its
// machine `prune-closure`/`graft-closure {json}` line only under `--json`; the dashboard
// preview shells pass it. The human prose stays either way.
test("dispatch prune --dry-run emits the machine closure line only under --json", async () => {
  const withClosure = {
    mode: "prune", target: "436", dropped: [], kept: [], remaining: [], parkedDropped: [],
    closure: { target: "436", dropped: [], keptBanked: [], remaining: [] },
  };
  const noJson = makeDeps({ runPrune: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "prune", target: "436", dryRun: true, purge: false, json: false }, noJson.deps);
  assert.ok(!noJson.logged.some((l) => l.startsWith("prune-closure")), "no closure JSON without --json");

  const withJson = makeDeps({ runPrune: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "prune", target: "436", dryRun: true, purge: false, json: true }, withJson.deps);
  assert.ok(withJson.logged.some((l) => l.startsWith("prune-closure ")), "closure JSON under --json");
});

test("dispatch graft --dry-run emits the machine closure line only under --json", async () => {
  const withClosure = {
    ids: ["436"], rejected: [], placement: [], remaining: [], applied: false,
    closure: { ids: ["436"], placement: [], remaining: [], rejected: [] },
  };
  const noJson = makeDeps({ runGraft: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "graft", ids: ["436"], dryRun: true, json: false }, noJson.deps);
  assert.ok(!noJson.logged.some((l) => l.startsWith("graft-closure")), "no closure JSON without --json");

  const withJson = makeDeps({ runGraft: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "graft", ids: ["436"], dryRun: true, json: true }, withJson.deps);
  assert.ok(withJson.logged.some((l) => l.startsWith("graft-closure ")), "closure JSON under --json");
});

// A paused campaign's event log where issue 436 (its only member) parked — the wave never
// closed, so a redrive still has work to land once the answer re-admits it.
const pausedCampaignAfterGreen = () => [
  { event: "campaign-start", waves: [["436"]] },
  { event: "wave-start", index: 0, tasks: ["436"] },
  { event: "parked", taskId: "436", reason: "question" },
  { event: "campaign-parked", index: 0, detail: "parked: 436" },
];

test("dispatch answer on an unparked issue reports it and exits 0 — never runs or redrives (§7)", async () => {
  const { deps, logged, exitCodes } = makeDeps({
    hasParked: spy(false) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.equal((deps.answerParked as any).calls.length, 0, "nothing to deliver to");
  assert.equal((deps.runLoop as any).calls.length, 0, "an unparked issue never runs");
  assert.equal((deps.campaign as any).calls.length, 0, "an unparked issue never redrives");
  assert.ok(logged.some((l) => /not parked/i.test(l)), "the report names it not parked");
  assert.deepEqual(exitCodes, []); // exit stays 0
});

test("dispatch answer delivers to the record and, with a live campaign lease, stops there — no run, no redrive (§5 step 3, §8)", async () => {
  const { deps } = makeDeps({
    projectHasLiveLease: spy(true) as any,
    readEventLog: spy(pausedCampaignAfterGreen()) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.deepEqual((deps.answerParked as any).calls, [[deps.cfg, "436", "ok"]], "the answer is written into the record");
  assert.equal((deps.runLoop as any).calls.length, 0, "the live campaign re-admits — the answer never runs the loop itself");
  assert.equal((deps.campaign as any).calls.length, 0, "no second process redrives over a live campaign");
});

test("dispatch answer delivers then redrives the paused campaign when no campaign is live (§5 step 3, §7)", async () => {
  const { deps } = makeDeps({
    readEventLog: spy(pausedCampaignAfterGreen()) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.deepEqual((deps.answerParked as any).calls, [[deps.cfg, "436", "ok"]], "the answer is delivered first");
  // No live campaign: a resume redrive re-admits the answered member (which consumes the answer).
  assert.equal((deps.runLoop as any).calls.length, 0, "the answer delivers — the redrive runs the member");
  assert.equal((deps.campaign as any).calls.length, 1);
  assert.deepEqual((deps.campaign as any).calls[0][4], { resume: true });
  assert.equal((deps.archiveIfIdle as any).calls.length, 1, "the answer→redrive path archives once idle");
});

test("dispatch answer redrive refuses to start while a campaign lease is live (§7)", async () => {
  const { deps } = makeDeps({
    projectHasLiveLease: spy(true) as any,
    readEventLog: spy(pausedCampaignAfterGreen()) as any,
  });
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.equal((deps.campaign as any).calls.length, 0, "the live lease blocks the answer's redrive");
});

test("dispatch answer for a standalone park (no campaign) delivers then runs the loop, exiting on its verdict", async () => {
  const { deps, exitCodes } = makeDeps(); // default readEventLog → [] (no campaign started)
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  assert.deepEqual((deps.answerParked as any).calls, [[deps.cfg, "436", "ok"]]);
  assert.equal((deps.campaign as any).calls.length, 0, "a standalone park never redrives");
  assert.deepEqual((deps.runLoop as any).calls, [[deps.cfg, "436"]], "the run consumes the answered record");
  assert.deepEqual(exitCodes, [0]); // the standalone green answer exits 0
});

test("dispatch answer with no text throws the needs-a-task-id-and-text message", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch({ kind: "answer", taskId: "436", text: [] }, deps),
    /answer needs a task id and text/,
  );
});
