import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { register } from "./registry.ts";
import { serveAllStatus } from "./status.ts";
import { seedDemoRun, DEMO_PROJECT, DEMO_CAMPAIGN } from "./dashboard-demo-fixture.ts";

// End-to-end over the real HTTP surface: seed the exact files the site reads (a
// live run + a parked record), serve it, and drive every dashboard surface at
// once — landing, campaign page, issue detail, feed, and the parked queue.
test("integration: a seeded live run populates the landing, campaign, issue detail, feed and parked queue", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "sctdd-demo-"));
  const baseLocation = join(configDir, "base");
  seedDemoRun(baseLocation, new Date("2026-08-22T09:00:00.000Z"));
  register(configDir, { project: DEMO_PROJECT, projectRoot: join(configDir, "root"), baseLocation });

  const server = await serveAllStatus(configDir, { port: 0, host: "127.0.0.1" });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const getJson = async (path: string) => (await fetch(base + path)).json();
  try {
    // Landing — the demo reads live, with the working/parked/queued tally and a cross-repo parked queue.
    const landing = await getJson("/api/landing");
    const card = landing.projects.find((p: { project: string }) => p.project === DEMO_PROJECT);
    assert.ok(card, "the demo project has a landing card");
    assert.notEqual(card.runState, "idle");
    assert.equal(card.campaignName, DEMO_CAMPAIGN);
    assert.equal(card.tally.parked, 1); // #205
    assert.equal(card.tally.queued, 2); // #206, #207 (#208 was carved out)
    assert.ok(card.tally.running >= 1, "at least #204 is running");
    assert.equal(landing.counters.parked, 1);
    assert.equal(landing.counters.queued, 2);
    const parked = landing.parked.find((p: { issueNumber: string }) => p.issueNumber === "205");
    assert.ok(parked, "the parked queue lists #205");
    assert.match(parked.question, /payment providers/i);

    // Campaign page — chips render every status, including the carved #208.
    const page = await (await fetch(`${base}/?project=${DEMO_PROJECT}`)).text();
    assert.match(page, /class="chip"/);
    for (const status of ["completed", "running", "parked", "carved"]) {
      assert.match(page, new RegExp(status), `page renders a ${status} chip`);
    }

    // Issue detail — #204's turn log is three agent-authored turns, newest first.
    const d204 = await getJson(`/api/issue?project=${DEMO_PROJECT}&issue=204`);
    assert.equal(d204.status, "running");
    assert.equal(d204.turns, 3);
    assert.equal(d204.turnLog.length, 3);
    assert.equal(d204.turnLog[0].turn, 2, "newest turn first");
    assert.ok(d204.turnLog.every((t: { summary: string }) => t.summary.length > 0), "every turn carries a summary");
    assert.ok(d204.elapsedMs > 0, "elapsed spans the turns");
    assert.equal((await getJson(`/api/issue?project=${DEMO_PROJECT}&issue=208`)).status, "carved");
    assert.equal((await getJson(`/api/issue?project=${DEMO_PROJECT}&issue=205`)).status, "parked");

    // Feed — repo-prefixed sentences.
    const feed = await getJson("/api/feed");
    assert.ok(feed.length > 0, "the feed has rows");
    assert.ok(
      feed.every((r: { text: string }) => typeof r.text === "string" && r.text.startsWith(`${DEMO_PROJECT} —`)),
      "every feed row is repo-prefixed",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(configDir, { recursive: true, force: true });
  }
});
