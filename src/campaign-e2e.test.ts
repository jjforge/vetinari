import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateSpec, ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { answerParked, clearParked, listOutbox, listParked } from "./state.ts";
import { BLOCKED, childRunEntry, DONE, defaultLoopDeps, runLoop, type LoopDeps } from "./loop.ts";
import { campaign, type CampaignDeps, type RunSpawner, type StopSignal } from "./modes.ts";
import { collectWaveChangelog, currentBranch, integrateGreens } from "./merge.ts";
import { runGates } from "./gate.ts";
import { buildStatus } from "./dashboard-status.ts";
import { describeEvent } from "./dashboard-event-text.ts";
import { inFlightRunning } from "./dashboard-live-tail.ts";
import type { HostBudget } from "./host-slots.ts";
import { makeLocalSandbox, type LocalAgentScript } from "./sandbox-local.ts";
import { gitOut, seedConflictRepo, seedRepo } from "./test-support.ts";

// ── End-to-end campaign through the local sandbox (design §3–§7, §13.4) ────────
//
// A real multi-wave campaign against a REAL temp-dir repo with a fake in-memory
// tracker and a scripted agent, driven through the local sandbox (ADR 0018) so no
// container or provider key is needed. Only the container boundary is faked in the
// two sanctioned ways (below); integrateGreens, the merged-base gate command, the
// real git merges/conflicts, collectWaveChangelog, currentBranch, the on-disk event
// log/parked dir and the commitsAhead/filesInCommit reads all run for real.
//
// This pins the §15 divergences §13.4 calls the core's open hole: an answered
// question rejoins its campaign, a failed issue holds its wave, and a redrive lands
// a green-but-unmerged member without re-running it.
//
// Note on vocabulary: the design's §13.2 rename (`campaign-batch`→`wave-start`,
// `quarantined`→`parked{conflict}`, the `campaign-*` stop markers) has landed;
// the events asserted here are that current §2.1 vocabulary.

/** Strip a leading `#` so a tracker id matches an `agent/<id>` branch suffix. */
const norm = (id: string) => id.replace(/^#/, "");

/**
 * An in-memory tracker (the acceptance's fake `fetchTask`/`blockedBy`/`listByLabel`):
 * a mutable id→body map so an "answer" is delivered the way the non-resumable path
 * delivers it — appended to the issue body a fresh run re-reads (design §3 step 9).
 */
interface FakeTracker {
  fetchTask: (id: string) => string;
  blockedBy: (id: string) => string[];
  listByLabel: (label: string) => string[];
  /** Append an answer to an issue body — what a human's `answer` posts as a comment. */
  answer: (id: string, text: string) => void;
}
const fakeTracker = (blocks: Record<string, string[]> = {}): FakeTracker => {
  const bodies = new Map<string, string>();
  const body = (id: string) => bodies.get(norm(id)) ?? `task ${norm(id)}`;
  return {
    fetchTask: (id) => body(id),
    blockedBy: (id) => blocks[norm(id)] ?? [],
    listByLabel: () => [...bodies.keys()],
    answer: (id, text) => bodies.set(norm(id), `${body(id)}\nANSWER: ${text}`),
  };
};

// A cfg over a real temp-dir repo: real on-disk log/parked dir/outbox, real gates,
// resumable (claude) agent. The sandbox factory is the only per-test injection.
const repoCfg = (dir: string, tracker: FakeTracker, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = join(dir, ".vetinari.local");
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return {
    project: "e2e",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    maxTurns: 4,
    idleTimeoutSeconds: 600,
    gates: [{ cmd: "test -f README.md" }],
    agent: { provider: "claude" },
    promptFile: "/prompts/tdd.md",
    log: loggerForRun({ logFile }),
    fetchTask: async (id: string) => tracker.fetchTask(id),
    blockedBy: (id: string) => tracker.blockedBy(id),
    listByLabel: (label: string) => tracker.listByLabel(label),
    ...overrides,
  } as unknown as ResolvedConfig;
};

// runLoop over a given agent-script, keeping the REAL commitsAhead/filesInCommit —
// only the container boundary (the sandbox factory) is faked.
const loopDepsFor = (script: LocalAgentScript): LoopDeps => ({
  ...defaultLoopDeps,
  makeSandbox: (cfg, taskId) => makeLocalSandbox(cfg, taskId, script),
});

// runLoop/campaign echo banners; silence the console so a test reads its result off
// disk, and run inside the temp repo so the host-repo git reads resolve there.
const inRepo = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const prevCwd = process.cwd();
  const realLog = console.log;
  const realErr = console.error;
  process.chdir(dir);
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    console.log = realLog;
    console.error = realErr;
  }
};

/**
 * The container boundary, faked in the two sanctioned ways and NOTHING else (ADR 0018):
 *   1. spawnRun → an in-process runLoop over the local sandbox (a child `run` would spawn
 *      a container). A thrown/unrecoverable turn surfaces as exit 1 — a `failed` member —
 *      exactly as a crashed child `run` process would (design §3 step 9 / §5).
 *   2. the merged-base gate's sandbox → the local sandbox (prod's gateMergedBase spins a
 *      container here); it still runs the REAL runGates(all:true) against the merged base.
 * integrateGreens, collectWaveChangelog and currentBranch are the production effects.
 * `spawns` records every id spawnRun drives, so a redrive can prove it re-ran nothing.
 */
const localCampaignDeps = (
  cfg: ResolvedConfig,
  dir: string,
  scriptFor: (id: string) => LocalAgentScript,
  spawns: string[] = [],
): CampaignDeps => {
  const spawnRun: RunSpawner = async (taskId, resumeSession, resumePrompt) => {
    spawns.push(taskId);
    // Enter the loop exactly as the child `run` does (cli-dispatch): a crash redrive resumes the
    // crashed session with the continue-where-you-left-off prompt (design §7); a merge-conflict
    // retry resumes with its conflict prompt, or re-enters fresh with it on a non-resumable
    // provider (design §6). Every other spawn gets neither.
    const entry = childRunEntry(resumeSession, resumePrompt);
    try {
      const outcome = await runLoop(cfg, taskId, undefined, entry, loopDepsFor(scriptFor(taskId)));
      // Mirror the real child `run`'s exit code (cli-dispatch's `exitCodeFor`): 0 green, 2
      // parked, 1 failed — the loop now returns `failed` for a thrown turn rather than
      // rethrowing (design §3 step 9), so the child exits 1 without spawnRun's catch.
      return outcome === "green" ? 0 : outcome === "failed" ? 1 : 2;
    } catch {
      return 1; // a still-thrown turn → the child `run` would exit non-zero → a failed member
    }
  };
  const mergedBaseGate = async (c: ResolvedConfig) => {
    const sbx = await makeLocalSandbox(c, "campaign-integrate", () => ({ signal: DONE }));
    try {
      return await runGates(c, sbx, { all: true });
    } finally {
      await sbx.close();
      execFileSync("git", ["-C", dir, "branch", "-D", `${c.branchPrefix}campaign-integrate`], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "worktree", "prune"], { stdio: "ignore" });
    }
  };
  // The per-merge check (#617): the real runGates over the flagged gates, through the same local sandbox.
  const perMergeGate = (c: ResolvedConfig, flagged: GateSpec[]) => mergedBaseGate({ ...c, gates: flagged });
  return {
    spawnRun,
    // Forward `index` and `opts` (the redrive re-gate flag) so integration behaves exactly as it
    // does in production; only the gates' sandbox is swapped for the local one.
    integrate: (c, greens, _deps, index, opts) => integrateGreens(c, greens, { gate: mergedBaseGate, perMergeGate }, index, opts),
    collectChangelog: collectWaveChangelog,
    currentBranch,
    grace: async () => {},
  };
};

// An issue's agent writes a disjoint impl file and commits on agent/<id> — file-disjoint,
// so co-wave greens merge clean.
const implScript =
  (id: string): LocalAgentScript =>
  (turn) => {
    turn.write(`impl-${id}.txt`, `impl for ${id}\n`);
    turn.commit(`implement ${id}`);
    return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
  };

// An issue whose turn hits an unrecoverable error — a crashed run. Its child `run` would
// exit non-zero; here the thrown turn surfaces as exit 1 through spawnRun (design §3 step 9).
const failingScript = (): LocalAgentScript => () => {
  throw new Error("unrecoverable agent turn");
};

// An issue that parks with a question until the human's answer reaches it, then implements
// green. The answer arrives one of two ways, both of which this recognises: a resumable provider
// resumes the parked session with an answer prompt (`turn.opts.prompt`), and a non-resumable one
// re-reads the issue body the answer was appended to (`ANSWER:` in the TASK — design §3 step 9).
const answerGatedScript =
  (id: string): LocalAgentScript =>
  (turn) => {
    const task = (turn.opts.promptArgs?.TASK as string) ?? "";
    const resumePrompt = (turn.opts.prompt as string) ?? "";
    const answered = task.includes("ANSWER:") || resumePrompt.includes("Answer from the human");
    if (!answered) return { signal: BLOCKED, stdout: `<question><summary>which approach for ${id}?</summary></question>` };
    return implScript(id)(turn);
  };

// Each issue rewrites the shared file to its own content — file-conflicting, so the loser
// cannot merge onto a base already carrying the winner. A merge-conflict retry (its prompt names
// conflict.txt) reports done without touching the branch, so its merge collides again.
const conflictScript =
  (id: string): LocalAgentScript =>
  (turn) => {
    if (retryPromptOf(turn).includes("conflict.txt")) return { signal: DONE, stdout: `<turn-summary>left ${id} as it was</turn-summary>` };
    turn.write("conflict.txt", `resolved by ${id}\n`);
    turn.commit(`rewrite conflict.txt in ${id}`);
    return { signal: DONE, stdout: `<turn-summary>rewrote conflict.txt in ${id}</turn-summary>` };
  };

/** The text a turn was driven with beyond the issue itself: a resumed session's prompt, or the
 * issue text a fresh re-entry carries (design §6) — empty for a plain first run. */
const retryPromptOf = (turn: { opts: { prompt?: unknown; promptArgs?: Record<string, unknown> } }): string =>
  String(turn.opts.prompt ?? turn.opts.promptArgs?.TASK ?? "");

// 101 and 102 both rewrite conflict.txt, so 102 collides at merge; 102 also writes its changelog
// fragment. On the retry (its prompt names conflict.txt) 102's agent merges the base into its
// branch and settles conflict.txt, keeping both sides. `retries` records each retry turn.
const resolvingConflictScript =
  (retries: { resumeSession?: string; text: string; tailed: string[] }[], cfg: ResolvedConfig) =>
  (id: string): LocalAgentScript =>
  (turn) => {
    const text = retryPromptOf(turn);
    if (text.includes("conflict.txt")) {
      // What the live tail follows while this retry runs (design §6, item 8).
      const tailed = inFlightRunning(buildStatus(cfg)).map((i) => i.issueNumber);
      retries.push({ resumeSession: turn.opts.resumeSession as string | undefined, text, tailed });
      try {
        turn.git(["merge", "base"]); // stops on the conflict.txt conflict, settled next
      } catch {
        // expected: the merge stops on the conflict, which the agent resolves below.
      }
      turn.write("conflict.txt", "resolved by 101 and 102\n");
      turn.commit(`merge the base into ${id}, resolve conflict.txt`);
      return { signal: DONE, stdout: `<turn-summary>merged the base into ${id}</turn-summary>` };
    }
    turn.write("conflict.txt", `resolved by ${id}\n`);
    if (id === "102") turn.write(`changelog.d/${id}.md`, `section: New features\n- [user] feature from ${id} (#${id}).\n`);
    turn.commit(`rewrite conflict.txt in ${id}`);
    return { signal: DONE, stdout: `<turn-summary>rewrote conflict.txt in ${id}</turn-summary>` };
  };

const host = (dir: string): HostBudget => ({ configDir: join(dir, "host"), ceiling: 2, weight: 1 });

for (const provider of ["claude", "copilot"] as const) {
  test(`scenario 9 (${provider}): a green whose merge collides is retried by its own agent in the same wave — it resolves, merges, and the wave completes with no park (#624)`, async () => {
    const dir = seedConflictRepo();
    const merged: string[] = [];
    const cfg = repoCfg(dir, fakeTracker(), { agent: { provider }, onIssueMerged: (id: string) => void merged.push(id) });
    const retries: { resumeSession?: string; text: string; tailed: string[] }[] = [];
    const deps = localCampaignDeps(cfg, dir, resolvingConflictScript(retries, cfg));

    await inRepo(dir, async () => {
      const outcome = await campaign(cfg, [["101", "102"]], host(dir), "retry", {}, deps);
      assert.equal(outcome, "done", "the retried collision merged and the campaign finished");

      // 102 merged in the same wave, carrying both sides of the conflict.
      assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101 and 102");
      const events = readEventLog(cfg);
      const waveDone = events.find((e) => e.event === "wave-done") as any;
      assert.deepEqual([...waveDone.merged].sort(), ["101", "102"]);

      // The event: one re-admit naming the real conflicting path and the base, logged just before
      // the retry's spawn.
      const readmits = events.filter((e) => e.event === "re-admit") as any[];
      assert.equal(readmits.length, 1);
      assert.equal(readmits[0].taskId, "102");
      assert.equal(readmits[0].reason, "conflict");
      assert.deepEqual(readmits[0].paths, ["conflict.txt"]);
      const firstIntegrated = events.find((e: any) => e.event === "campaign-integrated") as any;
      assert.equal(readmits[0].base, firstIntegrated.headSha, "the base is HEAD once the first pass's merges landed");
      const at = events.indexOf(readmits[0]);
      const next = events.slice(at + 1).find((e: any) => e.taskId === "102") as any;
      assert.equal(next?.event, "spawn", "the re-admit is written just before the retry's spawn");

      // The prompt reached the agent: on the resumed session (resumable) or as a fresh re-entry.
      assert.equal(retries.length, 1);
      if (provider === "claude") assert.equal(retries[0].resumeSession, "local-102-0", "the green's last session is resumed");
      else assert.equal(retries[0].resumeSession, undefined, "a non-resumable provider re-enters fresh");
      assert.ok(retries[0].text.includes(readmits[0].base), "the prompt names the base commit");
      if (provider === "copilot") assert.match(retries[0].text, /^task 102/, "the prompt rides on the issue text");
      // Live tail: while the retry ran, the retried issue was an in-flight runner.
      assert.deepEqual(retries[0].tailed, ["102"]);

      // A retry is not a park: no parked event, no parked record, no park notice.
      assert.equal(events.filter((e) => e.event === "parked").length, 0);
      assert.deepEqual(listParked(cfg), []);
      assert.equal(listOutbox(cfg).filter((r) => r.event === "campaign-parked").length, 0);

      // Post-merge steps ran after the retry pass: its fragment folded and its label advanced.
      assert.match(gitOut(dir, ["show", "base:CHANGELOG.md"]), /feature from 102 \(#102\)/);
      assert.deepEqual([...merged].sort(), ["101", "102"]);
    });
  });
}

test("scenario 10: a retried agent that asks a question parks `question`, not `conflict` — the retry's own verdict stands (#624)", async () => {
  const dir = seedConflictRepo();
  const cfg = repoCfg(dir, fakeTracker());
  // 102 collides; its retry asks a question instead of resolving.
  const scriptFor =
    (id: string): LocalAgentScript =>
    (turn) =>
      retryPromptOf(turn).includes("conflict.txt")
        ? { signal: BLOCKED, stdout: "<question><summary>keep both sides of conflict.txt?</summary></question>" }
        : conflictScript(id)(turn);

  await inRepo(dir, async () => {
    const outcome = await campaign(cfg, [["101", "102"]], host(dir), "retry-question", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(outcome, "parked");

    const events = readEventLog(cfg);
    assert.equal(events.filter((e) => e.event === "re-admit").length, 1);
    const parks = events.filter((e) => e.event === "parked") as any[];
    assert.deepEqual(
      parks.map((e) => [e.taskId, e.reason]),
      [["102", "question"]],
      "the retry parked on its question; nothing parked `conflict`",
    );
    assert.deepEqual(
      listParked(cfg).map((r) => [r.taskId, r.reason]),
      [["102", "question"]],
    );
    const stop = events.find((e) => e.event === "campaign-parked") as any;
    assert.equal(stop.reason, "question");
  });
});

test("scenario 11: a merge that fails with no unmerged paths — a held index.lock — fails the member: no retry, no park, the campaign fails (#624, #581)", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir, fakeTracker());
  const spawns: string[] = [];
  const base = localCampaignDeps(cfg, dir, implScript, spawns);
  const lock = join(dir, ".git", "index.lock");
  // Something else holds the base's index while the wave integrates.
  const deps: CampaignDeps = {
    ...base,
    integrate: async (...args) => {
      writeFileSync(lock, "");
      try {
        return await base.integrate(...args);
      } finally {
        rmSync(lock, { force: true });
      }
    },
  };

  await inRepo(dir, async () => {
    const outcome = await campaign(cfg, [["101"]], host(dir), "lock", {}, deps);
    assert.equal(outcome, "failed", "the campaign ends campaign-failed");

    const events = readEventLog(cfg);
    const failed = events.filter((e) => e.event === "failed") as any[];
    assert.deepEqual(
      failed.map((e) => e.taskId),
      ["101"],
    );
    assert.match(failed[0].detail, /Unable to write index/, "the failure carries the merge output");
    assert.deepEqual(spawns, ["101"], "no retry was spawned");
    assert.equal(events.filter((e) => e.event === "re-admit").length, 0);
    assert.equal(events.filter((e) => e.event === "parked").length, 0);
    assert.deepEqual(listParked(cfg), []);
    assert.ok(events.some((e) => e.event === "campaign-failed"));
  });
});

test("scenario 12: a red first-pass merged base outranks a collision — the wave parks `red-base` and no retry is spawned (#624)", async () => {
  const dir = seedConflictRepo();
  // Each green passes alone; a.txt and b.txt together are red.
  const cfg = repoCfg(dir, fakeTracker(), { gates: [{ cmd: "[ ! -f a.txt ] || [ ! -f b.txt ]" }] });
  // 101 writes a.txt and conflict.txt; 102 collides with it on conflict.txt; 103 writes b.txt.
  const scriptFor =
    (id: string): LocalAgentScript =>
    (turn) => {
      if (id !== "103") turn.write("conflict.txt", `resolved by ${id}\n`);
      if (id === "101") turn.write("a.txt", "101\n");
      if (id === "103") turn.write("b.txt", "103\n");
      turn.commit(`implement ${id}`);
      return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
    };
  const spawns: string[] = [];

  await inRepo(dir, async () => {
    const outcome = await campaign(cfg, [["101", "102", "103"]], host(dir), "red", {}, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(outcome, "parked");

    const events = readEventLog(cfg);
    const stop = events.find((e) => e.event === "campaign-parked") as any;
    assert.equal(stop.reason, "red-base");
    assert.deepEqual([...spawns].sort(), ["101", "102", "103"], "no retry was spawned");
    assert.equal(events.filter((e) => e.event === "re-admit").length, 0);
  });
});

test("scenario 13: a co-wave build break is caught per member — only the second merge is undone, retried once with the check-failure prompt, then parked `conflict` (#617)", async () => {
  const dir = seedRepo();
  // Each green passes alone; a.txt and b.txt together fail the flagged check.
  const clash = {
    cmd: `if [ -f a.txt ] && [ -f b.txt ]; then echo "a.txt and b.txt clash"; exit 1; fi`,
    label: "clash-check",
    perMerge: true,
  };
  const cfg = repoCfg(dir, fakeTracker(), { gates: [{ cmd: "test -f README.md" }, clash] });
  const retries: string[] = [];
  const scriptFor =
    (id: string): LocalAgentScript =>
    (turn) => {
      const text = retryPromptOf(turn);
      // The retry reports done without fixing anything, so its merge fails the check again.
      if (text.includes("clash-check")) {
        retries.push(text);
        return { signal: DONE, stdout: `<turn-summary>left ${id} as it was</turn-summary>` };
      }
      turn.write(id === "101" ? "a.txt" : "b.txt", `${id}\n`);
      turn.commit(`implement ${id}`);
      return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
    };
  // An unrelated uncommitted edit in the operator's checkout.
  writeFileSync(join(dir, "README.md"), "operator's local edit\n");

  await inRepo(dir, async () => {
    const outcome = await campaign(cfg, [["101", "102"]], host(dir), "clash", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(outcome, "parked", "the second failure parks the member and the campaign stops");

    const events = readEventLog(cfg);
    // 101 stays merged; 102's merge is undone both times, so the base sits on 101's merge.
    assert.equal(gitOut(dir, ["log", "-1", "--format=%s", "base"]), "campaign: merge agent/101");
    assert.equal(gitOut(dir, ["show", "base:a.txt"]), "101");
    assert.deepEqual(
      events.filter((e) => e.event === "merged").map((e: any) => e.taskId),
      ["101"],
      "no `merged` for an undone merge",
    );
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "operator's local edit\n", "the undo kept the local edit");

    // The re-admit carries the gate, its output tail, no paths, and the base it must merge.
    const readmits = events.filter((e) => e.event === "re-admit") as any[];
    assert.equal(readmits.length, 1);
    assert.equal(readmits[0].taskId, "102");
    assert.equal(readmits[0].reason, "conflict");
    assert.equal(readmits[0].gate, "clash-check");
    assert.match(readmits[0].detail, /a\.txt and b\.txt clash/);
    assert.deepEqual(readmits[0].paths, []);
    assert.equal(readmits[0].base, gitOut(dir, ["rev-parse", "base"]), "the base is the undone merge's pre-merge commit");
    assert.equal(describeEvent(readmits[0]), "#102 retrying failed check — clash-check");

    // The retried agent got the check-failure prompt: the gate, its output tail and the base commit.
    assert.equal(retries.length, 1);
    assert.match(retries[0], /fails clash-check/);
    assert.match(retries[0], /a\.txt and b\.txt clash/);
    assert.ok(retries[0].includes(readmits[0].base));

    // The retry failed the check again: 102 parks `conflict` with the output and the gate's question.
    const parks = events.filter((e) => e.event === "parked") as any[];
    assert.deepEqual(
      parks.map((e) => [e.taskId, e.reason]),
      [["102", "conflict"]],
    );
    assert.match(parks[0].detail, /a\.txt and b\.txt clash/);
    const record = listParked(cfg).find((r) => r.taskId === "102")!;
    assert.equal(record.reason, "conflict");
    assert.match(record.detail ?? "", /a\.txt and b\.txt clash/);
    assert.equal(record.question, "Merge of agent/102 fails clash-check — fix it on the base, then redrive.");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the member's work is preserved");
    assert.equal((events.find((e) => e.event === "campaign-parked") as any).reason, "conflict");
  });
});

test("scenario 5: a retried merge that collides again parks `conflict` and holds the wave — the campaign parks; a branch-side resolve then a redrive lands it (design §5 step 5, §6, §7)", async () => {
  const dir = seedConflictRepo();
  const tracker = fakeTracker(); // no blockers → the conflict strands nothing
  const cfg = repoCfg(dir, tracker);

  await inRepo(dir, async () => {
    // 101 merges first; 102 collides at merge and is retried once by its own agent, which leaves
    // the branch as it was — so the retry's merge collides again and 102 parks `conflict`. A
    // conflict-parked green is unresolved work awaiting a human, so — even with nothing stranded —
    // it holds the wave and the campaign parks (it no longer slips through to done, #310).
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "conflict", {}, localCampaignDeps(cfg, dir, conflictScript));
    assert.equal(parkedOk, "parked", "a conflict park holds the wave");

    const events = readEventLog(cfg);
    // One retry, then the second collision parks: the re-admit comes before the park.
    const readmits = events.filter((e) => e.event === "re-admit") as any[];
    assert.deepEqual(
      readmits.map((e) => e.taskId),
      ["102"],
      "exactly one retry per integration",
    );
    // 101 merged and stays; 102 is the attributed loser — parked, its branch preserved.
    assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
    const q = events.filter((e: any) => e.event === "parked" && e.reason === "conflict") as any[];
    assert.deepEqual(
      q.map((e) => e.taskId),
      ["102"],
    );
    assert.ok(events.indexOf(q[0]) > events.indexOf(readmits[0]), "only the second collision parks");
    assert.ok(
      listParked(cfg).some((r) => r.taskId === "102" && r.reason === "conflict"),
      "today's parked record is written",
    );
    assert.ok(
      listOutbox(cfg).some((r) => r.event === "campaign-parked" && r.text.includes("Merge conflict on #102")),
      "today's conflict notice is enqueued",
    );
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the conflicted member's work is preserved");
    // The wave never closed and the campaign did not finish — the stop marker carries reason conflict.
    assert.equal(
      events.some((e) => e.event === "wave-done"),
      false,
      "the held wave is not closed",
    );
    assert.equal(
      events.some((e) => e.event === "campaign-done"),
      false,
    );
    const parked = events.filter((e) => e.event === "campaign-parked") as any[];
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, "conflict", "the wave's reason is conflict");
  });

  // The human resolves the conflict on the branch: merge the base into agent/102 and settle
  // conflict.txt, so agent/102 now merges onto the base clean.
  const wt = mkdtempSync(join(tmpdir(), "vetinari-resolve-"));
  execFileSync("git", ["-C", dir, "worktree", "add", "--force", wt, "agent/102"], { stdio: "ignore" });
  try {
    execFileSync("git", ["-C", wt, "merge", "base"], { stdio: "ignore" }); // conflicts — exits non-zero, resolved next
  } catch {
    // expected: the merge stops on the conflict.txt conflict, which we resolve by hand below.
  }
  writeFileSync(join(wt, "conflict.txt"), "resolved by 101 and 102\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "commit", "-qm", "resolve conflict.txt on agent/102"]);
  execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt], { stdio: "ignore" });

  await inRepo(dir, async () => {
    // Redrive re-enters the held wave and INTEGRATES the now-mergeable 102 without re-running it;
    // 101 is already banked. The wave closes and the campaign finishes.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, conflictScript, spawns));
    assert.equal(doneOk, "done", "the redrive landed the resolved conflict and finished");
    assert.deepEqual(spawns, [], "no member of the reconciled wave was re-run");

    // 102's resolved work is on the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101 and 102");
    const events = readEventLog(cfg);
    assert.ok(
      events.some((e) => e.event === "merged" && (e as any).taskId === "102"),
      "102 was merged on the redrive",
    );
    assert.ok(
      events.some((e) => e.event === "campaign-done"),
      "the campaign advanced to done",
    );
  });
});

// Two branches each green alone but red together (both present) — an emergent red base. The
// merged-base gate passes when at most one of a.txt/b.txt is present.
const abScript =
  (id: string): LocalAgentScript =>
  (turn) => {
    const file = id === "101" ? "a.txt" : "b.txt";
    turn.write(file, `${id}\n`);
    turn.commit(`add ${file} in ${id}`);
    return { signal: DONE, stdout: `<turn-summary>added ${file}</turn-summary>` };
  };

test("scenario 6: a red base parks the wave; a fix-forward then a redrive RE-GATES the base even though nothing new merges (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  // Green alone (only one of a.txt/b.txt present on each branch), red on the merged base (both).
  const cfg = repoCfg(dir, tracker, { gates: [{ cmd: "[ ! -f a.txt ] || [ ! -f b.txt ]" }] });

  await inRepo(dir, async () => {
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "red-base", {}, localCampaignDeps(cfg, dir, abScript));
    assert.equal(parkedOk, "parked", "the emergent red base parks the wave");
    const events = readEventLog(cfg);
    const parked = events.filter((e) => e.event === "campaign-parked") as any[];
    assert.equal(parked.length, 1);
    assert.equal(parked[0].reason, "red-base", "the wave's reason is red-base");
    // Both greens are merged on the base (never rolled back), the base sitting red.
    assert.equal(gitOut(dir, ["show", "base:a.txt"]), "101");
    assert.equal(gitOut(dir, ["show", "base:b.txt"]), "102");
    assert.equal(
      events.some((e) => e.event === "wave-done"),
      false,
    );
  });

  // Fix forward on the base: drop b.txt so the base gate goes green again.
  execFileSync("git", ["-C", dir, "rm", "-q", "b.txt"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "fix forward: drop b.txt"]);

  await inRepo(dir, async () => {
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, abScript, spawns));
    assert.equal(doneOk, "done", "the redrive re-gated the fixed base green and finished");
    assert.deepEqual(spawns, [], "nothing was re-run — the fix lived on the base, not a member branch");

    const events = readEventLog(cfg);
    // The base was re-gated on re-entry even though nothing new merged (design §7): the
    // merged-base gate (a gate-result with no taskId) ran after the redrive and passed, the wave
    // closed, and the campaign completed. `landed` on the redrive event is 0 — nothing freshly
    // merged — yet the gate still ran.
    const redrive = events.find((e) => e.event === "redrive") as any;
    assert.ok(redrive, "a redrive event was logged");
    assert.equal(redrive.landed, 0, "nothing freshly merged on the re-entry");
    // The re-entry runs a second wave-start; the merged-base gate (gate-result, no taskId) fires
    // during that wave's integration even though nothing new merged.
    const secondWaveStart = events.map((e) => e.event).lastIndexOf("wave-start");
    const gatesAfterRedrive = events.slice(secondWaveStart).filter((e) => e.event === "gate-result" && !(e as any).taskId) as any[];
    assert.ok(gatesAfterRedrive.length > 0, "the merged base was re-gated after the redrive");
    assert.ok(
      gatesAfterRedrive.every((g) => g.exitCode === 0),
      "the re-gated base passed",
    );
    assert.ok(
      events.some((e) => e.event === "wave-done"),
      "the re-gated wave closed",
    );
    assert.ok(
      events.some((e) => e.event === "campaign-done"),
      "the campaign advanced to done",
    );
  });
});

test("scenario 4: a redrive integrates a green-but-unmerged member — landed without re-running it (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges; 102 parks → the wave parks and exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "redrive", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(parkedOk, "parked");

    // The answer produces a GREEN 102 that is not yet integrated: a standalone run (what
    // `answer` does) re-enters agent/102, greens, logs `green`, and clears the record — but
    // does NOT merge. So the redrive re-enters a wave with a green-but-unmerged member.
    tracker.answer("102", "use approach B");
    const answered = await runLoop(cfg, "102", undefined, undefined, loopDepsFor(scriptFor("102")));
    assert.equal(answered, "green", "the answered member ran to green");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "102 is green but its branch is unmerged");

    // Redrive with a recording spawner: 102 is already green, so it is INTEGRATED without
    // being re-run. 101 is already banked and is likewise not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, "done", "the redrive landed the banked greens and finished");
    assert.deepEqual(spawns, [], "no member of the reconciled wave was re-run");

    // 102's green work is now merged onto the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    const integrated = events.filter((e: any) => e.event === "campaign-integrated");
    assert.ok(
      integrated.some((e: any) => e.merged.includes("102")),
      "102 was integrated on the redrive",
    );
    assert.ok(
      events.some((e) => e.event === "campaign-done"),
      "the campaign advanced to done",
    );
  });
});

test("scenario 8: a --now stop that kills one member before its run started and another after it logged green parks the campaign `stopped`; a redrive lands the green and re-runs the other (#464)", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir, fakeTracker());

  await inRepo(dir, async () => {
    // The stop signal kills each child by the default disposition: 102 still booting (its stop
    // handler not yet installed), 101 in the tail after its runLoop logged green and returned.
    const base = localCampaignDeps(cfg, dir, implScript);
    let fire!: (signal: StopSignal) => void;
    let signalled!: () => void;
    const killed = new Promise<void>((r) => (signalled = r));
    const stopped = await campaign(
      cfg,
      [["101", "102"]],
      host(dir),
      undefined,
      {},
      {
        ...base,
        onStop: (cb) => {
          fire = cb;
          return () => {};
        },
        signalRuns: () => signalled(),
        spawnRun: async (id, resume) => {
          if (id === "102") {
            await killed;
            return "SIGTERM";
          }
          assert.equal(await base.spawnRun(id, resume), 0);
          fire("SIGTERM");
          return "SIGTERM";
        },
      },
    );
    assert.equal(stopped, "parked", "the stopped campaign pauses rather than failing");
    const events = readEventLog(cfg);
    assert.ok(!events.some((e) => e.event === "campaign-failed"));
    assert.deepEqual(
      events.filter((e: any) => e.event === "campaign-parked").map((e: any) => e.reason),
      ["stopped"],
    );
    assert.deepEqual(
      listParked(cfg).map((r) => [r.taskId, r.reason]),
      [["102", "stopped"]],
    );

    // The redrive lands 101's banked green without re-running it, and re-runs the stopped 102.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, implScript, spawns));
    assert.equal(doneOk, "done");
    assert.deepEqual(spawns, ["102"]);
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
  });
});

test("scenario 2b: an answer delivered mid-wave (the grace window) re-admits the member into the SAME wave with the answer, and the campaign finishes without a redrive (design §5 step 3)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker, { parkGraceSeconds: 30 });
  // 101 implements green; 102 parks until answered.
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    const deps: CampaignDeps = {
      ...localCampaignDeps(cfg, dir, scriptFor),
      // The human's answer lands inside the grace window: DELIVERED into 102's parked record.
      // The live campaign re-admits it into this same wave — the re-run resumes the session with
      // the answer, greens, and merges alongside 101, so the wave never parks.
      grace: async (c, ids) => {
        for (const id of ids) answerParked(c, id, "use approach A");
      },
    };
    const ok = await campaign(cfg, [["101", "102"]], host(dir), "rejoin-in-wave", {}, deps);
    assert.equal(ok, "done", "the in-window answer let the member rejoin and the wave finish");

    // Both greens are on the base — 102 merged in the same wave it parked in, no separate redrive.
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    assert.ok(
      events.some((e) => e.event === "grace-wait"),
      "the wave held open for the answer",
    );
    assert.ok(
      events.some((e) => e.event === "wave-done"),
      "the wave closed with both members merged",
    );
    assert.ok(
      events.some((e) => e.event === "campaign-done"),
      "the campaign finished",
    );
    assert.equal(
      events.some((e) => e.event === "campaign-parked"),
      false,
      "the answered member never parked the wave",
    );
    assert.equal(
      listParked(cfg).some((r) => r.taskId === "102"),
      false,
      "the answered record was consumed by the re-run",
    );
  });
});

test("scenario 1: two all-green waves merge in order, the base is gated between them, and the campaign finishes done", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["101"], ["102"]], host(dir), "two-waves", {}, localCampaignDeps(cfg, dir, implScript)),
  );
  assert.equal(ok, "done", "both waves ran green and the campaign completed");

  const events = readEventLog(cfg);

  // Both waves ran, in order.
  const batches = events.filter((e: any) => e.event === "wave-start").map((e: any) => e.tasks);
  assert.deepEqual(batches, [["101"], ["102"]], "the two waves ran in order");

  // Each wave integrated its green, in order — integrateGreens logs one per wave.
  const integrated = events.filter((e: any) => e.event === "campaign-integrated").map((e: any) => e.merged);
  assert.deepEqual(integrated, [["101"], ["102"]], "each wave merged its green, in order");

  // The base is gated BETWEEN waves: the merged-base gate (a gate-result with no taskId)
  // ran for each wave's integration and passed both times.
  const baseGates = events.filter((e: any) => e.event === "gate-result" && !e.taskId);
  assert.equal(baseGates.length, 2, "the merged base was gated once per wave");
  assert.ok(
    baseGates.every((r: any) => r.exitCode === 0),
    "each merged-base gate passed",
  );

  // The merges are real and cumulative: both impl files are on the base, wave 1 having
  // been cut from a base that already carried wave 0's work.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
  assert.ok(
    events.some((e) => e.event === "campaign-done"),
    "the campaign advanced to done",
  );
});

test("scenario 3: a failed member drains its wave — the sibling merges — then holds the wave: no next wave starts and the campaign stops failed (design §5)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  // 101 implements green; 102's turn crashes (a failed member). 201 is a later wave.
  const scriptFor = (id: string) => (id === "102" ? failingScript() : implScript(id));

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["101", "102"], ["201"]], host(dir), "fail", {}, localCampaignDeps(cfg, dir, scriptFor)),
  );
  assert.equal(ok, "failed", "a failed member stops the campaign non-zero");

  const events = readEventLog(cfg);

  // Only wave 0 ran — the failure held the wave and no succeeding wave started.
  const batches = events.filter((e: any) => e.event === "wave-start").map((e: any) => e.index);
  assert.deepEqual(batches, [0], "only wave 0 ran — no succeeding wave started");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/201"]), "", "the succeeding wave's issue never ran");

  // The sibling still merged — a failure never aborts or un-merges a sibling.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");

  // The campaign stopped as failed: one `campaign-failed` stop marker naming the wave and member.
  const failed = events.filter((e) => e.event === "campaign-failed") as any[];
  assert.equal(failed.length, 1, "exactly one campaign-failed stop marker");
  assert.equal(failed[0].index, 0, "the stop marker names the wave that failed");
  assert.ok(String(failed[0].detail).includes("102"), "the stop marker's detail names the failed member");
  // The failed member is carried by its own `failed` event (design §2.1).
  const failedMember = events.find((e) => e.event === "failed") as any;
  assert.ok(failedMember, "the failed member has its own failed event");
  assert.equal(failedMember.taskId, "102");
  // The sibling green stayed merged on the base — a `merged` event names it.
  const mergedMembers = events.filter((e) => e.event === "merged").map((e: any) => e.taskId);
  assert.deepEqual(mergedMembers, ["101"], "the green stayed merged on the base");
  // The wave holds, it does not close.
  assert.equal(
    events.some((e) => e.event === "wave-done"),
    false,
    "the failed wave is not logged done",
  );
  assert.equal(
    events.some((e) => e.event === "campaign-done"),
    false,
  );
});

test("scenario 2: a question park drains its wave, campaign parks and exits; an answer rejoins the member, which re-runs green and merges, and the campaign continues to done (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  // 101 implements green; 102 parks until answered.
  const scriptFor = (id: string) => (id === "102" ? answerGatedScript(id) : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges under Gate 2; 102 parks → the wave parks and exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "rejoin", {}, localCampaignDeps(cfg, dir, scriptFor));
    assert.equal(parkedOk, "parked", "the parked wave stops the campaign");

    // The sibling merged (drain, don't abort): 101's impl is on the base, its branch GC'd.
    assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
    // 102's parked record survives so it stays answerable, and its branch (created when it
    // parked) is preserved — the re-run must re-enter it, not fail trying to recreate it.
    assert.ok(
      listParked(cfg).some((r) => r.taskId === "102"),
      "102 stayed parked and answerable",
    );
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "the parked member's branch is preserved");
  });

  // The human answers 102: the answer is DELIVERED into the parked record (design §5 step 3),
  // not run — the record and its session id are kept so the redrive can resume it.
  answerParked(cfg, "102", "use approach A");

  await inRepo(dir, async () => {
    // Redrive: 102's answered record re-runs — re-entering its existing agent/102 branch,
    // resuming the session with the answer — greens, merges, and clears the record; 101
    // (already banked) is not re-run.
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptFor, spawns));
    assert.equal(doneOk, "done", "the answered member rejoined and the campaign finished");
    assert.deepEqual(spawns, ["102"], "only the answered member re-ran; the banked sibling did not");
    assert.equal(
      listParked(cfg).some((r) => r.taskId === "102"),
      false,
      "the answered record was consumed by the re-run",
    );

    // 102's work is now on the base, and the campaign completed.
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
    const events = readEventLog(cfg);
    assert.ok(
      events.some((e) => e.event === "campaign-done"),
      "the campaign advanced to done",
    );
  });
});

// A member that commits its work then crashes mid-turn: its first turn writes and commits (so the
// branch banks a commit and a session lands on the log), then the process dies before a verdict.
// On resume it observes the crash prompt and greens with the already-banked commit. `seen` records
// the session id each resume was driven on, so the test can prove it resumed vs re-ran fresh.
const crashThenResumeScript =
  (seen: string[]) =>
  (id: string): LocalAgentScript =>
  (turn) => {
    const resume = turn.opts.resumeSession as string | undefined;
    if (resume) {
      seen.push(resume);
      return { signal: DONE, stdout: `<turn-summary>resumed ${id} from a crash</turn-summary>` };
    }
    turn.write(`impl-${id}.txt`, `impl for ${id}\n`);
    turn.commit(`implement ${id}`);
    // The process vanishes here — a parked question stands in for the crash, then the test deletes
    // the on-disk record to leave the recordless shape §7 reconciles to parked{crash}.
    return { signal: BLOCKED, stdout: `<question><summary>crash point for ${id}</summary></question>` };
  };

test("scenario 7: a crashed member with commits on its branch resumes its session on redrive; no record, but the banked work and session drive a resume, not a fresh run (design §7)", async () => {
  const dir = seedRepo();
  const tracker = fakeTracker();
  const cfg = repoCfg(dir, tracker);
  const seen: string[] = [];
  const scriptFor = crashThenResumeScript(seen);
  const scriptForBoth = (id: string) => (id === "102" ? scriptFor("102") : implScript(id));

  await inRepo(dir, async () => {
    // First run: 101 greens and merges; 102 commits then "crashes" (parks, standing in for a
    // dead process). The wave parks and the campaign exits.
    const parkedOk = await campaign(cfg, [["101", "102"]], host(dir), "crash", {}, localCampaignDeps(cfg, dir, scriptForBoth));
    assert.equal(parkedOk, "parked", "the crash-shaped park stops the campaign");
    assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102", "102's committed work is preserved on its branch");
  });

  // The crash leaves NO on-disk record (a dead process wrote no park record): drop it, leaving the
  // recordless shape §7 reconciles to parked{crash}. Its committed branch and logged session remain.
  clearParked(cfg, "102");
  assert.equal(
    listParked(cfg).some((r) => r.taskId === "102"),
    false,
    "the crash left no record",
  );

  await inRepo(dir, async () => {
    const spawns: string[] = [];
    const doneOk = await campaign(cfg, [], host(dir), undefined, { resume: true }, localCampaignDeps(cfg, dir, scriptForBoth, spawns));
    assert.equal(doneOk, "done", "the redrive resumed the crash, greened, merged, and finished");
    assert.deepEqual(spawns, ["102"], "only the crashed member re-ran; the banked sibling did not");
    // The proof of §7: the resume was driven on the member's recorded session, not a fresh start.
    assert.deepEqual(seen, ["local-102-0"], "the crashed session was resumed, not re-run fresh");
    assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102", "the banked work landed on the base");
    assert.ok(
      readEventLog(cfg).some((e) => e.event === "campaign-done"),
      "the campaign advanced to done",
    );
  });
});
