# Vetinari

The boundary model for running the vetinari orchestrator across multiple
projects at once: what each project commits, what it excludes, and the shared
host process that fronts them all.

## Language

### Per-project layout

**`vetinari/`**:
The project's **committed** Vetinari configuration, versioned in the
project's own repo. Holds the config module, the project's `Dockerfile`, and any
custom build things or prompt override. `vetinari/` = shared.
_Avoid_: config folder, config dir

**`.vetinari.local/`**:
The project's **excluded** (gitignored) machine-local area. Holds the project's
credentials (`.env`), run logs, and run state (`parked/`). Never committed. The
`.local` suffix carries the "yours, not shared" convention (`settings.local.json`,
`.env.local`).
_Avoid_: state dir, work dir, `.sandcastle/`

**Shared install**:
The single machine-wide install of vetinari, shared by every project on the
host (ADR 0003). A project runs whatever version the machine has — it is never
vendored a copy and never pins a version, and vetinari never appears in the
app's own `package.json`.
_Avoid_: runtime pull, vendored runtime

### Shared host

**Gateway**:
The single host-level daemon (systemd) that fronts **every** project at once. A
**dumb router**: it holds no project config and no secrets, only a registry of
pointers. It is the sole Telegram consumer — deduping shared bot tokens so each
bot is polled exactly once — routing each project's outbound messages per that
project's own rules and routing inbound replies back to the right parked task.
Replaces the old one-poller-per-project `dispatch`.
_Avoid_: dispatcher, poller

**Registration** / **register event**:
How a project makes itself known to the gateway: it hands over its **base
location** and nothing else. The gateway reads config and secrets from there,
never copying them.
_Avoid_: enrollment, subscribe

**Base location**:
The `.vetinari.local/` path a project registers with the gateway — the single
place its config and secrets are read from, so a secret is never duplicated.

**Consuming project**:
Any software project that runs vetinari against its own backlog. Has a
committed `vetinari/` and an excluded `.vetinari.local/`; the gateway serves
many of them simultaneously.
_Avoid_: client, target repo

### Host concurrency

**Host slot budget**:
The total number of agent containers the **machine** allows across every project at
once — a property of the host, set host-side, not in any project's config. Unset
means no host ceiling: each [[run]] is bounded only by its own `QUEUE_SLOTS`,
uncoordinated, as before. When set, every run cooperates to keep the sum of live
containers within it (ADR 0010).
_Avoid_: max containers, global slots, concurrency cap

**Project weight**:
A number a project declares in its `vetinari/` config (default one) that sets its
cut of the [[host-slot-budget]] when projects contend. Higher weight → more slots;
it only bites while more than one project is active.
_Avoid_: priority, rank

**Fair share**:
A project's currently-allowed slot count under the [[host-slot-budget]]: a **floor
of one** slot per active project, plus a [[project-weight]]-proportional cut of the
remainder, computed over the *currently active* projects — so a project alone gets
the whole budget and each active project always gets something. Not a reservation:
it is the ceiling a run checks before taking its next slot.
_Avoid_: quota, allocation

**Slot lease**:
The host-level **filesystem** primitive the `campaign`/`queue` processes cooperate
through to honor the [[host-slot-budget]] — each records the slots it holds and its
[[project-weight]] there, and a dead holder's slots are reclaimed on contention. It
is **not** the [[gateway]] (which stays a dumb router and never allocates); it is a
shared file every run reads and writes directly, so it needs no daemon. A run takes
a slot only when under both its own `QUEUE_SLOTS` and its current [[fair-share]],
and releases on park or finish — so when a new project becomes active a busy one
stops re-acquiring above its now-smaller share and **drains to it** as turns finish,
never preempting a running container.
_Avoid_: semaphore, lock, allocator

### Communications

**Message category**:
The kind of a piece of outbound communication, used to route it. The five:
**question** (a parked task needs a human answer — the only *interactive* one),
**success** (green, merged, campaign complete), **failure** (halt, resume error),
**progress** (queue/campaign/wave/batch lifecycle, including a **carve** dropping
an issue and its dependents), **finding** (an incidental defect was filed).
A routing rule may target a whole category or a specific event under it
(`progress:wave-start`, `progress:carve`).
_Avoid_: message type, event kind

**Interactive** (of a message):
A message that expects a reply routed back — only **question** is. Its
destination is *where the human answers*, so a project's questions must resolve to
a single destination the gateway can watch. All other categories are fire-and-forget.

**Destination**:
A named Telegram connection (bot + chat, optionally thread) a project defines and
routes categories to. "All → bot A, failures → bot B" is two destinations.
_Avoid_: channel, target, route

**Routing rule** / **notify map**:
A project's declaration, in its `vetinari/` config, of which message category
goes to which destination. The gateway enforces it; the project owns it.

**Outbound record** / **outbox**:
A category-tagged message (`{category, event?, text}`) a run writes into its
`.vetinari.local/` instead of sending to Telegram itself. The gateway drains the
outbox and routes each record per the notify map — so all outbound flows through
the gateway (the sole sender), and a parked **question** is simply the interactive
kind of outbound record that also feeds the reply index.
_Avoid_: message queue, mailbox

**Wave**:
One batch of a campaign — the tasks run together before their greens are merged
and the next batch starts. "Wave start" is a **progress** message.
_Avoid_: batch (in user-facing comms), round

### Runs

**Run**:
One invocation of `campaign` or `queue` — the unit whose event log the dashboard
reads. A project has one **live run** at a time (its `orchestrator.jsonl`);
finishing it archives that log (see [[archived-run]]).
_Avoid_: session, job

**Archived run**:
A completed run whose event log `archiveRun` moved aside to
`logs/archive/orchestrator-<timestamp>.jsonl` (kept, never deleted) so a finished
run stops reading as current. The event log is the run's durable, per-run artifact
— the dashboard reconstructs the whole wave/issue view from it. The `agent-*` and
`gate-*` logs are **live-only scratch**: overwritten across runs and not archived.
_Avoid_: past run, old log

**Event feed** (the landing's `EVENT LOG`):
A rolling recent-history operator log of the narratable events across every
project's live run and recently-[[archived-run]] logs, newest-first — what the fleet
has been doing lately, at a glance. Bounded to a recent window; deeper per-run
history lives in the [[archived-run]] list, not here.
_Avoid_: ticker, live feed, activity stream

**Campaign name**:
An optional human label for a run, passed as `campaign --name` and recorded on the
`campaign-start` event, so the dashboard and the [[archived-run]] list say what a
run was for at a glance. `campaign-plan` suggests one from the area labels the
selected issues span. Absent, a run falls back to its timestamp.
_Avoid_: run title

**Wave name**:
A wave's human label, **derived at render** from the titles of the issues it holds
(one issue → its title; several → the lead title + "+N") — never stored, and never
an epic: a [[wave]] is a file-disjoint layer that crosses epics, so its issues,
not an epic, name it.
_Avoid_: batch name

### Issue status

The dashboard shows the orchestrator's own `IssueStatus` vocabulary, plus one
render-derived state (`carved`) — not the UX handoff's friendlier labels (ADR 0007).

**running**:
An agent is on the issue in the active [[wave]] — whether executing or waiting for
a slot. The active-wave slot-wait is not a separate status; it is still running.
_Avoid_: working, in progress

**parked**:
The agent asked a question and stopped; the issue waits on a human answer. The one
[[interactive]] state and the reason to open an issue's detail.

**failure**:
The run errored out **without** parking. The dashboard shows it — the orchestrator
really does emit this, so hiding it would make the UI and the event log disagree on
which states exist. The turn log tells the story of why.
_Avoid_: failed, errored, broken

**completed**:
The issue's work landed on the base.
_Avoid_: merged, done

**unstarted**:
In the plan, not yet begun — a later [[wave]] with no agent assigned.
_Avoid_: queued, pending

**carved**:
A [[carve]] left the issue out of the campaign with its unstarted dependents.
**Derived at render** from the carve event (not a stored status), so it shows in
both the live run and an [[archived-run]] — a browsing operator can see what was
carved out of a finished run.
_Avoid_: removed, dropped, pruned

### Campaign planning

**Campaign plan** (the `campaign-plan` tool):
A generic vetinari tool that turns a selected set of ticket ids into the
dependency-ordered, file-disjoint wave arguments `campaign` consumes. It plans; it
never runs Vetinari or pushes. A peer of [[carve]], sharing its DAG foundation.
_Avoid_: campaign builder, batcher

**Carve**:
Dropping an issue and its transitive dependents from a **running** campaign. It
**prunes the unfinished remainder without discarding banked work**: of the removed
closure, anything already merged or mergeable is kept, only parked/not-yet-started
issues leave the plan. Against a running campaign it appends a **carve event** the
loop honors at the next wave boundary (the in-flight wave finishes; future waves
shrink) — distinct from the from-scratch `carve <issue> <batch…>` form, which
launches a reduced campaign from a plan you supply.
_Avoid_: prune, remove, cancel, drop (as the noun)

**File-set resolver**:
A project-provided config function, `fileSet(ticket) → { files, confident }`, that
names the files a ticket will touch (by basename) so co-wave tickets can be kept
file-disjoint. A config seam like [[base-location]]'s `blockedBy`/`fetchTask`;
vetinari ships a generic cites-from-body default.
_Avoid_: file matcher, crossover detector

**Under-specified ticket**:
A ticket whose file-set resolves with `confident: false` (cites nothing, or cites
what the tree lacks). `campaign-plan` never plans around it silently — it halts and
asks the requestor to either carve it (and its dependents) out and proceed, or stop
and put the data on the issue.
_Avoid_: unresolved ticket, ambiguous ticket
