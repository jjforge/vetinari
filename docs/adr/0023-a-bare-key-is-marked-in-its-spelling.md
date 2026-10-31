# A bare key is marked in its spelling, not by a field

Status: recorded in design.md §4.

The planner keeps co-wave issues file-disjoint by comparing **fileKeys**. Most keys are
resolved repo-relative paths, compared exactly. A cite that cannot be pinned to one path
(an ambiguous `Touches:` cite, a bare `Creates:` cite, or a `Creates:` cite whose
directory matches several tree directories) keys to a **bare key**: the file's name
alone, standing for that name in any directory, so it collides with every file of that
name.

The planner used to tell the two apart by spelling, but implicitly: a key with no `/`
was bare. That cannot distinguish an ambiguous cite from a correctly resolved key that
happens to have no `/`, such as a repo-root file unique in the tree or, under
`packageScopedFileSet`, a top-level package `pkg`. Those were treated as bare and
collided with every same-named key elsewhere (`docs/NOTES.md`, `internal/pkg`),
serializing tickets that touch different files.

## Decision

The resolver marks a bare key **in its spelling**: `*/<name>`, read as "this name in
any directory". A key without the marker is an exact path, with or without a `/`. Two
keys collide when they are equal, or when they share a name and either carries the
marker. The `FileSet` shape (`{ files, confident }`) is unchanged.

## Rejected: a `bare: string[]` field on `FileSet`

Marking bare keys with a separate field on the exported `FileSet` type keeps every key
a plain name, but it is an `[api]` change that does not stop at the resolver. A fileKey
travels: `graft` events store fileKeys so the fold can place grafted issues (ADR 0014),
and `waivedFiles` matches entries against fileKeys. Both would have to carry the field
too, or lose which keys are bare. A key that carries its own meaning works everywhere a
string already flows: the event log, the waiver match, the dry run's listing.

## Consequences

- A `waivedFiles` entry still matches exactly: `README.md` waives only the repo-root
  file, and `*/README.md` waives the bare key.
- A `graft` event logged before this change stores its bare keys without the marker.
  They are read as exact paths; there is no translation, so a campaign with grafts is
  finished or re-launched before upgrading.
- A project's own `fileSet` resolver that emitted slash-free bare basenames must spell
  them `*/<name>`. `packageScopedFileSet` emits no bare keys and is unchanged.
