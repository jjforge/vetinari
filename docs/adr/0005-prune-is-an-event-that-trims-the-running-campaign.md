# Prune is an event that trims the running campaign; the plan is reconstructed from the log

Status: recorded in design.md §5.

Pruning an issue out of a **running** campaign must not require a plan on the
command line or a fresh campaign process. We decided that prune appends a
**prune event** to the project's event log, and the `campaign` loop reconstructs
its remaining waves *from that log* at each wave boundary — the same reduction
`buildStatus` already runs to render the dashboard. A running campaign therefore
has no separate mutable plan file: the event log stays the single source of
truth (ADR 0002), and the running campaign and the dashboard agree by
construction. The in-flight wave finishes as-is; only future waves shrink.

Prune **trims the unfinished remainder, it never discards banked work.** Of the
removed closure (the target plus its transitive dependents), anything already
merged is left as-is, anything green/mergeable is allowed to merge, and only the
parked or not-yet-started issues actually leave `remaining` (their parked records
cleared). Notably a merged/green target still prunes its unfinished dependents —
prune is a human's forward-looking "remove this subtree" decision, not a
re-derivation of what the DAG has unblocked.

"Only the parked or not-yet-started issues leave" applies to **future** waves.
In a **live** campaign's in-flight wave, the not-yet-started members are kept:
that wave finishes as-is, so they will run anyway, and dropping them could
empty the wave and shift the plan under the loop's wave index. The in-flight
wave's parked members still leave. The log cannot tell a live in-flight wave
from a crashed one (both are a `wave-start` with no `wave-done`), so liveness is
checked once, when the prune is issued, and recorded as `keepInFlight` on the
prune event; the fold applies the in-flight rule only to an event carrying that
marker, which is what keeps the replay deterministic.

One exception lets a **manual** prune's own target leave even though it is
green: a target that a merge conflict parked (ADR 0013). Its green cannot land
until the conflict is resolved, so the operator's `prune <issue>` — the conflict
notice's own advice — drops it, clears its parked record, and folds it to a
pruned member that never started; its work stays on the kept branch unless
`--purge`. A **failed** target leaves the same way: the failure notice advises
`prune <issue>`, and a failed member would otherwise hold its wave and fail
every redrive. Only the target gets this: a conflict-parked or failed
*dependent* in the closure is kept until it is itself pruned. `campaign --auto-prune` never drops
its conflict target — that target still holds its wave. The fold recomputes
the drop on every replay, so `prune` records the exception as `dropTarget` on
its event; an event without the marker (every auto-prune, every older log)
replays the plain rule, keeping the target.

## Considered Options

- **A separate mutable plan file the loop re-reads** — rejected: it introduces a
  second source of truth that can desync from the event log, and the log already
  reconstructs the plan for the dashboard. An event keeps one source of truth.
- **Halt the running campaign and relaunch a reduced one** — rejected: process
  teardown mid-run is disruptive and loses the clean wave-boundary semantics the
  event-reconstruction approach preserves.

## Consequences

The plan-reduction logic currently living in `status.ts` (`buildStatus`, the
event fold at `status.ts:166`) must be extracted into a pure module that both the
dashboard and the `campaign` loop import — the loop changes from iterating an
in-memory `batches` array to reducing remaining-waves-from-events each wave.
Because `computePrune` stays a pure function over the plan, the "keep banked
work" rule lives in *applying* the prune event against the campaign's current
outcomes, not in `computePrune` itself.
