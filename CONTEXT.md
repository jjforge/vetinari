# Vetinari

The domain glossary: the words vetinari's code, logs, dashboard and docs all
speak, in the settled vocabulary. Every term here appears in the operator's
model ([`docs/user-guide.md`](docs/user-guide.md)) or the design
([`docs/design.md`](docs/design.md)) — those two documents are the source, this
is the index. When two words exist for one concept, the current one is the
heading and the retired one sits under `_Avoid_`.

## Language

### Objects

**Project**:
A repo you run vetinari in. Has a committed [[vetinari]] (config, Dockerfile) and
an ignored [[vetinari-local]] holding this machine's secrets, logs and run state.
Identified by its `origin` repo (`owner/name`), falling back to its declared name
when the repo can't be derived — a repo with no `origin`, a non-GitHub remote, or an
unparseable URL degrades to the name rather than erroring.
_Avoid_: client, target repo, consuming project.

**Issue**:
The unit of work, read from your tracker. Runnable unattended only when its body
says what to build and which files it touches.

**Agent**:
One per [[issue]], sealed in a container on branch `agent/<id>`, committing as it
goes. Ends each turn by saying COMPLETE or BLOCKED-with-a-question; it never
decides "done".

**Gate**:
Your test commands. The orchestrator runs them after every COMPLETE and again on
the merged base; green is the only signal that an issue is done. A red gate
resumes the same agent with the output.

**Campaign**:
A set of [[issue]]s planned into [[wave]]s and run wave by wave — the unit you
launch, watch and pick back up.
_Avoid_: queue (removed as a mode), campaign-plan (say `campaign --dry-run`).

**Wave**:
The [[issue]]s that run at the same time: no dependency between them, no shared
files. When a wave finishes its greens merge onto the [[base]], the base is gated
as a whole, and the next wave starts from there.
_Avoid_: batch, round.

**Base**:
The branch checked out when a [[campaign]] launched. Merges land on it locally;
pushing is the human's. The next [[wave]] never starts until the base is green.

### Issue states

Five words, one per situation. Waves, campaigns and the project card roll up from
their issues in the order failed > parked > running > completed.

**unstarted**:
In the plan, no [[agent]] yet.
_Avoid_: queued, pending.

**running**:
An [[agent]] is on the [[issue]] — executing, or waiting for a container slot.
The slot-wait is not a separate status. A green that is not yet merged is also
`running` even though no [[agent]] is on it: banked-but-unmerged work waiting for
its [[wave]] to integrate, since [[completed]] is reserved for work on the
[[base]]. What the [[issue]] is doing within `running` is its [[phase]].
_Avoid_: working, in progress.

**parked**:
Held on a human, work preserved, resumable — the one word for every "needs a
human" situation, at the [[issue]], [[wave]], campaign and card level alike. What
differs is the [[park-reason]], which selects the recovery. Durable: shown and
announced until a human resolves it.
_Avoid_: blocked, waiting, quarantined, wave-parked, interrupted (each is
`parked` + a reason).

**failed**:
The red terminal — an [[issue]] the [[agent]] could not make green. Holds its
[[wave]] like a park, but stops the run rather than pausing for an answer; the
recovery is a [[redrive]]. Outranks [[parked]] on roll-up.
_Avoid_: errored, broken.

**completed**:
The issue's work merged onto the [[base]]. A green that is not yet merged is still
[[running]] — the word for banked work is reserved for work on the base.
_Avoid_: merged, done.

Membership is an orthogonal axis, shown as a badge rather than a state:

**pruned**:
A [[prune]] left the [[issue]] out of the campaign with its unstarted dependents.
Derived at render from the prune event, so it shows in a live and an
[[archived-run]] alike.
_Avoid_: removed, dropped, carved.

**grafted**:
A [[graft]] added the [[issue]] to the running campaign; it waits in a later
[[wave]]. Derived at render and transient — becomes [[running]] on pickup.
_Avoid_: added, appended, injected.

**phase**:
The step an [[issue]] is currently in — `starting`, `coding`, `testing · <cmd>`
(naming the [[gate]] command running now), `filing findings`, `waiting to merge`
(a green awaiting integration). A sub-axis of [[running]], never a sixth state:
derived at render from the issue's latest event (nothing stored), orthogonal to
status and never rolled up to a [[wave]] or campaign. It shows on the issue row
and sheet in place of the word `running`; the other four states keep their word
and carry none. A phase where nothing is executing (a wait) stills the dot.
_Avoid_: step, stage, substate as the surface word.

### Park reasons

**Park reason**:
Why a [[parked]] issue or wave is held, and which recovery it offers — metadata on
the park, not a status. One enum: `question | stalled | conflict | red-base |
crash`.
_Avoid_: quarantined, interrupted (those were reasons masquerading as statuses).

**question**:
The [[agent]] asked something only a human can answer. Answer it and the campaign
continues on its own.

**stalled**:
The turn budget was spent, the [[agent]] went quiet, or a COMPLETE changed
nothing. Read the turn log, then answer with guidance or [[prune]].

**conflict**:
A green branch conflicts with the [[base]] at merge; its branch, worktree and
session are kept. Resolve on the base, then [[redrive]].
_Avoid_: quarantined.

**red-base**:
Every [[issue]] passed alone but the merged [[base]] fails together — no single
culprit is knowable. Fix forward on the base, then [[redrive]].

**crash**:
The run died with no verdict. [[redrive]] to continue.
_Avoid_: interrupted.

### The five moves

The only things a human does to a [[campaign]].

**Answer**:
Reply to a [[parked]] question; the [[issue]] goes back to work and the campaign
continues by itself. You do not answer and then separately ask it to continue.

**Prune**:
Drop an [[issue]] and everything that depends on it from a running campaign. It
takes effect at the next [[wave]] boundary; banked work is never undone and a
pruned issue's branch is kept.
_Avoid_: carve, remove, cancel, drop (as the noun).

**Graft**:
Add [[issue]]s to a running campaign. Each lands in the earliest unstarted
[[wave]] after its blockers whose members touch none of its files; the wave in
flight is never touched.
_Avoid_: extend, add (as the noun), append, inject.

**Fix forward**:
Repair the [[base]] by hand — resolve a [[conflict]] or a [[red-base]] — then
[[redrive]].

**Redrive**:
Pick an unfinished [[campaign]] back up where it stopped: reconcile the log, then
continue. Never redoes merged work, and lands green-but-unmerged work rather than
re-running it. Resume is one path through it, not a synonym.
_Avoid_: restart, recover, re-run, resume (as the umbrella).

### Roll-ups

Wave, campaign and card states are derived from their issues, one fold per level.

**failed** (roll-up):
A [[wave]], campaign or card carrying at least one [[failed]] issue — the red
"something broke" state. Outranks [[parked]]; the recovery is a [[redrive]].
_Avoid_: halted, errored.

**idle**:
A card with no campaign that is running, [[parked]] or [[failed]] — no plan, or a
cleanly [[completed]] run folded away.
_Avoid_: done, empty, inactive.

### Planning

**File-set resolver** (`fileSet`):
A project config function, `fileSet(ticket) → { files, confident }`, naming the
files an [[issue]] touches (by basename; the default reads the `Touches:`/
`Creates:` line) so co-[[wave]] issues stay file-disjoint.
_Avoid_: file matcher, crossover detector.

**Under-specified ticket**:
An [[issue]] whose file-set resolves `confident: false` — cites nothing, or cites
what the tree lacks. The planner never schedules it silently: it halts and asks to
[[prune]] it out or fix the issue.
_Avoid_: unresolved ticket, ambiguous ticket.

### Project layout & configuration

**`vetinari/`**:
The project's committed vetinari configuration — config module, `Dockerfile`,
prompt overrides — versioned in the project's own repo.
_Avoid_: config folder, config dir.

**`.vetinari.local/`**:
The project's ignored, machine-local area: credentials (`.env`, `host.env`), run
logs, and run state (`parked/`). Never committed.
_Avoid_: state dir, work dir, `.sandcastle/`.

**Container gate** (`.env`):
The one file in [[vetinari-local]] that crosses into the [[agent]] container —
only the agent provider's credential. A secret the agent must not see never goes
here.
_Avoid_: container boundary, sandbox env, container config.

**`host.env`**:
The project's host-only secrets the container must never get — its Telegram bot
token and chat. Read by the [[gateway]], never injected into a container.
_Avoid_: orchestrator.env.

**`hostEnv`**:
A committed, non-secret map in [[vetinari]] applied to the orchestrator process
only (e.g. `GIT_CONFIG_GLOBAL`). A secret the host needs goes in [[host.env]],
never here.

### Host & concurrency

**Gateway**:
The single host daemon that fronts every [[project]] at once — a dumb router
holding no project config or secrets. The sole Telegram consumer: it routes each
project's outbound notices and routes replies back to the [[parked]] issue that
asked.
_Avoid_: dispatch, attend, dispatcher, poller.

**Max concurrent containers** (`MAX_CONCURRENT_CONTAINERS`):
The ceiling on [[agent]] containers the machine allows across every project at
once — a host property, never a project's config. Unset resolves to a
machine-derived default, never unbounded.
_Avoid_: QUEUE_SLOTS, host slot budget, global slots, concurrency cap.

**Container share** (`containerShare`):
A tier — `high`, `medium` (default) or `low` — a project declares in [[vetinari]],
setting its cut of [[max-concurrent-containers]] when projects contend: a weighted
share with a floor of one, never preemptive, never starving.
_Avoid_: hostWeight, project weight, priority, rank.

**Lease**:
The host-level file every run reads and writes directly to honour
[[max-concurrent-containers]] — recording what each run holds and its share, and
reclaimed from a dead holder on contention. Not the [[gateway]], which never
allocates.
_Avoid_: semaphore, lock, allocator.

### Communications

**Message category**:
The kind of an outbound notice, used to route it: **question** (the only
interactive kind), **success**, **failure**, **progress**, **finding**. A routing
rule may target a whole category or a specific event under it
(`progress:wave-start`).
_Avoid_: message type, event kind.

**Interactive** (of a notice):
Expects a reply routed back — only **question** is. Every other category is
fire-and-forget.

**Bot connection**:
A [[project]]'s one Telegram bot and the chat it speaks in by default — the token
and chat id in its [[host.env]], read live by the [[gateway]]. One bot per
project: a project has exactly one, or none (and then the gateway skips it).
_Avoid_: telegram config, bot creds, the project's telegram.

**Destination**:
A named place on the project's [[bot connection]] — a chat, optionally a forum
thread under it — that a [[message-category]] routes to. It names no bot and
carries no secret; it only picks *where* on that one bot a message lands.
_Avoid_: channel, target, route.

**Routing rule** (`notify`):
A project's declaration, in [[vetinari]], of which [[message-category]] goes to
which [[destination]]. The [[gateway]] enforces it; the project owns it.

**Outbound record** (outbox):
A category-tagged message a run writes into [[vetinari-local]] instead of sending
to Telegram itself. The [[gateway]] drains the outbox and routes each record per
the notify map.
_Avoid_: message queue, mailbox.

### Runs

**Run**:
One invocation of `run` or `campaign` — the unit whose event log the dashboard
reads. A [[project]] has one live run at a time; finishing it archives that log.
_Avoid_: session, job.

**Archived run**:
A completed run whose event log was moved to `logs/archive/` (kept, never deleted)
so a finished run stops reading as current.
_Avoid_: past run, old log.

**Campaign name**:
An optional human label for a run, passed as `campaign --name` and recorded on
`campaign-start`, so the dashboard and the [[archived-run]] list say what a run was
for. Absent, a run falls back to its timestamp.
_Avoid_: run title.
