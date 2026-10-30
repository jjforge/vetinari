import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read a JSON file at the repo root, the way the drift tests read `docs/reference.md`. */
function readRootJson(file: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), file), "utf8"));
}

const manifest = readRootJson("package.json");
const lockfile = readRootJson("package-lock.json");

test("package.json declares the Node floor the README gives", () => {
  assert.equal(manifest.engines?.node, ">=22.15");
});

test("package.json pins tsx to the exact version the lockfile resolves", () => {
  const tsx = manifest.dependencies?.tsx;
  assert.match(tsx, /^\d+\.\d+\.\d+$/, `tsx must be an exact x.y.z version, got ${JSON.stringify(tsx)}`);
  assert.equal(tsx, lockfile.packages["node_modules/tsx"].version);
});

test("package-lock.json's root entry agrees with package.json on tsx and engines", () => {
  const root = lockfile.packages[""];
  assert.equal(root.dependencies?.tsx, manifest.dependencies.tsx);
  assert.equal(root.engines?.node, manifest.engines.node);
});
