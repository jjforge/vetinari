import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SECTION_ORDER } from "./changelog.ts";

// The shipped TDD prompt is what config.ts resolves as the default promptFile
// (`../prompts/tdd.md` from src/). Read the same artifact the loop injects into
// each agent container so this pins the prompt agents actually receive.
const prompt = readFileSync(new URL("../prompts/tdd.md", import.meta.url), "utf8");

// Markers bracketing the inline section-label list in the prompt, so the drift
// test reads the same delimited block agents do — and the fragment example's
// `section: Bug fixes` line cannot leak into the extraction.
const LABELS_BEGIN = "<!-- SECTION-LABELS:BEGIN";
const LABELS_END = "<!-- SECTION-LABELS:END";

/** The ` · `-delimited section labels listed inline in the prompt's fragment step. */
function promptSectionLabels(): string[] {
  const start = prompt.indexOf(LABELS_BEGIN);
  const end = prompt.indexOf(LABELS_END);
  assert.ok(start >= 0 && end > start, "prompts/tdd.md has no SECTION-LABELS block");
  const inner = prompt.slice(prompt.indexOf("-->", start) + "-->".length, end);
  return inner
    .split("·")
    .map((l) => l.trim())
    .filter(Boolean);
}

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
  const section = prompt.match(/[^\n]*\bcomment[^]*?(?:\n\n|$)/i)?.[0] ?? prompt;
  assert.match(section, /acceptance criteria|design intent/i);
  assert.match(section, /authoritative/i);
  assert.match(prompt, /title[^]*?\blabel\b/i);
});

test("the TDD prompt lists the changelog section labels inline, in SECTION_ORDER — neither can drift (#415)", () => {
  // The prompt must be self-sufficient: agents read the labels from the prompt
  // itself, not from docs/changelog-conventions.md (absent in consuming
  // projects). The list is pinned to SECTION_ORDER so an edit to either alone
  // fails here.
  assert.deepEqual(promptSectionLabels(), SECTION_ORDER);
});

test("the TDD prompt lists the four audience tags with a project-neutral meaning each (#415)", () => {
  for (const tag of ["[user]", "[ops]", "[api]", "[internal]"]) {
    assert.ok(prompt.includes("`" + tag + "`"), `prompt is missing the ${tag} audience tag`);
  }
});

test("the TDD prompt no longer sends agents to docs/changelog-conventions.md for labels or tags (#415)", () => {
  assert.ok(!prompt.includes("changelog-conventions"), "prompt still points at docs/changelog-conventions.md for the fragment vocabulary");
});

test("the TDD prompt warns that co-wave siblings may share a package and asks for unique package-level names (#404)", () => {
  // File-disjoint is not compile-disjoint in a package-scoped language: a sibling
  // ticket in the same wave may land in the same package, so the agent must prefer
  // unique, feature-specific names for new package-level identifiers, not generic
  // ones that collide at merge.
  assert.match(prompt, /package/i);
  assert.match(prompt, /sibling|co-wave|concurrently|same wave/i);
  assert.match(prompt, /unique/i);
});

test("the TDD prompt tells the agent it has no GitHub login and how a finding reaches the host instead (#440)", () => {
  // The container never holds tracker credentials, so an agent that tries `gh issue
  // create` fails and its finding dies in the closing account. The prompt every
  // project's agents receive must say so, and name the harvest turn's `<finding>`
  // block — the same tags parseFindings reads — as the route to the host.
  assert.match(prompt, /no GitHub login/i);
  assert.match(prompt, /never run `gh`/i);
  for (const tag of ["<finding>", "<summary>", "<location>", "<repro>"]) {
    assert.ok(prompt.includes(tag), `prompt is missing the ${tag} tag the harvest parser reads`);
  }
  assert.match(prompt, /final message/i, "prompt does not say where a finding goes when no harvest turn comes");
});

test("the TDD prompt points at the real command reference, not the README Modes table it no longer has (#437)", () => {
  // The README lost its Modes table to docs/reference.md (generated from MODES in
  // src/help.ts), so the prompt must not send every agent hunting for it — and must
  // word the pointer so it still reads in a consuming project.
  assert.ok(!/README's \*\*Modes\*\* table/.test(prompt), "prompt still sends agents to the README's Modes table");
  assert.match(prompt, /the project's command reference/);
  assert.ok(prompt.includes("`docs/reference.md`"), "prompt does not name docs/reference.md as vetinari's command reference");
  assert.ok(prompt.includes("`MODES` in `src/help.ts`"), "prompt does not say docs/reference.md is generated from MODES in src/help.ts");
});
