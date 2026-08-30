// Tests for the all-repos landing surface — cards, counters, the parked queue and the
// cross-repo event feed (dashboard-render-landing.ts, via the status barrel).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stateColor, counterColor, STATE_DOT_CSS, LIVE_TAIL_STYLES } from "./dashboard-assets.ts";
import { event, highlightJsonLine, renderLandingShell, feedFresh, feedKindLabel, feedProjects, feedRowMatches, feedView, followView } from "./status.ts";

test("renderLandingShell's card heading shows owner/name, but links and keys on the bare project", () => {
  const html = renderLandingShell(["alpha"]);
  // The card heading reads the card's owner/name, falling back to the bare key when absent.
  assert.match(html, /"card-project", p\.repo \?\? p\.project/);
  // Routing stays keyed on the bare project: the card href is the bare project key.
  assert.match(
    html,
    /card\.href = "\/\?project=" \+ encodeURIComponent\(p\.project\)/,
  );
});
test("renderLandingShell is single-column on mobile with 44px tap targets", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The cards collapse to one column on a phone.
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /\.cards \{ grid-template-columns: 1fr; \}/);
  // The two tappable controls — the project dropdown and each card — are at least 44px.
  assert.match(html, /\.project-picker select \{[^}]*min-height: 44px/);
  assert.match(html, /\.card \{[^}]*min-height: 44px/);
});
test("an idle running tally renders a solid blue dot with no pulse; genuinely-running dots still pulse (§5, #100)", () => {
  const html = renderLandingShell(["alpha"]);
  // A card's blue running-dots track work: a "0 running" tally is idle, so its dot is
  // solid blue but must not pulse (the pulse means active work). The idle rule is the
  // pure `tallyDotClass` (dashboard-visual-state.ts) — asserted directly there
  // (count=0 ⇒ "running idle") — single-sourced into this page via `.toString()` and
  // called on the tally dot, so the browser runs the very function the node test pins.
  assert.match(html, /function tallyDotClass/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // Motion: a .dot.running pulses by default (its blue is the shared stateColor-derived dot
  // rule); an idle (zero-count) one is stilled, keeping the blue but dropping the motion.
  assert.match(html, /\.dot\.running\.idle \{ animation: none; \}/);
  // The base running dot still pulses — a wave member with real running work is unaffected.
  assert.match(html, /\.dot\.running \{ animation: chip-pulse/);
});
test("renderLandingShell mounts the cross-project feed under the cards on every width", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The feed container sits after the cards and is client-rendered off /api/feed.
  assert.match(html, /id="feed"/);
  assert.match(html, /\/api\/feed/);
  assert.ok(
    html.indexOf('id="cards"') < html.indexOf('id="feed"'),
    "the feed renders after the cards",
  );
  // The event log now shows on a phone too (#125): the mobile block no longer
  // hides `.feed`, so iOS Safari at an iPhone width renders it under the cards.
  const mobileBlock = html.match(
    /@media \(max-width: 640px\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(mobileBlock, "the landing has a ≤640px mobile media block");
  assert.doesNotMatch(mobileBlock[0], /\.feed \{ display: none; \}/);
});
test("renderLandingShell mounts the host-log gear + pane on the host view (#180)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The host-log surface lives on the all-repos landing/host view.
  assert.match(html, /data-host-log-gear/);
  assert.match(html, /data-host-log-panel/);
  // Its initial rows come from the no-daemon host-log reader endpoint.
  assert.match(html, /\/api\/host-log/);
});
test("renderLandingShell parked counter expands a cross-repo parked queue in place", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // The parked counter is an interactive toggle, unlike the other three counters —
  // a button controlling the queue panel, inert (disabled) until the client learns
  // there is at least one parked question.
  assert.match(
    html,
    /<button[^>]*class="counter counter-toggle"[^>]*data-counter="parked"[^>]*disabled[^>]*aria-controls="parked-queue"/,
  );
  // The queue panel sits between the counters and the cards, so expanding it pushes
  // the cards down while keeping them visible; it starts hidden.
  assert.match(html, /<section id="parked-queue"[^>]*hidden/);
  assert.ok(
    html.indexOf('id="parked-queue"') < html.indexOf('id="cards"'),
    "parked queue renders above the cards",
  );
  // The client renders one row per parked question, oldest first from data.parked,
  // each opening that repo's issue detail, showing repo, issue number, the full
  // question and how long it has waited.
  assert.match(html, /data\.parked/);
  assert.match(html, /\/\?project=/);
  assert.match(html, /fmtWaited/);
  // The counter is inert (disabled, no arrow/cursor) when there are no parked
  // questions, and becomes a working toggle when there are.
  assert.match(html, /\.counter-toggle:disabled/);
  assert.match(html, /aria-expanded/);
  // The parked rows collapse to a readable stack on a phone.
  assert.match(html, /\.parked-row/);
  // `.parked-queue { display: grid }` otherwise defeats the UA `[hidden]` rule, so
  // the collapse rule must be restored explicitly or clicking the counter flips the
  // caret but never hides the panel (#71).
  assert.match(html, /\.parked-queue\[hidden\] \{ display: none;? \}/);
});
test("renderLandingShell opens a parked-queue row's issue detail inline, not by navigating (#74)", () => {
  const html = renderLandingShell(["alpha"]);
  // The landing now hosts the issue-detail sheet (the same one the campaign page has).
  assert.match(html, /<div id="issue-detail" class="issue-detail"[^>]*hidden>/);
  assert.match(html, /id="reply-send"/);
  assert.match(html, /id="redrive-form"/);
  assert.match(html, /id="prune-panel"/);
  // openIssue is defined here, and a parked row opens it in place — the click is
  // intercepted so the row never does the full navigation to the campaign page.
  assert.match(html, /const openIssue = async \(project, issue, prunable, run\)/);
  assert.match(
    html,
    /row\.addEventListener\("click", \(event\) => \{ event\.preventDefault\(\); openIssue\(p\.project, p\.issueNumber, true\); \}\)/,
  );
  // The sheet's collapse rules are present so a flex display can't defeat [hidden].
  assert.match(html, /\.issue-detail\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.prune-panel\[hidden\] \{ display: none; \}/);
  // The status dot colours are scoped to .dot (the shared stateColor-derived rules) so they
  // don't tint the run-state pills.
  assert.ok(html.includes(STATE_DOT_CSS));
});
test("renderLandingShell's feed renders humanized rows in the shared .lv-row component, dot by event state (#216)", () => {
  const html = renderLandingShell(["alpha"]);
  // The feed's humanized branch builds the shared .lv-row from each row's server-attached parts,
  // so the feed reads as the same component as the tail/host/archive — no bespoke .feed-kind label.
  assert.match(html, /humanizedRow\(e\.humanized, document\)/);
  assert.match(html, /function humanizedRow/);
  // The multiline-collapse split (#217) ships alongside, since humanizedRow calls it client-side.
  assert.match(html, /function splitOverflow/);
  assert.ok(!html.includes("feed-kind") && !html.includes("feedKindClass"), "the old per-kind .feed-kind label is gone");
  // The shared .lv-dot state palette (generated from LOG_DOT_STATE_COLOR) paints the row dots.
  assert.match(html, /\.lv-dot\.merged \{ background:/);
  assert.match(html, /\.lv-dot\.failure \{ background:/);
});
test("the shared .lv-row paints the 2b least→most emphasis ramp: time muted · actor mono+subdued · message prominent (#221)", () => {
  const html = renderLandingShell(["alpha"]);
  // Least important — the time reads in the most muted grey (--color-dim).
  assert.match(html, /\.lv-t \{[^}]*color: var\(--color-dim\)/);
  // Mid — the actor is distinct but subdued: a mono handle at mid brightness (--color-text-light-2).
  assert.match(html, /\.lv-lead \{[^}]*font-family: ui-monospace/);
  assert.match(html, /\.lv-lead \{[^}]*color: var\(--color-text-light-2\)/);
  // Most important — the message itself is the brightest, most readable element (--color-text).
  assert.match(html, /\.lv-msg \{[^}]*color: var\(--color-text\)/);
});
test("the shared .lv-row styles the multiline-collapse chevron and overflow block (#217)", () => {
  const html = renderLandingShell(["alpha"]);
  // The bare chevron is a dim, clickable affordance that brightens on hover (palette tokens, §1).
  assert.match(html, /\.lv-chev \{[^}]*cursor: pointer/);
  assert.match(html, /\.lv-chev:hover \{[^}]*color:/);
  // The overflow block sits in the message column (grid-column 3), mono/raw and copy-pasteable,
  // and is display:none until the chevron toggles its [hidden] off.
  assert.match(html, /\.lv-overflow \{[^}]*grid-column: 3/);
  assert.match(html, /\.lv-overflow\[hidden\] \{ display: none; \}/);
});
test("renderLandingShell's feed is a scrollable live-tail-style pane, not a show-older list (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The empty window reads the feed's own copy, not the live-only "No activity yet".
  assert.match(html, /No activity in the last 48 hours\./);
  assert.ok(!html.includes("No activity yet."), "the live-only empty state is gone from the feed");
  // The old cap-and-reveal model is gone: the feed now renders into a scroll pane bounded by the
  // shared follow/pause render cap, so there is no 20-row cap and no archive-show-older control.
  assert.ok(!html.includes("const FEED_CAP = 20;"), "the show-older cap is gone from the feed");
  assert.doesNotMatch(html, /"feed-rows"[^;]*archive-show-older/);
  assert.ok(!html.includes("older event"), "the show-older-events control is gone");
  // The feed body is its own scroll pane keeping prose typography (its rows differ from the
  // tail's mono raw lines), styled alongside the shared chrome rather than reusing .tail-body.
  assert.match(html, /\.feed-body \{[^}]*overflow-y: auto/);
});
test("renderLandingShell's feed adopts the live-tail pane chrome via shared CSS (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The event-log pane draws the live tail's shared chrome (container, header, control strip,
  // backlog, footer) from LIVE_TAIL_STYLES rather than a second ad-hoc restyle.
  assert.match(html, /\.live-tail \{/);
  assert.match(html, /\.tail-head \{/);
  assert.match(html, /\.tail-controls \{/);
  // The feed section is a .live-tail card carrying its own hook, with the shared header chrome.
  assert.match(html, /<section id="feed" class="live-tail feed" data-feed/);
  assert.match(html, /class="tail-head"[\s\S]*?data-feed-dot/);
  // The event-log title still reads "Event log · all repos"; the old "Recent activity" heading
  // and the old bespoke <h2> feed header are gone.
  assert.match(html, /Event log · all repos/);
  assert.ok(!html.includes("Recent activity"), "the old heading is gone");
  assert.doesNotMatch(html, /class="feed"[^>]*>\s*<h2/);
});
test("renderLandingShell's feed is humanized-only: no Humanized/Raw toggle, no raw tokeniser (#221)", () => {
  const html = renderLandingShell(["alpha"]);
  // #221: the feed always renders its narrated rows — the Humanized/Raw toggle is gone entirely,
  // and with it the per-view mode memory and the raw NDJSON tokeniser it used.
  assert.doesNotMatch(html, /data-feed-mode/);
  assert.doesNotMatch(html, /vetinari:feed-mode/);
  assert.doesNotMatch(html, /highlightJsonLine\(e\.raw\)/);
});
test("renderLandingShell's feed Download JSON emits the filtered underlying NDJSON (#203)", () => {
  const html = renderLandingShell(["alpha"]);
  // Download JSON emits the currently-filtered rows' raw event NDJSON (e.raw joined by newlines) as
  // a .jsonl blob — the raw bytes, uncapped by the render window — not the old narrated .txt export.
  assert.match(html, /download = "event-log\.jsonl"/);
  assert.match(html, /application\/x-ndjson/);
  assert.match(html, /\.map\(\(e\) => e\.raw\)/);
  assert.ok(!html.includes("event-log.txt"), "the old narrated-text export is gone");
});
test("renderLandingShell's feed carries the live-tail controls wired to the shared view-model (#196)", () => {
  const html = renderLandingShell(["alpha"]);
  // The control strip: case-insensitive filter, follow/pause, download-visible (the mockup 1a
  // chrome drops the Clear control — the download preserves the data, #216).
  for (const hook of ["data-feed-filter", "data-feed-play", "data-feed-save", "data-feed-backlog"]) {
    assert.ok(html.includes(hook), `feed control ${hook} is present`);
  }
  // The client drives follow/pause/backlog through the shared, tested view-model and dedups the
  // re-fetched window through feedFresh — the same tested logic as the tail, not a parallel copy.
  assert.match(html, /function followView/);
  assert.match(html, /function feedFresh/);
  assert.match(html, /function feedRowMatches/);
  assert.match(html, /function tailAppend/);
  // Follow/pause reads through the shared view-model — now via feedView, which composes the
  // project + text predicate over followView (#220); the backlog points up (newest-on-top, #195).
  assert.match(html, /feedView\(\{ buffer: feedBuffer/);
  assert.match(html, /"↑ " \+ view\.backlog \+ " new event"/);
  // Filter drives feedRowMatches over the (kind, text) pair.
  assert.match(html, /feedRowMatches\(/);
  // Download JSON exports the visible rows' underlying NDJSON (the Raw-toggle counterpart, #203).
  assert.match(html, /download = "event-log/);
});
test("feedKindLabel folds an orchestrator event kind to the feed's clean lowercase label — the term the filter still matches on (#196)", () => {
  // The label is the clean namespace.verb remap; an unmapped kind falls through to its raw value.
  // The feed's humanized rows now render in the shared .lv-row (#216), so the label no longer
  // shows as a per-row chip — it survives only as the term feedRowMatches lets the filter match.
  assert.equal(feedKindLabel("green"), "issue.merged");
  assert.equal(feedKindLabel("prune"), "issue.pruned");
  // The map speaks the §2.1 event vocabulary the reader normalizes to — waves are
  // `wave-start`/`wave-done`, a red-base hold is `campaign-parked` — never the retired
  // pre-§2.1 event names (folded to §2.1 on the read path before they reach here).
  assert.equal(feedKindLabel("wave-start"), "wave.started");
  assert.equal(feedKindLabel("wave-done"), "wave.closed");
  assert.equal(feedKindLabel("campaign-parked"), "campaign.parked");
  assert.equal(feedKindLabel("campaign-failed"), "campaign.failed");
  assert.equal(feedKindLabel("some-unmapped-kind"), "some-unmapped-kind");
});
test("feedRowMatches filters a feed row case-insensitively over its kind label + narrated text (#196)", () => {
  const row = { kind: "green", text: "acme — #101 merged" };
  // An empty / whitespace query matches everything (the filter is cleared).
  assert.equal(feedRowMatches(row, ""), true);
  assert.equal(feedRowMatches(row, "   "), true);
  // The prose text matches, case-insensitively.
  assert.equal(feedRowMatches(row, "ACME"), true);
  assert.equal(feedRowMatches(row, "#101"), true);
  // The remapped kind label matches — the operator sees "issue.merged", not the raw "green".
  assert.equal(feedRowMatches(row, "issue.merged"), true);
  assert.equal(feedRowMatches(row, "merged"), true);
  // A miss on both label and text hides the row.
  assert.equal(feedRowMatches(row, "zzz"), false);
});
test("feedFresh dedups a re-fetched newest-first window, returning only genuinely new rows oldest-first (#196)", () => {
  // The server returns the whole window newest-first each fetch; the client accumulates.
  const fe = (ts: string, text: string) => ({ project: "acme", ts, kind: "green", text });
  const window1 = [fe("2026-08-28T00:00:02Z", "c"), fe("2026-08-28T00:00:01Z", "b"), fe("2026-08-28T00:00:00Z", "a")];
  const first = feedFresh(window1, {});
  // Fresh is oldest-first so it appends to the oldest→newest buffer in chronological order.
  assert.deepEqual(first.fresh.map((r) => r.text), ["a", "b", "c"]);

  // Next fetch re-sends the window plus one newer row; only the new row is fresh.
  const window2 = [fe("2026-08-28T00:00:03Z", "d"), ...window1];
  const second = feedFresh(window2, first.seen);
  assert.deepEqual(second.fresh.map((r) => r.text), ["d"]);

  // Two rows with the same ts but different text are distinct events, both fresh.
  const window3 = [fe("2026-08-28T00:00:03Z", "d2"), ...window2];
  const third = feedFresh(window3, second.seen);
  assert.deepEqual(third.fresh.map((r) => r.text), ["d2"]);
});
test("the feed drives the shared followView with its (kind, text) filter — same view-model as the tail (#196)", () => {
  // The feed client accumulates an oldest→newest buffer and drives followView with feedRowMatches,
  // exactly as the tail drives it with its own predicate. Rows shaped like feed entries.
  const fe = (ts: string, kind: string, text: string) => ({ project: "acme", ts, kind, text });
  const buffer = [fe("t0", "turn", "acme — #1 took a turn"), fe("t1", "green", "acme — #2 merged"), fe("t2", "parked", "acme — #3 parked")];

  // Following, no filter: newest-first, backlog zero, following true.
  const all = followView({ buffer, mark: 0, live: true, cap: 160, match: (e) => feedRowMatches(e, "") });
  assert.deepEqual(all.rows.map((r) => r.text), ["acme — #3 parked", "acme — #2 merged", "acme — #1 took a turn"]);
  assert.equal(all.backlog, 0);
  assert.equal(all.following, true);

  // The filter narrows to rows whose kind label or prose text matches — "merged" hits both the
  // remapped label (issue.merged) and the prose of the green row.
  const filtered = followView({ buffer, mark: 0, live: true, cap: 160, match: (e) => feedRowMatches(e, "merged") });
  assert.deepEqual(filtered.rows.map((r) => r.text), ["acme — #2 merged"]);

  // Paused at mark=2 freezes the first two; the parked row that arrived after counts as backlog.
  const paused = followView({ buffer, mark: 2, live: false, cap: 160, match: (e) => feedRowMatches(e, "") });
  assert.deepEqual(paused.rows.map((r) => r.text), ["acme — #2 merged", "acme — #1 took a turn"]);
  assert.equal(paused.backlog, 1);
  assert.equal(paused.following, false);
});
test("renderLandingShell's feed carries the project dropdown wired to the shared feedView, labelled by owner/name (#220)", () => {
  const html = renderLandingShell([{ project: "alpha", repo: "acme/alpha", runState: "idle" }]);
  // The controls strip gains a project dropdown beside the free-text filter, defaulting to "all repos".
  for (const hook of ["data-feed-project-dd", "data-feed-project-trigger", "data-feed-project-menu", "data-feed-project-label"]) {
    assert.ok(html.includes(hook), `feed project-dropdown hook ${hook} is present`);
  }
  assert.match(html, /data-feed-project-label[^>]*>all repos</);
  // The composed project+text filtering drives through the shared, tested feedView, and the option
  // set is derived from the buffer by the tested feedProjects — the same functions the node test runs.
  assert.match(html, /function feedView/);
  assert.match(html, /function feedProjects/);
  assert.match(html, /feedView\(\{ buffer: feedBuffer/);
  // The options are labelled by owner/name (the repo switcher's label), keyed on the project — so
  // the repo map for the registered projects is serialised into the page for the menu to read.
  assert.match(html, /acme\/alpha/);
});
test("feedView composes the project dropdown and the (kind, text) filter as AND over the shared followView (#220)", () => {
  // The event-log feed's body view-model, the sibling of tailView: it swaps the tail's issue
  // criterion for a project one and folds it, with the substring filter, into one match predicate
  // the shared followView applies to both the visible set and the backlog count.
  const fe = (project: string, ts: string, kind: string, text: string) => ({ project, ts, kind, text });
  const buffer = [
    fe("acme", "t0", "turn", "acme — #1 took a turn"),
    fe("beta", "t1", "green", "beta — #2 merged"),
    fe("acme", "t2", "green", "acme — #3 merged"),
  ];

  // Both cleared: everything, newest-first (the default all-repos, no-text state).
  const both = feedView({ buffer, mark: 0, live: true, project: "", query: "", cap: 160 });
  assert.deepEqual(both.rows.map((r) => r.text), ["acme — #3 merged", "beta — #2 merged", "acme — #1 took a turn"]);

  // Project only narrows to that project's rows; the text filter is widened (cleared).
  const byProject = feedView({ buffer, mark: 0, live: true, project: "acme", query: "", cap: 160 });
  assert.deepEqual(byProject.rows.map((r) => r.text), ["acme — #3 merged", "acme — #1 took a turn"]);

  // Text only narrows by substring across every project; the project is widened (cleared).
  const byText = feedView({ buffer, mark: 0, live: true, project: "", query: "merged", cap: 160 });
  assert.deepEqual(byText.rows.map((r) => r.text), ["acme — #3 merged", "beta — #2 merged"]);

  // Both set compose as AND — a chosen project AND the text substring.
  const both2 = feedView({ buffer, mark: 0, live: true, project: "acme", query: "merged", cap: 160 });
  assert.deepEqual(both2.rows.map((r) => r.text), ["acme — #3 merged"]);

  // The composed predicate reaches the backlog count too: paused at mark=2, the later acme green
  // is backlog only while it matches both criteria; a non-matching project would not count it.
  const paused = feedView({ buffer, mark: 2, live: false, project: "acme", query: "", cap: 160 });
  assert.equal(paused.backlog, 1);
  const pausedOther = feedView({ buffer, mark: 2, live: false, project: "beta", query: "", cap: 160 });
  assert.equal(pausedOther.backlog, 0);
});
test("feedProjects lists the distinct projects present in the buffer, sorted, updating as new projects arrive (#220)", () => {
  // The dropdown's options are sourced from the buffer (no dead options), mirroring how the live
  // tail's agent dropdown tracks running issues — so a project with nothing in the window is not
  // offered, and a new project's first event grows the list.
  const fe = (project: string, text: string) => ({ project, ts: "t", kind: "turn", text });
  assert.deepEqual(feedProjects([]), []);
  const buffer = [fe("beta", "b1"), fe("acme", "a1"), fe("beta", "b2")];
  // Distinct and sorted for a stable menu, regardless of arrival order or repeats.
  assert.deepEqual(feedProjects(buffer), ["acme", "beta"]);
  // A new project's event grows the option set.
  assert.deepEqual(feedProjects([...buffer, fe("gamma", "g1")]), ["acme", "beta", "gamma"]);
});
test("the card progress-bar selector is scoped so no bare `.progress {` rule can leak onto a status word (#85)", () => {
  const html = renderLandingShell(["alpha"]);
  // A bare `.progress {` rule (the card progress bar) would match any element carrying the
  // `progress` word as a modifier, applying height/background/overflow. Scope the bar's
  // selector so no bare `.progress {` exists.
  assert.doesNotMatch(html, /(?<![-\w])\.progress \{/);
});
test("renderLandingShell colours each project card's highlight by run state (#75)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card element carries its run-state class...
  assert.match(html, /el\("a", "card " \+ p\.runState\)/);
  // ...and per-state border-top-color rules tint the highlight to match the pill. The colour
  // for each state is `stateColor` (asserted by value there); one structural check confirms the
  // rendered output carries those reducer-derived rules verbatim, proven once not per state.
  const cardEdgeCss = ["running", "parked", "failure", "completed", "idle"]
    .map((s) => `.card.${s} { border-top-color: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(cardEdgeCss), "landing carries the stateColor-derived card edges");
});
test("renderLandingShell draws each card a run-state-coloured progress bar sized by percent merged (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The card renders a progress track with a fill sized to percentMerged and classed by run state,
  // sitting beneath the wave/percent meta line.
  assert.match(html, /el\("div", "progress-fill " \+ p\.runState\)/);
  assert.match(html, /\.style\.width = p\.percentMerged \+ "%"/);
  // The fill is coloured by run state (idle stays grey via the base rule). Each state's colour
  // is `stateColor` (asserted by value there); one structural check confirms the rendered output
  // carries those fill rules verbatim, proven once rather than re-pinned per state.
  const fillCss = ["running", "parked", "completed"]
    .map((s) => `.progress-fill.${s} { background: ${stateColor(s)}; }`)
    .join(" ");
  assert.ok(html.includes(fillCss), "landing carries the stateColor-derived progress fills");
});
test("renderLandingShell renders the card tally as status-dot chips, not plain text (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // The tally builds one pill chip per bucket, each with a status dot scoped to .dot,
  // whose class comes from the shared `tallyDotClass` reducer (dashboard-visual-state.ts).
  assert.match(html, /el\("span", "tally-chip"\)/);
  assert.match(html, /"dot " \+ tallyDotClass\(\{ kind: bucket, count \}\)/);
  // The chip treatment matches the campaign page's chips — a bordered pill.
  assert.match(html, /\.tally-chip \{[^}]*border-radius: 999px/);
  // The tally dots reuse the shared stateColor-derived .dot colours (queued the dim unstarted
  // grey, running/parked their status colours) — asserted by value against stateColor.
  assert.ok(html.includes(STATE_DOT_CSS));
  // The old plain-text tally string is gone.
  assert.doesNotMatch(html, /" running · " \+ p\.tally\.parked/);
});
test("renderLandingShell colours the counter values and highlights the parked counter when it has questions (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter value reads in its status colour — working blue, parked amber, merged-today
  // green; queued stays neutral. The value→colour mapping is owned by `counterColor` (asserted
  // there); here one structural check confirms the rendered output carries that reducer's CSS.
  const counterValueCss = ["working", "parked", "mergedToday"]
    .map((k) => `[data-counter="${k}"] .counter-value { color: ${counterColor(k)}; }`)
    .join(" ");
  assert.ok(
    html.includes(counterValueCss),
    "landing carries the counterColor-derived counter-value rules",
  );
  // The parked counter carries a gold border only while it is actionable — enabled, i.e. parked > 0.
  assert.match(
    html,
    /\.counter-toggle\[data-counter="parked"\]:not\(:disabled\) \{[^}]*border-color: var\(--color-yellow\)/,
  );
});
test("renderLandingShell gives each counter a payload-derived sublabel (#80)", () => {
  const html = renderLandingShell(["alpha"]);
  // Each counter carries a sublabel element the client fills from the payload.
  assert.match(html, /data-counter-sub="working"/);
  assert.match(html, /data-counter-sub="parked"/);
  assert.match(html, /data-counter-sub="queued"/);
  assert.match(html, /data-counter-sub="mergedToday"/);
  // working counts repos with a running agent; parked reads the oldest parked question's wait;
  // queued and merged-today are fixed context lines.
  assert.match(html, /across " \+ /);
  assert.match(html, /oldest " \+ fmtWaited/);
  assert.match(html, /in later waves/);
  // The counter is titled "Merged today" (the metric); its sublabel states the
  // scope — the all-repos aggregate — matching the "across N repos" sibling (#104).
  assert.match(html, /All repos/);
  assert.doesNotMatch(html, /issues merged/);
  assert.doesNotMatch(html, /issues closed/);
});
test("renderLandingShell stacks each counter label on top of an inline value + sublabel row (#94)", () => {
  const html = renderLandingShell(["alpha"]);
  // POC layout: the uppercase label sits on top, then the value and sublabel share
  // one inline row (a .counter-line), rather than value → label → sublabel stacked.
  for (const key of ["working", "parked", "queued", "mergedToday"]) {
    const counter = html.match(
      new RegExp(`data-counter="${key}"[^>]*>(.*?)counter-sub`),
    );
    assert.ok(counter, `counter ${key} present`);
    const body = counter[1];
    // Label markup comes before the value markup for this counter.
    assert.ok(
      body.indexOf("counter-label") < body.indexOf("counter-value"),
      `counter ${key} renders label above value`,
    );
    // The value and sublabel are wrapped together in the inline row.
    assert.ok(
      body.includes("counter-line"),
      `counter ${key} wraps value + sub in an inline row`,
    );
  }
  // The inline row lays value + sublabel out on one baseline-aligned line.
  assert.match(
    html,
    /\.counter-line \{[^}]*display: flex[^}]*align-items: baseline/,
  );
});
test("renderLandingShell wires live SSE updates and an updated-ago readout, no page-level pause (#210)", () => {
  const html = renderLandingShell(["alpha", "beta"]);
  // Subscribes to the one-way SSE stream and re-reads the landing as events land.
  assert.match(html, /new EventSource\("\/api\/events"\)/);
  // A live indicator and an "updated Ns ago" readout live in the toolbar header.
  assert.match(html, /data-live-state/);
  assert.match(html, /data-updated/);
  // The page-level pause is gone (#210): no pause button, no paused-state page-level freeze.
  assert.doesNotMatch(html, /id="pause"/);
  assert.doesNotMatch(html, /let paused = false/);
});
test("renderLandingShell's repo dropdown is the All-repos heading, replacing the h1 + native select", () => {
  const html = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate scope reads "All repos" as the trigger label — the heading itself.
  assert.match(html, /<span class="repo-label">All repos<\/span>/);
  assert.match(
    html,
    /<button type="button" class="repo-trigger"[^>]*aria-haspopup="listbox"/,
  );
  // The old separate <h1>All repos</h1> title is gone — the trigger is the heading now.
  assert.doesNotMatch(html, /<h1>All repos<\/h1>/);
});
test("the repo dropdown's All-repos row uses the teal accent dot and the repo count as its note", () => {
  const landing = renderLandingShell([
    { project: "jjforge/tidepool", runState: "running" },
    { project: "acme/tidepool", runState: "idle" },
  ]);

  // The aggregate has no run state of its own: its dot is the teal accent (`all`), its
  // note the repo count, and on the landing it is the selected (current) scope.
  assert.match(
    landing,
    /<li class="repo-option selected" role="option" aria-selected="true" data-project="" tabindex="-1"><span class="repo-dot all" aria-hidden="true"><\/span><span class="repo-optlabel">All repos<\/span><span class="repo-note">2 repos<\/span><\/li>/,
  );
  // The teal accent is the product accent, so the `all` dot reads --color-primary.
  assert.match(
    landing,
    /\.repo-dot\.all \{ background: var\(--color-primary\); \}/,
  );
});
