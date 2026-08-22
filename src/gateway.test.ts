import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "./registry.ts";
import type { ParkedRecord } from "./state.ts";
import type { TgConn } from "./telegram.ts";
import {
  formatGatewayStatus,
  isStatusCommand,
  loadGatewayProjects,
  newReplyIndex,
  pendingAnnouncements,
  pollLoop,
  pollTargets,
  rebuildIndex,
  recordSend,
  resolveReply,
  routeReply,
  type GatewayProject,
  type SendRef,
} from "./gateway.ts";

let gwCounter = 0;

const project = (over: Partial<GatewayProject> = {}): GatewayProject => ({
  project: "jjforge",
  projectRoot: "/home/me/code/jjforge",
  baseLocation: "/home/me/code/jjforge/.sandcastle.local",
  conn: { token: "botA", chat: "-100" },
  parked: [],
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
  baseLocation: "/home/me/code/jjforge/.sandcastle.local",
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

test("routeReply routes a reply-to-question message to a resume of that task", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const action = routeReply(index, conn, { text: "use approach B", replyToId: 100 });

  assert.equal(action.kind, "resume");
  assert.equal(action.kind === "resume" && action.ref.task, "A1");
  assert.equal(action.kind === "resume" && action.text, "use approach B");
});

test("routeReply treats a /status message as a status query, not an answer", () => {
  const action = routeReply(newReplyIndex(), conn, { text: "/status" });

  assert.equal(action.kind, "status");
});

test("routeReply leaves a reply that matches no question unrouted", () => {
  const action = routeReply(newReplyIndex(), conn, { text: "hello?", replyToId: 999 });

  assert.equal(action.kind, "unrouted");
});

test("routeReply leaves a plain (non-reply) message unrouted — a shared bot needs the reply target", () => {
  const index = newReplyIndex();
  recordSend(index, "botA", 100, { project: "alpha", task: "A1", projectRoot: "/r", baseLocation: "/b", parkedAt: "t1" });

  const action = routeReply(index, conn, { text: "yes" });

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

  await pollLoop(conn, index, { poll, resume: (ref, text) => resumes.push({ task: ref.task, text }) });

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

  await pollLoop(conn, newReplyIndex(), {
    poll,
    resume: () => resumeCalls++,
    onStatus: () => {
      statusCalls++;
    },
  });

  assert.equal(statusCalls, 1);
  assert.equal(resumeCalls, 0);
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

  await pollLoop(conn, newReplyIndex(), { poll, resume: () => {} }, 2);

  assert.deepEqual(offsets, [2, 5, 9]);
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
  const configDir = join(tmpdir(), `sctdd-gw-load-${Date.now()}-${gwCounter++}`);
  const base = join(tmpdir(), `sctdd-gw-base-${Date.now()}-${gwCounter++}`, ".sandcastle.local");
  mkdirSync(join(base, "parked"), { recursive: true });
  writeFileSync(join(base, "orchestrator.env"), "SANDCASTLE_TELEGRAM_BOT_TOKEN=tok\nSANDCASTLE_TELEGRAM_CHAT_ID=chat\n");
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
  const configDir = join(tmpdir(), `sctdd-gw-stale-${Date.now()}-${gwCounter++}`);
  register(configDir, { project: "ghost", projectRoot: "/gone", baseLocation: join(tmpdir(), `sctdd-gw-missing-${Date.now()}-${gwCounter++}`) });

  assert.deepEqual(loadGatewayProjects(configDir), []);
});

test("isStatusCommand recognizes status queries and ignores answers", () => {
  for (const t of ["/status", "status", "/status@my_bot", "  Status ", "STATUS"]) assert.equal(isStatusCommand(t), true, t);
  for (const t of ["A", "use option B", "status of the world is fine", "", "s"]) assert.equal(isStatusCommand(t), false, t);
});
