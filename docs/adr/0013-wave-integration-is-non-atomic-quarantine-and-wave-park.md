# Wave integration is non-atomic: a conflict quarantines one issue, a red combined gate parks the wave

Integration was atomic per wave. When `integrateGreens` hit a merge conflict or a
red merged-base gate, it ran `git reset --hard` to the commit the wave started at —
un-merging every green that had **already** merged in that wave — and halted the
whole campaign. It left those greens' branches, worktrees, parked records, and
`changelog.d/` fragments behind for a human to clean up by hand, and because the
run stayed parked it never archived, so the halted run also lingered as "live" on
the dashboard.

So one issue's failure discarded other issues' independently-verified work, stopped
everything, and left a mess that blocked the run from closing out. Worse, it
collapsed two unlike failures into one blunt response: a **merge conflict**, which
git attributes to a single branch, and a **red combined gate** (each branch green
alone, the merged base red together), which has no single culprit at all.

## Decision

Integration is **non-atomic**, and the two failures are handled by whether blame is
attributable.

- **Merge conflict — attributable.** Abort only the conflicting merge and mark that
  issue **quarantined**: its branch, worktree, and agent session are preserved so it
  is resumable, never re-run from scratch. The greens already merged **stay merged**;
  the wave continues integrating the rest. The wave neither rolls back nor stops.

- **Red combined gate — emergent.** Leave everything merged on the base and
  **wave-park**: the base sits red, the campaign pauses, and a human decides — fix
  forward and resume, or prune a suspect and resume. The machine never guesses a
  culprit, because none is knowable (every issue passed on its own).

The base is where the merges live in both cases; a wave-parked base is a temporary
red `main` the operator owns (never pushed, nothing builds on it while paused).

Around that core:

- **Campaign flow.** A quarantine that orphans dependents in *later* waves pauses the
  campaign at the wave boundary — the blast-radius call belongs to a human. A
  quarantine that orphans nothing does not stop anything. `campaign --auto-prune`
  opts into pruning the quarantined issue's dependent closure and running on.
- **Prune preserves work.** Prune keeps the pruned issue's branch + worktree +
  session by default so it can be investigated and resumed; `--purge` is the rare
  true-drop.
- **Persist and resume.** A paused campaign's plan and progress already live in the
  event log (the reconstruction `prune` relies on — see
  [ADR 0005](0005-prune-is-an-event-that-trims-the-running-campaign.md)), so
  `campaign --resume` continues the unrun waves on the fixed base rather than making
  the operator rebuild wave args.
- **Changelog and label timing.** A green issue's `changelog.d/` fragment folds and
  its `pending-verify` label lands **only** when it is part of a base that passed the
  gate. A wave-parked red base verifies nothing, so its greens wait until it is
  resolved green.
- **`tidy` reconciles drift.** Human-in-the-loop resolution (a manual fix-forward, a
  by-hand merge) is where artifacts leak. `tidy` folds orphaned fragments for
  already-merged issues, and garbage-collects agent branches/worktrees **only** when
  their commits are provably reachable from the base — never a branch with unmerged
  work, never a `quarantined`/`parked`/`wave-parked` issue. Dry-run by default.

## Consequences

- A single issue's failure no longer discards the wave's other verified work; the
  expensive loss (throwing away green agent work and forcing a full restart) is gone.
- The orchestrator gains two states beyond `parked`: **`quarantined`** (a conflict
  pulled an issue from integration, work preserved) and **`wave-parked`** (a red
  combined gate holds the whole wave). One word for three different situations is
  what bred the original confusion; the glossary keeps them distinct.
- The atomic-rollback safety property is not lost, it is *narrowed*: the only thing
  that survives red is a base the combined gate has not blessed, and it survives
  **paused**, under a human, never advanced upon.
- Recovery is a plain-git story on the base the operator is already on — fix forward
  or prune, then `--resume` — not a parallel-branch reconciliation.
- `tidy`'s one load-bearing rule: a branch dies only when it is provably merged. That
  is what makes it safe to trust and consistent with "never lose work."
