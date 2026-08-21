# E3: Gateway — registration, single Telegram consumer, reply routing

Epic: [#14](https://github.com/jjforge/sandcastle-tdd/issues/14) · Source: [ADR 0002](../adr/0002-gateway-is-a-dumb-router-projects-own-comms.md), [ADR 0001](../adr/0001-sandcastle-committed-vs-local-split.md), [ADR 0003](../adr/0003-shared-machine-install.md) · Glossary: [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

I want to run agents across several of my projects at the same time and answer
their parked questions from Telegram, but the current design cannot do that.
Telegram allows exactly one consumer per bot token, and today each project runs its
own `dispatch` poller — so a second project polling the same bot silently steals the
first's replies. The host-only pieces make it worse: the Telegram token and
`GIT_CONFIG_GLOBAL` live in a per-project `orchestrator.env`, and the systemd unit is
bound to one project's `WorkingDirectory`. There is no single place that knows about
all my projects and routes messages to the right one. Until there is, "run many
projects at once" is not real.

## Solution

One host-level **gateway** daemon fronts every project. Projects **register** with it
by handing over their **base location** (their `.sandcastle.local/` path); the gateway
reads each project's Telegram connection and secrets from there and never copies them.
The gateway is the **sole Telegram consumer** — it polls each distinct bot exactly
once, deduping projects that share a bot — and the **sole sender**: when a run parks,
it writes its parked record silently and the gateway announces the question to that
project's destination. When I reply, the gateway routes my answer to the exact project
and task it belongs to and resumes it using the shared install. The old per-project
`dispatch` and `attend` modes retire into the gateway, and `migrate` moves the
host-only secrets and the systemd unit up to the gateway so nothing project-bound is
left behind.

## User Stories

1. As a maintainer, I want a single gateway that serves all my projects, so that I can
   run agents in several projects at once without their Telegram traffic colliding.
2. As a maintainer, I want a project to register with the gateway by handing over only
   its base location, so that the gateway never duplicates my config or secrets.
3. As a maintainer, I want a run to register its project automatically when it starts,
   so that I never have to enroll a project by hand.
4. As a maintainer, I want registration to be a pointer only (`project`, project root,
   base location), so that editing my `sandcastle/` config needs no re-register — the
   gateway always reads live from the base location.
5. As a maintainer, I want the gateway to poll each distinct bot token exactly once
   even when several projects share it, so that Telegram's one-consumer-per-bot rule is
   never violated.
6. As a maintainer, I want two projects to be able to use their own separate bots, so
   that I can isolate them when I want to.
7. As a maintainer, I want a run that parks to write its record silently, so that the
   gateway is the only thing that ever sends to Telegram.
8. As a maintainer, I want the gateway to announce a newly parked question to that
   project's destination, so that I hear about it wherever that project routes to.
9. As a maintainer, I want my reply routed to the exact project and task whose question
   I replied to, so that the right agent resumes even when many are parked at once.
10. As a maintainer, I want the gateway to resume an answered task using the shared
    install in that project's directory, so that the resume runs with the project's own
    config and gates.
11. As a maintainer, I want several answered tasks to resume concurrently, so that one
    slow resume does not hold up the others (as `dispatch` does today).
12. As a maintainer, I want the gateway to survive a restart without losing which
    message belongs to which task, so that a reply sent while it was down still routes
    correctly.
13. As a maintainer, I want announcing to be idempotent, so that a restart does not
    re-send questions I have already been asked.
14. As a maintainer, I want a reply on a shared bot disambiguated by which question
    message it replies to, so that sharing a bot across projects still routes precisely.
15. As a maintainer, I want a `/status`-style query over Telegram to still work, so that
    I can get a live summary without a terminal.
16. As a maintainer, I want the old `dispatch` and `attend` modes retired, so that there
    is exactly one way (the gateway) that Telegram round-trips happen.
17. As a maintainer, I want `migrate` to move the host-only Telegram token and
    `GIT_CONFIG_GLOBAL` out of a per-project `orchestrator.env` and into the gateway, so
    that nothing host-only is left bound to a single project.
18. As a maintainer, I want `migrate` to rewrite the systemd unit from a
    per-project poller into the host-level gateway, so that the service is no longer
    bound to one project's directory.
19. As a maintainer, I want the gateway to run as a single host service, so that it
    starts on boot and restarts on failure independent of any project.
20. As a maintainer, I want a project whose base location has moved or been deleted to
    be tolerated (skipped, not crashing the gateway), so that one stale registration
    cannot take the whole gateway down.
21. As a maintainer running only one project with no wish for a gateway, I want a clear
    message that Telegram round-trips now go through the gateway, so that I am not
    surprised that inline per-run sending is gone.

## Implementation Decisions

- **Registry module (new).** A host-level pointer store under the gateway's config
  directory. `register(pointer)` upserts `{project, projectRoot, baseLocation}`;
  `listProjects()` returns the registered pointers; `readProject(pointer)` loads that
  project's Telegram connection + secrets live from its base location. Pointer-only —
  no config or secrets are copied into the registry (ADR 0002).
- **Auto-register on run.** The run entry points register (or refresh) the current
  project's pointer at start. Idempotent; a re-run just refreshes the pointer.
- **Gateway is sole consumer and sole sender (ADR 0002).** Runs no longer send to
  Telegram. `park()` writes the record silently; the gateway announces it. Only the
  gateway calls the Telegram send/poll API.
- **Telegram parameterized by a bot connection (prefactor).** The Telegram send/poll
  helpers take an explicit connection (token, chat, optional thread) instead of reading
  process-global env, so the gateway can poll and send per bot. This is the enabling
  change and lands first.
- **Poll dedupe.** A pure `pollTargets(projects)` collapses the registered projects to
  the distinct bot connections; the gateway runs one poll loop per distinct bot.
- **Send-time index.** A pure in-memory index maps `(botToken, messageId) →
  {project, task, baseLocation}`. `recordSend` fills it when the gateway announces a
  question; `resolveReply` reads it to route an incoming reply. The index is a cache:
  it is **rebuilt on startup** by scanning registered projects' parked records (which
  persist their announced message id and bot), so a restart loses nothing and a
  question is never re-announced.
- **Announcing.** A pure `pendingAnnouncements(projects, index)` returns the parked
  records that have not yet been announced (no stored message id). The gateway sends
  each to that project's destination and writes the returned message id back into the
  record, which both marks it announced and feeds index rebuild.
- **Minimal destination for E3.** A project's questions go to its single configured
  Telegram destination (its bot + chat, read from the base location). The full
  category→destination **notify map is E4**; E3 only needs "where do this project's
  questions go."
- **Resume.** On a routed reply, the gateway runs `answer <task> "<text>"` via the
  shared install in that project's root, so it resumes with the project's own config
  and gates. Resumes run concurrently (a child per answered task), replacing
  `dispatch`'s serial-friendly but per-project spawner.
- **`/status` over Telegram.** The gateway answers a status query with a summary across
  the projects the replying bot serves. Richer multi-project presentation is the
  dashboard's job (E5).
- **Retire `dispatch` and `attend`.** Their behavior is now the gateway's. Remove them
  as separate modes.
- **`migrate` extension (from E1's deferral).** Extend the layout-migration planner so
  it also folds a project's `orchestrator.env` (Telegram token, `GIT_CONFIG_GLOBAL`)
  into the gateway's host-level config and rewrites the systemd unit from a
  per-project `dispatch` poller into the host-level gateway service.
- **Stale registrations tolerated.** A pointer whose base location is gone is skipped
  with a log line, never fatal to the gateway loop.

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs: given a set
  of registered projects and an incoming reply, which project+task is resolved; given
  projects sharing a bot, which distinct connections are polled; given parked records,
  which need announcing. The routing/dedupe/announce logic is pure — no network, no
  spawned processes, no Telegram.
- **Modules tested.** (1) The reply index — `recordSend`/`resolveReply`, including a
  shared-bot case disambiguated by message id and a miss returning null. (2)
  `pollTargets` dedupe — several projects, shared and distinct bots. (3)
  `pendingAnnouncements` — records already announced vs not, and index rebuilt from
  persisted records. (4) The registry — register/list/read against a tmp config dir,
  including a stale (missing base location) pointer skipped. (5) The gateway loop with
  an **injected** poller and an **injected** resume-runner, asserting a fake inbound
  reply drives exactly one resume of the right task.
- **Prior art.** `carve.test.ts` (pure logic over fake resolvers) for index/dedupe/
  announce; `state.test.ts` / `archive.test.ts` (fs against `tmpdir()`) for the registry
  and parked-record interplay. Telegram itself stays untested behind the injected
  connection, as it is today.

## Out of Scope

- **The full comms taxonomy and notify map** (category→destination routing for success/
  failure/progress/finding) — E4 (#15). E3 sends only the `question` category, to the
  project's single destination.
- **The multi-project dashboard** and aggregated status site — E5 (#16). E3's Telegram
  `/status` is a text summary only.
- **`init`** (scaffolding a new project) — E2 (#13). E3 assumes a project already exists
  and can be registered.
- **The E1 layout move itself** — E3 only *extends* `migrate` with the gateway-coupled
  parts (`orchestrator.env` fold, systemd rewrite) that E1 deliberately deferred.

## Further Notes

- Telegram permits exactly one consumer per bot token; the gateway being the single
  consumer is what makes concurrent projects possible at all. This is the load-bearing
  reason the gateway exists.
- Because the gateway is now the only sender, running Telegram round-trips *requires* the
  gateway. Story 21 is the explicit heads-up for a single-project user who previously
  relied on inline per-run sending via `attend`.
- The index-rebuild-from-parked-records decision means the gateway holds no separate
  durable state of its own beyond the registry pointers — parked records remain the
  source of truth, consistent with the dumb-router stance (ADR 0002).
