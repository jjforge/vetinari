import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, identityLine, parseArgs, type Command, type DispatchDeps } from "./cli-dispatch.ts";
import { projectHasLiveCampaign, registerProject } from "./host-slots.ts";
import { GraftRejectedError } from "./graft.ts";

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
  const errored: string[] = [];
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
    error: (m: string) => errored.push(m),
    setExitCode: (c: number) => exitCodes.push(c),
    selectAgent: spy(),
    isCampaignChild: false,
    archiveLeftoverRun: spy(),
    archiveIfIdle: spy(),
    askUnderspecified: spy("drop") as unknown as DispatchDeps["askUnderspecified"],
    build: spy(Promise.resolve(true)) as unknown as DispatchDeps["build"],
    baseline: spy(Promise.resolve(true)) as unknown as DispatchDeps["baseline"],
    runLoop: spy(Promise.resolve("green")) as unknown as DispatchDeps["runLoop"],
    campaign: spy(Promise.resolve("done")) as unknown as DispatchDeps["campaign"],
    expandSelection: spy(Promise.resolve([])) as unknown as DispatchDeps["expandSelection"],
    runCampaignPlan: spy(Promise.resolve({ waves: [], waveArgs: "", report: "", suggestedName: "" })) as unknown as DispatchDeps["runCampaignPlan"],
    runPrune: spy(Promise.resolve({ mode: "prune", project: "demo", repo: undefined, title: undefined, target: "436", dropped: [], kept: [], remaining: [], parkedDropped: [] })) as unknown as DispatchDeps["runPrune"],
    runGraft: spy(Promise.resolve({ project: "demo", repo: undefined, titles: {}, ids: [], rejected: [], placement: [], remaining: [], applied: true })) as unknown as DispatchDeps["runGraft"],
    listParked: spy([]) as unknown as DispatchDeps["listParked"],
    hasParked: spy(true) as unknown as DispatchDeps["hasParked"],
    answerParked: spy() as unknown as DispatchDeps["answerParked"],
    projectHasLiveCampaign: spy(false) as unknown as DispatchDeps["projectHasLiveCampaign"],
    readEventLog: spy([]) as unknown as DispatchDeps["readEventLog"],
    archiveRun: spy({ archivedLog: null, clearedOutbound: 0 }) as unknown as DispatchDeps["archiveRun"],
    requireTelegram: spy({}) as unknown as DispatchDeps["requireTelegram"],
    tgTest: spy(Promise.resolve()) as unknown as DispatchDeps["tgTest"],
    ask: spy(Promise.resolve("")) as unknown as DispatchDeps["ask"],
    tgSend: spy(Promise.resolve(1)) as unknown as DispatchDeps["tgSend"],
    runTgConnect: spy(Promise.resolve({ ok: true, written: true })) as unknown as DispatchDeps["runTgConnect"],
    ...overrides,
  };
  return { deps, logged, errored, exitCodes, cfg };
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

test("parseArgs maps a bare `tg-connect` to a collect command with default flags", () => {
  assert.deepEqual(parseArgs(["tg-connect"]), {
    kind: "tgConnect",
    token: undefined,
    chat: undefined,
    noVerify: false,
    force: false,
  });
});

test("parseArgs reads tg-connect's --token/--chat (both `--flag value` and `--flag=` forms) and --no-verify/--force", () => {
  assert.deepEqual(parseArgs(["tg-connect", "--token", "T", "--chat=C", "--no-verify", "--force"]), {
    kind: "tgConnect",
    token: "T",
    chat: "C",
    noVerify: true,
    force: true,
  });
  assert.deepEqual(parseArgs(["tg-connect", "--token=T2", "--chat", "C2"]), {
    kind: "tgConnect",
    token: "T2",
    chat: "C2",
    noVerify: false,
    force: false,
  });
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
    project: undefined,
    ids: ["436", "611", "640"],
    dryRun: true,
    json: false,
  });
});

test("parseArgs reads a project qualifier on graft — a leading non-issue token", () => {
  assert.deepEqual(parseArgs(["graft", "vetinari", "436", "611", "--dry-run"]), {
    kind: "graft",
    project: "vetinari",
    ids: ["436", "611"],
    dryRun: true,
    json: false,
  });
});

test("parseArgs reads NO graft qualifier when the leading non-issue token is not followed by an issue token (a malformed batch)", () => {
  // `graft "875" "876" "877"` — every token is a malformed id, not a project. The
  // leading token being non-issue is not enough to read it as a qualifier (prune's
  // rule): the token after it must look like an issue. So all three stay ids and
  // reach validation, where each is rejected as malformed rather than one becoming a
  // bogus project qualifier.
  assert.deepEqual(parseArgs(["graft", '"875"', '"876"', '"877"']), {
    kind: "graft",
    project: undefined,
    ids: ['"875"', '"876"', '"877"'],
    dryRun: false,
    json: false,
  });
});

test("parseArgs reads graft --json and keeps it out of the ids", () => {
  assert.deepEqual(parseArgs(["graft", "436", "--dry-run", "--json"]), {
    kind: "graft",
    project: undefined,
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
    project: undefined,
    target: "436",
    dryRun: false,
    purge: false,
    json: false,
  });
});

test("parseArgs reads a project qualifier on prune — a non-issue token before the issue", () => {
  assert.deepEqual(parseArgs(["prune", "vetinari", "436"]), {
    kind: "prune",
    project: "vetinari",
    target: "436",
    dryRun: false,
    purge: false,
    json: false,
  });
});

test("parseArgs reads prune --json and keeps it out of the target", () => {
  assert.deepEqual(parseArgs(["prune", "436", "--dry-run", "--json"]), {
    kind: "prune",
    project: undefined,
    target: "436",
    dryRun: true,
    purge: false,
    json: true,
  });
});

test("parseArgs reads `prune` flags and ignores a retired batch tail — only the issue is the target", () => {
  assert.deepEqual(parseArgs(["prune", "436", "611 640", "623", "--dry-run", "--purge"]), {
    kind: "prune",
    project: undefined,
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

// A parked record whose question is the XML shape agents emit (prompts/tdd.md): the run
// loop stores the inner <summary>/<detail>/<options><option> verbatim, no outer wrapper.
const xmlParked = {
  taskId: "640",
  parkedAt: "2026-08-22T00:00:00.000Z",
  reason: "question" as const,
  branch: "agent/640",
  question:
    "<summary>Which store?</summary><detail>Redis or Postgres.</detail><options><option>Redis</option><option>Postgres</option></options>",
};

test("dispatch parked renders a parsed summary/detail/options for the XML question form (#384)", async () => {
  const { deps, logged } = makeDeps({
    listParked: spy([xmlParked]) as unknown as DispatchDeps["listParked"],
  });
  await dispatch({ kind: "parked" }, deps);
  const out = logged.join("\n");
  assert.doesNotMatch(out, /<summary>|<detail>|<option>/, "no raw XML tags reach the terminal");
  assert.match(out, /Which store\?/, "summary is shown");
  assert.match(out, /Redis or Postgres\./, "detail is shown");
  assert.match(out, /Redis/, "each option is listed as plain text");
  assert.match(out, /Postgres/);
});

test("dispatch parked leaves the Markdown `options:` form parsed and a non-matching question as its trimmed text (#384)", async () => {
  const mdParked = { ...xmlParked, taskId: "641", question: "Pick a store.\noptions:\n- Redis\n- Postgres" };
  const plainParked = { ...xmlParked, taskId: "642", question: "  Just a plain question, no structure.  " };
  const { deps, logged } = makeDeps({
    listParked: spy([mdParked, plainParked]) as unknown as DispatchDeps["listParked"],
  });
  await dispatch({ kind: "parked" }, deps);
  const out = logged.join("\n");
  assert.match(out, /Pick a store\./);
  assert.match(out, /Redis/);
  assert.match(out, /Postgres/);
  assert.match(out, /Just a plain question, no structure\./, "a non-matching question falls back to its full trimmed text");
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

test("dispatch tg-connect resolves the base location from cfg.stateDir and runs the collector with the parsed opts", async () => {
  const runTgConnect = spy(Promise.resolve({ ok: true, written: true }));
  const { deps, exitCodes } = makeDeps({ runTgConnect: runTgConnect as any });
  await dispatch({ kind: "tgConnect", token: "T", chat: "C", noVerify: false, force: true }, deps);
  assert.equal(runTgConnect.calls.length, 1);
  const [baseLocation, opts, collectorDeps] = runTgConnect.calls[0] as any[];
  // The base location is this project's stateDir resolved against cwd — the same path tg-test uses.
  assert.equal(baseLocation, join(process.cwd(), ".vetinari.local"));
  assert.deepEqual(opts, { token: "T", chat: "C", noVerify: false, force: true });
  // The collector's prompt + verification send + label are wired from dispatch deps.
  assert.equal(typeof collectorDeps.ask, "function");
  assert.equal(typeof collectorDeps.send, "function");
  assert.equal(collectorDeps.label, "demo");
  // A successful collect leaves the exit code at its default (0).
  assert.deepEqual(exitCodes, []);
});

test("dispatch tg-connect exits non-zero when the collector returns not-ok", async () => {
  const { deps, exitCodes } = makeDeps({
    runTgConnect: spy(Promise.resolve({ ok: false, written: false })) as any,
  });
  await dispatch({ kind: "tgConnect", token: undefined, chat: undefined, noVerify: false, force: false }, deps);
  assert.deepEqual(exitCodes, [1]);
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
  // The loop is handed the host budget so it holds one slot around the container (design §8), and
  // no resume entry for a fresh run (no VETINARI_RESUME_SESSION → undefined).
  assert.deepEqual((deps.runLoop as any).calls, [[deps.cfg, "436", deps.host, undefined]]);
  assert.deepEqual(exitCodes, [0]);
});

test("dispatch run resumes a crashed session when spawned with one (design §7): the loop gets a resume entry", async () => {
  const { deps } = makeDeps({ resumeSession: "sess-436" });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  const call = (deps.runLoop as any).calls[0];
  assert.deepEqual(call.slice(0, 3), [deps.cfg, "436", deps.host]);
  assert.equal(call[3].resumeSessionId, "sess-436", "the crashed session is resumed on the existing branch");
  assert.match(call[3].answerPrompt, /interrupted before it reported a result/);
});

test("dispatch run refuses with one line naming the project and exits non-zero when a campaign lease is live (§5 step 3, §8)", async () => {
  const { deps, logged, exitCodes } = makeDeps({
    projectHasLiveCampaign: spy(true) as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  // Nothing is mutated: no leftover archived, no container started, no slot consumed.
  assert.equal((deps.archiveLeftoverRun as any).calls.length, 0, "the live log is not archived");
  assert.equal((deps.runLoop as any).calls.length, 0, "no second process runs the issue");
  // One line naming the project, and a non-zero exit.
  assert.equal(logged.length, 1, "exactly one refusal line");
  assert.ok(/demo/.test(logged[0]), "the refusal names the project");
  assert.ok(exitCodes.length === 1 && exitCodes[0] !== 0, "it exits non-zero");
});

test("dispatch run consults the lease with the host config dir and the project", async () => {
  const lease = spy(false);
  const { deps } = makeDeps({
    host: { configDir: "/cfg" } as any,
    projectHasLiveCampaign: lease as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  assert.deepEqual(lease.calls, [["/cfg", "demo"]]);
});

test("dispatch run is not refused by a standalone run's own lease — only a live campaign refuses (§5 step 3, §8)", async () => {
  // Wire the real lease probe against a real config dir: a standalone `run` for issue 436 is in
  // flight, holding a `kind: "run"` lease, and its pid is this test's own (alive). A second `run`
  // for a different issue must proceed — the run lease is not a live campaign.
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-dispatch-slots-"));
  registerProject(configDir, "demo", 1, "run", { pid: process.pid });
  assert.equal(projectHasLiveCampaign(configDir, "demo"), false, "a run lease is not a live campaign");
  const { deps } = makeDeps({
    host: { configDir } as any,
    projectHasLiveCampaign: projectHasLiveCampaign as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["611"], json: false }, deps);
  assert.equal((deps.runLoop as any).calls.length, 1, "the second standalone run is not refused by the first run's lease");

  // A campaign lease for the same project, by contrast, does refuse the run.
  registerProject(configDir, "demo", 1, "campaign", { pid: process.pid });
  const { deps: deps2, logged } = makeDeps({
    host: { configDir } as any,
    projectHasLiveCampaign: projectHasLiveCampaign as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["611"], json: false }, deps2);
  assert.equal((deps2.runLoop as any).calls.length, 0, "a live campaign lease refuses the standalone run");
  assert.ok(logged.some((l) => /campaign is already running/.test(l)), "the refusal names a live campaign");
});

test("dispatch run for a campaign's own child (VETINARI_CHILD) runs even while the lease is live", async () => {
  const { deps, exitCodes } = makeDeps({
    isCampaignChild: true,
    projectHasLiveCampaign: spy(true) as any,
  });
  await dispatch({ kind: "run", agent: {}, args: ["436"], json: false }, deps);
  // The child is admitted: it archives (a no-op for a child) and runs the loop, mapping green to 0.
  assert.equal((deps.runLoop as any).calls.length, 1, "the child run is not refused");
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
    projectHasLiveCampaign: spy(true) as any,
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
  assert.deepEqual((deps.runPrune as any).calls, [[deps.cfg, "436", { project: undefined, dryRun: true, purge: false, host: deps.host }]]);
});

test("dispatch prune forwards a project qualifier to runPrune", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "prune", project: "vetinari", target: "436", dryRun: false, purge: false, json: false }, deps);
  assert.deepEqual((deps.runPrune as any).calls, [[deps.cfg, "436", { project: "vetinari", dryRun: false, purge: false, host: deps.host }]]);
});

test("dispatch graft routes to runGraft with the parsed ids and flag", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "graft", ids: ["436", "611"], dryRun: false, json: false }, deps);
  assert.deepEqual((deps.runGraft as any).calls, [[deps.cfg, ["436", "611"], { project: undefined, dryRun: false }]]);
});

test("dispatch graft forwards a project qualifier to runGraft", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "graft", project: "vetinari", ids: ["436"], dryRun: false, json: false }, deps);
  assert.deepEqual((deps.runGraft as any).calls, [[deps.cfg, ["436"], { project: "vetinari", dryRun: false }]]);
});

// No JSON reaches stdout without `--json` (design §11): a `--dry-run` closure emits its
// machine `prune-closure`/`graft-closure {json}` line only under `--json`; the dashboard
// preview shells pass it. The human prose stays either way.
test("dispatch prune --dry-run emits the machine closure line only under --json", async () => {
  const withClosure = {
    mode: "prune", project: "demo", repo: undefined, title: undefined, target: "436", dropped: [], kept: [], remaining: [], parkedDropped: [],
    closure: { project: "demo", repo: undefined, target: "436", dropped: [], keptBanked: [], remaining: [] },
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
    project: "demo", repo: undefined, titles: {}, ids: ["436"], rejected: [], placement: [], remaining: [], applied: false,
    closure: { project: "demo", repo: undefined, ids: ["436"], placement: [], remaining: [], rejected: [] },
  };
  const noJson = makeDeps({ runGraft: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "graft", ids: ["436"], dryRun: true, json: false }, noJson.deps);
  assert.ok(!noJson.logged.some((l) => l.startsWith("graft-closure")), "no closure JSON without --json");

  const withJson = makeDeps({ runGraft: spy(Promise.resolve(withClosure)) as any });
  await dispatch({ kind: "graft", ids: ["436"], dryRun: true, json: true }, withJson.deps);
  assert.ok(withJson.logged.some((l) => l.startsWith("graft-closure ")), "closure JSON under --json");
});

test("dispatch graft on a real (non-dry-run) rejection prints the prose, emits the closure line only under --json, and exits non-zero", async () => {
  const closure = {
    project: "demo", repo: undefined, ids: ["202"], placement: [], remaining: [["101"], ["202"]],
    rejected: [{ id: "202", reason: "already-in-campaign" as const }],
  };
  const rejecting = (): Promise<never> =>
    Promise.reject(new GraftRejectedError("graft rejected — nothing added (already in the campaign: #202).", closure));

  // Without --json: the human prose prints, no JSON on stdout, exit non-zero.
  const noJson = makeDeps({ runGraft: (() => rejecting()) as unknown as DispatchDeps["runGraft"] });
  await dispatch({ kind: "graft", ids: ["202"], dryRun: false, json: false }, noJson.deps);
  assert.ok(noJson.logged.some((l) => /graft rejected — nothing added \(already in the campaign: #202\)/.test(l)), "prints the prose");
  assert.ok(!noJson.logged.some((l) => l.startsWith("graft-closure")), "no closure JSON without --json");
  assert.deepEqual(noJson.exitCodes, [1], "a rejected graft exits non-zero");

  // With --json: the machine `graft-closure {json}` line is emitted too (design §11).
  const withJson = makeDeps({ runGraft: (() => rejecting()) as unknown as DispatchDeps["runGraft"] });
  await dispatch({ kind: "graft", ids: ["202"], dryRun: false, json: true }, withJson.deps);
  assert.ok(withJson.logged.some((l) => l === `graft-closure ${JSON.stringify(closure)}`), "closure JSON under --json");
  assert.deepEqual(withJson.exitCodes, [1]);
});

test("dispatch graft on a broken graft (a non-rejection throw) surfaces the message cleanly on stderr and exits non-zero — no stack-trace footer", async () => {
  // A precondition throw ("no campaign", "settled", bad config) is NOT a rejection — it
  // carries no closure. The operator (via the dashboard route lifting the child's last
  // stderr line, #367) needs runGraft's sentence, not a Node stack ending in "Node.js vX",
  // so dispatchGraft prints just the message to stderr and exits non-zero.
  const broken = (): Promise<never> =>
    Promise.reject(new Error("graft adds to an open campaign, but the latest one is settled — every member merged."));
  const { deps, logged, errored, exitCodes } = makeDeps({ runGraft: (() => broken()) as unknown as DispatchDeps["runGraft"] });
  await dispatch({ kind: "graft", ids: ["640"], dryRun: false, json: false }, deps);
  assert.deepEqual(errored, ["graft adds to an open campaign, but the latest one is settled — every member merged."]);
  assert.ok(!logged.some((l) => l.startsWith("graft-closure")), "a broken child prints no closure line");
  assert.deepEqual(exitCodes, [1]);
});

test("identityLine names project, repo and title, and degrades each end gracefully", () => {
  assert.equal(
    identityLine("vetinari", "jjforge/vetinari", "42", "Fix the thing"),
    'vetinari · jjforge/vetinari#42 — "Fix the thing"',
  );
  // No title → project · repo#id.
  assert.equal(identityLine("vetinari", "jjforge/vetinari", "42"), "vetinari · jjforge/vetinari#42");
  // No repo → project and id.
  assert.equal(identityLine("vetinari", undefined, "42", "Fix the thing"), 'vetinari #42 — "Fix the thing"');
  assert.equal(identityLine("vetinari", undefined, "42"), "vetinari #42");
});

test("dispatch prune leads with the project/repo/title identity line", async () => {
  const result = {
    mode: "prune", project: "vetinari", repo: "jjforge/vetinari", title: "Fix the thing",
    target: "42", dropped: ["42"], kept: [], remaining: [["101"]], parkedDropped: [],
  };
  const { deps, logged } = makeDeps({ runPrune: spy(Promise.resolve(result)) as any });
  await dispatch({ kind: "prune", target: "42", dryRun: false, purge: false, json: false }, deps);
  assert.equal(logged[0], 'vetinari · jjforge/vetinari#42 — "Fix the thing"');
});

// A dry-run clears nothing, so its report must read as a preview, not a completed side-effect.
// The parked-record line branches on `cmd.dryRun` the way its --purge neighbour already does.
test("dispatch prune --dry-run reports the parked record in the future tense (would clear), not the past", async () => {
  const result = {
    mode: "prune", project: "demo", repo: undefined, title: undefined,
    target: "101", dropped: ["101"], kept: [], remaining: [["102", "103"]], parkedDropped: ["101"],
    closure: { project: "demo", repo: undefined, target: "101", dropped: ["101"], keptBanked: [], remaining: [["102", "103"]] },
  };
  const { deps, logged } = makeDeps({ runPrune: spy(Promise.resolve(result)) as any });
  await dispatch({ kind: "prune", target: "101", dryRun: true, purge: false, json: false }, deps);
  const line = logged.find((l) => /parked record/.test(l))!;
  assert.match(line, /^would clear the parked record for #101 — branch\/worktree\/session kept, resumable \(--purge also drops the branch \+ worktree\)\.$/);
});

test("dispatch prune --purge --dry-run reports the parked record in the future tense (would clear)", async () => {
  const result = {
    mode: "prune", project: "demo", repo: undefined, title: undefined,
    target: "101", dropped: ["101"], kept: [], remaining: [["102", "103"]], parkedDropped: ["101"],
    closure: { project: "demo", repo: undefined, target: "101", dropped: ["101"], keptBanked: [], remaining: [["102", "103"]] },
  };
  const { deps, logged } = makeDeps({ runPrune: spy(Promise.resolve(result)) as any });
  await dispatch({ kind: "prune", target: "101", dryRun: true, purge: true, json: false }, deps);
  const line = logged.find((l) => /parked record/.test(l))!;
  assert.equal(line, "would clear the parked record for #101.");
});

// An applied prune still reports the completed side-effect in the past tense — unchanged by the fix.
test("dispatch prune (applied) reports the parked record as cleared, past tense", async () => {
  const result = {
    mode: "prune", project: "demo", repo: undefined, title: undefined,
    target: "101", dropped: ["101"], kept: [], remaining: [["102", "103"]], parkedDropped: ["101"],
  };
  const { deps, logged } = makeDeps({ runPrune: spy(Promise.resolve(result)) as any });
  await dispatch({ kind: "prune", target: "101", dryRun: false, purge: false, json: false }, deps);
  const line = logged.find((l) => /parked record/.test(l))!;
  assert.equal(line, "cleared parked record for #101 — branch/worktree/session kept, resumable (--purge also drops the branch + worktree).");
});

test("dispatch graft leads with an identity line per grafted id", async () => {
  const result = {
    project: "vetinari", repo: "jjforge/vetinari",
    titles: { "301": "First", "302": "Second" },
    ids: ["301", "302"], rejected: [],
    placement: [{ id: "301", wave: 2 }, { id: "302", wave: 2 }],
    remaining: [["101"], ["301", "302"]], applied: true,
  };
  const { deps, logged } = makeDeps({ runGraft: spy(Promise.resolve(result)) as any });
  await dispatch({ kind: "graft", ids: ["301", "302"], dryRun: false, json: false }, deps);
  assert.equal(logged[0], 'vetinari · jjforge/vetinari#301 — "First"');
  assert.equal(logged[1], 'vetinari · jjforge/vetinari#302 — "Second"');
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
    projectHasLiveCampaign: spy(true) as any,
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
    projectHasLiveCampaign: spy(true) as any,
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
  assert.deepEqual((deps.runLoop as any).calls, [[deps.cfg, "436", deps.host]], "the run consumes the answered record and takes a host slot");
  assert.deepEqual(exitCodes, [0]); // the standalone green answer exits 0
});

test("dispatch answer runs the same credential preflight as run before delivering (design §3 step 1, §15)", async () => {
  const { deps } = makeDeps();
  await dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps);
  // answer carries no --agent flags, so it preflights the project/inherited selection.
  assert.deepEqual((deps.selectAgent as any).calls, [[deps.cfg, {}]], "the provider and its credentials are checked up front");
});

test("dispatch answer preflight refuses before delivering when the agent selection is bad", async () => {
  const { deps } = makeDeps({
    selectAgent: (() => {
      throw new Error('agent provider "codex" has no credentials');
    }) as any,
  });
  await assert.rejects(dispatch({ kind: "answer", taskId: "436", text: ["ok"] }, deps), /no credentials/);
  assert.equal((deps.answerParked as any).calls.length, 0, "a failed preflight delivers nothing");
});

test("dispatch answer with no text throws the needs-a-task-id-and-text message", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    dispatch({ kind: "answer", taskId: "436", text: [] }, deps),
    /answer needs a task id and text/,
  );
});
