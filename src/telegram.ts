import { log } from "./log.ts";

// Credentials come from the ORCHESTRATOR's environment, never from the
// sandcastle .env file — that file is injected into agent containers, and a bot
// token must not ride along. Unset means "not configured", which is a normal
// state and not an error: every send becomes a no-op.
const TOKEN = () => process.env.WAVE_TELEGRAM_BOT_TOKEN;
const CHAT = () => process.env.WAVE_TELEGRAM_CHAT_ID;
const THREAD = () => process.env.WAVE_TELEGRAM_THREAD_ID;
const api = () => `https://api.telegram.org/bot${TOKEN()}`;

export const tgConfigured = () => Boolean(TOKEN() && CHAT());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tgSend(text: string): Promise<number | undefined> {
  if (!tgConfigured()) return undefined;
  const body: Record<string, unknown> = { chat_id: CHAT(), text: text.slice(0, 3900) };
  if (THREAD()) body.message_thread_id = Number(THREAD());
  const res = await fetch(`${api()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const j: any = res ? await res.json().catch(() => null) : null;
  if (!j?.ok) {
    log("telegram-send-failed", { status: res?.status ?? "network" });
    return undefined;
  }
  return j.result.message_id as number;
}

/**
 * Offset past everything already queued. Called before listening so a message
 * sent BEFORE a question was asked is never mistaken for its answer.
 */
export async function tgDrain(): Promise<number> {
  const j: any = await fetch(`${api()}/getUpdates?offset=-1`).then((r) => r.json()).catch(() => null);
  return j?.ok && j.result.length ? j.result[j.result.length - 1].update_id + 1 : 0;
}

export type TgMsg = { text: string; replyToId?: number };

/**
 * One long-poll cycle, text messages from the configured chat only.
 *
 * Telegram allows exactly ONE consumer of a bot's updates, so at most one
 * process may poll: a second poller silently steals messages from the first.
 */
export async function tgPoll(offset: number): Promise<{ offset: number; messages: TgMsg[] }> {
  const j: any = await fetch(`${api()}/getUpdates?timeout=50&offset=${offset}`).then((r) => r.json()).catch(() => null);
  if (!j?.ok) {
    await sleep(5000);
    return { offset, messages: [] };
  }
  const messages: TgMsg[] = [];
  for (const u of j.result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    if (String(m.chat?.id) !== String(CHAT())) continue;
    messages.push({ text: m.text as string, replyToId: m.reply_to_message?.message_id });
  }
  return { offset, messages };
}

/** Single-question wait: a reply to `parkMsgId`, or any plain (non-reply) text. */
export async function tgWaitReply(parkMsgId: number | undefined): Promise<string> {
  let offset = await tgDrain();
  for (;;) {
    const r = await tgPoll(offset);
    offset = r.offset;
    for (const m of r.messages) {
      if (m.replyToId && parkMsgId && m.replyToId !== parkMsgId) continue;
      return m.text;
    }
  }
}
