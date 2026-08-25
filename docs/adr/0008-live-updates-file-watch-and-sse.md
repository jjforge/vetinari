# Live dashboard updates come from watching the log files and pushing over SSE

The dashboard is read-mostly: an operator opens it to find out whether anything
needs them. For that to stay true without a manual refresh, the open page has to
learn about new events as they land. Three mechanisms were on the table — the
client polls a JSON endpoint on an interval, the server pushes over Server-Sent
Events, or a full WebSocket.

We push over **SSE**, fed by the server `fs.watch`ing each registered project's
live-run `logs/` directory. The event log (`orchestrator.jsonl`) is the durable
per-run artifact the dashboard already reconstructs everything from (ADR 0006, and
the `archived-run` glossary entry), so an append to it *is* the "something happened"
signal — watching it is watching the source of truth directly, not a derived feed.
We watch the containing directory rather than the file itself so a run whose log
does not exist yet, or one that rotates the file, still registers. On a change the
server emits an SSE event and the client re-reads the affected project. The server
never needs anything *from* the client, so a one-way push fits and a WebSocket's
bidirectional channel would be unused complexity.

**Filter, then debounce, before pushing.** Not every append is worth a refresh. The
render path already skips machine-noise (`describeEvent` returns nothing for it), and
the emit path applies the same idea: appended events are first passed through a
**fail-open denylist** — a small set of known side-channel kinds (a failed message
send, an outbound-queue enqueue) that change no rendered view — and a frame is
pushed only when a view-relevant event survives. It is a denylist, not an allowlist,
because the per-repo page renders more than the cross-project feed (its issue-detail
sheet folds turn/gate/worktree rows), so an allowlist keyed on the feed would drop
events the detail view needs; fail-open means an unrecognized kind still refreshes.
The survivors are then **debounced per project** into a single frame per short
window, so a burst of appends during an active run yields one refresh, not one per
line.

**The client re-fetches softly, never a full reload.** Both surfaces re-fetch and
patch in place rather than reloading the page: the landing rebuilds its cards from
`/api/landing`, and the per-repo page re-fetches its own HTML and swaps only its
live region (parked cards, campaign meta, wave grid), leaving the issue sheet, its
open reply/compose, the archived-runs list and the scroll position untouched. A full
page reload blanked the view and lost scroll and half-typed replies — worst over the
tailnet — which the whole live-update affordance exists to avoid.

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

- The dashboard server gains a watcher per live project logs directory (resolved
  through the registry, `listProjects`) and one SSE endpoint the client subscribes to.
  A moved or deleted base location is a watcher that falls away, tolerated the same way
  the gateway tolerates a stale registration (ADR 0002).
- Each SSE connection holds a small per-project debounce buffer (the surviving events
  awaiting their flush) and a pending timer, both torn down when the connection closes.
  The filter denylist is a curated set: a genuinely new view-relevant event kind must be
  kept out of it, but fail-open means the cost of forgetting is a wasted refresh, never a
  missed one.
- Pause buffers client-side and flushes on resume; the server is unaware of pause.
- This assumes the watcher runs on the same host as the projects' base locations —
  true today (the shared install, ADR 0003). Serving projects on other hosts would
  reopen this.
