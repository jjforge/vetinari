# File overlap is a per-project opt-in

Status: recorded in design.md §4 and §9.

The planner keeps co-wave issues **file-disjoint**: two issues whose fileKeys collide
never run in the same wave. That is a pessimistic lock. It holds two issues apart even
when their edits would merge cleanly — two issues touching different functions of one
file — and a real collision is already handled at merge: the conflicting green is
retried once in its wave by its own agent, and parks `conflict` only if it collides
again, while the rest of the wave still merges (ADR 0013).

## The decision

A project config gains **`fileOverlap: "strict" | "allow"`**, resolved to `"strict"`
when absent; any other value is refused at config load.

- **`"strict"`** is today's rule, unchanged: the planner, `graft` and `replan` keep
  co-wave issues file-disjoint.
- **`"allow"`** drops file-disjointness entirely for that project. The planner and
  `replan` layer waves by **dependencies alone**, and a graft is placed by its
  dependencies and the pinned-wave rule alone. File-sets are still resolved, so an
  under-specified issue still halts the plan; they are reported, not enforced.

Under `"allow"`:

- **A collision is caught at merge.** The conflicting green is retried once, in its
  wave, by the issue's own agent (logged as a re-admit, not a park); a second collision
  parks it `conflict`, as today.
- **A clean merge that breaks the build** is caught by the merged-base gate
  (`red-base`), as today. A replay found none among cleanly merged pairs on this
  project; revisit if red bases show up once projects opt in.
- **`campaign --dry-run` lists every overlap it did not enforce** — each pair of co-wave
  issues whose keys collide, with the key — and bounds the wave count by dependency
  depth alone, since no file group holds a wave apart. The most-shared files are still
  listed, as information.
- **A graft's event carries `fileOverlap: "allow"`**, so the fold places it the same
  way on every replay. A graft event without the marker — every strict graft, and
  every graft logged before the setting — replays file-disjointly, as it always did. A
  `replan` event records its resulting waves, so it needs no marker (ADR 0022).

Generated files that ride along with their source are not a new mechanism: they go in
`waivedFiles`.

## Evidence

A replay of the archived campaigns (about a hundred campaigns, about a thousand
issues):

- **About half of all waves exist only because of file overlap**: dependency depth
  alone accounts for about half the waves real plans had.
- **12–20 conflict parks per 100 overlapping merges** if file-disjointness were dropped
  with no retry. About half the sampled conflicts were mechanical (list or test
  appends), and generated-file conflicts were only shifted line numbers.
- **With one in-wave retry**, costing a fraction f of the issue's own agent time plus
  one more integration, total wall clock drops about 7–19% depending on f, against a
  ceiling of about 25% with no collisions at all.
- **Second-collision parks** run 0–4.7 per 100 merges on the busiest project, which is
  the main risk.

## Rejected: a per-file strict list

Dropping the rule except for a per-project list of files that stay strict did **worse**
on replay than dropping it everywhere: the hot files sit on too many issues, so keeping
them strict keeps most of the waves the lock created.

A middle setting is likewise left out; there are two modes.

## The pilot

`"strict"` stays the default and ships everywhere. Vetinari is the pilot: the maintainer
flips it to `"allow"` once this is verified, because under the strict rule co-wave
issues never share a file, so the retry has never fired and its real cost (f) cannot be
measured until a project allows overlap. The pilot measures how often the retry
succeeds and what it costs; another project's opt-in is decided from those numbers and
per-key collision rates.
