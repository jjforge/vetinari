import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Load the setup module as a preload in a child process (as `npm test` does for each test
// file) and read back the gateway home it leaves in the environment.
const SETUP = fileURLToPath(new URL("./test-setup.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const printedGatewayHome = (gatewayHome: string | undefined): string => {
  const env = { ...process.env };
  delete env.VETINARI_GATEWAY_HOME;
  if (gatewayHome !== undefined) env.VETINARI_GATEWAY_HOME = gatewayHome;
  const run = spawnSync(TSX, ["--import", SETUP, "-e", "console.log(process.env.VETINARI_GATEWAY_HOME)"], {
    env,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

test("the test setup points an unset VETINARI_GATEWAY_HOME at a fresh directory under the OS temp dir", () => {
  const home = printedGatewayHome(undefined);
  assert.ok(home.startsWith(tmpdir() + sep), `${home} is under ${tmpdir()}`);
});

test("the test setup leaves a preset VETINARI_GATEWAY_HOME unchanged", () => {
  const preset = join(tmpdir(), "vetinari-preset-gateway-home");
  assert.equal(printedGatewayHome(preset), preset);
});

// Anchored at the package root, not `./src/…`: a test that re-spawns node with
// `process.execArgv` from another cwd (dashboard-child) must still resolve the preload.
test("npm test passes the test setup to the runner as a preload, by a cwd-independent path", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /^tsx --test --import "\$PWD\/src\/test-setup\.ts" /);
});
