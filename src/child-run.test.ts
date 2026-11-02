import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeChildStart,
  enableJsonOutput,
  encodeChildStart,
  isCampaignChildRun,
  isJsonOutput,
  readAgentOverride,
  stampAgentOverride,
  type ChildStart,
} from "./child-run.ts";

test("encodeChildStart writes the literal child env for every start, omitting what a start does not carry", () => {
  assert.deepEqual(encodeChildStart({ kind: "fresh" }), { VETINARI_CHILD: "1" });
  assert.deepEqual(encodeChildStart({ kind: "resume", session: "s" }), { VETINARI_CHILD: "1", VETINARI_RESUME_SESSION: "s" });
  assert.deepEqual(encodeChildStart({ kind: "reenter", prompt: "p", session: "s" }), {
    VETINARI_CHILD: "1",
    VETINARI_RESUME_SESSION: "s",
    VETINARI_RESUME_PROMPT: "p",
  });
  assert.deepEqual(encodeChildStart({ kind: "reenter", prompt: "p" }), { VETINARI_CHILD: "1", VETINARI_RESUME_PROMPT: "p" });
});

test("every child start round-trips through encode and decode", () => {
  const starts: ChildStart[] = [
    { kind: "fresh" },
    { kind: "resume", session: "s" },
    { kind: "reenter", prompt: "p", session: "s" },
    { kind: "reenter", prompt: "p" },
  ];
  for (const start of starts) assert.deepEqual(decodeChildStart(encodeChildStart(start)), start);
});

test("decodeChildStart reads an env with no resume pair — or empty values — as a fresh start", () => {
  assert.deepEqual(decodeChildStart({}), { kind: "fresh" });
  assert.deepEqual(decodeChildStart({ VETINARI_RESUME_SESSION: "", VETINARI_RESUME_PROMPT: "" }), { kind: "fresh" });
});

test("a process spawned with any child start is a campaign child; one with no marker is not", () => {
  assert.equal(isCampaignChildRun(encodeChildStart({ kind: "fresh" })), true);
  assert.equal(isCampaignChildRun(encodeChildStart({ kind: "reenter", prompt: "p" })), true);
  assert.equal(isCampaignChildRun({}), false);
});

test("enabling --json sets the env a child inherits, and is read back live", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(isJsonOutput(env), false);
  enableJsonOutput(env);
  assert.deepEqual(env, { VETINARI_JSON: "1" });
  assert.equal(isJsonOutput(env), true);
});

test("a stamped agent override is the literal VETINARI_AGENT a child inherits and reads back; an empty one stamps nothing", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(readAgentOverride(env), {});
  stampAgentOverride({}, env);
  assert.deepEqual(env, {});
  stampAgentOverride({ provider: "pi", effort: "xhigh" }, env);
  assert.deepEqual(env, { VETINARI_AGENT: '{"provider":"pi","effort":"xhigh"}' });
  assert.deepEqual(readAgentOverride(env), { provider: "pi", effort: "xhigh" });
});
