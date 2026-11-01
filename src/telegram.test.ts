import test from "node:test";
import assert from "node:assert/strict";
import { TG_POLL_TIMEOUT_S, newPollBackoff, tgDrain, tgEnvConn, tgSend, tgPoll } from "./telegram.ts";
import { memoryLogger } from "./log.ts";
import { withEnv } from "./test-support.ts";

const TG_ENV = [
  "VETINARI_TELEGRAM_BOT_TOKEN",
  "VETINARI_TELEGRAM_CHAT_ID",
  "VETINARI_TELEGRAM_THREAD_ID",
  "VETINARI_TELEGRAM_ALLOWED_SENDERS",
];

/** Run `fn` with every Telegram key cleared, then `env` applied, restoring whatever was there before. */
const withTgEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T =>
  withEnv({ ...Object.fromEntries(TG_ENV.map((k) => [k, undefined])), ...env }, fn);

test("tgEnvConn builds a connection from the orchestrator env", () => {
  withTgEnv({ VETINARI_TELEGRAM_BOT_TOKEN: "tok", VETINARI_TELEGRAM_CHAT_ID: "chat", VETINARI_TELEGRAM_THREAD_ID: "7" }, () => {
    assert.deepEqual(tgEnvConn(), { token: "tok", chat: "chat", thread: "7" });
  });
});

test("tgEnvConn omits the thread when unset", () => {
  withTgEnv({ VETINARI_TELEGRAM_BOT_TOKEN: "tok", VETINARI_TELEGRAM_CHAT_ID: "chat" }, () => {
    assert.deepEqual(tgEnvConn(), { token: "tok", chat: "chat", thread: undefined });
  });
});

test("tgEnvConn reads the allowed senders, trimmed with empty entries ignored, and omits the key when empty", () => {
  const base = { VETINARI_TELEGRAM_BOT_TOKEN: "tok", VETINARI_TELEGRAM_CHAT_ID: "-1" };
  withTgEnv({ ...base, VETINARI_TELEGRAM_ALLOWED_SENDERS: " 1, ,2 ," }, () => {
    assert.deepEqual(tgEnvConn(), { token: "tok", chat: "-1", thread: undefined, allowedSenders: new Set(["1", "2"]) });
  });
  withTgEnv({ ...base, VETINARI_TELEGRAM_ALLOWED_SENDERS: " , " }, () => {
    assert.deepEqual(tgEnvConn(), { token: "tok", chat: "-1", thread: undefined });
  });
});

test("tgEnvConn is undefined when token or chat is missing", () => {
  withTgEnv({ VETINARI_TELEGRAM_BOT_TOKEN: "tok" }, () => assert.equal(tgEnvConn(), undefined));
  withTgEnv({ VETINARI_TELEGRAM_CHAT_ID: "chat" }, () => assert.equal(tgEnvConn(), undefined));
  withTgEnv({}, () => assert.equal(tgEnvConn(), undefined));
});

/** Swap global.fetch for a recorder that returns Telegram's ok envelope. */
const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = saved;
  }
};

const okResponse = (result: unknown) => ({ json: async () => ({ ok: true, result }), status: 200 }) as unknown as Response;

test("tgSend is a no-op returning undefined when the connection is undefined", async () => {
  let called = false;
  await withFetch(
    (async () => {
      called = true;
      return okResponse({ message_id: 1 });
    }) as typeof fetch,
    async () => {
      assert.equal(await tgSend(undefined, "hi"), undefined);
    },
  );
  assert.equal(called, false);
});

test("tgSend addresses the explicit connection, not process env", async () => {
  let url = "";
  let body: any;
  const record = (async (u: any, init: any) => {
    url = String(u);
    body = JSON.parse(init.body);
    return okResponse({ message_id: 42 });
  }) as typeof fetch;
  // Conflicting env set for the whole send: the helper must ignore it entirely.
  await withTgEnv(
    { VETINARI_TELEGRAM_BOT_TOKEN: "ENV_TOKEN", VETINARI_TELEGRAM_CHAT_ID: "ENV_CHAT", VETINARI_TELEGRAM_THREAD_ID: "999" },
    () =>
      withFetch(record, async () => {
        const id = await tgSend({ token: "CONN_TOKEN", chat: "CONN_CHAT", thread: "3" }, "hello");
        assert.equal(id, 42);
      }),
  );
  assert.ok(url.includes("botCONN_TOKEN"), `url used conn token: ${url}`);
  assert.equal(body.chat_id, "CONN_CHAT");
  assert.equal(body.message_thread_id, 3);
});

test("tgSend sends a reply target as reply_parameters that still sends if the target is gone", async () => {
  const bodies: any[] = [];
  const record = (async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return okResponse({ message_id: 43 });
  }) as typeof fetch;
  await withFetch(record, async () => {
    await tgSend({ token: "t", chat: "c" }, "answered", undefined, 42);
    await tgSend({ token: "t", chat: "c" }, "plain");
  });
  assert.deepEqual(bodies[0].reply_parameters, { message_id: 42, allow_sending_without_reply: true });
  assert.equal("reply_parameters" in bodies[1], false, "no reply target → no reply_parameters");
});

test("tgSend routes a send failure to the injected logger, not the process-global", async () => {
  const logger = memoryLogger();
  // Telegram's not-ok envelope: the send fails and the diagnostic must be captured.
  const failing = (async () => ({ json: async () => ({ ok: false }), status: 400 }) as unknown as Response) as typeof fetch;
  await withFetch(failing, async () => {
    const id = await tgSend({ token: "t", chat: "c" }, "hello", logger);
    assert.equal(id, undefined);
  });
  assert.deepEqual(
    logger.events.map((e) => [e.event, (e as { status?: unknown }).status]),
    [["telegram-send-failed", 400]],
  );
});

test("tgPoll long-polls getUpdates for TG_POLL_TIMEOUT_S seconds — the unit the gateway's staleness is judged in", async () => {
  const urls: string[] = [];
  await withFetch(
    (async (url: string) => {
      urls.push(String(url));
      return okResponse([]);
    }) as typeof fetch,
    async () => {
      await tgPoll({ token: "t", chat: "c" }, 7);
    },
  );
  assert.equal(new URL(urls[0]).searchParams.get("timeout"), "50");
  assert.equal(TG_POLL_TIMEOUT_S, 50);
});

test("tgPoll keeps only messages from the connection's chat", async () => {
  await withFetch(
    (async () =>
      okResponse([
        { update_id: 10, message: { text: "mine", chat: { id: "CONN_CHAT" } } },
        { update_id: 11, message: { text: "theirs", chat: { id: "OTHER" } } },
      ])) as typeof fetch,
    async () => {
      const r = await tgPoll({ token: "t", chat: "CONN_CHAT" }, 0);
      assert.deepEqual(
        r.messages.map((m) => m.text),
        ["mine"],
      );
      assert.equal(r.offset, 12);
    },
  );
});

/** A `getUpdates` message update in `chat`, from sender `from` (omitted when undefined). */
const msgUpdate = (update_id: number, chat: number, text: string, from?: number) => ({
  update_id,
  message: { text, chat: { id: chat }, ...(from != null && { from: { id: from } }) },
});

const refusedRows = (logger: ReturnType<typeof memoryLogger>) =>
  logger.events.filter((e) => (e.event as string) === "telegram-sender-refused") as unknown as Array<Record<string, unknown>>;

test("tgPoll in a group chat keeps only allowlisted senders and logs each refusal without its text", async () => {
  const logger = memoryLogger();
  await withFetch(
    (async () =>
      okResponse([msgUpdate(1, -222, "allowed", 333), msgUpdate(2, -222, "stranger", 444), msgUpdate(3, -222, "nobody")])) as typeof fetch,
    async () => {
      const r = await tgPoll({ token: "42:secret", chat: "-222", allowedSenders: new Set(["333"]) }, 0, logger);
      assert.deepEqual(r.messages, [{ text: "allowed", replyToId: undefined, senderId: "333", chat: "-222" }]);
      assert.equal(r.offset, 4);
    },
  );
  const rows = refusedRows(logger);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bot, "42");
  assert.equal(rows[0].chat, "-222");
  assert.equal(rows[0].sender, "444");
  for (const row of rows) {
    assert.equal("text" in row, false);
    assert.equal(JSON.stringify(row).includes("secret"), false);
  }
});

test("tgPoll keeps every chat in the connection's chats, gating each group chat by its allowlist", async () => {
  const logger = memoryLogger();
  await withFetch(
    (async () =>
      okResponse([
        msgUpdate(1, 111, "default", 111),
        msgUpdate(2, -222, "allowed", 333),
        msgUpdate(3, -222, "stranger", 999),
        msgUpdate(4, 444, "elsewhere", 444),
      ])) as typeof fetch,
    async () => {
      const conn = { token: "42:secret", chat: "111", chats: new Set(["111", "-222"]), allowedSenders: new Set(["333"]) };
      const r = await tgPoll(conn, 0, logger);
      assert.deepEqual(r.messages, [
        { text: "default", replyToId: undefined, senderId: "111", chat: "111" },
        { text: "allowed", replyToId: undefined, senderId: "333", chat: "-222" },
      ]);
      assert.equal(r.offset, 5);
    },
  );
  const rows = refusedRows(logger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat, "-222");
  assert.equal(rows[0].sender, "999");
});

test("tgPoll with no allowlist drops and logs every group-chat message", async () => {
  const logger = memoryLogger();
  await withFetch((async () => okResponse([msgUpdate(1, -222, "a", 333), msgUpdate(2, -222, "b", 444)])) as typeof fetch, async () => {
    const r = await tgPoll({ token: "42:secret", chat: "-222" }, 0, logger);
    assert.deepEqual(r.messages, []);
  });
  assert.deepEqual(
    refusedRows(logger).map((r) => r.sender),
    ["333", "444"],
  );
});

test("tgPoll passes a private chat's message with or without an allowlist, carrying its sender", async () => {
  for (const allowed of [{}, { allowedSenders: new Set(["999"]) }]) {
    const logger = memoryLogger();
    await withFetch((async () => okResponse([msgUpdate(1, 555, "hi", 555)])) as typeof fetch, async () => {
      const r = await tgPoll({ token: "42:secret", chat: "555", ...allowed }, 0, logger);
      assert.deepEqual(r.messages, [{ text: "hi", replyToId: undefined, senderId: "555", chat: "555" }]);
    });
    assert.equal(refusedRows(logger).length, 0);
  }
});

/** Telegram's not-ok envelope at an HTTP `status`, with optional `description` / `retry_after`. */
const failResponse = (status: number, description?: string, retryAfter?: number) =>
  ({
    json: async () => ({
      ok: false,
      error_code: status,
      description,
      ...(retryAfter != null && { parameters: { retry_after: retryAfter } }),
    }),
    status,
  }) as unknown as Response;

/** A poll backoff on a fake clock (moved only by `advance`) whose sleep records the wait instead of waiting. */
const fakePollBackoff = () => {
  let t = 1_000_000;
  const waits: number[] = [];
  const backoff = newPollBackoff({
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { backoff, waits, advance: (ms: number) => (t += ms) };
};

const pollFailedRows = (logger: ReturnType<typeof memoryLogger>) =>
  logger.events.filter((e) => (e.event as string) === "telegram-poll-failed") as unknown as Array<Record<string, unknown>>;

test("tgPoll logs a 401 as one telegram-poll-failed row with Telegram's status and description, never the token", async () => {
  const logger = memoryLogger();
  const { backoff } = fakePollBackoff();
  await withFetch((async () => failResponse(401, "Unauthorized")) as typeof fetch, async () => {
    const r = await tgPoll({ token: "123:SECRET", chat: "c" }, 7, logger, backoff);
    assert.deepEqual(r, { offset: 7, messages: [] });
  });
  const rows = pollFailedRows(logger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 401);
  assert.equal(rows[0].description, "Unauthorized");
  assert.ok(!JSON.stringify(logger.events).includes("SECRET"), "no row carries the bot token");
});

test("tgPoll logs a repeated identical failure once per five minutes, but a different failure at once", async () => {
  const logger = memoryLogger();
  const { backoff, advance } = fakePollBackoff();
  let reply = () => failResponse(409, "Conflict: terminated by other getUpdates request");
  await withFetch((async () => reply()) as typeof fetch, async () => {
    // Ten failures, with the clock frozen at the first so all sit inside the window.
    for (let i = 0; i < 10; i++) await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
    assert.equal(pollFailedRows(logger).length, 1, "ten identical failures in the window → one row");

    reply = () => failResponse(401, "Unauthorized");
    await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
    assert.equal(pollFailedRows(logger).length, 2, "a different (status, description) logs its own row");

    advance(5 * 60_000);
    reply = () => failResponse(409, "Conflict: terminated by other getUpdates request");
    await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
  });
  assert.deepEqual(
    pollFailedRows(logger).map((r) => r.status),
    [409, 401, 409],
    "once the window has passed the same failure logs again",
  );
});

test("tgPoll backs off between consecutive failed polls, 5 s doubling to a 5 min cap, and an ok poll resets it", async () => {
  const { backoff, waits } = fakePollBackoff();
  let reply = () => failResponse(502, "Bad Gateway");
  await withFetch((async () => reply()) as typeof fetch, async () => {
    for (let i = 0; i < 9; i++) await tgPoll({ token: "1:t", chat: "c" }, 0, memoryLogger(), backoff);
    reply = () => okResponse([]);
    await tgPoll({ token: "1:t", chat: "c" }, 0, memoryLogger(), backoff);
    reply = () => failResponse(502, "Bad Gateway");
    await tgPoll({ token: "1:t", chat: "c" }, 0, memoryLogger(), backoff);
  });
  const s = 1000;
  assert.deepEqual(waits, [5 * s, 10 * s, 20 * s, 40 * s, 80 * s, 160 * s, 300 * s, 300 * s, 300 * s, 5 * s]);
});

test('tgPoll treats a network error as a failed poll: logged as status "network" and backed off', async () => {
  const logger = memoryLogger();
  const { backoff, waits } = fakePollBackoff();
  await withFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    async () => {
      await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
      await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
    },
  );
  assert.deepEqual(
    pollFailedRows(logger).map((r) => r.status),
    ["network"],
  );
  assert.deepEqual(waits, [5000, 10000]);
});

test("tgPoll answered 429 waits at least retry_after seconds before the next poll on that connection", async () => {
  const logger = memoryLogger();
  const { backoff, waits } = fakePollBackoff();
  await withFetch((async () => failResponse(429, "Too Many Requests: retry after 42", 42)) as typeof fetch, async () => {
    await tgPoll({ token: "1:t", chat: "c" }, 0, logger, backoff);
  });
  assert.ok(waits[0] >= 42_000, `waited ${waits[0]} ms`);
  assert.equal(pollFailedRows(logger)[0].retryAfter, 42);
});

test("tgDrain logs a failed getUpdates as telegram-poll-failed and still returns offset 0", async () => {
  const logger = memoryLogger();
  await withFetch((async () => failResponse(409, "Conflict")) as typeof fetch, async () => {
    assert.equal(await tgDrain({ token: "1:SECRET", chat: "c" }, logger), 0);
  });
  assert.deepEqual(
    pollFailedRows(logger).map((r) => [r.status, r.description]),
    [[409, "Conflict"]],
  );
  assert.ok(!JSON.stringify(logger.events).includes("SECRET"));
});

test("tgSend's telegram-send-failed row carries Telegram's description, and a 429's retryAfter", async () => {
  const logger = memoryLogger();
  let reply = () => failResponse(400, "Bad Request: chat not found");
  await withFetch((async () => reply()) as typeof fetch, async () => {
    await tgSend({ token: "1:SECRET", chat: "c" }, "hello", logger);
    reply = () => failResponse(429, "Too Many Requests: retry after 9", 9);
    await tgSend({ token: "1:SECRET", chat: "c" }, "hello", logger);
  });
  const rows = logger.events.filter((e) => (e.event as string) === "telegram-send-failed") as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((r) => [r.status, r.description, r.retryAfter]),
    [
      [400, "Bad Request: chat not found", undefined],
      [429, "Too Many Requests: retry after 9", 9],
    ],
  );
  assert.ok(!JSON.stringify(logger.events).includes("SECRET"));
});
