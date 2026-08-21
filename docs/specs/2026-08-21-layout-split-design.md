# E1: Layout split + config resolution + migrate

Epic: [#12](https://github.com/jjforge/sandcastle-tdd/issues/12) · Source: [ADR 0001](../adr/0001-sandcastle-committed-vs-local-split.md), [ADR 0003](../adr/0003-shared-machine-install.md) · Glossary: [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

I want to run sandcastle-tdd against several of my projects at once, but the way a
project is laid out today makes the boundaries porous. Everything lives under one
gitignored `.sandcastle/` directory — logs, parked records, container secrets,
*and* an accepted config location (`.sandcastle/config.mts`). Because that
directory is excluded, project configuration that should be versioned with the
repo can silently live where it is never committed. There is no clean line between
"the parts of this that belong to the project and should be shared" and "the parts
that are this machine's and must never be checked in." Until that line exists, I
cannot confidently stand the tool up in a second and third project.

## Solution

Every consuming project gets two directories with opposite, unmistakable meanings:

- **`sandcastle/`** — committed. The project's versioned configuration: the config
  module, the project's `Dockerfile`, and any prompt override.
- **`.sandcastle.local/`** — excluded (gitignored). This machine's moving parts:
  the project's credentials (`.env`), run logs, and run state (`parked/`). The
  `.local` suffix carries the "yours, not shared" convention I already use
  (`settings.local.json`, `.env.local`). sandcastle-tdd itself is a shared machine
  install (ADR 0003), so nothing runtime-related lives here.

Config resolution stops accepting a config inside the excluded directory. The new
canonical config location is `sandcastle/config.mts`; the old locations keep
working for one minor release but emit a deprecation warning, so a live setup is
never broken the moment it upgrades.

A `sandcastle migrate` command moves an existing project onto the new layout in one
step, so I never have to hand-shuffle directories or hand-edit `.gitignore`.

## User Stories

1. As a maintainer, I want my project's sandcastle configuration to live in a
   committed `sandcastle/` directory, so that it is versioned and shared with
   everyone who checks out the repo.
2. As a maintainer, I want all credentials, logs, and state under a single excluded
   `.sandcastle.local/` directory, so that nothing machine-local is ever committed.
3. As a maintainer, I want the two directory names to be visibly different (not one
   dot apart), so that I never confuse the committed one with the excluded one in
   speech, `ls`, or tab-completion.
4. As a maintainer, I want `sandcastle/config.mts` to be the canonical config
   location, so that there is one obvious place my config belongs.
5. As a maintainer, I want config resolution to search candidates in a defined
   precedence order, so that the winning config is predictable when more than one
   exists.
6. As a maintainer with an old `.sandcastle/config.mts`, I want the tool to still
   find it but warn me it is deprecated, so that my existing project keeps working
   while I am told to move it.
7. As a maintainer with an old root `sandcastle-tdd.config.mts`, I want the same
   deprecation warning, so that every legacy location is called out consistently.
8. As a maintainer, I want the deprecation warning to name the new location, so
   that I know exactly where to move the file.
9. As a maintainer with no config anywhere, I want a clear error that lists the
   canonical location and how to create one, so that I am not left guessing.
10. As a maintainer, I want run state (`logs/`, `parked/`) to default into
    `.sandcastle.local/` instead of `.sandcastle/`, so that state follows the new
    excluded directory with no extra configuration.
11. As a maintainer, I want a fresh checkout to gitignore `.sandcastle.local/`, so
    that secrets and state cannot be accidentally committed.
12. As a maintainer, I want to keep `.sandcastle/` ignored during the transition,
    so that a not-yet-migrated project does not start leaking its old state.
13. As a maintainer, I want a `sandcastle migrate` command that moves an existing
    project onto the new layout, so that I do not have to shuffle directories by
    hand.
14. As a maintainer, I want `migrate --dry-run` to print exactly what it would move
    without touching anything, so that I can review the plan before committing to it.
15. As a maintainer, I want `migrate` to move my config from its old location into
    `sandcastle/`, so that it becomes committed and canonical.
16. As a maintainer, I want `migrate` to move my old `.sandcastle/` state and
    secrets into `.sandcastle.local/`, so that nothing is lost and the old
    directory is retired.
17. As a maintainer, I want `migrate` to update `.gitignore` to exclude
    `.sandcastle.local/`, so that the new excluded directory is protected without my
    editing the file.
18. As a maintainer, I want `migrate` to be idempotent — safe to run twice — so that
    re-running it on an already-migrated project changes nothing and reports so.
19. As a maintainer, I want `migrate` to refuse to clobber an existing destination
    and tell me why, so that I never silently lose files to a half-done previous run.
20. As a maintainer, I want `migrate` to warn me about the parts it deliberately does
    not handle (Telegram/orchestrator secrets and the systemd unit), so that I know
    those are handled by the gateway epic and not forgotten.
21. As a maintainer, I want `migrate` to report a clear summary of what it moved, so
    that I can verify the result at a glance.
22. As the maintainer of sandcastle-tdd itself, I want to run `migrate` on this repo
    (dogfood), so that the tool's own project proves the migration on a real layout.
23. As a maintainer, I want a passing `baseline` after migrating, so that I know the
    layout change did not break how the orchestrator finds its config, state, or logs.

## Implementation Decisions

- **Two directories, fixed meaning (ADR 0001).** `sandcastle/` = committed;
  `.sandcastle.local/` = excluded. Names chosen to differ by a whole word, not a
  dot.
- **Config candidate precedence.** New order, highest first: `sandcastle/config.mts`,
  `sandcastle/config.ts`, then the deprecated `sandcastle-tdd.config.mts`,
  `sandcastle-tdd.config.ts`, `.sandcastle/config.mts`. `.sandcastle/config.mts` is
  no longer canonical; it only resolves as a deprecated fallback.
- **Extract a pure resolver.** A new `resolveConfigPath(baseDir)` returns the winning
  path and, if it came from a legacy location, which one — doing candidate precedence
  and existence checks only, with no module import or execution. `loadConfig` calls
  it, dynamically imports the resolved path as it does today, and emits a deprecation
  warning when the resolver reports a legacy origin. The warning names
  `sandcastle/config.mts` as the destination.
- **Not-found error lists the canonical path.** When no candidate exists, the error
  leads with `sandcastle/config.mts` and mentions `--config <path>`.
- **State default flips.** The default `stateDir` becomes `.sandcastle.local` (was
  `.sandcastle`); `parkedDir` and `logFile` continue to derive from it, and the
  hardcoded default in the logger moves in step. An explicit `stateDir` in a project's
  config still wins.
- **New `migrate` module, planner + apply.** `computeLayoutMigration(scan)` is a pure
  planner that takes a description of what exists on disk (old config location present,
  `.sandcastle/` present and its contents, current `.gitignore`) and returns a plan:
  the set of moves, the `.gitignore` edit, and any warnings. `applyLayoutMigration(plan)`
  performs the filesystem moves and the `.gitignore` edit. A new `migrate` CLI mode
  wires them, honoring `--dry-run` (print the plan, apply nothing).
- **Migration scope guard.** E1's `migrate` performs the **layout move only**: config →
  `sandcastle/`, `.sandcastle/` state+secrets → `.sandcastle.local/`, `.gitignore`
  update. Folding host-only orchestrator secrets and rewriting the systemd unit are
  **deferred to E3 (gateway)**; `migrate` emits a warning pointing at that follow-up
  rather than attempting it.
- **Idempotent and non-clobbering.** Running `migrate` when already migrated yields an
  empty plan and a "nothing to do" report. A move whose destination already exists is
  refused with a clear message rather than overwriting.
- **`.gitignore` keeps both entries during the transition.** Add `.sandcastle.local/`;
  leave `.sandcastle/` ignored so a partially-migrated tree cannot leak old state.

## Testing Decisions

- **What makes a good test here.** Assert only external behavior: for resolution, the
  path chosen and whether a deprecation was signaled given a set of files on disk; for
  migration, the plan produced from a described on-disk state and the resulting files
  after apply. Never assert on internal call order or private structure. The pure
  planner and pure resolver are the seams — they take plain inputs and return plain
  data, so tests need no mocking of Docker, Telegram, or the agent.
- **Modules tested.** (1) `resolveConfigPath` — candidate precedence, a deprecation
  origin reported for each legacy location, and the not-found case; plus `loadConfig`'s
  resolved `stateDir`/`parkedDir`/`logFile` defaults flipping to `.sandcastle.local`.
  (2) `computeLayoutMigration` — the plan for a fresh legacy project, an
  already-migrated project (empty plan), and a conflicting destination (refusal). (3)
  `applyLayoutMigration` — files land where the plan says, `.gitignore` is updated,
  against a tmp dir.
- **Prior art.** `carve.test.ts` is the model for testing a pure planner via a fake
  resolver (`computeCarve` with an in-memory edge map). `archive.test.ts` and
  `state.test.ts` are the model for filesystem behavior against a `tmpdir()` working
  directory. Config-resolution tests are new — there is no `config.test.ts` today.

## Out of Scope

- **The `sandcastle init` scaffold** for a new project — that is E2 (#13). E1 changes
  where config and state resolve and provides `migrate`; it does not add `init`.
  sandcastle-tdd is a shared machine install (ADR 0003) — there is no launcher or
  vendored runtime in scope anywhere.
- **The gateway**, registration, and the single Telegram consumer — E3 (#14). The
  `orchestrator.env` fold and systemd-unit rewrite parts of ADR 0001's migration ride
  with the gateway, not here.
- **The comms taxonomy / notify map** (E4, #15) and the **multi-project dashboard**
  (E5, #16).
- **Removing the deprecated config locations.** E1 keeps them working with a warning;
  the actual removal is a later minor release, tracked separately.

## Further Notes

- Existing state/status/archive tests construct `ResolvedConfig` with an explicit
  `stateDir` pointing at a tmp dir, so the default flip does not disturb them.
- The deprecation window is one minor release (ADR 0001). Dropping the legacy
  candidates should be filed as its own follow-up when that release lands.
- Dogfooding this repo (story 22) is the acceptance test for `migrate`: this project's
  own `.sandcastle/` becomes `.sandcastle.local/` and a `baseline` still passes.
