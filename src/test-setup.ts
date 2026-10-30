// Preloaded into every test-file process by `npm test` (`tsx --test --import`). Functions that
// default their logger to `hostLogger()` write under `gatewayConfigDir()`, so without this a test
// run appends fixture rows to the operator's real host log. Point the gateway home at a fresh
// temp dir unless the caller already chose one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.VETINARI_GATEWAY_HOME) {
  const gatewayHome = mkdtempSync(join(tmpdir(), "vetinari-test-gateway-"));
  process.env.VETINARI_GATEWAY_HOME = gatewayHome;
  process.on("exit", () => rmSync(gatewayHome, { recursive: true, force: true }));
}
