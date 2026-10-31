import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every environment variable name a source text reads or sets: each `process.env.NAME` and
 * `process.env["NAME"]`, the same reads through an injected env object (`env.NAME`,
 * `env["NAME"]`), and each string assigned to an exported `*_ENV_VAR` constant (read
 * back through `process.env[CONST]`).
 */
function envVarsInSource(src: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    // `process.env.X` and an injected `env.X` alike — `\b` admits the `.` before `env`.
    /\benv\.([A-Z_][A-Z0-9_]*)/g,
    /\benv\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g,
    /export\s+const\s+[A-Z0-9_]*_ENV_VAR\s*=\s*["'`]([A-Z_][A-Z0-9_]*)["'`]/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}

/** The names in `names` that `section` never mentions backticked, sorted. */
function undocumentedEnvVars(names: Iterable<string>, section: string): string[] {
  return [...names].filter((n) => !section.includes(`\`${n}\``)).sort();
}

test("the env collector finds process.env reads, bracket reads and exported *_ENV_VAR constants", () => {
  const src = [
    `const a = process.env.FOO_BAR ?? "x";`,
    `if (process.env["BAZ"]) go();`,
    `export const THING_ENV_VAR = "QUX_1";`,
    `process.env[k] = v; // dynamic — not a name`,
  ].join("\n");
  assert.deepEqual([...envVarsInSource(src)].sort(), ["BAZ", "FOO_BAR", "QUX_1"]);
});

test("the env collector finds reads through an injected env object, dotted and bracketed", () => {
  const src = [
    `const port = env.FOO ?? env.STATUS_PORT;`,
    `const token = env["BAR_2"];`,
    `const lower = env.notAVar; // lower-case — not an env name`,
  ].join("\n");
  assert.deepEqual([...envVarsInSource(src)].sort(), ["BAR_2", "FOO", "STATUS_PORT"]);
});

test("a variable the source reads but the section omits is named as undocumented", () => {
  const src = `const p = process.env.SOME_NEW_VAR; const q = process.env.KNOWN;`;
  const section = "| `KNOWN` | host env | documented |";
  assert.deepEqual(undocumentedEnvVars(envVarsInSource(src), section), ["SOME_NEW_VAR"]);
});

/**
 * Read from the environment but not vetinari configuration: passed through to child processes
 * as-is (the `PATH`/`SHELL` of a spawned shell), so the reference does not document them.
 */
const ENV_REFERENCE_PASSTHROUGH = new Set(["PATH", "SHELL"]);

/** Every env var name the non-test `src/*.ts` and `src/*.mts` sources read or set. */
function envVarsInRepoSources(): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync("src")) {
    if (!/\.m?ts$/.test(f) || f.endsWith(".test.ts")) continue;
    for (const n of envVarsInSource(readFileSync(join("src", f), "utf8"))) names.add(n);
  }
  return names;
}

/** `docs/reference.md`'s `## Environment variables` section, up to the next `## ` heading. */
function referenceEnvSection(): string {
  const md = readFileSync(join(process.cwd(), "docs/reference.md"), "utf8");
  const start = md.indexOf("\n## Environment variables\n");
  assert.ok(start >= 0, "docs/reference.md has no `## Environment variables` section");
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start, end < 0 ? undefined : end);
}

test("docs/reference.md documents every environment variable src/ reads or sets", () => {
  const names = [...envVarsInRepoSources()].filter((n) => !ENV_REFERENCE_PASSTHROUGH.has(n));
  assert.deepEqual(undocumentedEnvVars(names, referenceEnvSection()), [], "add these to docs/reference.md's `## Environment variables`");
});

/** Plumbing between vetinari's own processes (and the demo fixture's root) — not configuration. */
const ENV_REFERENCE_INTERNAL = [
  "VETINARI_CHILD",
  "VETINARI_JSON",
  "VETINARI_RESUME_SESSION",
  "VETINARI_RESUME_PROMPT",
  "VETINARI_DEMO_DIR",
  "VETINARI_AGENT",
  "VETINARI_ANSWER_SOURCE",
];

test("the internal environment variables are documented under `### Internal`, not in the main table", () => {
  const section = referenceEnvSection();
  const at = section.indexOf("\n### Internal\n");
  assert.ok(at >= 0, "`## Environment variables` has no `### Internal` subheading");
  const [main, internal] = [section.slice(0, at), section.slice(at)];
  assert.deepEqual(undocumentedEnvVars(ENV_REFERENCE_INTERNAL, internal), [], "missing under `### Internal`");
  assert.deepEqual(
    ENV_REFERENCE_INTERNAL.filter((n) => main.includes(`\`${n}\``)),
    [],
    "internal, so not in the main table",
  );
});
