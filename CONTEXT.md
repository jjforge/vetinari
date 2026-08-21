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

**Wave**:
One batch of a campaign — the tasks run together before their greens are merged
and the next batch starts. "Wave start" is a **progress** message.
_Avoid_: batch (in user-facing comms), round
