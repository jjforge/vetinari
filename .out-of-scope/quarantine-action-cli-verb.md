# Quarantine-action CLI verb

The project will not add a dedicated CLI verb to "un-quarantine", release, or
re-run a quarantined issue after its merge conflict is resolved.

## Why this is out of scope

Quarantine is **terminal by design**. Per ADR-0013 (non-atomic wave integration),
when a merge conflict quarantines an issue the campaign sets it aside and either
continues or pauses for a human — the quarantine is not a transient state waiting
for its own command to clear it. The intended recovery is a human **fix-forward
and resume**, or pruning the stranded closure:

- `campaign --resume` continues the paused campaign once the conflict is resolved
  on the base, and
- `campaign --auto-carve` prunes a quarantine's stranded dependents and runs on.

Adding an `un-quarantine` / `re-run-quarantined` verb would introduce a discrete
"clear the quarantine flag and re-attempt integration" operation the model
deliberately does not have. That contradicts the ADR-0013 framing where a
quarantine is resolved by the human resolving the underlying conflict and the
existing resume/carve verbs picking the work back up — not by a command that
treats quarantine as a reversible, addressable state. The vocabulary already has
the right verbs (`resume`, `carve`, `--auto-carve`); a quarantine-specific action
verb is surface area that fights the design rather than serving it.

A dashboard **action** for quarantine was also considered and set aside for the
same reason: with no quarantine verb to shell, the dashboard surfaces quarantine
**informationally** ("resolve the conflict, then resume") and points the operator
at the resume path (see the resume-action work).

## Prior requests

- #192 — "A quarantine-action CLI verb: re-run or release a quarantined issue after resolving the conflict"
