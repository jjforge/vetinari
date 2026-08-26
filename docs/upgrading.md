# Upgrading

Two things get updated independently: this package (the orchestrator) and
`@ai-hero/sandcastle` (the library it runs on). Both come down to the same habit
afterwards: re-run `baseline` in each consuming project, because that is what
proves the image, gates, and config an update has to keep working, and it costs
no agent.

## Update this package

**Installed from git** (`github:jjforge/vetinari`): npm copies the repo
at a commit, so updates are explicit:

```bash
npm update vetinari                          # move to the tip of main
npm install github:jjforge/vetinari#<sha>           # or pin to a commit
```

Then re-run `npx vetinari baseline` in that project. Its image, gates, and
config are what an update has to keep working, and `baseline` exercises all
three without agent cost.

**Installed from a local path** (`file:../vetinari`): npm creates a
**symlink**, so the consuming project always runs your working tree and a `git
pull` in the package directory takes effect immediately with no reinstall.
Convenient while developing the orchestrator, and worth knowing when debugging:
a consuming project has no pinned version to blame, because it has no pin.

Config changes are the other update path. `defineConfig` is typed, so `npx tsc
--noEmit` in the consuming project catches a renamed or dropped field.

## Update `@ai-hero/sandcastle`

> **Temporary fork pin.** `@ai-hero/sandcastle` is pinned to a fork,
> `git+https://github.com/zachthieme/sandcastle.git`, at the `state-dir-prebuilt`
> commit, for the `stateDir` option vetinari needs (it routes sandcastle's own
> artifacts under `.vetinari.local/` instead of a stray `.sandcastle/`). That
> branch carries a prebuilt `dist/`, because npm 11 blocks a dependency's
> build-on-install scripts by default and a git install could not otherwise build
> it. The change itself is upstream as
> [mattpocock/sandcastle#961](https://github.com/mattpocock/sandcastle/pull/961);
> this pin is temporary, to be dropped for a published `@ai-hero/sandcastle` (the
> flow below) once that PR lands in a release. The clean feature branch
> (`configurable-state-dir`, what the PR tracks) carries no `dist/`.

When on a published release, the dependency is pinned `^0.12.0`, so npm's caret
allows patches only. sandcastle is pre-1.0, so a minor can carry behavioural
changes; pinning to patches lets us adopt a minor deliberately, after re-verifying
the integration points below, rather than by surprise.

```bash
npm install @ai-hero/sandcastle@latest   # here, and in each consuming project
npm run check-contract                   # ~1s, no Docker: is the surface intact?
npx vetinari baseline              # container + gate path still work
npx vetinari run <small task>      # agent + session + resume still work
```

Climb all four rungs, because each sees what the one below cannot.
`check-contract` catches a renamed export or dropped option in about a second;
`tsc` alone will **not**, because vetinari probes a few optional members of
sandcastle's result objects at runtime. `baseline` proves the container path.
Only a real `run` exercises the agent, the gate→resume cycle, and session capture.

vetinari builds on four sandcastle behaviours that no static check can see. These
are the integration points `check-contract` prints, and the ones we re-verify on
any minor bump:

1. **A sandbox command returns a non-zero exit code rather than throwing.** This
   is what lets a red gate read as red, so it is the behaviour we depend on most
   and the first we check on an upgrade.
2. **`resumeSession` is used without `maxIterations > 1`.**
3. **An idle agent throws a catchable timeout**, which is how a stall is detected
   and parked.
4. **Session capture writes host-side JSONL, and re-creating a sandbox on an
   existing branch reuses that worktree**: together, what make park→answer
   survive a fresh process.

Consuming projects pin the library themselves (it's a peer in practice), so bump
it there too and re-run that project's `baseline`.
