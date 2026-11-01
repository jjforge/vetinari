import { hostLogger, type Logger } from "./log.ts";

/**
 * An explicit bot connection: which bot to talk to, which chat, and (optionally)
 * which forum thread. Every send/poll helper takes one, so the gateway can drive
 * many bots from one process — no helper reads process-global env.
 */
export interface TgConn {
  token: string;
  chat: string;
  thread?: string;
  /**
   * Telegram user ids allowed to send into a group chat on this bot (`VETINARI_TELEGRAM_ALLOWED_SENDERS`).
   * Absent means none: a group chat's messages are all refused. A private chat needs no allowlist.
   */
  allowedSenders?: ReadonlySet<string>;
  /**
   * The chats a poll keeps — the gateway's poll target hears every chat its bot's projects use.
   * Absent means only `chat`.
   */
  chats?: ReadonlySet<string>;
}

/**
 * Parse `VETINARI_TELEGRAM_ALLOWED_SENDERS` — comma-separated user ids, whitespace trimmed, empty
 * entries ignored — into the `allowedSenders` key of a connection: `{}` when unset or empty, so an
 * unconfigured connection carries no key at all.
 */
export const allowedSendersOf = (raw: string | undefined): { allowedSenders?: ReadonlySet<string> } => {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? { allowedSenders: new Set(ids) } : {};
};

// The ONE place a Telegram connection is read from process env. Credentials come
// from the ORCHESTRATOR's environment, never from the sandcastle .env file — that
// file is injected into agent containers, and a bot token must not ride along.
// Unset means "not configured", which is a normal state and not an error:
// callers pass the resulting (possibly undefined) connection and every send
// becomes a no-op.
export const tgEnvConn = (): TgConn | undefined => {
  const token = process.env.VETINARI_TELEGRAM_BOT_TOKEN;
  const chat = process.env.VETINARI_TELEGRAM_CHAT_ID;
  return token && chat
    ? {
        token,
        chat,
        thread: process.env.VETINARI_TELEGRAM_THREAD_ID,
        ...allowedSendersOf(process.env.VETINARI_TELEGRAM_ALLOWED_SENDERS),
      }
    : undefined;
};

const api = (conn: TgConn) => `https://api.telegram.org/bot${conn.token}`;

export const tgConfigured = () => Boolean(tgEnvConn());
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Why a Telegram call failed: the HTTP status (or `"network"`), and Telegram's own `description` / `retry_after` when it sent them. */
export interface TgFailure {
  status: number | "network";
  description?: string;
  retryAfter?: number;
}

const tgFailureOf = (res: Response | null, j: any): TgFailure => ({
  status: res?.status ?? "network",
  ...(typeof j?.description === "string" && { description: j.description }),
  ...(typeof j?.parameters?.retry_after === "number" && { retryAfter: j.parameters.retry_after }),
});

/** A bot's numeric id — the token's part before the first `:` — so a log row names the bot without carrying its secret. */
export const botId = (conn: TgConn) => conn.token.split(":")[0];

/**
 * One `sendMessage` on `conn`, returning the sent message's id. `replyTo` threads it as a reply to
 * that message; a deleted target still gets the message, unthreaded. A failed send returns
 * `undefined` and hands why to `onFailure` — the outbox drain reads a 429's `retryAfter` from it.
 */
export async function tgSend(
  conn: TgConn | undefined,
  text: string,
  logger: Logger = hostLogger(),
  replyTo?: number,
  onFailure?: (failure: TgFailure) => void,
): Promise<number | undefined> {
  if (!conn) return undefined;
  const body: Record<string, unknown> = { chat_id: conn.chat, text: text.slice(0, 3900) };
  if (conn.thread) body.message_thread_id = Number(conn.thread);
  if (replyTo != null) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  const res = await fetch(`${api(conn)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const j: any = res ? await res.json().catch(() => null) : null;
  if (!j?.ok) {
    const failure = tgFailureOf(res, j);
    logger.log("telegram-send-failed", { ...failure });
    onFailure?.(failure);
    return undefined;
  }
  return j.result.message_id as number;
}

/**
 * Offset past everything already queued. Called before listening so a message
 * sent BEFORE a question was asked is never mistaken for its answer.
 */
export async function tgDrain(conn: TgConn, logger: Logger = hostLogger()): Promise<number> {
  const res = await fetch(`${api(conn)}/getUpdates?offset=-1`).catch(() => null);
  const j: any = res ? await res.json().catch(() => null) : null;
  if (!j?.ok) {
    logger.log("telegram-poll-failed", { bot: botId(conn), ...tgFailureOf(res, j) });
    return 0;
  }
  return j.result.length ? j.result[j.result.length - 1].update_id + 1 : 0;
}

/** How long one (status, description) poll failure stays quiet after it is logged. */
const POLL_FAIL_LOG_WINDOW_MS = 5 * 60_000;
const POLL_BACKOFF_BASE_MS = 5000;
const POLL_BACKOFF_CAP_MS = 5 * 60_000;

/**
 * One bot connection's poll-failure state, carried across `tgPoll` calls: the wait before the
 * next poll after a failure, and until when each (status, description) failure is already logged.
 * `now`/`sleep` are injectable so a test drives it on a fake clock.
 */
export interface PollBackoff {
  intervalMs: number;
  loggedUntil: Map<string, number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const newPollBackoff = (opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): PollBackoff => ({
  intervalMs: POLL_BACKOFF_BASE_MS,
  loggedUntil: new Map(),
  now: opts.now ?? Date.now,
  sleep: opts.sleep ?? sleep,
});

// The backoff a caller that passes none shares, one per bot token.
const defaultPollBackoffs = new Map<string, PollBackoff>();
const defaultPollBackoff = (conn: TgConn): PollBackoff => {
  let b = defaultPollBackoffs.get(conn.token);
  if (!b) defaultPollBackoffs.set(conn.token, (b = newPollBackoff()));
  return b;
};

/** A polled text message. `chat` is the chat it came from; absent means the poll connection's `chat`. */
export type TgMsg = { text: string; replyToId?: number; senderId?: string; chat?: string };

/** How long one `getUpdates` long-poll holds open, in seconds — also the gateway's poll-staleness unit. */
export const TG_POLL_TIMEOUT_S = 50;

/**
 * One long-poll cycle, text messages from the connection's `chats` only (just `chat` when absent),
 * each tagged with the chat it came from.
 *
 * In a group chat (a negative chat id: group, supergroup or channel) only a sender in the
 * connection's `allowedSenders` gets through; anyone else — or a message with no sender — is
 * dropped unanswered and logged as one `telegram-sender-refused` row (bot id, chat, sender; never
 * the text). A private chat (a positive id) is the other person, so it is never gated.
 *
 * Telegram allows exactly ONE consumer of a bot's updates, so at most one
 * process may poll: a second poller silently steals messages from the first.
 *
 * A failed poll (Telegram's not-ok, or a network error) returns an empty batch after
 * logging `telegram-poll-failed` — once per (status, description) per 5 min — and
 * sleeping `backoff`'s interval: 5 s doubling to 5 min, at least a 429's
 * `retry_after`, reset by the next ok poll. Pass one `backoff` per connection across
 * calls; without one, a shared default per bot token is used.
 */
export async function tgPoll(
  conn: TgConn,
  offset: number,
  logger: Logger = hostLogger(),
  backoff: PollBackoff = defaultPollBackoff(conn),
): Promise<{ offset: number; messages: TgMsg[] }> {
  const res = await fetch(`${api(conn)}/getUpdates?timeout=${TG_POLL_TIMEOUT_S}&offset=${offset}`).catch(() => null);
  const j: any = res ? await res.json().catch(() => null) : null;
  if (!j?.ok) {
    const failure = tgFailureOf(res, j);
    const key = `${failure.status}|${failure.description ?? ""}`;
    if ((backoff.loggedUntil.get(key) ?? 0) <= backoff.now()) {
      backoff.loggedUntil.set(key, backoff.now() + POLL_FAIL_LOG_WINDOW_MS);
      logger.log("telegram-poll-failed", { bot: botId(conn), ...failure });
    }
    const wait = Math.max(backoff.intervalMs, (failure.retryAfter ?? 0) * 1000);
    backoff.intervalMs = Math.min(backoff.intervalMs * 2, POLL_BACKOFF_CAP_MS);
    await backoff.sleep(wait);
    return { offset, messages: [] };
  }
  backoff.intervalMs = POLL_BACKOFF_BASE_MS;
  const messages: TgMsg[] = [];
  for (const u of j.result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    const chat = String(m.chat?.id);
    if (!(conn.chats ?? new Set([String(conn.chat)])).has(chat)) continue;
    const senderId = m.from?.id != null ? String(m.from.id) : undefined;
    if (Number(chat) < 0 && !(senderId && conn.allowedSenders?.has(senderId))) {
      logger.log("telegram-sender-refused", { bot: botId(conn), chat, sender: senderId });
      continue;
    }
    messages.push({ text: m.text as string, replyToId: m.reply_to_message?.message_id, senderId, chat });
  }
  return { offset, messages };
}

/** Single-question wait: a reply to `parkMsgId`, or any plain (non-reply) text. */
export async function tgWaitReply(conn: TgConn, parkMsgId: number | undefined): Promise<string> {
  let offset = await tgDrain(conn);
  const backoff = newPollBackoff();
  for (;;) {
    const r = await tgPoll(conn, offset, undefined, backoff);
    offset = r.offset;
    for (const m of r.messages) {
      if (m.replyToId && parkMsgId && m.replyToId !== parkMsgId) continue;
      return m.text;
    }
  }
}
