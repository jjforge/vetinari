# A host slot budget is honored by a cooperative filesystem lease, not a gateway allocator

Status: superseded by design.md §8.

Multiple projects run their own `campaign`/`queue` at once, and each self-limits by
its own `QUEUE_SLOTS` with no cross-project coordination — so N projects at eight
slots is 8N containers, and one busy machine oversubscribes. We want a **host-level
ceiling** on live containers, split by project priority when projects contend,
without throwing away in-flight work.

The decision: a **host slot budget** — a host-side setting; unset leaves today's
uncoordinated behavior untouched — is honored by a **cooperative lease that lives in
the filesystem**, which every run reads and writes directly. A run takes a slot only
when it is under both its own `QUEUE_SLOTS` and its current **fair share**: a floor
of one slot per active project plus a weight-proportional cut of the remainder,
computed over the currently-active projects. Because a run only ever *checks its
share before acquiring the next slot*, allocation self-corrects — when another
project becomes active, a busy run stops re-acquiring above its now-smaller share and
**drains to it as its turns finish**, with no preemption and no discarded work. A
project declares its **weight** in its own `vetinari/` config (default one); the
host owns the total.

Crucially, the lease is **not** the gateway. The gateway stays a dumb router
(ADR 0002) that holds no cross-project decisions; making it the allocator would give
it exactly the shared state that ADR meant to keep out, and put the whole host's
throughput behind one process that today need not even be running. The lease is
instead a small shared file the run processes coordinate through — it composes with
the gateway rather than living inside it.

## Considered Options

- **A gateway (or new) allocator daemon that hands out slots** — rejected: it breaks
  ADR 0002's dumb-router stance, funnels every project's throughput through one
  daemon, and couples slot allocation to a process that is otherwise optional.
- **Dynamic rebalancing with preemption** — a live scheduler that resizes pools and
  kills containers to hit exact shares. Rejected: preemption discards a paid-for
  turn, and drain-to-share reaches the same steady state cooperatively, at the cost
  of only a turn or two of lag.
- **Per-project `QUEUE_SLOTS` only (status quo)** — rejected: it cannot bound the
  host, because each run knows nothing of the others.

## Consequences

- The budget is **opt-in**: with none set, every run behaves exactly as before — its
  own `QUEUE_SLOTS`, uncoordinated.
- `QUEUE_SLOTS` stays a run's *own* desired maximum; the fair share is an
  *additional* ceiling, so effective concurrency is `min(QUEUE_SLOTS, fair-share)`.
- A newly-active project ramps into its share over a turn or two rather than
  instantly — the price of never preempting. A project running alone gets the whole
  budget.
- The lease must be **crash-safe**: a run that dies without releasing must not wedge
  the budget, so a dead holder's slots are reclaimed on contention.
- When active projects outnumber the budget, the one-slot floor is best-effort:
  projects that cannot get their slot wait first-come for the next freed one.
