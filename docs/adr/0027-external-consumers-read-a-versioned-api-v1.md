# External consumers read a versioned `/api/v1/`

Status: recorded in design.md §11.

An outside agent should be able to watch running campaigns — list projects, see
each campaign's waves and members and their status, see parked work and why it
parked, and follow changes live — without scraping the dashboard. The data was
already served: the dashboard's `GET /api/status` returns its view model as JSON,
and `GET /api/events` streams raw orchestrator events. But those shapes are
dashboard internals. They carry render fields (a running issue's phase, a wave's
time split, a festive-name offset), use absent-means-empty fields, and type a park
reason as a free string. A dashboard refactor could rename or reshape a field and
silently break an outside consumer, with no test to catch it.

We add a **separate `/api/v1/` namespace** for outside consumers:
`GET /api/v1/projects`, `GET /api/v1/campaign?project=<name>` and
`GET /api/v1/events`. Its documented shapes are in [`docs/api.md`](../api.md).

- **Its own mapping functions.** The v1 JSON is built by explicit mappers that
  copy named fields out of the dashboard model. They never spread or pass a model
  object through, so a field added to or renamed in the dashboard model cannot
  reach v1 JSON. The dashboard is free to diverge.
- **The orchestrator's vocabulary.** Every status and reason is the orchestrator's
  own enum value (ADR 0007, ADR 0019's single `parked` state), never a display
  string, and every field is always present, `null` when empty.
- **The stream is a doorbell.** `/api/v1/events` carries no event payloads, only
  which project changed (`null` on connect, meaning everything); the consumer
  re-fetches. Payload-free frames keep the event schema out of the contract and
  make a missed frame harmless.
- **Path-prefix versioning, additive-only within v1.** A new field, endpoint, or
  enum value (only when the orchestrator's own enum gains one) may land in v1.
  Renaming or removing a field, or changing its type or meaning, needs
  `/api/v2/`. The dashboard's own `/api/*` stays unversioned and is not a
  contract.
- **Enforced by a contract test.** `src/dashboard-route-api-v1.test.ts` pins every
  shape with `deepStrictEqual` against a literal of the exact JSON, round-tripped
  through `JSON` so an `undefined` cannot hide. Breaking the contract means
  editing that literal: a deliberate, visible change.

## Considered Options

- **Promote the existing routes** (`/api/status`, `/api/events`) to the contract —
  rejected: it would freeze the dashboard's view model, so every UI change would
  have to keep the outside contract, and those shapes carry render fields and
  display-shaped reasons a consumer should not depend on.
- **A `schemaVersion` field** instead of a path prefix — rejected: a consumer
  learns of a break only after it has read a response it may misparse, and the old
  and new shapes cannot be served side by side. A path prefix lets v1 and v2
  coexist while consumers move.
- **The event-log JSONL as the contract**, with HTTP as transport — rejected: the
  log is the orchestrator's internal record and grows new event kinds freely, and
  folding it into campaign state is the reducer's job (ADR 0005). Every consumer
  would have to re-implement that fold, and the fold would become the contract.
- **A separate read-only port or bind**, so the API is reachable without exposing
  the write routes — rejected as out of scope for now. The API is served on the
  dashboard's port under the same refusals, keeping ADR 0021's posture: no
  authentication, private network only, the Host and Origin checks, and the
  Docker-peer refusal of agent containers.

## Consequences

- An outside consumer reads one documented page and a set of enums, and is
  insulated from dashboard refactors.
- Every v1 field costs a mapper line and a test literal line, and the mapper must
  be kept in step when the orchestrator's model changes meaning.
- Webhooks, an MCP server, write routes, and the issue detail, turn log, live tail
  and host log are not in v1. Any of them can be added later, additively.
