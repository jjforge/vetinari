---
name: triage-placement
description: Use when placing issues into the epic hierarchy (and milestones, where the repo uses them) and wiring their dependencies — triaging a loose issue, auditing the tracker for drift, or reorganizing it. Decides the correct epic for an issue and encodes native sub-issue and blocked-by edges. Triggers "place this issue", "which epic/milestone", "wire the dependencies", "audit the tracker".
---

# Triage placement

Put every planned issue in the right **epic → issue** slot (under a **milestone**, where
the repo uses them) and encode its **dependencies** as native GitHub relationships, so the
tracker's shape is the real shape of the work. This is orthogonal to `/triage`: that skill
decides *readiness*; this one decides *where the work lives* and *what it waits on*.

Vetinari reads this shape directly. Its planner treats an issue typed `Epic` as a
container, never as work, and schedules an issue only once every native `blocked_by`
blocker is closed or merged (`pending-verify`). A dependency written only in prose is invisible to it, so a campaign
can run the dependent issue first.

Read the repo's own tracker conventions before placing anything: its `CLAUDE.md` or
`AGENTS.md`, and the tracker docs under `docs/agents/` where they exist
(`issue-tracker.md`, `triage-labels.md`, `work-tracking.md`). Where they conflict with this skill, they win. Every `OWNER/REPO` below is
`gh repo view --json nameWithOwner -q .nameWithOwner`.

## The model — three levels and no more

`milestone (optional) → epic (optional) → issue`, and it stops there.

- A **milestone**, in a repo that uses them, is a theme bucket with a due date. Size is
  fine; **incoherence is not**. The due date orders the work, and the theme is what makes
  the bucket mean something. A repo with no milestones skips every milestone step below.
- An **epic** is a **deliverable chunk** — a slice you could hand to a wave of agents and
  merge as a unit (within one milestone, where there are milestones). It holds no work of
  its own and **closes when its children close**. An issue with no children is **not** an
  epic, however large; give it `needs-triage` and let `/grill-with-docs → /to-spec →
  /to-tickets` break it down.
- An **issue** is the atom of work. Where epics exist for its theme, every non-epic issue
  sits under exactly one. A theme small enough to need no epic can hold issues directly.

## Placing one issue

1. **Verify the body before trusting it.** A body is a dated claim; grep every identifier
   it asserts (symbol, route, CLI subcommand) — a renamed thing is invisible to the old
   name, so search the behaviour too. Fix a stale body before placing the issue on top of
   it.
2. **Pick the milestone by theme, not by due date** (skip if the repo has no milestones).
   Match the issue's subject to a milestone's theme. Never pull an issue into a nearer
   milestone just to make it "sooner" — that is how a theme bucket rots into a grab-bag.
3. **If nothing fits, STOP — do not force-fit.** An issue that matches no milestone or
   epic is a signal, not a placement problem: it belongs somewhere you haven't proposed
   yet, or its theme deserves a milestone or epic of its own. Surface it. Force-fitting is
   the drift this skill exists to prevent.
4. **Pick the epic.** List the open epics (add `--milestone "<m>"` where milestones apply):
   `gh issue list --state open --json number,title,issueType --jq '.[]|select(.issueType.name=="Epic")'`.
   Add the issue as a native **sub-issue**:
   `gh api -X POST repos/OWNER/REPO/issues/<epic>/sub_issues -F sub_issue_id=<child-id>`.
   If none fits, the issue is mis-milestoned (back to step 2) or reveals a missing epic:
   propose it, then create it with `gh issue create`, type it with
   `gh api --method PATCH repos/OWNER/REPO/issues/<n> -f type=Epic`, and parent the members.
5. **Encode the dependencies — at the right level.** Read the body for "blocks / blocked
   by / depends on / prerequisite for / after #N" and every `#N` cross-reference, and add a
   native edge for each real one:
   `gh api -X POST repos/OWNER/REPO/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-id>`.
   Where there are milestones, **the level is the rule:**
   - **Within a milestone**, encode issue↔issue (across sibling epics too — same due date,
     no boundary crossed).
   - **Across a milestone boundary**, encode **epic↔epic**, never issue↔issue. A milestone
     is a delivery boundary, so the ordering fact lives between the chunks that ship as a
     unit. An issue↔issue edge across it inverts the two due dates (the "sooner" issue
     can't ship in its window), couples two schedules too finely, and rots when either
     issue is split.
   - When a cross-milestone edge tempts you, first ask whether the **dependent issue is
     mis-milestoned** (put it with its blocker) — that resolves most of them. If the two
     really belong apart, lift the edge to the epics that own them.
6. **Type and labels.** Set exactly one native issue **type** (`Epic`, `Bug` or `Task`,
   unless the repo's conventions say otherwise) with
   `gh api --method PATCH repos/OWNER/REPO/issues/<n> -f type=Bug`, then the labels the
   repo's conventions require (priority, readiness, area).

## Two encoding traps

- **Sub-issue and blocked-by both take the integer database id**, not the `#number` and
  not the `node_id`: `id=$(gh api repos/OWNER/REPO/issues/N --jq .id)`, passed with
  `gh api -F` (typed integer), not `-f` (string — the API rejects it with
  `422 not of type integer`).
- **A closed milestone still reserves its title.** Recreating a same-titled milestone
  fails with `422 already_exists`; to reuse a retired theme, **reopen** it
  (`gh api --method PATCH repos/OWNER/REPO/milestones/<n> -f state=open`, and refresh
  `due_on`) rather than minting a duplicate — a second same-theme milestone is itself the
  drift.

## Auditing the tracker for drift

Each hit is a placement failure to fix, not just a report:

```bash
R=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# issues in no milestone (only where the repo uses milestones)
gh issue list --state open --json number,milestone --jq '[.[]|select(.milestone==null)]|length'

# non-epic issues with no parent, grouped by milestone
gh issue list --state open --json number,milestone,issueType,parent \
  --jq '.[]|select(.parent==null)|select(.issueType.name!="Epic")|(.milestone.title // "NONE")' \
  | sort | uniq -c | sort -rn

# childless epics (an epic that broke nothing down is unspecced work mistyped)
for e in $(gh issue list --state open --json number,issueType --jq '.[]|select(.issueType.name=="Epic")|.number'); do
  n=$(gh api "repos/$R/issues/$e/sub_issues" --jq 'length'); echo "$n  #$e"; done | sort -n

# two milestones for one theme (open both to compare scope; merge if they overlap)
gh api "repos/$R/milestones?state=all" --jq '.[]|"\(.state)\t\(.title)"' | sort
```

A dependency that lives only in prose (`Blocked by: #N` in a body, a "prerequisite for"
sentence) and not as a native relationship gets encoded. `issue_dependencies_summary.blocked_by`
(open blockers only) is the live gate; a prose line is invisible to it.

```bash
# issue-level edges that cross a milestone boundary (should be zero — lift them to epic↔epic).
# Only OPEN blockers gate; a closed blocker is discharged and needn't be lifted.
for n in $(gh issue list --state open --json number --jq '.[].number'); do
  cm=$(gh issue view "$n" --json milestone --jq '.milestone.title // "NONE"')
  for b in $(gh api "repos/$R/issues/$n/dependencies/blocked_by" --jq '.[]?|.number' 2>/dev/null); do
    bm=$(gh issue view "$b" --json state,milestone --jq 'select(.state=="OPEN")|.milestone.title // "NONE"')
    [ -n "$bm" ] && [ "$cm" != "$bm" ] && echo "CROSS: #$n[$cm] <- #$b[$bm]"
  done
done
```

## Red flags — placement is NOT done if

- An issue you triaged sits in a milestone or epic whose theme it doesn't match, or in no
  milestone in a repo that uses them.
- Epics exist for its theme but the issue you placed is parented to none of them.
- You created a second milestone or epic for a theme that already had one.
- You typed an issue `Epic` but gave it no native children — or parented children to it in
  prose (a task list, a "Part of #N" line) instead of native sub-issues, so the UI, the
  audit queries and vetinari's planner can't see them.
- The body says "blocked by #N" / "depends on #N" and no native `blocked_by` edge exists.
- A `blocked_by` edge crosses a milestone boundary at the **issue** level — lift it to
  epic↔epic, or re-milestone the dependent issue to sit with its blocker.
- You force-fit an issue that matched nothing instead of surfacing what's missing.
