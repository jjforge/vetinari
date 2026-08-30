import type { CampaignStatus, StatusIssue } from "./dashboard-model.ts";
import type { StructuredGraftClosure } from "./graft.ts";
import type { GraftRejection } from "./plan.ts";
import { DASHBOARD_PALETTE_CSS } from "./dashboard-assets.ts";
import { escapeHtml } from "./dashboard-render.ts";

/**
 * Is this issue still prunable? Only the unfinished remainder is — an unstarted
 * (future-wave) or parked issue is exactly what a prune would actually drop
 * (ADR 0005). A completed issue is banked and a running one is in flight, so
 * prune would do nothing useful there and gets no control (story 20).
 */
export const isPrunable = (issue: StatusIssue) => issue.membership !== "pruned" && (issue.status === "unstarted" || issue.status === "parked");

/**
 * Whether the campaign is parked on a red merged base — the combined-gate hold that
 * carries the `red-base` park reason (ADR 0019). The Redrive control below surfaces only
 * in that state, keyed on the reason rather than a distinct wave word.
 */
export const isRedBaseParked = (status: CampaignStatus) => status.waves.some((wave) => wave.issues.some((issue) => issue.reason === "red-base"));

/** Whether any issue is held on a merge conflict — the `conflict` park reason (ADR 0019),
 * a passed green pulled out of integration awaiting a manual resolve. Gates the note. */
export const hasConflict = (status: CampaignStatus) => status.waves.some((wave) => wave.issues.some((issue) => issue.reason === "conflict"));

/**
 * The red-base Redrive control (#171): when a campaign is paused on a red merged base,
 * a human fixes forward and taps Redrive, which POSTs `/redrive` for this project — the
 * aggregated dumb router (ADR 0002) shells `redrive` in the project's own root. Redrive
 * is non-destructive and project-scoped, so — unlike prune — it needs no preview/confirm
 * gate: a single POST. Emitted only on the interactive aggregated page (`prune`, the same
 * page option prune rides) and only while parked on a red base.
 */
export const renderRedriveControl = (status: CampaignStatus) =>
  `<section class="redrive-banner"><div class="redrive-banner-text"><strong>Campaign paused</strong> — a wave's merged base gated red, so its greens were kept and the campaign paused for a human. Fix forward, then redrive.</div><form method="post" action="/redrive" class="redrive-form"><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit" class="redrive-btn">Redrive campaign</button></form></section>`;

/**
 * The merge-conflict informational affordance (#171): a merge conflict held a passed
 * issue out of integration (ADR 0013). There is deliberately no conflict-release CLI to
 * shell, so this is a note only — it points the operator at resolve-then-redrive, with no
 * action route or button of its own. It points at the per-issue Redrive move (which now
 * renders in the sheet for a conflict park, #307) and the CLI — never a "Redrive control
 * above" that only renders on a red base, which for a conflict-only campaign was absent.
 */
export const renderConflictNote = () =>
  `<section class="conflict-note"><strong>Issue held on a merge conflict</strong> — a passed green was kept out of integration. Resolve the conflict, then redrive the campaign (open the held issue and Redrive, or <code>vetinari redrive</code> in the project root).</section>`;

/**
 * The Graft affordance (#168, reworked to mockup 1a in #202). Where prune prunes an
 * existing campaign issue (a per-chip control), graft *extends* the running campaign
 * with new issues named by explicit id. 1a places it as a quiet, always-visible input
 * on the campaign summary line rather than a banner: at rest a dim `graft issue ids`
 * placeholder and a greyed (disabled) button; the client enables the button once ids
 * are typed and, on submit, POSTs `/graft` for this project directly — the graft
 * confirms on the wave (the new wave card appears on the live refresh), with no
 * preview/confirm form. `graft` is variadic, so the field carries a set of ids
 * (whitespace/comma-split, matching the CLI). A whole-batch rejection and any per-id
 * validation surface inline in `[data-graft-error]`, never navigating away.
 *
 * Graft is offered only while the campaign is unsettled (design §11, #307). A settled
 * campaign (every wave closed) has nothing live-or-resumable to layer into (the graft
 * engine refuses, ADR 0014), so the affordance renders *nothing at all* — no input and no
 * notice. The earlier structural-disable "final wave" message (#202) is superseded: a
 * settled campaign simply carries no graft chrome.
 */
export const renderGraftInline = (status: CampaignStatus) =>
  isGraftable(status)
    ? `<form method="post" action="/graft" class="graft-inline" data-graft><input type="text" name="ids" class="graft-ids" placeholder="graft issue ids" autocomplete="off" aria-label="Graft issue ids" data-graft-ids /><input type="hidden" name="project" value="${escapeHtml(status.project)}" /><button type="submit" class="graft-btn" data-graft-submit disabled>graft</button><span class="graft-error" data-graft-error hidden></span></form>`
    : "";

/** Whether the campaign can still accept a graft: it is live-or-resumable (unsettled) while
 * any wave is not yet closed. A wholly-closed campaign is settled — nothing left to layer
 * into, which the graft engine refuses (ADR 0014) — so the affordance renders nothing (#307). */
const isGraftable = (status: CampaignStatus) => status.waves.some((wave) => wave.status !== "closed");

/**
 * The aggregated site's prune preview: it is a dumb router (ADR 0002) with no
 * project's `blockedBy` resolver, so it does not compute the closure itself — it
 * shows the closure the selected project's own `prune <issue> --dry-run` printed,
 * behind a confirm form (preview-then-confirm parity, story 19/23). Confirming
 * shells `prune` in that project's root. Serves as the no-JS prune fallback. Colour
 * comes from the one shared palette (Appendix A): the card carries the amber 3px left
 * edge every "needs you" card takes, and the confirm button the prune coral it acts.
 */
export const renderAggregatedPrunePreview = (project: string, target: string, previewText: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project)} — prune #${escapeHtml(target)}</title>
<style>
${DASHBOARD_PALETTE_CSS}
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: var(--color-body); color: var(--color-text); }
  h1 { letter-spacing: -0.035em; }
  .card { background: var(--color-box-body); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: 1rem 1.25rem; margin: 1rem 0; }
  pre { white-space: pre-wrap; margin: 0; }
  .actions { display: flex; gap: .75rem; align-items: center; }
  form { margin: 0; }
  button { padding: .5rem .9rem; border: 0; border-radius: var(--border-radius); cursor: pointer; font-weight: 700; }
  .confirm button { background: var(--color-red); color: var(--color-on-accent); }
  a.cancel { color: var(--color-text-light-2); text-decoration: none; padding: .5rem .9rem; }
</style>
</head>
<body>
<h1>Prune #${escapeHtml(target)} from ${escapeHtml(project)}?</h1>
<section class="card"><pre>${escapeHtml(previewText)}</pre></section>
<div class="actions">
<form method="post" action="/prune" class="confirm"><input type="hidden" name="taskId" value="${escapeHtml(target)}" /><input type="hidden" name="project" value="${escapeHtml(project)}" /><input type="hidden" name="confirm" value="1" /><button type="submit">✂️ Confirm prune</button></form>
<a class="cancel" href="/?project=${encodeURIComponent(project)}">Cancel</a>
</div>
</body>
</html>`;

/** A graft rejection reason (ADR 0014) as the operator reads it in the verdict list —
 * graft's own words, so the dashboard and the CLI name an offender the same way. */
const GRAFT_REASON_TEXT: Record<GraftRejection["reason"], string> = {
  unknown: "not found",
  closed: "closed on GitHub",
  "already-in-campaign": "already in the campaign",
};

/**
 * The aggregated site's graft rejection surface (option 1a): a whole-batch graft
 * (ADR 0014 — all-or-nothing) that found any offender grafts *nothing* and lands
 * here instead of navigating. It renders the batch as a per-id verdict list —
 * "would graft" for the clean ids, the reason per offender — under a "Nothing
 * grafted — fix these" header, carrying the typed ids so the summary-line input can
 * retain them. The client lifts `[data-graft-verdicts]` to show it inline beside the
 * input; served whole it is the no-JS fallback. Colour comes from the one shared palette
 * (Appendix A): the card carries the amber 3px left edge every "needs you" card takes (the
 * single edge rule — never the prune coral), and each offender's reason reads the rejection red.
 */
export const renderAggregatedGraftRejection = (project: string, closure: StructuredGraftClosure) => {
  const verdicts = closure.ids
    .map((id) => {
      const rejection = closure.rejected.find((r) => r.id === id);
      const verdict = rejection ? GRAFT_REASON_TEXT[rejection.reason] : "would graft";
      return `<li class="graft-verdict ${rejection ? "bad" : "ok"}">#${escapeHtml(id)} — ${escapeHtml(verdict)}</li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(project)} — graft rejected</title>
<style>
${DASHBOARD_PALETTE_CSS}
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; background: var(--color-body); color: var(--color-text); }
  h1 { letter-spacing: -0.035em; }
  .card { background: var(--color-box-body); border: 1px solid var(--color-secondary); border-left: 3px solid var(--color-yellow); border-radius: var(--border-radius-medium); padding: 1rem 1.25rem; margin: 1rem 0; }
  ul { margin: 0; padding-left: 1.2rem; }
  .graft-verdict.bad { color: var(--color-red); }
  a.cancel { color: var(--color-text-light-2); text-decoration: none; }
</style>
</head>
<body>
<h1>Nothing grafted — fix these</h1>
<section class="card" data-graft-rejection data-graft-ids="${escapeHtml(closure.ids.join(" "))}"><ul data-graft-verdicts>${verdicts}</ul></section>
<a class="cancel" href="/?project=${encodeURIComponent(project)}">Back to ${escapeHtml(project)}</a>
</body>
</html>`;
};

/**
 * The issue-detail sheet's markup — one definition rendered by both the campaign
 * page and the all-repos landing (previously hand-synced copies, #76). The foot holds
 * exactly the issue-level moves a state allows (design §11, #307, #325), each gated
 * client-side by the pure `issueMoves` rule off the fetched detail: the reply block (its
 * heading, the hoisted issue title + elapsed, the question or a fix-forward notice, the
 * options and answer box), a `Reply` submit (→ `/answer`), and the prune panel. Redrive is
 * a *whole-campaign* control on the project page (design §7), never an issue move, so it is
 * not in this foot. `prune` includes that panel: always on the landing (every parked row is
 * prunable), and on the campaign page only when its prune controls are enabled. Both move
 * buttons share the one `.sheet-btn` style.
 */
export const issueDetailSheetMarkup = (prune: boolean) =>
  `<div id="issue-detail" class="issue-detail" role="dialog" aria-modal="true" aria-live="polite" hidden><div class="issue-detail-sheet"><header class="issue-detail-header"><div class="issue-detail-head-main"><span class="issue-detail-status"><span class="dot"></span><span class="issue-detail-num"></span> <span class="issue-detail-statuslabel"></span></span><h2 class="issue-detail-title"></h2><p class="issue-detail-context"></p></div><button type="button" id="issue-detail-close" class="issue-detail-close" aria-label="Dismiss">&times;</button></header><div class="issue-detail-meta"><div class="meta-tile"><span class="meta-label">Turns</span><span class="meta-value" id="issue-detail-turns"></span></div><div class="meta-tile meta-tile-path" id="issue-detail-worktree-tile" hidden><span class="meta-label">Worktree</span><span class="meta-value meta-value-path" id="issue-detail-worktree"></span></div></div><h3 class="turn-log-heading">Agent turns</h3><ol class="turn-log" id="issue-detail-turnlog"></ol><div id="issue-detail-reply" class="issue-detail-reply" hidden><h3 class="reply-heading" id="reply-heading">PARKED — NEEDS YOUR ANSWER</h3><p class="reply-context"><span class="reply-title" id="reply-title"></span><span class="reply-elapsed" id="reply-elapsed"></span></p><p class="reply-question" id="reply-question"></p><div class="reply-options" id="reply-options"></div><form method="post" action="/answer" id="reply-form"><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><textarea name="text" id="reply-text" placeholder="Type your reply…"></textarea></form></div><div class="sheet-actions"><button type="submit" form="reply-form" id="reply-send" class="sheet-btn" hidden>Reply</button>${
    prune
      ? `<div id="prune-panel" class="prune-panel" hidden><button type="button" id="prune-start" class="sheet-btn prune-start">Prune</button><span id="prune-explainer" class="prune-explainer" hidden>Removes this issue and everything blocked by it from the running campaign; merged and mergeable work is kept.</span><form method="post" action="/prune" id="prune-confirm" class="prune-confirm" hidden><span class="prune-confirm-text"></span><input type="hidden" name="taskId" value="" /><input type="hidden" name="project" value="" /><input type="hidden" name="confirm" value="1" /><button type="submit" class="prune-confirm-btn">Confirm</button><button type="button" id="prune-cancel" class="prune-cancel">Cancel</button></form><span id="prune-note" class="prune-note"></span></div>`
      : ""
  }</div></div></div>`;

