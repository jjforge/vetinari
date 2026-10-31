# Format versions on persisted records

vetinari does not stamp a format version on its persisted records — parked
records, outbox records, host-slot leases, and registry pointers.

## Why this is out of scope

A version field earns its keep only when a reader has to tell two formats apart,
and no second format exists. Adding one now means writing and testing a field
nothing branches on, plus an "unknown version" policy for a case that cannot
happen yet.

Leaving it out costs nothing later. When a record's format first changes, the
change that introduces the new shape adds the field, and a record without one
reads as the original format:

```ts
const version = rec.version ?? 1;
```

The decision about how readers treat an unknown version belongs to that change,
when there is a real second format to reason about.

## Prior requests

- #576 — "Persisted records carry no format version"
