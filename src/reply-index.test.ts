import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listParkedIn, parkedDirOf, writeParkedRecord, type ParkedRecord } from "./state.ts";
import type { GatewayProject } from "./gateway.ts";
import { newReplyIndex } from "./reply-index.ts";

// A base location with no `parked/` dir: the announce's persist is then a no-op.
const NO_PARKED_DIR = join(tmpdir(), `vetinari-reply-index-${process.pid}-missing`);

const alpha = (over: Partial<GatewayProject> = {}): GatewayProject => ({
  project: "alpha",
  projectRoot: "/r/alpha",
  baseLocation: NO_PARKED_DIR,
  conn: { token: "botA", chat: "-1" },
  parked: [],
  outbox: [],
  ...over,
});

const parked = (over: Partial<ParkedRecord> = {}): ParkedRecord => ({
  taskId: "A1",
  parkedAt: "t1",
  reason: "question",
  sessionId: "s",
  branch: "agent/A1",
  question: "Which approach?",
  ...over,
});

const inA = { token: "botA", chat: "-1" };

test("a question announced is routed when its reply arrives", () => {
  const projects = [alpha({ parked: [parked()] })];
  const index = newReplyIndex([]);

  const [a, ...rest] = index.pending(projects);
  assert.equal(rest.length, 0);
  assert.equal(a.record.taskId, "A1");
  assert.deepEqual(a.conn, inA);
  index.recordAnnouncement(a, 100);

  assert.deepEqual(index.resolveReply(inA, 100), {
    project: "alpha",
    task: "A1",
    projectRoot: "/r/alpha",
    baseLocation: NO_PARKED_DIR,
    parkedAt: "t1",
  });
  assert.equal(index.resolveReply(inA, 999), null);
  assert.equal(index.resolveReply({ token: "otherBot", chat: "-1" }, 100), null);
  assert.deepEqual(index.pending(projects), [], "and it is not announced again this session");
});

test("a re-park of an announced task is announced anew, and the old question's reply goes unrouted", () => {
  const index = newReplyIndex([]);
  index.recordAnnouncement(index.pending([alpha({ parked: [parked({ parkedAt: "t1" })] })])[0], 100);

  const reparked = [alpha({ parked: [parked({ parkedAt: "t2" })] })];
  index.tick(reparked);

  assert.equal(index.resolveReply(inA, 100), null);
  assert.deepEqual(
    index.pending(reparked).map((a) => a.record.parkedAt),
    ["t2"],
  );
});

test("a stopped or outdated-agent record is never pending and never routed", () => {
  const projects = [
    alpha({
      parked: [
        parked({ taskId: "A1" }),
        parked({ taskId: "A2", reason: "stopped", detail: "SIGINT" }),
        parked({ taskId: "A3", reason: "outdated-agent", detail: "API Error: 400" }),
        parked({ taskId: "A4", reason: "stopped", tgMessageId: 104 }),
        parked({ taskId: "A5", reason: "outdated-agent", tgMessageId: 105 }),
      ],
    }),
  ];
  const index = newReplyIndex(projects);

  assert.deepEqual(
    index.pending(projects).map((a) => a.record.taskId),
    ["A1"],
  );
  assert.equal(index.resolveReply(inA, 104), null);
  assert.equal(index.resolveReply(inA, 105), null);
});

test("a project with no Telegram connection has nothing pending and routes nothing", () => {
  const projects = [alpha({ conn: undefined, parked: [parked({ taskId: "A1" }), parked({ taskId: "A2", tgMessageId: 100 })] })];
  const index = newReplyIndex(projects);

  assert.deepEqual(index.pending(projects), []);
  assert.equal(index.resolveReply(inA, 100), null);
});

test("after a restart a question with a persisted message id is not re-announced, and its reply still routes", () => {
  const projects = [alpha({ parked: [parked({ taskId: "A1" }), parked({ taskId: "A2", parkedAt: "t2", tgMessageId: 100 })] })];
  const index = newReplyIndex(projects);

  assert.deepEqual(
    index.pending(projects).map((a) => a.record.taskId),
    ["A1"],
  );
  assert.equal(index.resolveReply(inA, 100)?.task, "A2");
});

test("a tick drops the route of a question whose record was answered or pruned away", () => {
  const index = newReplyIndex([alpha({ parked: [parked({ taskId: "A1", tgMessageId: 100 })] })]);
  assert.equal(index.resolveReply(inA, 100)?.task, "A1");

  index.tick([alpha({ parked: [] })]);

  assert.equal(index.resolveReply(inA, 100), null);
});

test("a tick keeps the question just announced from the set loaded before the announce, and it is not re-announced", () => {
  const loadedBeforeAnnounce = [alpha({ parked: [parked()] })];
  const index = newReplyIndex(loadedBeforeAnnounce);
  index.recordAnnouncement(index.pending(loadedBeforeAnnounce)[0], 100);

  index.tick(loadedBeforeAnnounce);
  index.tick(loadedBeforeAnnounce);

  assert.equal(index.resolveReply(inA, 100)?.task, "A1");
  assert.deepEqual(index.pending(loadedBeforeAnnounce), []);
});

test("a record stamped with a different message id routes by its persisted id", () => {
  const index = newReplyIndex([]);
  index.recordAnnouncement(index.pending([alpha({ parked: [parked()] })])[0], 100);

  index.tick([alpha({ parked: [parked({ tgMessageId: 200 })] })]);

  assert.equal(index.resolveReply(inA, 100), null);
  assert.equal(index.resolveReply(inA, 200)?.task, "A1");
});

test("a project absent from a tick's loaded set keeps its routes and its session guard", () => {
  const records = [parked({ taskId: "A1", tgMessageId: 100 }), parked({ taskId: "A2", parkedAt: "t2" })];
  const index = newReplyIndex([alpha({ parked: records })]);
  index.recordAnnouncement(index.pending([alpha({ parked: records })])[0], 101);

  index.tick([alpha({ project: "beta", conn: { token: "botB", chat: "-2" } })]);

  assert.equal(index.resolveReply(inA, 100)?.task, "A1");
  assert.equal(index.resolveReply(inA, 101)?.task, "A2");
  assert.deepEqual(index.pending([alpha({ parked: records })]), [], "nothing is re-announced when it comes back");
});

test("a loaded project that lost its connection routes nothing, and once reconnected announces its unstamped questions again", () => {
  const records = [parked({ taskId: "A1" })];
  const index = newReplyIndex([]);
  index.recordAnnouncement(index.pending([alpha({ parked: records })])[0], 100);

  index.tick([alpha({ conn: undefined, parked: records })]);

  assert.equal(index.resolveReply(inA, 100), null);
  assert.deepEqual(
    index.pending([alpha({ parked: records })]).map((a) => a.record.taskId),
    ["A1"],
  );
});

test("recording an announcement stamps the parked record, so a restart from disk routes it and announces nothing", (t) => {
  const base = mkdtempSync(join(tmpdir(), "vetinari-reply-index-stamp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { parkedAt: _, ...rec } = parked();
  writeParkedRecord({ parkedDir: parkedDirOf(base) }, rec);
  const fromDisk = () => [alpha({ baseLocation: base, parked: listParkedIn(parkedDirOf(base)) })];
  const running = newReplyIndex(fromDisk());

  running.recordAnnouncement(running.pending(fromDisk())[0], 100);

  assert.equal(fromDisk()[0].parked[0].tgMessageId, 100);
  const restarted = newReplyIndex(fromDisk());
  assert.deepEqual(restarted.pending(fromDisk()), []);
  assert.equal(restarted.resolveReply(inA, 100)?.task, "A1");
});

test("a question sent to a separate question chat routes from that chat across ticks, and not from the default chat", () => {
  const projects = [
    alpha({
      conn: { token: "botA", chat: "111" },
      notify: { question: "asks" },
      destinations: { asks: { chat: "-222" } },
      parked: [parked()],
    }),
  ];
  const index = newReplyIndex(projects);
  const [a] = index.pending(projects);
  assert.deepEqual(a.conn, { token: "botA", chat: "-222", thread: undefined });

  index.recordAnnouncement(a, 100);
  index.tick(projects);
  index.tick(projects);

  assert.equal(index.resolveReply({ token: "botA", chat: "-222" }, 100)?.task, "A1");
  assert.equal(index.resolveReply({ token: "botA", chat: "111" }, 100), null);
});

test("two chats on one shared bot each route their own question with the same message id", () => {
  const index = newReplyIndex([
    alpha({ conn: { token: "shared", chat: "111" }, parked: [parked({ tgMessageId: 42 })] }),
    alpha({ project: "beta", conn: { token: "shared", chat: "-222" }, parked: [parked({ taskId: "B1", tgMessageId: 42 })] }),
  ]);

  assert.equal(index.resolveReply({ token: "shared", chat: "111" }, 42)?.task, "A1");
  assert.equal(index.resolveReply({ token: "shared", chat: "-222" }, 42)?.task, "B1");
});

test("re-pointing a project's question chat moves its routes to the new chat at the next tick, as a restart would", () => {
  const routedTo = (chat: string) =>
    alpha({ notify: { question: "asks" }, destinations: { asks: { chat } }, parked: [parked({ tgMessageId: 100 })] });
  const index = newReplyIndex([routedTo("-old")]);

  index.tick([routedTo("-new")]);

  assert.equal(index.resolveReply({ token: "botA", chat: "-old" }, 100), null);
  assert.equal(index.resolveReply({ token: "botA", chat: "-new" }, 100)?.task, "A1");
});

test("rotating a project's bot token re-keys its routes under the new token at the next tick, as a restart would", () => {
  const records = [parked({ taskId: "A1", tgMessageId: 100 }), parked({ taskId: "A2", parkedAt: "t2" })];
  const index = newReplyIndex([alpha({ parked: records })]);
  index.recordAnnouncement(index.pending([alpha({ parked: records })])[0], 101);

  index.tick([alpha({ conn: { token: "botNew", chat: "-1" }, parked: records })]);

  assert.equal(index.resolveReply(inA, 100), null);
  assert.equal(index.resolveReply({ token: "botNew", chat: "-1" }, 100)?.task, "A1");
  assert.equal(index.resolveReply({ token: "botNew", chat: "-1" }, 101)?.task, "A2");
});

test("a question is announced to the chat and thread its question key resolves to, else through the wildcard, else to the default chat", () => {
  const connOf = (over: Partial<GatewayProject>) => {
    const projects = [alpha({ conn: { token: "botA", chat: "-100" }, parked: [parked()], ...over })];
    return newReplyIndex(projects).pending(projects)[0].conn;
  };

  assert.deepEqual(connOf({ notify: { question: "asks" }, destinations: { asks: { chat: "-999", thread: "7" } } }), {
    token: "botA",
    chat: "-999",
    thread: "7",
  });
  assert.deepEqual(connOf({ notify: { "*": "wild" }, destinations: { wild: { chat: "-42" } } }), {
    token: "botA",
    chat: "-42",
    thread: undefined,
  });
  assert.deepEqual(connOf({}), { token: "botA", chat: "-100" });
});

test("projects sharing one bot and chat are told apart by which message the reply targets", () => {
  const index = newReplyIndex([
    alpha({ parked: [parked({ tgMessageId: 100 })] }),
    alpha({ project: "beta", parked: [parked({ taskId: "B1", tgMessageId: 200 })] }),
  ]);

  assert.equal(index.resolveReply(inA, 100)?.project, "alpha");
  assert.equal(index.resolveReply(inA, 200)?.project, "beta");
});

// A small seeded generator, so a failing scenario replays exactly.
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

test("after any tick each loaded project routes what a fresh restart over its stamped records routes, and an absent one keeps its routes", () => {
  // Each project rides its own bot, and message ids are unique, so no two projects share a route.
  const names = ["alpha", "beta", "gamma"];
  const chats = ["-1", "-2"];
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    let nextId = 1;
    // The parked records on disk, which the announce stamps, and the shape each project loads as.
    const disk = new Map<string, ParkedRecord[]>(names.map((n) => [n, []]));
    const load = (n: string): GatewayProject => {
      const conn = rand() < 0.15 ? undefined : { token: `bot-${n}`, chat: pick(chats) };
      const notify = rand() < 0.5 ? { question: "asks" } : undefined;
      return alpha({ project: n, conn, notify, destinations: { asks: { chat: pick(chats) } }, parked: disk.get(n)! });
    };
    const probes = names.flatMap((n) => chats.map((chat) => ({ token: `bot-${n}`, chat })));
    const routes = (index: ReturnType<typeof newReplyIndex>) =>
      probes.flatMap((conn) => Array.from({ length: 200 }, (_, id) => ({ conn, id, ref: index.resolveReply(conn, id) })));

    const index = newReplyIndex(names.map(load));
    for (let step = 0; step < 6; step++) {
      // The task's parked records change between ticks: answered, re-parked, newly parked, stopped.
      for (const n of names) {
        const kept = disk.get(n)!.filter(() => rand() < 0.7);
        if (rand() < 0.6) {
          const taskId = pick(["1", "2", "3"]);
          const fresh = parked({ taskId, parkedAt: `s${step}`, reason: rand() < 0.2 ? "stopped" : "question" });
          disk.set(n, [...kept.filter((r) => r.taskId !== taskId), rand() < 0.2 ? { ...fresh, tgMessageId: nextId++ } : fresh]);
        } else disk.set(n, kept);
      }
      const loaded = names.filter(() => rand() < 0.8).map(load);
      const before = routes(index);

      for (const a of index.pending(loaded)) {
        const messageId = nextId++;
        index.recordAnnouncement(a, messageId);
        const records = disk.get(a.project)!;
        disk.set(
          a.project,
          records.map((r) => (r === a.record ? { ...r, tgMessageId: messageId } : r)),
        );
      }
      index.tick(loaded);

      const restart = newReplyIndex(loaded.map((p) => ({ ...p, parked: disk.get(p.project)! })));
      const isLoaded = (project?: string) => loaded.some((p) => p.project === project);
      const expected = routes(restart).map((r, i) => (r.ref || isLoaded(before[i].ref?.project) ? r : before[i]));
      assert.deepEqual(routes(index), expected, `seed ${seed}, step ${step}`);
    }
  }
});
