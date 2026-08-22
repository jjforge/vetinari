# The status dashboard is the registry-backed aggregated server; the standalone single-project server is retired

E5 (ADR 0002, #16) shipped two status servers: the original single-project
`serveStatus`, and a gateway-hosted aggregated `serveAllStatus` with a project
dropdown over the host registry. E5 deliberately **kept** the standalone one as a
"run one project without a gateway" fallback (story 8). We now retire it: the
`status` CLI mode serves the **aggregated** server, and the single-project
`serveStatus` + its `renderCarvePreview` page are removed.

The reason the standalone server existed is now covered for free. **Auto-register
on run (#22)** writes every project's pointer into the host registry whether or
not a gateway is running, and `serveAllStatus` reads that registry **without the
gateway daemon** — it is just an HTTP server over `listProjects(...)`. So a
single-project, no-gateway user is simply a **one-entry dropdown** on the
aggregated view. Maintaining a second, parallel render path bought nothing but
duplication.

## Considered Options

- **Keep both servers** (the E5 status quo) — rejected: two render paths and two
  carve-preview implementations to keep in step, for a single-project case the
  aggregated server already covers as a one-entry dropdown.
- **Make the aggregated server require the gateway daemon** — rejected: it needs
  only the registry (which auto-register always populates), so coupling it to the
  daemon would reintroduce exactly the "need a gateway to see status" problem the
  standalone server was there to avoid.

## Consequences

- The `status` CLI mode now serves `serveAllStatus` over the registry; there is
  one dashboard, not two. A single-project user sees a one-entry dropdown.
- The standalone `serveStatus` and the standalone `renderCarvePreview` page are
  deleted; the aggregated site's server-side preview
  (`renderAggregatedCarvePreview`) remains as the no-JS carve fallback.
- This reverses E5 story 8. It is safe only because auto-register makes the
  registry always present — if that ever changes, this decision must be revisited.
