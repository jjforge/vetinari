# One narration table for the feed and the log view

vetinari keeps two narrations of its events: the one-line sentence the
activity feed and the landing card's last-event line show (`describeEvent`),
and the structured row the log view and the live tail show (`humanizeLogLine`:
time, actor, verb, styled spans, dot). Merging them into one table, with the
sentence derived from the row, is not planned.

## Why this is out of scope

The two look like copies but serve different readers, and they differ on
purpose:

- **Wording.** For the same event they say different things. A `failed` row
  reads `failed` with the issue in its own actor column, while the feed says
  `#202 failed — could not be made green`. A `turn` row reads `turn 3 …`, while
  the feed shows the agent's summary. The feed narrates `re-admit`; the row
  falls back to its generic summary.
- **What is shown at all.** The feed and the last-event line depend on
  `describeEvent` returning nothing for machine noise (tool calls, gates,
  spawns, unknown kinds), as ADR 0008 relies on. A row is never blank. Deriving
  the sentence from the row would flood the feed with every tool call unless a
  separate visibility rule were added.
- **Dots.** Renaming the row's dot vocabulary to the status tokens reaches the
  archived-run dot, the host-log narration and a fallback in the browser
  script, for no change anyone sees.

So one table would mean deciding a single wording for every event kind,
adding feed-visibility rules and migrating the dots. That is a large change,
and the deletion test fails: collapsing the two changes what people read
rather than removing duplication. Where the two must agree on a fact, fix both
narrations together, as the green-versus-merged wording was fixed.

## Prior requests

- #695 — "Merge the two event narration tables into one" (re-scoped to the
  green-versus-merged wording bug)
