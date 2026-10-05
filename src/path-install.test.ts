import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePathInstallArgs, planPathInstall, renderWrapper, resolvedWrapper, WRAPPER_MARKER } from "./path-install.ts";

// The same fixed launch the resolveGatewayExecStart tests use (migrate.test.ts).
const APP_LAUNCH = {
  execPath: "/opt/node/bin/node",
  execArgv: ["--require", "/app/node_modules/tsx/dist/preflight.cjs", "--import", "file:///app/node_modules/tsx/dist/loader.mjs"],
  argv1: "/app/src/cli.mts",
};

test("renderWrapper writes a /bin/sh script that execs PATH's node with the tsx loader and the cli", () => {
  const script = renderWrapper(APP_LAUNCH);

  assert.equal(
    script,
    "#!/bin/sh\n" +
      `${WRAPPER_MARKER}\n` +
      'exec node --require /app/node_modules/tsx/dist/preflight.cjs --import file:///app/node_modules/tsx/dist/loader.mjs /app/src/cli.mts "$@"\n',
  );
  // node comes from the operator's PATH — the pinned execPath is not baked in, and none
  // of the launchers that make a bin shim useless outside this checkout appear.
  assert.ok(!script.includes("/opt/node/bin/node"));
  assert.doesNotMatch(script, /\bnpx\b/);
  assert.doesNotMatch(script, /\benv\b/);
});

test("renderWrapper single-quotes a launch path with a space or a quote, and sh parses it back verbatim", () => {
  const script = renderWrapper({ execPath: "/opt/node/bin/node", execArgv: [], argv1: "/home/z z/it's/cli.mts" });
  assert.match(script, /^exec node '\/home\/z z\/it'\\''s\/cli\.mts' "\$@"$/m);

  // Swap `exec node` for `printf` so running the script echoes exactly the words sh parsed.
  const dir = mkdtempSync(join(tmpdir(), "vetinari-path-install-"));
  const file = join(dir, "vetinari");
  writeFileSync(file, script.replace("exec node", "printf '%s\\n'"));
  assert.equal(spawnSync("sh", ["-n", file]).status, 0, "sh -n accepts the script");
  const run = spawnSync("sh", [file, "a b"], { encoding: "utf8" });
  assert.equal(run.stdout, "/home/z z/it's/cli.mts\na b\n");
});

test("resolvedWrapper writes the real src/cli.mts path when argv1 is a symlink (an npx-cache launch)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vetinari-path-install-")));
  mkdirSync(join(root, "checkout", "src"), { recursive: true });
  const real = join(root, "checkout", "src", "cli.mts");
  writeFileSync(real, "");
  mkdirSync(join(root, "npx-cache", ".bin"), { recursive: true });
  const link = join(root, "npx-cache", ".bin", "vetinari");
  symlinkSync(real, link);

  const script = resolvedWrapper({ ...APP_LAUNCH, argv1: link });
  assert.ok(script.includes(` ${real} "$@"`), script);
  assert.ok(!script.includes(link));
});

const WRAPPER = renderWrapper(APP_LAUNCH);
const ON_PATH = { PATH: "/usr/bin:/home/me/.local/bin", SHELL: "/bin/bash" };
const plan = (existing: string | undefined, force = false) =>
  planPathInstall({ dir: "/home/me/.local/bin", content: WRAPPER, existing, force, env: ON_PATH });

test("planPathInstall writes <dir>/vetinari when nothing is there", () => {
  const p = plan(undefined);
  assert.equal(p.target, "/home/me/.local/bin/vetinari");
  assert.equal(p.content, WRAPPER);
  assert.equal(p.action, "write");
});

test("planPathInstall rewrites a file it wrote before — even an identical one (an idempotent rerun)", () => {
  assert.equal(plan(WRAPPER).action, "rewrite");
  assert.equal(plan(`#!/bin/sh\n${WRAPPER_MARKER}\nexec node /old/checkout/src/cli.mts "$@"\n`).action, "rewrite");
});

test("planPathInstall refuses a file it did not write, naming the path and --force", () => {
  const p = plan("#!/bin/sh\necho someone else's vetinari\n");
  assert.equal(p.action, "refuse");
  assert.match(p.refusal ?? "", /\/home\/me\/\.local\/bin\/vetinari/);
  assert.match(p.refusal ?? "", /--force/);
});

test("planPathInstall overwrites a file it did not write when forced", () => {
  assert.equal(plan("#!/bin/sh\necho someone else's vetinari\n", true).action, "overwrite");
});

const planWithEnv = (env: { PATH?: string; SHELL?: string }) =>
  planPathInstall({ dir: "/home/me/.local/bin", content: WRAPPER, force: false, env });

test("planPathInstall reports the dir as on PATH when a PATH entry names it, trailing slash or not", () => {
  for (const PATH of ["/usr/bin:/home/me/.local/bin", "/home/me/.local/bin/:/usr/bin"]) {
    const p = planWithEnv({ PATH, SHELL: "/bin/bash" });
    assert.equal(p.onPath, true, PATH);
    assert.equal(p.profileLine, undefined, PATH);
  }
});

test("planPathInstall still installs off PATH, and gives the export line to add to the shell profile", () => {
  const p = planWithEnv({ PATH: "/usr/bin:/home/me/.local/binx", SHELL: "/bin/zsh" });
  assert.equal(p.action, "write");
  assert.equal(p.onPath, false);
  assert.equal(p.profileLine, 'export PATH="/home/me/.local/bin:$PATH"');
  assert.equal(planWithEnv({}).profileLine, 'export PATH="/home/me/.local/bin:$PATH"', "no PATH at all is off PATH");
});

test("planPathInstall gives fish_add_path when the shell is fish", () => {
  assert.equal(planWithEnv({ PATH: "/usr/bin", SHELL: "/usr/bin/fish" }).profileLine, "fish_add_path /home/me/.local/bin");
});

test("parsePathInstallArgs reads --dir as a resolved directory, and --force and --dry-run", () => {
  assert.deepEqual(parsePathInstallArgs(["--dir", "/x/bin/", "--force", "--dry-run"], "/home/z"), {
    dir: "/x/bin",
    force: true,
    dryRun: true,
  });
});

test("parsePathInstallArgs defaults the directory to <home>/.local/bin, with force and dry run off", () => {
  assert.deepEqual(parsePathInstallArgs([], "/home/z"), { dir: "/home/z/.local/bin", force: false, dryRun: false });
});

test("parsePathInstallArgs refuses --dir with no value or another flag as its value, naming the flag with an example", () => {
  for (const args of [
    ["--dir", "--dry-run"],
    ["--dir", "--force"],
    ["--force", "--dir"],
    ["--dir", ""],
  ]) {
    assert.deepEqual(
      parsePathInstallArgs(args, "/home/z"),
      { refusal: "install --dir needs a directory, e.g. --dir ~/bin" },
      args.join(" "),
    );
  }
});

// End to end: spawn the real CLI through the local tsx bin (as refusal.test.ts does), in
// a tmp cwd that is not a vetinari project — `install` is host-level and needs no config.
const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const runCli = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(TSX, [CLI, ...args], { cwd, env, encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "vetinari-path-install-"));

test("`vetinari install --dir` writes an executable wrapper that runs the CLI from any directory, and a rerun is idempotent", () => {
  const cwd = tmp();
  const bin = join(cwd, "bin");
  const target = join(bin, "vetinari");

  const first = runCli(["install", "--dir", bin], cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`vetinari install → ${target}`));
  assert.match(first.stdout, new RegExp(`Wrote ${target}\\.`));
  const written = readFileSync(target, "utf8");
  assert.ok(written.includes(WRAPPER_MARKER));
  assert.equal(statSync(target).mode & 0o777, 0o755);

  const help = spawnSync(target, ["--help"], { cwd: tmp(), encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /install \[--dir <d>\] \[--force\] \[--dry-run\]/);

  const second = runCli(["install", "--dir", bin], cwd);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(target, "utf8"), written);
});

test("`vetinari install --dry-run` prints the target and the wrapper and writes nothing", () => {
  const cwd = tmp();
  const target = join(cwd, "bin", "vetinari");
  const r = runCli(["install", "--dir", join(cwd, "bin"), "--dry-run"], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith(`vetinari install → ${target}\n\n#!/bin/sh\n${WRAPPER_MARKER}\nexec node `), r.stdout);
  assert.match(r.stdout, /"\$@"\n\n\(dry run — nothing was written\)/);
  assert.equal(existsSync(join(cwd, "bin")), false);
});

test("`vetinari install --dir --dry-run` refuses (exit 4, naming --dir) rather than installing into ./--dry-run", () => {
  const cwd = tmp();
  const r = runCli(["install", "--dir", "--dry-run"], cwd);
  assert.equal(r.status, 4, r.stdout);
  assert.equal(r.stderr.trim(), "install --dir needs a directory, e.g. --dir ~/bin");
  assert.equal(existsSync(join(cwd, "--dry-run")), false);
});

test("`vetinari install` refuses a foreign file at the target (exit 4, naming it) unless --force", () => {
  const cwd = tmp();
  const bin = join(cwd, "bin");
  const target = join(bin, "vetinari");
  mkdirSync(bin);
  writeFileSync(target, "#!/bin/sh\necho mine\n");

  for (const args of [
    ["install", "--dir", bin],
    ["install", "--dir", bin, "--dry-run"],
  ]) {
    const refused = runCli(args, cwd);
    assert.equal(refused.status, 4, args.join(" "));
    assert.ok(refused.stderr.includes(target), refused.stderr);
    assert.match(refused.stderr, /--force/);
    assert.equal(readFileSync(target, "utf8"), "#!/bin/sh\necho mine\n");
  }

  const forced = runCli(["install", "--dir", bin, "--force"], cwd);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(readFileSync(target, "utf8").includes(WRAPPER_MARKER));
});

test("`vetinari install` into a dir off PATH still writes, then prints the profile line for it", () => {
  const cwd = tmp();
  const bin = join(cwd, "bin");
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: "/bin/sh" };
  const r = runCli(["install", "--dir", bin], cwd, env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`export PATH="${bin}:$PATH"`), r.stdout);
  assert.ok(existsSync(join(bin, "vetinari")));
});

test("src/cli.mts keeps its `npx tsx` shebang — the in-repo convenience; the wrapper is how other projects reach it", () => {
  assert.ok(readFileSync(CLI, "utf8").startsWith("#!/usr/bin/env -S npx tsx\n"));
});
