---
name: fileset
description: "Fill in missing file-set markers on ready-for-agent issues before a campaign. Reads each ticket against the tree, infers its Touches:/Creates: marker, and writes it back after you confirm. Run interactively before campaign-plan."
disable-model-invocation: true
---

# Fileset

`campaign-plan` keeps co-wave tickets file-disjoint by reading a `Touches:` / `Files:` / `Creates:` **marker line** from each ticket (parsed in `src/fileset.ts`; the convention is in `docs/issue-conventions.md`, "Declaring a ticket's file-set"). A ticket whose file-set can't be resolved makes the planner **halt**. Nothing else *produces* those markers, so ready-for-agent tickets routinely arrive without one and stall the planner.

This skill closes that gap: it finds marker-less tickets, works out which files each will touch — the same judgement a human makes reading a ticket against the tree — and writes the marker back, **after you confirm**. It is the pre-campaign pass you run at the pause you already take, after triage and before `campaign-plan`.

You are inferring, and inference is fallible — so a human validates every marker before it is written. Never guess wildly: when a ticket genuinely names no resolvable files, say so and leave it unmarked. That is the same honest failure `campaign-plan` surfaces today, now with a paste-ready starting point.

## What counts as a "valid marker"

Reuse the resolver's own definition so this skill skips tickets that are already fine, rather than inventing a looser one. A valid marker is an **anchored marker line** — a line that, ignoring a leading list bullet (`-`/`*`/`+`) and surrounding `**bold**`, begins with `Touches:`, `Files:`, or `Creates:` (case-insensitive) and **names at least one cite** after the colon (a file in backticks, or a bare `dir/name.ext` path). A mid-sentence mention like "reads the `Touches:` marker" does **not** count — it isn't at line start.

Since `src/fileset.ts` resolves markers from a ticket's **comments** as well as its title+body (a body/title marker wins; comments are the fallback), a ticket whose only marker lives in a comment is **already resolvable** — treat it as having a valid marker and skip it. This skill's write-back is the fallback for tickets with **no marker anywhere**.

## Process

### 1. Select the tickets

- **No args — sweep.** List open `ready-for-agent` issues and keep those with **no valid marker** in their title, body, *or any comment*:

  ```
  gh issue list --repo jjforge/vetinari --state open --label ready-for-agent --json number,title
  ```

  For each, `gh issue view <n> --json title,body,comments` and check for a valid marker per the definition above. Drop the ones that already have one.
- **Explicit ids** (`/fileset 173 176`) — operate only on those, in order. Still guard: if one already has a valid marker, skip it and say so.

Report the selected set before doing any inference, so the operator sees what you are about to work on.

### 2. Determine each ticket's file-set

For each selected issue, read the whole ticket — **title + body + every comment** (`gh issue view <n> --json title,body,comments`) — and the repo, and work out which files the work will touch, the same way a human would. Then split the cites:

- **Files that already exist in the tree → `Touches:`.** Validate each against the working tree (`git ls-files` / a direct path check); a `Touches:` cite the tree lacks is read by the resolver as a stale or typo'd note and forbids confidence, so only cite existing paths here.
- **Files the ticket will create → `Creates:`.** New paths that are legitimately absent from the tree.

Cite files in backticks, matching the convention's examples:

```
Touches (existing files): `fileset.ts`, `src/cli.mts`
Creates (new files): `event-log.ts`, `event-log.test.ts`
```

A ticket that only edits existing files carries just a `Touches:` line; one that only adds a new module carries just a `Creates:` line; one that does both carries both. Paths reduce to their basename in the resolver, so cite each file however reads clearly.

**When a ticket names no resolvable files** — the work is too vague to pin to a file-set, or names only things absent from the tree that aren't plausibly new files — do **not** invent one. Say so, leave the ticket unmarked, and move on. A missing marker the operator can see is better than a confident-looking wrong one.

### 3. Confirm, then write back

Show the operator the proposed marker line(s) for every ticket and get a **go-ahead before editing anything**. Let them correct a cite first.

On approval, add the marker to the **issue body** — `gh issue edit` replaces the whole body, so fetch the current body first and write the marker back **with it**, appended near the top (consistent with the convention's examples):

```
gh issue edit <n> --repo jjforge/vetinari --body "$NEW_BODY"
```

where `$NEW_BODY` is the marker block followed by the existing body. Tag the added block as AI-authored, e.g.:

```
> *File-set markers added by AI (`/fileset`).*

Touches (existing files): `fileset.ts`, `src/fileset.test.ts`
Creates (new files): `.agents/skills/fileset/SKILL.md`
```

**Guard against clobbering:** never overwrite a marker that is already there. Selection already excludes tickets that have one, but check again on the fetched body before writing — if a valid marker appeared since selection, skip the ticket rather than adding a second.

### 4. Report

Summarise what happened per ticket: **marked** (with the marker written), **skipped** (already had one), or **left unmarked** (no resolvable file-set — the operator now has a paste-ready starting point to fill in by hand). The unmarked ones are exactly what `campaign-plan` would still halt on, surfaced early.

## Out of scope

- Wiring this into `campaign-plan`'s halt branch — it stays a manual pre-campaign step.
- Any change to `src/fileset.ts`, `src/github.ts`, or the external `to-tickets` / `to-spec` skills. This skill only reads tickets and writes markers back via `gh`.
