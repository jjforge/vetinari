# Running a campaign (issues → waves)

vetinari runs `ready-for-agent` tickets through its own `campaign` mode in
dependency-ordered waves. This is the repo-specific companion to the operator's
model in [`user-guide.md`](user-guide.md) — "A campaign, start to finish" and the
five moves — and the mechanism in [`design.md`](design.md) §4–§7. It names the
moves and the invariants; for the exhaustive flag and mode list see
[`reference.md`](reference.md).

## Select, plan, run — one command

`campaign <selection>` turns a selection into waves and runs them:

- **Select** — a numeric token is an issue id; a non-numeric token is a **label**,
  expanded to the open issues carrying it. Tokens mix freely, so
  `campaign 436 ready-for-agent` unions the explicit id with the label's issues.
- **Plan** — the selection is layered by tracker dependencies, then each layer is
  split so no two issues in a wave touch the same file (the two invariants below).
  `campaign --dry-run <selection>` prints the plan and runs nothing — the way to
  inspect a plan before committing to it.
- **Run** — the campaign drains each wave, merges its greens, gates the merged
  base, then advances to the next wave.

The planner is the safety net: it refuses to guess. See
[`reference.md`](reference.md) for the flags that tune planning and running.

## The two wave invariants

The planner enforces both — the `blocked_by` graph alone gives neither:

1. **Maintain the ticket DAG** — a ticket's wave comes after every open
   in-campaign blocker's wave (waves are the DAG's topological layers). A closed
   blocker does not gate; a blocker outside the selection makes the ticket
   unreachable, so it is reported and dropped with its dependents.
2. **No two tickets in one wave edit the same file** — crossover is not in the
   DAG, so each layer is partitioned into **file-disjoint** sub-waves, collision
   judged by **basename**. Each ticket declares its file-set with an explicit
   marker **line** — `Touches:`/`Files:` for files it edits, `Creates:` for files
   it adds. See
   [`issue-conventions.md`](issue-conventions.md#declaring-a-tickets-file-set)
   for the authoring convention.

When planning meets an under-specified ticket — one whose file-set the resolver
cannot confirm against the tree — it halts rather than guess. A non-interactive
run pre-decides with `--on-underspecified` ([`reference.md`](reference.md)): drop
the not-confident tickets and their dependents, or fail so the file data can be
added and the plan re-run. Parallelize **across epics** — epics carry no inherent
order, so a wave normally spans several; never serialize by epic.

**A selection that resolves to one issue is the exception to both.** With no
co-wave, invariant 2 guards nothing, so the file-set check is **skipped** (not
halted, not pruned — the provenance says so) and the ticket runs without a marker
line. Invariant 1's *layering* is likewise trivial, so a configured `blocked_by`
resolver is no longer *required* — bare `campaign <id>` runs in a project that has
none. The resolver's *reachability* is not vacuous, though: when one **is**
configured, a lone ticket held by an open blocker outside the selection is still
dropped and reported, exactly as in a larger set. Above one ticket everything
above holds unchanged.

## The loop

The campaign drains a wave, merges its greens one at a time, gates the **merged**
base as a whole, then advances — all on the checked-out base branch, locally,
never pushing. The merged-base gate is integration, not live verification: a
merged ticket is `pending-verify` until a local run confirms it (the closing rule
in [`issue-conventions.md`](issue-conventions.md)), then it closes. A wave is done
only when every member is `completed`; one member parking or failing never aborts
its siblings — the wave drains, every green still merges, and only then does the
campaign park or stop as failed.

## When a wave stops: parked, with a reason

Integration is **non-atomic** (ADR 0013): a stopped wave is never rolled back.
Work stops in one of the settled states — a member `failed` (it could not go
green, terminal until you change something), or a member `parked` with the
**reason** that says what happened and which of the five moves it asks of you:

- **`conflict`** — a green branch conflicts with the base at merge. That one issue
  is parked with its branch, worktree and session intact; every green already
  merged this wave stays merged and integration carries on with the rest. Resolve
  the conflict on the base, then redrive.
- **`red-base`** — every branch was green alone but the merged base fails
  together. The whole wave parks: everything stays merged, the base sits red
  (never pushed, nothing builds on it while paused), and the campaign stops. The
  machine never guesses a culprit — none is knowable. Fix forward on the base, or
  `prune` a suspect, then redrive.
- **`question`** / **`stalled`** / **`crash`** — a run needs you. Answer the
  question; read the turn log and answer a stall with guidance or prune it; a
  crash just needs a redrive. The reason table in
  [`user-guide.md`](user-guide.md) gives the full mapping.

A parked or failed campaign holds no live state — everything is on disk. You take
one of the **five moves** — answer, prune, graft, fix forward, redrive
([`user-guide.md`](user-guide.md)) — and continue. An answer resumes the campaign
by itself; the other moves are followed by `vetinari redrive`, which picks the
campaign up where it stopped, redoing no already-merged issue and integrating work
that is green but not yet merged rather than re-running it. A parked wave folds no
`changelog.d/` fragments and applies no `pending-verify` labels for its greens
until it is resolved green.

## Reconciling drift: `tidy`

Human-in-the-loop resolution — a manual fix-forward, a by-hand merge — is where
artifacts leak. `vetinari tidy` folds orphaned `changelog.d/` fragments whose
issue is merged, garbage-collects `agent/<id>` branches and worktrees whose
commits are **provably** reachable from the base, and clears parked records for
issues now merged. It never touches an unmerged, parked, or failed branch.
Dry-run by default; see [`reference.md`](reference.md) for its flags.
