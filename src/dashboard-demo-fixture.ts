import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A realistic in-flight campaign, materialized as the exact files the dashboard
 * reads (a live `orchestrator.jsonl` + parked records), so the site can be driven
 * end-to-end without running real agents — for the integration test and for
 * populating a running dashboard to look at.
 *
 * The run is deliberately rich: a closed wave, a running wave holding a completed,
 * a running (multi-turn), and a parked issue, a carved issue in a later wave, and
 * an agent-authored summary on every turn so the issue-detail turn log has real
 * content. It emits no `campaign-done`/`campaign-halt`, so the run reads live.
 */
export const DEMO_PROJECT = "acme-checkout";
export const DEMO_CAMPAIGN = "guest checkout";

const TITLES: Record<string, string> = {
  "201": "Cart persists across sessions",
  "202": "Stock check on add-to-cart",
  "203": "Guest checkout entry point",
  "204": "Session guard middleware",
  "205": "Payment provider selection",
  "206": "Order confirmation email",
  "207": "Receipt PDF",
  "208": "Promo code field",
};

export const DEMO_PARKED_QUESTION =
  "Which payment providers should guest checkout offer at launch?\n\nOptions:\n- A: Stripe only\n- B: Stripe + PayPal\n- C: Stripe + PayPal + Apple Pay";

/** The live run's event log, timestamped relative to `now` so "waiting"/elapsed read sensibly. */
export function demoEvents(now: Date = new Date()): object[] {
  const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  return [
    { ts: at(0), event: "campaign-start", batches: [["201", "202"], ["203", "204", "205"], ["206", "207", "208"]], name: DEMO_CAMPAIGN, titles: TITLES },
    // Wave 0 — closed, both merged.
    { ts: at(1), event: "campaign-batch", index: 0 },
    { ts: at(1), event: "queue-start", taskIds: ["201", "202"] },
    { ts: at(2), event: "turn", taskId: "201", turn: 0, summary: "Wrote a failing test for cart persistence across a fresh session, then backed it with a keyed store." },
    { ts: at(2), event: "turn", taskId: "202", turn: 0, summary: "Pinned add-to-cart against a sold-out fixture so it returns 409 instead of silently overselling." },
    { ts: at(4), event: "green", taskId: "201", branch: "agent/201" },
    { ts: at(4), event: "green", taskId: "202", branch: "agent/202" },
    { ts: at(5), event: "queue-done", outcomes: { "201": "green", "202": "green" } },
    { ts: at(5), event: "campaign-batch-done", index: 0, merged: ["201", "202"] },
    // Wave 1 — running now: one completed, one mid-flight (3 turns), one parked.
    { ts: at(6), event: "campaign-batch", index: 1 },
    { ts: at(6), event: "queue-start", taskIds: ["203", "204", "205"] },
    { ts: at(7), event: "queue-spawn", taskId: "203", running: 1, left: 2 },
    { ts: at(7), event: "queue-spawn", taskId: "204", running: 2, left: 1 },
    { ts: at(7), event: "queue-spawn", taskId: "205", running: 3, left: 0 },
    { ts: at(8), event: "turn", taskId: "203", turn: 0, summary: "Added the /checkout/guest route behind a test asserting an anonymous cart reaches it." },
    { ts: at(9), event: "green", taskId: "203", branch: "agent/203" },
    { ts: at(8), event: "turn", taskId: "204", turn: 0, summary: "Red test: an expired session should redirect to /login, not 500 — it currently 500s." },
    { ts: at(10), event: "turn", taskId: "204", turn: 1, summary: "Extracted the guard into middleware; the redirect passes but two existing route tests now fail." },
    { ts: at(12), event: "turn", taskId: "204", turn: 2, summary: "Fixed the two callers to mount the middleware; full suite green, tidying names before I signal." },
    { ts: at(8), event: "turn", taskId: "205", turn: 0, summary: "Provider-selection test in place; blocked on which providers to offer at launch." },
    { ts: at(11), event: "parked", taskId: "205", reason: "blocked" },
    // Parking a slot preserves its worktree; the loop logs the path so the sheet can show it.
    { ts: at(11), event: "worktree-preserved", taskId: "205", path: ".sandcastle.local/wt/205" },
    // A carve drops the promo-code work (unstarted) from the plan.
    { ts: at(13), event: "carve", target: "208", removed: ["208"] },
    // Wave 2 (206, 207) is left unstarted — queued.
  ];
}

/** The parked records the live run leaves on disk, keyed by task id. */
export function demoParked(now: Date = new Date()): Record<string, object> {
  const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
  return {
    "205": { taskId: "205", parkedAt: at(11), reason: "blocked", branch: "agent/205", sessionId: "sess-205", question: DEMO_PARKED_QUESTION },
  };
}

/** Materialize the demo run into a base location: the live event log and the parked record(s). */
export function seedDemoRun(baseLocation: string, now: Date = new Date()): void {
  mkdirSync(join(baseLocation, "logs"), { recursive: true });
  mkdirSync(join(baseLocation, "parked"), { recursive: true });
  writeFileSync(join(baseLocation, "logs", "orchestrator.jsonl"), demoEvents(now).map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [taskId, rec] of Object.entries(demoParked(now))) {
    writeFileSync(join(baseLocation, "parked", `${taskId}.json`), JSON.stringify(rec, null, 2));
  }
}
