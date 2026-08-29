# The orchestrator pipeline is integration-tested through a local sandbox

The orchestrator's hard behaviors — per-issue gate, green→merge, conflict→quarantine,
the merged-base gate, and the park→drain→wave-park escalation (ADR 0013, ADR 0017) —
are each unit-tested against real on-disk state, but **every unit test stubs the seams
on both sides of the unit under test**: the loop test scripts the sandbox and the git
reads, the campaign test stubs `spawnRun`/`integrate`/the gate, the merge test stubs
the gate. No test drives `agent → gate → merge → advance` as one chain, and the real
`Sandbox`'s execution edge (its `exec`, the thing that actually runs the gates) is
neither faked nor executed under test. A regression that mis-wires two green units — or
that lets a red suite read green across the gate→merge boundary — has nothing to catch
it.

## Decision

Add a **local sandbox**: a no-container `Sandbox` implementation that runs the *real*
gates and *real* git against a temporary checkout. Its `exec` actually runs
`git diff --name-only` and each gate command in the worktree; its `run` (the agent turn,
the one thing that cannot be real without an LLM) invokes a **test-supplied agent-script**
that makes real commits on the issue branch and returns a completion signal.

One integration test drives a real `campaign` wave through it and asserts the spanned
outcome. The test fakes **only the container boundary** — the sandbox factory (real
container → local sandbox) and the process-spawning `spawnRun` (child `run` process →
in-process loop). Everything downstream of the agent turn runs for real: gate selection
and exit codes, the merge and its conflict→quarantine path, the merged-base gate, the
changelog fold, the merged-issue hook, and the wave-advance / wave-park decision.

This is a **second, slower test tier, not a replacement**. The existing unit tests keep
their bespoke stubs; the local sandbox exists to span the seams they each cut.

## Consequences

- A wiring regression between the gate, merge, and wave-advance seams has a home — the
  class of bug the stub-on-both-sides unit tests structurally cannot see.
- The container edge (the agent turn plus the sandbox factory) stays the **only** fake in
  the spanning test; the rest of the pipeline is exercised, not swapped.
- Because it runs real git and real gates, a span is slow relative to a unit test, so the
  suite keeps **one focused span per outcome** rather than a per-permutation matrix. The
  happy path lands first; the failure-path spans (quarantine, wave-park, red merged base)
  are added incrementally on the same harness.
- The local sandbox is a real second adapter behind the `Sandbox` seam, so a unit test
  that today hand-rolls a sandbox stub may later adopt it — but that migration is not
  required by this decision.
