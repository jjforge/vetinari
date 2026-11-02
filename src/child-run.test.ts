import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeChildExit,
  decodeChildRejection,
  decodeChildStart,
  enableJsonOutput,
  encodeChildStart,
  isCampaignChildRun,
  isFailedOutcome,
  isJsonOutput,
  readAgentOverride,
  stampAgentOverride,
  verdictOutcome,
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

test("a child's exit decodes to its verdict: 0 green, 2 parked, any other code failed with error(n)", () => {
  assert.deepEqual(decodeChildExit(0, false), { kind: "green" });
  assert.deepEqual(decodeChildExit(2, false), { kind: "parked" });
  assert.deepEqual(decodeChildExit(1, false), { kind: "failed", detail: "error(1)" });
  assert.deepEqual(
    decodeChildExit(137, true),
    { kind: "failed", detail: "error(137)" },
    "an exit code is decoded as such even under a stop",
  );
});

test("a child killed by a signal is stopped while the campaign is halted, else failed naming the signal", () => {
  assert.deepEqual(decodeChildExit("SIGTERM", true), { kind: "stopped", signal: "SIGTERM" });
  assert.deepEqual(decodeChildExit("SIGTERM", false), { kind: "failed", detail: "error(SIGTERM)" });
});

test("a spawn or stop-handling rejection decodes to a failure carrying its message", () => {
  assert.deepEqual(decodeChildRejection(new Error("spawn ENOENT")), { kind: "failed", detail: "error(spawn ENOENT)" });
  assert.deepEqual(decodeChildRejection("boom"), { kind: "failed", detail: "error(boom)" });
});

test("a verdict's outcome is the campaign's outcome string, and only a failure's reads as a failure", () => {
  assert.equal(verdictOutcome({ kind: "green" }), "green");
  assert.equal(verdictOutcome({ kind: "parked" }), "parked");
  assert.equal(verdictOutcome({ kind: "failed", detail: "error(1)" }), "error(1)");
  assert.equal(isFailedOutcome("error(1)"), true);
  assert.equal(isFailedOutcome("error(merge failed)"), true);
  for (const o of ["green", "parked", undefined]) assert.equal(isFailedOutcome(o), false, String(o));
});
