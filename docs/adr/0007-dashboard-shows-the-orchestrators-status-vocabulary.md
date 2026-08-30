# The dashboard shows the orchestrator's real status vocabulary, plus `pruned`

Status: superseded by design.md §2.2.

The UX handoff (the `dashboard-ux` package) defined a five-word status vocabulary
— *running, parked, queued, merged, pruned* — and **banned a failure status**, on
the theory that a run that breaks parks and asks rather than failing. The
orchestrator does not behave that way. Its `IssueStatus` (`src/status.ts`) is
`completed | parked | failure | running | unstarted`, and a run can error out to
`failure` **without** parking.

So the dashboard shows the orchestrator's own vocabulary rather than relabelling it
into the handoff's friendlier words. It adds exactly one status the backend does
not carry as an enum value: **`pruned`**, derived at render from the prune event,
so an operator browsing a live or archived run can see which issues left the
campaign. The reconstruction reads prune events already in the log; the agent loop
and the `IssueStatus` type are untouched.

## Considered Options

- **Relabel backend statuses in the render layer** (`completed → merged`,
  `unstarted → queued`, hide `failure`) — rejected: it hides a state the
  orchestrator genuinely emits and mints two states (`merged`, `queued`) the event
  log never produces, so the UI and the log would disagree on which states exist.
- **Change `IssueStatus` to the handoff's words** — rejected: it churns a
  load-bearing type the loop and gate depend on, purely to make the UI prettier.
  The orchestrator's truth is fine; only the handoff's labels were the problem.

## Consequences

- The dashboard's status set is **running · parked · failure · completed ·
  unstarted · pruned**. `failure` is visible; the per-issue turn log carries the
  why.
- `pruned` is folded from prune events in the reconstruction (`reduceCampaign`) and
  renders identically in live and archived runs.
- The `dashboard-ux` handoff is **superseded on vocabulary** (its §3). Its visual
  system, layout, and interaction model still stand.
