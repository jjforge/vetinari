import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import {
  autoPruneNotice,
  build,
  buildImageArgs,
  campaign,
  campaignFailedNotice,
  childSpawnEnv,
  conflictParkedNotice,
  markMergedIssues,
  reconcileResumeWave,
  strandedConflictNotice,
  queue,
  requireTelegram,
  resolveTitles,
  warnIfTelegramUnconfigured,
  campaignParkedNotice,
  type CampaignDeps,
  type RunSpawner,
} from "./modes.ts";
import { loggerForRun, memoryLogger, type MemoryLogger } from "./log.ts";
import { answerParked, clearParked, hasParked, listOutbox } from "./state.ts";
import {
  readEventLog,
  type CampaignDoneEvent,
  type CampaignFailedEvent,
  type CampaignParkedEvent,
  type CampaignStartEvent,
  type FailedEvent,
  type GraceWaitEvent,
  type SpawnEvent,
  type WaveDoneEvent,
  type WaveStartEvent,
} from "./event-log.ts";
import { archiveRun, shouldArchiveLeftover } from "./archive.ts";
import { readLeases, type HostBudget } from "./host-slots.ts";

const cfgWith = (fetchTask: ResolvedConfig["fetchTask"]): ResolvedConfig =>
  ({ fetchTask }) as ResolvedConfig;

let counter = 0;
const baseLocationWith = (env?: string): string => {
  const base = join(
    tmpdir(),
    `vetinari-modes-${Date.now()}-${counter++}`,
    ".vetinari.local",
  );
  mkdirSync(base, { recursive: true });
  if (env !== undefined) writeFileSync(join(base, "host.env"), env);
  return base;
};

const withEnv = (over: Record<string, string | undefined>, fn: () => void) => {
  const keys = Object.keys(over);
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys)
    over[k] === undefined ? delete process.env[k] : (process.env[k] = over[k]);
  try {
    fn();
  } finally {
    for (const k of keys)
      prev[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = prev[k]);
  }
};

test("requireTelegram resolves the connection from the base location's host.env — the path the gateway sends on", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\nVETINARI_TELEGRAM_CHAT_ID=-1001\n",
  );

  assert.deepEqual(requireTelegram("tg-test", baseLocation), {
    token: "123:abc",
    chat: "-1001",
    thread: undefined,
  });
});

test("requireTelegram fails naming host.env and the base location when creds are only exported", () => {
  const baseLocation = baseLocationWith(); // no host.env on disk
  withEnv(
    {
      VETINARI_TELEGRAM_BOT_TOKEN: "exported",
      VETINARI_TELEGRAM_CHAT_ID: "exported",
    },
    () => {
      // Exporting the vars is the wrong path — the gateway never reads process.env,
      // so tg-test must still report them missing and point at the file to fix.
      assert.throws(
        () => requireTelegram("tg-test", baseLocation),
        (e: Error) =>
          e.message ===
          `tg-test needs VETINARI_TELEGRAM_BOT_TOKEN and VETINARI_TELEGRAM_CHAT_ID in ${join(baseLocation, "host.env")}`,
      );
    },
  );
});

// Capture what a body writes to stderr, restoring the real console.error after.
const captureStderr = (fn: () => void): string => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = real;
  }
  return lines.join("\n");
};

// A cfg whose base location IS this stateDir (absolute, so it resolves to itself),
// carrying a silent in-memory logger so the emitted event can be read back off
// `cfg.log.events` — no on-disk log target needed.
const unnotifiableCfg = (baseLocation: string): ResolvedConfig =>
  ({ project: "myapp", stateDir: baseLocation, log: memoryLogger() }) as unknown as ResolvedConfig;

/** The `.events` a cfg's injected memory logger captured. */
const eventsOf = (cfg: ResolvedConfig) => (cfg.log as MemoryLogger).events;

test("warnIfTelegramUnconfigured warns naming host.env and logs telegram-unconfigured when the base location resolves no conn", () => {
  const baseLocation = baseLocationWith(); // no host.env → no conn
  const cfg = unnotifiableCfg(baseLocation);

  const stderr = captureStderr(() => warnIfTelegramUnconfigured(cfg));

  // The operator is told, on stderr, that parks won't ping and which file to fix.
  assert.match(stderr, /Telegram/);
  assert.match(
    stderr,
    new RegExp(join(baseLocation, "host.env").replace(/[.\\/]/g, "\\$&")),
  );

  // …and the same fact is logged so the dashboard can narrate it.
  const logged = eventsOf(cfg).filter(
    (e) => e.event === "telegram-unconfigured",
  );
  assert.equal(logged.length, 1);
  assert.deepEqual(
    {
      project: (logged[0] as any).project,
      baseLocation: (logged[0] as any).baseLocation,
    },
    { project: "myapp", baseLocation },
  );
});

test("warnIfTelegramUnconfigured is silent when the base location's host.env resolves a conn", () => {
  const baseLocation = baseLocationWith(
    "VETINARI_TELEGRAM_BOT_TOKEN=123:abc\nVETINARI_TELEGRAM_CHAT_ID=-1001\n",
  );
  const cfg = unnotifiableCfg(baseLocation);

  const stderr = captureStderr(() => warnIfTelegramUnconfigured(cfg));

  assert.equal(stderr, "");
  assert.equal(
    eventsOf(cfg).filter((e) => e.event === "telegram-unconfigured").length,
    0,
  );
});

test("markMergedIssues calls the configured onIssueMerged seam with exactly the merged ids", async () => {
  const seen: string[] = [];
  await markMergedIssues({ onIssueMerged: (id) => void seen.push(id), log: memoryLogger() }, [
    "101",
    "102",
    "103",
  ]);
  assert.deepEqual(seen, ["101", "102", "103"]);
});

test("campaignParkedNotice draws attention to a paused campaign whose greens stay merged, carrying the gate detail", () => {
  const notice = campaignParkedNotice("acme", 2, ["101", "102"], "main", "gate line\nGATE FAILED");
  // Routed to the alerting channel — a wave-park demands a human, like the old halt did.
  assert.equal(notice.category, "failure");
  assert.equal(notice.event, "campaign-parked");
  // Header follows the §10 skeleton in the settled words: emoji · project · STATE · context.
  assert.ok(notice.text.startsWith("🅿️ acme · PARKED · wave 2"));
  // The operator is told which greens stay merged, on which base, and that it paused.
  assert.ok(notice.text.includes("101, 102"));
  assert.ok(notice.text.includes("main"));
  assert.ok(/pause/i.test(notice.text));
  // No machine-named culprit: the notice says the failure is unattributable.
  assert.ok(/no attributable culprit/i.test(notice.text));
  // Self-contained recovery: it names the exact commands to type (folded from #170), in the settled verb.
  assert.ok(notice.text.includes("vetinari redrive"));
  assert.ok(notice.text.includes("prune <issue>"));
  // The gate report tail rides along so the human sees why it went red.
  assert.ok(notice.text.includes("GATE FAILED"));
});

test("strandedConflictNotice draws a human to a campaign paused by a quarantine that orphaned later-wave dependents", () => {
  const notice = strandedConflictNotice(
    "acme",
    1,
    [{ target: "640", removed: ["640", "701"], dropped: ["701"] }],
    "main",
  );
  // Routed to the alerting channel — a paused campaign demands a human, like a wave-park.
  assert.equal(notice.category, "failure");
  assert.equal(notice.event, "campaign-parked");
  // Header follows the §10 skeleton in the settled words: emoji · project · STATE · context.
  assert.ok(notice.text.startsWith("🅿️ acme · PARKED · wave 1"));
  // Names the conflicted issue and the dependents it stranded.
  assert.ok(notice.text.includes("640"));
  assert.ok(notice.text.includes("701"));
  assert.ok(/pause/i.test(notice.text));
  // Points at both recovery paths, each by its exact command (folded from #170), in the settled verb.
  assert.ok(notice.text.includes("vetinari redrive"));
  assert.ok(notice.text.includes("campaign --auto-prune"));
});

test("autoPruneNotice reports the pruned dependents and that the campaign ran on", () => {
  const notice = autoPruneNotice("acme", 1, [
    { target: "640", removed: ["640", "701"], dropped: ["701"] },
  ]);
  // Informational — the campaign continued, so it rides the progress channel.
  assert.equal(notice.category, "progress");
  assert.equal(notice.event, "prune");
  // Header follows the §10 skeleton in the settled words: emoji · project · STATE · context.
  assert.ok(notice.text.startsWith("✂️ acme · PRUNED · wave 1"));
  assert.ok(notice.text.includes("640"));
  assert.ok(notice.text.includes("701"));
  assert.ok(/prune/i.test(notice.text));
});

// The retired words that must never reach an operator through a notice (design §10, §13.1):
// the old halt labels, the queue/batch vocabulary, and `campaign --resume` as a recovery command.
const RETIRED_IN_NOTICES = /quarantin|wave-park|batch|queue|--resume/i;

test("no notice builder renders a retired word — the settled vocabulary reaches operators (§10, §13.1)", () => {
  // Every operator notice a park/failure/prune builds, rendered with representative args.
  const built = [
    campaignParkedNotice("acme", 2, ["101", "102"], "main", "gate line\nGATE FAILED"),
    campaignFailedNotice("acme", 3, ["101"], ["102"], "main"),
    strandedConflictNotice("acme", 1, [{ target: "640", removed: ["640", "701"], dropped: ["701"] }], "main"),
    conflictParkedNotice("acme", 1, ["640"], ["101"], "main"),
    autoPruneNotice("acme", 1, [{ target: "640", removed: ["640", "701"], dropped: ["701"] }]),
  ];
  for (const n of built)
    assert.ok(!RETIRED_IN_NOTICES.test(n.text), `retired word in: ${n.text}`);
});

test("a green campaign's outbound notices carry no retired word (§10, §13.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-notice-vocab-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  // A two-wave green campaign emits campaign-start, wave-start ×2, wave-done ×2, campaign-done —
  // every inline campaign notice — so grepping the outbox proves the whole set uses the skeleton.
  await silenceConsole(() =>
    campaign(cfg, [["101"], ["201"]], host, "vocab work", {}, gitFreeDeps(cfg, async () => 0)),
  );
  const outbox = listOutbox(cfg);
  assert.ok(outbox.length >= 6, "the campaign emitted its inline notices");
  for (const rec of outbox)
    assert.ok(!RETIRED_IN_NOTICES.test(rec.text), `retired word in notice: ${rec.text}`);
});

test("markMergedIssues is a no-op when onIssueMerged is unconfigured — core names no labels", async () => {
  // No throw, nothing to observe: the core stays tracker-agnostic.
  await markMergedIssues({ log: memoryLogger() }, ["101"]);
});

test("markMergedIssues isolates a throwing hook — it is logged and the rest still run, no throw", async () => {
  const seen: string[] = [];
  const log = memoryLogger();
  await markMergedIssues(
    {
      onIssueMerged: (id) => {
        seen.push(id);
        if (id === "102") throw new Error("offline");
      },
      log,
    },
    ["101", "102", "103"],
  );
  // 102 threw but 101 and 103 were still attempted, and the call itself did not throw.
  assert.deepEqual(seen, ["101", "102", "103"]);
  // The failure surfaced on the injected event log, naming the offending id.
  const failed = log.events.filter((e) => (e as { event: string }).event === "issue-merged-hook-failed");
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as any).taskId, "102");
});

test("resolveTitles maps each id to its fetched title", async () => {
  const titles: Record<string, string> = {
    "101": "Add login flow",
    "102": "Rotate logs",
  };
  const map = await resolveTitles(
    cfgWith(async (id) => JSON.stringify({ title: titles[id] })),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "Add login flow", "102": "Rotate logs" });
});

test("resolveTitles normalizes #-prefixed ids and dedupes", async () => {
  const seen: string[] = [];
  const map = await resolveTitles(
    cfgWith(async (id) => {
      seen.push(id);
      return JSON.stringify({ title: `title ${id}` });
    }),
    ["#101", "101", "202"],
  );
  assert.deepEqual(map, { "101": "title 101", "202": "title 202" });
  // Each distinct issue is fetched once, by its normalized id.
  assert.deepEqual(seen.sort(), ["101", "202"]);
});

test("resolveTitles omits an id whose task carries no structured title", async () => {
  const map = await resolveTitles(
    cfgWith(async (id) =>
      id === "101" ? JSON.stringify({ title: "Real title" }) : "just a body",
    ),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "Real title" });
});

test("resolveTitles degrades gracefully when a fetch throws — the id is simply absent, no throw", async () => {
  const map = await resolveTitles(
    cfgWith(async (id) => {
      if (id === "102") throw new Error("network down");
      return JSON.stringify({ title: "ok" });
    }),
    ["101", "102"],
  );
  assert.deepEqual(map, { "101": "ok" });
});

test("buildImageArgs shells sandcastle build-image with the image and dockerfile, each named once", () => {
  const args = buildImageArgs("vetinari-myapp", "vetinari/Dockerfile");
  assert.deepEqual(args, [
    "docker",
    "build-image",
    "--dockerfile",
    "vetinari/Dockerfile",
    "--image-name",
    "vetinari-myapp",
  ]);
});

test("childSpawnEnv marks a spawned child so its `run` skips leftover-archiving, keeping the parent env (#150)", () => {
  const child = childSpawnEnv({ PATH: "/usr/bin", HOME: "/home/x" });
  // The marker a child `run` reads to know it must not archive the campaign log.
  assert.equal(child.VETINARI_CHILD, "1");
  // The rest of the environment crosses through unchanged.
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/home/x");
});

test("childSpawnEnv threads the selected agent (VETINARI_AGENT) to a spawned child so every wave runs the chosen provider, not a silent claude (ADR 0016)", () => {
  // The parent invocation stamped its `--agent` override onto process.env; the child
  // `run` a queue/campaign spawns must inherit it, so `agentFor` reads back the same
  // agent for every wave instead of falling to the config default.
  const child = childSpawnEnv({
    PATH: "/usr/bin",
    VETINARI_AGENT: JSON.stringify({ provider: "pi", effort: "xhigh" }),
  });
  assert.equal(child.VETINARI_AGENT, JSON.stringify({ provider: "pi", effort: "xhigh" }));
  // …and it is still marked a child (the two markers coexist).
  assert.equal(child.VETINARI_CHILD, "1");
});

const buildCfg = (): ResolvedConfig =>
  ({ image: "vetinari-myapp", log: memoryLogger() }) as unknown as ResolvedConfig;

test("build builds the image, then runs baseline by default, returning its result", async () => {
  const calls: string[] = [];
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async (image, dockerfile) => {
        calls.push(`build ${image} ${dockerfile}`);
        return 0;
      },
      baseline: async () => {
        calls.push("baseline");
        return true;
      },
    },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    "build vetinari-myapp vetinari/Dockerfile",
    "baseline",
  ]);
});

test("build with --no-baseline builds only, skipping the probe", async () => {
  let baselineRan = false;
  const ok = await build(
    buildCfg(),
    { baseline: false },
    {
      buildImage: async () => 0,
      baseline: async () => {
        baselineRan = true;
        return true;
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(baselineRan, false);
});

test("build fails and skips baseline when the image build exits non-zero", async () => {
  let baselineRan = false;
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async () => 1,
      baseline: async () => {
        baselineRan = true;
        return true;
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(baselineRan, false);
});

test("build fails when the image builds but baseline is red", async () => {
  const ok = await build(
    buildCfg(),
    { baseline: true },
    {
      buildImage: async () => 0,
      baseline: async () => false,
    },
  );
  assert.equal(ok, false);
});

// A Docker-free harness for the campaign wave-loop (issue #151). A real on-disk
// event log under a throwaway state dir is what the per-wave re-derive reads and
// what a child `run` would archive — so the loop is exercised for real; only the
// container-bound effects (the child spawn, the git merge, the changelog fold, the
// branch guard) are injected.
const harnessCfg = (dir: string): ResolvedConfig => {
  const stateDir = join(dir, ".vetinari.local");
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(stateDir, "orchestrator.jsonl");
  return {
    project: "harness",
    stateDir,
    parkedDir: join(stateDir, "parked"),
    logFile,
    baseBranch: "base",
    branchPrefix: "agent/",
    log: loggerForRun({ logFile }),
    fetchTask: async () => "",
  } as unknown as ResolvedConfig;
};

// Campaign/queue echo their progress to the console; silence it so the harness
// tests read their result off the event log, not off a wall of run output.
const silenceConsole = async <T>(fn: () => Promise<T>): Promise<T> => {
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
};

// Capture the terminal lines a campaign writes to stdout (the report.ts human lines, or the
// raw event JSONL under --json), restoring console.log afterwards. The #299 output tests read
// the screen the operator sees, not the event log.
const captureLines = async <T>(fn: () => Promise<T>): Promise<string[]> => {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return lines;
};

// The container-bound effects a campaign would otherwise run, stubbed git-free:
// greens merge as-is, no changelog fold, and the base-branch guard passes. Only
// `spawnRun` varies per test — it stands in for the spawned child `run`.
const gitFreeDeps = (
  cfg: ResolvedConfig,
  spawnRun: CampaignDeps["spawnRun"],
): CampaignDeps => ({
  spawnRun,
  integrate: async (_cfg, greens) => ({ merged: greens, conflictParked: [] }),
  collectChangelog: () => ({ collected: [], committed: false }),
  currentBranch: () => cfg.baseBranch,
  // Default grace is a no-op that resolves at once — a wave never blocks a test on real time.
  // A grace test overrides this to observe the wait or to model an answer landing in-window.
  grace: async () => {},
});

test("a wave declares its want as held-plus-pending and refreshes it as the wave drains, never reserving idle slots (#387)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-want-"));
  const cfg = harnessCfg(dir);
  // Ceiling 2 with a three-ticket wave: one ticket stays pending while two run, so
  // the want must move as containers finish rather than sit frozen at the wave size.
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 2, weight: 1 };
  const seen: Record<string, number | undefined> = {};
  // Capture the project's declared want on its lease at the moment each child starts.
  const childRun: CampaignDeps["spawnRun"] = async (id) => {
    seen[id] = readLeases(host.configDir).find((l) => l.project === cfg.project)?.want;
    return 0;
  };
  await silenceConsole(() =>
    campaign(cfg, [["101", "102", "103"]], host, "drain", {}, gitFreeDeps(cfg, childRun)),
  );
  const wants = Object.values(seen).filter((w): w is number => w !== undefined);
  assert.equal(wants.length, 3, "every child observed a declared want");
  // The wave opens declaring it wants all three; by the time the last-admitted ticket
  // spawns a sibling has drained, so the declared want has fallen below the wave size.
  assert.equal(Math.max(...wants), 3, "the wave opens wanting all three tickets");
  assert.ok(Math.min(...wants) < 3, "the want falls as the wave drains — not frozen at the wave size");
});

test("a one-ticket wave declares it wants exactly one slot — the reservation bug (#387)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-want-one-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 8, weight: 2 };
  let seen: number | undefined;
  const childRun: CampaignDeps["spawnRun"] = async () => {
    seen = readLeases(host.configDir).find((l) => l.project === cfg.project)?.want;
    return 0;
  };
  await silenceConsole(() =>
    campaign(cfg, [["101"]], host, "one", {}, gitFreeDeps(cfg, childRun)),
  );
  // A single-ticket wave wants one slot, not its weight-derived cut of the ceiling.
  assert.equal(seen, 1);
});

test("campaign prints human-readable plan/wave/complete lines and NO event JSON to stdout by default (#299)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-report-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  const prev = process.env.VETINARI_JSON;
  delete process.env.VETINARI_JSON;
  const lines = await captureLines(() =>
    campaign(cfg, [["101"], ["201"]], host, "vocab", {}, gitFreeDeps(cfg, async () => 0)),
  );
  if (prev !== undefined) process.env.VETINARI_JSON = prev;
  const text = lines.join("\n");
  assert.match(text, /plan “vocab” · 2 waves/, "the plan, with the campaign name");
  assert.match(text, /▶ wave 1\/2 — #101/, "per-wave progress");
  assert.match(text, /🏆 campaign “vocab” complete · 2 waves onto base/, "the completion line");
  // The screen is human-readable: no raw event line (a JSON object carrying an `event`) leaks.
  const jsonLeaked = lines.some((l) => {
    try {
      return typeof JSON.parse(l)?.event === "string";
    } catch {
      return false;
    }
  });
  assert.equal(jsonLeaked, false, "no event JSON reaches stdout without --json");
});

test("campaign under --json streams the raw event stream and suppresses the human lines (#299)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-report-json-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  const prev = process.env.VETINARI_JSON;
  process.env.VETINARI_JSON = "1";
  const lines = await captureLines(() =>
    campaign(cfg, [["101"], ["201"]], host, "vocab", {}, gitFreeDeps(cfg, async () => 0)),
  );
  if (prev === undefined) delete process.env.VETINARI_JSON;
  else process.env.VETINARI_JSON = prev;
  // Tooling reads clean JSONL: the campaign-start event is on stdout as a parseable line…
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  assert.ok(events.some((e) => e.event === "campaign-start"), "raw events reach stdout under --json");
  // …and none of the human report lines do.
  assert.ok(!lines.some((l) => l.includes("plan “vocab”")), "human plan line suppressed under --json");
  assert.ok(!lines.some((l) => l.includes("🏆")), "human completion line suppressed under --json");
});

test("campaign drives every wave with no Docker — the per-wave re-derive survives a faithful child spawn (#151/#150)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // A faithful stand-in for a spawned child `run`: at startup it consults the real
  // leftover-archive gate honoring the child marker (isChild:true), exactly as
  // cli.mts does — the #150 surface — then reports green. Post-#150 the gate refuses
  // to archive a child, so the campaign's in-flight log survives and the wave-loop
  // re-derives every wave. Revert #150 and this child archives the log mid-wave-0,
  // stranding the plan — the regression class this pins.
  const childRun: CampaignDeps["spawnRun"] = async () => {
    if (shouldArchiveLeftover(cfg, { isChild: true })) archiveRun(cfg);
    return 0;
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101"], ["102"], ["103"]], host, "harness", {}, gitFreeDeps(cfg, childRun)),
  );

  assert.equal(ok, "done");
  const events = readEventLog(cfg);
  const batches = events.filter(
    (e): e is WaveStartEvent => e.event === "wave-start",
  );
  // Every wave in the plan re-derived and ran, in order — the log was never stranded.
  assert.deepEqual(
    batches.map((b) => b.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    batches.map((b) => b.tasks),
    [["101"], ["102"], ["103"]],
  );
  assert.ok(events.some((e) => e.event === "campaign-done"));
});

test("the harness has teeth — a child that archives the parent log (the #150 bug) strands the plan after wave 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // The pre-#150 child: it archives the parent's live log (isChild:false through the
  // same gate), exactly the bug #150 fixed. The archive wipes the campaign's in-flight
  // log mid-wave-0, so the next wave's re-derive finds no plan and the loop stops.
  const archivingChild: CampaignDeps["spawnRun"] = async () => {
    if (shouldArchiveLeftover(cfg, { isChild: false })) archiveRun(cfg);
    return 0;
  };

  await silenceConsole(() =>
    campaign(cfg, [["101"], ["102"], ["103"]], host, "harness", {}, gitFreeDeps(cfg, archivingChild)),
  );

  // With the plan stranded, waves 1 and 2 never start — proof the harness would go
  // red against pre-#150 code, so the faithful-child test above genuinely pins it.
  const batches = readEventLog(cfg).filter((e) => e.event === "wave-start");
  assert.ok(
    batches.length < 3,
    `expected the archive to strand the plan, but ${batches.length} waves ran`,
  );
});

test("campaign stamps its name and titles once on campaign-start, names the completion, and names the operator notes (#174)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-named-"));
  const cfg = harnessCfg(dir);
  const titles: Record<string, string> = { "101": "cache eviction", "102": "warm the cache" };
  cfg.fetchTask = async (id) => JSON.stringify({ title: titles[String(id).replace(/^#/, "")] ?? "" });
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"]], host, "gateway work", {}, gitFreeDeps(cfg, async () => 0)),
  );
  assert.equal(ok, "done");

  const events = readEventLog(cfg);
  // The name and the id→title map are recorded once, on campaign-start (design §2.1); no wave event repeats them.
  const start = events.find((e): e is CampaignStartEvent => e.event === "campaign-start");
  assert.equal(start?.name, "gateway work");
  assert.deepEqual(start?.titles, titles);

  const done = events.find((e): e is CampaignDoneEvent => e.event === "campaign-done");
  assert.equal(done?.name, "gateway work");

  // The operator notes name the run too, so the Telegram feed isn't anonymous mid-campaign.
  const outbox = listOutbox(cfg);
  assert.ok(outbox.find((m) => m.event === "wave-start")?.text.includes("gateway work"));
  assert.ok(outbox.find((m) => m.event === "wave-done")?.text.includes("gateway work"));
});

test("campaign writes no festive-name offset on campaign-start — the name is derived at render, never reserved on a host cursor (#193)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-festive-"));
  const cfg = harnessCfg(dir);
  // One shared host cursor across both campaigns (same configDir) — nothing should consume it.
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  await silenceConsole(() => campaign(cfg, [["101"], ["102"], ["103"]], host, "first", {}, gitFreeDeps(cfg, async () => 0)));
  const firstStart = readEventLog(cfg).find((e): e is CampaignStartEvent => e.event === "campaign-start");
  // No presentation state is written: the festive wave name is derived at render from this
  // event's timestamp, so campaign-start carries no reserved offset.
  assert.equal((firstStart as { festiveOffset?: number } | undefined)?.festiveOffset, undefined);

  // A second campaign in the same project/host writes no offset either — nothing was reserved,
  // so nothing was consumed off the host cursor.
  const cfg2 = harnessCfg(join(dir, "run2"));
  await silenceConsole(() => campaign(cfg2, [["201"]], host, "second", {}, gitFreeDeps(cfg2, async () => 0)));
  const secondStart = readEventLog(cfg2).find((e): e is CampaignStartEvent => e.event === "campaign-start");
  assert.equal((secondStart as { festiveOffset?: number } | undefined)?.festiveOffset, undefined);
});

test("campaign --resume recovers the run's name from the log, not the ignored param (#174)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-resume-named-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Seed a paused campaign: wave 0 (101) already banked green, wave 1 (102) still to run.
  cfg.log.log("campaign-start", {
    waves: [["101"], ["102"]],
    slots: 4,
    name: "seeded run",
    titles: { "101": "cache eviction", "102": "warm the cache" },
  });
  cfg.log.log("green", { taskId: "101", branch: "agent/101", commits: ["abc"] });

  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, "ignored param", { resume: true }, gitFreeDeps(cfg, async () => 0)),
  );
  assert.equal(ok, "done");

  // The redrive re-entered wave 1 and ran 102 (read off the wave-start it re-logged).
  const resumed = readEventLog(cfg).find(
    (e): e is WaveStartEvent => e.event === "wave-start" && e.index === 1,
  );
  assert.deepEqual(resumed?.tasks, ["102"]);

  // The run's name is recovered from campaign-start (design §2.1), never the ignored param: it
  // rides the completion event and every operator note.
  const done = readEventLog(cfg).find((e): e is CampaignDoneEvent => e.event === "campaign-done");
  assert.equal(done?.name, "seeded run");
  const note = listOutbox(cfg).find((m) => m.event === "wave-start");
  assert.ok(note?.text.includes("seeded run"), "the note carries the seeded name");
  assert.ok(!note?.text.includes("ignored param"), "never the ignored --name param");
});

// A CampaignDeps that records which task ids it spawns and which green sets it is asked
// to integrate, so a redrive test can prove work was landed rather than re-run.
const recordingDeps = (
  cfg: ResolvedConfig,
  spawned: string[],
  integrated: string[][],
  spawnRun: CampaignDeps["spawnRun"] = async (id) => {
    spawned.push(id);
    return 0;
  },
): CampaignDeps => ({
  spawnRun: async (id) => spawnRun(id),
  integrate: async (_cfg, greens) => {
    integrated.push(greens);
    return { merged: greens, conflictParked: [] };
  },
  collectChangelog: () => ({ collected: [], committed: false }),
  currentBranch: () => cfg.baseBranch,
  grace: async () => {},
});

// Seed a wave-0 park: 101 merged green, 102 parked — with no `wave-done`, so the wave never
// closed. The base state every redrive-reconciliation test starts from.
const seedParkedWave = (cfg: ResolvedConfig) => {
  cfg.log.log("campaign-start", { waves: [["101", "102"]], slots: 4 });
  cfg.log.log("wave-start", { index: 0, tasks: ["101", "102"] });
  cfg.log.log("green", { taskId: "101", branch: "agent/101", commits: ["a"] });
  cfg.log.log("parked", { taskId: "102", reason: "question" });
  cfg.log.log("campaign-parked", { index: 0, detail: "parked, awaiting a human: 102" });
};

test("redrive re-enters the parked wave and integrates a green-but-unmerged member without respawning it (design §7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-green-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedParkedWave(cfg);
  // The answer landed: 102 ran to green (its record cleared, a `green` logged) — so both
  // members are `completed`, but the wave still never closed.
  cfg.log.log("green", { taskId: "102", branch: "agent/102", commits: ["b"] });

  const spawned: string[] = [];
  const integrated: string[][] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawned, [], "no member of the parked wave was respawned");
  assert.deepEqual(integrated, [["101", "102"]], "both greens were handed to integration to land");
  assert.ok(
    readEventLog(cfg).some((e) => e.event === "wave-done"),
    "the reconciled wave closed",
  );
});

test("the redrive event carries fromWave, landed, and skipped (design §2.1, §7, #314)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-counts-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedParkedWave(cfg);
  cfg.log.log("green", { taskId: "102", branch: "agent/102", commits: ["b"] }); // both completed

  // Integration lands 102 (freshly merged) and recognises 101 as already banked (skipped).
  const deps: CampaignDeps = {
    spawnRun: async () => 0,
    integrate: async (_cfg, greens) => ({
      merged: greens.filter((g) => g !== "101"),
      alreadyMerged: greens.filter((g) => g === "101"),
      conflictParked: [],
    }),
    collectChangelog: () => ({ collected: [], committed: false }),
    currentBranch: () => cfg.baseBranch,
    grace: async () => {},
  };

  const ok = await silenceConsole(() => campaign(cfg, [], host, undefined, { resume: true }, deps));
  assert.equal(ok, "done");
  const redrive = readEventLog(cfg).find((e) => e.event === "redrive") as any;
  assert.equal(redrive.fromWave, 0, "the wave the redrive re-entered");
  assert.equal(redrive.landed, 1, "102 was freshly landed");
  assert.equal(redrive.skipped, 1, "101 was already banked and skipped");
});

test("resolve reads only the wave's members — a stray parked record for a non-member never holds the wave (design §5 step 5, #314)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-nonmember-park-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  // A parked record on disk for #999 — an issue NOT in this campaign (a prune removed it, or
  // another process left it). Every member of the wave goes green.
  seedParkedRecord(cfg, "999");

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"]], host, "harness", {}, gitFreeDeps(cfg, async () => 0)),
  );

  assert.equal(ok, "done", "the stray non-member parked record never held the wave");
  assert.ok(readEventLog(cfg).some((e) => e.event === "wave-done"), "the wave closed");
  assert.ok(readEventLog(cfg).some((e) => e.event === "campaign-done"), "the campaign finished");
});

test("redrive re-runs a parked member whose parked record is gone (a crash, no record), and lands the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-norecord-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedParkedWave(cfg);
  // 102 is parked in the log but has NO on-disk record — a crash-shaped member, re-run on its branch.

  const spawned: string[] = [];
  const integrated: string[][] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawned, ["102"], "the recordless park re-ran — 101 was banked, not respawned");
});

test("reconcileResumeWave resumes a crashed member's session and runs the rest fresh (design §7)", () => {
  // 101 banked (completed), 102 a recordless crash with a resumable session on a branch with
  // commits, 103 unstarted. Only the crash carries a session out; the fresh runs carry none.
  const outcomes = new Map<string, string>([
    ["101", "completed"],
    ["102", "parked"],
    ["103", "unstarted"],
  ]);
  const resumeSessionFor = (id: string) => (id === "102" ? "sess-102" : undefined);
  const { toRun, pre, resume } = reconcileResumeWave(
    ["101", "102", "103"],
    outcomes,
    () => false, // 102's record is gone — a crash holds nothing
    false,
    new Set(),
    resumeSessionFor,
  );

  assert.deepEqual(pre, { "101": "green" }, "the banked member is handed to integration");
  assert.deepEqual(toRun, ["102", "103"], "the crash and the unstarted member both run");
  assert.deepEqual(resume, { "102": "sess-102" }, "only the crash resumes its session; the unstarted runs fresh");
});

test("reconcileResumeWave runs a crashed member fresh when its session cannot be resumed — no commits / non-resumable (design §7)", () => {
  // The resolver yields nothing (no commits on the branch, or a non-resumable provider): the
  // crash still re-runs, but fresh — no session in the resume map.
  const { toRun, resume } = reconcileResumeWave(
    ["102"],
    new Map([["102", "parked"]]),
    () => false,
    false,
    new Set(),
    () => undefined,
  );

  assert.deepEqual(toRun, ["102"], "the crash re-runs");
  assert.deepEqual(resume, {}, "with no resumable session it runs fresh");
});

test("reconcileResumeWave never resumes an answered park or a --override failed re-run (design §7)", () => {
  // The resolver would happily hand a session to either, but the reconciler only consults it on
  // the crash/unstarted spawn paths: an answered park re-runs via its own record, and a failed
  // --override re-run is an explicit fresh start.
  const outcomes = new Map<string, string>([
    ["201", "parked"], // answered park — record present, so parkHoldsWave is false but it is NOT a crash
    ["202", "failed"],
  ]);
  const { toRun, resume } = reconcileResumeWave(
    ["201", "202"],
    outcomes,
    () => false,
    true, // --override
    new Set(),
    () => "SHOULD-NOT-BE-USED",
  );

  assert.deepEqual(toRun.sort(), ["201", "202"], "both re-run");
  assert.deepEqual(resume, { "201": "SHOULD-NOT-BE-USED" }, "the resolver alone gates: the campaign returns undefined for an answered park, never the failed re-run");
});

// Seed a wave-0 crash for 102 that recorded a session before the process died: 101 merged green,
// 102 spawned and finished a turn (session on the log) then the campaign process vanished — a
// crash, reconciled to parked{crash} with no on-disk record.
const seedCrashWithSession = (cfg: ResolvedConfig) => {
  cfg.log.log("campaign-start", { waves: [["101", "102"]], slots: 4 });
  cfg.log.log("wave-start", { index: 0, tasks: ["101", "102"] });
  cfg.log.log("green", { taskId: "101", branch: "agent/101", commits: ["a"] });
  cfg.log.log("spawn", { taskId: "102", running: 1, left: 0 });
  cfg.log.log("turn", { taskId: "102", turn: 0, sessionId: "sess-102", summary: "" });
  cfg.log.log("campaign-parked", { index: 0, detail: "crash" });
};

// A recordingDeps whose spawnRun captures the resume session each spawn was handed, and whose
// branch-commits probe is stubbed (no real git in the harness).
const resumeCapturingDeps = (
  cfg: ResolvedConfig,
  spawns: { id: string; resume?: string }[],
  branchHasCommits: (cfg: ResolvedConfig, id: string) => boolean,
): CampaignDeps => ({
  spawnRun: async (id, resume) => {
    spawns.push({ id, resume });
    return 0;
  },
  integrate: async (_cfg, greens) => ({ merged: greens, conflictParked: [] }),
  collectChangelog: () => ({ collected: [], committed: false }),
  currentBranch: () => cfg.baseBranch,
  grace: async () => {},
  branchHasCommits,
});

test("redrive resumes a crashed member's session when the provider is resumable and the branch has commits (design §7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-resume-"));
  const cfg = harnessCfg(dir); // no agent → claude, resumable
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedCrashWithSession(cfg);

  const spawns: { id: string; resume?: string }[] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, resumeCapturingDeps(cfg, spawns, () => true)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawns, [{ id: "102", resume: "sess-102" }], "the crash re-ran resuming its recorded session");
});

test("redrive runs a crashed member fresh when its branch has no commits (design §7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-nocommits-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedCrashWithSession(cfg);

  const spawns: { id: string; resume?: string }[] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, resumeCapturingDeps(cfg, spawns, () => false)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawns, [{ id: "102", resume: undefined }], "no commits on the branch → a fresh run, no session resumed");
});

test("redrive runs a crashed member fresh when the provider is non-resumable, even with commits (design §7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-nonresumable-"));
  const cfg = harnessCfg(dir);
  (cfg as { agent?: unknown }).agent = { provider: "copilot" }; // non-resumable
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedCrashWithSession(cfg);

  const spawns: { id: string; resume?: string }[] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, resumeCapturingDeps(cfg, spawns, () => true)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawns, [{ id: "102", resume: undefined }], "a non-resumable provider carries no session across a crash → a fresh run");
});

test("redrive re-runs a parked member whose record is ANSWERED, consuming the answer, and lands the rest (design §5 step 3, §7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-answered-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedParkedWave(cfg);
  // 102's parked record is on disk WITH a delivered answer — the re-admit signal. Its record
  // is present but answered, so it re-runs (a plain un-answered record would hold the wave).
  seedParkedRecord(cfg, "102");
  answerParked(cfg, "102", "use approach A");

  const spawned: string[] = [];
  const integrated: string[][] = [];
  // The re-admitted run models the real child consuming the answered record: it clears it.
  const spawnRun: CampaignDeps["spawnRun"] = async (id) => {
    spawned.push(id);
    clearParked(cfg, id);
    return 0;
  };
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated, spawnRun)),
  );

  assert.equal(ok, "done");
  assert.deepEqual(spawned, ["102"], "only the answered park re-ran — 101 was banked, not respawned");
  assert.equal(hasParked(cfg, "102"), false, "the answered record was consumed by the re-run");
});

test("redrive does not spawn a parked member whose record remains; the wave parks again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-unanswered-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  seedParkedWave(cfg);
  // 102's parked record is still on disk — no answer landed.
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(
    join(cfg.parkedDir, "102.json"),
    JSON.stringify({ taskId: "102", reason: "question", branch: "agent/102", question: "?", parkedAt: "2026-08-30T00:00:00Z" }),
  );

  const spawned: string[] = [];
  const integrated: string[][] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated)),
  );

  assert.equal(ok, "parked", "the unresolved park re-parks the wave and stops the campaign");
  assert.deepEqual(spawned, [], "the still-parked member was not respawned");
  // A fresh campaign-park was recorded on the redrive (the second one in the log).
  assert.equal(
    readEventLog(cfg).filter((e) => e.event === "campaign-parked").length,
    2,
    "the redrive re-parked the wave",
  );
});

test("redrive resumes at the parked wave, not past it — a closed earlier wave is skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-index-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  // Wave 0 closed (wave-done), wave 1 parked (102 parked, record present), wave 2 unrun.
  cfg.log.log("campaign-start", { waves: [["101"], ["102"], ["103"]], slots: 4 });
  cfg.log.log("wave-start", { index: 0, tasks: ["101"] });
  cfg.log.log("green", { taskId: "101", branch: "agent/101", commits: ["a"] });
  cfg.log.log("wave-done", { index: 0, merged: ["101"] });
  cfg.log.log("wave-start", { index: 1, tasks: ["102"] });
  cfg.log.log("parked", { taskId: "102", reason: "question" });
  cfg.log.log("campaign-parked", { index: 1, detail: "parked, awaiting a human: 102" });
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(
    join(cfg.parkedDir, "102.json"),
    JSON.stringify({ taskId: "102", reason: "question", branch: "agent/102", question: "?", parkedAt: "2026-08-30T00:00:00Z" }),
  );

  const spawned: string[] = [];
  const integrated: string[][] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated)),
  );

  assert.equal(ok, "parked", "the parked wave 1 stops the redrive again");
  assert.deepEqual(spawned, [], "neither the closed wave 0 nor the still-parked wave 1 respawned");
  // The redrive re-entered wave 1 (its wave-start re-logged), never stepping to wave 2.
  const batches = readEventLog(cfg)
    .filter((e): e is WaveStartEvent => e.event === "wave-start")
    .map((b) => b.index);
  assert.ok(batches.includes(1), "the redrive re-entered the parked wave 1");
  assert.ok(!batches.includes(2), "the redrive never started wave 2 past the unresolved park");
});

test("redrive stops as failed again on a failed member, but re-runs it under --override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-redrive-failed-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };
  const seedFailedWave = () => {
    cfg.log.log("campaign-start", { waves: [["101", "102"]], slots: 4 });
    cfg.log.log("wave-start", { index: 0, tasks: ["101", "102"] });
    cfg.log.log("green", { taskId: "101", branch: "agent/101", commits: ["a"] });
    cfg.log.log("failed", { taskId: "102", detail: "error(1)" });
    cfg.log.log("campaign-failed", { index: 0, detail: "102 failed" });
  };
  seedFailedWave();

  // No override: the failed member holds the wave and the campaign stops as failed again.
  const spawned: string[] = [];
  const integrated: string[][] = [];
  const stopped = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true }, recordingDeps(cfg, spawned, integrated)),
  );
  assert.equal(stopped, "failed", "the failed member stops the redrive as failed");
  assert.deepEqual(spawned, [], "a failed member is not silently re-run without an override");

  // With --override: the operator chose to re-run the failed member.
  const spawned2: string[] = [];
  const integrated2: string[][] = [];
  const ok = await silenceConsole(() =>
    campaign(cfg, [], host, undefined, { resume: true, override: true }, recordingDeps(cfg, spawned2, integrated2)),
  );
  assert.equal(ok, "done", "the overridden failed member re-ran to green and the wave closed");
  assert.deepEqual(spawned2, ["102"], "only the failed member re-ran; 101 stayed banked");
});

test("a graft appended mid-wave lands in a future wave; the loop re-derives and runs it (#166)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-graft-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  const spawned: string[] = [];
  // While wave 0 (task 101) runs, graft 301 onto the campaign. The wave-loop
  // re-derives its plan from the log each boundary, so 301 must appear in a later
  // wave — the in-flight wave 0 is never disturbed.
  const childRun: CampaignDeps["spawnRun"] = async (taskId) => {
    spawned.push(taskId);
    if (taskId === "101") {
      cfg.log.log("graft", { ids: ["301"], blockedBy: {}, fileKeys: {} });
    }
    return 0;
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101"], ["201"]], host, "harness", {}, gitFreeDeps(cfg, childRun)),
  );

  assert.equal(ok, "done");
  const batches = readEventLog(cfg)
    .filter((e): e is WaveStartEvent => e.event === "wave-start")
    .map((b) => b.tasks);
  // Wave 0 ran 101 alone (untouched by the graft); 301 landed in a later wave and ran.
  assert.deepEqual(batches[0], ["101"]);
  assert.ok(batches.slice(1).flat().includes("301"), "grafted 301 ran in a later wave");
  assert.ok(spawned.includes("301"), "the loop actually spawned the grafted issue");
});

test("Gate 1 (ADR 0017): a per-issue park drains its wave, merges the greens, then wave-parks — no next wave starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-park-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Wave 0: 101 goes green, 102 parks (exit 2 → outcome "parked"). The wave drains —
  // 101 still merges under Gate 2 — and then escalates to a wave-park.
  const spawned: string[] = [];
  const childRun: CampaignDeps["spawnRun"] = async (taskId) => {
    spawned.push(taskId);
    return taskId === "102" ? 2 : 0;
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"], ["201"]], host, "harness", {}, gitFreeDeps(cfg, childRun)),
  );

  // The wave wave-parks, so the campaign returns false and never runs the next wave.
  assert.equal(ok, "parked");
  assert.ok(!spawned.includes("201"), "the succeeding wave's issue never spawned");

  const events = readEventLog(cfg);
  const batches = events.filter((e): e is WaveStartEvent => e.event === "wave-start");
  assert.deepEqual(batches.map((b) => b.index), [0], "only wave 0 ran — no succeeding wave started");

  // The wave parked at index 0, the in-flight parked wave.
  const parked = events.filter((e): e is CampaignParkedEvent => e.event === "campaign-parked");
  assert.equal(parked.length, 1, "exactly one campaign-parked event — the existing state, reused");
  assert.equal(parked[0].index, 0, "the parked wave's index is recorded");

  // …and the operator notice went out on the same wave-park channel, naming the green kept merged.
  const notice = listOutbox(cfg).find((r) => r.event === "campaign-parked");
  assert.ok(notice, "a campaignParkedNotice was enqueued for the operator");
  assert.equal(notice?.category, "failure");
  assert.ok(notice?.text.includes("101"), "the green stayed merged on the base");

  // No wave-done closed the wave — it stays the in-flight parked wave, not a completed one.
  assert.ok(
    !events.some((e) => e.event === "wave-done"),
    "the parked wave is not logged done",
  );
});

test("Gate 1: a parked record survives the wave boundary — the boundary clears nothing (design §2.5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-park-rec-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Seed the parked record a parking child would have written — the stubbed spawnRun
  // only returns the exit code, so we place the record the wave boundary must leave alone.
  const parkedRecord = join(cfg.parkedDir, "102.json");
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(parkedRecord, JSON.stringify({ taskId: "102", reason: "question", sessionId: "s1" }));

  const childRun: CampaignDeps["spawnRun"] = async (taskId) => (taskId === "102" ? 2 : 0);

  await silenceConsole(() =>
    campaign(cfg, [["101", "102"]], host, "harness", {}, gitFreeDeps(cfg, childRun)),
  );

  assert.ok(existsSync(parkedRecord), "the parked record survives the wave boundary — resumable, dashboard-visible, answerable");
});

test("re-admit: a parked member answered while the wave still drains re-runs and merges in the same wave (design §5 step 3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-readmit-"));
  const cfg = harnessCfg(dir);
  cfg.parkGraceSeconds = 0; // re-admit during the drain is independent of the boundary grace window
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // 101 drains slowly (its slot stays leased until we resolve it); 102 parks first —
  // writing its on-disk record like a real child — then, while 101 is still in flight,
  // the human's answer is *delivered* to that record (answered, not cleared) and 101 frees
  // its slot. The freed slot re-admits 102 with the answer; the re-run consumes the record
  // (clearing it, as a real child `run` does) and greens. Both greens integrate in this wave.
  let resolve101!: (code: number) => void;
  const p101 = new Promise<number>((r) => (resolve101 = r));
  const spawns: string[] = [];
  let firstPark = true;
  const spawnRun: CampaignDeps["spawnRun"] = (taskId) => {
    spawns.push(taskId);
    if (taskId === "101") return p101;
    if (firstPark) {
      firstPark = false;
      mkdirSync(cfg.parkedDir, { recursive: true });
      writeFileSync(
        join(cfg.parkedDir, "102.json"),
        JSON.stringify({ taskId: "102", reason: "question", branch: "agent/102", question: "?", parkedAt: "2026-08-30T00:00:00Z" }),
      );
      // Deferred to a macrotask so 102 has settled parked-with-record before the answer lands.
      setTimeout(() => {
        answerParked(cfg, "102", "use approach A");
        resolve101(0);
      }, 0);
      return Promise.resolve(2);
    }
    // The re-admitted run models the real child consuming the answered record: it clears it.
    clearParked(cfg, "102");
    return Promise.resolve(0);
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"]], host, "harness", {}, gitFreeDeps(cfg, spawnRun)),
  );

  assert.equal(ok, "done", "the wave completed once the answered park re-ran green");
  const done = readEventLog(cfg).find((e): e is WaveDoneEvent => e.event === "wave-done");
  assert.deepEqual([...(done?.merged ?? [])].sort(), ["101", "102"], "both greens merged in the same wave");
  assert.deepEqual(spawns, ["101", "102", "102"], "102 was re-admitted — spawned once to park, once to re-run");
  assert.equal(hasParked(cfg, "102"), false, "the answered park's record stays cleared");
});

// A parking child would write its on-disk record; the stub only returns the exit code, so a
// grace test writes the record itself to model a genuine question/stalled park awaiting an answer.
const seedParkedRecord = (cfg: ResolvedConfig, taskId: string) => {
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(
    join(cfg.parkedDir, `${taskId}.json`),
    JSON.stringify({ taskId, reason: "question", branch: `agent/${taskId}`, question: "?", parkedAt: "2026-08-30T00:00:00Z" }),
  );
};

test("grace window: a question/stalled park no answer resolves within parkGraceSeconds falls through to a wave-park", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-grace-expiry-"));
  const cfg = harnessCfg(dir);
  cfg.parkGraceSeconds = 30;
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // 101 green, 102 parks and its record stays in place — no answer lands within the window.
  const spawnRun: CampaignDeps["spawnRun"] = async (taskId) => {
    if (taskId === "102") {
      seedParkedRecord(cfg, "102");
      return 2;
    }
    return 0;
  };
  let graceArgs: { ids: string[]; secs: number } | undefined;
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, spawnRun),
    // Expiry: the window ends with the record still on disk — no re-admission.
    grace: async (_c, ids, secs) => {
      graceArgs = { ids, secs };
    },
  };

  const ok = await silenceConsole(() => campaign(cfg, [["101", "102"]], host, "harness", {}, deps));

  assert.equal(ok, "parked", "an unanswered park at expiry stops the campaign");
  assert.deepEqual(graceArgs, { ids: ["102"], secs: 30 }, "the wave waited on 102 for the configured window");
  const grace = readEventLog(cfg).find((e): e is GraceWaitEvent => e.event === "grace-wait");
  assert.equal(grace?.seconds, 30);
  assert.deepEqual(grace?.tasks, ["102"]);
  assert.ok(
    readEventLog(cfg).some((e) => e.event === "campaign-parked"),
    "the wave parked once the window expired",
  );
});

test("grace window: an answer that lands within parkGraceSeconds re-admits the member, which merges in the same wave", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-grace-answered-"));
  const cfg = harnessCfg(dir);
  cfg.parkGraceSeconds = 30;
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  let parked102 = true;
  const spawnRun: CampaignDeps["spawnRun"] = async (taskId) => {
    if (taskId === "102" && parked102) {
      parked102 = false;
      seedParkedRecord(cfg, "102");
      return 2;
    }
    // The re-admitted run models the real child consuming the answered record: it clears it.
    if (taskId === "102") clearParked(cfg, "102");
    return 0; // 101 green; 102 green on re-admission
  };
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, spawnRun),
    // The answer lands inside the window: deliver it to the record so the caller re-admits 102.
    grace: async (c, ids) => {
      for (const id of ids) answerParked(c, id, "use approach A");
    },
  };

  const ok = await silenceConsole(() => campaign(cfg, [["101", "102"]], host, "harness", {}, deps));

  assert.equal(ok, "done", "the in-window answer let the wave finish");
  const done = readEventLog(cfg).find((e): e is WaveDoneEvent => e.event === "wave-done");
  assert.deepEqual([...(done?.merged ?? [])].sort(), ["101", "102"], "the re-admitted member merged in the same wave");
});

test("grace window: a conflict (quarantine) never triggers the wait, even with parkGraceSeconds set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-grace-conflict-"));
  const cfg = harnessCfg(dir);
  cfg.parkGraceSeconds = 30;
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Both green; integration then quarantines 102 on a merge conflict — a conflict park, not a
  // question/stalled member park. No member is `parked`, so the grace window is never entered.
  let graceCalls = 0;
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, async () => 0),
    integrate: async (_cfg, greens) => ({ merged: greens.filter((g) => g !== "102"), conflictParked: ["102"] }),
    grace: async () => {
      graceCalls++;
    },
  };

  const ok = await silenceConsole(() => campaign(cfg, [["101", "102"]], host, "harness", {}, deps));

  // A conflict-parked green holds the wave like any park (design §5 step 5, #310): even with
  // nothing stranded, the campaign parks — it does not slip through to done.
  assert.equal(ok, "parked", "a conflict park holds the wave and stops the campaign");
  assert.equal(graceCalls, 0, "a conflict never waits");
  assert.ok(!readEventLog(cfg).some((e) => e.event === "grace-wait"), "no grace-wait was logged for a conflict");
  // The campaign-parked stop marker carries the wave's reason `conflict` (§2.1 rule 2).
  const parked = readEventLog(cfg).filter((e) => e.event === "campaign-parked");
  assert.equal(parked.length, 1, "exactly one campaign-parked marks the conflict hold");
  assert.equal((parked[0] as any).reason, "conflict", "the wave's reason is conflict");
});

test("grace window: the default parkGraceSeconds of 0 never waits — a park stops the campaign at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-grace-default-"));
  const cfg = harnessCfg(dir);
  cfg.parkGraceSeconds = 0;
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  const spawnRun: CampaignDeps["spawnRun"] = async (taskId) => {
    if (taskId === "102") {
      seedParkedRecord(cfg, "102");
      return 2;
    }
    return 0;
  };
  let graceCalls = 0;
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, spawnRun),
    grace: async () => {
      graceCalls++;
    },
  };

  const ok = await silenceConsole(() => campaign(cfg, [["101", "102"]], host, "harness", {}, deps));

  assert.equal(ok, "parked", "with no grace, the park stops the campaign");
  assert.equal(graceCalls, 0, "the grace waiter is never invoked when the window is 0");
  assert.ok(!readEventLog(cfg).some((e) => e.event === "grace-wait"), "no grace-wait event with the window at 0");
});

test("Gate 2 unchanged: an all-green wave whose combined base gates red still wave-parks via the existing path — Gate 1 does not double-fire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-gate2-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Every issue passes alone (all green), but the merged base gates red with no
  // attributable culprit — the Gate 2 wave-park. `integrateGreens` owns logging the
  // `wave-parked` event; here the stub just reports the red base so we observe the
  // loop's own response: enqueue the notice, stop, and (crucially) not escalate again.
  const spawned: string[] = [];
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, async (taskId) => {
      spawned.push(taskId);
      return 0;
    }),
    integrate: async (_cfg, greens) => ({
      merged: greens,
      conflictParked: [],
      parked: { reason: "red-base", detail: "GATE FAILED" },
    }),
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"], ["201"]], host, "harness", {}, deps),
  );

  assert.equal(ok, "parked", "the red combined base wave-parks");
  assert.ok(!spawned.includes("201"), "no succeeding wave starts on a red base");
  const notice = listOutbox(cfg).find((r) => r.event === "campaign-parked");
  assert.ok(notice, "the existing campaignParkedNotice still goes out");
  // The loop logs exactly one campaign-parked for the red-base park; Gate 1 (the per-issue
  // park path) must not add a second — no issue parked here.
  assert.equal(
    readEventLog(cfg).filter((e) => e.event === "campaign-parked").length,
    1,
    "exactly one campaign-parked — the red-base park; Gate 1 does not double-fire",
  );
});

test("a failed member drains its wave, integrates the greens, then stops the campaign as failed — no next wave (#285)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-fail-"));
  const cfg = harnessCfg(dir);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Wave 0: 101 goes green, 102 fails (child `run` exits 1 → outcome "error(1)"). The wave
  // still drains and 101 still merges under integration; then the failure holds the wave
  // and stops the whole campaign — the next wave never starts.
  const spawned: string[] = [];
  const childRun: CampaignDeps["spawnRun"] = async (taskId) => {
    spawned.push(taskId);
    return taskId === "102" ? 1 : 0;
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["101", "102"], ["201"]], host, "harness", {}, gitFreeDeps(cfg, childRun)),
  );

  assert.equal(ok, "failed", "a failed member stops the campaign non-zero");
  assert.ok(!spawned.includes("201"), "the succeeding wave never starts once a member failed");

  const events = readEventLog(cfg);
  const batches = events.filter((e): e is WaveStartEvent => e.event === "wave-start");
  assert.deepEqual(batches.map((b) => b.index), [0], "only wave 0 ran — no succeeding wave started");

  // The failed member is named on its own `failed` event (logged by queue), and the campaign
  // stop marker carries the failed wave's index.
  const perTaskFailed = events.filter((e): e is FailedEvent => e.event === "failed");
  assert.deepEqual(perTaskFailed.map((f) => f.taskId), ["102"], "the failed member is named on its own failed event");
  const failed = events.filter((e): e is CampaignFailedEvent => e.event === "campaign-failed");
  assert.equal(failed.length, 1, "exactly one campaign-failed stop marker");
  assert.equal(failed[0].index, 0, "the stop marker carries the failed wave's index");

  // The wave is never logged done — it holds, it does not close.
  assert.ok(
    !events.some((e) => e.event === "wave-done"),
    "the failed wave is not logged done",
  );

  // The operator notice went out on the failure channel, naming the green sibling kept merged —
  // a failure never aborts or un-merges a sibling.
  const notice = listOutbox(cfg).find((r) => r.event === "campaign-failed");
  assert.ok(notice, "a campaign-failed notice was enqueued for the operator");
  assert.equal(notice?.category, "failure");
  assert.ok(notice?.text.includes("101"), "the green stayed merged on the base");
});

test("a quarantine that strands later-wave dependents wave-parks the campaign — an explicit terminal event, never a silent stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-campaign-strand-"));
  const cfg = harnessCfg(dir);
  // 701 in the later wave is blocked by 640, so quarantining 640 strands 701.
  cfg.blockedBy = (id: string) => (id.replace(/^#/, "") === "701" ? ["640"] : []);
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 4, weight: 1 };

  // Wave 0 drains green, but integration quarantines 640 on a merge conflict; wave 1's
  // 701 depends on it, so the default (no --auto-prune) pauses the campaign.
  const spawned: string[] = [];
  const deps: CampaignDeps = {
    ...gitFreeDeps(cfg, async (taskId) => {
      spawned.push(taskId);
      return 0;
    }),
    integrate: async (_cfg, _greens) => ({ merged: [], conflictParked: ["640"] }),
  };

  const ok = await silenceConsole(() =>
    campaign(cfg, [["640"], ["701"]], host, "harness", {}, deps),
  );

  assert.equal(ok, "parked", "the stranded quarantine pauses the campaign");
  assert.ok(!spawned.includes("701"), "the stranded later wave never starts");

  // The pause is an explicit campaign-park, so the log is never indistinguishable from a crash.
  const parked = readEventLog(cfg).filter((e): e is CampaignParkedEvent => e.event === "campaign-parked");
  assert.equal(parked.length, 1, "exactly one campaign-parked event marks the pause");
  assert.match(parked[0].detail ?? "", /stranded|conflict/i, "the detail names the stranded-conflict reason");
});

// One event-loop tick — lets the queue's synchronous `fill()` (and its microtask
// chain) run so we can observe the deferred spawners it started before releasing them.
const tick = () => new Promise<void>((r) => setImmediate(r));

// A Docker-free harness for `queue()` (#190): the same on-disk log + injected-deps
// pattern the campaign tests use, but driving `queue` directly. `spawnRun` is a
// deferred/controllable child so the queue fills to the ceiling with every slot held —
// the `spawn` running count is then observable climbing to `host.ceiling` — and
// each task's exit code is chosen per test to pin the outcome map.
test("queue fills to the host ceiling, then writes a spawn per task with climbing running counts (#190)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-queue-"));
  const cfg = harnessCfg(dir);
  const taskIds = ["101", "102", "103"];
  // ceiling >= taskIds.length so a lone project gets the whole ceiling and never hits
  // the 1 s re-drive poll — every task spawns in the first `fill()`.
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 3, weight: 1 };

  const spawned: string[] = [];
  const release: Array<(code: number) => void> = [];
  // Held-open children: each spawn parks a resolver instead of returning, so all three
  // slots stay leased and `running` climbs to the ceiling before any frees.
  const spawnRun: RunSpawner = (taskId) => {
    spawned.push(taskId);
    return new Promise<number>((resolve) => release.push(resolve));
  };

  const draining = silenceConsole(() => queue(cfg, taskIds, host, undefined, spawnRun));

  // Let the queue fill: all three tasks take a slot before any child resolves.
  while (spawned.length < taskIds.length) await tick();
  assert.deepEqual(spawned, taskIds, "each task spawned once, in order, up to the ceiling");

  // Now let every child exit green and the drain complete.
  release.forEach((r) => r(0));
  await draining;

  const events = readEventLog(cfg);
  // No durable queue-start event frames the drain (design §2.1): each task announces itself
  // with a `spawn`, reporting the running count climbing to the ceiling and the queue draining.
  const spawns = events.filter((e): e is SpawnEvent => e.event === "spawn");
  assert.deepEqual(spawns.map((s) => s.taskId), taskIds);
  assert.deepEqual(spawns.map((s) => s.running), [1, 2, 3]);
  assert.deepEqual(spawns.map((s) => s.left), [2, 1, 0]);
});

test("queue returns and logs a per-task outcome map translating each child's exit code (#190)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-queue-outcomes-"));
  const cfg = harnessCfg(dir);
  const taskIds = ["101", "102", "103"];
  const host: HostBudget = { configDir: join(dir, "host"), ceiling: 3, weight: 1 };

  // `run`'s exit-code contract: 0 → green, 2 → parked, anything else → error(n).
  const codes: Record<string, number> = { "101": 0, "102": 2, "103": 7 };
  const spawnRun: RunSpawner = async (taskId) => codes[taskId];

  const outcomes = await silenceConsole(() => queue(cfg, taskIds, host, undefined, spawnRun));

  const expected = { "101": "green", "102": "parked", "103": "error(7)" };
  assert.deepEqual(outcomes, expected, "the returned map is the caller's greens without re-deriving from the log");

  // No durable queue-done event: a member the agent could not make green is folded to its own
  // `failed` event (design §2.1) so the reducer holds its wave; green/parked members carry their
  // own rows from the run loop.
  const failed = readEventLog(cfg).filter((e): e is FailedEvent => e.event === "failed");
  assert.deepEqual(failed.map((f) => f.taskId), ["103"], "only the errored member is folded to a failed event");
  assert.equal(failed[0].detail, "error(7)", "the failed event carries the translated exit code");
});
