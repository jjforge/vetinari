# Graft is an event that extends the running campaign; the added issues are re-layered from the log

Adding issues to a **running** campaign is the symmetric counterpart to carve
(ADR 0005), and takes the same shape: `graft <ids…>` appends a **graft event** to
the project's event log, and the `campaign` loop reconstructs its remaining waves
*from that log* at each wave boundary — so the added issues land in future waves
while the in-flight wave finishes untouched. There is still no separate mutable
plan file; the event log stays the single source of truth (ADR 0002), and the
running campaign and the dashboard agree by construction. Where carve prunes the
unfinished remainder, graft **extends** it: the added issues are layered into the
plan alongside the not-yet-started work.

## How the added issues are placed

At each boundary the loop pins the in-flight wave — its not-yet-completed issues
(`running`/`parked`/`quarantined`) stay put as the current wave — and re-layers
only `unstarted ∪ grafted` into *later* waves. Placement is a **stable-insert**:
existing `unstarted` wave assignments are preserved, and each grafted issue drops
into the earliest later wave that satisfies its `blockedBy` dependencies and keeps
the wave basename-disjoint, appending new waves only as needed. Because a grafted
issue can never join the pinned in-flight wave, a basename collision with an
in-flight issue is safe by construction — file-disjointness is only enforced
*within* a wave, and the wave boundary serializes them. Dependencies fall out for
free: `blocked_by` an already-merged issue → eligible in the next wave;
`blocked_by` an unrun issue → layered after it.

Graft is allowed against any run that is not yet `campaign-done` — live (honored at
the next wave boundary) or paused/wave-parked/resumable (honored on the next
`--resume`, which is that run's next boundary). This is a deliberate divergence
from carve's running-only in-place form: a wave-parked campaign is exactly when an
operator often wants to add work.

## The event carries precomputed layering inputs, not just ids

`reduceCampaign` is a pure reducer with no tracker or filesystem access (ADR 0012),
so — exactly as the carve event stores its resolved closure — the **graft event
stores the resolved layering inputs** (the added ids plus their `blockedBy` graph
and basenames), computed by the CLI at append time via the same resolvers
`campaign-plan` uses. The fold is then a pure `layerWaves`/`partitionWaves` call
over data already in the log.

## Considered Options

- **A fresh sub-plan appended strictly after the remaining waves** — rejected: it
  duplicates the layering logic and runs added work later than its dependencies
  require, losing the interleaving the DAG already expresses. Re-layering the union
  reuses the existing planner and is correct by construction.
- **Full re-optimize of the unstarted waves on every graft** — rejected in favour
  of stable-insert: churning already-planned wave assignments surprises an operator
  watching the plan, for negligible gain over inserting the added issues.
- **Storing only the ids and re-resolving `blockedBy`/basenames in the fold** —
  rejected: it breaks the purity `reduceCampaign` relies on to also run in the
  dashboard (ADR 0012).

## Consequences

A grafted issue renders as the render-derived `grafted` state (transient: shown
while `unstarted`, becoming `running` on pickup), the additive mirror of `carved`.
A graft emits a `progress:graft` comms event, symmetric with `progress:carve`.
`graft` validates all-or-nothing: an unknown/closed id, or an id already in the
campaign, rejects the whole graft naming the offenders, rather than half-applying.
