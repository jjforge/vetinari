import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The shipped TDD prompt is what config.ts resolves as the default promptFile
// (`../prompts/tdd.md` from src/). Read the same artifact the loop injects into
// each agent container so this pins the prompt agents actually receive.
const prompt = readFileSync(
  new URL("../prompts/tdd.md", import.meta.url),
  "utf8",
);

test("the TDD prompt still carries the {{TASK}} payload placeholder", () => {
  assert.match(prompt, /\{\{TASK\}\}/);
});

test("the TDD prompt directs the agent to read the whole ticket — full body and every comment", () => {
  // Acceptance criterion #1: the prompt must instruct reading the entire ticket
  // (title + full body + all comments), not just anchor on the title.
  assert.match(prompt, /\bentire\b|\bwhole\b/i);
  assert.match(prompt, /\bbody\b/i);
  assert.match(prompt, /\bcomment/i);
});

test("the TDD prompt names body and comments as authoritative for acceptance criteria and design intent", () => {
  // The title is only a label; the real spec lives lower in the ticket. The
  // prompt must say so, so an agent does not implement from the summary alone.
  const section =
    prompt.match(/[^\n]*\bcomment[^]*?(?:\n\n|$)/i)?.[0] ?? prompt;
  assert.match(section, /acceptance criteria|design intent/i);
  assert.match(section, /authoritative/i);
  assert.match(prompt, /title[^]*?\blabel\b/i);
});
