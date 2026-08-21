# Thin global launcher, runtime vendored per project

The only thing installed on the host is a **thin `sandcastle` launcher**. It does
not contain the orchestrator. `sandcastle init` scaffolds a project's
`sandcastle/` and `.sandcastle.local/`, pulls a **pinned, vendored copy of the
sandcastle-tdd runtime into `.sandcastle.local/`**, and auto-registers the project
with the gateway. When run inside a project, the launcher delegates to that
vendored runtime — so each project pins its own version independently, and an
upgrade to one project never moves another.

The **gateway** is a host-level singleton and runs from its own separately-pinned
runtime under `~/.config/sandcastle/`, not from any project's vendored copy.

## Considered Options

- **One global runtime; `.sandcastle.local/` holds only a version ref** —
  rejected: lighter, but loses true per-project version isolation and reintroduces
  a shared moving part across projects, which is the coupling this whole effort
  removes.
- **Runtime as a normal committed dependency in the app's `package.json`** —
  rejected in ADR 0001: it puts sandcastle-tdd in the app's dependency graph.

## Consequences

Disk cost: each project carries its own runtime copy. The launcher must resolve
"am I inside a project?" (find an ancestor `.sandcastle.local/`) to decide between
delegating to a vendored runtime and running a host-level command like `gateway`.
