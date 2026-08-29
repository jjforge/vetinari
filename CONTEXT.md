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

### Configuration layers

**Configuration axes**:
Where a config item lives is fixed by three orthogonal questions (ADR 0011): its
**scope** (host / project / run), whether it is a **secret** (secret → the excluded
`.vetinari.local/`, else the committed `vetinari/`), and its **container-reach** (does
it cross into the agent container?). Answering the three names the file it belongs in.

**Container boundary**:
The single gate into the agent container: **only** the keys declared in
`.vetinari.local/.env` cross in (the sandbox runtime injects them as container env).
Everything else — Telegram credentials, `GIT_CONFIG_GLOBAL`, the
[[max-concurrent-containers]] ceiling — stays host-side by construction. A secret that
must not reach the agent must never appear in `.env`.
_Avoid_: sandbox env, container config

**`.env`** (container secrets):
The project's excluded secrets the **in-container agent** needs — the selected agent
provider's credential (ADR 0016: `claude` → `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`,
`pi` → `ANTHROPIC_API_KEY`, `codex` → `OPENAI_API_KEY`). The one file that crosses the
[[container-boundary]]; it keeps the name `.env` because the sandbox runtime reads it by
that name. A run whose provider's key is absent here fails a preflight before launch.
_Avoid_: container.env

**`host.env`** (host-side secrets):
The project's excluded secrets the **host** process needs but the container must not
get — the Telegram bot token and chat. Read into the orchestrator process and live
per-project by the [[gateway]]; never injected into a sandbox.
_Avoid_: orchestrator.env

**hostEnv**:
A committed, **non-secret** map in `vetinari/` applied to the orchestrator process only
(never a sandbox) — e.g. `GIT_CONFIG_GLOBAL` pointing at a writable gitconfig path. A
secret the host needs goes in [[host.env]], never as a literal here.

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

**Max concurrent containers** (`MAX_CONCURRENT_CONTAINERS`):
The ceiling on agent containers the **machine** allows across every project at once —
a property of the host, set host-side (env var or a file in the gateway config dir),
never in a project's config. A project running alone consumes all of it; unset resolves
to a machine-derived default rather than unbounded, so the host is never swamped. Every
run cooperates to keep the sum of live containers within it (ADR 0010, ADR 0011).
_Avoid_: host slot budget, QUEUE_SLOTS, global slots, concurrency cap

**Container share** (`containerShare`):
A named tier — `high`, `medium` (default), or `low` — a project declares in its
`vetinari/` config, setting its cut of [[max-concurrent-containers]] when projects
contend. A **weighted share with a floor of one, never preemptive and never starving**:
a higher tier takes more of the remainder, not all of it, and it only bites while more
than one project is active.
_Avoid_: project weight, hostWeight, priority, rank

**Fair share**:
A project's currently-allowed container count under [[max-concurrent-containers]]: a
**floor of one** per active project, plus a [[container-share]]-weighted cut of the
remainder, computed over the *currently active* projects — so a project alone gets the
whole ceiling and each active project always gets something. Not a reservation: it is
the ceiling a run checks before taking its next container.
_Avoid_: quota, allocation

**Slot lease**:
The host-level **filesystem** primitive the `campaign`/`queue` processes cooperate
through to honor [[max-concurrent-containers]] — each records the containers it holds and
its [[container-share]] there, and a dead holder's are reclaimed on contention. It is
**not** the [[gateway]] (which stays a dumb router and never allocates); it is a shared
file every run reads and writes directly, so it needs no daemon. A run takes a container
only when under its current [[fair-share]], and releases on park or finish — so when a
new project becomes active a busy one stops re-acquiring above its now-smaller share and
**drains to it** as turns finish, never preempting a running container.
_Avoid_: semaphore, lock, allocator

### Communications

**Message category**:
The kind of a piece of outbound communication, used to route it. The five:
**question** (a parked task needs a human answer — the only *interactive* one),
**success** (green, merged, campaign complete), **failure** (halt, resume error),
**progress** (queue/campaign/wave/batch lifecycle, including a **prune** dropping
an issue and its dependents and a **graft** adding issues to the running campaign),
**finding** (an incidental defect was filed).
A routing rule may target a whole category or a specific event under it
(`progress:wave-start`, `progress:prune`, `progress:graft`).
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
One batch of a campaign — the tasks run together, their greens are merged, and the
next batch starts **only once the wave is fully resolved**: a healthy combined base
and zero outstanding parks (ADR 0017). "Wave start" is a **progress** message.
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

**Wave-parked**:
A whole [[wave]] held on a human, from either of two triggers. **Combined-gate:**
every issue went green alone, but the **merged base is red together**, so no single
issue is at fault (ADR 0013). **Escalated park:** an issue in the wave [[parked]];
the wave **drains** (its other agents finish, their greens merge) and then parks, so
no succeeding wave builds on an unresolved one (ADR 0017). Either way everything
green stays merged (the base sits red, never pushed), the campaign pauses, and a
human resolves it: fix forward and resume, or prune a suspect and resume. A run-level
counterpart to an issue's [[parked]] — the wave, not one agent, waits on a human.
_Avoid_: halted, rolled back, failed wave

### Issue status

The dashboard shows the orchestrator's own `IssueStatus` vocabulary, plus one
render-derived state (`pruned`) — not the UX handoff's friendlier labels (ADR 0007).

**running**:
An agent is on the issue in the active [[wave]] — whether executing or waiting for
a slot. The active-wave slot-wait is not a separate status; it is still running.
_Avoid_: working, in progress

**parked**:
The agent asked a question and stopped; the issue waits on a human answer. The one
[[interactive]] state and the reason to open an issue's detail. A park **holds its
wave** — the wave drains, then wave-parks, and no succeeding wave starts until it is
resolved (ADR 0017). It is **durable**: always shown in the dashboard and always
announced via Telegram until a human resolves it, never cleared out from under an
open question.

**quarantined**:
A merge **conflict** pulled the issue out of integration; its branch, worktree, and
agent session are preserved so it is resumable, never re-run from scratch. Distinct
from [[parked]] (which asked a question) — a quarantine asks nothing, it holds a
conflict for a human to resolve. The wave keeps its other greens merged and carries
on. See [ADR 0013](../docs/adr/0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md).
_Avoid_: conflicted, skipped, rejected

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

**pruned**:
A [[prune]] left the issue out of the campaign with its unstarted dependents.
**Derived at render** from the prune event (not a stored status), so it shows in
both the live run and an [[archived-run]] — a browsing operator can see what was
pruned out of a finished run.
_Avoid_: removed, dropped, carved

**grafted**:
A [[graft]] added the issue to the running campaign; it waits in a later [[wave]].
**Derived at render** from the graft event (not a stored status), and **transient**
— the additive mirror of [[pruned]]: shown while the issue is `unstarted`, it
becomes [[running]] on pickup. Answers "why did this wave grow?" at a glance.
_Avoid_: added, appended, injected

### Campaign planning

**Campaign plan** (the `campaign-plan` tool):
A generic vetinari tool that turns a selected set of ticket ids into the
dependency-ordered, file-disjoint wave arguments `campaign` consumes. It plans; it
never runs Vetinari or pushes. A peer of [[prune]], sharing its DAG foundation.
_Avoid_: campaign builder, batcher

**Prune**:
Dropping an issue and its transitive dependents from a **running** campaign. It
**prunes the unfinished remainder without discarding banked work**: of the removed
closure, anything already merged or mergeable is kept, only parked/not-yet-started
issues leave the plan. Against a running campaign it appends a **prune event** the
loop honors at the next wave boundary (the in-flight wave finishes; future waves
shrink) — distinct from the from-scratch `prune <issue> <batch…>` form, which
launches a reduced campaign from a plan you supply.
_Avoid_: carve, remove, cancel, drop (as the noun)

**Graft**:
Adding issues to a **running** campaign — the additive counterpart of [[prune]]
(ADR 0014). `graft <ids…>` appends a **graft event** the loop honors at the next
wave boundary: the in-flight wave finishes untouched and the added issues are
re-layered into future waves (dependency-ordered, basename-disjoint), leaving
already-planned [[wave]]s stable. Unlike prune it is allowed against any run not yet
done — live, or paused/[[wave-parked]] and honored on the next `--resume`.
_Avoid_: extend, add (as the noun), append, inject

**File-set resolver**:
A project-provided config function, `fileSet(ticket) → { files, confident }`, that
names the files a ticket will touch (by basename) so co-wave tickets can be kept
file-disjoint. A config seam like [[base-location]]'s `blockedBy`/`fetchTask`;
vetinari ships a generic cites-from-body default.
_Avoid_: file matcher, crossover detector

**Under-specified ticket**:
A ticket whose file-set resolves with `confident: false` (cites nothing, or cites
what the tree lacks). `campaign-plan` never plans around it silently — it halts and
asks the requestor to either prune it (and its dependents) out and proceed, or stop
and put the data on the issue.
_Avoid_: unresolved ticket, ambiguous ticket
