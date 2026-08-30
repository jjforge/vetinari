import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { loggerForRun } from "./log.ts";
import { readEventLog } from "./event-log.ts";
import { listParked } from "./state.ts";
import { readFileSync } from "node:fs";
import { BLOCKED, DONE, defaultLoopDeps, runLoop, type LoopDeps } from "./loop.ts";
import { campaign, graceWaitForAnswer, type CampaignDeps, type RunSpawner } from "./modes.ts";
import { collectWaveChangelog, currentBranch, integrateGreens } from "./merge.ts";
import { runGates } from "./gate.ts";
import { listOutbox } from "./state.ts";
import type { HostBudget } from "./host-slots.ts";
import { makeLocalSandbox, type LocalAgentScript } from "./sandbox-local.ts";

// ── The local-sandbox integration harness (ADR 0018) ─────────────────────────
//
// A real temp-dir git repo on `base`, with real gates that run for real inside a
// worktree via the local sandbox's `exec`. Only the container boundary is faked:
// the per-issue loop's `makeSandbox` (→ `makeLocalSandbox`). Everything downstream
// of the agent turn — the gate, its exit code, the on-disk event log/parked dir,
// the `commitsAhead`/`filesInCommit` git reads — runs against real state.

/** A fresh repo on `base` whose seed commits `README.md` + a `CHANGELOG.md`. */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-pipeline-"));
  const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "-c", "init.defaultBranch=base", "init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n### Older — August 1, 2026\n\n**Bug fixes:**\n- [user] old (#1)\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed"]);
  return dir;
}

// A cfg over a real temp-dir repo: a real on-disk event log/parked dir/outbox under
// its stateDir driven by a real logger, real gates, resumable (claude) agent. Only
// the sandbox factory is injected per-test.
const repoCfg = (dir: string, overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const stateDir = join(dir, ".vetinari.local");
  const logFile = join(stateDir, "logs", "orchestrator.jsonl");
  return {
    project: "pipeline",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    maxTurns: 4,
    idleTimeoutSeconds: 600,
    gates: [{ cmd: "test -f marker.txt" }],
    agent: { provider: "claude" },
    promptFile: "/prompts/tdd.md",
    log: loggerForRun({ logFile }),
    fetchTask: async () => "task text",
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

const gitOut = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

test("a green agent turn commits on its branch and the real gate runs via the local sandbox's exec → runLoop green", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir);

  // The agent-script operates on the real checkout: writes the file the gate checks
  // for, makes a real commit on agent/T1, and returns DONE.
  const greenScript: LocalAgentScript = (turn) => {
    turn.write("marker.txt", "ok\n");
    turn.commit("add marker");
    return { signal: DONE, stdout: "<turn-summary>added the marker</turn-summary>" };
  };

  const outcome = await inRepo(dir, () => runLoop(cfg, "T1", undefined, loopDepsFor(greenScript)));

  assert.equal(outcome, "green");
  assert.equal(listParked(cfg).length, 0);

  // The commit is real: agent/T1 carries the marker the script committed.
  assert.equal(gitOut(dir, ["show", "agent/T1:marker.txt"]), "ok");

  // The green event names the branch and the real commit sha.
  const events = readEventLog(cfg);
  const green = events.find((e) => e.event === "green") as { branch: string; commits: string[] } | undefined;
  assert.ok(green, "expected a green event");
  assert.equal(green!.branch, "agent/T1");
  assert.equal(green!.commits.length, 1);

  // The gate ran for real via exec — a zero-exit gate-result is on the log.
  const gateResult = events.find((e) => e.event === "gate-result") as { exitCode: number } | undefined;
  assert.ok(gateResult, "expected a gate-result event");
  assert.equal(gateResult!.exitCode, 0);
});

test("a deliberately red gate yields a real non-zero exit via exec and parks — the gate genuinely runs, no stub reads it green", async () => {
  const dir = seedRepo();
  const cfg = repoCfg(dir, { maxTurns: 2 });

  // The agent commits real work each turn but never writes the file the gate checks
  // for, so `test -f marker.txt` exits non-zero for real, turn after turn.
  let n = 0;
  const redScript: LocalAgentScript = (turn) => {
    n++;
    turn.write(`attempt-${n}.txt`, "still working\n");
    turn.commit(`attempt ${n}`);
    return { signal: DONE, stdout: "<turn-summary>tried again</turn-summary>" };
  };

  const outcome = await inRepo(dir, () => runLoop(cfg, "T2", undefined, loopDepsFor(redScript)));

  // A red gate parks (stalled on the turn budget) — never a green over a red suite.
  assert.equal(outcome, "parked");
  const parked = listParked(cfg);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "stalled");
  assert.equal(parked[0].detail, "budget:2");

  const events = readEventLog(cfg);
  assert.equal(events.some((e) => e.event === "green"), false);
  // The gate ran for real and its non-zero exit was seen — not a stubbed green read.
  const reds = events.filter((e) => e.event === "gate-result") as { exitCode: number }[];
  assert.ok(reds.length > 0, "expected gate-result events");
  assert.ok(reds.every((r) => r.exitCode !== 0), "every gate run went red for real");
});

// Each issue's agent-script writes a disjoint impl file + its own changelog fragment
// and commits on agent/<id> — file-disjoint, so both greens merge clean.
const implScript = (id: string): LocalAgentScript => (turn) => {
  turn.write(`impl-${id}.txt`, `impl for ${id}\n`);
  turn.write(`changelog.d/${id}.md`, `section: New features\n- [user] feature from ${id} (#${id}).\n`);
  turn.commit(`implement ${id}`);
  return { signal: DONE, stdout: `<turn-summary>implemented ${id}</turn-summary>` };
};

/**
 * The container boundary, faked in the two sanctioned ways and NOTHING else (ADR 0018):
 *   1. spawnRun → an in-process runLoop over the local sandbox (a child `run` would spawn
 *      a container); it keeps the real commitsAhead/filesInCommit.
 *   2. the merged-base gate's sandbox → the local sandbox (prod's gateMergedBase spins a
 *      container here); it still runs the REAL runGates(all:true) against the merged base.
 * integrateGreens, collectWaveChangelog and currentBranch are the production effects,
 * unswapped.
 */
const localCampaignDeps = (
  cfg: ResolvedConfig,
  dir: string,
  scriptFor: (id: string) => LocalAgentScript = implScript,
): CampaignDeps => {
  const spawnRun: RunSpawner = async (taskId) => {
    const outcome = await runLoop(cfg, taskId, undefined, loopDepsFor(scriptFor(taskId)));
    return outcome === "green" ? 0 : outcome === "parked" ? 2 : 1;
  };
  // The merged-base gate: real runGates over the merged base through the local sandbox
  // (only the container is faked). Cleans up its throwaway branch/worktree like prod's
  // gateMergedBase does.
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
  return {
    spawnRun,
    integrate: (c, greens) => integrateGreens(c, greens, { gate: mergedBaseGate }),
    collectChangelog: collectWaveChangelog,
    currentBranch,
    grace: graceWaitForAnswer,
  };
};

test("a campaign wave of two issues spans agent → gate → merge → advance through the local sandbox", async () => {
  const dir = seedRepo();
  // README.md exists on the base and every branch, so the gate is green for each green
  // alone and on the merged base — the red-gate path is pinned separately above.
  const cfg = repoCfg(dir, { gates: [{ cmd: "test -f README.md" }] });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () => campaign(cfg, [["101", "102"]], host, "span", {}, localCampaignDeps(cfg, dir)));

  assert.equal(ok, "done");

  const events = readEventLog(cfg);

  // AC1: both issues ran on real agent/<id> branches carrying real commits, each gated green.
  const greens = events.filter((e) => e.event === "green") as { branch: string; commits: string[] }[];
  assert.deepEqual(greens.map((g) => g.branch).sort(), ["agent/101", "agent/102"]);
  assert.ok(greens.every((g) => g.commits.length === 1), "each green carries its real commit");

  // AC2: both greens merged through the real integrateGreens; the real merged-base gate ran…
  const merged = events.find((e: any) => e.event === "campaign-integrated") as { merged: string[] } | undefined;
  assert.ok(merged, "expected a campaign-integrated event from integrateGreens");
  assert.deepEqual(merged!.merged.sort(), ["101", "102"]);
  // …the merged-base gate is the gate-result with no taskId (all:true, no single issue).
  const baseGate = events.filter((e) => e.event === "gate-result" && !(e as any).taskId) as { exitCode: number }[];
  assert.ok(baseGate.length > 0, "expected a merged-base gate-result");
  assert.ok(baseGate.every((r) => r.exitCode === 0), "the merged base gated green");
  // …and the wave advanced to done.
  assert.ok(events.some((e) => e.event === "campaign-done"), "the wave advanced to campaign-done");

  // The merges are real: both impl files are on the base, the agent branches are GC'd.
  assert.equal(gitOut(dir, ["show", "base:impl-101.txt"]), "impl for 101");
  assert.equal(gitOut(dir, ["show", "base:impl-102.txt"]), "impl for 102");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "");

  // AC3: collectWaveChangelog ran for real — both wave fragments folded into CHANGELOG.md.
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes("- [user] feature from 101 (#101)."), "101's fragment folded");
  assert.ok(changelog.includes("- [user] feature from 102 (#102)."), "102's fragment folded");

  // The operator feed reports the merged wave and the completed campaign.
  const outbox = listOutbox(cfg);
  assert.ok(outbox.find((m) => m.event === "wave-done"), "wave-done went out");
  assert.ok(outbox.find((m) => m.event === "campaign-done"), "campaign-done went out");
});

// ── Span 1: merge conflict → quarantine (ADR 0013) ───────────────────────────
//
// Two same-wave greens whose branches touch the SAME file with conflicting content:
// each passes its own gate alone, but the second cannot merge onto a base already
// carrying the first. integrateGreens attributes the conflict to that one branch,
// quarantines it (work preserved), and keeps the first green merged.

/** Seed `conflict.txt` on the base so two branches that both rewrite it collide at merge. */
function seedConflictRepo(): string {
  const dir = seedRepo();
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed conflict.txt"]);
  return dir;
}

// Each issue rewrites the shared file to its own content and commits — file-conflicting,
// so the loser cannot merge onto a base already carrying the winner.
const conflictScript = (id: string): LocalAgentScript => (turn) => {
  turn.write("conflict.txt", `resolved by ${id}\n`);
  turn.commit(`rewrite conflict.txt in ${id}`);
  return { signal: DONE, stdout: `<turn-summary>rewrote conflict.txt in ${id}</turn-summary>` };
};

test("a merge conflict quarantines the losing green (work preserved) while the winner stays merged, and — with a stranded dependent — quarantine-pauses the campaign", async () => {
  const dir = seedConflictRepo();
  // README exists everywhere, so each green passes its own gate and the merged base
  // (carrying only the winner) gates green — the ONLY red here is the merge itself.
  const cfg = repoCfg(dir, {
    gates: [{ cmd: "test -f README.md" }],
    // #103's dependent sits in a later, unstarted wave, so quarantining it strands work.
    blockedBy: (id: string) => (id.replace(/^#/, "") === "103" ? ["102"] : []),
  });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["101", "102"], ["103"]], host, "conflict", {}, localCampaignDeps(cfg, dir, conflictScript)),
  );

  // The blast-radius call belongs to a human: the campaign quarantine-pauses, not done.
  assert.equal(ok, "parked");

  const events = readEventLog(cfg);

  // Both branches went green on their own gate (each rewrite passed `test -f README.md`).
  const greens = events.filter((e) => e.event === "green") as { branch: string }[];
  assert.deepEqual(greens.map((g) => g.branch).sort(), ["agent/101", "agent/102"]);

  // 101 merged first and stays merged: its content is on the base, its branch GC'd.
  assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/101"]), "");

  // 102 is the attributed loser: a real integrator `parked{conflict}` event, and its branch (work) preserved.
  const q = events.find((e) => e.event === "parked" && (e as any).reason === "conflict") as { taskId: string } | undefined;
  assert.ok(q, "expected a parked{conflict} event");
  assert.equal(q!.taskId, "102");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102");

  // The wave neither rolled back nor advanced past the boundary: no campaign-done, and the
  // stranded dependent's wave never started (no agent/103, no green for it).
  assert.equal(events.some((e) => e.event === "campaign-done"), false);
  assert.equal(gitOut(dir, ["branch", "--list", "agent/103"]), "");
  assert.equal(events.some((e) => e.event === "green" && (e as any).branch === "agent/103"), false);

  // Blast-radius handling per config: default (no --auto-prune) pauses for a human.
  const outbox = listOutbox(cfg);
  assert.ok(outbox.find((m) => m.event === "campaign-parked"), "the quarantine-pause notice (campaign-parked) went out");
  assert.equal(outbox.some((m) => m.event === "prune"), false);
  assert.equal(events.some((e) => e.event === "prune"), false);
});

test("a merge conflict under --auto-prune quarantines the loser and prunes the stranded dependent, but the conflict still holds the wave (design §5 step 5, #314)", async () => {
  const dir = seedConflictRepo();
  const cfg = repoCfg(dir, {
    gates: [{ cmd: "test -f README.md" }],
    blockedBy: (id: string) => (id.replace(/^#/, "") === "103" ? ["102"] : []),
  });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["101", "102"], ["103"]], host, "conflict", { autoPrune: true }, localCampaignDeps(cfg, dir, conflictScript)),
  );

  // `--auto-prune` decides the DEPENDENTS' fate (prune the stranded closure), never whether the
  // campaign stops: the conflict-parked green itself holds the wave, so the campaign parks.
  assert.equal(ok, "parked");

  const events = readEventLog(cfg);
  // 102 still quarantined (its work kept), 101 still the merged winner.
  const q = events.find((e) => e.event === "parked" && (e as any).reason === "conflict") as { taskId: string } | undefined;
  assert.equal(q?.taskId, "102");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/102"]), "agent/102");
  assert.equal(gitOut(dir, ["show", "base:conflict.txt"]), "resolved by 101");

  // The stranded dependent was still pruned (a real prune event on 102's closure) so a later
  // redrive skips the doomed dependent — but the campaign parked rather than advancing to done.
  const prune = events.find((e) => e.event === "prune") as { target: string; dropped: string[] } | undefined;
  assert.ok(prune, "expected a prune event");
  assert.equal(prune!.target, "102");
  assert.deepEqual(prune!.dropped, ["103"]);
  assert.equal(events.some((e) => e.event === "campaign-done"), false, "the campaign did not advance to done");
  // The conflict hold is an explicit campaign-parked with reason conflict (§2.1 rule 2).
  const parked = events.filter((e) => e.event === "campaign-parked") as any[];
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, "conflict");

  const outbox = listOutbox(cfg);
  assert.ok(outbox.find((m) => m.event === "prune"), "the auto-prune notice (prune) went out");
  assert.ok(outbox.some((m) => m.event === "campaign-parked"), "the conflict-park notice went out");
});

// ── Span 2: per-issue park → drain → wave-park (ADR 0017) ────────────────────
//
// One issue's agent returns BLOCKED — a per-issue park. Its wave is NOT aborted:
// the sibling green drains and merges under Gate 2, and only THEN does the park
// escalate to a wave-park. The parked record survives the wave-boundary clear and
// no succeeding wave starts.

// 202 asks a question and parks; every other issue implements green.
const parkOneScript = (blockedId: string) => (id: string): LocalAgentScript =>
  id === blockedId
    ? () => ({ signal: BLOCKED, stdout: "<question><summary>which approach?</summary></question>" })
    : implScript(id);

test("a per-issue BLOCKED park drains its wave's greens, then wave-parks — the parked record survives and no succeeding wave starts", async () => {
  const dir = seedRepo();
  // README exists everywhere, so 201's green passes its own gate and the merged base
  // (carrying only 201) gates green — the wave-park here is the parked issue, not a red base.
  const cfg = repoCfg(dir, { gates: [{ cmd: "test -f README.md" }] });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["201", "202"], ["203"]], host, "park", {}, localCampaignDeps(cfg, dir, parkOneScript("202"))),
  );

  // A wave that parks an issue is not fully resolved, so the campaign pauses (not done).
  assert.equal(ok, "parked");

  const events = readEventLog(cfg);

  // Drain, don't abort (ADR 0017): 201's green drained and merged under Gate 2 —
  // its impl is on the base and its branch GC'd.
  assert.equal(gitOut(dir, ["show", "base:impl-201.txt"]), "impl for 201");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/201"]), "");

  // Then the wave parked: a campaign-parked event whose detail names the parked issue.
  const wp = events.find((e) => e.event === "campaign-parked") as { detail?: string } | undefined;
  assert.ok(wp, "expected a campaign-parked event");
  assert.ok(wp!.detail?.includes("202"), "campaign-park detail names the parked issue");

  // The parked record survives the wave-boundary held-clear (ADR 0017): 202 is still
  // listed, as a first-class durable `question` park — not cleared into silence.
  const parked = listParked(cfg);
  const p202 = parked.find((r) => r.taskId === "202");
  assert.ok(p202, "202's parked record survived the wave-boundary clear");
  assert.equal(p202!.reason, "question");

  // No succeeding wave starts: the campaign did not advance to done and 203 never ran.
  assert.equal(events.some((e) => e.event === "campaign-done"), false);
  assert.equal(gitOut(dir, ["branch", "--list", "agent/203"]), "");
  assert.equal(events.some((e) => e.event === "green" && (e as any).branch === "agent/203"), false);

  // The operator feed drew a human with the wave-park notice.
  assert.ok(listOutbox(cfg).find((m) => m.event === "campaign-parked"), "the wave-park notice (campaign-parked) went out");
});

// ── Span 3: red merged base → Gate-2 wave-park (ADR 0013) ────────────────────
//
// Two greens with DISJOINT files (so they merge clean, no conflict) but a gate that
// each passes alone and the combined base fails — the emergent, unattributable
// failure. No branch is to blame, so nothing rolls back: the greens stay merged on a
// red base and the wave parks for a human.

test("each green passes its own gate but the merged base fails the combined gate → wave-park with greens left merged and no rollback", async () => {
  const dir = seedRepo();
  // The gate is green with at most one impl-*.txt present (true in each single-issue
  // worktree) and RED once the merged base carries both — each passes alone, together red.
  const cfg = repoCfg(dir, { gates: [{ cmd: 'test "$(ls impl-*.txt 2>/dev/null | wc -l)" -le 1' }] });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };

  const ok = await inRepo(dir, () =>
    campaign(cfg, [["301", "302"]], host, "red-base", {}, localCampaignDeps(cfg, dir)),
  );

  // An unattributable red base pauses the campaign for a human — never done.
  assert.equal(ok, "parked");

  const events = readEventLog(cfg);

  // Each issue passed its OWN gate alone (its worktree carried one impl file).
  const greens = events.filter((e) => e.event === "green") as { branch: string }[];
  assert.deepEqual(greens.map((g) => g.branch).sort(), ["agent/301", "agent/302"]);
  const perIssueGates = events.filter((e) => e.event === "gate-result" && (e as any).taskId) as { exitCode: number }[];
  assert.ok(perIssueGates.length > 0 && perIssueGates.every((r) => r.exitCode === 0), "each per-issue gate went green alone");

  // The combined base gated RED for real — the merged-base gate-result (no taskId) is non-zero.
  const baseGate = events.filter((e) => e.event === "gate-result" && !(e as any).taskId) as { exitCode: number }[];
  assert.ok(baseGate.length > 0, "expected a merged-base gate-result");
  assert.ok(baseGate.some((r) => r.exitCode !== 0), "the merged base gated red");

  // Wave-park (ADR 0013): the greens stayed MERGED on the base — no rollback — over the two
  // branches. The campaign-parked stop marker records the pause, and each landed green is on
  // the log as a `merged` event; both impl files are on the base.
  const cp = events.find((e) => e.event === "campaign-parked");
  assert.ok(cp, "expected a campaign-parked event");
  const mergedEvents = events.filter((e) => e.event === "merged").map((e) => (e as any).taskId).sort();
  assert.deepEqual(mergedEvents, ["301", "302"]);
  assert.equal(gitOut(dir, ["show", "base:impl-301.txt"]), "impl for 301");
  assert.equal(gitOut(dir, ["show", "base:impl-302.txt"]), "impl for 302");

  // No rollback and no green-path cleanup: the merged branches are left intact (never GC'd
  // over a red base), so the work stays resumable once a human fixes it forward.
  assert.equal(gitOut(dir, ["branch", "--list", "agent/301"]), "agent/301");
  assert.equal(gitOut(dir, ["branch", "--list", "agent/302"]), "agent/302");

  // A red base verifies nothing: no changelog fold (fragments left for the retry) and no done.
  assert.equal(events.some((e) => e.event === "campaign-done"), false);
  assert.ok(existsSync(join(dir, "changelog.d", "301.md")), "301's fragment left unfolded");
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.equal(changelog.includes("feature from 301"), false);

  // The operator feed drew a human with the wave-park notice.
  assert.ok(listOutbox(cfg).find((m) => m.event === "campaign-parked"), "the wave-park notice (campaign-parked) went out");
});
