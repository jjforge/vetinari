# Re-plan is an event that rewrites the unstarted remainder of a running campaign

Status: recorded in design.md §5.

A campaign's waves are fixed at launch (`campaign-start`'s `waves`), and `redrive`
rebuilds that same plan from the log. Before this, the only way to re-plan the waves
that had not started — after a better `fileSet` resolver, a fixed file marker, or a
new `waivedFiles` entry for a hot file — was to `stop` and launch a fresh `campaign`,
which archives the log and needs an operator who knows to do it. File overlap, not
dependencies, accounts for about half of all waves, so this is the change an operator
most often wants mid-run.

`vetinari replan` recomputes the waves of the campaign's **unstarted** members from the
current config and tracker, and appends a **`replan` event**, the way `graft` appends a
graft (ADR 0014). The `campaign` loop picks it up when it re-folds the log at the next
wave boundary; on a stopped campaign the next `redrive` runs the new plan. There is
still no mutable plan file — the event log stays the single source of truth.

## What it may move

Only unstarted members, grafted ones included. **Started is wave-level**: every member
of a wave that has had a `wave-start` is started, even if it has not spawned yet, so the
in-flight wave is never touched and completed, in-flight, parked and failed members keep
their waves. A graceful stop's parked wave is the exception that proves the rule — it
names the *next* wave, which never started, so a re-plan rewrites it and the reducer
recomputes the stop marker from the new wave at that index. A re-plan never adds or
removes an issue: adding stays `graft`'s job, removing stays `prune`'s.

## The event stores the result, not the inputs

`replan { waves }` carries the new waves for the unstarted remainder. The reducer keeps
every started wave at its index (the loop is index-based) and replaces only the tail, so
replaying an old log after a future planner change still gives the plan the campaign ran
(ADR 0012). Unlike `graft`, whose event carries layering inputs the fold places with,
there is nothing left for the fold to compute: the re-plan *is* a placement.

Because the result was computed against the log as it stood when `replan` read it, the
fold applies a **race rule**: a re-planned member that has started by that point in the
log, or is no longer in the campaign (pruned since), is skipped; an unstarted member the
re-plan does not name (grafted since) goes in a trailing wave of its own; waves left
empty are dropped. And right before appending, `replan` re-reads the log and refuses if
a `graft`, `prune`, `wave-start` or `replan` landed since it read — the fold's rule is
for safety, not a licence to fold a stale plan.

The display `layout` follows the new tail past the started prefix; a pruned member whose
display wave was replaced moves to one trailing display-only wave, so the dashboard
never loses a member (ADR 0007).

## Considered Options

- **Stop and relaunch** — the status quo; rejected because it archives the log the
  dashboard and the redrive read, and loses the campaign's identity mid-run.
- **Store the inputs (file keys, blockers) and re-place in the fold** — rejected: the
  fold would re-plan with whatever planner the reader runs, so an archived run could
  replay into a plan it never ran.
- **Re-plan automatically at every wave boundary** — rejected for now: a plan that moves
  under an operator watching it is a surprise, and the re-read of every unstarted issue
  costs a tracker round-trip per boundary. `replan` is an explicit operator act.
- **Go through `planCampaign`** — rejected: it drops unreachable and under-specified
  issues silently, words its refusals for `campaign`, and skips the file-set check for
  one issue. A re-plan refuses whole instead, naming every offender (an issue with no
  confident file set, or an open blocker outside the campaign) and logging nothing.

## Consequences

A re-plan never changes membership, so it carries no membership badge and emits no
operator notice; the dashboard and status line simply show the re-planned waves,
numbered after the started ones. It is CLI-only — there is no dashboard control.
