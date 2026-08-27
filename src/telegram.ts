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
}

// The ONE place a Telegram connection is read from process env. Credentials come
// from the ORCHESTRATOR's environment, never from the sandcastle .env file — that
// file is injected into agent containers, and a bot token must not ride along.
// Unset means "not configured", which is a normal state and not an error:
// callers pass the resulting (possibly undefined) connection and every send
// becomes a no-op.
export const tgEnvConn = (): TgConn | undefined => {
  const token = process.env.VETINARI_TELEGRAM_BOT_TOKEN;
  const chat = process.env.VETINARI_TELEGRAM_CHAT_ID;
  return token && chat ? { token, chat, thread: process.env.VETINARI_TELEGRAM_THREAD_ID } : undefined;
};

const api = (conn: TgConn) => `https://api.telegram.org/bot${conn.token}`;

export const tgConfigured = () => Boolean(tgEnvConn());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tgSend(conn: TgConn | undefined, text: string, logger: Logger = hostLogger()): Promise<number | undefined> {
  if (!conn) return undefined;
  const body: Record<string, unknown> = { chat_id: conn.chat, text: text.slice(0, 3900) };
  if (conn.thread) body.message_thread_id = Number(conn.thread);
  const res = await fetch(`${api(conn)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const j: any = res ? await res.json().catch(() => null) : null;
  if (!j?.ok) {
    logger.log("telegram-send-failed", { status: res?.status ?? "network" });
    return undefined;
  }
  return j.result.message_id as number;
}

/**
 * Offset past everything already queued. Called before listening so a message
 * sent BEFORE a question was asked is never mistaken for its answer.
 */
export async function tgDrain(conn: TgConn): Promise<number> {
  const j: any = await fetch(`${api(conn)}/getUpdates?offset=-1`).then((r) => r.json()).catch(() => null);
  return j?.ok && j.result.length ? j.result[j.result.length - 1].update_id + 1 : 0;
}

export type TgMsg = { text: string; replyToId?: number };

/**
 * One long-poll cycle, text messages from the configured chat only.
 *
 * Telegram allows exactly ONE consumer of a bot's updates, so at most one
 * process may poll: a second poller silently steals messages from the first.
 */
export async function tgPoll(conn: TgConn, offset: number): Promise<{ offset: number; messages: TgMsg[] }> {
  const j: any = await fetch(`${api(conn)}/getUpdates?timeout=50&offset=${offset}`).then((r) => r.json()).catch(() => null);
  if (!j?.ok) {
    await sleep(5000);
    return { offset, messages: [] };
  }
  const messages: TgMsg[] = [];
  for (const u of j.result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    if (String(m.chat?.id) !== String(conn.chat)) continue;
    messages.push({ text: m.text as string, replyToId: m.reply_to_message?.message_id });
  }
  return { offset, messages };
}

/** Single-question wait: a reply to `parkMsgId`, or any plain (non-reply) text. */
export async function tgWaitReply(conn: TgConn, parkMsgId: number | undefined): Promise<string> {
  let offset = await tgDrain(conn);
  for (;;) {
    const r = await tgPoll(conn, offset);
    offset = r.offset;
    for (const m of r.messages) {
      if (m.replyToId && parkMsgId && m.replyToId !== parkMsgId) continue;
      return m.text;
    }
  }
}
