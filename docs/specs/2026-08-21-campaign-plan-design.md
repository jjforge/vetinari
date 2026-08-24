# campaign-plan: waves from the selected set, not the graph

Epic: [#10](https://github.com/jjforge/vetinari/issues/10) · Source: [ADR 0004](../adr/0004-campaign-plan-is-a-generic-feature-with-a-config-fileset-resolver.md) · Glossary: [CONTEXT.md](../../CONTEXT.md) · Supersedes: jjforge `docs/specs/2026-08-20-campaign-builder-design.md`

## Problem Statement

`campaign` merges the greens of each wave in the order it is handed and does not
compute the waves — by design. Building that wave list is a manual step today, and
it is where the two campaign invariants get encoded. The dependency invariant is
served fine by the `blockedBy` graph, but the **file-crossover** invariant is not: I
have to eyeball which selected tickets touch the same file and keep them out of the
same wave, or they collide as a merge conflict at integration. Worse, the tempting
fix — encoding "these two touch the same file, so serialize them" as a `blockedBy`
edge — is wrong: crossover depends on *which tickets are in this campaign's
selection*, and that varies run to run, so a permanent edge lies to every future
campaign. I want the waves computed for me, correctly, from the set I actually
selected.

## Solution

A `campaign-plan <ticket-ids…>` command that takes the selected set and emits the
dependency-ordered, file-disjoint **wave** arguments ready to paste into `campaign`.
It layers the selected tickets by their `blockedBy` graph, then splits each layer so
no two tickets in a wave touch the same file. Each ticket's file-set comes from a
project-provided **file-set resolver** (vetinari ships a generic default). When
a ticket's file-set can't be determined confidently, the tool does not guess — it
**stops and asks me** whether to drop that ticket (and its dependents) and plan the
rest, or halt so I can put the missing data on the issue. It plans only; it never
runs `campaign` or pushes.

## User Stories

1. As a maintainer, I want to pass a set of ticket ids and get back the wave
   arguments, so that I do not build the batch list by hand.
2. As a maintainer, I want the waves ordered by the `blockedBy` graph restricted to my
   selected set, so that a ticket only runs after its in-campaign blockers merge.
3. As a maintainer, I want a ticket whose only blockers are closed to be on the
   frontier (wave 0), so that already-merged work does not hold it back.
4. As a maintainer, I want a ticket with an open blocker that is not in my selection to
   be reported as unreachable and dropped, not silently scheduled, so that I know it
   cannot run until that blocker lands.
5. As a maintainer, I want each wave partitioned so no two tickets in it touch the same
   file, so that a wave never collides as a merge conflict at integration.
6. As a maintainer, I want file collisions judged by basename, so that the same file
   cited by different paths across tickets is still caught.
7. As a maintainer, I want a ticket's file-set resolved against the current tree at
   plan time, so that the plan reflects the tree the campaign will actually run on, not
   a stale note written weeks ago.
8. As a maintainer, I want a shipped default resolver that reads a ticket's cited paths
   and validates them against the tree, so that I get useful behavior with no config.
9. As a maintainer, I want to supply my own file-set resolver in config, so that my
   project's specifics (a symbol/route→file index, append-targets) can improve
   resolution beyond the default.
10. As a maintainer, I want a ticket whose file-set can't be resolved confidently to
    stop the plan and ask me what to do, so that missing data never hides behind a
    plausible-looking wave list.
11. As a maintainer, when asked, I want to choose to drop the under-specified ticket
    and its dependents and plan the rest, so that one unclear ticket does not block the
    whole campaign.
12. As a maintainer, I want dropping a ticket to also drop everything it blocks, so
    that the remaining plan has no unreachable tickets left in it.
13. As a maintainer, I want the alternative of halting so I can add the file data to
    the issue and re-run, so that I can fix the source rather than work around it.
14. As a maintainer running non-interactively (a script or CI), I want to pre-decide
    that behavior with a flag, so that the tool never blocks on a prompt; and I want
    the default with no flag and no terminal to be to fail, so that missing data is
    never silently dropped.
15. As a maintainer, I want the plan to explain itself — why each ticket is in its wave
    and why any ticket was spilled to a later sub-wave or carved out — so that I can
    trust the partition before pasting it into a live campaign.
16. As a maintainer, I want the bare wave arguments emitted cleanly too, so that I can
    paste them straight into `campaign` without hand-editing.
17. As a maintainer, I want the tool to only plan — never run `campaign`, never push —
    so that I stay in control of when work actually starts.
18. As a maintainer of any project (not just jjforge), I want this to be a generic
    vetinari feature, so that every project I run campaigns in gets it.

## Implementation Decisions

- **Generic feature, peer of `carve` (ADR 0004).** `campaign-plan` lives in
  vetinari. No project-specific paths are hard-coded.
- **Shared DAG foundation with `carve`.** The step that builds each ticket's blockers
  restricted to the selected set (which `carve` does inline today) is factored into a
  shared helper both use. `campaign-plan` then topologically **layers** the restricted
  graph (wave 0 = no open in-set blocker; a ticket enters wave *W* when all its
  blockers are in earlier waves).
- **Open vs closed blockers.** Layering needs to know each blocker's state: a closed
  blocker does not gate; an open blocker inside the set is a layering edge; an open
  blocker outside the set makes its dependent **unreachable** (reported and dropped).
  The injected blocker resolver therefore provides open blockers, not merely ids.
- **File-set resolver is a config seam.** A project supplies `fileSet(ticket) →
  { files, confident }`. vetinari ships a generic default that parses a ticket's
  cited paths, normalizes to basename, and validates against the tree, marking
  `confident: false` when a ticket cites nothing or cites what the tree lacks. Exported
  alongside `githubBlockedBy`. A project may use it or wrap it.
- **Partition by basename within a layer.** Since cross-layer pairs are already
  serialized, crossover is resolved only within a layer: greedily pack tickets into
  sub-waves so no two share a basename, spilling losers to a later sub-wave (this can
  add a wave or two — the intended trade).
- **Under-specified tickets halt to the requestor.** When `fileSet` returns
  `confident: false`, `campaign-plan` prompts: (A) drop the ticket **and its
  dependents** (reusing `computeCarve`) and plan the rest, or (B) stop so the requestor
  enriches the issue and re-runs. A `--on-underspecified=drop|fail` flag pre-decides
  for non-interactive runs; with no flag and no terminal the default is **fail**.
- **Irreducible residual.** An agent may still touch an uncited file no resolver can
  predict. This is not closed here — it surfaces at merge as a visible three-dot
  conflict (the existing invariant-2 backstop). The tool documents it; it does not
  pretend to eliminate it.
- **Output.** The bare quoted wave args for pasting, plus a human-readable provenance
  report (each ticket's wave and the reason, and anything carved). Plans only — never
  runs `campaign`, never pushes.

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs: given a
  selected set and a fake blocker resolver, the waves and the unreachable list; given
  fake file-sets, the sub-wave partition; given an under-specified ticket and a
  decision, either the carved remainder or a failure. Every core piece is a pure
  function over injected resolvers — no live GitHub, no containers, no TTY.
- **Modules tested.** (1) The shared restricted-blockers helper — edges kept only
  within the set. (2) `layerWaves` — layering with closed/open/out-of-set blockers, and
  unreachable detection. (3) The default `fileSet` resolver — cites validated against a
  tmp tree, basename normalization, and `confident: false` on none/mismatch. (4) The
  basename partition — a layer that must spill a colliding ticket. (5) The
  under-specified decision — `drop` carves the ticket and its dependents; `fail`
  errors. (6) The `campaign-plan` command end to end with injected resolvers and a
  scripted prompt.
- **Regression fixture.** The 2026-08-19 campaign's ~41 issues: the partition must be
  DAG-consistent and crossover-safe — concretely `#461` (no `blockedBy` edge, but
  shares `stack_strip.tmpl` with `#378`/`#688`/`#400`) must not land in a wave with any
  of them. A pure-DAG planner puts `#461` in wave 0 and collides; the file partition
  must spill it.
- **Prior art.** `carve.test.ts` for the pure planners over a fake resolver;
  `status.test.ts` / `archive.test.ts` for the default resolver against a `tmpdir()`
  tree.

## Out of Scope

- **Running the campaign.** `campaign-plan` emits wave args; `campaign` still executes
  them. No change to how `campaign` merges or gates.
- **Agents emitting their actual touched file-set** for post-hoc validation — the
  deferred "(c)" feedback loop (ADR 0004), a separate future item.
- **Eliminating the irreducible residual** (uncited append-targets) — handled by the
  existing merge-time conflict backstop, not by this tool.
- **A project's own file-set resolver implementation** (e.g. jjforge's symbol/route
  index) — that is the project's config, not this feature.

## Further Notes

- The output is not a pure function of the ids — it reads the tree and may prompt.
  That is accepted: the tree is the ground truth the campaign runs against, and the
  prompt is the point of the under-specified halt.
- `campaign-plan` and `carve` are siblings: they share the restricted-blockers
  foundation, and `campaign-plan`'s "drop and proceed" path *is* `carve`.
