# vetinari is one shared machine install, not vendored per project

Status: recorded in design.md §1.

vetinari is installed once on the host and that single install is shared by
every project on the machine. A project is not given its own copy of the runtime
and does not pin a version — it runs whatever the machine has installed. The CLI
operates on whichever project it is invoked in: the working directory selects the
project, and config resolution (ADR 0001) finds that project's committed
`vetinari/` config and its excluded `.vetinari.local/` state. The gateway
(ADR 0002) is a host-level singleton from the same shared install.

This corrects an earlier same-session draft that proposed a thin launcher plus a
**vendored, per-project pinned runtime** copied into each `.vetinari.local/`.
That was rejected once the model was stated plainly: it added a launcher, a
vendoring step, and per-project version state for a benefit — per-project version
isolation — that is not wanted. A shared install is simpler, and keeping
vetinari out of the app's `package.json` is already achieved by it being a
machine install rather than a project dependency.

## Consequences

Every project on the machine runs the same installed version; upgrading the
install moves all of them at once. There is no per-project runtime under
`.vetinari.local/` — that directory holds only credentials, run logs, parked
records, and run state. Onboarding a new project is therefore just scaffolding the
two directories (a `vetinari init`), not installing or vendoring anything.
