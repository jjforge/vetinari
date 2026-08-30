// Tests for the issue-detail sheet and its moves
// (dashboard-render-issue.ts, via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { ISSUE_DETAIL_SHEET_STYLES, ISSUE_DETAIL_SHEET_SCRIPT } from "./dashboard-assets.ts";
import { issueDetailSheetMarkup, renderLandingShell, renderStatusPage } from "./status.ts";

test("the issue-detail sheet markup, CSS, and script are defined once and shared by both pages (#76)", () => {
  const landing = renderLandingShell(["alpha", "beta"]);
  // The campaign page renders the sheet with its prune panel when prune is on and
  // without it otherwise; the landing always hosts the prune-enabled sheet.
  const campaignPrune = renderStatusPage(
    { project: "beta", waves: [], parked: [] },
    { prune: true },
  );
  const campaignPlain = renderStatusPage({
    project: "beta",
    waves: [],
    parked: [],
  });

  // Markup: one helper, rendered verbatim by both pages. The landing and the
  // prune-enabled campaign page share the prune-panel variant; a plain campaign
  // page shares the no-prune variant.
  assert.ok(landing.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPrune.includes(issueDetailSheetMarkup(true)));
  assert.ok(campaignPlain.includes(issueDetailSheetMarkup(false)));
  // The no-prune variant has no prune panel; the prune variant does.
  assert.ok(!issueDetailSheetMarkup(false).includes("prune-panel"));
  assert.ok(issueDetailSheetMarkup(true).includes('id="prune-panel"'));

  // CSS: one definition of the sheet styles, included by both pages verbatim.
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".issue-detail-sheet {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".turn-log {"));
  assert.ok(ISSUE_DETAIL_SHEET_STYLES.includes(".sheet-actions {"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_STYLES));
  assert.ok(campaignPrune.includes(ISSUE_DETAIL_SHEET_STYLES));

  // Script: one definition of the sheet behaviour (openIssue/renderDetail/
  // renderReply/closeSheet/prune wiring), included by both pages verbatim.
  assert.ok(
    ISSUE_DETAIL_SHEET_SCRIPT.includes(
      "const openIssue = async (project, issue, prunable, run)",
    ),
  );
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("const closeSheet = () =>"));
  assert.ok(landing.includes(ISSUE_DETAIL_SHEET_SCRIPT));
  assert.ok(campaignPrune.includes(ISSUE_DETAIL_SHEET_SCRIPT));

  // The hand-sync note is gone now that the sheet has a single source.
  assert.ok(!landing.includes("#76"));
  assert.ok(!landing.includes("kept in sync"));
});
test("the issue-detail sheet offers a reply/redrive only for a question park, not a conflict/red-base/stall (ADR 0019)", () => {
  // A held issue reads `parked` whatever its reason, so the reply block must gate on the
  // reason — a merge conflict / red base / stall is resolved through the campaign-level
  // affordance, not a per-issue answer. The shipped sheet script keys the reply block off
  // `d.reason` (a legacy park with no reason still reads as a question).
  assert.match(
    ISSUE_DETAIL_SHEET_SCRIPT,
    /const parked = d\.status === "parked" && !d\.archived && \(!d\.reason \|\| d\.reason === "question"\)/,
  );
});
