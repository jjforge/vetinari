import test from "node:test";
import assert from "node:assert/strict";
import type { ParkedRecord } from "./state.ts";
import type { TgConn } from "./telegram.ts";
import {
  newReplyIndex,
  pendingAnnouncements,
  pollTargets,
  rebuildIndex,
  recordSend,
  resolveReply,
  routeReply,
  type GatewayProject,
  type SendRef,
} from "./gateway.ts";

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
