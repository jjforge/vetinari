#!/usr/bin/env -S npx tsx
/**
 * The demo dashboard fixture as a dev tool, not an operator mode (design §12): `make
 * demo-create` / `make demo-remove` invoke this via `tsx`, calling the same
 * `createDemo`/`removeDemo` the dashboard coverage test drives. It seeds a set of
 * registered projects that between them render every dashboard state, under the demo
 * root ($VETINARI_DEMO_DIR, default ~/.cache/vetinari-demo), so the status UI can be
 * clicked through without running real agents. `create` is idempotent (clear-then-reseed);
 * `remove` deletes only the demo root and the pointers under it (never a real project).
 */
import { gatewayConfigDir } from "../src/registry.ts";
import { createDemo, demoRoot, removeDemo } from "../src/dashboard-demo-fixture.ts";

const sub = process.argv[2];
if (sub !== "create" && sub !== "remove") {
  console.error("usage: tsx scripts/demo.ts create | remove");
  process.exit(1);
}

const configDir = gatewayConfigDir();
const root = demoRoot();

if (sub === "create") {
  // Idempotent: clear any prior demo first, so a re-run refreshes rather than
  // duplicating or stacking stale state.
  removeDemo(configDir, root);
  const { projects } = createDemo(configDir, root);
  console.log(
    `seeded + registered ${projects.length} demo project(s) under ${root}: ${projects.join(", ")}\n` +
      `registry: ${configDir} — refresh the running dashboard to see them.`,
  );
} else {
  const { removed } = removeDemo(configDir, root);
  console.log(
    removed.length
      ? `removed ${removed.length} demo project(s) (${removed.join(", ")}) and deleted ${root}`
      : `no demo projects registered under ${root} — nothing to remove.`,
  );
}
