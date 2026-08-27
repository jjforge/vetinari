/**
 * The gateway's routing logic: the send-time reply index, poll-target dedupe,
 * announcement selection, and reply routing. All pure so it is testable without
 * Telegram or spawned processes; the daemon (`gateway`) is the thin impure glue
 * that wires these to the real send/poll helpers and the shared install.
 *
 * The gateway is a dumb router (ADR 0002): it holds no project config or secrets,
 * only pointers, and reads each project's connection and parked records live from
 * its base location.
 */

import { spawn } from "node:child_process";
import { normalize } from "./carve.ts";
import { resolveDestination, type Destination, type NotifyMap } from "./config.ts";
import { hostLogger, type Logger } from "./log.ts";
import {
  listOutboxIn,
  listParkedIn,
  markOutboundSent,
  outboxDirOf,
  parkedDirOf,
  setParkedMessageId,
  type OutboundRecord,
  type ParkedRecord,
} from "./state.ts";
import { gatewayConfigDir, readProjects } from "./registry.ts";
import { campaignRunning, logFileOf, readEventLog, serveAllStatus, shellCarvePreview } from "./status.ts";
import { tgPoll, tgSend, type TgConn, type TgMsg } from "./telegram.ts";

/**
 * A read-only status query, not an answer to a parked question: `/status` (bare,
 * or `/status@thebot` in a group) returns a summary instead of being routed to a
 * task. Kept to whole-word, unambiguous tokens so it never swallows a real
 * one-word answer.
 */
const STATUS_COMMANDS = new Set(["status", "/status"]);
export const isStatusCommand = (text: string) => STATUS_COMMANDS.has(text.trim().toLowerCase().replace(/@\w+$/, ""));

/**
 * A gateway command parsed from an inbound message, or `null` when the text is
 * not one — a plain answer to a parked question. Carve joins `/status` in the
 * command family (spec §"Carve joins the gateway command family"): `carve 640`
 * targets the one running campaign on the bot, `carve <project> 640`
 * disambiguates when several run there, and a bare `yes` confirms a pending
 * carve. Kept to whole, unambiguous tokens — an issue must be numeric — so a
 * one-word answer like "640" or "A" is never mistaken for a command.
 */
export type GatewayCommand =
  | { kind: "status" }
  | { kind: "carve"; project?: string; issue: string }
  | { kind: "confirm" };

const isIssueToken = (t: string) => /^#?\d+$/.test(t);

export function parseGatewayCommand(text: string): GatewayCommand | null {
  const trimmed = text.trim();
  if (isStatusCommand(trimmed)) return { kind: "status" };

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (head === "yes" && tokens.length === 1) return { kind: "confirm" };
  if (head === "carve") {
    const args = tokens.slice(1);
    // `carve 640` — the sole running campaign on this bot; `carve proj 640` —
    // an explicit project when several run there. The issue is always numeric.
    if (args.length === 1 && isIssueToken(args[0])) return { kind: "carve", issue: normalize(args[0]) };
    if (args.length === 2 && isIssueToken(args[1])) return { kind: "carve", project: args[0], issue: normalize(args[1]) };
  }
  return null;
}

/**
 * A registered project as the gateway sees it: its pointer fields, the Telegram
 * connection read live from its base location (absent when it configures none),
 * and its current parked records. The pure routing functions take these plain
 * structures; the daemon assembles them from the registry and each project's
 * `parked/` dir.
 */
export interface GatewayProject {
  project: string;
  projectRoot: string;
  baseLocation: string;
  conn?: TgConn;
  /** The project's routing rules, read live from its base location (absent = route everything to the default conn). */
  notify?: NotifyMap;
  /** The project's named destinations, read live from its base location. */
  destinations?: Record<string, Destination>;
  parked: ParkedRecord[];
  outbox: OutboundRecord[];
}

/**
 * Every live registered project as the gateway sees it: its pointer, its
 * connection read live from the base location, and its current parked records.
 * Stale registrations (base location gone) are dropped by `readProjects`, so one
 * moved or deleted project never takes the gateway down (ADR 0002). Read fresh
 * each tick so newly parked questions and newly registered projects are picked up.
 */
export function loadGatewayProjects(configDir: string): GatewayProject[] {
  return readProjects(configDir).map(({ pointer, conn, notify, destinations }) => ({
    project: pointer.project,
    projectRoot: pointer.projectRoot,
    baseLocation: pointer.baseLocation,
    conn,
    notify,
    destinations,
    parked: listParkedIn(parkedDirOf(pointer.baseLocation)),
    outbox: listOutboxIn(outboxDirOf(pointer.baseLocation)),
  }));
}

/**
 * A registered project paired with whether it currently has a running campaign —
 * the state `resolveCarveTarget` resolves a carve against. The daemon reads each
 * project's running/not-running state from its event log (`campaignRunning`); the
 * pairing keeps `resolveCarveTarget` pure over plain data.
 */
export interface CarveCandidate {
  project: GatewayProject;
  running: boolean;
}

/**
 * Which project a `carve` command targets, resolved from the bot it arrived on
 * (spec §"Project resolution from bot context"): exactly one running campaign on
 * that bot targets it; more than one is ambiguous and carries the candidate list
 * so the gateway can ask for `carve <project> 640`; none rejects. An explicit
 * project name resolves straight to that project when it is running on the bot.
 */
export type CarveResolution =
  | { kind: "target"; project: GatewayProject }
  | { kind: "ambiguous"; candidates: GatewayProject[] }
  | { kind: "none" };

/**
 * Resolve a carve command to a project, pure over the candidates and the bot the
 * message arrived on. Only projects served by that bot (same token, mirroring
 * `onStatus`'s filter) with a running campaign are eligible. An explicit project
 * name selects it directly (past any ambiguity); with none named, a single
 * running campaign is the target, several are ambiguous, and zero rejects.
 */
export function resolveCarveTarget(candidates: CarveCandidate[], conn: TgConn, project?: string): CarveResolution {
  const running = candidates.filter((c) => c.running && c.project.conn?.token === conn.token);
  if (project) {
    const named = running.find((c) => c.project.project === project);
    return named ? { kind: "target", project: named.project } : { kind: "none" };
  }
  if (running.length === 1) return { kind: "target", project: running[0].project };
  if (running.length > 1) return { kind: "ambiguous", candidates: running.map((c) => c.project) };
  return { kind: "none" };
}

/**
 * The distinct bot connections to poll — one per token. Telegram allows exactly
 * one consumer per bot, so projects sharing a token collapse to a single poll
 * loop; a project with no connection is skipped. The first connection seen for a
 * token wins (any chat on that bot yields the same update stream).
 */
export function pollTargets(projects: GatewayProject[]): TgConn[] {
  const seen = new Set<string>();
  const targets: TgConn[] = [];
  for (const p of projects) {
    if (!p.conn || seen.has(p.conn.token)) continue;
    seen.add(p.conn.token);
    targets.push(p.conn);
  }
  return targets;
}

/**
 * Reconcile the running poll loops against the live poll targets, keyed by bot
 * token: which tokens need a loop started (a newly-registered bot, or a token a
 * project rotated *to*) and which running loops to tear down (a project
 * deregistered, or a token a project rotated *away from*). A token present on both
 * sides is left running — its loop keeps its update offset — so only the delta
 * moves. Pure over the two token sets; the supervisor acts on the result.
 */
export function reconcilePollTargets(active: Iterable<string>, desired: TgConn[]): { start: TgConn[]; stop: string[] } {
  const activeTokens = new Set(active);
  const desiredTokens = new Set(desired.map((c) => c.token));
  return {
    start: desired.filter((c) => !activeTokens.has(c.token)),
    stop: [...activeTokens].filter((token) => !desiredTokens.has(token)),
  };
}

/**
 * Where a reply routes back to: the project and task whose question was answered,
 * plus the project root (the cwd the resume runs in, so `answer` loads that
 * project's own config) and its base location. `parkedAt` distinguishes one park
 * event from a later re-park of the same task, so a resumed-then-re-parked task
 * still announces its new question.
 */
export interface SendRef {
  project: string;
  task: string;
  projectRoot: string;
  baseLocation: string;
  parkedAt: string;
}

/**
 * The send-time index: `(botToken, messageId) → SendRef`, built as the gateway
 * announces each question and read to route an incoming reply. It is a cache
 * rebuilt on startup from persisted parked records (which carry their announced
 * message id), so it holds no durable state of its own — parked records remain
 * the source of truth (ADR 0002).
 *
 * `announced` is the in-memory guard against re-announcing a question already
 * sent this session, keyed by the specific park event so a re-park announces anew.
 */
export interface ReplyIndex {
  byMessage: Map<string, SendRef>;
  announced: Set<string>;
}

export const newReplyIndex = (): ReplyIndex => ({ byMessage: new Map(), announced: new Set() });

// NUL-joined keys: a bot token and a message id cannot collide across projects
// that share a bot, because the message id is unique per bot.
const messageKey = (token: string, messageId: number) => `${token} ${messageId}`;
const announceKey = (project: string, task: string, parkedAt: string) => `${project} ${task} ${parkedAt}`;

/** Record that a question for `ref` was announced as `messageId` on `token`. */
export function recordSend(index: ReplyIndex, token: string, messageId: number, ref: SendRef): void {
  index.byMessage.set(messageKey(token, messageId), ref);
  index.announced.add(announceKey(ref.project, ref.task, ref.parkedAt));
}

/** The project+task a reply belongs to, or null when no question matches it. */
export function resolveReply(index: ReplyIndex, token: string, messageId: number): SendRef | null {
  return index.byMessage.get(messageKey(token, messageId)) ?? null;
}

const isAnnounced = (index: ReplyIndex, project: string, task: string, parkedAt: string) =>
  index.announced.has(announceKey(project, task, parkedAt));

/**
 * A carve awaiting its confirming `yes`: the resolved project and the issue to
 * carve. Recorded when the gateway previews a carve and read back to execute it
 * on a reply to the preview. Carries only pointers — the project-side `carve`
 * recomputes the closure against the project's own graph (ADR 0002/0003).
 */
export interface PendingConfirm {
  project: string;
  projectRoot: string;
  baseLocation: string;
  issue: string;
}

/**
 * The in-memory store of pending carve confirmations, keyed to the preview
 * message a `yes` must reply to (spec §"`pendingConfirms` store"). Deliberately
 * non-durable — a gateway restart drops it and re-sending `carve 640` is the
 * recovery (ADR 0002). The clock is injected so expiry is testable without real
 * time; `resolve` is one-shot (a confirm fires at most once) and drops an entry
 * older than the TTL, so a stray or stale `yes` resolves to nothing.
 */
export interface PendingConfirms {
  record(token: string, messageId: number, confirm: PendingConfirm): void;
  resolve(token: string, messageId: number): PendingConfirm | null;
}

// A short TTL: long enough to read the preview and reply, short enough that a
// much later `yes` cannot trigger a carve the maintainer has forgotten about.
const CONFIRM_TTL_MS = 5 * 60 * 1000;

export function newPendingConfirms(now: () => number, ttlMs: number = CONFIRM_TTL_MS): PendingConfirms {
  const entries = new Map<string, { confirm: PendingConfirm; expiresAt: number }>();
  return {
    record(token, messageId, confirm) {
      entries.set(messageKey(token, messageId), { confirm, expiresAt: now() + ttlMs });
    },
    resolve(token, messageId) {
      const key = messageKey(token, messageId);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key); // one-shot: consumed whether or not it is still live
      return entry.expiresAt > now() ? entry.confirm : null;
    },
  };
}

/**
 * A parked question the gateway must still announce: the project's destination
 * and the record to send. The daemon sends each, writes the returned message id
 * back into the record, and records it in the index.
 */
export interface Announcement {
  project: string;
  projectRoot: string;
  baseLocation: string;
  conn: TgConn;
  record: ParkedRecord;
}

/**
 * The parked records not yet announced: those with no persisted message id and
 * not already announced this session (the index guard). A project with no
 * destination is skipped — there is nowhere to route its reply. Pure, so the
 * daemon can act on the result and the selection stays trivially testable.
 */
export function pendingAnnouncements(projects: GatewayProject[], index: ReplyIndex): Announcement[] {
  const out: Announcement[] = [];
  for (const p of projects) {
    if (!p.conn) continue;
    for (const record of p.parked) {
      if (record.tgMessageId != null) continue;
      if (isAnnounced(index, p.project, record.taskId, record.parkedAt)) continue;
      out.push({ project: p.project, projectRoot: p.projectRoot, baseLocation: p.baseLocation, conn: p.conn, record });
    }
  }
  return out;
}

/**
 * Where an outbound record routes: the destination name the notify map resolves
 * (undefined when unmapped and there is no wildcard), and the connection to send
 * on — the destination's chat/thread on the project's bot, or the project's
 * default connection when no named destination applies. `conn` is undefined only
 * when the project configures no Telegram at all (nowhere to send). Pure, so the
 * drain's routing decision is testable without a send.
 */
export function resolveRecordDestination(project: GatewayProject, record: OutboundRecord): { destination?: string; conn?: TgConn } {
  const resolved = resolveDestination(project.notify ?? {}, record.category, record.event);
  if (!project.conn) return { destination: resolved };
  const named = resolved ? project.destinations?.[resolved] : undefined;
  // A named destination overrides the chat/thread but rides the project's bot
  // token; with no map (or an unlisted name) everything falls to the default conn.
  const conn = named ? { token: project.conn.token, chat: named.chat, thread: named.thread } : project.conn;
  // Delivered on the default connection with nothing named: report "default"
  // (the docs' "default chat") so the stamp and `gateway-routed` log read as a
  // real destination, never `undefined`. Only when `conn` exists — a project
  // with no bot is genuinely undeliverable and keeps its unresolved destination.
  const destination = resolved ?? "default";
  return { destination, conn };
}

/**
 * One outbound record that was routed: which destination it resolved to and
 * whether the send landed. The daemon logs these; tests assert them.
 */
export interface DrainResult {
  record: OutboundRecord;
  destination?: string;
  sent: boolean;
}

/**
 * Drain one project's outbox: route each not-yet-sent record via its notify map
 * and hand it to the injected `send`, then stamp it sent so a later drain (or a
 * gateway restart) neither re-sends nor drops it. Idempotent — a record carrying
 * a `sentAt` is skipped; a send that fails is left unsent for the next tick. A
 * project with no connection is skipped whole (nowhere to send). The send is
 * injected so the routing is testable without a live bot.
 */
export async function drainOutbox(
  project: GatewayProject,
  send: (conn: TgConn, text: string) => Promise<number | undefined>,
  logger: Logger = hostLogger(),
): Promise<DrainResult[]> {
  const results: DrainResult[] = [];
  for (const record of project.outbox) {
    if (record.sentAt != null) continue;
    const { destination, conn } = resolveRecordDestination(project, record);
    if (!conn) continue;
    const messageId = await send(conn, record.text);
    if (messageId == null) {
      logger.log("gateway-route-failed", { project: project.project, id: record.id, category: record.category, event: record.event });
      results.push({ record, destination, sent: false });
      continue;
    }
    markOutboundSent(outboxDirOf(project.baseLocation), record.id, destination);
    logger.log("gateway-routed", { project: project.project, id: record.id, category: record.category, event: record.event, destination });
    results.push({ record, destination, sent: true });
  }
  return results;
}

/**
 * What an incoming Telegram message means: resume the task whose question it
 * replies to, answer a status query, or nothing routable (a reply to no known
 * question, or a plain message on a bot that may serve several projects). Pure,
 * so the daemon's poll loop is a thin dispatch over this decision.
 */
export type ReplyAction =
  | { kind: "resume"; ref: SendRef; text: string }
  | { kind: "status" }
  | { kind: "carve"; command: { project?: string; issue: string } }
  | { kind: "confirm"; confirm: PendingConfirm }
  | { kind: "unrouted" };

/**
 * Route one message. A gateway command (`/status`, `carve …`) takes precedence
 * over reply routing — it is a command, never an answer. A `yes` replying to a
 * live carve preview resolves (and consumes) that pending confirmation; any
 * other reply to a known question resumes its task, so a task genuinely answered
 * with the word "yes" still resumes when no carve is pending. Everything else is
 * unrouted.
 */
export function routeReply(index: ReplyIndex, pending: PendingConfirms, conn: TgConn, msg: TgMsg): ReplyAction {
  const command = parseGatewayCommand(msg.text);
  if (command?.kind === "status") return { kind: "status" };
  if (command?.kind === "carve") {
    const payload = command.project ? { project: command.project, issue: command.issue } : { issue: command.issue };
    return { kind: "carve", command: payload };
  }
  if (msg.replyToId != null) {
    if (command?.kind === "confirm") {
      const confirm = pending.resolve(conn.token, msg.replyToId);
      if (confirm) return { kind: "confirm", confirm };
    }
    const ref = resolveReply(index, conn.token, msg.replyToId);
    if (ref) return { kind: "resume", ref, text: msg.text };
  }
  return { kind: "unrouted" };
}

/**
 * The reply when several projects on one bot have a running campaign: name them
 * and show the disambiguating `carve <project> <issue>` form (user story 11).
 */
export function formatCarveAmbiguity(candidates: GatewayProject[], issue: string): string {
  const names = candidates.map((c) => c.project);
  return (
    `Several projects on this bot have a running campaign: ${names.join(", ")}.\n` +
    `Say which one — e.g. \`carve ${names[0]} ${issue}\`.`
  );
}

/**
 * The seams `handleCarveCommand` drives: the current carve candidates (each
 * project paired with its running state), the closure preview (which shells the
 * project's `carve <issue> --dry-run` and returns its text — or null on
 * failure), and the Telegram send. All injected so the resolve→preview→record
 * flow is testable without a bot or a spawned process.
 */
export interface CarveHandlerDeps {
  candidates: () => CarveCandidate[];
  preview: (target: PendingConfirm) => Promise<string | null>;
  send: (conn: TgConn, text: string) => Promise<number | undefined>;
}

/**
 * Handle a `carve` command end to end but for the execution: resolve the target
 * from the bot it arrived on, and either reject (ambiguous → candidate list,
 * none → nothing running) or preview the closure and record a pending
 * confirmation keyed to the preview message. Records nothing on a rejection or a
 * failed preview/send, so only a confirmed carve ever runs. The preview is a
 * private interactive exchange — it writes no outbox record and broadcasts
 * nothing (spec §"Preview then confirm"); only the executed carve emits
 * `progress:carve`.
 */
export async function handleCarveCommand(
  deps: CarveHandlerDeps,
  pending: PendingConfirms,
  conn: TgConn,
  command: { project?: string; issue: string },
): Promise<void> {
  const resolution = resolveCarveTarget(deps.candidates(), conn, command.project);
  if (resolution.kind === "none") {
    await deps.send(conn, `No campaign is running on this bot — nothing to carve.`);
    return;
  }
  if (resolution.kind === "ambiguous") {
    await deps.send(conn, formatCarveAmbiguity(resolution.candidates, command.issue));
    return;
  }
  const p = resolution.project;
  const target: PendingConfirm = { project: p.project, projectRoot: p.projectRoot, baseLocation: p.baseLocation, issue: command.issue };
  const previewText = await deps.preview(target);
  if (previewText == null) {
    await deps.send(conn, `Couldn't preview carve #${command.issue} for ${p.project} — is a campaign still running?`);
    return;
  }
  const messageId = await deps.send(conn, `${previewText}\n\nReply "yes" to this message to carve.`);
  if (messageId == null) return; // send failed — nothing to confirm against, drop it
  pending.record(conn.token, messageId, target);
}

/**
 * A plain-text `/status` summary across the projects a bot serves: each project
 * and the questions it has parked. A text-only summary by design — richer
 * multi-project presentation is the dashboard's job (E5). Pure over the given
 * projects (the daemon filters them to the replying bot first).
 */
export function formatGatewayStatus(projects: GatewayProject[]): string {
  const lines: string[] = ["📊 Gateway status"];
  for (const p of projects) {
    lines.push("", `${p.project}`);
    if (!p.parked.length) lines.push("  nothing parked");
    else for (const rec of p.parked) lines.push(`  ⏸ ${rec.taskId} — ${rec.reason}`);
  }
  if (projects.every((p) => !p.parked.length)) {
    lines.push("", "Nothing parked across these projects — reply to a question message to answer and resume it.");
  }
  return lines.join("\n");
}

/**
 * The seams the poll loop drives, all injected so the loop is testable without a
 * live bot or a spawned resume. `poll` returns one long-poll cycle, or `null` to
 * end the loop — the real poller never returns null (it blocks and retries), so
 * in production the loop runs forever; a test's fake poller returns null to stop.
 */
export interface PollDeps {
  poll: (conn: TgConn, offset: number) => Promise<{ offset: number; messages: TgMsg[] } | null>;
  resume: (ref: SendRef, text: string) => void;
  onStatus?: (conn: TgConn) => void | Promise<void>;
  onCarve?: (conn: TgConn, command: { project?: string; issue: string }) => void | Promise<void>;
  onConfirm?: (confirm: PendingConfirm) => void | Promise<void>;
  onUnrouted?: (conn: TgConn, msg: TgMsg) => void | Promise<void>;
  /** Tears the loop down when it fires — the supervisor aborts a token that was rotated away or deregistered. */
  signal?: AbortSignal;
}

/**
 * One bot's poll loop: long-poll, route each message, resume the matching task.
 * Because Telegram allows exactly one consumer per bot, exactly one of these runs
 * per distinct token (see `pollTargets`). It never routes work itself — it maps
 * each message through `routeReply` and hands the decision to the injected seams,
 * so several answered tasks resume concurrently through `resume`.
 */
export async function pollLoop(conn: TgConn, index: ReplyIndex, pending: PendingConfirms, deps: PollDeps, offset = 0): Promise<void> {
  for (;;) {
    if (deps.signal?.aborted) return;
    const r = await deps.poll(conn, offset);
    if (!r) return;
    offset = r.offset;
    for (const msg of r.messages) {
      const action = routeReply(index, pending, conn, msg);
      if (action.kind === "resume") deps.resume(action.ref, action.text);
      else if (action.kind === "status") await deps.onStatus?.(conn);
      else if (action.kind === "carve") await deps.onCarve?.(conn, action.command);
      else if (action.kind === "confirm") await deps.onConfirm?.(action.confirm);
      else await deps.onUnrouted?.(conn, msg);
    }
  }
}

/**
 * Keep the running poll loops in sync with the live poll targets. Each pass reads
 * the current targets, starts a loop (with its own abort signal) for every token
 * not already running, and aborts the loop for every token that vanished — so a
 * rotated or newly-registered bot is polled without a restart, and a token a
 * project rotated away from or deregistered stops being polled. A token present
 * across passes keeps its one loop, so its update offset is preserved. `targets`,
 * `start`, and `tick` are injected; the real daemon reads targets live and `tick`
 * sleeps one reconcile interval (never returning false, so it supervises forever).
 */
export async function supervisePolls(
  targets: () => TgConn[],
  start: (conn: TgConn, signal: AbortSignal) => void,
  tick: () => Promise<boolean>,
): Promise<void> {
  const active = new Map<string, AbortController>();
  do {
    const { start: toStart, stop: toStop } = reconcilePollTargets(active.keys(), targets());
    for (const token of toStop) {
      active.get(token)?.abort();
      active.delete(token);
    }
    for (const conn of toStart) {
      const controller = new AbortController();
      active.set(conn.token, controller);
      start(conn, controller.signal);
    }
  } while (await tick());
}

/**
 * Rebuild the send-time index from persisted parked records on startup: every
 * record that carries an announced message id (and whose project has a bot) is
 * re-recorded, so a restart re-announces nothing and still routes a reply that
 * arrived while the gateway was down. Parked records are the source of truth; the
 * index is only their in-memory projection (ADR 0002).
 */
export function rebuildIndex(projects: GatewayProject[]): ReplyIndex {
  const index = newReplyIndex();
  for (const p of projects) {
    if (!p.conn) continue;
    for (const record of p.parked) {
      if (record.tgMessageId == null) continue;
      recordSend(index, p.conn.token, record.tgMessageId, {
        project: p.project,
        task: record.taskId,
        projectRoot: p.projectRoot,
        baseLocation: p.baseLocation,
        parkedAt: record.parkedAt,
      });
    }
  }
  return index;
}

// --- The daemon: impure glue wiring the pure routing above to real Telegram and
// the shared install. Telegram send/poll and the resume shell-out are the only
// side effects here; everything they decide comes from the pure functions.

const ANNOUNCE_INTERVAL_MS = Math.max(1000, Number(process.env.VETINARI_GATEWAY_ANNOUNCE_MS ?? 5000));
// How often the poll supervisor re-derives its targets from the live registry so
// a rotated or newly-registered bot is picked up without a restart. Shares the
// announce cadence — the same "read everything fresh each tick" beat.
const POLL_RECONCILE_INTERVAL_MS = ANNOUNCE_INTERVAL_MS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The aggregated status site the gateway hosts (E5): one port fronting every
// registered project, a dropdown to pick between them. Defaults to the same
// 8765 the standalone per-project server uses (they don't run together on one
// host — the gateway supersedes running one project standalone).
const STATUS_PORT = Number(process.env.VETINARI_GATEWAY_STATUS_PORT ?? 8765);
const STATUS_HOST = process.env.VETINARI_GATEWAY_STATUS_HOST ?? "127.0.0.1";

const announceText = (a: Announcement) =>
  `⏸ ${a.project} agent PARKED (${a.record.reason}) on ${a.record.taskId}\n\n${a.record.question}\n\nReply to this message to answer and resume.`;

/**
 * Announce every parked question not yet sent to its project's destination, then
 * stamp the returned message id back into the record (which persists "announced"
 * and feeds a later index rebuild) and into the live index (which routes the
 * reply). Reads projects fresh so questions parked since the last tick are picked
 * up. Idempotent: a record that already has a message id is never re-announced.
 */
async function announcePending(configDir: string, index: ReplyIndex, logger: Logger = hostLogger()): Promise<void> {
  for (const a of pendingAnnouncements(loadGatewayProjects(configDir), index)) {
    const messageId = await tgSend(a.conn, announceText(a));
    if (messageId == null) {
      logger.log("gateway-announce-failed", { project: a.project, task: a.record.taskId });
      continue;
    }
    setParkedMessageId(parkedDirOf(a.baseLocation), a.record.taskId, messageId);
    recordSend(index, a.conn.token, messageId, {
      project: a.project,
      task: a.record.taskId,
      projectRoot: a.projectRoot,
      baseLocation: a.baseLocation,
      parkedAt: a.record.parkedAt,
    });
    logger.log("gateway-announced", { project: a.project, task: a.record.taskId, messageId });
  }
}

/**
 * Drain every registered project's outbox once: route each not-yet-sent record
 * per that project's notify map and send it, marking it sent. Reads projects
 * fresh so records written since the last tick are picked up; idempotent, so a
 * record already sent (persisted `sentAt`) is skipped across restarts. This is
 * the sole-sender path for broadcast messages — the announce loop above is the
 * same thing for the interactive `question` category.
 */
async function drainOutboxes(configDir: string, logger: Logger = hostLogger()): Promise<void> {
  for (const p of loadGatewayProjects(configDir)) {
    if (!p.outbox.some((r) => r.sentAt == null)) continue;
    await drainOutbox(p, (conn, text) => tgSend(conn, text), logger);
  }
}

/**
 * Every registered project paired with whether it currently has a running
 * campaign, read fresh from each project's event log (`campaignRunning`). This
 * is the state `resolveCarveTarget` resolves a carve against; read live so a
 * campaign that started or ended since the last tick is reflected.
 */
function carveCandidates(configDir: string): CarveCandidate[] {
  return loadGatewayProjects(configDir).map((project) => ({
    project,
    running: campaignRunning(readEventLog({ logFile: logFileOf(project.baseLocation) })),
  }));
}

/**
 * Preview a carve by shelling the project's own `carve <issue> --dry-run` via the
 * shared install in its root: it computes the closure against the project's real
 * `blockedBy` graph and prints it, changing nothing (the CLI breaks before it
 * appends the event or writes any outbox record). Returns the printed closure, or
 * null when the child fails — e.g. the campaign ended between resolve and preview.
 * Shares the shell-out with the aggregated dashboard's `POST /carve` preview
 * (`shellCarvePreview`); the only extra here is the failure log line.
 */
async function carvePreview(target: PendingConfirm, logger: Logger = hostLogger()): Promise<string | null> {
  const text = await shellCarvePreview(target.projectRoot, target.issue);
  if (text == null) logger.log("gateway-carve-preview-failed", { project: target.project, issue: target.issue });
  return text;
}

/**
 * Execute a confirmed carve by shelling the project's own `carve <issue>` via the
 * shared install in its root (ADR 0003), exactly as an answered question resumes
 * with `answer`. The project-side carve computes the closure, appends the carve
 * event, clears the dropped issues' parked records, and emits the one
 * `progress:carve` — the gateway only routes the command and its confirmation.
 * Fire-and-forget, like `spawnResume`.
 */
function spawnCarve(target: PendingConfirm, logger: Logger = hostLogger()): void {
  logger.log("gateway-carve", { project: target.project, issue: target.issue });
  spawn(process.execPath, [...process.execArgv, process.argv[1], "carve", target.issue], {
    cwd: target.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  })
    .on("exit", (code) => logger.log("gateway-carve-done", { project: target.project, issue: target.issue, code }))
    .on("error", (err) => logger.log("gateway-carve-failed", { project: target.project, issue: target.issue, error: String(err) }));
}

/**
 * Resume an answered task via the shared install in that project's root, so it
 * runs with the project's own config and gates (ADR 0003). Fire-and-forget: the
 * child runs detached and several resumes proceed concurrently — one slow resume
 * never holds up the others.
 */
function spawnResume(ref: SendRef, text: string, logger: Logger = hostLogger()): void {
  logger.log("gateway-resume", { project: ref.project, task: ref.task, chars: text.length });
  spawn(process.execPath, [...process.execArgv, process.argv[1], "answer", ref.task, text], {
    cwd: ref.projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
  })
    .on("exit", (code) => logger.log("gateway-resume-done", { project: ref.project, task: ref.task, code }))
    // A stale projectRoot (moved/deleted since registration) surfaces here as an
    // 'error', not a throw — log it rather than let it crash the whole daemon.
    .on("error", (err) => logger.log("gateway-resume-failed", { project: ref.project, task: ref.task, error: String(err) }));
}

/**
 * The host gateway daemon: sole Telegram consumer and sole sender across every
 * registered project. Rebuilds the reply index from persisted parked records
 * (so a restart re-announces nothing and still routes a reply sent while it was
 * down), announces newly parked questions and drains each project's outbox on a
 * timer (routing broadcast records per its notify map), and runs one poll loop
 * per distinct bot — routing each reply to the exact project+task and resuming it.
 *
 * Does not drain replies on startup: an unconfirmed reply that arrived while the gateway
 * was down is still in Telegram's backlog, and polling from offset 0 picks it up
 * and routes it via the rebuilt index (a reply to an already-cleared question
 * resolves to nothing and is left unrouted).
 *
 * Poll targets are re-derived live by the supervisor (`supervisePolls`), matching
 * the outbound side: a project that rotates its bot token or registers a brand-new
 * one begins being polled without a restart, and a token rotated away from or
 * deregistered stops being polled — its loop torn down while a token that persists
 * keeps its loop (and its update offset). New parked questions and new projects on
 * already-polled bots are picked up live by the announce loop.
 */
export async function gateway(configDir: string = gatewayConfigDir()): Promise<void> {
  // The host daemon spans every project and has no per-run cfg.logFile, so it
  // emits to the persistent host log (`hostLogTarget`), threaded through its helpers.
  const log = hostLogger();
  const index = rebuildIndex(loadGatewayProjects(configDir));
  // Non-durable by design (ADR 0002): a restart drops pending carve
  // confirmations, and re-sending `carve 640` is the recovery.
  const pending = newPendingConfirms(() => Date.now());
  // Just for the startup line — the supervisor below re-derives targets live.
  const startupBots = pollTargets(loadGatewayProjects(configDir)).length;
  log.log("gateway-start", { configDir, bots: startupBots });
  if (!startupBots) console.log("gateway up — no project defines a Telegram bot yet; announcing silently.");

  // Host the one aggregated status site over every registered project (E5). The
  // server reads the registry live per request, so it needs no restart when a
  // project registers; it runs alongside the Telegram loops below.
  await serveAllStatus(configDir, { port: STATUS_PORT, host: STATUS_HOST });

  const announcing = (async () => {
    for (;;) {
      try {
        await announcePending(configDir, index, log);
        await drainOutboxes(configDir, log);
      } catch (e) {
        log.log("gateway-announce-error", { error: String(e) });
      }
      await sleep(ANNOUNCE_INTERVAL_MS);
    }
  })();

  // One poll loop per distinct bot, kept in sync with the live registry: the
  // supervisor starts a loop for each newly-seen token and tears down one whose
  // token vanished. Each loop reads its send connection fresh from the token the
  // supervisor handed it, so a rotated token's replies and in-loop sends both ride
  // the live connection rather than the one captured at startup.
  const startPollLoop = (conn: TgConn, signal: AbortSignal) => {
    pollLoop(conn, index, pending, {
      poll: (c, o) => tgPoll(c, o),
      resume: (ref, text) => spawnResume(ref, text, log),
      onStatus: async (c) => {
        const served = loadGatewayProjects(configDir).filter((p) => p.conn?.token === c.token);
        await tgSend(c, formatGatewayStatus(served));
      },
      onCarve: (c, command) =>
        handleCarveCommand({ candidates: () => carveCandidates(configDir), preview: (t) => carvePreview(t, log), send: tgSend }, pending, c, command),
      onConfirm: (confirm) => spawnCarve(confirm, log),
      onUnrouted: async (c, msg) => {
        // Only answer a genuine misdirected reply; stay quiet for plain chatter.
        if (msg.replyToId != null) await tgSend(c, "That question isn't tracked anymore (already answered, or from before I started). Reply to a current question message.");
      },
      signal,
    }).catch((e) => log.log("gateway-poll-error", { token: conn.token, error: String(e) }));
  };

  const polling = supervisePolls(
    () => pollTargets(loadGatewayProjects(configDir)),
    startPollLoop,
    async () => {
      await sleep(POLL_RECONCILE_INTERVAL_MS);
      return true;
    },
  );

  await Promise.all([announcing, polling]);
}
