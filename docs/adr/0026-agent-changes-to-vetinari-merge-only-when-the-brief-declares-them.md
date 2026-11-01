# Agent changes to vetinari/ merge only when the brief declares them

Status: recorded in design.md §6.

## The trust boundary

`loadConfig` **imports** `vetinari/config.mts`: it executes on the host, outside every
sandbox. A campaign starts each member as a child CLI in the project root — the very
checkout its waves merge into — and each child loads the config again, as do the
`answer`/`prune`/`redrive` children the dashboard and Telegram start. So a
`vetinari/config.mts` an agent merges in one wave runs on the host in the next, inside
the same campaign, before a human has looked at it. `vetinari/Dockerfile` is the image
recipe for every later run.

An agent's change under `vetinari/` is therefore host code execution, and only a
human can authorize it. Briefs are human-written, and a campaign agent cannot edit an
issue (it has no tracker login), so a path declared on the issue is a human's
authorization.

Agents do change `vetinari/` legitimately when a brief asks them to — adding a lint
gate to the config, changing the Dockerfile — and those briefs declare the path on
their marker line.

## The decision

At integration, right after a member's merge succeeds and before the `perMerge`
gates, the paths the merge changed are listed with
`git diff --name-only --no-renames <pre-merge> HEAD` (`--no-renames`, so a move out of
`vetinari/` still shows its `vetinari/` side). Every one under `vetinari/` must be
**declared**: matched, the way the planner matches fileKeys (an exact path, or a bare
`*/` key with the same basename), by a key the issue resolves to.

- **The issue is read live**, every time a merge touches `vetinari/`: fetched then and
  resolved the planner's way (the project's `fileSet`, else the default resolver),
  without `waivedFiles` — those waive planning collisions, not this check. The plan's
  snapshot is never used, so a human who declares the path and redrives gets it
  merged. If the issue can't be read, the merge is undone before the error ends the
  campaign, so a redrive checks it again.
- **Only an explicit marker line declares** — `Touches:`/`Files:`/`Creates:`. With
  none, the issue declares nothing, even where the resolver's whole-body fallback would
  read a cite out of its prose.
- **An undeclared path is a failed per-merge check**, handled exactly like one: only
  that member's merge is undone (`git reset --keep`), the `perMerge` gates do not run on
  it, and it is a collision with the gate `vetinari-paths` and the undeclared paths. The
  campaign re-admits it once; its prompt names the paths and tells the agent to drop
  those changes, because its brief does not declare them. If the retry's merge still
  changes an undeclared `vetinari/` path, the issue parks `conflict`, asking a human to
  declare the paths on the marker line and redrive, or merge it by hand.

The host never runs a CLI against an undeclared `vetinari/` change: it is undone before
the next member merges or the next wave starts.

## Scope

Only `vetinari/**`, fixed. `src/` — including the dogfood repository's own host-run
code — is out of scope: marker lines are planning hints, and agents routinely and
rightly touch `src/` files their brief did not name. Holding every path to the marker
line would turn a planning hint into a merge gate and park ordinary work. The protected
set is not configurable.

## Known limit

A merge already on the base after a crash, which redrive recognises as already merged,
is not re-checked: its merge may no longer be the newest commit, so it cannot be
undone the way a fresh one is. The window is a crash between a member's merge and this
check.

## Rejected: always park a vetinari/ change

Park every merge that touches `vetinari/` for a human to merge. Simple, but it parks
the briefs that ask for exactly that change, and the human has already said yes by
writing the brief.

## Rejected: trust and document

Leave merges as they are and document that `vetinari/` changes run on the host.
Documentation does not stop a green branch from executing on the host in the next wave
of the same campaign, before anyone reads it.
