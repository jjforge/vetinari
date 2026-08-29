import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { listProjects, register } from "./registry.ts";
import { serveAllStatus } from "./status.ts";
import {
  archiveStatusConfig,
  buildStatus,
  cardState,
  listArchivedRuns,
  statusConfigFromPointer,
  type DisplayStatus,
  type Membership,
  type RunState,
} from "./dashboard-model.ts";
import {
  ALL_DISPLAY_STATUSES,
  ALL_MEMBERSHIPS,
  ALL_RUN_STATES,
  createDemo,
  DEMO_PARKED_PROJECT,
  removeDemo,
} from "./dashboard-demo-fixture.ts";

/**
 * Read every seeded demo project back through the SAME model the dashboard renders
 * from, and collect which lifecycle `DisplayStatus` chips, which `Membership` badges,
 * and which `RunState` cards actually surface across all of them: the live status per
 * project (`buildStatus` + `cardState`) plus each archived run read back as a dead run
 * (`buildStatus({ dead: true })`, the stalled read the page does, ADR 0019). This is the
 * coverage guard — it asserts the demo *renders* each state, not that the fixture literal
 * names it.
 */
function coverageFromModel(configDir: string): { statuses: Set<DisplayStatus>; memberships: Set<Membership>; runStates: Set<RunState> } {
  const statuses = new Set<DisplayStatus>();
  const memberships = new Set<Membership>();
  const runStates = new Set<RunState>();
  const collect = (waves: { issues: { status: DisplayStatus; membership?: Membership }[] }[]) => {
    for (const wave of waves) for (const issue of wave.issues) {
      statuses.add(issue.status);
      memberships.add(issue.membership ?? "member");
    }
  };
  for (const pointer of listProjects(configDir)) {
    const live = buildStatus(statusConfigFromPointer(pointer));
    runStates.add(cardState(live));
    collect(live.waves);
    for (const run of listArchivedRuns(pointer.baseLocation)) {
      collect(buildStatus(archiveStatusConfig(pointer.project, run.file), { dead: true }).waves);
    }
  }
  return { statuses, memberships, runStates };
}

test("the demo covers every dashboard state — a new DisplayStatus/Membership/RunState goes red until the seed renders it (#225)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-demo-"));
  const root = join(configDir, "demo");
  try {
    createDemo(configDir, root, new Date(Date.now() - 30 * 60 * 1000));
    const { statuses, memberships, runStates } = coverageFromModel(configDir);

    const missingStatuses = ALL_DISPLAY_STATUSES.filter((s) => !statuses.has(s));
    const missingMemberships = ALL_MEMBERSHIPS.filter((s) => !memberships.has(s));
    const missingRunStates = ALL_RUN_STATES.filter((s) => !runStates.has(s));
    // Name exactly which state is unrepresented, so a new union member tells the
    // implementer what the seed must grow to cover rather than just "they differ".
    assert.deepEqual(
      { missingStatuses, missingMemberships, missingRunStates },
      { missingStatuses: [], missingMemberships: [], missingRunStates: [] },
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("demo create is idempotent — re-running refreshes rather than duplicating or erroring (#225)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-demo-"));
  const root = join(configDir, "demo");
  try {
    const first = createDemo(configDir, root, new Date());
    const again = createDemo(configDir, root, new Date());
    assert.deepEqual(again.projects, first.projects, "same project set on re-run");
    // One pointer per project — a re-run overwrote, it did not accumulate duplicates.
    assert.equal(listProjects(configDir).length, first.projects.length);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("demo remove unregisters exactly the demo projects and leaves a real one untouched; a no-op when nothing is seeded (#225)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-demo-"));
  const root = join(configDir, "demo");
  const realBase = join(configDir, "real-project", ".vetinari.local");
  try {
    // A real project registered OUTSIDE the demo root — remove must never touch it.
    register(configDir, { project: "real-project", projectRoot: join(configDir, "real-project"), baseLocation: realBase });

    const { projects } = createDemo(configDir, root, new Date());
    assert.ok(projects.length >= 5, "seeds one project per RunState");

    const { removed } = removeDemo(configDir, root);
    assert.deepEqual(removed.slice().sort(), projects.slice().sort(), "removed exactly the demo projects");
    assert.equal(existsSync(root), false, "the demo root is gone");

    const left = listProjects(configDir);
    assert.deepEqual(left.map((p) => p.project), ["real-project"], "the real project survives");

    // A second remove finds nothing under the (now absent) root — a clean no-op.
    assert.deepEqual(removeDemo(configDir, root).removed, []);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("integration: the parked demo project serves a live, populated campaign page and parked queue (#225)", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "vetinari-demo-"));
  const root = join(configDir, "demo");
  // Seed relative to the present so the run reads *live* and its events land inside
  // the feed's 48h window (measured against the handlers' real clock).
  createDemo(configDir, root, new Date(Date.now() - 30 * 60 * 1000));

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const getJson = async (path: string) => (await fetch(base + path)).json();
  try {
    const landing = await getJson("/api/landing");
    const card = landing.projects.find((p: { project: string }) => p.project === DEMO_PARKED_PROJECT);
    assert.ok(card, "the parked demo project has a landing card");
    assert.equal(card.runState, "parked");
    const parked = landing.parked.find((p: { project: string }) => p.project === DEMO_PARKED_PROJECT);
    assert.ok(parked, "its parked question is in the cross-repo queue");

    // Its campaign page renders member rows across the states its issues cover.
    const page = await (await fetch(`${base}/?project=${DEMO_PARKED_PROJECT}`)).text();
    assert.match(page, /class="wave-member [a-z]+"/);
    for (const status of ["completed", "running", "parked", "pruned"]) {
      assert.match(page, new RegExp(status), `page renders a ${status} member row`);
    }

    const feed = await getJson("/api/feed");
    assert.ok(feed.length > 0, "the feed has rows across the seeded projects");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(configDir, { recursive: true, force: true });
  }
});
