# E2: `sandcastle init` — scaffold a new project onto the layout

Epic: [#13](https://github.com/jjforge/sandcastle-tdd/issues/13) · Source: [ADR 0003](../adr/0003-shared-machine-install.md), [ADR 0001](../adr/0001-sandcastle-committed-vs-local-split.md) · Glossary: [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

sandcastle-tdd is installed once on my machine and shared by every project, but
standing a *new* project up still means doing the layout by hand: create the
committed `sandcastle/` directory, write a config module, copy in a Dockerfile,
create the excluded `.sandcastle.local/`, and add it to `.gitignore`. That is
fiddly, easy to get subtly wrong, and something I have to redo for every project I
want to run agents against.

## Solution

A single `sandcastle init` command scaffolds a project onto the layout: it creates
a committed `sandcastle/` (a config template plus a Dockerfile template to fill in)
and an excluded `.sandcastle.local/`, and adds `.sandcastle.local/` to `.gitignore`.
Because sandcastle-tdd is a shared machine install, `init` installs and vendors
nothing — it only lays down files. After `init`, I fill in my toolchain and gates
and I am ready to build the image and run `baseline`.

## User Stories

1. As a maintainer, I want `sandcastle init` to create the committed `sandcastle/`
   directory, so that my project config has its versioned home without my making it
   by hand.
2. As a maintainer, I want `init` to drop a config template into `sandcastle/`, so
   that I start from a working `defineConfig` skeleton instead of a blank file.
3. As a maintainer, I want `init` to drop a Dockerfile template into `sandcastle/`,
   so that I have the standard base image to add my toolchain to.
4. As a maintainer, I want `init` to create the excluded `.sandcastle.local/`
   directory, so that credentials, logs, and run state have their machine-local home.
5. As a maintainer, I want `init` to add `.sandcastle.local/` to `.gitignore` (creating
   the file if absent), so that secrets and state can never be accidentally committed.
6. As a maintainer, I want `init` to be idempotent — safe to run twice — so that
   re-running it on an already-initialized project changes nothing and says so.
7. As a maintainer, I want `init` to refuse to overwrite an existing `sandcastle/`
   config and tell me why, so that I never lose config I already wrote.
8. As a maintainer, I want `init --dry-run` to print what it would create without
   writing anything, so that I can review the plan first.
9. As a maintainer, I want `init` to print a summary of what it created and the next
   steps (fill the Dockerfile/gates, build the image, run `baseline`), so that I know
   what to do next.
10. As a maintainer, I want `init` not to install or vendor any runtime, so that it
    stays fast and my project never carries a copy of sandcastle-tdd.
11. As a maintainer, I want the scaffolded config to already point run state at
    `.sandcastle.local/` by default, so that the two directories line up out of the box.

## Implementation Decisions

- **Planner + apply.** A pure `computeInit(scan)` takes a description of the target
  directory (does `sandcastle/` exist, does `.sandcastle.local/` exist, current
  `.gitignore`) and returns a plan: the files/dirs to create and the `.gitignore`
  edit. `applyInit(plan)` writes them. A new `init` CLI mode wires them and honors
  `--dry-run`.
- **Templates come from the shared install.** The config skeleton and the Dockerfile
  template ship with sandcastle-tdd (the Dockerfile template already exists in the
  install) and are copied into the project's `sandcastle/`. `init` installs nothing.
- **Idempotent and non-clobbering.** Re-running yields an empty plan and a "nothing to
  do" report. An existing `sandcastle/config` is never overwritten — `init` refuses
  with a clear message. Missing pieces (e.g. only `.gitignore` needs the entry) are
  filled in without disturbing what already exists.
- **Config resolution is E1's job.** `init` writes the layout; finding and loading it
  is E1's config resolution. `init` does not add any project-selection logic.

## Testing Decisions

- **What makes a good test here.** Assert external behavior only: the plan produced
  from a described target directory, and the files present after apply. The pure
  planner is the seam — plain inputs, plain plan out — so no mocking of the filesystem
  beyond a tmp working directory.
- **Modules tested.** `computeInit` — a fresh directory (full scaffold plan), an
  already-initialized directory (empty plan), a directory with an existing
  `sandcastle/` config (refusal), and a directory with a `.gitignore` missing the
  entry (only the gitignore edit planned). `applyInit` — files land where the plan
  says and `.gitignore` is updated, against a tmp dir.
- **Prior art.** `carve.test.ts` for the pure planner; `archive.test.ts` for
  filesystem behavior against a `tmpdir()`.

## Out of Scope

- **Registration with the gateway** — deferred to E3 (#14), which owns the registry
  format and auto-register-on-run. `init` does not register.
- **`migrate`** (moving an *existing* project onto the layout) — that is E1 (#18).
  `init` is for a *new* project.
- **Filling in the project's actual toolchain, gates, and secrets** — the maintainer
  does that after `init`; the templates are skeletons.
- **Any launcher, vendoring, or version pinning** — explicitly not part of the model
  (ADR 0003).

## Further Notes

- `init` and `migrate` are siblings built on the same planner+apply shape: `init` for
  a greenfield project, `migrate` for one already on the old layout. Keeping their
  structure parallel is deliberate.
