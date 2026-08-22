# sandcastle-tdd — working agreement

This file is always-on context, so it is read as *current truth*. Keep it
number-free (see the no-numbers rule below) and keep it to rules, not state.

## Work tracking — GitHub issues are the single source of truth

**GitHub issues on `jjforge/sandcastle-tdd` are the single source of truth for
all work** — bugs, features, follow-ups, deferred items, "do this next". Every
loose end gets an issue; never leave one only in a scratch note, a plan doc, or a
chat. There is **no backlog file** — no `NEXT-STEPS.md`, no `ROADMAP.md`; do not
create one. "What's next" is the highest-priority open `ready-for-agent` issue
whose blockers are all closed — read it from the tracker, not a file.

**Filing one needs no permission — file it when you find it.** An issue changes
no code and ships nothing, so it is not an outward action that needs a confirm; it
is a note in a queue, edited or closed as cheaply as it was opened. A finding you
carry to the end of a turn instead of filing is lost, because you are the only one
who saw it. Say what you saw and where, name the work you were doing when you
found it, and label it per the conventions below. **Do not fold the finding into
the change you are making** — that is the thing filing exists to prevent.

**No issue numbers in always-on context.** A number written into this file,
`CONTEXT.md`, `docs/adr/`, or the memory store cannot stay true — the issue closes
and the text still implies pending work, or the number was never right and nobody
can tell by reading. Describe the *behaviour* — "a carve of a merged target still
dropped its dependents" — and let the tracker hold the number. Where you need the
live set, run the query at the moment you need it (`gh issue list --label …`,
`gh issue search "<behaviour>"`). The rule is about *storing* numbers as current
truth, not using them: **cite issue numbers freely in commits, `CHANGELOG.md`
bullets, issue comments, and what you report to the user** — those are dated
records pinned to a moment, so a number in them stays accurate.

## Conventions — type is a native issue type; every other axis is a label; the title is plain

Titles are plain and descriptive, **with no bracketed prefix** — a prefix cannot
be filtered, counted, or corrected by a query, and it rots without anything
failing. Each axis lives in a label, except the work's *nature*, which is a native
GitHub **issue type**.

| Axis | Encoded as |
| --- | --- |
| **Type (nature)** | native GitHub **issue type**, exactly one: `Epic` (a container — holds no work of its own, closes when its sub-issues do), `Bug` (something is broken), `Task` (every other deliberate piece of work). Set: `gh api --method PATCH repos/jjforge/sandcastle-tdd/issues/<n> -f type=Bug`. There is **no Documentation or Feature type** — a doc change is a `Task` labelled `documentation`; a feature is a `Task`. |
| Priority | label, exactly one of `P0` (critical), `P1` (high — blocking), `P2` (medium), `P3` (low) — applies to **all** work (severity on a bug, priority on planned work) |
| Readiness | label — `ready-for-agent` (fully specified, runnable unattended), `ready-for-human`, `needs-info`, and `needs-triage` (the default until you are certain it is `ready-for-agent`) |
| Area | label — `orchestrator`, `gateway`, `comms`, `dashboard`, `layout`, `launcher` |
| Lifecycle | labels `known-red` (a check already failing at baseline) and `pending-verify` (fixed on `main`, not yet verified end-to-end) |

`known-red` and `pending-verify` are **label queries, never a list in a doc** — a
doc list goes stale as issues are added and not: `gh issue list --label known-red`,
`gh issue list --label pending-verify`. Bugs additionally carry reproduction steps
and any workaround in the body.

## Hierarchy, dependencies, and closing

- **Epic → issue.** An epic is typed `Epic` (or holds native sub-issues), owns no
  work of its own, and closes when its children do. A large childless issue is not
  an epic however big it is — it is *unspecced* work; give it `needs-triage` and
  let `/grill-with-docs → /to-spec → /to-tickets` produce the children.
- **Dependencies are native.** Use GitHub's `blocked_by` issue dependencies, not
  prose in a body — a ticket is grabbable once all its blockers are closed. Set one
  with `gh api -X POST repos/jjforge/sandcastle-tdd/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-id>`.
- **Close on merge.** A plain `git merge` does **not** auto-close the issue — close
  it explicitly when its work lands (`gh issue close <n> -c "…"`). An epic closes
  when its last child closes.

## Running a campaign (issues → waves)

sandcastle-tdd runs `ready-for-agent` tickets through its own `campaign` mode in
dependency-ordered waves. Build the wave list with **`campaign-plan <ids…>`** (it
plans; it never runs sandcastle or pushes). Two invariants it enforces — the
`blocked_by` graph alone gives neither:

1. **Maintain the ticket DAG** — a ticket's wave comes after every open in-campaign
   blocker's wave (waves are the DAG's topological layers).
2. **No two tickets in one wave edit the same file** — crossover is not in the DAG,
   so each layer is partitioned into **file-disjoint** sub-waves, collision judged
   by **basename**. Each ticket body carries a
   `Touches (existing files): \`a.ts\`, \`b.ts\`` line the file-set resolver reads.

Parallelize **across epics** — epics carry no inherent order, so a wave normally
spans several; never serialize by epic. The campaign drains a wave, merges its
greens, gates the **merged** base, then advances; it halts and rolls back on a
conflict or red base, and it advances the base locally without pushing. The
merged-base gate is integration, not live verification — verify a real run before
closing.
