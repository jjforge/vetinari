# Agent activity is captured live from the run stream, not the session log

Status: recorded in design.md §11.

The live tail renders each running agent's activity **per tool-use, as it happens**.
We decided to source that stream from the agent runner's live streaming callback
(sandcastle's `onAgentStreamEvent`, which fires per stdout line during a run),
projecting it into a **per-task, live-only `activity-<taskId>.jsonl`** under the run's
logs dir. The loop — which owns the `taskId` — also folds its own `turn`, `gate`/
`gate-result`, and per-`commit` events for that task into the same file, so the pane
tails **one** complete per-agent record. The activity event kinds live in the shared
orchestrator event union so producer and consumer share one typed schema.

## Considered Options

- **Tail the Claude session JSONL** — rejected: on the host it only lands at *iteration
  end*, so a "live" tail would advance a whole turn at a time, not per tool-use. The
  streaming callback is the only per-tool-use source.
- **Emit only the runner's typed `toolCall` events** — rejected: the runner's typed
  tool event carries only a few tools (Bash/WebSearch/WebFetch/Agent) and drops the
  file operations (Read/Edit/Write/Grep/Glob) that dominate a real agent's activity.
  The projector must parse the **raw** stream line to recover file-op tools with their
  path and size.
- **Two sources merged in the consumer** (agent stream in the activity file, gate/commit
  read from the event log by `taskId`) — rejected: it pushes a merge into every reader.
  Folding gate/commit into the single per-task file keeps the consumer to one tail.
- **Fold the activity stream into the archived event log** — rejected: it is high-volume
  and only meaningful while the agent is running, so it stays **live-only scratch**
  (the same convention as the existing per-agent and per-gate logs), never archived.

## Consequences

`gate`/`gate-result` must start carrying `taskId` (they are emitted inside the gate
runner today without it), and a per-`commit` event becomes net-new (commit SHAs are
currently buried inside `green`). The runner is passed a `logging` sink at the call
site (it is given none today, so per-tool activity is currently discarded). The raw
tool-use projector is a pure function over a stream line, unit-testable in isolation.
