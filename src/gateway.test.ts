import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "./registry.ts";
import { enqueueOutbound, listOutboxIn, outboxDirOf, type ParkedRecord } from "./state.ts";
import { memoryLogger } from "./log.ts";
import type { TgConn } from "./telegram.ts";
import {
  drainOutbox,
  formatGatewayStatus,
  handleCarveCommand,
  isStatusCommand,
  loadGatewayProjects,
  newPendingConfirms,
  newReplyIndex,
  parseGatewayCommand,
  pendingAnnouncements,
  pollLoop,
  pollTargets,
  rebuildIndex,
  reconcilePollTargets,
  recordSend,
  supervisePolls,
  resolveCarveTarget,
  resolveReply,
  routeReply,
  type GatewayProject,
  type PendingConfirm,
  type SendRef,
} from "./gateway.ts";

let gwCounter = 0;

const project = (over: Partial<GatewayProject> = {}): GatewayProject => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.vetinari.local",
  conn: { token: "botA", chat: "-100" },
  parked: [],
  outbox: [],
  ...over,
});

const parked = (over: Partial<ParkedRecord> = {}): ParkedRecord => ({
  taskId: "640",
  parkedAt: "2026-08-22T00:00:00.000Z",
  reason: "blocked",
  sessionId: "s",
  branch: "agent/640",
  question: "Which approach?",
  ...over,
});

const ref = (over: Partial<SendRef> = {}): SendRef => ({
  project: "jjforge",
  task: "640",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.vetinari.local",
  parkedAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

test("resolveReply returns the ref recorded for that (bot token, message id)", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, ref({ task: "640" }));

  assert.deepEqual(resolveReply(index, "botA", 100), ref({ task: "640" }));
});

test("resolveReply disambiguates a shared bot by which message the reply targets", () => {
  const index = newReplyIndex();
  // Two projects share one bot token; each question is a distinct message id.
  recordSend(index, "shared", 100, ref({ project: "alpha", task: "A1", baseLocation: "/a" }));
  recordSend(index, "shared", 200, ref({ project: "beta", task: "B1", baseLocation: "/b" }));

  assert.equal(resolveReply(index, "shared", 100)?.project, "alpha");
  assert.equal(resolveReply(index, "shared", 200)?.project, "beta");
});

test("resolveReply returns null for a message id it never recorded", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, ref());

  assert.equal(resolveReply(index, "botA", 999), null);
  assert.equal(resolveReply(index, "otherBot", 100), null);
});

test("pollTargets collapses projects sharing a bot to one connection per token", () => {
  const targets = pollTargets([
    project({ project: "alpha", conn: { token: "shared", chat: "-1" } }),
    project({ project: "beta", conn: { token: "shared", chat: "-2" } }),
    project({ project: "gamma", conn: { token: "solo", chat: "-3" } }),
  ]);

  assert.deepEqual(
    targets.map((t) => t.token),
    ["shared", "solo"],
  );
});

test("pollTargets skips a project that configures no Telegram connection", () => {
  const targets = pollTargets([
    project({ project: "alpha", conn: { token: "botA", chat: "-1" } }),
    project({ project: "beta", conn: undefined }),
  ]);

  assert.deepEqual(
    targets.map((t) => t.token),
    ["botA"],
  );
});

test("reconcilePollTargets starts a loop for a newly-appeared token and leaves a persisting one alone", () => {
  const { start, stop } = reconcilePollTargets(
    ["shared"],
    [
      { token: "shared", chat: "-1" },
      { token: "fresh", chat: "-2" },
    ],
  );

  assert.deepEqual(
    start.map((c) => c.token),
    ["fresh"],
    "only the token not already polled is started",
  );
  assert.deepEqual(stop, [], "a token that persists is never torn down, so its offset is preserved");
});

test("reconcilePollTargets stops a loop whose token vanished (deregistered or rotated away)", () => {
  const { start, stop } = reconcilePollTargets(["old", "kept"], [{ token: "kept", chat: "-1" }]);

  assert.deepEqual(start, [], "nothing new to start");
  assert.deepEqual(stop, ["old"], "the token no longer among the targets is torn down");
});

test("reconcilePollTargets both stops the rotated-away token and starts its replacement", () => {
  // A project rotates its bot token: the old token disappears from the targets
  // and its replacement appears — one tick tears the old loop down and starts one
  // for the new token.
  const { start, stop } = reconcilePollTargets(["old"], [{ token: "new", chat: "-1" }]);

  assert.deepEqual(
    start.map((c) => c.token),
    ["new"],
  );
  assert.deepEqual(stop, ["old"]);
});

test("pendingAnnouncements returns parked records that carry no announced message id", () => {
  const pend = pendingAnnouncements(
    [
      project({
        project: "alpha",
        parked: [parked({ taskId: "A1" }), parked({ taskId: "A2", tgMessageId: 55 })],
      }),
    ],
    newReplyIndex(),
  );

  assert.deepEqual(
    pend.map((a) => a.record.taskId),
    ["A1"],
  );
  assert.equal(pend[0].project, "alpha");
  assert.equal(pend[0].conn.token, "botA");
});

test("pendingAnnouncements skips a project with no destination to announce to", () => {
  const pend = pendingAnnouncements([project({ conn: undefined, parked: [parked({ taskId: "A1" })] })], newReplyIndex());

  assert.deepEqual(pend, []);
});

test("pendingAnnouncements skips a record already announced this session via the index", () => {
  const index = newReplyIndex();
  const rec = parked({ taskId: "A1", parkedAt: "t1" });
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const pend = pendingAnnouncements([project({ project: "alpha", parked: [rec] })], index);

  assert.deepEqual(pend, []);
});

test("rebuildIndex re-announces nothing but still routes a reply to a persisted question", () => {
  const projects = [
    project({ project: "alpha", conn: { token: "botA", chat: "-1" }, parked: [parked({ taskId: "A1", parkedAt: "t1", tgMessageId: 100 })] }),
  ];
  const index = rebuildIndex(projects);

  assert.deepEqual(pendingAnnouncements(projects, index), []);
  const routed = resolveReply(index, "botA", 100);
  assert.equal(routed?.project, "alpha");
  assert.equal(routed?.task, "A1");
});

const conn: TgConn = { token: "botA", chat: "-100" };
const noPending = () => newPendingConfirms(() => 0);

test("routeReply routes a reply-to-question message to a resume of that task", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const action = routeReply(index, noPending(), conn, { text: "use approach B", replyToId: 100 });

  assert.equal(action.kind, "resume");
  assert.equal(action.kind === "resume" && action.ref.task, "A1");
  assert.equal(action.kind === "resume" && action.text, "use approach B");
});

test("routeReply treats a /status message as a status query, not an answer", () => {
  const action = routeReply(newReplyIndex(), noPending(), conn, { text: "/status" });

  assert.equal(action.kind, "status");
});

test("routeReply routes a carve command to a carve action, not a resume", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const action = routeReply(index, noPending(), conn, { text: "carve jjforge 640" });

  assert.equal(action.kind, "carve");
  assert.deepEqual(action.kind === "carve" && action.command, { project: "jjforge", issue: "640" });
});

test("routeReply routes a yes replying to a live preview to a confirm of that carve", () => {
  const pending = noPending();
  pending.record("botA", 500, pendingConfirm({ issue: "640" }));

  const action = routeReply(newReplyIndex(), pending, conn, { text: "yes", replyToId: 500 });

  assert.equal(action.kind, "confirm");
  assert.deepEqual(action.kind === "confirm" && action.confirm, pendingConfirm({ issue: "640" }));
});

test("routeReply leaves a stray yes with nothing pending unrouted", () => {
  const action = routeReply(newReplyIndex(), noPending(), conn, { text: "yes", replyToId: 500 });

  assert.equal(action.kind, "unrouted");
});

test("routeReply resumes a task answered with the word yes when no carve is pending", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  // A `yes` replying to a parked question — not a preview — answers that task.
  const action = routeReply(index, noPending(), conn, { text: "yes", replyToId: 100 });

  assert.equal(action.kind, "resume");
  assert.equal(action.kind === "resume" && action.ref.task, "A1");
  assert.equal(action.kind === "resume" && action.text, "yes");
});

test("routeReply leaves a reply that matches no question unrouted", () => {
  const action = routeReply(newReplyIndex(), noPending(), conn, { text: "hello?", replyToId: 999 });

  assert.equal(action.kind, "unrouted");
});

test("routeReply leaves a plain (non-reply) message unrouted — a shared bot needs the reply target", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const action = routeReply(index, noPending(), conn, { text: "yes" });

  assert.equal(action.kind, "unrouted");
});

test("pollLoop drives exactly one resume of the right task from one fake reply", async () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });
  recordSend(index, "botA", 200, { project: "alpha", task: "A2", projectRoot: "/r", baseLocation: "/b", parkedAt: "t2" });

  const resumes: Array<{ task: string; text: string }> = [];
  // The injected poller yields one reply (to A1's question), then signals stop.
  let served = false;
  const poll = async () => {
    if (served) return null;
    served = true;
    return { offset: 1, messages: [{ text: "go with B", replyToId: 100 }] };
  };

  await pollLoop(conn, index, noPending(), { poll, resume: (ref, text) => resumes.push({ task: ref.task, text }) });

  assert.deepEqual(resumes, [{ task: "A1", text: "go with B" }]);
});

test("pollLoop hands a /status message to the injected status handler, not resume", async () => {
  let statusCalls = 0;
  let resumeCalls = 0;
  let served = false;
  const poll = async () => {
    if (served) return null;
    served = true;
    return { offset: 1, messages: [{ text: "/status" }] };
  };

  await pollLoop(conn, newReplyIndex(), noPending(), {
    poll,
    resume: () => resumeCalls++,
    onStatus: () => {
      statusCalls++;
    },
  });

  assert.equal(statusCalls, 1);
  assert.equal(resumeCalls, 0);
});

test("pollLoop hands a carve command to onCarve and a confirming yes to onConfirm", async () => {
  const pending = noPending();
  pending.record("botA", 500, pendingConfirm({ issue: "640" }));
  const carves: Array<{ project?: string; issue: string }> = [];
  const confirms: PendingConfirm[] = [];
  let served = false;
  const poll = async () => {
    if (served) return null;
    served = true;
    return {
      offset: 1,
      messages: [
        { text: "carve 641" },
        { text: "yes", replyToId: 500 },
      ],
    };
  };

  await pollLoop(conn, newReplyIndex(), pending, {
    poll,
    resume: () => {},
    onCarve: (_c, command) => {
      carves.push(command);
    },
    onConfirm: (confirm) => {
      confirms.push(confirm);
    },
  });

  assert.deepEqual(carves, [{ issue: "641" }]);
  assert.deepEqual(confirms, [pendingConfirm({ issue: "640" })]);
});

test("pollLoop stops when its abort signal fires, so a rotated-away token's loop tears down", async () => {
  const ac = new AbortController();
  let cycles = 0;
  // The poller yields an empty cycle each time; the signal aborts after the first,
  // so the loop must not poll a second time.
  const poll = async () => {
    cycles++;
    ac.abort();
    return { offset: cycles, messages: [] };
  };

  await pollLoop(conn, newReplyIndex(), noPending(), { poll, resume: () => {}, signal: ac.signal });

  assert.equal(cycles, 1, "the loop exits after the abort rather than polling again");
});

test("pollLoop never polls when handed an already-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  let polled = false;

  await pollLoop(conn, newReplyIndex(), noPending(), {
    poll: async () => {
      polled = true;
      return { offset: 1, messages: [] };
    },
    resume: () => {},
    signal: ac.signal,
  });

  assert.equal(polled, false, "an already-torn-down target is never polled");
});

test("pollLoop advances the offset it passes to the poller across cycles", async () => {
  const offsets: number[] = [];
  const results = [
    { offset: 5, messages: [] },
    { offset: 9, messages: [] },
  ];
  const poll = async (_c: TgConn, offset: number) => {
    offsets.push(offset);
    return results.shift() ?? null;
  };

  await pollLoop(conn, newReplyIndex(), noPending(), { poll, resume: () => {} }, 2);

  assert.deepEqual(offsets, [2, 5, 9]);
});

// --- The poll supervisor: keeps the running poll loops in sync with the live
// targets across ticks. `targets` (live compute), `start` (spin up a loop), and
// `tick` (sleep one interval, or stop) are injected so the reconcile behaviour is
// testable without real bots or timers.

const scriptedTargets = (frames: TgConn[][]) => {
  let i = 0;
  return () => frames[Math.min(i++, frames.length - 1)];
};

// `tick` returns true `n` times then false, ending the supervisor after n+1 passes.
const ticksThenStop = (n: number) => {
  let left = n;
  return async () => left-- > 0;
};

const recordingStart = () => {
  const started: Array<{ token: string; signal: AbortSignal }> = [];
  return { started, start: (conn: TgConn, signal: AbortSignal) => started.push({ token: conn.token, signal }) };
};

test("supervisePolls starts one loop per initial target", async () => {
  const { started, start } = recordingStart();

  await supervisePolls(
    scriptedTargets([[{ token: "botA", chat: "-1" }, { token: "botB", chat: "-2" }]]),
    start,
    ticksThenStop(0),
  );

  assert.deepEqual(
    started.map((s) => s.token),
    ["botA", "botB"],
  );
});

test("supervisePolls begins polling a newly-registered bot on a later tick without restarting the existing one", async () => {
  const { started, start } = recordingStart();

  await supervisePolls(
    scriptedTargets([
      [{ token: "botA", chat: "-1" }],
      [{ token: "botA", chat: "-1" }, { token: "botB", chat: "-2" }],
    ]),
    start,
    ticksThenStop(1),
  );

  assert.deepEqual(
    started.map((s) => s.token),
    ["botA", "botB"],
    "botA is started once and left alone; botB begins on the tick it appears",
  );
});

test("supervisePolls tears down a rotated-away token's loop and starts its replacement", async () => {
  const { started, start } = recordingStart();

  await supervisePolls(
    scriptedTargets([[{ token: "old", chat: "-1" }], [{ token: "new", chat: "-1" }]]),
    start,
    ticksThenStop(1),
  );

  assert.deepEqual(
    started.map((s) => s.token),
    ["old", "new"],
  );
  assert.equal(started[0].signal.aborted, true, "the rotated-away loop's signal is aborted so it tears down");
  assert.equal(started[1].signal.aborted, false, "the replacement loop keeps running");
});

test("formatGatewayStatus summarizes each served project and its parked questions", () => {
  const text = formatGatewayStatus([
    project({ project: "alpha", parked: [parked({ taskId: "A1", reason: "blocked" }), parked({ taskId: "A2", reason: "budget" })] }),
    project({ project: "beta", parked: [] }),
  ]);

  assert.match(text, /alpha/);
  assert.match(text, /A1/);
  assert.match(text, /blocked/);
  assert.match(text, /A2/);
  assert.match(text, /beta/);
  // beta has nothing parked — it still appears, marked as having no questions.
  assert.match(text, /beta[\s\S]*nothing parked/i);
});

test("formatGatewayStatus reports when no served project has anything parked", () => {
  const text = formatGatewayStatus([project({ project: "alpha", parked: [] })]);

  assert.match(text, /nothing parked/i);
});

test("loadGatewayProjects reads each live project's connection and parked records from its base location", () => {
  const configDir = join(tmpdir(), `vetinari-gw-load-${Date.now()}-${gwCounter++}`);
  const base = join(tmpdir(), `vetinari-gw-base-${Date.now()}-${gwCounter++}`, ".vetinari.local");
  mkdirSync(join(base, "parked"), { recursive: true });
  writeFileSync(join(base, "host.env"), "VETINARI_TELEGRAM_BOT_TOKEN=tok\nVETINARI_TELEGRAM_CHAT_ID=chat\n");
  writeFileSync(
    join(base, "parked", "A1.json"),
    JSON.stringify({ taskId: "A1", parkedAt: "t1", reason: "blocked", sessionId: "s", branch: "agent/A1", question: "?" }),
  );
  register(configDir, { project: "alpha", projectRoot: "/home/me/alpha", baseLocation: base });

  const projects = loadGatewayProjects(configDir);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].project, "alpha");
  assert.deepEqual(projects[0].conn, { token: "tok", chat: "chat", thread: undefined });
  assert.deepEqual(
    projects[0].parked.map((p) => p.taskId),
    ["A1"],
  );
});

test("loadGatewayProjects skips a stale registration whose base location is gone", () => {
  const configDir = join(tmpdir(), `vetinari-gw-stale-${Date.now()}-${gwCounter++}`);
  register(configDir, { project: "ghost", projectRoot: "/gone", baseLocation: join(tmpdir(), `vetinari-gw-missing-${Date.now()}-${gwCounter++}`) });

  assert.deepEqual(loadGatewayProjects(configDir), []);
});

test("isStatusCommand recognizes status queries and ignores answers", () => {
  for (const t of ["/status", "status", "/status@my_bot", "  Status ", "STATUS"]) assert.equal(isStatusCommand(t), true, t);
  for (const t of ["A", "use option B", "status of the world is fine", "", "s"]) assert.equal(isStatusCommand(t), false, t);
});

test("parseGatewayCommand recognizes status, carve, and a confirming yes", () => {
  assert.deepEqual(parseGatewayCommand("/status"), { kind: "status" });
  assert.deepEqual(parseGatewayCommand("status"), { kind: "status" });
  assert.deepEqual(parseGatewayCommand("carve 640"), { kind: "carve", issue: "640" });
  assert.deepEqual(parseGatewayCommand("carve #640"), { kind: "carve", issue: "640" });
  assert.deepEqual(parseGatewayCommand("  Carve 640 "), { kind: "carve", issue: "640" });
  assert.deepEqual(parseGatewayCommand("carve jjforge 640"), { kind: "carve", project: "jjforge", issue: "640" });
  assert.deepEqual(parseGatewayCommand("yes"), { kind: "confirm" });
  assert.deepEqual(parseGatewayCommand("  YES "), { kind: "confirm" });
});

test("parseGatewayCommand does not mistake a one-word answer for a command", () => {
  for (const t of ["A", "640", "use option B", "carve", "carve foo", "carve a b c", "yeah", ""]) {
    assert.equal(parseGatewayCommand(t), null, t);
  }
});

const candidate = (over: Partial<GatewayProject> = {}, running = true) => ({
  project: project(over),
  running,
});

test("resolveCarveTarget targets the sole running campaign on the bot", () => {
  const res = resolveCarveTarget(
    [
      candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, true),
      candidate({ project: "beta", conn: { token: "botA", chat: "-2" } }, false),
    ],
    { token: "botA", chat: "-1" },
  );

  assert.equal(res.kind, "target");
  assert.equal(res.kind === "target" && res.project.project, "alpha");
});

test("resolveCarveTarget rejects as ambiguous when several campaigns run on the bot", () => {
  const res = resolveCarveTarget(
    [
      candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, true),
      candidate({ project: "beta", conn: { token: "botA", chat: "-2" } }, true),
    ],
    { token: "botA", chat: "-1" },
  );

  assert.equal(res.kind, "ambiguous");
  assert.deepEqual(res.kind === "ambiguous" && res.candidates.map((p) => p.project), ["alpha", "beta"]);
});

test("resolveCarveTarget rejects with none when nothing is running on the bot", () => {
  const res = resolveCarveTarget(
    [candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, false)],
    { token: "botA", chat: "-1" },
  );

  assert.equal(res.kind, "none");
});

test("resolveCarveTarget ignores projects served by a different bot", () => {
  const res = resolveCarveTarget(
    [
      candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, true),
      candidate({ project: "other", conn: { token: "botB", chat: "-9" } }, true),
    ],
    { token: "botA", chat: "-1" },
  );

  assert.equal(res.kind, "target");
  assert.equal(res.kind === "target" && res.project.project, "alpha");
});

test("resolveCarveTarget with an explicit project targets it past the ambiguity", () => {
  const res = resolveCarveTarget(
    [
      candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, true),
      candidate({ project: "beta", conn: { token: "botA", chat: "-2" } }, true),
    ],
    { token: "botA", chat: "-1" },
    "beta",
  );

  assert.equal(res.kind, "target");
  assert.equal(res.kind === "target" && res.project.project, "beta");
});

test("resolveCarveTarget with an explicit project that has no running campaign rejects", () => {
  const res = resolveCarveTarget(
    [
      candidate({ project: "alpha", conn: { token: "botA", chat: "-1" } }, true),
      candidate({ project: "beta", conn: { token: "botA", chat: "-2" } }, false),
    ],
    { token: "botA", chat: "-1" },
    "beta",
  );

  assert.equal(res.kind, "none");
});

const pendingConfirm = (over: Partial<PendingConfirm> = {}): PendingConfirm => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.vetinari.local",
  issue: "640",
  ...over,
});

test("pendingConfirms records a preview and resolves a reply to it", () => {
  const store = newPendingConfirms(() => 0);
  store.record("botA", 100, pendingConfirm({ issue: "640" }));

  assert.deepEqual(store.resolve("botA", 100), pendingConfirm({ issue: "640" }));
});

test("pendingConfirms returns null for a yes with nothing pending", () => {
  const store = newPendingConfirms(() => 0);
  store.record("botA", 100, pendingConfirm());

  assert.equal(store.resolve("botA", 999), null, "a reply to a message with no pending confirm is ignored");
  assert.equal(store.resolve("otherBot", 100), null, "another bot's message id does not match");
});

test("pendingConfirms is one-shot — a confirm resolves at most once", () => {
  const store = newPendingConfirms(() => 0);
  store.record("botA", 100, pendingConfirm());

  assert.ok(store.resolve("botA", 100), "first yes resolves");
  assert.equal(store.resolve("botA", 100), null, "a second yes to the same preview is ignored");
});

test("pendingConfirms drops a confirmation older than its TTL", () => {
  let clock = 0;
  const store = newPendingConfirms(() => clock, 60_000);
  store.record("botA", 100, pendingConfirm());

  clock = 60_001; // past the TTL
  assert.equal(store.resolve("botA", 100), null, "an expired confirmation is not honored");
});

// --- The carve-command handler: resolve → preview → record. The closure preview
// (which shells `carve --dry-run`) and the Telegram send are injected, so the
// resolve/preview/record flow is testable without a bot or a spawned process.

const carveHandlerDeps = (candidates: GatewayProject[], previewText: string | null = "would drop #640, #641") => {
  const sends: Array<{ chat: string; text: string }> = [];
  const previews: PendingConfirm[] = [];
  let id = 500;
  return {
    sends,
    previews,
    deps: {
      candidates: () => candidates.map((project) => ({ project, running: true })),
      preview: async (target: PendingConfirm) => {
        previews.push(target);
        return previewText;
      },
      send: async (conn: TgConn, text: string) => {
        sends.push({ chat: conn.chat, text });
        return id++;
      },
    },
  };
};

test("handleCarveCommand previews the closure and records a pending confirm keyed to it", async () => {
  const { sends, previews, deps } = carveHandlerDeps([project({ project: "alpha", conn: { token: "botA", chat: "-1" } })]);
  const pending = newPendingConfirms(() => 0);

  await handleCarveCommand(deps, pending, { token: "botA", chat: "-1" }, { issue: "640" });

  assert.deepEqual(
    previews.map((p) => [p.project, p.issue]),
    [["alpha", "640"]],
    "the resolved project's carve is previewed for the named issue",
  );
  assert.equal(sends.length, 1, "exactly the preview is sent");
  assert.match(sends[0].text, /would drop #640, #641/);
  // The preview's message id (500, the first send) carries the pending confirm.
  assert.deepEqual(pending.resolve("botA", 500)?.issue, "640");
});

test("handleCarveCommand rejects an ambiguous carve with the candidate list and records nothing", async () => {
  const { sends, previews, deps } = carveHandlerDeps([
    project({ project: "alpha", conn: { token: "botA", chat: "-1" } }),
    project({ project: "beta", conn: { token: "botA", chat: "-1" } }),
  ]);
  const pending = newPendingConfirms(() => 0);

  await handleCarveCommand(deps, pending, { token: "botA", chat: "-1" }, { issue: "640" });

  assert.equal(previews.length, 0, "an ambiguous carve is never previewed");
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /alpha/);
  assert.match(sends[0].text, /beta/);
  assert.match(sends[0].text, /carve (alpha|beta) 640/, "tells the user how to disambiguate");
  assert.equal(pending.resolve("botA", 500), null, "nothing is left pending");
});

test("handleCarveCommand rejects when nothing is running and records nothing", async () => {
  const { sends, previews, deps } = carveHandlerDeps([]);
  const pending = newPendingConfirms(() => 0);

  await handleCarveCommand(deps, pending, { token: "botA", chat: "-1" }, { issue: "640" });

  assert.equal(previews.length, 0);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /nothing (is )?running|no campaign/i);
  assert.equal(pending.resolve("botA", 500), null);
});

// --- Outbox drain-and-route (E4). Records live in a real tmp outbox so the drain
// can mark them sent; the actual Telegram send is injected and recorded.

let obCounter = 0;
const outboxBase = () => join(tmpdir(), `vetinari-gw-outbox-${Date.now()}-${obCounter++}`, ".vetinari.local");

const routed = (base: string, over: Partial<GatewayProject> = {}): GatewayProject => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: base,
  conn: { token: "tok", chat: "-1" },
  destinations: { ops: { bot: "main", chat: "-100" }, alerts: { bot: "main", chat: "-200" } },
  notify: { "*": "ops", failure: "alerts", "progress:carve": "alerts" },
  parked: [],
  outbox: listOutboxIn(outboxDirOf(base)),
  ...over,
});

const recordingSend = () => {
  const sends: Array<{ chat: string; text: string }> = [];
  let id = 100;
  const send = async (conn: TgConn, text: string) => {
    sends.push({ chat: conn.chat, text });
    return id++;
  };
  return { sends, send };
};

test("drainOutbox routes each record to the destination its category resolves and marks it sent once", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "success", event: "green", text: "GREEN on 26" });
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "failure", event: "halt", text: "campaign HALTED" });
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "progress", event: "carve", text: "carved #640" });
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "progress", event: "wave-start", text: "batch 1" });

  const { sends, send } = recordingSend();
  await drainOutbox(routed(base), send, memoryLogger());

  // success:green → wildcard ops (-100); failure → alerts (-200);
  // progress:carve → alerts (-200); progress:wave-start → wildcard ops (-100).
  // Intra-tick order is unspecified, so assert each message's destination by text.
  const chatOf = new Map(sends.map((s) => [s.text, s.chat]));
  assert.equal(sends.length, 4, "every record is sent exactly once");
  assert.equal(chatOf.get("GREEN on 26"), "-100");
  assert.equal(chatOf.get("campaign HALTED"), "-200");
  assert.equal(chatOf.get("carved #640"), "-200");
  assert.equal(chatOf.get("batch 1"), "-100");

  const after = listOutboxIn(outboxDirOf(base));
  assert.equal(after.length, 4);
  assert.ok(
    after.every((r) => r.sentAt),
    "every routed record is marked sent",
  );
});

test("drainOutbox emits its routing events to the injected Logger, not a global", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "success", event: "green", text: "GREEN" });

  const logger = memoryLogger();
  const { send } = recordingSend();
  await drainOutbox(routed(base), send, logger);

  assert.ok(
    logger.events.some((e) => (e.event as string) === "gateway-routed"),
    "a routed record is logged to the injected logger",
  );
});

test("drainOutbox is idempotent — a second drain re-sends nothing", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "success", event: "green", text: "GREEN" });

  const first = recordingSend();
  await drainOutbox(routed(base), first.send, memoryLogger());
  assert.equal(first.sends.length, 1);

  // A gateway restart re-reads the (now-stamped) outbox and must not re-send.
  const second = recordingSend();
  await drainOutbox(routed(base), second.send, memoryLogger());
  assert.equal(second.sends.length, 0, "an already-sent record is skipped");
});

test("drainOutbox falls back to the project's default connection when no notify map routes it", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "progress", event: "queue-start", text: "queue up" });

  const { sends, send } = recordingSend();
  await drainOutbox(routed(base, { notify: undefined, destinations: undefined }), send, memoryLogger());

  assert.deepEqual(
    sends.map((s) => s.chat),
    ["-1"],
    "with no routing configured, everything goes to the project's default chat",
  );
});

test("drainOutbox reports the default destination — never undefined — when no notify map routes a delivered record", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "progress", event: "queue-start", text: "queue up" });

  const { send } = recordingSend();
  const results = await drainOutbox(routed(base, { notify: undefined, destinations: undefined }), send, memoryLogger());

  assert.deepEqual(
    results.map((r) => r.destination),
    ["default"],
    "a default-chat delivery reports the default marker, not undefined",
  );
  assert.equal(
    listOutboxIn(outboxDirOf(base))[0].destination,
    "default",
    "the stamped record carries the default marker so the dashboard/log never read undefined",
  );
});

test("drainOutbox keeps the named destination on a record its notify map routes", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "failure", event: "halt", text: "campaign HALTED" });

  const { send } = recordingSend();
  const results = await drainOutbox(routed(base), send, memoryLogger()); // notify maps failure → alerts

  assert.deepEqual(results.map((r) => r.destination), ["alerts"], "a mapped record keeps its resolved destination name");
  assert.equal(listOutboxIn(outboxDirOf(base))[0].destination, "alerts");
});

test("drainOutbox skips a project with no connection, leaving its records unsent for a later tick", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "success", event: "green", text: "GREEN" });

  const { sends, send } = recordingSend();
  await drainOutbox(routed(base, { conn: undefined }), send, memoryLogger());

  assert.equal(sends.length, 0, "nothing is sent when the project has no bot");
  assert.equal(listOutboxIn(outboxDirOf(base))[0].sentAt, undefined, "the record stays unsent");
});

test("drainOutbox leaves a record unsent when the send fails, so the next tick retries it", async () => {
  const base = outboxBase();
  enqueueOutbound({ stateDir: base, log: memoryLogger() }, { category: "success", event: "green", text: "GREEN" });

  const failingSend = async () => undefined; // Telegram rejected — no message id
  await drainOutbox(routed(base), failingSend, memoryLogger());

  assert.equal(listOutboxIn(outboxDirOf(base))[0].sentAt, undefined, "a failed send is not marked sent");
});
