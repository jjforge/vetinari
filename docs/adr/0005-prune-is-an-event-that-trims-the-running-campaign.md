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
