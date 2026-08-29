import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli-dispatch.ts";

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

test("parseArgs splits `fileset-check` ids on whitespace/commas", () => {
  assert.deepEqual(parseArgs(["fileset-check", "436 611", "640"]), {
    kind: "filesetCheck",
    ids: ["436", "611", "640"],
  });
});

test("parseArgs maps `answer` to its task id and the answer text tail", () => {
  assert.deepEqual(parseArgs(["answer", "436", "looks", "good"]), {
    kind: "answer",
    taskId: "436",
    text: ["looks", "good"],
  });
});

test("parseArgs maps a bare `prune <issue>` to a prune of that target with no fresh plan", () => {
  assert.deepEqual(parseArgs(["prune", "436"]), {
    kind: "prune",
    target: "436",
    plan: undefined,
    dryRun: false,
    purge: false,
  });
});

test("parseArgs reads `prune` flags and a positional batch tail into a fresh-launch plan", () => {
  assert.deepEqual(
    parseArgs(["prune", "436", "611 640", "623", "--dry-run", "--purge"]),
    {
      kind: "prune",
      target: "436",
      plan: [["611", "640"], ["623"]],
      dryRun: true,
      purge: true,
    },
  );
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
