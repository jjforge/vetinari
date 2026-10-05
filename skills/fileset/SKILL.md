---
name: fileset
description: "Fill in missing file-set markers on ready-for-agent issues before a campaign. Reads each ticket against the tree, infers its Touches:/Creates: marker, and writes it back after you confirm. Run interactively before a campaign."
disable-model-invocation: true
---

# Fileset

`vetinari campaign` keeps co-wave tickets file-disjoint by reading a `Touches:` /
`Files:` / `Creates:` **marker line** from each ticket. A ticket whose file-set can't
be resolved makes the planner **halt**. Nothing else *produces* those markers, so
`ready-for-agent` tickets routinely arrive without one and stall the planner. The
convention is vetinari's `docs/issue-conventions.md`, "Declaring a ticket's file-set";
this skill restates what it needs from it.

This skill closes that gap: it finds marker-less tickets, works out which files each
will touch — the same judgement a human makes reading a ticket against the tree — and
writes the marker back, **after you confirm**. It is the pre-campaign pass you run at
the pause you already take, after triage and before a campaign.

You are inferring, and inference is fallible — so a human validates every marker before
it is written. Never guess wildly: when a ticket genuinely names no resolvable files,
say so and leave it unmarked. That is the same honest failure `campaign --dry-run`
surfaces today, now with a paste-ready starting point.

This is **pure inference** — you read tickets with `gh`, read the tree with `git` and
file reads, decide, and write markers back with `gh`. You invoke no build tool; the
judgement of whether a ticket is usable is your own read of it, not a command's verdict.

## What counts as a "valid marker"

A ticket has a valid marker only when, reading its **title, body, and comments**, you
find an anchored marker line whose cites actually resolve. Deciding that is your job —
make the same read the planner makes and mark exactly the tickets it would otherwise
halt on.

An **anchored marker line** is a line that, ignoring a leading list bullet (`-`/`*`/`+`)
and surrounding `**bold**`, begins with `Touches:`, `Files:`, or `Creates:`
(case-insensitive). That is **necessary but not sufficient** — the line's cites must
actually **resolve**:

- a real backticked cite (`` `report.go` ``) or a bare `dir/name.ext` path;
- for `Touches:`/`Files:`, a file the working tree actually has;
- for `Creates:`, a new path that is legitimately absent from the tree.

A line that is anchored but whose cites don't parse or don't check out is **not** a
valid marker, and the ticket must be **selected**, not skipped. The shapes that fail:

- **Backslash-escaped backticks** — `` \`report.go\` `` instead of
  `` `report.go` ``: the anchored line is present, but nothing parses out of it as
  a cite, so it does not resolve.
- **A bare non-path token** — `Touches: report` (no extension, no directory): not a
  backticked cite and not a `dir/name.ext` path, so it does not resolve.
- **A tree-absent `Touches:` cite** — a `Touches:` cite naming a file the tree lacks is
  read as a stale or typo'd note and forbids confidence.

Markers may live in a ticket's **comments** as well as its title+body — a resolvable
marker in the body or title wins, and a comment is the fallback. So a ticket whose only
*resolvable* marker lives in a comment is **already usable** and this skill skips it.
This skill's write-back is the fallback for tickets that have no resolvable marker
anywhere.

## Process

### 1. Select the tickets

- **No args — sweep.** List open `ready-for-agent` issues, read each against the rule
  above, and keep the ones that carry no resolvable marker:

  ```
  gh issue list --state open --label ready-for-agent --json number,title
  gh issue view <n> --json title,body,comments
  ```

  Keep the ids with no resolvable marker — those are exactly what `campaign` would halt
  on, whether they carry no marker at all or an anchored marker whose cites don't
  resolve (escaped backticks, a bare non-path token, a tree-absent `Touches:` cite).
  Drop the ones that already have a resolvable marker — the planner already accepts them
  (including a ticket whose only resolvable marker lives in a comment).
- **Explicit ids** (`/fileset 173 176`) — operate only on those, in order. Still guard:
  read each against the rule and skip the ones that already have a resolvable marker,
  saying so.

Report the selected set before doing any inference, so the operator sees what you are
about to work on.

### 2. Determine each ticket's file-set

For each selected issue, read the whole ticket — **title + body + every comment**
(`gh issue view <n> --json title,body,comments`) — and the repo, and work out which
files the work will touch, the same way a human would. Then split the cites:

- **Files that already exist in the tree → `Touches:`.** Validate each against the
  working tree (`git ls-files` / a direct path check); a `Touches:` cite the tree lacks
  is read as a stale or typo'd note and forbids confidence, so only cite existing paths
  here.
- **Files the ticket will create → `Creates:`.** New paths that are legitimately absent
  from the tree.

Cite files in backticks:

```
Touches (existing files): `cmd/app/main.go`, `Makefile`
Creates (new files): `internal/report/report.go`, `internal/report/report_test.go`
```

**Docs count as files.** A README or `docs/*` file the change must update — because it
documents the flag, command, config field or behaviour being changed — goes on the
`Touches:` line like any source file. The planner schedules co-wave tickets by the marker
alone, so two tickets editing the same doc that neither marked collide at merge.

**So do the CLI files.** A change that adds, removes or renames a command or flag, or
changes its `--help` text, lists `src/help.ts` (the `MODES` table drives `--help`), and
`docs/reference.md` too whenever it touches `MODES` (the reference's modes block is
generated from it and a test pins the two together; a help-footer-only change leaves the
reference alone). Add `src/cli-dispatch.ts` for a post-config command (parsed by
`parseArgs`, run by `dispatch`), or `src/cli.mts` for a host-level command handled inline
in the entry point, or when the change hands a new dependency to `dispatch`.

A ticket that only edits existing files carries just a `Touches:` line; one that only
adds a new module carries just a `Creates:` line; one that does both carries both. A
`Touches:` cite resolves by matching the tail of its path against the tree, so a bare
`main.go` and a full `cmd/app/main.go` both work, but a bare name the tree holds several
times collides with every file of that name; cite enough of the path to make it unique.
`Creates:` cites have no tree to resolve against and collide by basename.

**Never cite the changelog fragment.** The `changelog.d/<issue>.md` a campaign agent
writes is per-issue by construction, so it cannot collide and the planner gains nothing
from hearing about it. Citing it does harm: the marker carries the literal placeholder,
so every such ticket shares the basename `<issue>.md`, every pair collides, and the
planner runs one ticket per wave. A ticket whose only new file is its fragment carries
**no** `Creates:` line; it still writes the fragment when the work lands.

**When a ticket names no resolvable files** — the work is too vague to pin to a
file-set, or names only things absent from the tree that aren't plausibly new files — do
**not** invent one. Say so, leave the ticket unmarked, and move on. A missing marker the
operator can see is better than a confident-looking wrong one.

### 3. Confirm, then write back

Show the operator the proposed marker line(s) for every ticket and get a **go-ahead
before editing anything**. Let them correct a cite first.

On approval, add the marker to the **issue body** — `gh issue edit` replaces the whole
body, so fetch the current body first and write the marker back **with it**, appended
near the top:

```
gh issue edit <n> --body "$NEW_BODY"
```

where `$NEW_BODY` is the marker block followed by the existing body. Tag the added block
as AI-authored, e.g.:

```
> *File-set markers added by AI (`/fileset`).*

Touches (existing files): `internal/report/report.go`
```

**Guard against clobbering:** never overwrite a marker that is already there. Selection
already excludes tickets that have one, but check again on the fetched body before
writing — if a valid marker appeared since selection, skip the ticket rather than adding
a second.

### 4. Report

Summarise what happened per ticket: **marked** (with the marker written), **skipped**
(already has a resolvable marker), or **left unmarked** (no resolvable file-set — the
operator now has a paste-ready starting point to fill in by hand). The unmarked ones are
exactly what `campaign` would still halt on, surfaced early.

To confirm the markers now resolve, run the planner over the selected ids with the halt
pre-decided to a drop rather than an interactive stop:

```
vetinari campaign --dry-run --on-underspecified=drop <ids>
```

It plans without running anything and drops (rather than halts on) any id still
underspecified, so the printed plan shows exactly which markers the planner now accepts
and which it would still skip — the machine confirmation that a freshly written marker
resolves.

## Out of scope

- Wiring this into the planner's halt branch — it stays a manual pre-campaign step.
- Any change to vetinari itself, or to the `to-tickets` / `to-spec` skills. This skill
  only reads tickets (via `gh` and file reads) and writes markers back via `gh`.
