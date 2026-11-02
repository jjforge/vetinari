import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch, reactToLiveCampaign, type LaunchEffects } from "./launch.ts";
import { Refusal } from "./refusal.ts";
import { LiveCampaignRefusal } from "./lease.ts";

const cfg = { project: "demo" } as unknown as LaunchEffects["cfg"];
const host = { configDir: "/cfg" } as unknown as LaunchEffects["host"];

// A recording fake: every effect appends one step to `steps`, in the order the launcher took it.
// `campaign`/`runLoop` resolve to the canned outcome (or reject with `startThrows`); `listParked`
// returns the canned records the run row reads back for a `stopped` park.
function recorder(opts: { outcome?: string; startThrows?: Error; parked?: { taskId: string; reason: string }[] } = {}) {
  const steps: unknown[][] = [];
  const start =
    (name: string) =>
    async (...args: unknown[]) => {
      steps.push([name, ...args]);
      if (opts.startThrows) throw opts.startThrows;
      return opts.outcome;
    };
  const fx: LaunchEffects = {
    cfg,
    host,
    log: (m) => steps.push(["log", m]),
    error: (m) => steps.push(["error", m]),
    setExitCode: (c) => steps.push(["setExitCode", c]),
    exit: (c) => steps.push(["exit", c]),
    archiveLeftoverRun: () => steps.push(["archiveLeftoverRun"]),
    archiveIfIdle: () => steps.push(["archiveIfIdle"]),
    campaign: start("campaign") as unknown as LaunchEffects["campaign"],
    runLoop: start("runLoop") as unknown as LaunchEffects["runLoop"],
    listParked: (() => opts.parked ?? []) as unknown as LaunchEffects["listParked"],
  };
  return { fx, steps };
}

test("launch run archives the leftover, runs the loop with its entry, and exits on the loop's verdict", async () => {
  for (const [outcome, code] of [
    ["green", 0],
    ["parked", 2],
    ["failed", 1],
  ] as const) {
    const { fx, steps } = recorder({ outcome });
    const entry = { resumeSessionId: "s", answerPrompt: "go on" };
    await launch({ path: "run", taskId: "436", entry }, fx);
    assert.deepEqual(steps, [["archiveLeftoverRun"], ["runLoop", cfg, "436", host, entry], ["setExitCode", code]]);
  }
});

test("launch run force-exits 2 at once on a `stopped` park of its own issue, but not on a question park", async () => {
  const stopped = recorder({ outcome: "parked", parked: [{ taskId: "#436", reason: "stopped" }] });
  await launch({ path: "run", taskId: "436", entry: undefined }, stopped.fx);
  assert.deepEqual(stopped.steps.slice(-2), [
    ["setExitCode", 2],
    ["exit", 2],
  ]);

  const question = recorder({ outcome: "parked", parked: [{ taskId: "436", reason: "question" }] });
  await launch({ path: "run", taskId: "436", entry: undefined }, question.fx);
  assert.deepEqual(question.steps.at(-1), ["setExitCode", 2]);
});

test("launch answer-run runs the loop on the answered issue with no archive either side, exiting on its verdict", async () => {
  const { fx, steps } = recorder({ outcome: "parked", parked: [{ taskId: "436", reason: "stopped" }] });
  await launch({ path: "answer-run", taskId: "436" }, fx);
  assert.deepEqual(steps, [
    ["runLoop", cfg, "436", host],
    ["setExitCode", 2],
  ]);
});

test("launch campaign archives the leftover, starts the waves with the caller's options, archives once idle, and exits on the verdict", async () => {
  for (const [outcome, code] of [
    ["done", 0],
    ["parked", 2],
    ["failed", 1],
  ] as const) {
    const { fx, steps } = recorder({ outcome });
    const options = { autoPrune: true, fileKeys: { "101": ["src/a.ts"] } };
    await launch({ path: "campaign", waves: [["101"], ["102"]], name: "n", options }, fx);
    assert.deepEqual(steps, [
      ["archiveLeftoverRun"],
      ["campaign", cfg, [["101"], ["102"]], host, "n", options],
      ["archiveIfIdle"],
      ["setExitCode", code],
    ]);
  }
});

test("launch campaign that loses the lease race surfaces the live campaign's Refusal — no archive once idle, no exit code", async () => {
  const lost = new LiveCampaignRefusal("demo");
  const { fx, steps } = recorder({ startThrows: lost });
  await assert.rejects(
    launch({ path: "campaign", waves: [["101"]], name: undefined, options: { autoPrune: false } }, fx),
    (e) => e === lost,
  );
  assert.deepEqual(
    steps.map(([s]) => s),
    ["archiveLeftoverRun", "campaign"],
  );
});

test("launch redrive continues the live log — no leftover archive — resuming with its flags, archives once idle, exits on the verdict", async () => {
  for (const [outcome, code] of [
    ["done", 0],
    ["parked", 2],
    ["failed", 1],
  ] as const) {
    const { fx, steps } = recorder({ outcome });
    await launch({ path: "redrive", name: undefined, autoPrune: true, override: false }, fx);
    assert.deepEqual(steps, [
      ["campaign", cfg, [], host, undefined, { autoPrune: true, resume: true, override: false }],
      ["archiveIfIdle"],
      ["setExitCode", code],
    ]);
  }
  // The `campaign --resume` alias is the same row, carrying its `--name`.
  const alias = recorder({ outcome: "done" });
  await launch({ path: "redrive", name: "r", autoPrune: false, override: true }, alias.fx);
  assert.deepEqual(alias.steps[0], ["campaign", cfg, [], host, "r", { autoPrune: false, resume: true, override: true }]);
});

test("launch redrive that loses the lease race reports the live campaign as the early check does — no archive once idle, no exit code (#527)", async () => {
  const { fx, steps } = recorder({ startThrows: new LiveCampaignRefusal("demo") });
  await launch({ path: "redrive", name: undefined, autoPrune: false, override: false }, fx);
  assert.deepEqual(steps.slice(1), [["log", "a campaign is already running for demo — it will pick up the work; redrive refused."]]);
});

test("launch redrive rethrows a start failure that is not a lost lease race", async () => {
  const boom = new Error("boom");
  const { fx } = recorder({ startThrows: boom });
  await assert.rejects(launch({ path: "redrive", name: undefined, autoPrune: false, override: false }, fx), (e) => e === boom);
});

test("launch answer-redrive re-admits the answered member by redriving its paused campaign, archives once idle, exits on the verdict", async () => {
  const { fx, steps } = recorder({ outcome: "parked" });
  await launch({ path: "answer-redrive", taskId: "436" }, fx);
  assert.deepEqual(steps, [["campaign", cfg, [], host, undefined, { resume: true }], ["archiveIfIdle"], ["setExitCode", 2]]);
});

test("launch answer-redrive that loses the lease race leaves the re-admit to the live campaign — no archive once idle, no exit code (#527)", async () => {
  const { fx, steps } = recorder({ startThrows: new LiveCampaignRefusal("demo") });
  await launch({ path: "answer-redrive", taskId: "436" }, fx);
  assert.deepEqual(steps.slice(1), [["log", "436 answered — the live campaign will re-admit it."]]);
});

test("reactToLiveCampaign refuses a fresh campaign with a Refusal and records nothing", () => {
  const { fx, steps } = recorder();
  assert.throws(
    () => reactToLiveCampaign({ command: "campaign" }, fx),
    (e: Error) => e instanceof Refusal && e.message === "a campaign is already running for demo — campaign refused.",
  );
  assert.deepEqual(steps, []);
});

test("reactToLiveCampaign answers each other caller in its own words and exit code", () => {
  for (const [caller, expected] of [
    [{ command: "redrive" }, [["log", "a campaign is already running for demo — it will pick up the work; redrive refused."]]],
    [
      { command: "run" },
      [
        ["error", "a campaign is already running for demo — it owns this issue; run refused."],
        ["setExitCode", 4],
      ],
    ],
    [{ command: "answer", taskId: "436" }, [["log", "436 answered — the live campaign will re-admit it."]]],
  ] as const) {
    const { fx, steps } = recorder();
    reactToLiveCampaign(caller, fx);
    assert.deepEqual(steps, expected, caller.command);
  }
});

test("dispatch leaves the launch tail to the launcher: no archive, archive-once-idle or lost-race handling of its own (#690)", () => {
  const source = readFileSync(new URL("./cli-dispatch.ts", import.meta.url), "utf8");
  for (const step of [/\.archiveLeftoverRun\(/, /\.archiveIfIdle\(/, /resumeUnlessLive/]) assert.doesNotMatch(source, step);
});
