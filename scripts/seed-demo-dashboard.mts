/**
 * Seed the demo campaign into the local dashboard so a running `status` server
 * shows a populated, live-looking project to click through — repeatable.
 *
 *   npx tsx scripts/seed-demo-dashboard.mts          # seed + register
 *   npx tsx scripts/seed-demo-dashboard.mts --clear  # unregister + delete
 *
 * The mock itself lives in src/dashboard-demo-fixture.ts (also used by the
 * dashboard integration test); this script just materializes it into the gateway
 * config dir the `status` server reads.
 */
import { rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayConfigDir, register } from "../src/registry.ts";
import { seedDemoRun, DEMO_PROJECT } from "../src/dashboard-demo-fixture.ts";

const baseLocation = process.env.VETINARI_DEMO_DIR ?? join(homedir(), ".cache", "vetinari-demo");
const configDir = gatewayConfigDir();
const pointerFile = join(configDir, "registry", `${DEMO_PROJECT}.json`);

if (process.argv.includes("--clear")) {
  rmSync(baseLocation, { recursive: true, force: true });
  if (existsSync(pointerFile)) rmSync(pointerFile);
  console.log(`cleared demo '${DEMO_PROJECT}': removed ${baseLocation} and its registry pointer`);
} else {
  seedDemoRun(baseLocation, new Date());
  register(configDir, { project: DEMO_PROJECT, projectRoot: join(baseLocation, "root"), baseLocation });
  console.log(`seeded + registered '${DEMO_PROJECT}' -> ${baseLocation}`);
  console.log(`registry: ${configDir} — refresh the running dashboard to see it.`);
}
