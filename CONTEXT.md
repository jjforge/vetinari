# Sandcastle-TDD

The boundary model for running the sandcastle-tdd orchestrator across multiple
projects at once: what each project commits, what it excludes, and the shared
host process that fronts them all.

## Language

### Per-project layout

**`sandcastle/`**:
The project's **committed** sandcastle configuration, versioned in the
project's own repo. Holds the config module, the project's `Dockerfile`, and any
custom build things or prompt override. `sandcastle/` = shared.
_Avoid_: config folder, config dir

**`.sandcastle.local/`**:
The project's **excluded** (gitignored) machine-local area. Holds the project's
credentials (`.env`), run logs, and run state (`parked/`). Never committed. The
`.local` suffix carries the "yours, not shared" convention (`settings.local.json`,
`.env.local`).
_Avoid_: state dir, work dir, `.sandcastle/`

**Shared install**:
The single machine-wide install of sandcastle-tdd, shared by every project on the
host (ADR 0003). A project runs whatever version the machine has — it is never
vendored a copy and never pins a version, and sandcastle-tdd never appears in the
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
The `.sandcastle.local/` path a project registers with the gateway — the single
place its config and secrets are read from, so a secret is never duplicated.

**Consuming project**:
Any software project that runs sandcastle-tdd against its own backlog. Has a
committed `sandcastle/` and an excluded `.sandcastle.local/`; the gateway serves
many of them simultaneously.
_Avoid_: client, target repo

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
A project's declaration, in its `sandcastle/` config, of which message category
goes to which destination. The gateway enforces it; the project owns it.

**Outbound record** / **outbox**:
A category-tagged message (`{category, event?, text}`) a run writes into its
`.sandcastle.local/` instead of sending to Telegram itself. The gateway drains the
outbox and routes each record per the notify map — so all outbound flows through
the gateway (the sole sender), and a parked **question** is simply the interactive
kind of outbound record that also feeds the reply index.
_Avoid_: message queue, mailbox

**Wave**:
One batch of a campaign — the tasks run together before their greens are merged
and the next batch starts. "Wave start" is a **progress** message.
_Avoid_: batch (in user-facing comms), round

### Campaign planning

**Campaign plan** (the `campaign-plan` tool):
A generic sandcastle-tdd tool that turns a selected set of ticket ids into the
dependency-ordered, file-disjoint wave arguments `campaign` consumes. It plans; it
never runs sandcastle or pushes. A peer of [[carve]], sharing its DAG foundation.
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
sandcastle-tdd ships a generic cites-from-body default.
_Avoid_: file matcher, crossover detector

**Under-specified ticket**:
A ticket whose file-set resolves with `confident: false` (cites nothing, or cites
what the tree lacks). `campaign-plan` never plans around it silently — it halts and
asks the requestor to either carve it (and its dependents) out and proceed, or stop
and put the data on the issue.
_Avoid_: unresolved ticket, ambiguous ticket
