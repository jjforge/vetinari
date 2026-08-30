# A wave gates the next on a healthy base and zero parks: a per-issue park escalates to a wave-park

Status: superseded by design.md §5.

Only a red combined gate held a wave ([ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md)). A **per-issue park** — an agent that asked a question, produced no change, or ran out of turns — was folded into the wave's non-green `held` set, its parked record cleared, and the campaign advanced to the next wave. So a wave could read **done**, and succeeding waves build on top, while an issue in it still waited on a human.

Worse, the park went **dark**. The parked record that drives the dashboard's parked surfaces and the gateway's Telegram announcement is the same record cleared at the wave boundary (and again at archive), so the question vanished from the dashboard, the run reported a clean "complete", and the dropped issue was left un-merged and no longer resumable. A human who missed the one announcement in the moment had no standing signal that anything was outstanding.

## Decision

**A wave gates the next on two conditions, and both resolve to a wave-park.** No succeeding wave starts until the current wave is **fully resolved** — a healthy combined base **and** zero outstanding parks. The goal is that `main` is both **healthy and complete-so-far** before anything builds on it.

- **Gate 2 — combined base health** (unchanged, [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md)). A wave whose issues each pass alone but whose **merged base fails the gate** wave-parks: everything stays merged, the base sits red, the campaign pauses for a human.

- **Gate 1 — zero unresolved parks** (new). If **any** issue in a wave parks, the wave **drains** — its in-flight siblings are never aborted; they finish, and their greens pass their own gate and merge under Gate 2 — and **then the wave parks**. A per-issue park **escalates to a wave-park**; it does not fold into `held` and let the campaign roll on.

**A park is first-class, durable state**, for an issue or a whole wave, until a human resolves it:

- **It persists.** A park is unfinished work, so its record is **never cleared at the wave boundary or at archive** (contrast a green, whose completed state clears when the run archives). A run with an outstanding park does not read as a clean archived "complete".
- **It always shows in the dashboard** — the landing counter, the cross-repo parked queue, and the project card's run-state — for as long as it is unresolved. The card never folds to idle/complete while a park exists.
- **It always communicates via Telegram, durably.** Because the dashboard and the gateway's announcer both read the *same* persisted park record, persistence delivers both surfaces at once. The announcement no longer depends on the gateway observing an ephemeral record before another step deletes it; it fires **exactly once** (the persisted announced-message id guards re-announcement across gateway restarts) and the question stays answerable for as long as the park lives.

**Drain, don't abort.** A per-issue park never kills its wave's other agents — their work is independently valuable, exactly as under [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md). They finish and their greens merge; only then does the wave settle into its park, and the campaign pauses at the wave boundary for a `--resume`.

## Considered options

- **Complete-but-flagged** — let later independent waves proceed and mark the run "completed with N parked." Rejected: a succeeding wave would build on a base whose prior wave is not actually resolved. "Main healthy before the next wave" is the property the whole campaign model rests on; throughput does not buy the right to advance on unresolved work.
- **Halt immediately, aborting siblings** — stop the wave the instant an issue parks. Rejected: it discards independently-verified in-flight work, the exact loss [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md) removed. Draining first preserves it.
- **Leave per-issue parks non-gating** (the status quo). Rejected: this *is* the defect — a wave reads done with an open question, the park goes dark, and the issue is silently dropped and unresumable.

## Consequences

- The advancement rule is uniform: a wave advances only from a **fully-resolved, green, park-free** base. Both gate failures converge on one primitive (**wave-park**) and one recovery (resolve/answer or prune, then `campaign --resume`).
- Parked records join the set of things that **survive a run** — alongside quarantined and wave-parked work under [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md) — and archive no longer clears them.
- The dashboard gains **no new state**, only fidelity: `parked` and `wave-parked` already exist ([ADR 0007](0007-dashboard-shows-the-orchestrators-status-vocabulary.md)); the change is that they persist and roll up to the landing card and counters until resolved, so a completed-looking campaign cannot hide one.
- Telegram notification for a park becomes a **durability guarantee** rather than a best-effort poll — consistent with the gateway owning comms ([ADR 0002](0002-gateway-is-a-dumb-router-projects-own-comms.md)): announced once, answerable for as long as the park lives.
- The accepted cost: **a single open question stalls succeeding waves.** That is the intended trade — correctness of `main` over wave throughput.
