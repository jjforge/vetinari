# The `turn` event carries an agent-authored one-line summary

Status: recorded in design.md §2.1.

An issue's detail view is built around a **turn log**: for each turn the agent
took, one sentence saying what happened, newest first. It is the whole reason to
open the detail sheet — it is how the operator decides whether to answer, prune, or
leave a parked issue alone. That sentence does not exist today: the `turn` event
(`src/loop.ts`) carries `turn`, `signal`, `commits`, and `usage` — machine fields,
no prose. The only English narration per issue is a single overwritten `detail`
string in the reconstruction, which keeps just the latest event.

So the agent **authors a one-line summary each turn**, and it is logged on the
`turn` event. Reconstruction retains the per-turn sequence; the dashboard renders
it verbatim. The summary is the agent's own account of the turn, because a
mechanical line synthesised from `signal` + `commits` ("Turn 6 — parked, 2
commits") says *that* the agent parked but never *why* — and the why is the entire
decision the operator opens the sheet to make.

## Considered Options

- **Synthesise the line mechanically** from the fields already on the `turn` event
  — rejected: it is free and needs no orchestrator change, but it carries no
  information the status chip and commit count don't already show. The sheet would
  exist to display nothing new.
- **Reconstruct a narrative from the raw session transcript** at render time —
  rejected: the transcript is a live-only scratch artifact (not archived), so it
  would vanish for finished runs, and parsing a model transcript into one honest
  sentence per turn is far more fragile than asking the agent for the sentence
  while it still has the context.

## Consequences

- The agent loop and its prompt gain a contract: each turn produces a short summary
  (captured the way the parked `<question>` is), added to the `turn` event's
  payload. This is a schema addition — old logs simply have no summary and render
  as before.
- Every turn now costs the agent a sentence. That is the intended price: the turn
  log is the product surface this data exists to feed.
- The summary is authored once, at the turn, and is durable in the archived event
  log — so the turn log reads identically for a live and a finished run.
