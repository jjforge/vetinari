import test from "node:test";
import assert from "node:assert/strict";
import { Refusal, handleCliError } from "./refusal.ts";

test("Refusal is an Error subclass so existing catch sites keep working", () => {
  const r = new Refusal("nope");
  assert.ok(r instanceof Error);
  assert.ok(r instanceof Refusal);
  assert.equal(r.name, "Refusal");
  assert.equal(r.message, "nope");
});

test("handleCliError writes a Refusal's message alone on stderr (no stack frames) and exits 4", () => {
  const out: string[] = [];
  const exits: number[] = [];
  handleCliError(
    new Refusal(
      "not a git repository: /tmp — run this from inside your project's checkout.",
    ),
    { writeStderr: (s) => out.push(s), exit: (c) => exits.push(c) },
  );
  const text = out.join("");
  assert.equal(
    text,
    "not a git repository: /tmp — run this from inside your project's checkout.\n",
    "exactly the message, nothing else",
  );
  assert.ok(!/\n\s+at /.test(text), "no `    at …` stack frames");
  assert.deepEqual(exits, [4]);
});

test("handleCliError preserves a multi-line Refusal message verbatim", () => {
  const out: string[] = [];
  const exits: number[] = [];
  handleCliError(new Refusal("line one\nline two"), {
    writeStderr: (s) => out.push(s),
    exit: (c) => exits.push(c),
  });
  assert.equal(out.join(""), "line one\nline two\n");
  assert.deepEqual(exits, [4]);
});

test("handleCliError writes a plain Error's stack and exits 1", () => {
  const out: string[] = [];
  const exits: number[] = [];
  handleCliError(new Error("boom"), {
    writeStderr: (s) => out.push(s),
    exit: (c) => exits.push(c),
  });
  const text = out.join("");
  assert.match(text, /boom/);
  assert.match(text, /\n\s+at /, "a plain Error keeps its stack frames");
  assert.deepEqual(exits, [1]);
});
