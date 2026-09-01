/**
 * Collect a project's Telegram **bot connection** — its one bot token and the chat
 * it speaks in by default — into that project's own `.vetinari.local/host.env`, the
 * host-side secrets file the gateway reads live (ADR 0002, ADR 0011). This is the
 * capability behind the `tg-connect` mode and the offer `init` makes after its
 * scaffold: today wiring a project's bot connection is a hand-edit of `host.env`
 * against the docs, done once per project by hand.
 *
 * Built on the same planner+apply shape as `init`/`migrate`: `planHostEnv` turns the
 * current file contents and the collected values into the new content (pure, no IO,
 * no network), and `writeHostEnv` performs the write — creating a new file `0600` and
 * leaving an existing file's mode untouched. `runTgConnect` is the shared collector
 * over a base-location *directory* (never a `ResolvedConfig`, so `init` — which runs
 * before the strict config load — can drive it too), with the terminal prompt and the
 * verification send injected so its flag/TTY branches are node-testable with no
 * terminal and no live network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostSecretsPath, tgConnForBaseLocation } from "./registry.ts";
import type { TgConn } from "./telegram.ts";

/** The two `host.env` keys that make up a bot connection (mirrors `telegram.ts`). */
const TOKEN_KEY = "VETINARI_TELEGRAM_BOT_TOKEN";
const CHAT_KEY = "VETINARI_TELEGRAM_CHAT_ID";

/** The collected bot connection: a bot token and the default chat it speaks in. */
export interface BotConnectionValues {
  token: string;
  chat: string;
}

/**
 * Pure planner: merge the collected token + chat into the current `host.env` content,
 * replacing an existing assignment of each key in place and appending one that is
 * absent, while every other line — comments, blanks, unrelated keys — survives verbatim.
 * Returns the new content (one trailing newline) and whether it differs from the input,
 * so the caller can skip an inert write. Writes nothing.
 */
export function planHostEnv(
  current: string | undefined,
  values: BotConnectionValues,
): { content: string; changed: boolean } {
  const updates = new Map<string, string>([
    [TOKEN_KEY, values.token],
    [CHAT_KEY, values.chat],
  ]);
  const raw = current ?? "";
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = body === "" ? [] : body.split("\n");

  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (m && updates.has(m[1])) {
      // Rewrite the first assignment of one of our keys in place, dropping any duplicate.
      if (!seen.has(m[1])) {
        out.push(`${m[1]}=${updates.get(m[1])}`);
        seen.add(m[1]);
      }
      continue;
    }
    out.push(line);
  }
  for (const [key, value] of updates) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }

  const content = out.join("\n") + "\n";
  return { content, changed: content !== raw };
}

/**
 * Write `content` to the base location's `host.env`. A file that did not exist is
 * created mode `0600` (a secrets file readable only by its owner); an existing file's
 * mode is left as-is — `writeFileSync`'s `mode` applies only on creation. Creates the
 * base location if it is missing.
 */
export function writeHostEnv(baseLocation: string, content: string): void {
  const path = hostSecretsPath(baseLocation);
  const isNew = !existsSync(path);
  mkdirSync(baseLocation, { recursive: true });
  if (isNew) writeFileSync(path, content, { mode: 0o600 });
  else writeFileSync(path, content);
}

/** Read the base location's raw `host.env`, or undefined when it is absent. */
function readHostEnv(baseLocation: string): string | undefined {
  const path = hostSecretsPath(baseLocation);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Flags/values the collector was invoked with (all optional but `noVerify`/`force`). */
export interface TgConnectOpts {
  /** `--token`: the bot token, or undefined to prompt (TTY) / report missing (non-TTY). */
  token?: string;
  /** `--chat`: the default chat id, or undefined to prompt (TTY) / report missing (non-TTY). */
  chat?: string;
  /** `--no-verify`: skip the verification send and write directly. */
  noVerify: boolean;
  /** `--force`: replace an already-configured bot connection without asking. */
  force: boolean;
}

/**
 * The terminal- and network-touching effects the collector needs, injected so its
 * flag/TTY branches are node-testable with no terminal and no live network. `ask` is
 * the same readline seam the campaign's under-specified prompt uses; `send` is one
 * `sendMessage` through the Telegram helper (`tgSend`'s shape — a message id, or
 * `undefined` on failure).
 */
export interface TgConnectDeps {
  /** Whether stdin is a terminal — gates every prompt and the re-prompt on failure. */
  isTTY: boolean;
  /** A readline-style prompt; consulted only on a TTY for values not given as flags. */
  ask: (question: string) => Promise<string>;
  /** Verify by sending one message; resolves a message id, or undefined on failure. */
  send: (conn: TgConn, text: string) => Promise<number | undefined>;
  /** Human-facing output. The token is never passed here. */
  log: (message: string) => void;
  /** An optional label for the verification message (the project name); never required. */
  label?: string;
}

/**
 * Collect a project's bot connection into its `host.env`, verify it with one send, and
 * write it — the shared implementation behind the `tg-connect` mode and `init`'s offer.
 *
 * - Values come from `--token`/`--chat` when given, else a TTY prompt; missing values
 *   with no terminal report what was missing and return not-ok (non-interactive never
 *   blocks).
 * - A bot connection already present in `host.env` (both keys) is guarded: without
 *   `--force`, a TTY shows the current chat id (never the token) and asks whether to
 *   replace, and a non-terminal refuses.
 * - Verification is one `sendMessage`; on failure nothing is written — a TTY re-prompts,
 *   a non-terminal returns not-ok. `--no-verify` skips the send.
 *
 * Returns `{ ok, written }`: `ok` false is the caller's cue for a non-zero exit. Every
 * user-facing line goes through `deps.log`.
 */
export async function runTgConnect(
  baseLocation: string,
  opts: TgConnectOpts,
  deps: TgConnectDeps,
): Promise<{ ok: boolean; written: boolean }> {
  // Re-run guard: a bot connection is already configured (both keys present).
  const existing = tgConnForBaseLocation(baseLocation);
  if (existing && !opts.force) {
    if (!deps.isTTY) {
      deps.log(
        `a bot connection is already configured (chat ${existing.chat}) — pass --force to replace it.`,
      );
      return { ok: false, written: false };
    }
    // Show the current chat id — never the token — and ask whether to replace it.
    const answer = (
      await deps.ask(`a bot connection is already configured (chat ${existing.chat}). Replace it? [y/N] `)
    )
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      deps.log("kept the existing bot connection — nothing changed.");
      return { ok: true, written: false };
    }
  }

  // Whether this invocation prompts at all: a TTY with at least one value not supplied
  // by a flag. When true, a failed verify (or an empty entry) re-prompts; when false,
  // the values are fixed, so a failure returns rather than looping.
  const prompting = deps.isTTY && (opts.token === undefined || opts.chat === undefined);

  for (;;) {
    let token = opts.token;
    let chat = opts.chat;
    if (deps.isTTY) {
      if (token === undefined) token = (await deps.ask("bot token: ")).trim();
      if (chat === undefined) chat = (await deps.ask("chat id: ")).trim();
    }

    const missing: string[] = [];
    if (!token) missing.push("--token");
    if (!chat) missing.push("--chat");
    if (missing.length) {
      if (prompting) {
        deps.log("both a bot token and a chat id are required.");
        continue;
      }
      deps.log(
        `tg-connect needs ${missing.join(" and ")} — supply them as flags or run on a terminal to be prompted.`,
      );
      return { ok: false, written: false };
    }

    const conn: TgConn = { token: token!, chat: chat! };

    if (!opts.noVerify) {
      const msgId = await deps.send(
        conn,
        `🔧 ${deps.label ?? "vetinari"} bot connection check — you can ignore this message.`,
      );
      if (msgId == null) {
        deps.log(
          "Telegram rejected the send — the token or chat id is wrong (see telegram-send-failed in the log). Nothing was written.",
        );
        if (prompting) continue;
        return { ok: false, written: false };
      }
    }

    const plan = planHostEnv(readHostEnv(baseLocation), conn);
    if (plan.changed) writeHostEnv(baseLocation, plan.content);
    deps.log(`wrote the bot connection to ${hostSecretsPath(baseLocation)}.`);
    return { ok: true, written: true };
  }
}
