/**
 * The gateway's reply index: which parked questions to announce, and which
 * question a Telegram reply answers. It is a projection of the parked records
 * (ADR 0002) — a non-durable cache with no state of its own beyond this
 * session's announcements. Startup and every tick build the routes by the same
 * function, so the running index routes exactly what a restart would.
 */

import { questionDestinations } from "./config.ts";
import { PARK_REASON_FACTS } from "./park-reasons.ts";
import { parkedDirOf, setParkedMessageId, type ParkedRecord } from "./state.ts";
import type { TgConn } from "./telegram.ts";
import type { Announcement, GatewayProject, SendRef } from "./gateway.ts";

/**
 * The reply index's four operations. `pending` is the parked questions still to
 * announce; `recordAnnouncement` registers one that was sent; `resolveReply`
 * routes a reply; `tick` brings the routes up to date with a tick's loaded set.
 */
export interface ReplyIndex {
  /**
   * The parked records to announce: each routable record with no persisted
   * message id that was not already announced this session.
   */
  pending(projects: GatewayProject[]): Announcement[];
  /**
   * Record that `a` was sent as `messageId`: register its route and the session
   * guard, then stamp the parked record with the id (`setParkedMessageId`). Throws
   * only when that persist fails — the route and guard are already recorded.
   */
  recordAnnouncement(a: Announcement, messageId: number): void;
  /** The question a reply to `messageId`, heard in `conn`'s chat on its bot, answers — or null. */
  resolveReply(conn: Pick<TgConn, "token" | "chat">, messageId: number): SendRef | null;
  /**
   * Rebuild every loaded project's routes from its records, with this session's
   * announced message ids applied, and forget this session's announcements whose
   * record is gone or re-parked. A project absent from `projects` (an unreadable
   * pointer, a vanished base location) keeps its routes until restart.
   */
  tick(projects: GatewayProject[]): void;
}

/**
 * Where a project's park announcements are sent: the destination its `question`
 * routing key resolves to (its chat/thread on the project's bot), or the project's
 * default connection when no map (or no wildcard) routes it — never
 * unconditionally to the default chat (design §10). `undefined` only when the
 * project configures no Telegram at all. The `question` key is validated to a
 * single destination at config load (`questionDestinations`), so this reads that
 * one destination and rides the project's own bot token.
 */
function resolveQuestionConn(project: GatewayProject): TgConn | undefined {
  if (!project.conn) return undefined;
  const name = questionDestinationName(project);
  const named = name ? project.destinations?.[name] : undefined;
  return named ? { token: project.conn.token, chat: named.chat, thread: named.thread } : project.conn;
}

/** The single destination name a project's `question` key resolves to, if any — where its questions, and the replies to them, go. */
export function questionDestinationName(project: Pick<GatewayProject, "notify">): string | undefined {
  const dests = questionDestinations(project.notify ?? {});
  return dests.size === 1 ? [...dests][0] : undefined;
}

/**
 * The one routable-record rule, shared by pending, the rebuild and routing: a
 * record that asks something (a `stopped` or `outdated-agent` record asks nothing
 * — only the campaign-level park notice goes out, #403/#444), on a project with a
 * question destination to announce to and hear the reply in.
 */
function routable(project: GatewayProject): { conn: TgConn; records: ParkedRecord[] } | undefined {
  const conn = resolveQuestionConn(project);
  if (!conn) return undefined;
  return { conn, records: project.parked.filter((r) => !PARK_REASON_FACTS[r.reason]?.asksNothing) };
}

// NUL-joined keys: a Telegram message id is unique only within a chat, so a reply
// is keyed by bot token, chat and message id — two chats heard on one bot (a
// shared bot, a separate `question` destination) cannot collide. A park event is
// keyed by task and `parkedAt`, so a re-park announces anew.
const messageKey = (conn: Pick<TgConn, "token" | "chat">, messageId: number) => `${conn.token}\0${conn.chat}\0${messageId}`;
const parkKey = (record: Pick<ParkedRecord, "taskId" | "parkedAt">) => `${record.taskId}\0${record.parkedAt}`;

const refOf = (project: Pick<GatewayProject, "project" | "projectRoot" | "baseLocation">, record: ParkedRecord): SendRef => ({
  project: project.project,
  task: record.taskId,
  projectRoot: project.projectRoot,
  baseLocation: project.baseLocation,
  parkedAt: record.parkedAt,
});

/** One project's slice of the index: its reply routes, and its park events announced this session. */
interface ProjectEntry {
  routes: Map<string, SendRef>;
  announced: Map<string, number>;
}

/**
 * The project's routes as a restart would build them: each routable record with a
 * message id — its persisted one, else the one it was announced as this session.
 */
function rebuildRoutes(project: GatewayProject, announced: Map<string, number>): Map<string, SendRef> {
  const routes = new Map<string, SendRef>();
  const live = routable(project);
  if (!live) return routes;
  for (const record of live.records) {
    const messageId = record.tgMessageId ?? announced.get(parkKey(record));
    if (messageId != null) routes.set(messageKey(live.conn, messageId), refOf(project, record));
  }
  return routes;
}

/**
 * A reply index over `projects`, as at gateway startup: every persisted question
 * routes, and nothing that carries a message id is announced again.
 */
export function newReplyIndex(projects: GatewayProject[]): ReplyIndex {
  const byProject = new Map<string, ProjectEntry>();
  const entryOf = (project: string) => {
    let entry = byProject.get(project);
    if (!entry) byProject.set(project, (entry = { routes: new Map(), announced: new Map() }));
    return entry;
  };

  const index: ReplyIndex = {
    pending(projects) {
      const out: Announcement[] = [];
      for (const p of projects) {
        const live = routable(p);
        if (!live) continue;
        const announced = byProject.get(p.project)?.announced;
        for (const record of live.records) {
          if (record.tgMessageId != null || announced?.has(parkKey(record))) continue;
          out.push({ project: p.project, projectRoot: p.projectRoot, baseLocation: p.baseLocation, conn: live.conn, record });
        }
      }
      return out;
    },
    recordAnnouncement(a, messageId) {
      const entry = entryOf(a.project);
      entry.routes.set(messageKey(a.conn, messageId), refOf(a, a.record));
      entry.announced.set(parkKey(a.record), messageId);
      setParkedMessageId(parkedDirOf(a.baseLocation), a.record.taskId, messageId);
    },
    resolveReply(conn, messageId) {
      const key = messageKey(conn, messageId);
      for (const entry of byProject.values()) {
        const ref = entry.routes.get(key);
        if (ref) return ref;
      }
      return null;
    },
    tick(projects) {
      for (const p of projects) {
        const entry = entryOf(p.project);
        const live = new Set(routable(p)?.records.map(parkKey));
        for (const key of entry.announced.keys()) if (!live.has(key)) entry.announced.delete(key);
        entry.routes = rebuildRoutes(p, entry.announced);
      }
    },
  };
  index.tick(projects);
  return index;
}
