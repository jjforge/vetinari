# The host sandbox runs agents unsandboxed, by opt-in

Status: recorded in design.md §3.

Some projects have a toolchain that exists only on macOS: Xcode, `xcrun`, the iOS
simulator. None of it runs in a Linux container, so the Docker sandbox cannot give such
a project a real gate. The `sandbox` config seam already lets a project replace Docker,
and sandcastle ships a no-container provider, `noSandbox()`, whose `exec` runs on the
host in the run's worktree.

## The decision

vetinari exports **`hostSandbox()`**, a `sandbox` factory for `noSandbox()`. A project
selects it with `sandbox: hostSandbox()` in `vetinari/config.mts`, and needs no `image`.

- **Opt-in only.** Nothing selects it but that line: it is never a default, and never
  a fallback when Docker is missing. A hand-written `sandbox: () => noSandbox()` is
  treated the same way.
- **Visible.** Every `campaign`, `redrive`, `run`, `answer` and `baseline` start prints
  one `⚠ unsandboxed` line on stderr (not repeated by a campaign child). The `sandbox`
  event row carries `sandbox: "host"`.
- **One issue at a time.** A host-sandbox project's campaign declares a demand of at
  most one slot, so it runs its waves one issue at a time, whatever the host ceiling.
  Host agents share one set of simulators, DerivedData and caches, and parallel
  `xcodebuild test` runs collide on them. Other projects keep the slots it does not
  want. Two standalone `run`s started by hand are not held apart.
- **GNU `timeout` is required.** Every gate runs under `timeout`, which macOS does not
  ship. A host-sandbox start refuses, naming GNU coreutils, when `timeout` is not on
  PATH, rather than letting every gate exit 127.

## What the agent gets

The agent runs as the operator's user, with the operator's filesystem and whole
environment, plus the keys in `.vetinari.local/.env`. It has any `gh` or ssh login the
operator has, `host.env` is readable on disk, and sandcastle runs it with
`--dangerously-skip-permissions`, so there are no permission prompts.

## What no longer holds

- **The `.env` / `host.env` split.** Nothing is withheld from a host agent.
- **ADR 0021's Docker-peer guard.** A host agent reaches the dashboard over loopback,
  which the guard admits.
- **ADR 0026's premise** that an agent cannot edit an issue and that its change to
  `vetinari/` only runs on the host at a later CLI start. A host agent already runs on
  the host and may hold the operator's tracker login.
- **The global git config is touched.** With `setup` set, sandcastle adds each worktree
  to the operator's global git `safe.directory`.
- **Copilot cannot resume.** Its per-issue session directory (ADR 0024) is a container
  mount, and the host has no mount.

## What still holds

Each run keeps its own branch and worktree under `<stateDir>/worktrees`. The
orchestrator still runs the gates and decides green, and the host lease still bounds
every project's containers.
