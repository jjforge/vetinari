// Tests for the CLI entry point's argv split (cli.mts). The split runs at the module's
// top level, so these spawn the real CLI through tsx in a temp cwd. `--config <path>`
// is `import()`ed, so it is honoured only before the mode — after the mode it gets no
// special treatment, and text a dashboard route forwards can never become it (#524).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("`gateway` exits 0 on SIGTERM, so a service stop is a clean exit rather than a kill", async () => {
  const home = mkdtempSync(join(tmpdir(), "vetinari-cli-gateway-home-"));
  // A `docker` stub that fails, so the Docker-peer subnet listing never runs the real one.
  const bin = mkdtempSync(join(tmpdir(), "vetinari-cli-gateway-bin-"));
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "docker"), 0o755);
  const child = spawn(TSX, [CLI, "gateway"], {
    cwd: home,
    env: {
      ...process.env,
      VETINARI_GATEWAY_HOME: home,
      VETINARI_GATEWAY_STATUS_PORT: "0",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("vetinari status: http://")) resolve();
      });
      child.once("exit", (code, signal) => reject(new Error(`gateway exited before serving: ${code} ${signal}\n${out}`)));
    });
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("exit", (code, signal) => resolve([code, signal])),
    );
    child.kill("SIGTERM");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit after SIGTERM")), 10_000).unref());
    const [code, signal] = await Promise.race([exited, timeout]);
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
