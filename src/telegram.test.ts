import test from "node:test";
import assert from "node:assert/strict";
import { tgEnvConn, tgSend, tgPoll } from "./telegram.ts";

const TG_ENV = ["SANDCASTLE_TELEGRAM_BOT_TOKEN", "SANDCASTLE_TELEGRAM_CHAT_ID", "SANDCASTLE_TELEGRAM_THREAD_ID"];

/** Run `fn` with the given Telegram env, restoring whatever was there before. */
const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(TG_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of TG_ENV) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of TG_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
};

/** Async `withEnv`: keeps the env in place across an awaited body. */
const withEnvAsync = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(TG_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of TG_ENV) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    await fn();
  } finally {
    for (const k of TG_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
};

test("tgEnvConn builds a connection from the orchestrator env", () => {
  withEnv(
    { SANDCASTLE_TELEGRAM_BOT_TOKEN: "tok", SANDCASTLE_TELEGRAM_CHAT_ID: "chat", SANDCASTLE_TELEGRAM_THREAD_ID: "7" },
    () => {
      assert.deepEqual(tgEnvConn(), { token: "tok", chat: "chat", thread: "7" });
    },
  );
});

test("tgEnvConn omits the thread when unset", () => {
  withEnv({ SANDCASTLE_TELEGRAM_BOT_TOKEN: "tok", SANDCASTLE_TELEGRAM_CHAT_ID: "chat" }, () => {
    assert.deepEqual(tgEnvConn(), { token: "tok", chat: "chat", thread: undefined });
  });
});

test("tgEnvConn is undefined when token or chat is missing", () => {
  withEnv({ SANDCASTLE_TELEGRAM_BOT_TOKEN: "tok" }, () => assert.equal(tgEnvConn(), undefined));
  withEnv({ SANDCASTLE_TELEGRAM_CHAT_ID: "chat" }, () => assert.equal(tgEnvConn(), undefined));
  withEnv({}, () => assert.equal(tgEnvConn(), undefined));
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

const okResponse = (result: unknown) =>
  ({ json: async () => ({ ok: true, result }), status: 200 }) as unknown as Response;

test("tgSend is a no-op returning undefined when the connection is undefined", async () => {
  let called = false;
  await withFetch((async () => {
    called = true;
    return okResponse({ message_id: 1 });
  }) as typeof fetch, async () => {
    assert.equal(await tgSend(undefined, "hi"), undefined);
  });
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
  await withEnvAsync(
    { SANDCASTLE_TELEGRAM_BOT_TOKEN: "ENV_TOKEN", SANDCASTLE_TELEGRAM_CHAT_ID: "ENV_CHAT", SANDCASTLE_TELEGRAM_THREAD_ID: "999" },
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

test("tgPoll keeps only messages from the connection's chat", async () => {
  await withFetch((async () =>
    okResponse([
      { update_id: 10, message: { text: "mine", chat: { id: "CONN_CHAT" } } },
      { update_id: 11, message: { text: "theirs", chat: { id: "OTHER" } } },
    ])) as typeof fetch, async () => {
    const r = await tgPoll({ token: "t", chat: "CONN_CHAT" }, 0);
    assert.deepEqual(r.messages.map((m) => m.text), ["mine"]);
    assert.equal(r.offset, 12);
  });
});
