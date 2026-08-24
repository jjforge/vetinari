# Carve control — trigger a carve from Telegram or the dashboard

Issue: [#11](https://github.com/jjforge/vetinari/issues/11) · Source: [ADR 0005](../adr/0005-carve-is-an-event-that-prunes-the-running-campaign.md), [ADR 0002](../adr/0002-gateway-is-a-dumb-router-projects-own-comms.md), [ADR 0001](../adr/0001-vetinari-committed-vs-local-split.md) · Glossary: [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

When I am watching a campaign run from my phone or the dashboard and I spot a task
that should drop out — and take everything blocked by it with it — I cannot act.
[[carve]] is CLI-only today, and worse, the CLI form is not even "edit the campaign
that is running": `carve <issue> <batch…>` makes me hand it the whole plan on the
command line and then launches a *fresh* reduced campaign. There is no way to reach
into the campaign that is actually running and prune a subtree from its remaining
[[wave]]s. So the moment I am away from a terminal — exactly when I am most likely to
be watching from Telegram or the dashboard — a task I know is bad keeps its slot and
drags its dependents along behind it.

## Solution

Carve becomes something you can do to a **running** campaign, from a terminal, from
Telegram, or from the dashboard, without ever retyping the plan. Against a running
campaign, carve appends a **carve event** to the project's event log; the `campaign`
loop reconstructs its remaining waves from that log at each wave boundary and honors
the carve there (ADR 0005). The in-flight wave finishes as-is; only future waves
shrink. Carve **prunes the unfinished remainder without discarding banked work**: of
the removed closure, anything already merged or mergeable is kept, and only the
parked or not-yet-started issues actually leave the plan.

The inbound side goes through the [[gateway]], which already is the single Telegram
consumer and already recognizes a `/status` command. Carve joins that command family:
a `carve 640` message resolves to the right [[consuming-project]] by the bot/chat it
arrived on, previews the closure ("this will drop 640, 641, 655"), and executes only
on a confirming reply. The dashboard grows a carve control beside its existing
parked-question answer control, with the same preview-then-confirm flow. Because the
plan is always reconstructed from the event log, neither entry point ever asks me for
wave arguments — I just name the issue.

## User Stories

1. As a maintainer watching a running campaign from Telegram, I want to carve an issue by sending `carve 640`, so that I can drop a bad task and its dependents without a terminal.
2. As a maintainer watching from the dashboard, I want a carve control on an issue, so that I can drop it and its dependents from the same page I monitor from.
3. As a maintainer, I want carve to prune the *running* campaign's remaining waves, so that the campaign I am already watching adjusts rather than my having to stop and relaunch one.
4. As a maintainer, I want the in-flight wave to finish as-is and only future waves to shrink, so that a carve never tears down work already running.
5. As a maintainer, I want carve to never discard banked work, so that an issue in the removed closure that already merged stays merged and one that is green still merges if appropriate.
6. As a maintainer, I want only the parked and not-yet-started issues in the closure to actually leave the plan, so that carve prunes the unfinished remainder and nothing already earned.
7. As a maintainer, I want a merged or green carve target to still carve its unfinished dependents, so that my deliberate "remove this subtree" decision is honored even when the target itself succeeded.
8. As a maintainer, I want carve to clear the parked records of removed issues, so that the gateway stops asking me questions about tasks I have dropped.
9. As a maintainer, I want to name only the issue (`carve 640`) and never the wave plan, so that I can carve from a phone without retyping the campaign.
10. As a maintainer, I want the gateway to figure out which project I mean from the bot/chat my message arrived on, so that carve targets the right project with no extra typing in the common case.
11. As a maintainer running several projects on one shared bot, I want carve to reject with a list when more than one of them has a running campaign, so that I disambiguate with `carve <project> 640` rather than carving the wrong project.
12. As a maintainer, I want carve to reject cleanly when no campaign is running, so that a `carve 640` with nothing to prune tells me so instead of failing obscurely.
13. As a maintainer, I want a preview of exactly which issues a carve will drop before it happens, so that I do not fat-finger away a larger subtree than I realized.
14. As a maintainer, I want to confirm a carve by replying to the preview message, so that the confirmation is unambiguous even when other things are happening in the chat.
15. As a maintainer, I want a bare `yes` with no carve pending to be ignored, so that a stray confirmation never triggers something.
16. As a maintainer, I want a pending confirmation to expire after a short while, so that an old un-confirmed carve cannot be triggered by a much later `yes`.
17. As a maintainer, I want the preview to be a private exchange that broadcasts nothing, so that only a carve that actually happened is announced.
18. As a maintainer, I want a confirmed carve to emit a `progress:carve` message listing the removed issues and the new remaining waves, so that I and anyone else routed that category hear what happened.
19. As a maintainer, I want the dashboard carve control to show the same closure preview and require a confirm, so that the dashboard is as safe as Telegram.
20. As a maintainer, I want the carve control to appear only on issues that are still carvable, so that I am not offered carve on completed or currently-in-flight issues where it would do nothing useful.
21. As a maintainer, I want the CLI `carve <issue>` with no plan to prune the running campaign, so that the terminal, the gateway, and the dashboard all share one behavior.
22. As a maintainer, I want the old `carve <issue> <batch…>` form with an explicit plan to keep launching a reduced campaign, so that the from-scratch case I already rely on is unchanged.
23. As a maintainer, I want the dashboard's single-project status server and the gateway's aggregated site to both offer carve, so that carve works whether I run one project standalone or many behind the gateway.
24. As a maintainer, I want carve to run with the target project's own `blockedBy` resolver, so that the dependency closure is computed against that project's real graph.
25. As a maintainer, I want a carve confirmation lost to a gateway restart to be harmless, so that I simply re-send `carve 640` rather than ending up in a bad state.

## Implementation Decisions

- **`reduceCampaign(events)` (new, extracted).** The event-fold that today lives inside `buildStatus` — reconstructing waves, per-issue outcomes, and which wave is current from the event log — is extracted into a pure module. Both `buildStatus` and the `campaign` loop import it. This is the load-bearing seam: it makes the running campaign and the dashboard agree on "the plan" by construction (ADR 0005), and it is what lets a running campaign re-derive its remaining waves at each boundary rather than trust an in-memory array.
- **Carve is an event; the loop re-reads at each wave boundary.** Carve against a running campaign appends a carve event to the project's event log. The `campaign` loop, at the top of each wave, calls `reduceCampaign` (now including any carve events) to compute the remaining waves it will run next. There is no separate mutable plan file — the event log stays the single source of truth (ADR 0002, ADR 0005).
- **`computeCarve` unchanged.** The pure transitive-closure reducer (`target` + its dependents, restricted to campaign issues) stays exactly as is. It computes *what is in the closure*; it does not decide what happens to each member.
- **`applyCarve(reduced, removed)` (new pure rule).** Given the reduced campaign (waves + outcomes) and `computeCarve`'s removed set, this encodes the keep-banked-work rule: already-merged issues are left as-is, green/mergeable ones are allowed to merge, parked and not-yet-started ones are dropped from `remaining` and flagged for parked-record clearing, and a merged/green *target* still drops its unfinished dependents. Returns the new remaining waves, the set to actually drop, and the parked records to clear.
- **CLI `carve` is context-aware by plan-arg presence.** `carve <issue>` (no plan) prunes the running campaign by appending a carve event; it requires a running campaign and rejects with a clear message when none is running. `carve <issue> <batch…>` (explicit plan) keeps today's behavior — compute and launch a reduced campaign from the supplied plan. Absence vs. presence of the plan args unambiguously selects the mode.
- **Carve joins the gateway command family.** `parseGatewayCommand(text)` generalizes the existing `isStatusCommand` recognizer to also parse `carve <issue>`, `carve <project> <issue>`, and a confirming `yes`. A carve command is recognized as a command, not routed to a parked task as an answer.
- **Project resolution from bot context.** `resolveCarveTarget(registeredProjects, botContext, issue)` resolves the command to a project: if exactly one project served by that bot/chat has a running campaign, target it; if more than one, return an ambiguous result carrying the candidate list (the gateway replies asking for `carve <project> 640`); if none, return a none result (the gateway replies that nothing is running). Pure over the registry plus each project's running/not-running state.
- **Preview then confirm.** On a resolved carve, the gateway computes the closure (via the project's `carve` — see execution, below), sends a preview listing the removed issues, and records a **pending confirmation** keyed to that preview message. The carve executes only on a reply to the preview. The preview broadcasts nothing; only the executed carve emits `progress:carve`.
- **`pendingConfirms` store (new, injected clock).** An in-memory map of pending confirmations with a short TTL, keyed so a `yes` is matched by being a reply to its preview message. A `yes` with no matching pending confirmation is ignored; an expired one is dropped. The store is deliberately non-durable — a gateway restart drops pending confirmations, consistent with ADR 0002's "the gateway holds no durable state of its own beyond the registry"; re-sending `carve 640` is the recovery.
- **Execution shells the project's `carve`.** The gateway runs `carve <issue>` for the resolved project via the shared install in that project's root (ADR 0003), exactly as E3 resumes with `answer <task>`. This is forced: `computeCarve` needs that project's `blockedBy` resolver, which exists only in the project's config. The gateway routes the command and the confirmation; the project-side carve computes the closure, appends the event, and clears parked records.
- **`progress:carve` reused, not re-invented.** The confirmed carve emits the existing `progress` category event (E4) with `event: carve`, its text listing the removed issues and the new remaining waves. Preview messages are outside the outbox — they are interactive gateway exchanges, not [[outbound-record]]s.
- **Dashboard `POST /carve`.** The single-project status server gains a `POST /carve` handler mirroring its existing `POST /answer`: it previews the closure (via `computeCarve` + `applyCarve`) and, on confirm, shells the project's `carve`. The gateway's aggregated site routes `/carve` to the selected project. The carve control renders only on issue chips that are still carvable — unstarted or future-wave — not on completed or current-wave-in-flight chips.

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs — the whole design is arranged so the hard logic is pure. Given an event log, `reduceCampaign` returns the right waves/outcomes/current-wave. Given a reduced campaign and a removed set, `applyCarve` returns the right dropped/kept/parked-to-clear split across every outcome combination. Given a registry and a bot context, `resolveCarveTarget` returns target/ambiguous/none. No network, no spawned processes, no Telegram.
- **Modules tested.** (1) `reduceCampaign` — several event logs (fresh campaign, mid-campaign with a completed wave, halted) reduce to the expected plan+progress; `buildStatus` keeps passing its current tests unchanged over the extracted module. (2) `applyCarve` — the keep-banked-work matrix: a merged member kept, a green member merged, a parked member dropped and flagged for clearing, an unstarted member dropped, and a merged/green *target* still dropping its unfinished dependents. (3) `computeCarve` — unchanged, its current tests stand. (4) `parseGatewayCommand` — `carve 640`, `carve proj 640`, `yes`, `/status`, and a plain one-word answer that must *not* be mistaken for a command. (5) `resolveCarveTarget` — one running campaign on the bot (target), two (ambiguous + candidates), none (none). (6) `pendingConfirms` — record→resolve, a `yes` with nothing pending ignored, and expiry driven by an injected clock. (7) `POST /carve` — preview returns the closure and confirm shells the carve, with the spawn injected.
- **Prior art.** `carve.test.ts` for the pure reducers and fake-resolver style (`applyCarve`, `resolveCarveTarget`); `status.test.ts` for `reduceCampaign` and the `POST /carve` handler (it already builds status from event logs and asserts on rendered pages / handlers against tmp state); the E3 reply index for `pendingConfirms`. Telegram and the child `carve` process stay behind injected boundaries, as they are today.

## Out of Scope

- **Killing in-flight containers.** A carved issue whose container is running now is allowed to finish; its result is simply excluded from the merge. Actively terminating a running container is not part of this work.
- **Reverting already-merged work.** Carve never un-merges. A merged issue in the closure is left exactly as it is.
- **A mutable plan file.** Rejected in ADR 0005 — the event log is the single source of truth and carve is an event over it, not an edit to a separate plan file.
- **New comms categories or destinations.** Carve reuses the existing `progress:carve` event and the E4 notify map; it defines no new [[message-category]] or [[destination]].
- **Carve against a finished or from-scratch plan via Telegram/dashboard.** Those inbound entry points act only on a running campaign; the explicit-plan `carve <issue> <batch…>` form stays CLI-only.

## Further Notes

- The one structural bet is extracting `reduceCampaign` out of `status.ts`. Everything downstream — the loop re-reading its plan, the dashboard, and carve itself — depends on that single reconstruction being shared, which is exactly what ADR 0005 commits to and what keeps the running campaign and the dashboard from ever disagreeing about the plan.
- Carve stays safe-by-preview because the danger is specific: you rarely realize how much a single issue drags behind it. Showing `computeCarve`'s removed list before acting turns that from a surprise into a decision, and it costs one round-trip.
- Nothing here invents a seam it did not have to. `computeCarve` is untouched, the command recognizer extends `isStatusCommand`, project resolution and the confirmation store follow the E3 reply-index/registry patterns, and the dashboard endpoint clones `POST /answer`.
