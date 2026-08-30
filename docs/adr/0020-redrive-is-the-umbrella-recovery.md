# Redrive is the umbrella recovery: an answer continues a campaign, a failure stops it

Status: superseded by design.md §7. Amends [ADR 0017](0017-a-wave-gates-the-next-on-a-healthy-base-and-zero-parks.md) and builds on [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md) and [ADR 0019](0019-held-work-is-one-parked-state-at-every-level.md).

## Context

[ADR 0017](0017-a-wave-gates-the-next-on-a-healthy-base-and-zero-parks.md) settled when a wave may advance — never onto unresolved work — and said the campaign "**pauses** at the wave boundary" for a human. That word was built as *exits*: the loop returns and the process ends. Nothing is left alive to notice the human's answer, so the recovery ADR 0017 names does not actually work end to end. Answering a park runs the agent standalone, its green is never merged because integration only happens inside the campaign loop, and resume — which starts after the last wave holding any completed member — steps straight over the wave the park is in. Each piece is defensible alone; together they mean an answered question never rejoins its campaign.

The gate is also only half-applied. A park holds its wave; a **failure** does not. A wave with a member the agent could not make green is logged done, its successor starts on top of it, and the run reports a clean finish — the exact defect ADR 0017 was written to remove, surviving in the one state ADR 0019 calls the red terminal.

And the vocabulary has been drifting. *Resume*, *restart*, *recover* and *redrive* have all been used for overlapping ideas, which is precisely the drift the working agreement's rule on defined vocabulary exists to stop.

## Decision

**Redrive is the umbrella** — the single named act of picking a campaign back up: reconcile what the log says happened, then continue. **Resume is one path through a redrive, not a synonym for it.** Every surface — the CLI, the dashboard, the operator notices, the glossary — uses *redrive* for the umbrella and reserves *resume* for the specific continue-from-here path.

A campaign holds to these rules, and a redrive honours them:

1. **Waves are strictly sequential, and a wave completes only when every member is resolved.** A **failure holds its wave exactly as a park does**: no successor starts, and the run does not report a clean finish. This extends ADR 0017's Gate 1 from parks to the red terminal.
2. **A park never blocks its wave's siblings.** The wave drains — the other agents finish and their greens merge — as ADR 0013 established.
3. **An answer that lands while the wave is still running puts the issue back to work**, spawned when a slot frees under the ordinary host budget. If it goes green before the wave drains, the wave completes normally and never parks.
4. **If the wave drains with the park unresolved, the wave parks and the campaign parks** (ADR 0017, unchanged).
5. **An answer is the continue signal.** Responding *is* the human's statement that it is safe to carry on, so the answer continues the campaign. The human does not answer and then separately ask for continuation.
6. **A park pauses; a failure stops.** A question park is a resumable hold that an answer lifts. A failure is terminal for the run: the process ends, and the campaign is redriven deliberately — with the dashboard as the surface for adjusting the campaign before it goes again.

**A redrive is durable, not a live process.** The continue path reconstructs the campaign from the event log; it must not depend on a process having stayed alive. A waiting process dies with any reboot, deploy or crash and nothing notices — the parked record still reads answerable while no one is listening — so a live-process mechanism would be correct only until the first restart. The durable path is therefore the mechanism, and it is sufficient on its own: a campaign paused at a wave boundary holds no container budget (the host-slot lease is scoped to a draining wave) and no state that is not re-derivable, since the plan is rebuilt from the log at every wave boundary under [ADR 0005](0005-prune-is-an-event-that-trims-the-running-campaign.md). Keeping a process alive across a park is an optional latency optimization on top, never the thing correctness rests on.

**A redrive never re-actions banked work.** Re-entering a wave skips members already merged into the base: no agent respawned, no branch re-cut, no second merge. A member that is green but unmerged — an answered park, a quarantined green — is landed rather than re-run.

## Considered options

- **Keep the campaign process alive, waiting for the answer.** The most literal reading of ADR 0017's "pauses". Rejected: it dies on every reboot and deploy, so the durable path has to exist regardless — and once it exists, the live process adds latency savings, not capability. It also holds a process open for what may be days against state that is fully re-derivable.
- **Let the comms daemon notice the park clearing and relaunch the campaign.** Rejected: it makes the dumb router a scheduler, against [ADR 0002](0002-gateway-is-a-dumb-router-projects-own-comms.md). The signal belongs in the path that already runs in the project's own root.
- **Leave parks non-gating so nothing ever needs redriving.** Rejected for the reasons ADR 0017 gives: a wave reads done with an open question and succeeding waves build on an unresolved base.
- **Treat a failure as a park — a resumable hold.** Tempting, since ADR 0019 already gathers held work under one state. Rejected: a park has a human answer that lifts it, and a failure has none. Its recovery is to *change* the campaign — prune, graft, fix forward — and drive again. That is a deliberate act, not a continuation, and calling it a pause would promise a resume that resolves nothing.
- **Keep both words, resume and redrive.** Rejected: two words for one concept is the drift rule 5 forbids, and the UI, the logs and the code would each pick a favourite.

## Consequences

- The wave loop gains a failure gate. A campaign that ends with a broken issue no longer exits green, so the exit status of such runs changes — anything scripted on that status sees the correction.
- The queue gains a notion of work that can arrive late, or the wave loop re-enters answered members before escalating to a wave-park. Either way a wave's outcome map is no longer final the moment a child exits.
- Resume's boundary becomes the first wave that is not **fully** resolved, rather than the first wave with nothing completed — and it must land green-but-unmerged members instead of skipping or re-running them.
- Prune and graft gate on whether the plan still holds unfinished members, not on the absence of a terminal event: a run that ended incomplete stays adjustable, which is what makes a deliberate redrive possible after a failure.
- The dashboard becomes the redrive surface — where the campaign is adjusted (prune, graft) and driven again — rather than a read-only view with two recovery buttons bolted on.
- The domain model gains **redrive**, and the `failed` state gains "holds its wave" alongside the same property already recorded for `parked`.
- A timeout, if one is adopted, is a **grace window at the wave boundary** — wait before declaring a drained wave parked, so a fast answer means the wave never parked at all. It is a bound on an optimization, never a mechanism of its own.
- The accepted cost: a campaign can now be continued by an answer arriving from a surface the campaign process never saw, so the continue path must be idempotent against a human who answers twice, or answers a park that a prune has already removed.
