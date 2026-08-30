// Tests for the issue-detail sheet and its moves
// (dashboard-render-issue.ts, via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { DASHBOARD_PALETTE_CSS, ISSUE_DETAIL_SHEET_STYLES, ISSUE_DETAIL_SHEET_SCRIPT } from "./dashboard-assets.ts";
import { issueDetailSheetMarkup, renderAggregatedGraftRejection, renderAggregatedPrunePreview, renderLandingShell, renderStatusPage } from "./status.ts";

test("the aggregated prune-preview and graft-rejection pages draw from the shared palette and carry the amber 3px edge, never a hand-authored hex (Appendix A, #317)", () => {
  const prunePage = renderAggregatedPrunePreview("demo", "42", "would drop #42, #43");
  const graftPage = renderAggregatedGraftRejection("demo", { ids: ["42"], placement: [], remaining: [], rejected: [{ id: "42", reason: "unknown" }] });
  for (const page of [prunePage, graftPage]) {
    // The one palette, not a local :root — so a token can never drift between pages.
    assert.ok(page.includes(DASHBOARD_PALETTE_CSS), "the page inlines the shared palette CSS");
    // Appendix A reserves the 3px left edge for amber ("needs you"); the prune coral never rides it.
    assert.match(page, /border-left: 3px solid var\(--color-yellow\)/);
    assert.doesNotMatch(page, /border-left: 3px solid #f79287/);
    // Every colour derives from the palette — outside the one palette block the page
    // hand-authors no hex (the shared palette is the sole home of raw colour).
    assert.doesNotMatch(page.replace(DASHBOARD_PALETTE_CSS, ""), /#[0-9a-fA-F]{6}\b/);
  }
});

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
  // renderMoves/closeSheet/prune wiring), included by both pages verbatim.
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
test("the issue sheet foot carries a reply-send button but no Redrive control — redrive is a campaign move now (#325)", () => {
  const markup = issueDetailSheetMarkup(true);
  // Redrive picks up the whole campaign (design §7), so it moved to the project page: the
  // sheet foot no longer carries a /redrive form or a Redrive button of its own.
  assert.doesNotMatch(markup, /action="\/redrive"/);
  assert.doesNotMatch(markup, /id="redrive-form"/);
  assert.doesNotMatch(markup, />Redrive</);
  // Reply submits the answer form; it shares the one move-button style with Prune.
  assert.match(markup, /<button type="submit" form="reply-form" id="reply-send" class="sheet-btn" hidden>Reply<\/button>/);
  assert.match(markup, /class="sheet-btn prune-start"/);
  // The reply panel hoists the issue title and the elapsed time above the answer box.
  assert.match(markup, /<span class="reply-title" id="reply-title">/);
  assert.match(markup, /<span class="reply-elapsed" id="reply-elapsed">/);
  // One button style is defined once in the sheet CSS.
  assert.match(ISSUE_DETAIL_SHEET_STYLES, /\.sheet-btn \{/);
  // The old bespoke reply-redrive button style is gone.
  assert.doesNotMatch(ISSUE_DETAIL_SHEET_STYLES, /\.reply-redrive \{/);
});

test("the issue sheet gates its moves through the single issueMoves rule, single-sourced into the script (#307, #325)", () => {
  // The sheet's reply/prune visibility is the one pure rule (dashboard-visual-state), shipped
  // into the browser via .toString() so the node test and the sheet run the same function —
  // a question/stall gets reply, a conflict/red-base/crash gets a fix-forward notice, and
  // every non-completed state prunes per the rule. No redrive: it is a campaign control now.
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("function issueMoves("));
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /issueMoves\(\{ status: d\.status, reason: d\.reason, archived: d\.archived \}\)/);
  assert.doesNotMatch(ISSUE_DETAIL_SHEET_SCRIPT, /redriveForm/);
  assert.doesNotMatch(ISSUE_DETAIL_SHEET_SCRIPT, /moves\.redrive/);
});

test("the issue sheet carries a fix-forward notice keyed by reason for a conflict/red-base/crash park (#307)", () => {
  // The redrive-only parks read a fix-forward instruction in the sheet notice, keyed by the
  // park reason (user-guide park reasons); a question/stall shows the answer box instead.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /const FIX_FORWARD = \{/);
  for (const reason of ["conflict", '"red-base"', "crash"]) {
    assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes(reason));
  }
});
