# Issue conventions

Reference for filing, labeling, structuring, and closing issues on
`jjforge/sandcastle-tdd`. The always-true rules — issues are the single source of
truth, file freely, no numbers in current-truth docs — live in
[`CLAUDE.md`](../CLAUDE.md); this is the vocabulary and the commands.

## Axes — type is a native issue type; every other axis is a label; the title is plain

Titles are plain and descriptive, with **no bracketed prefix** — a prefix cannot be
filtered, counted, or corrected by a query, and it rots without anything failing.

| Axis | Encoded as |
| --- | --- |
| **Type (nature)** | native GitHub **issue type**, exactly one: `Epic` (a container — holds no work of its own, closes when its sub-issues do), `Bug` (something is broken), `Task` (every other deliberate piece of work). There is no Documentation or Feature type — a doc change is a `Task` labelled `documentation`; a feature is a `Task`. |
| Priority | label, exactly one of `P0` (critical), `P1` (high — blocking), `P2` (medium), `P3` (low) — applies to **all** work (severity on a bug, priority on planned work). |
| Readiness | label — `ready-for-agent` (fully specified, runnable unattended), `ready-for-human`, `needs-info`, and `needs-triage` (the default until you are certain it is `ready-for-agent`). |
| Area | label — `orchestrator`, `gateway`, `comms`, `dashboard`, `layout`, `launcher`. |
| Lifecycle | `known-red` (a check already failing at baseline), `pending-verify` (merged on `main`, awaiting a local end-to-end validation — see Closing). |
| Shape / decision | `duplicate`, `wontfix`. |

`known-red` and `pending-verify` are **label queries, never a list in a doc** (a
doc list goes stale): `gh issue list --label known-red`,
`gh issue list --label pending-verify`. Bugs additionally carry reproduction steps
and any workaround in the body.

Type is set via the **API**, not a label:
`gh api --method PATCH repos/jjforge/sandcastle-tdd/issues/<n> -f type=Bug`.

## Hierarchy & dependencies

- **Epic → issue.** An epic is typed `Epic` (or holds native sub-issues), owns no
  work of its own, and closes when its children do. A large childless issue is not
  an epic however big it is — it is *unspecced* work; give it `needs-triage` and let
  `/grill-with-docs → /to-spec → /to-tickets` produce the children.
- **Dependencies are native.** Use GitHub's `blocked_by` dependencies, not prose in
  a body — a ticket is grabbable once all its blockers are closed:
  `gh api -X POST repos/jjforge/sandcastle-tdd/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-id>`.

## Closing — merge → `pending-verify` → close

A merge is **not** a close (and a plain `git merge` never auto-closes anyway). When
work lands on `main`, label it **`pending-verify`**; close it only after a **local
end-to-end validation** — driving the change on a local run/stack is enough, it need
not reach a remote or production. Then `gh issue close <n> -c "…"` and the label
drops with it. An epic closes when its last child closes.

**Wont-fix is a close with a reason:** the `wontfix` label plus a comment giving the
rationale, so the decision is a durable record and is not re-filed or re-argued.
