import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planHostEnv, runTgConnect, type TgConnectDeps } from "./tg-connect.ts";
import { hostSecretsPath } from "./registry.ts";
import type { TgConn } from "./telegram.ts";

const VALUES = { token: "123456:ABC-tok", chat: "-1001234567890" };

const tmpBase = () => mkdtempSync(join(tmpdir(), "vetinari-tgconnect-"));

/** A fake terminal prompt: hands back queued answers in order; throws if it runs dry. */
function fakeAsk(answers: string[]) {
  const asked: string[] = [];
  const ask = (q: string) => {
    asked.push(q);
    if (!answers.length) throw new Error(`unexpected prompt: ${q}`);
    return Promise.resolve(answers.shift()!);
  };
  return Object.assign(ask, { asked });
}

/** A fake send that records each call and returns a canned outcome (msg id, or undefined = failure). */
function fakeSend(results: (number | undefined)[]) {
  const calls: { conn: TgConn; text: string }[] = [];
  const send = (conn: TgConn, text: string) => {
    calls.push({ conn, text });
    return Promise.resolve(results.length ? results.shift()! : 1);
  };
  return Object.assign(send, { calls });
}

function deps(overrides: Partial<TgConnectDeps> = {}): { deps: TgConnectDeps; logged: string[] } {
  const logged: string[] = [];
  return {
    logged,
    deps: {
      isTTY: false,
      ask: fakeAsk([]),
      send: fakeSend([]),
      log: (m: string) => logged.push(m),
      ...overrides,
    },
  };
}

test("planHostEnv writes both keys into a brand-new (absent) host.env", () => {
  const { content, changed } = planHostEnv(undefined, VALUES);
  assert.equal(changed, true);
  assert.match(content, /^VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok$/m);
  assert.match(content, /^VETINARI_TELEGRAM_CHAT_ID=-1001234567890$/m);
  // A tidy file ends with exactly one trailing newline.
  assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
});

test("planHostEnv merges into an existing file, preserving every other key", () => {
  const current = "# my secrets\nSOME_OTHER_KEY=keep-me\n";
  const { content, changed } = planHostEnv(current, VALUES);
  assert.equal(changed, true);
  // The pre-existing content survives verbatim.
  assert.match(content, /^# my secrets$/m);
  assert.match(content, /^SOME_OTHER_KEY=keep-me$/m);
  // The two bot-connection keys are appended.
  assert.match(content, /^VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok$/m);
  assert.match(content, /^VETINARI_TELEGRAM_CHAT_ID=-1001234567890$/m);
});

test("planHostEnv replaces both keys in place when the file already carries them", () => {
  const current =
    "SOME_OTHER_KEY=keep-me\n" +
    "VETINARI_TELEGRAM_BOT_TOKEN=old-token\n" +
    "VETINARI_TELEGRAM_CHAT_ID=old-chat\n";
  const { content, changed } = planHostEnv(current, VALUES);
  assert.equal(changed, true);
  // Exactly one assignment of each key — replaced, not duplicated.
  assert.equal((content.match(/^VETINARI_TELEGRAM_BOT_TOKEN=/gm) ?? []).length, 1);
  assert.equal((content.match(/^VETINARI_TELEGRAM_CHAT_ID=/gm) ?? []).length, 1);
  assert.match(content, /^VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok$/m);
  assert.match(content, /^VETINARI_TELEGRAM_CHAT_ID=-1001234567890$/m);
  assert.doesNotMatch(content, /old-token|old-chat/);
  // The unrelated key is untouched.
  assert.match(content, /^SOME_OTHER_KEY=keep-me$/m);
});

test("planHostEnv reports no change when both keys already carry the same values", () => {
  const current =
    "VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok\n" +
    "VETINARI_TELEGRAM_CHAT_ID=-1001234567890\n";
  const { content, changed } = planHostEnv(current, VALUES);
  assert.equal(changed, false);
  assert.equal(content, current);
});

test("runTgConnect with --token/--chat (non-TTY) verifies with one send and writes both keys", async () => {
  const base = tmpBase();
  writeFileSync(hostSecretsPath(base), "SOME_OTHER_KEY=keep-me\n");
  const send = fakeSend([1]);
  const { deps: d, logged } = deps({ send });
  const r = await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: false, force: false }, d);

  assert.deepEqual(r, { ok: true, written: true });
  // Exactly one verification send, through the collected connection.
  assert.equal(send.calls.length, 1);
  assert.deepEqual(send.calls[0].conn, { token: VALUES.token, chat: VALUES.chat });
  // The file carries both keys and keeps the pre-existing one.
  const written = readFileSync(hostSecretsPath(base), "utf8");
  assert.match(written, /^VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok$/m);
  assert.match(written, /^VETINARI_TELEGRAM_CHAT_ID=-1001234567890$/m);
  assert.match(written, /^SOME_OTHER_KEY=keep-me$/m);
  // The token is never echoed to the log.
  assert.ok(!logged.some((l) => l.includes(VALUES.token)));
});

test("runTgConnect never prompts when both values come from flags", async () => {
  const base = tmpBase();
  const ask = fakeAsk([]); // would throw if consulted
  const { deps: d } = deps({ ask });
  await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: false, force: false }, d);
  assert.equal(ask.asked.length, 0, "flags supplied → no prompt");
});

test("runTgConnect on a TTY with no flags prompts for the token then the chat, then writes", async () => {
  const base = tmpBase();
  const ask = fakeAsk([VALUES.token, VALUES.chat]);
  const send = fakeSend([1]);
  const { deps: d } = deps({ isTTY: true, ask, send });
  const r = await runTgConnect(base, { noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: true, written: true });
  assert.equal(ask.asked.length, 2, "prompted for both values");
  assert.match(ask.asked[0], /token/i);
  assert.match(ask.asked[1], /chat/i);
  const written = readFileSync(hostSecretsPath(base), "utf8");
  assert.match(written, /VETINARI_TELEGRAM_BOT_TOKEN=/);
});

test("runTgConnect non-interactively with a value missing does not block — it names what was missing and returns not-ok", async () => {
  const base = tmpBase();
  const { deps: d, logged } = deps();
  const r = await runTgConnect(base, { token: VALUES.token, chat: undefined, noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: false, written: false });
  assert.ok(logged.some((l) => l.includes("--chat")), "names the missing flag");
  assert.ok(!existsSync(hostSecretsPath(base)), "nothing written");
});

test("runTgConnect: a verify failure non-interactively writes nothing and returns not-ok, reporting the error", async () => {
  const base = tmpBase();
  const send = fakeSend([undefined]); // send rejected
  const { deps: d, logged } = deps({ send });
  const r = await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: false, written: false });
  assert.ok(!existsSync(hostSecretsPath(base)), "nothing written on a failed verify");
  assert.ok(logged.some((l) => /rejected|wrong/i.test(l)), "the telegram error is reported");
});

test("runTgConnect: a verify failure on a TTY re-prompts, then writes once the send succeeds", async () => {
  const base = tmpBase();
  // First attempt fails, second succeeds; prompts are re-asked for the second attempt.
  const ask = fakeAsk(["bad-token", VALUES.chat, VALUES.token, VALUES.chat]);
  const send = fakeSend([undefined, 1]);
  const { deps: d } = deps({ isTTY: true, ask, send });
  const r = await runTgConnect(base, { noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: true, written: true });
  assert.equal(send.calls.length, 2, "one failed send, then a successful re-send");
  const written = readFileSync(hostSecretsPath(base), "utf8");
  assert.match(written, /VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok/);
});

test("runTgConnect --no-verify skips the send and writes directly", async () => {
  const base = tmpBase();
  const send = fakeSend([]);
  const { deps: d } = deps({ send });
  const r = await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: true, force: false }, d);
  assert.deepEqual(r, { ok: true, written: true });
  assert.equal(send.calls.length, 0, "no send under --no-verify");
  assert.ok(existsSync(hostSecretsPath(base)));
});

test("runTgConnect re-run guard: on a TTY it shows the chat (never the token) and keeps the connection on a no", async () => {
  const base = tmpBase();
  writeFileSync(
    hostSecretsPath(base),
    "VETINARI_TELEGRAM_BOT_TOKEN=secret-existing\nVETINARI_TELEGRAM_CHAT_ID=999\n",
  );
  const ask = fakeAsk(["n"]);
  const { deps: d, logged } = deps({ isTTY: true, ask });
  const r = await runTgConnect(base, { noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: true, written: false }, "declining is not an error and writes nothing");
  // The prompt discloses the current chat id but never the token.
  assert.ok(ask.asked[0].includes("999"), "shows the current chat id");
  assert.ok(![...ask.asked, ...logged].some((l) => l.includes("secret-existing")), "never shows the token");
  // The file is left exactly as it was.
  assert.match(readFileSync(hostSecretsPath(base), "utf8"), /secret-existing/);
});

test("runTgConnect re-run guard: non-interactively it refuses unless --force", async () => {
  const base = tmpBase();
  writeFileSync(
    hostSecretsPath(base),
    "VETINARI_TELEGRAM_BOT_TOKEN=secret-existing\nVETINARI_TELEGRAM_CHAT_ID=999\n",
  );
  const { deps: d, logged } = deps();
  const r = await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: false, written: false });
  assert.ok(logged.some((l) => l.includes("--force")), "points at --force");
  assert.match(readFileSync(hostSecretsPath(base), "utf8"), /secret-existing/, "left untouched");
});

test("runTgConnect --force replaces an existing bot connection without asking", async () => {
  const base = tmpBase();
  writeFileSync(
    hostSecretsPath(base),
    "VETINARI_TELEGRAM_BOT_TOKEN=old\nVETINARI_TELEGRAM_CHAT_ID=old\n",
  );
  const ask = fakeAsk([]); // must not be consulted
  const send = fakeSend([1]);
  const { deps: d } = deps({ isTTY: true, ask, send });
  const r = await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: false, force: true }, d);
  assert.deepEqual(r, { ok: true, written: true });
  assert.equal(ask.asked.length, 0, "--force asks nothing");
  const written = readFileSync(hostSecretsPath(base), "utf8");
  assert.match(written, /VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok/);
});

test("runTgConnect creates a new host.env mode 0600", async () => {
  const base = tmpBase();
  const { deps: d } = deps({ send: fakeSend([1]) });
  await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: true, force: false }, d);
  const mode = statSync(hostSecretsPath(base)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("runTgConnect leaves an existing host.env's mode untouched", async () => {
  const base = tmpBase();
  const path = hostSecretsPath(base);
  writeFileSync(path, "SOME_OTHER_KEY=x\n", { mode: 0o644 });
  const { deps: d } = deps({ send: fakeSend([1]) });
  await runTgConnect(base, { token: VALUES.token, chat: VALUES.chat, noVerify: true, force: false }, d);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o644, "an existing file's mode is left as-is");
});

test("runTgConnect on a TTY with a bad --token flag re-prompts for both values rather than looping (a bad flag is correctable)", async () => {
  const base = tmpBase();
  // --token is a bad flag, no --chat. First send fails; the re-prompt asks for BOTH values.
  const ask = fakeAsk([VALUES.chat, VALUES.token, VALUES.chat]);
  const send = fakeSend([undefined, 1]);
  const { deps: d } = deps({ isTTY: true, ask, send });
  const r = await runTgConnect(base, { token: "bad-flag-token", chat: undefined, noVerify: false, force: false }, d);
  assert.deepEqual(r, { ok: true, written: true });
  assert.equal(send.calls.length, 2);
  // The re-prompt re-asked for the token (not only the prompted chat), so the bad flag was fixable.
  assert.ok(ask.asked.some((q) => /token/i.test(q)), "the token is re-prompted after a bad flag");
  assert.match(readFileSync(hostSecretsPath(base), "utf8"), /VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-tok/);
});
