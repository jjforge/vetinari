# Running a campaign (issues → waves)

vetinari runs `ready-for-agent` tickets through its own `campaign` mode in
dependency-ordered waves. Build the wave list with **`campaign-plan <ids…>`** (it
plans; it never runs Vetinari or pushes), then hand the waves to `campaign`.

## The two wave invariants

`campaign-plan` enforces both — the `blocked_by` graph alone gives neither:

1. **Maintain the ticket DAG** — a ticket's wave comes after every open in-campaign
   blocker's wave (waves are the DAG's topological layers).
2. **No two tickets in one wave edit the same file** — crossover is not in the DAG,
   so each layer is partitioned into **file-disjoint** sub-waves, collision judged by
   **basename**. Each ticket declares its file-set with an explicit marker **line**
   the file-set resolver reads — start a line with `Touches:` or `Files:` and list
   the files it touches in backticks:

   ```
   Touches (existing files): `a.ts`, `b/c.ts`
   ```

   Only the marker line is read, so incidental filenames elsewhere in the body — an
   env file, a config name, a spec link — do not affect the result; paths are
   normalized to their basename, so `b/c.ts` and a bare `c.ts` collide as one file.
   A ticket that cites a file the tree does not have, or (with no marker line) any
   incidental token that isn't a real file, resolves `confident: false` and
   `campaign-plan` halts rather than guess — so give every ticket a marker line.
   Files a ticket *creates* go on a `Creates:` line instead: their absence from the
   tree is expected, so they feed disjointness but are not tree-checked. This makes a
   new-file-only tracer-bullet ticket — often the first slice of a seam — schedulable
   without folding in an incidental edit to an existing file.
   See [`issue-conventions.md`](issue-conventions.md#declaring-a-tickets-file-set)
   for the authoring convention.

Parallelize **across epics** — epics carry no inherent order, so a wave normally
spans several; never serialize by epic.

## The loop

The campaign drains a wave, merges its greens, gates the **merged** base, then
advances, advancing the base locally without pushing. The merged-base gate is
integration, not live verification — so a merged ticket is `pending-verify` until a
local run confirms it (the closing rule in
[`docs/issue-conventions.md`](issue-conventions.md)), then it closes.

## When a wave fails: quarantine and wave-park

Integration is **non-atomic** (ADR 0013): a failing wave is not rolled back, and the
two ways it can fail get two responses, by whether blame is attributable.

- **Merge conflict** — attributable to one branch. That one issue is **quarantined**
  (its branch, worktree, and session preserved so it is resumable, never re-run from
  scratch); every green already merged this wave stays merged and the wave carries on
  integrating the rest. A quarantine that strands dependents in *later* waves pauses
  the campaign at the wave boundary — the blast-radius call is a human's — unless you
  ran `campaign --auto-prune`, which prunes the stranded closure and runs on.
- **Red merged base** — emergent, no single culprit (each branch was green alone). The
  wave **wave-parks**: everything stays merged, the base sits red (never pushed,
  nothing builds on it while paused), and the campaign pauses. Resolve it — fix forward
  and `campaign --resume`, or `prune <suspect>` and resume.

`campaign --resume` continues a paused campaign's unrun waves on the current base,
reconstructing the plan from the event log and redoing no already-merged issue; it
takes no batch args. A wave-parked red base folds no `changelog.d/` fragments and
applies no `pending-verify` labels for its greens until it is resolved green.

## Reconciling drift: `tidy`

Human-in-the-loop resolution — a manual fix-forward, a by-hand merge — is where
artifacts leak. `vetinari tidy` folds orphaned `changelog.d/` fragments whose issue is
merged, garbage-collects `agent/<id>` branches and worktrees whose commits are
**provably** reachable from the base, and clears parked records for issues now merged.
It never touches an unmerged, quarantined, parked, or wave-parked branch. Dry-run by
default; `--apply` acts, and `--all` sweeps every registered project.
