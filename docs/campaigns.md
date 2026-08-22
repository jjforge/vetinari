# Running a campaign (issues → waves)

sandcastle-tdd runs `ready-for-agent` tickets through its own `campaign` mode in
dependency-ordered waves. Build the wave list with **`campaign-plan <ids…>`** (it
plans; it never runs sandcastle or pushes), then hand the waves to `campaign`.

## The two wave invariants

`campaign-plan` enforces both — the `blocked_by` graph alone gives neither:

1. **Maintain the ticket DAG** — a ticket's wave comes after every open in-campaign
   blocker's wave (waves are the DAG's topological layers).
2. **No two tickets in one wave edit the same file** — crossover is not in the DAG,
   so each layer is partitioned into **file-disjoint** sub-waves, collision judged by
   **basename**. Each ticket body carries a line the file-set resolver reads:

   ```
   Touches (existing files): `a.ts`, `b.ts`
   ```

Parallelize **across epics** — epics carry no inherent order, so a wave normally
spans several; never serialize by epic.

## The loop

The campaign drains a wave, merges its greens, gates the **merged** base, then
advances; it halts and rolls back on a conflict or red base, and it advances the
base locally without pushing. The merged-base gate is integration, not live
verification — so a merged ticket is `pending-verify` until a local run confirms it
(the closing rule in [`docs/issue-conventions.md`](issue-conventions.md)), then it
closes.
