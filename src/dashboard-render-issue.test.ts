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
test("the issue sheet foot carries a /redrive form and a reply-send button, one button style across moves (#307)", () => {
  const markup = issueDetailSheetMarkup(true);
  // Redrive is its own move — a form POSTing /redrive (project-scoped, no taskId) in the foot.
  assert.match(
    markup,
    /<form method="post" action="\/redrive" id="redrive-form"[^>]*hidden><input type="hidden" name="project" value="" \/><button type="submit" class="sheet-btn">Redrive<\/button><\/form>/,
  );
  // Reply submits the answer form; it shares the one move-button style with Redrive and Prune.
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

test("the issue sheet gates its moves through the single issueMoves rule, single-sourced into the script (#307)", () => {
  // The sheet's reply/redrive/prune visibility is the one pure rule (dashboard-visual-state),
  // shipped into the browser via .toString() so the node test and the sheet run the same
  // function — a question/stall gets reply, a conflict/red-base/crash gets a fix-forward
  // notice + redrive, and every non-completed state prunes per the rule.
  assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes("function issueMoves("));
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /issueMoves\(\{ status: d\.status, reason: d\.reason, archived: d\.archived \}\)/);
});

test("the issue sheet carries a fix-forward notice keyed by reason for a conflict/red-base/crash park (#307)", () => {
  // The redrive-only parks read a fix-forward instruction in the sheet notice, keyed by the
  // park reason (user-guide park reasons); a question/stall shows the answer box instead.
  assert.match(ISSUE_DETAIL_SHEET_SCRIPT, /const FIX_FORWARD = \{/);
  for (const reason of ["conflict", '"red-base"', "crash"]) {
    assert.ok(ISSUE_DETAIL_SHEET_SCRIPT.includes(reason));
  }
});
