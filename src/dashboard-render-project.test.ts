// Tests for the campaign/project surface — waves, chips and archived runs
// (dashboard-render-project.ts, via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { stateColor, STATE_DOT_CSS, ISSUE_DETAIL_SHEET_SCRIPT, REPO_DROPDOWN_SCRIPT, ARCHIVE_LIST_SCRIPT } from "./dashboard-assets.ts";
import { archiveRowMatches, buildStatus, buildStatusWithIssueNames, cappedRawRows, event, highlightJsonLine, renderStatusPage, type CampaignStatus } from "./status.ts";

const cfgFor = (dir: string): ResolvedConfig =>
  ({
    project: "demo",
    image: "img",
    baseBranch: "main",
    branchPrefix: "agent/",
    gates: [{ cmd: "npm test" }],
    maxTurns: 6,
    idleTimeoutSeconds: 600,
    stateDir: dir,
    parkedDir: join(dir, "parked"),
    logFile: join(dir, "logs", "orchestrator.jsonl"),
    promptFile: "prompt.md",
    fetchTask: (id: string) => id,
  }) as ResolvedConfig;

const writeJsonl = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

const seedState = (dir: string, events: unknown[]) => {
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "parked"), { recursive: true });
  writeJsonl(join(dir, "logs", "orchestrator.jsonl"), events);
};

// A minimal reconstructed run status for an archived row's campaign pane — a
// single closed wave holding one completed issue chip.
const archStatus = (issue: string): CampaignStatus => ({
  project: "beta",
  waves: [
    {
      index: 0,
      status: "completed",
      issues: [{ issueNumber: issue, status: "completed" }],
    },
  ],
  parked: [],
});

test("green live dots pulse when live even with zero running — they track the stream, not work (§5, #100)", () => {
  // Regression guard for the misdirected first #100 attempt: it hung a running-gate on the
  // green dot so an idle campaign (0 running) stopped pulsing. The green dots must stay live.
  const idle = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "1", status: "completed" }] }],
    parked: [],
  });
  assert.doesNotMatch(idle, /data-running/);
  assert.match(idle, /\.live-indicator::before \{[^}]*animation: chip-pulse[^}]*infinite/);
});
test("status dots never shrink under flex fill pressure — one shared base gives .dot/.repo-dot/.tail-dot/.lv-dot flex:none (#234)", () => {
  const campaign = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "212", status: "running" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // A wave-member row is a flex container whose ellipsised title exerts fill pressure;
  // a status dot with the default flex:0 1 auto collapses horizontally by a title-length
  // dependent amount, rendering as a pill or bar instead of a circle (#234). The four
  // status dots share one base rule so the "small solid circle that never shrinks"
  // invariant — border-radius + flex:none — is written once, not four times.
  assert.match(
    campaign,
    /\.dot, \.repo-dot, \.tail-dot, \.lv-dot \{[^}]*flex: none[^}]*\}/,
  );
  assert.match(
    campaign,
    /\.dot, \.repo-dot, \.tail-dot, \.lv-dot \{[^}]*border-radius: 999px[^}]*\}/,
  );
});
test("renderStatusPage greys the Redrive campaign control with a one-line reason while a campaign process is live (#325)", () => {
  // Redrive picks up the whole campaign (design §7, §11): a campaign control on the project
  // page, never an issue move. While a campaign process still holds the lease — the observed
  // bug fired it on a draining wave — it renders disabled with the reason, and no dialog opens.
  const live = renderStatusPage(
    {
      project: "beta",
      name: "checkout revamp",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] }],
      parked: [],
    },
    { prune: true, graft: true, leaseLive: true, baseBranch: "main" },
  );
  assert.match(live, /class="redrive-btn"[^>]*data-redrive-open[^>]*disabled/);
  assert.match(live, /class="redrive-reason">a campaign process is still running</);
  // The old always-fires red-base banner is gone — the greyed-until-safe control replaces it.
  assert.doesNotMatch(live, /class="redrive-banner"/);
  // No confirm dialog renders while the control is disabled — there is nothing to confirm.
  assert.doesNotMatch(live, /class="redrive-dialog"/);
});
test("renderStatusPage enables the Redrive control with a naming confirm dialog when the campaign is stopped and the lease is dead (#325)", () => {
  // A campaign parked on a red base with no live process is exactly when a redrive is safe:
  // the fold is stopped and the lease is dead (design §7, §11). The control enables and opens
  // a dialog naming what will happen — the campaign, the wave it re-enters, its members, the base.
  const parked = renderStatusPage(
    {
      project: "beta",
      name: "checkout revamp",
      waves: [
        { index: 0, status: "completed", issues: [{ issueNumber: "101", status: "completed" }] },
        { index: 1, status: "parked", reason: "red-base", issues: [{ issueNumber: "201", status: "completed" }, { issueNumber: "202", status: "completed" }] },
      ],
      parked: [],
    },
    { prune: true, graft: true, leaseLive: false, baseBranch: "main" },
  );
  // Enabled: the button opens the dialog and is not disabled.
  assert.match(parked, /<button type="button" class="redrive-btn" data-redrive-open>Redrive<\/button>/);
  assert.doesNotMatch(parked, /class="redrive-btn"[^>]*disabled/);
  // The dialog names the campaign, the resume wave (wave 2), its members and the base.
  assert.match(parked, /<dialog class="redrive-dialog" data-redrive-dialog>/);
  assert.match(parked, /Redrive <strong>checkout revamp<\/strong>: re-enters wave 2 — #201, #202 — on <code>main<\/code>/);
  // Only Confirm POSTs /redrive (project-scoped, no taskId); Cancel is the default (autofocus)
  // and does not submit.
  assert.match(parked, /<form method="post" action="\/redrive" class="redrive-dialog-actions" data-redrive-form><input type="hidden" name="project" value="beta" \/>/);
  assert.match(parked, /<button type="button" class="redrive-cancel" data-redrive-cancel autofocus>Cancel<\/button>/);
  assert.match(parked, /<button type="submit" class="redrive-confirm" data-redrive-confirm>Redrive<\/button>/);
  // The page ships the dialog's open/cancel wiring, re-run on live refresh like graft.
  assert.match(parked, /function wireRedrive\(\)/);
  assert.match(parked, /wireRedrive\(\);/);
});
test("renderStatusPage greys the Redrive control on a settled campaign — nothing to redrive (#325)", () => {
  // Every wave closed → the campaign is settled; there is no stopped campaign to pick up, so
  // the control is disabled with that reason (the graft affordance renders nothing, as before).
  const settled = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "completed", issues: [{ issueNumber: "101", status: "completed" }] }],
      parked: [],
    },
    { prune: true, graft: true, leaseLive: false, baseBranch: "main" },
  );
  assert.match(settled, /class="redrive-btn"[^>]*disabled/);
  assert.match(settled, /class="redrive-reason">the campaign is settled — nothing to redrive</);
});
test("the Redrive control reads the risky-action coral — enabled button, dialog outline and confirm (#328)", () => {
  // Redrive discards/re-runs work, so it is a risky action (Appendix A): its enabled button and
  // its confirm surface wear the risky-action coral (--color-red), not the plain teal accent a
  // benign link wears. The greyed-unless-safe disabled state stays neutral — colour is never the
  // only channel, the confirm dialog and the disabled-with-reason are the load-bearing guards.
  const page = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "parked", reason: "red-base", issues: [{ issueNumber: "201", status: "completed" }] }],
      parked: [],
    },
    { prune: true, graft: true, leaseLive: false, baseBranch: "main" },
  );
  // The enabled button wears coral.
  assert.match(page, /\.redrive-btn \{[^}]*background: var\(--color-red\)/);
  // Its disabled state stays neutral (the grey greyed-out control), untouched.
  assert.match(page, /\.redrive-btn:disabled \{[^}]*border: 1px solid var\(--color-secondary\)/);
  // The confirm dialog is the 1px-outline confirmation treatment, in coral.
  assert.match(page, /\.redrive-dialog \{[^}]*border: 1px solid var\(--color-red\)/);
  // The Confirm button wears coral too.
  assert.match(page, /\.redrive-confirm \{[^}]*background: var\(--color-red\)/);
});
test("renderStatusPage puts a quiet graft input on the summary line, greyed at rest (#202, #168)", () => {
  const runningCampaign = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  // Mockup 1a: the graft affordance rides the campaign summary line (project · N issues ·
  // M waves), not a banner. A form POSTing to /graft carries the project and a quiet ids
  // input; the button is greyed/disabled at rest and only activates once ids are typed.
  const withGraft = renderStatusPage(runningCampaign, { prune: true, graft: true });
  // The input lives inside the summary line, not a standalone banner.
  assert.doesNotMatch(withGraft, /class="graft-banner"/);
  const summary = withGraft.slice(withGraft.indexOf('class="campaign-summary"'), withGraft.indexOf('class="waves-grid"'));
  assert.match(summary, /class="campaign-meta"/);
  assert.match(summary, /<form method="post" action="\/graft"[^>]*>/);
  assert.match(summary, /name="project" value="beta"/);
  assert.match(summary, /name="ids"[^>]*placeholder="graft issue ids"/);
  // The graft button is disabled at rest — it activates client-side once ids are entered.
  assert.match(summary, /class="graft-btn"[^>]*disabled/);

  // Without the graft page option, no graft control — the same gating prune rides.
  const withoutGraft = renderStatusPage(runningCampaign, { prune: true });
  assert.doesNotMatch(withoutGraft, /action="\/graft"/);
  assert.doesNotMatch(withoutGraft, /class="campaign-summary"/);
});
test("renderStatusPage offers no graft affordance — and no 'final wave' notice — on a settled campaign (#307)", () => {
  // Graft is offered only while the campaign is unsettled (design §11). A settled campaign
  // (every wave closed) has nothing live-or-resumable to layer into, so the affordance
  // renders nothing at all — no graft form, and none of the old "final wave" refusal notice
  // (#202's structural-disable message, superseded). The campaign meta still renders.
  const finished = {
    project: "beta",
    waves: [
      { index: 0, status: "completed" as const, issues: [{ issueNumber: "101", status: "completed" as const }] },
      { index: 1, status: "completed" as const, issues: [{ issueNumber: "201", status: "completed" as const }] },
    ],
    parked: [],
  };
  const html = renderStatusPage(finished, { prune: true, graft: true });
  const summary = html.slice(html.indexOf('class="campaign-summary"'), html.indexOf('class="waves-grid"'));
  // The meta still reads, but the graft input, the refusal, and the "final wave" words are gone.
  assert.match(summary, /class="campaign-meta"/);
  assert.doesNotMatch(html, /graft-refused/);
  assert.doesNotMatch(html, /class="graft-refusal"/);
  assert.doesNotMatch(html, /final wave/i);
  assert.doesNotMatch(html, /<form method="post" action="\/graft"/);
});
test("renderStatusPage marks a freshly-grafted wave with a static teal edge, not motion (#202, §5)", () => {
  const grafted = {
    project: "beta",
    waves: [
      { index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] },
      { index: 1, status: "unstarted" as const, issues: [{ issueNumber: "305", status: "unstarted" as const, membership: "grafted" as const }] },
    ],
    parked: [],
  };
  const html = renderStatusPage(grafted, { prune: true, graft: true });
  // A wave carrying a grafted issue (the membership axis) is marked, and takes the teal
  // product accent on its edge so the new card reads at a glance on the live refresh.
  assert.match(html, /class="wave unstarted has-grafted"/);
  assert.match(html, /\.wave\.has-grafted \{ border-top-color: var\(--color-primary\); \}/);
  // §5 reserves motion for the work/stream channels — the mockup's teal pulse is
  // translated to this static emphasis (CLAUDE.md rule 5). No new colour animation: the
  // only @keyframes on the page stays chip-pulse (the §5 invariant test #100 also pins).
  assert.deepEqual(
    [...new Set([...html.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]))],
    ["chip-pulse"],
  );
});
test("renderStatusPage mutes the graft input's placeholder so it reads as an example, not a value (#236)", () => {
  const running = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  const html = renderStatusPage(running, { prune: true, graft: true });
  // The `graft issue ids` placeholder is a hint, not entered content — it renders muted
  // (the dim token) so it reads as an example rather than a typed value, while real typed
  // ids keep the full text colour on `.graft-ids` itself.
  assert.match(html, /\.graft-ids::placeholder \{ color: var\(--color-dim\); \}/);
  assert.match(html, /\.graft-ids \{[^}]*color: var\(--color-text\);/);
});
test("renderStatusPage ships the graft input's client wiring, re-run on live refresh (#202)", () => {
  const running = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  const html = renderStatusPage(running, { prune: true, graft: true });
  // The graft input is inside #live-region (swapped on every soft-refresh), so its wiring
  // is a function re-run from wireLiveRegion, not a one-shot bind.
  assert.match(html, /function wireGraft\(\)/);
  assert.match(html, /wireGraft\(\);/);
  // It POSTs directly on submit and surfaces a 422 whole-batch rejection inline in the
  // error box (keeping the typed ids), rather than navigating away.
  assert.match(html, /fetch\("\/graft"/);
  assert.match(html, /422/);
  assert.match(html, /data-graft-error/);
  // It validates against the retained dry-run closure endpoint on blur.
  assert.match(html, /\/graft\?preview/);
  // The carry-over reducer is single-sourced into the page via `.toString()` (#329) — the
  // shipped function is the same one the node test drives — and the soft-refresh hands its
  // decision to wireGraft. This asserts the wiring is present, not the rule (that is the
  // reducer's own node test, per ADR 0012); a rule-source-text match here would pass whether
  // or not the rule is correct.
  assert.match(html, /function graftCarry\(captured\)/);
  assert.match(html, /pendingGraftCarry = graftCarry\(/);
  assert.match(html, /if \(pendingGraftCarry\)/);
});
test("renderStatusPage's graft control reads as in-flight during its POST — aria-busy + `grafting…`, distinct from at-rest disabled, cleared on every exit (#327)", () => {
  const running = {
    project: "beta",
    waves: [{ index: 0, status: "running" as const, issues: [{ issueNumber: "201", status: "running" as const }] }],
    parked: [],
  };
  const html = renderStatusPage(running, { prune: true, graft: true });

  // At rest the control is disabled with the resting label `graft`, and the form carries no
  // aria-busy — so the in-flight rendering asserted below is genuinely distinct from the
  // at-rest disabled state (which is identical to a graft that was never accepted).
  const summary = html.slice(html.indexOf('class="campaign-summary"'), html.indexOf('class="waves-grid"'));
  assert.match(summary, /<button type="submit" class="graft-btn" data-graft-submit disabled>graft<\/button>/);
  assert.doesNotMatch(summary, /aria-busy/);

  // On submit the control enters the in-flight state: aria-busy="true" on the form and the
  // button relabelled `grafting…` and held disabled — a signal that is not colour/text-only
  // and differs from the at-rest disabled rendering.
  assert.match(html, /const enterFlight = \(\) => \{[^}]*form\.setAttribute\("aria-busy", "true"\)[^}]*submit\.textContent = "grafting…"[^}]*submit\.disabled = true[^}]*\}/);

  // Re-submitting while a graft is in flight is impossible — the busy guard returns before
  // any second /graft POST is shelled against the same ids.
  assert.match(html, /if \(busy \|\| !typed\(\)\) return;/);

  // Every exit path clears the in-flight state — the clear runs in a `finally`, so success,
  // 422 and thrown/network error all restore the `graft` label and drop aria-busy, then
  // sync() sets the disabled state from the ids. The finally also tolerates its own nodes
  // being detached by a mid-flight soft-refresh (setAttribute/textContent never throw there).
  assert.match(html, /const clearFlight = \(\) => \{[^}]*form\.removeAttribute\("aria-busy"\)[^}]*submit\.textContent = "graft"[^}]*\}/);
  assert.match(html, /\} finally \{[^}]*busy = false;[^}]*clearFlight\(\);[^}]*sync\(\);[^}]*\}/);
});
test("renderStatusPage shows an informational merge-conflict affordance with no action of its own (#171)", () => {
  const held = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [
            { issueNumber: "611", status: "completed" },
            { issueNumber: "640", status: "parked", reason: "conflict" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // A merge-conflict-held issue (the conflict park reason) surfaces a "resolve the conflict,
  // then redrive" note...
  assert.match(held, /class="conflict-note"/);
  assert.match(held, /resolve the conflict/i);
  // ...but the note is informational only — it introduces no action form/route of its own.
  const note = held.slice(held.indexOf('class="conflict-note"'));
  const noteBlock = note.slice(0, note.indexOf("</section>"));
  assert.doesNotMatch(noteBlock, /<form/);
  // It points the operator at the campaign's Redrive control and the CLI — the redrive is a
  // whole-campaign move now, not a per-issue one (#325).
  assert.match(noteBlock, /Redrive control/);
  assert.match(noteBlock, /vetinari redrive/);

  // No conflict-held issue → no note.
  const clean = renderStatusPage(
    {
      project: "beta",
      waves: [{ index: 0, status: "running", issues: [{ issueNumber: "611", status: "completed" }] }],
      parked: [],
    },
    { prune: true },
  );
  assert.doesNotMatch(clean, /class="conflict-note"/);
});
test("wave labels read from tmp-log issue titles, resolved through buildStatusWithIssueNames", async () => {
  const dir = join(tmpdir(), `vetinari-status-wave-names-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102", "103"], ["201"]],
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
    }),
    event("wave-start", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    // The wave spawns its member: 201 goes running, so the wave folds to `running`
    // (the wave status is a pure fold of its issues now, ADR 0019).
    event("spawn", { ts: "2025-01-01T00:03:30.000Z", taskId: "201", running: 1, left: 0 }),
  ]);
  const titles: Record<string, string> = {
    "101": "config resolution",
    "102": "retry policy",
    "103": "log rotation",
    "201": "cache eviction",
  };

  const status = await buildStatusWithIssueNames({
    ...cfgFor(dir),
    // Unique project so the process-lifetime issue-name cache can't collide with
    // another test's "demo:101".
    project: "wave-names",
    fetchTask: async (id: string) => JSON.stringify({ title: titles[id] }),
  });
  const html = renderStatusPage(status);

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave completed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status completed">completed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});
test("renderStatusPage names waves festively when the toggle is on (#193)", () => {
  const dir = join(tmpdir(), `vetinari-festive-render-${Date.now()}`);
  seedState(dir, [
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102"], ["201"]],
      titles: { "101": "config resolution", "102": "retry policy", "201": "cache eviction" },
      slots: 1,
    }),
    event("wave-start", { ts: "2025-01-01T00:01:00.000Z", index: 0, tasks: ["101", "102"] }),
    event("wave-done", { ts: "2025-01-01T00:02:00.000Z", index: 0, merged: ["101", "102"] }),
    event("wave-start", { ts: "2025-01-01T00:03:00.000Z", index: 1, tasks: ["201"] }),
  ]);
  const status = buildStatus(cfgFor(dir));

  // Off (default) — labels are exactly today's `Wave N …`, no festive name.
  const plain = renderStatusPage(status);
  assert.match(plain, /<h2 class="wave-label">Wave 2 — cache eviction<\/h2>/);
  assert.match(plain, /Wave 1 <span class="completed-wave-tally">/);
  assert.doesNotMatch(plain, /Susan Sto Helit/);

  // On — cards and the closed-wave chip carry `index · name`; the closed card drops the
  // lead-title collapse (its member rows carry the titles). The offset is no longer stored
  // on the log — it is derived from the `campaign-start` ts, so wave 0/1 draw
  // festiveWaveName(festiveOffsetFor("2025-01-01T00:00:00.000Z"), 0/1) = Susan Sto Helit / Ysabell.
  const festive = renderStatusPage(status, { festive: true });
  assert.match(festive, /<h2 class="wave-label">Wave 2 · Ysabell<\/h2>/);
  assert.match(festive, /<h2 class="wave-label">Wave 1 · Susan Sto Helit<\/h2>/);
  assert.match(festive, /✓<\/span> Wave 1 · Susan Sto Helit <span class="completed-wave-tally">/);
});
test("renderStatusPage renders a nameless Wave N when festive is on but the run reserved no offset (#193)", () => {
  // A run that reserved no festive offset (its status carries no `festiveOffset` — a run from
  // before the feature) still renders plain `Wave N` under the festive toggle: `festiveNameFor`
  // yields no name when `festiveOffset` is undefined, so the label stays nameless. Driven off a
  // status literal because a `campaign-start` now always derives its offset from the start ts —
  // the no-offset case only survives on a CampaignStatus with the field absent.
  const status: CampaignStatus = {
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [{ issueNumber: "201", status: "running" }] }],
    parked: [],
  };
  const festive = renderStatusPage(status, { festive: true });
  assert.match(festive, /<h2 class="wave-label">Wave 1<\/h2>/);
});
test("wave labels and chip hovers render from the log's titles, with no fetchTask", () => {
  const dir = join(tmpdir(), `vetinari-render-log-titles-${Date.now()}`);
  seedState(dir, [
    // Wave 0 (many issues) closes; wave 1 (one issue) is now running.
    event("campaign-start", {
      ts: "2025-01-01T00:00:00.000Z",
      waves: [["101", "102", "103"], ["201"]],
      titles: {
        "101": "config resolution",
        "102": "retry policy",
        "103": "log rotation",
        "201": "cache eviction",
      },
      slots: 1,
    }),
    event("wave-start", {
      ts: "2025-01-01T00:01:00.000Z",
      index: 0,
      tasks: ["101", "102", "103"],
    }),
    event("wave-done", {
      ts: "2025-01-01T00:02:00.000Z",
      index: 0,
      merged: ["101", "102", "103"],
    }),
    event("wave-start", {
      ts: "2025-01-01T00:03:00.000Z",
      index: 1,
      tasks: ["201"],
    }),
    // The wave spawns its member: 201 goes running, so the wave folds to `running`
    // (the wave status is a pure fold of its issues now, ADR 0019).
    event("spawn", { ts: "2025-01-01T00:03:30.000Z", taskId: "201", running: 1, left: 0 }),
  ]);

  // buildStatus over cfgFor's id-echoing fetchTask: the only source of titles is
  // the log, exactly as the dumb-router dashboard reads them (ADR 0002).
  const html = renderStatusPage(buildStatus(cfgFor(dir)));

  // Many-issue wave (closed): a compact "Wave N" toggle chip with its merged tally; the
  // lead title + "+N" now reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">3\/3<\/span><\/button>/,
  );
  assert.match(
    html,
    /<section class="wave completed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+2<\/h2><div class="wave-meta"><span class="wave-tally">3\/3<\/span><span class="wave-status completed">completed<\/span>/,
  );
  // Single-issue wave (open): just that issue's title, in a wave card.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — cache eviction<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // Every chip carries its own title on hover, alongside its status detail — 201 took
  // an agent slot (the `spawn` seeds it running), so its hover is the title plus that detail.
  assert.match(html, /title="cache eviction&#10;Running in an agent slot \(1 active, 0 waiting\)"/);
  // A chip whose issue also has a status detail carries the title alongside it.
  assert.match(html, /title="config resolution&#10;Merged into base"/);
});
test("renderStatusPage shows a merged/total tally on an open wave card", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "completed" },
          { issueNumber: "202", status: "running" },
        ],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [
          { issueNumber: "301", status: "unstarted" },
          { issueNumber: "302", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });

  // Each open wave card's head carries its merged/total — one of two done in the
  // running wave, none in the unstarted one — ahead of its state pill in the meta group.
  assert.match(
    html,
    /<span class="wave-tally">1\/2<\/span><span class="wave-status running">running<\/span>/,
  );
  assert.match(
    html,
    /<span class="wave-tally">0\/2<\/span><span class="wave-status unstarted">unstarted<\/span>/,
  );
});
test("renderStatusPage renders one stable wave-head row: label · merged/total · state · pruned, with the pill outside the label", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          {
            issueNumber: "201",
            status: "completed",
            name: "Guest checkout entry point",
          },
          { issueNumber: "202", status: "running" },
          { issueNumber: "203", status: "unstarted", membership: "pruned" },
        ],
      },
    ],
    parked: [],
  });

  // The head is one row: the label in its own element (so a long label can't shove the
  // state pill onto its own line, the Wave 2 vs Wave 3 misalignment), then a meta group
  // ordering merged/total · state pill · pruned tally — the pruned count folded into the
  // row, not floating in the corner.
  assert.match(
    html,
    /<div class="wave-head"><h2 class="wave-label">Wave 2 — Guest checkout entry point \+2<\/h2><div class="wave-meta"><span class="wave-tally">1\/3<\/span><span class="wave-status running">running<\/span><span class="wave-pruned">1 pruned<\/span><\/div><\/div>/,
  );
  // The state pill is no longer nested inside the <h2> label.
  assert.doesNotMatch(
    html,
    /<span class="wave-status running">running<\/span><\/h2>/,
  );
});
test("renderStatusPage renders one interactive member row per issue, merging the old chip + title blocks", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [
            {
              issueNumber: "201",
              status: "running",
              name: "wire up the parser",
            },
            { issueNumber: "202", status: "unstarted" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // One member list, one interactive row per issue: status dot + #NNN + resolved
  // title + status word — no separate chip row and no separate title list.
  assert.match(
    html,
    /<ul class="wave-members"><li><button type="button" class="wave-member running"[^>]*><span class="dot running"><\/span>#201 <span class="wave-member-title">wire up the parser<\/span><small>running<\/small><\/button><\/li>/,
  );
  // An unresolved title falls back to just #NNN (no title span).
  assert.match(
    html,
    /<li><button type="button" class="wave-member unstarted"[^>]*><span class="dot unstarted"><\/span>#202 <small>unstarted<\/small><\/button><\/li>/,
  );
  // The row carries its issue+project so a tap opens the detail sheet, and is flagged
  // prunable when prunable (202 is an unstarted future-wave remainder).
  assert.match(
    html,
    /class="wave-member unstarted" title="[^"]*" data-issue="202" data-project="beta" data-prunable="1"/,
  );
  // The old dual blocks are retired — no chip row (`.chips`/`.chip`) and no title list.
  assert.doesNotMatch(html, /class="chips"/);
  assert.doesNotMatch(html, /class="wave-issues"/);
  assert.doesNotMatch(html, /class="chip /);
});
test("renderStatusPage colours a pruned chip and pulses a running one", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "live one" },
          { issueNumber: "202", status: "unstarted", membership: "pruned", name: "pruned one" },
        ],
      },
    ],
    parked: [],
  });

  // A pruned member row composes the two axes (ADR 0019): its lifecycle dot/word read
  // `unstarted`, and a `pruned` membership badge rides alongside; the `.wave-member.pruned`
  // class (the membership) reads struck-through…
  assert.match(
    html,
    /<button type="button" class="wave-member unstarted pruned"[^>]*><span class="dot unstarted"><\/span>#202 <span class="wave-member-title">pruned one<\/span><span class="member-badge pruned">pruned<\/span><small>unstarted<\/small><\/button>/,
  );
  assert.match(
    html,
    /\.wave-member\.pruned \{ color: var\(--color-text-light-2\); text-decoration: line-through; \}/,
  );
  // …and the wave it left gains a pruned tally in its header, so the prune reads
  // at a glance without counting struck-through chips (one of two issues pruned).
  assert.match(html, /<span class="wave-pruned">1 pruned<\/span>/);
  // …in a distinct pruned colour defined in the stylesheet (ADR 0007's sixth state),
  // scoped to .dot so it tints only the dot, never the whole struck-through chip (#81). The
  // pruned dot's colour is stateColor("pruned") (asserted by value there), carried in the shared
  // dot rules the page splices in.
  assert.match(html, /--color-pruned:/);
  assert.ok(html.includes(STATE_DOT_CSS));
  // A running chip pulses — a keyframed animation on its dot, reduced-motion aware.
  assert.match(html, /@keyframes chip-pulse/);
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
  assert.match(html, /prefers-reduced-motion/);
});
test("renderStatusPage shows a running member's phase in place of the word, controlling the pulse (#359)", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          // An agent mid-gate: its phase names the running command and the dot keeps pulsing.
          { issueNumber: "201", status: "running", name: "mid gate", phase: { label: "testing · go-unit", steady: false } },
          // A green waiting to merge: nothing executes, so the dot goes steady (`idle`) and the
          // phase replaces the word — never "running".
          { issueNumber: "202", status: "running", name: "green one", phase: { label: "waiting to merge", steady: true } },
        ],
      },
    ],
    parked: [],
  });

  // The phase replaces the status word on the row (never "running · testing"); the row's own
  // lifecycle class stays `running` (it colours the left edge, unchanged).
  assert.match(
    html,
    /<button type="button" class="wave-member running"[^>]*><span class="dot running"><\/span>#201 <span class="wave-member-title">mid gate<\/span><small>testing · go-unit<\/small><\/button>/,
  );
  // The steady phase drops the pulse via the existing `.dot.running.idle` rule — no new colour,
  // just the `idle` class — and still shows the phase word, not "running".
  assert.match(
    html,
    /<button type="button" class="wave-member running"[^>]*><span class="dot running idle"><\/span>#202 <span class="wave-member-title">green one<\/span><small>waiting to merge<\/small><\/button>/,
  );
  assert.doesNotMatch(html, /<small>running<\/small>/);
});
test("renderStatusPage renders a grafted member row's status dot alongside its grafted badge (#307)", () => {
  // A grafted issue composes the two axes (ADR 0019): its lifecycle dot reads its own
  // status (here running), and the `grafted` membership badge rides alongside — the dot is
  // never suppressed by the membership, so a grafted row still reads its run-state at a glance.
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "305", status: "running", membership: "grafted", name: "grafted one" }],
        },
      ],
      parked: [],
    },
    { prune: true, graft: true },
  );
  assert.match(
    html,
    /<button type="button" class="wave-member running grafted"[^>]*><span class="dot running"><\/span>#305 <span class="wave-member-title">grafted one<\/span><span class="member-badge grafted">grafted<\/span><small>running<\/small><\/button>/,
  );
});
test("renderStatusPage's prune panel discloses kept-banked work and carries a standalone explainer", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "401", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );
  // The confirmation is built from the structured closure the endpoint returns:
  // it names the dropped dependents and, separately, states the banked (merged or
  // mergeable) work that is kept — so a confirm never implies banked work leaves.
  assert.match(html, /also drops/);
  assert.match(html, /Keeps banked \(merged or mergeable\)/);
  // A standalone Prune (no Redrive beside it) carries a plain-words explainer of
  // what a prune does, keyed to show only when the issue is prunable and unparked.
  assert.match(html, /id="prune-explainer"/);
  assert.match(html, /everything blocked by it/);
});
test("renderStatusPage renders the repo dropdown (with a no-JS select fallback) and the selected project's body", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [
        {
          issueNumber: "201",
          reason: "question",
          parkedAt: "now",
          branch: "agent/201",
          description: "Need a choice.",
          options: [],
        },
      ],
    },
    { projects: ["alpha", "beta", "gamma"], selected: "beta" },
  );

  // The primary control is the repo dropdown trigger stating the current scope.
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  assert.match(html, /<span class="repo-label">beta<\/span>/);
  // The native <select> lives on inside <noscript> as the no-JS switch (posts back to GET /).
  assert.match(
    html,
    /<noscript><form[^>]*method="get"[^>]*action="\/"[^>]*class="project-picker">/,
  );
  assert.match(
    html,
    /<select name="project" onchange="this\.form\.submit\(\)">/,
  );
  assert.match(html, /<option value="">All repos<\/option>/);
  assert.match(html, /<option value="beta" selected>beta<\/option>/);
  assert.match(html, /<option value="gamma">gamma<\/option>/);
  // The selected project's own body still renders exactly as the single-project view.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
  // The parked card carries the project so the sheet routes its reply/prune to it.
  assert.match(html, /<a class="parked-card"[^>]*data-project="beta"/);
});
test("renderStatusPage's repo dropdown states the current scope as the heading trigger, not a native select", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The trigger is the page heading and the switcher in one control: a button, not a
  // native <select>, carrying the full owner/name scope as its label plus a chevron.
  assert.match(html, /<div class="repo-dropdown" data-repo-dropdown>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger" id="repo-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="repo-menu">/,
  );
  assert.match(html, /<span class="repo-label">acme\/tidepool<\/span>/);
  assert.match(html, /<span class="repo-chevron" aria-hidden="true">▾<\/span>/);
  // The full owner/name is the label — never abbreviated to just the repo name.
  assert.doesNotMatch(html, /<span class="repo-label">tidepool<\/span>/);
});
test("the repo dropdown shows owner/name from repo while data-project stays the bare project key", () => {
  const html = renderStatusPage(
    {
      project: "vetinari",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        {
          project: "vetinari",
          runState: "running",
          repo: "jjforge/vetinari",
        },
        { project: "acme-checkout", runState: "idle" },
      ],
      selected: "vetinari",
    },
  );

  // The trigger heading reads the selected repo's owner/name, not its bare key.
  assert.match(
    html,
    /<span class="repo-label">jjforge\/vetinari<\/span>/,
  );
  // Its row shows owner/name too, but routing stays keyed on the bare project key.
  assert.match(
    html,
    /<li class="repo-option selected"[^>]*data-project="vetinari"[^>]*><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">jjforge\/vetinari<\/span>/,
  );
  // A project with no remote falls back to its bare key for the label.
  assert.match(
    html,
    /data-project="acme-checkout"[^>]*><span class="repo-dot idle"[^>]*><\/span><span class="repo-optlabel">acme-checkout<\/span>/,
  );
});
test("the repo dropdown menu rows carry a run-state dot, the owner/name label, and a note", () => {
  const html = renderStatusPage(
    {
      project: "acme/tidepool",
      waves: [{ index: 0, status: "running", issues: [] }],
      parked: [],
    },
    {
      projects: [
        { project: "jjforge/tidepool", runState: "parked" },
        { project: "acme/tidepool", runState: "running" },
      ],
      selected: "acme/tidepool",
    },
  );

  // The menu is a listbox; each repo is an option with a dot in its run-state colour,
  // the full owner/name label, and its run state as the note.
  assert.match(
    html,
    /<ul class="repo-menu" id="repo-menu" role="listbox" aria-label="Switch repo" tabindex="-1" hidden>/,
  );
  assert.match(
    html,
    /<li class="repo-option" role="option" aria-selected="false" data-project="jjforge\/tidepool" tabindex="-1"><span class="repo-dot parked" aria-hidden="true"><\/span><span class="repo-optlabel">jjforge\/tidepool<\/span><span class="repo-note">parked<\/span><\/li>/,
  );
  // The current scope's row is filled (aria-selected + a .selected class), no checkmark.
  // The current scope's row is the fill (a .selected class + aria-selected), with no
  // checkmark glyph inside the row — the fill alone marks it.
  assert.match(
    html,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="acme\/tidepool" tabindex="-1"><span class="repo-dot running"[^>]*><\/span><span class="repo-optlabel">acme\/tidepool<\/span><span class="repo-note">running<\/span><\/li>/,
  );
});
test("switching scope resets the view: it navigates (fresh sheet) and closed-wave state is per-repo", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "completed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      projects: [
        { project: "alpha", runState: "idle" },
        { project: "beta", runState: "running" },
      ],
      selected: "beta",
    },
  );
  // A scope switch is a navigation, so the target page loads fresh — the issue sheet
  // starts hidden and nothing is pre-opened.
  assert.match(
    REPO_DROPDOWN_SCRIPT,
    /location\.href = project \? "\/\?project=" \+ encodeURIComponent\(project\) : "\/";/,
  );
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  // Expanded closed-waves are persisted per-repo, so a different scope reads its own
  // (collapsed) set — wave labels aren't unique across repos, so this can't expand the wrong wave.
  assert.match(
    html,
    /const storeKey = "vetinari:closed-waves:" \+ waveBar\.dataset\.project;/,
  );
});
test("renderStatusPage renders archived runs as a collapsible list of wave cards, with no mode control or raw pane (#222)", () => {
  // Pin the timezone so the local-rendered when-clock is deterministic here (the
  // dedicated #102 test covers the divergent-tz case); UTC keeps `22:22:36`.
  const origTZ = process.env.TZ;
  process.env.TZ = "UTC";
  try {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T22-22-36-267Z",
          name: "comms + dashboard",
          startedAt: "2026-02-01T22:22:36.267Z",
          state: "complete",
          issues: 3,
          status: archStatus("101"),
        },
        {
          run: "2026-01-01T00-00-00-000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          state: "stalled",
          issues: 1,
          status: archStatus("111"),
        },
      ],
    },
  );

  // The shared log-view chrome header (#256) — the .tail-head control bar the
  // live-tail/feed/host-log carry, an "Archived runs" static title and a filter
  // input — replaces the bespoke <h2>Archived runs</h2>.
  assert.doesNotMatch(html, /<h2>Archived runs<\/h2>/);
  assert.match(
    html,
    /<section class="archived-runs"><div class="tail-head"><span class="tail-title tail-title-static">Archived runs<\/span><span class="tail-gap"><\/span><span class="tail-controls"><input type="text" class="tail-filter" placeholder="filter runs…" aria-label="Filter archived runs" data-archive-filter \/><\/span><\/div>/,
  );
  assert.match(html, /<ul class="archive-list" data-project="beta">/);
  // No download/pause .lv-ico buttons on this static, non-downloadable surface (#256).
  const section = html.slice(
    html.indexOf('<section class="archived-runs">'),
    html.indexOf("</section>", html.indexOf('<section class="archived-runs">')),
  );
  assert.doesNotMatch(section, /lv-ico/);
  // A collapsed row renders through the shared `.lv-row` control (not bespoke
  // `.archive-*` chrome): the when-time in the dim `.lv-t` tier, a mapped `.lv-dot`
  // (complete → merged/green), the run name as the brightest `.lv-lead`, and the
  // disposition `state · N issues` as the dim `.lv-verb`.
  assert.match(html, /<li data-run="2026-02-01T22-22-36-267Z">/);
  assert.match(
    html,
    /<button type="button" class="lv-row" aria-expanded="false" aria-controls="archive-body-2026-02-01T22-22-36-267Z"><span class="lv-t">Feb 1, 2026 · 22:22:36<\/span><span class="lv-dot merged"><\/span><span class="lv-msg"><span class="lv-lead">comms \+ dashboard<\/span><span class="lv-verb">complete · 3 issues<\/span><\/span><\/button>/,
  );
  // An unnamed run falls back to its token as the label; issue count pluralizes;
  // stalled maps to the parked (amber) dot (ADR 0019).
  assert.match(
    html,
    /<span class="lv-dot parked"><\/span><span class="lv-msg"><span class="lv-lead">2026-01-01T00-00-00-000Z<\/span><span class="lv-verb">stalled · 1 issue<\/span><\/span>/,
  );
  // The bespoke `.archive-*` chrome is gone.
  assert.doesNotMatch(html, /archive-name|archive-when|archive-state|archive-dot|archive-toggle|archive-chevron/);
  // No mode control at all — an archived run is a single expandable line (#222).
  assert.doesNotMatch(html, /class="archive-modes"/);
  assert.doesNotMatch(html, /class="archive-mode/);
  assert.doesNotMatch(html, /data-mode=/);
  // …and no run-level raw/log pane — the expanded body is the wave-card grid only.
  assert.doesNotMatch(html, /archive-raw/);
  assert.doesNotMatch(html, /data-pane=/);
  // The expanded body reuses the live wave renderer directly — the run's own chip renders.
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T22-22-36-267Z" hidden>[\s\S]*#101 <small>/,
  );
  // Bodies start collapsed (hidden) and rows render newest-first (order preserved).
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T22-22-36-267Z" hidden>/,
  );
  assert.ok(
    html.indexOf("2026-02-01T22-22-36-267Z") <
      html.indexOf("2026-01-01T00-00-00-000Z"),
    "newest-first",
  );
  // A short list has no show-older control.
  assert.doesNotMatch(html, /<button[^>]*class="archive-show-older"/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});
test("renderStatusPage renders an archived run's when-time in the operator's LOCAL timezone, no UTC suffix (#102)", () => {
  // The gateway runs in the operator's timezone, so the displayed clock localizes.
  // PST is UTC−8 in February: `2026-02-01T22:22:36.267Z` reads `14:22:36` local,
  // and the hardcoded " UTC" suffix is gone (raw-log content, not this chrome, keeps UTC).
  const origTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const html = renderStatusPage(
      { project: "beta", waves: [], parked: [] },
      {
        selected: "beta",
        archivedRuns: [
          {
            run: "2026-02-01T22-22-36-267Z",
            name: "comms + dashboard",
            startedAt: "2026-02-01T22:22:36.267Z",
            state: "complete",
            issues: 1,
            status: archStatus("101"),
          },
        ],
      },
    );
    assert.match(
      html,
      /<span class="lv-t">Feb 1, 2026 · 14:22:36<\/span>/,
    );
    assert.doesNotMatch(html, /lv-t">[^<]*UTC/);
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});
test("renderStatusPage shows a stalled run as stalled and still expands it to its partial waves", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      // A run cut short: wave 1 merged, wave 2 was in flight when it stopped.
      archivedRun: "2026-05-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-05-01T00-00-00-000Z",
          startedAt: "2026-05-01T00:00:00.000Z",
          state: "stalled",
          issues: 2,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "completed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
              {
                // The FSM folds a stalled run's in-flight issue to `parked{stalled}` —
                // an archived run never reads as live (#152, ADR 0019).
                index: 1,
                status: "parked",
                issues: [{ issueNumber: "201", status: "parked", reason: "stalled" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The row reads stalled — the parked (amber) dot and the `.lv-verb` disposition…
  assert.match(
    html,
    /<span class="lv-dot parked"><\/span><span class="lv-msg"><span class="lv-lead">2026-05-01T00-00-00-000Z<\/span><span class="lv-verb">stalled · 2 issues<\/span><\/span>/,
  );
  // …and, opened, its body still shows the partial waves it did run — the in-flight
  // wave/issue folded to the terminal `parked{stalled}`, never `running`.
  // (The live campaign has no waves, so these chips are the archived run's own.)
  assert.match(html, /#101 <small>completed<\/small>/);
  assert.match(html, /#201 <small>parked<\/small>/);
  assert.doesNotMatch(html, /<small>running<\/small>/);
});
test("renderStatusPage opens the archived row named by archivedRun, showing its wave cards (#222)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // The named row opens: its `.lv-row` toggle expanded, its body shown.
  assert.match(
    html,
    /<li class="open" data-run="2026-02-01T00-00-00-000Z">/,
  );
  assert.match(
    html,
    /<button type="button" class="lv-row" aria-expanded="true" aria-controls="archive-body-2026-02-01T00-00-00-000Z"/,
  );
  // The body shows and holds the wave-card grid directly — no mode toggle, no raw pane.
  assert.match(
    html,
    /<div class="archive-body" id="archive-body-2026-02-01T00-00-00-000Z">[\s\S]*#101 <small>/,
  );
  assert.doesNotMatch(html, /archive-mode/);
  assert.doesNotMatch(html, /archive-raw/);
  assert.doesNotMatch(html, /data-pane=/);
});
test("renderStatusPage carries no raw-specific archive CSS on phone-width (#222)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRun: "2026-02-01T00-00-00-000Z",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );

  // The raw-log pane and mode toggle are gone, so their ≤640px overrides are gone
  // with them — no leftover .archive-raw / .archive-modes / .archive-pane rules.
  assert.doesNotMatch(html, /\.archive-raw/);
  assert.doesNotMatch(html, /\.archive-modes/);
  assert.doesNotMatch(html, /\.archive-pane/);
  assert.doesNotMatch(html, /\.archive-mode/);
});
test("renderStatusPage ships the archived-list client wiring: expand/collapse (one open at a time) and the filter, and nothing raw/log (#222, #256)", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: archStatus("101"),
        },
      ],
    },
  );
  // The page embeds the archived-list script…
  assert.ok(html.includes(ARCHIVE_LIST_SCRIPT), "page includes ARCHIVE_LIST_SCRIPT");
  // …a row's shared `.lv-row` head toggles its body open/closed…
  assert.match(ARCHIVE_LIST_SCRIPT, /row\.querySelector\("\.lv-row"\)/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /\.archive-toggle/);
  // …one row open at a time (opening closes the others)…
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /for \(const other of archiveRows\) if \(other !== row && other\.classList\.contains\("open"\)\) closeRow\(other\);/,
  );
  // …the URL reducer is shipped to the browser (#333) so open/close mirror the run into the
  // URL through the node-tested archiveRunHref…
  assert.match(ARCHIVE_LIST_SCRIPT, /function archiveRunHref/);
  // …closing a row clears run= (syncUrl(null)), so a reload renders the list collapsed…
  assert.match(ARCHIVE_LIST_SCRIPT, /closeRow = \(row\) => \{[\s\S]*syncUrl\(null\);/);
  // …and opening records the newly-opened run *after* closing the others, so opening B while A
  // is open leaves the URL naming only B — the ordering invariant closeRow-then-syncUrl relies on.
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /openRow = \(row\) => \{[\s\S]*closeRow\(other\);[\s\S]*syncUrl\(row\.dataset\.run\);/,
  );
  // …and typing in the shared filter hides the non-matching li[data-run] rows over
  // their visible summary text (archiveRowMatches — the feed/host-log filter contract).
  assert.match(ARCHIVE_LIST_SCRIPT, /function archiveRowMatches/);
  assert.match(
    ARCHIVE_LIST_SCRIPT,
    /filterEl\.addEventListener\("input", \(\) => \{[\s\S]*row\.hidden = !archiveRowMatches\(row\.querySelector\("\.lv-row"\)\.textContent, filterEl\.value\);/,
  );
  // The dropped show-older cap leaves no show-older wiring behind.
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /showOlder|archive-show-older|archive-older-row/);
  // The raw/log surface is gone: no mode switch, no /archive/log fetch, no line-number
  // deep-links, no filter, no Download JSON, no cap machinery.
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /\/archive\/log/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /archive-raw/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /highlightJsonLine/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /cappedRawRows/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /humanizedRow/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /rawMode|MODE_KEY|localStorage/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /data-archive-raw-save|Download JSON/);
  assert.doesNotMatch(ARCHIVE_LIST_SCRIPT, /#L|mode=raw/);
});
test("renderStatusPage makes archived campaign chips open the issue sheet against the archived run, read-only", () => {
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "completed",
                issues: [{ issueNumber: "101", status: "completed" }],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );
  // The chip carries its issue, project and the run token, so the shared sheet reads
  // the archived run's own log (its turn log lives there, not in the live log).
  assert.match(
    html,
    /data-issue="101" data-project="beta" data-run="2026-02-01T00-00-00-000Z"/,
  );
  // Read-only: an archived chip is never prunable (a finished run has nothing to prune).
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-prunable/);
  // The shared sheet forwards a run token to /api/issue so it can read the archive.
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /run \? "&run=" \+ encodeURIComponent\(run\) : ""/,
  );
});
test("renderStatusPage renders every archived run in the scrollable pane, no show-older cap (#256)", () => {
  const runs = Array.from({ length: 22 }, (_, i) => {
    const day = String(22 - i).padStart(2, "0");
    return {
      run: `2026-01-${day}T00-00-00-000Z`,
      startedAt: `2026-01-${day}T00:00:00.000Z`,
      state: "complete" as const,
      issues: 1,
      status: archStatus(String(100 + i)),
    };
  });
  const html = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { selected: "beta", archivedRuns: runs },
  );

  // Every row renders — a list longer than the old cap is not truncated…
  assert.equal(
    [...html.matchAll(/<li(?: class="open")? data-run=/g)].length,
    22,
  );
  // …none render hidden (the cap is gone; the pane scrolls instead)…
  assert.doesNotMatch(html, /<li data-run="[^"]*" hidden>/);
  // …and there is no show-older control or its row.
  assert.doesNotMatch(html, /archive-show-older/);
  assert.doesNotMatch(html, /archive-older-row/);
});
test("renderStatusPage omits the campaign name from the meta line for an unnamed run", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });
  assert.doesNotMatch(html, /class="run-name"/);
  assert.doesNotMatch(html, /class="campaign-name"/);
  // The counts still render — an unnamed campaign is still a campaign.
  assert.match(html, /<p class="campaign-meta">0 issues · 1 wave<\/p>/);
});
test("renderStatusPage renders no archived-runs section when a project has none", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { selected: "demo" },
  );
  assert.doesNotMatch(html, /class="archived-runs"/);
  assert.doesNotMatch(html, /class="archived-run"/);
});
test("renderStatusPage omits the project dropdown when no project list is given", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /class="repo-dropdown"/);
  assert.doesNotMatch(html, /class="project-picker"/);
  assert.doesNotMatch(html, /<select name="project"/);
  // A single-project view with no repo list falls back to a plain <h1> heading.
  assert.match(html, /<h1>demo<\/h1>/);
});
test("renderStatusPage uses the jjforge dark palette", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.match(html, /--color-body: #090c10/);
  assert.match(html, /--color-primary: #3fb9b0/);
  assert.match(html, /--color-box-header: #10151b/);
  assert.match(html, /--color-text: #e6edf3/);
  assert.match(html, /background: var\(--color-body\)/);
  assert.doesNotMatch(html, /radial-gradient/);
});
test("renderStatusPage does not render the color legend under the heading", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  assert.doesNotMatch(html, /Green completed · Yellow parked · Red failure/);
});
test("renderStatusPage makes issue chips tap-friendly for touch devices", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "Add login flow",
            detail: "Agent turn 2 finished; waiting for verification/redrive",
          },
        ],
      },
    ],
    parked: [],
  });

  // The chip keeps its hover title and now carries the ids the sheet fetches with.
  assert.match(
    html,
    /title="Add login flow&#10;Agent turn 2 finished; waiting for verification\/redrive"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="101"[^>]*data-project="demo"/,
  );
  assert.match(html, /id="issue-detail"/);
  assert.match(html, /el\.addEventListener\("click"/);
});
test("renderStatusPage opens the issue-detail sheet from a chip, fetching /api/issue", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          { issueNumber: "101", status: "running", name: "Add login flow" },
        ],
      },
    ],
    parked: [],
  });

  // A dismissible sheet, hidden until an issue is opened.
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="issue-detail-close"/);
  // A sticky header (number, status, title, repo · campaign), meta tiles, and the turn log.
  assert.match(html, /class="issue-detail-header"/);
  assert.match(html, /\.issue-detail-header \{[^}]*position: sticky;/);
  assert.match(html, /class="issue-detail-title"/);
  assert.match(html, /class="issue-detail-context"/);
  assert.match(html, /id="issue-detail-turns"/);
  assert.match(html, /id="issue-detail-turnlog"/);
  // Chips open the sheet, which fetches the reconstructed detail.
  assert.match(html, /openIssue\(/);
  assert.match(html, /fetch\("\/api\/issue\?project="/);
  // Dismissible, and reveal keys off a `show` class over the hidden default.
  assert.match(html, /\.issue-detail\.show \{ display: flex; \}/);
  assert.match(
    html,
    /getElementById\("issue-detail-close"\)\.addEventListener\("click"/,
  );
});
test("renderStatusPage gives the sheet a WORKTREE tile and turns-with-duration meta (#90)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // A third meta tile carrying the agent's real worktree path — hidden until a
  // fetched detail carries one, so a run without a preserved worktree shows nothing.
  assert.match(
    html,
    /<div class="meta-tile[^"]*" id="issue-detail-worktree-tile" hidden>/,
  );
  assert.match(html, /<span class="meta-label">Worktree<\/span>/);
  assert.match(html, /id="issue-detail-worktree"/);
  // A meta-tile is a flex box, so its display would defeat the UA [hidden] rule;
  // restore the collapse so the worktree tile can hide when the path is absent.
  assert.match(html, /\.meta-tile\[hidden\][^{]*\{ display: none;? \}/);
  // The script reveals the tile only when the detail carries a worktree path…
  assert.match(html, /d\.worktree/);
  // …and presents turns with their working duration (N turns · Mm), not a bare count.
  assert.match(html, /" turn" \+ \(.*\? "" : "s"\) \+ " · "/);
});
test("renderStatusPage renders the turn log newest-first with each turn number in its status colour", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Each turn's number carries the issue's status class, so it reads in the status colour.
  assert.match(html, /"turn-num " \+ .*\bstatus\b/);
  // The turn log region is an ordered list the script fills from the fetched turnLog.
  assert.match(html, /id="issue-detail-turnlog"/);
  assert.match(html, /turnLog/);
  // The status dot palette is shared, so a turn number reuses the same status colours. Each
  // state's colour is `stateColor` (asserted by value there); one structural check confirms the
  // page splices those turn-num rules in, proven once rather than re-pinned per state.
  const turnNumCss = ["completed", "parked", "failed", "running", "unstarted"]
    .map((s) => `.turn-num.${s} { color: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(turnNumCss), "the page splices the stateColor-derived turn-num rules");
});
test("renderStatusPage makes the issue-detail sheet a full-width bottom sheet on mobile", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // Desktop: a centred sheet. Mobile: pinned full-width to the bottom.
  assert.match(
    html,
    /@media \(max-width: [^)]+\) \{[^}]*\.issue-detail-sheet \{[^}]*width: 100%;/,
  );
  assert.match(html, /\.issue-detail-sheet/);
});
test("renderStatusPage hosts the prune affordance and inline confirm in the tap-detail panel", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "unstarted",
          issues: [{ issueNumber: "301", status: "unstarted" }],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // The panel — not the chip — carries a Prune button (in the one shared move-button style)
  // and a hidden inline confirm.
  assert.match(
    html,
    /<button type="button" id="prune-start" class="sheet-btn prune-start">Prune<\/button>/,
  );
  assert.match(
    html,
    /<form method="post" action="\/prune" id="prune-confirm"[^>]*hidden>/,
  );
  assert.match(html, /<span class="prune-confirm-text"><\/span>/);
  // The confirm POSTs the existing /prune with confirm=1, carrying taskId+project.
  assert.match(
    html,
    /id="prune-confirm"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?name="confirm" value="1"/,
  );
  assert.match(
    html,
    /<button type="submit" class="prune-confirm-btn">Confirm<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" id="prune-cancel" class="prune-cancel">Cancel<\/button>/,
  );
  // The script keys off the prune data: it fetches the JSON preview, discloses the
  // removed list, POSTs the confirm, then shows a transient "pruning…".
  assert.match(html, /\/prune\?preview/);
  assert.match(html, /prune-confirm-text/);
  assert.match(html, /data-prunable/);
  assert.match(html, /method: "POST"/);
  assert.match(html, /pruning/);
});
test("renderStatusPage hosts a parked reply block with a Reply submit and no sheet Redrive form (#307, #325)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The sheet carries a reply block, hidden until the opened issue is parked.
  assert.match(
    html,
    /<div id="issue-detail-reply" class="issue-detail-reply" hidden>/,
  );
  assert.match(html, /id="reply-question"/);
  assert.match(html, /id="reply-options"/);
  // A free-text reply field posts through the existing /answer path, carrying taskId+project.
  assert.match(html, /<form method="post" action="\/answer" id="reply-form">/);
  assert.match(
    html,
    /id="reply-form"[\s\S]*?name="taskId"[\s\S]*?name="project"[\s\S]*?<textarea name="text"/,
  );
  // Reply submits that form; it is associated by `form=` so it can sit outside the form, beside Prune.
  assert.match(
    html,
    /<button type="submit" form="reply-form" id="reply-send" class="sheet-btn" hidden>Reply<\/button>/,
  );
  // The sheet has no Redrive form of its own — redrive is a whole-campaign control on the page (#325).
  assert.doesNotMatch(html, /id="redrive-form"/);
});
test("renderStatusPage caps the reply textarea so it stays within the sheet/card (#73)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });
  // A width:100% textarea with padding still spilled past the right edge of the sheet
  // and the parked card; max-width:100% caps it against its padded content box so it
  // never overflows and introduces no horizontal scroll on the sheet.
  assert.match(html, /\btextarea \{[^}]*max-width: 100%/);
});
test("renderStatusPage places Reply and Prune in one sheet-actions row, sized for touch (#307, #325)", () => {
  const html = renderStatusPage(
    { project: "demo", waves: [], parked: [] },
    { prune: true },
  );

  // The issue-level move controls live in the same actions row so they are reachable together;
  // Redrive is no longer among them — it is a campaign control on the page (#325).
  assert.match(
    html,
    /<div class="sheet-actions"><button type="submit" form="reply-form" id="reply-send"[^>]*>Reply<\/button><div id="prune-panel"/,
  );
  assert.doesNotMatch(html, /id="redrive-form"/);
  // A 44px tap target for the shared move button on a phone.
  assert.match(html, /\.sheet-btn \{[^}]*min-height: 44px;/);
  // The actions row is a flex box, so it needs [hidden] restored explicitly or an
  // empty foot (no reply, no prune) would always show its border and padding.
  assert.match(html, /\.sheet-actions\[hidden\][^{]*\{ display: none; \}/);
  // The prune panel is likewise a flex box whose display would defeat the UA
  // [hidden] rule; restore its collapse rule so a non-prunable issue can hide it (#72).
  assert.match(html, /\.prune-panel\[hidden\][^{]*\{ display: none;? \}/);
  // …and the confirm form inside it: its own `display: flex` would defeat the UA
  // [hidden] rule too, so Confirm/Cancel showed by default beside Prune. Restore the
  // collapse so they reveal only in the prune step and the default action row is Prune alone (#90).
  assert.match(html, /\.prune-confirm\[hidden\][^{]*\{ display: none;? \}/);
});
test("renderStatusPage wires the parked reply block: shown when parked, options fill the field", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The reply block reveals only for a parked issue, carrying its ids for /answer.
  assert.match(html, /d\.status === "parked"/);
  assert.match(html, /d\.parked/);
  // Options render as buttons that fill the reply field without submitting it.
  assert.match(html, /"reply-option"/);
  assert.match(html, /replyText\.value = /);
});
test("renderStatusPage gives the parked block a directive heading and labels the turn log (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The parked block leads with a directive heading, not a flat "Reply & redrive".
  assert.match(html, /class="reply-heading" id="reply-heading">PARKED — NEEDS YOUR ANSWER</);
  assert.doesNotMatch(html, /Reply &amp; redrive/);
  // The turn log is its own labeled section ("Agent turns"), distinct from the meta tiles.
  assert.match(html, /class="turn-log-heading">Agent turns</);
});
test("renderStatusPage shows the duration once and pluralizes the turn count (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // TURNS now carries the working duration (N turns · Mm), so the separate ELAPSED
  // tile is redundant and gone — no tile, no script ref, no formatter output for it.
  assert.doesNotMatch(html, /id="issue-detail-elapsed"/);
  assert.doesNotMatch(html, /<span class="meta-label">Elapsed<\/span>/);
  assert.doesNotMatch(html, /detailElapsed/);
  // The count pluralizes: "1 turn", "N turns" — never the "1 turns" the POC flags.
  assert.match(html, /" turn" \+ \(.*=== 1 \? "" : "s"\)/);
  assert.match(html, /" · "/);
});
test("renderStatusPage renders reply options as full-width lettered rows (#92)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // The options stack one per line as full-width rows, not inline wrapping pills.
  assert.match(
    html,
    /\.reply-options \{[^}]*flex-direction: column;/,
  );
  // Each row is a flex row: a fixed letter margin on the left, the label filling the rest.
  assert.match(html, /\.reply-option \{[^}]*display: flex;/);
  assert.match(html, /\.reply-option-letter \{/);
  // An "A:"/"B)"-style marker in the option is pulled into the letter margin; an
  // option with no marker falls back to a positional A/B/C letter from the index.
  assert.match(html, /option\.match\(\/\^\(\[A-Za-z\]\)\[\.\):\]/);
  assert.match(html, /String\.fromCharCode\(65 \+ /);
  assert.match(html, /"reply-option-letter"/);
  assert.match(html, /"reply-option-label"/);
  // Clicking a row still fills the reply field with the full original option text.
  assert.match(html, /replyText\.value = option/);
});
test("renderStatusPage falls back to a no-JS prune form per prunable issue", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 1,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // Progressive enhancement: a plain server-side form per prunable issue, inside
  // <noscript>, still reaches POST /prune → the preview page → confirm with no JS.
  assert.match(
    html,
    /<noscript>[\s\S]*<form method="post" action="\/prune"[\s\S]*?name="taskId" value="301"[\s\S]*?name="project" value="demo"[\s\S]*<\/noscript>/,
  );
  assert.match(
    html,
    /<noscript>[\s\S]*name="taskId" value="302"[\s\S]*<\/noscript>/,
  );
  // Never a fallback form for a running (in-flight) issue.
  assert.doesNotMatch(html, /name="taskId" value="201"/);
});
test("renderStatusPage omits the prune panel and no-JS fallback unless prune is opted in", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /id="prune-start"/);
  assert.doesNotMatch(html, /<noscript>/);
});
test("renderStatusPage leads with parked issues above the waves when any are parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "question",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  assert.match(
    html,
    /<section class="parked-issues"><h2>Parked · <span class="parked-count">1<\/span><\/h2>/,
  );
  // Parked section comes before the wave grid.
  assert.ok(
    html.indexOf('class="parked-issues"') < html.indexOf('class="waves-grid"'),
    "parked should render above the waves",
  );
  // The parked-dot color rule must stay background-only; the section styling must not
  // bleed onto <span class="dot parked"> and inflate the chip height.
  assert.match(html, /\.parked \{ background: var\(--color-yellow\); \}/);
  assert.doesNotMatch(html, /\.parked \{[^}]*margin/);
});
test("renderStatusPage opens the issue-detail sheet from a parked row too", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "question",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // The whole parked card is a clickable question card carrying the ids the sheet
  // fetches with; its href is the no-JS fallback, and the same wiring opens the sheet
  // from a member row or a parked card (the anchor's default click is prevented).
  assert.match(
    html,
    /<a class="parked-card" href="\/\?project=demo" data-issue="102" data-project="demo"><div class="parked-card-title"><span class="parked-issue">#102<\/span> Need a choice\.<\/div>/,
  );
  assert.match(
    html,
    /querySelectorAll\("\.wave-member\[data-issue\], \.parked-card\[data-issue\]"\)/,
  );
  assert.match(html, /event\.preventDefault\(\); openIssue\(/);
});
test("renderStatusPage omits the parked section entirely when nothing is parked", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "running", issues: [] }],
    parked: [],
  });

  assert.doesNotMatch(html, /Parked issues/);
  assert.doesNotMatch(html, /Nothing parked/);
  assert.doesNotMatch(html, /class="parked-issues"/);
});
test("renderStatusPage orders the top of the page: Parked → campaign-meta → waves (#81)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [
      {
        issueNumber: "102",
        reason: "question",
        parkedAt: "now",
        branch: "agent/102",
        description: "Need a choice.",
        options: [],
      },
    ],
  });

  // Top→bottom order per the design (#81): the Parked section leads, then the
  // campaign-meta line, then the waves — the meta line no longer sits above Parked.
  assert.ok(
    html.indexOf('class="parked-issues"') <
      html.indexOf('class="campaign-meta"'),
    "Parked should render above the campaign-meta line",
  );
  assert.ok(
    html.indexOf('class="campaign-meta"') < html.indexOf('class="waves-grid"'),
    "campaign-meta should render above the waves",
  );
});
test("a parked card spells its reason with reasonWord, so red-base reads as two words (#317)", () => {
  // The parked card's meta prints the park reason the same way every other surface does —
  // through the one `reasonWord` mapping — so `red-base` reads `red base`, never the raw enum.
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "red-base",
        parkedAt: "now",
        branch: "agent/102",
        description: "Held on a red base.",
        options: [],
      },
    ],
  });
  assert.match(html, /<div class="parked-card-meta">waiting <span class="parked-waited"[^>]*>…<\/span> · red base<\/div>/);
  assert.doesNotMatch(html, /· red-base<\/div>/);
});
test("renderStatusPage collapses closed waves into expandable completed wave chips", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<div class="completed-waves"><div class="completed-wave-bar" data-project="demo">/,
  );
  assert.doesNotMatch(html, /Completed:/);
  // The chip is a toggle button, not a native <details>/<summary>.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">1\/1<\/span><\/button>/,
  );
  assert.match(
    html,
    /\.completed-wave-chip \.check \{ color: var\(--color-green\);/,
  );
  // The closed-wave toggle bar must not stretch: the first wrapped line was rendering
  // taller in Safari.
  assert.match(
    html,
    /\.completed-wave-bar \{ display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start;/,
  );
  // The open wave still renders its own card in the grid.
  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span><\/div><\/div>/,
  );
});
test("renderStatusPage labels a single-issue wave with that issue's resolved title, keeping the index", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<section class="wave running"><div class="wave-head"><h2 class="wave-label">Wave 2 — config resolution<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});
test("renderStatusPage labels a multi-issue wave with its lead issue's title + the extra count", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running", name: "config resolution" },
          { issueNumber: "202", status: "unstarted", name: "retry policy" },
          { issueNumber: "203", status: "unstarted", name: "log rotation" },
          { issueNumber: "204", status: "unstarted", name: "cache eviction" },
        ],
      },
    ],
    parked: [],
  });

  // Lead title names the wave; the rest collapse to a "+N" (all four still carry
  // their own titles on their chips).
  assert.match(
    html,
    /<h2 class="wave-label">Wave 2 — config resolution \+3<\/h2><div class="wave-meta"><span class="wave-tally">0\/4<\/span><span class="wave-status running">running<\/span>/,
  );
});
test("renderStatusPage keeps a closed wave's chip compact and puts the issue titles on its card", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [
          {
            issueNumber: "101",
            status: "completed",
            name: "config resolution",
          },
          { issueNumber: "102", status: "completed", name: "retry policy" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The compact chip carries only "Wave N" + the merged tally — no lead title.
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
  // The lead title + "+N" reads on the full card the chip reveals in the grid.
  assert.match(
    html,
    /<section class="wave completed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — config resolution \+1<\/h2><div class="wave-meta"><span class="wave-tally">2\/2<\/span><span class="wave-status completed">completed<\/span>/,
  );
});
test("renderStatusPage escapes a wave name derived from an issue title", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [
          {
            issueNumber: "101",
            status: "running",
            name: "fix <script> & things",
          },
        ],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1 — fix &lt;script&gt; &amp; things<\/h2>/,
  );
});
test("renderStatusPage keeps the bare wave index when no issue title is resolved yet", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "101", status: "running" }],
      },
    ],
    parked: [],
  });

  assert.match(
    html,
    /<h2 class="wave-label">Wave 1<\/h2><div class="wave-meta"><span class="wave-tally">0\/1<\/span><span class="wave-status running">running<\/span>/,
  );
});
test("renderStatusPage renders a campaign meta line of name · issues · waves, omitted with no campaign (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    name: "gateway work",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
      {
        index: 1,
        status: "running",
        issues: [
          { issueNumber: "201", status: "running" },
          { issueNumber: "202", status: "unstarted" },
        ],
      },
    ],
    parked: [],
  });
  // Three issues across two waves, under the named campaign.
  assert.match(
    html,
    /<p class="campaign-meta"><span class="campaign-name">gateway work<\/span> · 3 issues · 2 waves<\/p>/,
  );

  // With no campaign at all (no waves), the meta line is omitted entirely.
  const empty = renderStatusPage({ project: "demo", waves: [], parked: [] });
  assert.doesNotMatch(empty, /class="campaign-meta"/);
});
test("renderStatusPage lays open waves out in a grid, accenting the running wave (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
      {
        index: 1,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });
  // Open wave cards sit in a responsive grid.
  assert.match(html, /<div class="waves-grid"><section class="wave running">/);
  assert.match(
    html,
    /\.waves-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(20rem, 1fr\)\);/,
  );
  // A running wave carries the status-coloured (blue) top accent; an unstarted one the dim default (§3).
  assert.match(html, /\.wave \{[^}]*border-top: 3px solid var\(--color-dim\);/);
  assert.match(
    html,
    /\.wave\.running \{ border-top-color: var\(--color-blue\); \}/,
  );
  assert.match(html, /<section class="wave unstarted">/);
});
test("renderStatusPage's parked card carries no inline reply form — the reply is in the sheet (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [],
    parked: [
      {
        issueNumber: "102",
        reason: "question",
        parkedAt: "2025-06-15T09:00:00.000Z",
        branch: "agent/102",
        description: "Need a choice.",
        options: ["A", "B"],
      },
    ],
  });
  // The card is a single clickable anchor with a meta line — no <form>, no <textarea>,
  // no per-issue "Send response" button. The only /answer form on the page is the sheet's.
  const card = html.slice(
    html.indexOf('class="parked-card"'),
    html.indexOf("</a>", html.indexOf('class="parked-card"')),
  );
  assert.doesNotMatch(card, /<form|<textarea|Send response/);
  assert.match(
    html,
    /waiting <span class="parked-waited" data-parked-at="2025-06-15T09:00:00.000Z">…<\/span> · question/,
  );
  // Exactly one /answer form remains — the sheet's reply-form.
  assert.equal(html.match(/action="\/answer"/g)?.length, 1);
});
test("renderStatusPage renders the landing live-bar top-right, not the old refresh widget (#79)", () => {
  const html = renderStatusPage({
    project: "demo",
    waves: [{ index: 0, status: "completed", issues: [] }],
    parked: [],
  });

  // The live-bar replaces the fixed-interval Refresh widget: a dot-only live indicator and
  // an "last activity Ns ago" readout — the same shared control the landing renders (#81). The
  // indicator shows no visible "Live" text (its state is an accessible label). The
  // page-level pause is gone (#210), so the bar carries no pause button; the settings gear
  // now rides the end of the bar after the readout (#215), so the readout no longer closes it.
  assert.match(
    html,
    /<div class="live-bar"[^>]*><span class="live-indicator" data-live-state="live" aria-label="Live"><\/span><span class="updated" data-updated>[^<]*<\/span>/,
  );
  assert.doesNotMatch(html, /id="pause"/);
  // The old interval widget is gone entirely.
  assert.doesNotMatch(html, /id="refresh-seconds"/);
  assert.doesNotMatch(html, /id="refresh-enabled"/);
  assert.doesNotMatch(html, /class="refresh"/);
  assert.doesNotMatch(html, /sandcastle-status-refresh/);
  // The h1 drops the " status" wording; with no dropdown it is just the project name.
  assert.match(
    html,
    /<div class="page-top"><h1>demo<\/h1><div class="live-bar"/,
  );
  assert.match(html, /\.page-top \{ display: flex;/);
});
test("renderStatusPage updates live off /api/events, soft-refreshing on a ping unless composing (#79, #131)", () => {
  const html = renderStatusPage({ project: "demo", waves: [], parked: [] });

  // One SSE stream drives updates as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // Soft-refresh, not a full reload (#131): a live tick re-fetches this page and swaps only
  // the #live-region, so the issue sheet, its open compose, and scroll survive — worst over
  // the tailnet, where a full reload blanked the page. The one deliberate reload on the page
  // is the settings gear's festive toggle (#193, #215 — server-rendered labels re-render only
  // on a reload); the live-event soft-refresh path itself never reloads.
  const softRefreshFn = html.match(/const softRefresh = async \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(softRefreshFn, "the soft-refresh function is present");
  assert.doesNotMatch(softRefreshFn[0], /location\.reload\(\)/);
  assert.match(html, /id="live-region"/);
  assert.match(html, /fetch\(location\.href/);
  assert.match(html, /DOMParser/);
  assert.match(html, /getElementById\("live-region"\)/);
  assert.match(html, /softRefresh\(\)/);
  // The page-level pause is gone (#210): no pause button, no paused/buffered state — a live
  // event always soft-refreshes.
  assert.doesNotMatch(html, /pauseBtn/);
  assert.doesNotMatch(html, /let paused/);
  // The "last activity Ns ago" readout is `freezeIntent`'s `updatedText` (dashboard-visual-state.ts,
  // asserted directly there), single-sourced into this page and written onto the readout.
  assert.match(html, /function freezeIntent/);
  assert.match(
    html,
    /updatedEl\.textContent = freezeIntent\(\{ lastUpdate, now: Date\.now\(\) \}\)\.updatedText/,
  );
});
test("renderStatusPage marks prunable chips with prune data and never puts a prune control on a chip", () => {
  const html = renderStatusPage(
    {
      project: "demo",
      waves: [
        {
          index: 0,
          status: "completed",
          issues: [{ issueNumber: "101", status: "completed" }],
        },
        {
          index: 1,
          status: "running",
          issues: [{ issueNumber: "201", status: "running" }],
        },
        {
          index: 2,
          status: "unstarted",
          issues: [
            { issueNumber: "301", status: "unstarted" },
            { issueNumber: "302", status: "parked" },
          ],
        },
      ],
      parked: [],
    },
    { prune: true },
  );

  // Each member row carries its issue and project; only a still-prunable one is flagged
  // prunable, so the tap-detail panel knows whether to offer a Prune button.
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="301"[^>]*data-project="demo"[^>]*data-prunable="1"/,
  );
  assert.match(
    html,
    /class="wave-member [a-z]+"[^>]*data-issue="302"[^>]*data-project="demo"[^>]*data-prunable="1"/,
  );
  // The completed (banked) and current-wave-in-flight (running) rows are not prunable.
  assert.doesNotMatch(html, /data-issue="101"[^>]*data-prunable/);
  assert.doesNotMatch(html, /data-issue="201"[^>]*data-prunable/);
  // Prune moved off the rows entirely: no inline ✂️ and no per-row prune form.
  assert.doesNotMatch(html, /✂️/);
  assert.doesNotMatch(html, /class="prune-form"/);
  assert.doesNotMatch(html, /class="chip-group"/);
  assert.doesNotMatch(html, /class="prune-btn"/);
});
test("renderStatusPage omits the prune control unless the page opts into it", () => {
  // The control is opt-in: both the standalone and the aggregated server pass
  // `prune: true`, but a bare render (e.g. the empty-registry page) shows none.
  const html = renderStatusPage({
    project: "demo",
    waves: [
      {
        index: 0,
        status: "unstarted",
        issues: [{ issueNumber: "301", status: "unstarted" }],
      },
    ],
    parked: [],
  });

  assert.doesNotMatch(html, /action="\/prune"/);
});
test("renderStatusPage renders closed waves as a compact toggle row of chip buttons", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [
          { issueNumber: "101", status: "completed" },
          { issueNumber: "102", status: "completed" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave is a toggle button (no native <details>/<summary>), carrying the
  // compact "Wave N" label + its merged/total tally + a chevron affordance, wired to
  // its card via aria-controls and defaulting to collapsed (aria-expanded="false").
  assert.doesNotMatch(html, /<details class="completed-wave"/);
  assert.doesNotMatch(html, /<summary/);
  assert.match(
    html,
    /<button type="button" class="completed-wave-chip" aria-expanded="false" aria-controls="closed-wave-0" data-wave="0"><span class="check" aria-hidden="true">✓<\/span> Wave 1 <span class="completed-wave-tally">2\/2<\/span><\/button>/,
  );
});
test("renderStatusPage renders each expanded closed wave's full card in the grid before the open waves", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [
          { issueNumber: "101", status: "completed", name: "cart persists" },
        ],
      },
      {
        index: 1,
        status: "running",
        issues: [{ issueNumber: "201", status: "running" }],
      },
    ],
    parked: [],
  });

  // The closed wave gets the SAME wave-card treatment as an open wave — a CLOSED pill,
  // its merged/total, and the merged member list — living in the waves-grid under a
  // stable id, hidden until its chip toggles it open.
  assert.match(
    html,
    /<section class="wave completed" id="closed-wave-0" hidden><div class="wave-head"><h2 class="wave-label">Wave 1 — cart persists<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status completed">completed<\/span><\/div><\/div>/,
  );
  // The closed card renders inside the same grid, positioned before the open running wave.
  const grid = html.match(
    /<div class="waves-grid">([\s\S]*?)<\/div>\s*(?:<section class="archived|<div id="issue-detail"|<noscript|<script)/,
  );
  assert.ok(grid, "expected a waves-grid");
  assert.ok(
    grid[1].indexOf('id="closed-wave-0"') < grid[1].indexOf("Wave 2"),
    "closed card should precede the open wave",
  );
});
test("renderStatusPage gives the closed-wave chip a chevron and a green accent when expanded", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The chevron is CSS keyed off aria-expanded (collapsed › → expanded ⌄), and an
  // expanded chip takes a green accent border.
  assert.match(html, /\.completed-wave-chip::after \{[^}]*content: "›"/);
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\]::after \{[^}]*content: "⌄"/,
  );
  assert.match(
    html,
    /\.completed-wave-chip\[aria-expanded="true"\] \{[^}]*border-color: var\(--color-green\)/,
  );
});
test("renderStatusPage persists the expanded closed-wave set across a live reload", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // The toggle row carries its project so the client can key the persisted open-set
  // per repo, and the script reads/writes it through storage so a /api/events reload
  // does not silently collapse everything the user opened.
  assert.match(html, /<div class="completed-wave-bar" data-project="beta">/);
  assert.match(html, /sessionStorage/);
  assert.match(html, /completed-wave-chip/);
});
test("renderStatusPage degrades the closed-wave toggle without JS", () => {
  const html = renderStatusPage({
    project: "beta",
    waves: [
      {
        index: 0,
        status: "completed",
        issues: [{ issueNumber: "101", status: "completed" }],
      },
    ],
    parked: [],
  });

  // Without JS the cards can never be toggled open, so a <noscript> reveals every
  // closed card in the grid and hides the inert toggle bar — the content stays reachable.
  assert.match(
    html,
    /<noscript><style>[^<]*\.completed-wave-bar \{ display: none;[^<]*\.wave\.completed\[hidden\] \{ display: block;/,
  );
});
test("renderStatusPage renders an archived run's closed waves as full cards, not colliding toggle ids", () => {
  const html = renderStatusPage(
    {
      project: "beta",
      waves: [
        {
          index: 0,
          status: "completed",
          issues: [{ issueNumber: "201", status: "completed" }],
        },
      ],
      parked: [],
    },
    {
      selected: "beta",
      archivedRuns: [
        {
          run: "2026-02-01T00-00-00-000Z",
          startedAt: "2026-02-01T00:00:00.000Z",
          state: "complete",
          issues: 1,
          // A finished run — every wave is closed.
          status: {
            project: "beta",
            waves: [
              {
                index: 0,
                status: "completed",
                issues: [
                  { issueNumber: "101", status: "completed", name: "old work" },
                ],
              },
            ],
            parked: [],
          },
        },
      ],
    },
  );

  // The live run's closed wave still uses the toggle (chip + hidden card, id closed-wave-0).
  assert.match(html, /aria-controls="closed-wave-0"/);
  // The archived row's campaign pane renders its closed wave as a full, always-expanded
  // card — no second toggle bar and no duplicated id="closed-wave-0" that would hijack
  // the live card.
  const bodyStart = html.indexOf('class="archive-body"');
  const body = html.slice(bodyStart, html.indexOf("</li>", bodyStart));
  assert.doesNotMatch(body, /completed-wave-bar/);
  assert.doesNotMatch(body, /id="closed-wave-0"/);
  assert.match(
    body,
    /<section class="wave completed"><div class="wave-head"><h2 class="wave-label">Wave 1 — old work<\/h2><div class="wave-meta"><span class="wave-tally">1\/1<\/span><span class="wave-status completed">completed<\/span>/,
  );
  // Exactly one element carries the toggle id across the whole page (no duplicate ids).
  assert.equal(html.split('id="closed-wave-0"').length - 1, 1);
});
