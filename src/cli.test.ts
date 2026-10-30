// Tests for the CLI entry point's argv split (cli.mts). The split runs at the module's
// top level, so these spawn the real CLI through tsx in a temp cwd. `--config <path>`
// is `import()`ed, so it is honoured only before the mode — after the mode it gets no
// special treatment, and text a dashboard route forwards can never become it (#524).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.mts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

// A temp git checkout (project-scoped modes resolve their root from git before loading
// config) holding a module that writes a sentinel file the moment it is imported.
const sentinelModule = () => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-cli-config-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const sentinel = join(dir, "imported");
  const module = join(dir, "config.mjs");
  writeFileSync(module, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "x");\nexport default {};\n`);
  return { dir, module, sentinel };
};

test("`--config <path>` after the mode is never imported", () => {
  const { dir, module, sentinel } = sentinelModule();
  spawnSync(TSX, [CLI, "graft", "1", "--config", module, "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.equal(existsSync(sentinel), false, "the module after the mode must not be imported");
});

test("`--config <path>` before the mode still loads that config", () => {
  const { dir, module, sentinel } = sentinelModule();
  spawnSync(TSX, [CLI, "--config", module, "graft", "1", "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.equal(existsSync(sentinel), true, "the pre-mode config is imported");
});
