# Live dashboard updates come from watching the log files and pushing over SSE

The dashboard is read-mostly: an operator opens it to find out whether anything
needs them. For that to stay true without a manual refresh, the open page has to
learn about new events as they land. Three mechanisms were on the table — the
client polls a JSON endpoint on an interval, the server pushes over Server-Sent
Events, or a full WebSocket.

We push over **SSE**, fed by the server `fs.watch`ing each registered project's
live `orchestrator.jsonl`. The event log is the durable per-run artifact the
dashboard already reconstructs everything from (ADR 0006, and the `archived-run`
glossary entry), so an append to that file *is* the "something happened" signal —
watching it is watching the source of truth directly, not a derived feed. On a
change the server emits an SSE event and the client re-reads the affected project.
The server never needs anything *from* the client, so a one-way push fits and a
WebSocket's bidirectional channel would be unused complexity.

**Pause is a client-side presentation freeze, not a disconnect.** The stream keeps
flowing and the client keeps collecting events while paused; resuming flushes the
whole backlog that arrived in between. Pausing exists so rows stop moving while
being read — losing the events that landed during the pause would defeat the point.

## Considered Options

- **Client polls `/api/status` on an interval** — rejected: it reintroduces the
  request/response cadence the "updated Ns ago" affordance is meant to replace, and
  either wastes reads when nothing changed or lags when something did. The log
  files give an exact change signal for free.
- **WebSocket** — rejected: the dashboard is server→client only; the client issues
  its two writes as ordinary POSTs (`/answer`, `/carve`). A duplex channel buys
  nothing over SSE here and costs more to run behind the tailnet.

## Consequences

- The dashboard server gains a watcher per live project log (resolved through the
  registry, `listProjects`) and one SSE endpoint the client subscribes to. A moved
  or deleted base location is a watcher that falls away, tolerated the same way the
  gateway tolerates a stale registration (ADR 0002).
- Pause buffers client-side and flushes on resume; the server is unaware of pause.
- This assumes the watcher runs on the same host as the projects' base locations —
  true today (the shared install, ADR 0003). Serving projects on other hosts would
  reopen this.
