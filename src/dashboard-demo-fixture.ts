import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listProjects, register, removePointer } from "./registry.ts";
import type { DisplayStatus, Membership, RunState } from "./dashboard-model.ts";

/**
 * The demo dashboard fixture: a handful of registered projects that between them
 * render every state the dashboard can show, materialized as the exact files the
 * gateway reads (a live `orchestrator.jsonl`, parked records, an archived run), so
 * the site can be driven end-to-end without running real agents. It backs both the
 * `vetinari demo create|remove` verb and the coverage guard in
 * `dashboard-demo.test.ts` (#225).
 *
 * There is one project per `RunState` — a live running wave, a parked/blocked
 * run, a failure run, an all-merged completed run (which folds to `idle`), and an
 * idle project whose only history is a stalled archived run — and their issues
 * distribute the lifecycle `DisplayStatus` values and both non-`member` `Membership`
 * badges across their chips so the unions are covered (ADR 0019).
 */

// ── The state vocabulary the demo must cover ─────────────────────────────────
// Three const tuples pinned to the dashboard's own unions by a compile-time
// exhaustiveness link (type-only import, so this file never edits the unions):
// `satisfies` rejects a wrong or extra member, and the `Exclude<…> extends never`
// assertions below reject a *missing* one — so adding a member to
// `DisplayStatus`/`Membership`/`RunState` is a typecheck error here, and then a red
// coverage test, until the seed renders it.
export const ALL_DISPLAY_STATUSES = [
  "completed",
  "parked",
  "failed",
  "running",
  "unstarted",
] as const satisfies readonly DisplayStatus[];

export const ALL_MEMBERSHIPS = ["member", "grafted", "pruned"] as const satisfies readonly Membership[];

export const ALL_RUN_STATES = ["running", "parked", "failed", "idle"] as const satisfies readonly RunState[];

// Compile-time only: a union member missing from the tuple above leaves a non-never
// residue here and fails `tsc` (`satisfies` alone catches only wrong/extra members).
type AssertNever<T> = [T] extends [never] ? true : false;
const _displayExhaustive: AssertNever<Exclude<DisplayStatus, (typeof ALL_DISPLAY_STATUSES)[number]>> = true;
const _membershipExhaustive: AssertNever<Exclude<Membership, (typeof ALL_MEMBERSHIPS)[number]>> = true;
const _runExhaustive: AssertNever<Exclude<RunState, (typeof ALL_RUN_STATES)[number]>> = true;
void _displayExhaustive;
void _membershipExhaustive;
void _runExhaustive;

/** The demo's project names, keyed by the `RunState` each one is built to render. */
export const DEMO_PARKED_PROJECT = "acme-checkout";
export const DEMO_RUNNING_PROJECT = "payments-api";
export const DEMO_FAILURE_PROJECT = "mobile-app";
export const DEMO_COMPLETED_PROJECT = "data-pipeline";
export const DEMO_IDLE_PROJECT = "legacy-portal";

/** Every demo project's name, in the order `demo create` seeds them. */
export const DEMO_PROJECTS: readonly string[] = [
  DEMO_PARKED_PROJECT,
  DEMO_RUNNING_PROJECT,
  DEMO_FAILURE_PROJECT,
  DEMO_COMPLETED_PROJECT,
  DEMO_IDLE_PROJECT,
];

export const DEMO_PARKED_QUESTION =
  "Which payment providers should guest checkout offer at launch?\n\nOptions:\n- A: Stripe only\n- B: Stripe + PayPal\n- C: Stripe + PayPal + Apple Pay";

/**
 * The demo root every project seeds under — `$VETINARI_DEMO_DIR`, or
 * `~/.cache/vetinari-demo` by default. Each project's base location is
 * `<root>/<project>`, so `demo remove` can identify exactly the demo pointers by
 * their base location sitting under this root (never a real project).
 */
export function demoRoot(): string {
  return process.env.VETINARI_DEMO_DIR ?? join(homedir(), ".cache", "vetinari-demo");
}

/** A project's base location under the demo root. */
export const demoBaseLocation = (root: string, project: string): string => join(root, project);

/** A minute-offset ISO stamp helper, relative to a run's `now`. */
type At = (min: number) => string;
const atFor =
  (now: Date): At =>
  (min: number) =>
    new Date(now.getTime() + min * 60_000).toISOString();

/** One demo project's on-disk shape: the live event log, any parked records, and
 * an optional single archived run (an interrupted one, for the `idle` project). */
interface DemoProjectSpec {
  project: string;
  /** live orchestrator events — empty for the idle project (its only history is archived). */
  live: (at: At) => object[];
  /** parked records keyed by task id, materialized under `parked/`. */
  parked?: (at: At) => Record<string, object>;
  /** one finished-but-interrupted run, materialized under `logs/archive/`. */
  archived?: (at: At) => object[];
}

const TITLES_PARKED: Record<string, string> = {
  "201": "Cart persists across sessions",
  "202": "Stock check on add-to-cart",
  "203": "Guest checkout entry point",
  "204": "Session guard middleware",
  "205": "Payment provider selection",
  "206": "Order confirmation email",
  "207": "Receipt PDF",
  "208": "Promo code field",
};

const TITLES_RUNNING: Record<string, string> = {
  "301": "Settlement ledger schema",
  "302": "Idempotent capture endpoint",
  "303": "Refund reconciliation",
  "304": "Webhook signature check",
  "305": "Payout scheduler",
  "306": "Dispute evidence upload",
};

const TITLES_FAILURE: Record<string, string> = {
  "401": "Offline queue store",
  "402": "Sync conflict resolver",
  "403": "Background sync worker",
};

const TITLES_COMPLETED: Record<string, string> = {
  "501": "Nightly extract job",
  "502": "Warehouse load step",
};

const TITLES_IDLE: Record<string, string> = {
  "601": "Portal shell scaffold",
  "602": "Auth redirect flow",
  "603": "Dashboard widgets",
};

/**
 * The demo's projects, one per `RunState`. Each live log is folded by the same
 * `reduceCampaign` the dashboard renders from, so the chips/cards it produces are
 * what a person actually clicks through — and what the coverage guard reads back.
 */
const DEMO_SPECS: DemoProjectSpec[] = [
  // ── RunState: parked ── a live guest-checkout run: a closed wave, a running wave
  // holding a merge-conflict-parked green, a running (multi-turn), and a blocked-parked
  // issue, plus a pruned one in a later wave. Covers completed, running, parked (with the
  // question and conflict reasons), the pruned membership, and unstarted (ADR 0019).
  {
    project: DEMO_PARKED_PROJECT,
    live: (at) => [
      { ts: at(0), event: "campaign-start", waves: [["201", "202"], ["203", "204", "205"], ["206", "207", "208"]], name: "guest checkout", titles: TITLES_PARKED },
      { ts: at(1), event: "wave-start", index: 0, tasks: ["201", "202"] },
      { ts: at(2), event: "turn", taskId: "201", turn: 0, summary: "Wrote a failing test for cart persistence across a fresh session, then backed it with a keyed store." },
      { ts: at(2), event: "turn", taskId: "202", turn: 0, summary: "Pinned add-to-cart against a sold-out fixture so it returns 409 instead of silently overselling." },
      { ts: at(4), event: "green", taskId: "201", branch: "agent/201" },
      { ts: at(4), event: "green", taskId: "202", branch: "agent/202" },
      { ts: at(5), event: "merged", taskId: "201", branch: "agent/201" },
      { ts: at(5), event: "merged", taskId: "202", branch: "agent/202" },
      { ts: at(5), event: "wave-done", index: 0, merged: ["201", "202"] },
      { ts: at(6), event: "wave-start", index: 1, tasks: ["203", "204", "205"] },
      { ts: at(7), event: "spawn", taskId: "203", running: 1, left: 2 },
      { ts: at(7), event: "spawn", taskId: "204", running: 2, left: 1 },
      { ts: at(7), event: "spawn", taskId: "205", running: 3, left: 0 },
      { ts: at(8), event: "turn", taskId: "203", turn: 0, summary: "Added the /checkout/guest route; green, but it collides with the session guard on merge." },
      { ts: at(9), event: "green", taskId: "203", branch: "agent/203" },
      // 203 passed its own gate but hit a merge conflict on integration — a parked(conflict)
      // hold (design §2.3). The run already reads parked (205 question), so this adds the reason.
      { ts: at(10), event: "parked", taskId: "203", reason: "conflict", detail: "merge conflict" },
      { ts: at(8), event: "turn", taskId: "204", turn: 0, summary: "Red test: an expired session should redirect to /login, not 500 — it currently 500s." },
      { ts: at(10), event: "turn", taskId: "204", turn: 1, summary: "Extracted the guard into middleware; the redirect passes but two existing route tests now fail." },
      { ts: at(12), event: "turn", taskId: "204", turn: 2, summary: "Fixed the two callers to mount the middleware; full suite green, tidying names before I signal." },
      { ts: at(8), event: "turn", taskId: "205", turn: 0, summary: "Provider-selection test in place; blocked on which providers to offer at launch." },
      { ts: at(11), event: "parked", taskId: "205", reason: "question" },
      { ts: at(11), event: "worktree-preserved", taskId: "205", path: ".vetinari.local/wt/205" },
      { ts: at(13), event: "prune", target: "208", removed: ["208"] },
    ],
    parked: (at) => ({
      "205": { taskId: "205", parkedAt: at(11), reason: "question", branch: "agent/205", sessionId: "sess-205", question: DEMO_PARKED_QUESTION },
    }),
  },

  // ── RunState: running ── a live settlement run with a closed wave, a running wave
  // holding a merged green and an in-flight issue, a grafted issue waiting in a later
  // wave, and an unstarted wave — nothing held, so the card folds to `running`. Covers
  // running, completed, the grafted membership, and unstarted (ADR 0019).
  {
    project: DEMO_RUNNING_PROJECT,
    live: (at) => [
      { ts: at(0), event: "campaign-start", waves: [["301", "302"], ["303", "304"], ["305"]], name: "settlement", titles: TITLES_RUNNING },
      { ts: at(1), event: "wave-start", index: 0, tasks: ["301", "302"] },
      { ts: at(2), event: "turn", taskId: "301", turn: 0, summary: "Modelled the ledger as append-only double-entry rows; a balance test drove the schema." },
      { ts: at(2), event: "turn", taskId: "302", turn: 0, summary: "Made capture idempotent on the provider reference so a retried webhook can't double-charge." },
      { ts: at(4), event: "green", taskId: "301", branch: "agent/301" },
      { ts: at(4), event: "green", taskId: "302", branch: "agent/302" },
      { ts: at(5), event: "merged", taskId: "301", branch: "agent/301" },
      { ts: at(5), event: "merged", taskId: "302", branch: "agent/302" },
      { ts: at(5), event: "wave-done", index: 0, merged: ["301", "302"] },
      { ts: at(6), event: "wave-start", index: 1, tasks: ["303", "304"] },
      { ts: at(7), event: "spawn", taskId: "303", running: 1, left: 1 },
      { ts: at(7), event: "spawn", taskId: "304", running: 2, left: 0 },
      { ts: at(8), event: "turn", taskId: "303", turn: 0, summary: "Reconciled refunds against the original capture; green and merged clean." },
      { ts: at(9), event: "green", taskId: "303", branch: "agent/303" },
      { ts: at(8), event: "turn", taskId: "304", turn: 0, summary: "Verifying the HMAC signature on inbound webhooks before we trust the payload." },
      // A graft adds a dispute-evidence issue; it lands in the unstarted later wave, so it reads `grafted`.
      { ts: at(11), event: "graft", ids: ["306"], blockedBy: {}, basenames: { "306": ["disputes.ts"] } },
    ],
  },

  // ── RunState: failure ── an offline-mode run whose second-wave issue the agent
  // could not make green (a `failure`, derived from the errored outcome, ADR 0019).
  // Covers failure (and more completed chips from its first wave).
  {
    project: DEMO_FAILURE_PROJECT,
    live: (at) => [
      { ts: at(0), event: "campaign-start", waves: [["401", "402"], ["403"]], name: "offline mode", titles: TITLES_FAILURE },
      { ts: at(1), event: "wave-start", index: 0, tasks: ["401", "402"] },
      { ts: at(2), event: "turn", taskId: "401", turn: 0, summary: "Backed the offline queue with an IndexedDB store behind a durability test." },
      { ts: at(2), event: "turn", taskId: "402", turn: 0, summary: "Last-write-wins conflict resolver, pinned by a divergent-edit fixture." },
      { ts: at(4), event: "green", taskId: "401", branch: "agent/401" },
      { ts: at(4), event: "green", taskId: "402", branch: "agent/402" },
      { ts: at(5), event: "merged", taskId: "401", branch: "agent/401" },
      { ts: at(5), event: "merged", taskId: "402", branch: "agent/402" },
      { ts: at(5), event: "wave-done", index: 0, merged: ["401", "402"] },
      { ts: at(6), event: "wave-start", index: 1, tasks: ["403"] },
      { ts: at(7), event: "spawn", taskId: "403", running: 1, left: 0 },
      { ts: at(7), event: "turn", taskId: "403", turn: 0, summary: "Background sync worker never went green — the durability test keeps failing after every retry." },
      { ts: at(9), event: "failed", taskId: "403", detail: "error(3)" },
      { ts: at(9), event: "campaign-failed", index: 1, detail: "403 failed" },
    ],
  },

  // ── RunState: idle (completed campaign) ── an all-merged nightly-ETL run left live;
  // a completed campaign folds to the card `idle` (ADR 0019). Covers completed chips and
  // the completed→idle card fold.
  {
    project: DEMO_COMPLETED_PROJECT,
    live: (at) => [
      { ts: at(0), event: "campaign-start", waves: [["501", "502"]], name: "nightly ETL", titles: TITLES_COMPLETED },
      { ts: at(1), event: "wave-start", index: 0, tasks: ["501", "502"] },
      { ts: at(2), event: "turn", taskId: "501", turn: 0, summary: "Extract job reads the change-feed cursor and continues from the last watermark." },
      { ts: at(2), event: "turn", taskId: "502", turn: 0, summary: "Load step upserts into the warehouse in batches, idempotent on the natural key." },
      { ts: at(4), event: "green", taskId: "501", branch: "agent/501" },
      { ts: at(4), event: "green", taskId: "502", branch: "agent/502" },
      { ts: at(5), event: "merged", taskId: "501", branch: "agent/501" },
      { ts: at(5), event: "merged", taskId: "502", branch: "agent/502" },
      { ts: at(5), event: "wave-done", index: 0, merged: ["501", "502"] },
    ],
  },

  // ── RunState: idle ── a freshly-registered project with an empty live log; its
  // only history is one stalled archived run whose in-flight issue, dead with no verdict,
  // folds to the terminal `parked{crash}` when read back. Covers idle (card) and the chip.
  {
    project: DEMO_IDLE_PROJECT,
    live: () => [],
    archived: (at) => [
      { ts: at(-180), event: "campaign-start", waves: [["601", "602"], ["603"]], name: "portal rewrite", titles: TITLES_IDLE },
      { ts: at(-179), event: "wave-start", index: 0, tasks: ["601", "602"] },
      { ts: at(-178), event: "green", taskId: "601", branch: "agent/601" },
      { ts: at(-178), event: "green", taskId: "602", branch: "agent/602" },
      { ts: at(-177), event: "merged", taskId: "601", branch: "agent/601" },
      { ts: at(-177), event: "merged", taskId: "602", branch: "agent/602" },
      { ts: at(-177), event: "wave-done", index: 0, merged: ["601", "602"] },
      { ts: at(-176), event: "wave-start", index: 1, tasks: ["603"] },
      { ts: at(-175), event: "spawn", taskId: "603", running: 1, left: 0 },
      { ts: at(-175), event: "turn", taskId: "603", turn: 0, summary: "Wiring the dashboard widgets when the run was cut short." },
      // No terminal event — the run stalled at the run level, and its in-flight #603, dead
      // with no verdict, folds to `parked{crash}` when read back (design §7).
    ],
  },
];

/** The archive filename token for a run started `now`, in `archiveRun`'s own
 * `YYYY-MM-DDThh-mm-ss-mmmZ` shape so `listArchivedRuns` parses its start time. */
const archiveStamp = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");

const writeLog = (file: string, events: object[]): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
};

/** Materialize one demo project into its base location: the live log, its parked
 * records, and any archived run. */
function seedProject(baseLocation: string, spec: DemoProjectSpec, now: Date): void {
  const at = atFor(now);
  mkdirSync(baseLocation, { recursive: true });
  writeLog(join(baseLocation, "logs", "orchestrator.jsonl"), spec.live(at));
  for (const [taskId, rec] of Object.entries(spec.parked?.(at) ?? {})) {
    mkdirSync(join(baseLocation, "parked"), { recursive: true });
    writeFileSync(join(baseLocation, "parked", `${taskId}.json`), JSON.stringify(rec, null, 2));
  }
  const archived = spec.archived?.(at);
  if (archived?.length) {
    // The run started before `now` (its events carry negative offsets); stamp the
    // archive file with a start time that sorts and parses like a real archive.
    writeLog(join(baseLocation, "logs", "archive", `orchestrator-${archiveStamp(new Date(now.getTime() - 180 * 60_000))}.jsonl`), archived);
  }
}

/**
 * Seed and register every demo project under `root`, pointing each pointer at its
 * base location so the dashboard lists it. Returns the seeded project names. Not
 * idempotent on its own — the caller (`vetinari demo create`) clears first via
 * `removeDemo`; the coverage test relies on that clear-then-seed for its
 * idempotence assertion.
 */
export function createDemo(configDir: string, root: string, now: Date = new Date()): { projects: string[] } {
  const projects: string[] = [];
  for (const spec of DEMO_SPECS) {
    const baseLocation = demoBaseLocation(root, spec.project);
    seedProject(baseLocation, spec, now);
    register(configDir, { project: spec.project, projectRoot: join(baseLocation, "root"), baseLocation });
    projects.push(spec.project);
  }
  return { projects };
}

/**
 * Remove every demo project: delete the demo root and unregister exactly the
 * pointers whose base location sits under it — keyed on the base location, never
 * the name, so a real project that happens to share a demo name is never touched.
 * A safe no-op when nothing is seeded (an absent root, no matching pointers).
 * Returns the unregistered project names.
 */
export function removeDemo(configDir: string, root: string): { removed: string[] } {
  const rootPrefix = resolve(root) + "/";
  const removed: string[] = [];
  for (const pointer of listProjects(configDir)) {
    if (resolve(pointer.baseLocation).startsWith(rootPrefix)) {
      removePointer(configDir, pointer.project);
      removed.push(pointer.project);
    }
  }
  rmSync(root, { recursive: true, force: true });
  return { removed };
}
