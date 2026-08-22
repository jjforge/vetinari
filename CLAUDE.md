# sandcastle-tdd — working agreement

This file is always-on context, so it is read as *current truth*. Keep it
number-free (see the no-numbers rule below) and keep it to rules, not state.

## How to work

These govern every change — yours interactively and every campaign agent's (the
TDD prompt reads this file first and lets it override).

**1. Think before coding.** Do not assume, hide confusion, or silently pick one
reading of an ambiguous request. State your assumptions explicitly; when the
ambiguity actually changes the outcome, lay out the interpretations instead of
guessing; point out a simpler alternative and push back when you see one. *Where
you would "ask":* interactively, ask. In a **headless campaign run** there is no
one to ask, so the only "ask" is the `BLOCKED` signal (`prompts/tdd.md`) — used
**only** for genuine ambiguity in the interface or intent, never as a routine gate;
otherwise treat the acceptance criteria and the existing seams as the agreement and
proceed.

**2. Simplicity first.** Write the minimum code the request needs — nothing
speculative. No unrequested features, no abstraction for one-time code, no
hypothetical flexibility or configurability, no handling for impossible scenarios.
If 200 lines could reasonably be 50, make it 50. The test: *would a senior engineer
call this overcomplicated?*

**3. Make surgical changes.** Touch only what the request requires, and clean up
only the mess your own change makes. Do not "improve" neighbouring code, comments,
or formatting; do no unrelated refactoring; match the repo's existing style. Remove
an import, variable, or function only when your change made it obsolete; *mention*
unrelated dead code rather than deleting it. Every changed line should trace back to
the request. (Refactoring the code your slice **touches** is the TDD loop's refactor
step and is fine — this bans the *drive-by* kind on code you were not sent to touch.)

**4. Goal-driven execution.** Define the success criteria and continue until they
are verified: "add validation" → failing invalid-input tests, then green; "fix the
bug" → a failing test that reproduces it, then green; "refactor X" → passing tests
before and after. Pair each step of multi-step work with an explicit check. For
campaign work this *is* the `tdd` skill's loop — let it drive; this rule is the same
discipline for interactive and non-TDD changes.

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

## Changelog — log every user-facing change as part of landing it

**Every change that adds or alters a command, flag, behaviour, config surface, or
output gets a [`CHANGELOG.md`](CHANGELOG.md) `[Unreleased]` entry** (under
`Added`/`Changed`/`Removed`/`Fixed`), citing the issue — in the same change that
lands it, not a later pass. A purely internal refactor with no user-visible effect
needs none. `CHANGELOG.md` is a dated record, so cite issue numbers in its bullets
freely (the no-numbers rule above is about always-on *current-truth* docs only).

This is enforced on the **implementing agent** via `prompts/tdd.md` (the TDD prompt
every campaign run drives) — not in `to-tickets`/`/implement`, which are external
skills we do not own, so the rule has to live where we control it: this file and
the prompt.

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
| Lifecycle | labels `known-red` (a check already failing at baseline) and `pending-verify` (merged on `main`, awaiting a local end-to-end validation — see Hierarchy below) |
| Shape / decision | labels `duplicate` and `wontfix` (closed as a deliberate decision not to do it) |

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
- **Merge → `pending-verify` → close (a merge is not a close).** A plain `git
  merge` never auto-closes the issue, and it should not be closed yet either: when
  the work lands on `main`, label it **`pending-verify`**. Close it only after a
  **local end-to-end validation** — driving the change on a local run/stack is
  enough; it need not reach a remote or production. Then `gh issue close <n> -c
  "…"` (the label drops with it). An epic closes when its last child closes.
- **Wont-fix is a close, with a reason.** When we decide an issue will not be done,
  close it with the **`wontfix`** label and a comment giving the reason — the
  closed, labelled issue is the durable record of the decision, so the same thing
  is not re-filed or re-argued later.

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
merged-base gate is integration, not live verification — so a merged ticket is
`pending-verify` until a local run confirms it (see Hierarchy above), then it
closes.
