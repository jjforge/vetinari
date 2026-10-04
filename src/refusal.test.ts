import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal, handleCliError } from "./refusal.ts";

// Spawn the real CLI (through the local tsx bin) so the process-wide handler and the
// pre-dispatch exit codes are exercised end to end — the only way to prove the handler
// is actually registered for a throw raised before command dispatch.
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const runCli = (args: string[], cwd: string) => spawnSync(TSX, [CLI, ...args], { cwd, encoding: "utf8" });

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
  handleCliError(new Refusal("not a git repository: /tmp — run this from inside your project's checkout."), {
    writeStderr: (s) => out.push(s),
    exit: (c) => exits.push(c),
  });
  const text = out.join("");
  assert.equal(text, "not a git repository: /tmp — run this from inside your project's checkout.\n", "exactly the message, nothing else");
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

test("the handler is registered before dispatch: `parked` in a non-git dir prints the refusal on stderr, no stack frames, exit 4", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-norepo-"));
  const r = runCli(["parked"], dir);
  assert.equal(r.status, 4, "a pre-dispatch refusal exits 4");
  assert.match(r.stderr, /not a git repository/);
  assert.match(r.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the directory");
  assert.ok(!/\n\s+at /.test(r.stderr), "no `    at …` stack frames");
  assert.equal(r.stdout, "", "nothing on stdout");
});

test("a bare `vetinari` is a usage refusal: usage on stderr, exit 4, outside any project", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-bare-"));
  const r = runCli([], dir);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /vetinari <mode> \[args\]/);
  assert.equal(r.stdout, "", "usage does not go to stdout for a refusal");
});

test("`vetinari --help` is not a refusal: usage on stdout, exit 0, outside any project", () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-help-"));
  const r = runCli(["--help"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vetinari <mode> \[args\]/);
});
