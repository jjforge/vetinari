# Split project config from runtime/secrets into `vetinari/` and `.vetinari.local/`

A consuming project keeps its versioned Vetinari configuration in a committed
`vetinari/` directory, and all runtime, secrets, and run state in an excluded
`.vetinari.local/` directory. The `.local` suffix carries the "yours, not
shared" convention already established by `settings.local.json` and `.env.local`,
so the split reads as a sentence: `vetinari/` is shared, `.vetinari.local/`
is this machine's.

This exists to kill a porous boundary in the old layout, where
`.sandcastle/config.mts` was an accepted config location *inside* the gitignored
directory — so project configuration that should be versioned could silently live
where it was never committed. `.sandcastle/config.mts` is dropped from the config
candidate list; config now resolves only from the committed `vetinari/`.

## Considered Options

- **`vetinari/` vs `.sandcastle/` (dot-switch)** — rejected despite its
  elegance: the two directories mean opposite things (commit vs never-commit) yet
  differ by a single character, indistinguishable in speech, `ls -a`, or
  tab-completion. Too much meaning on one dot.
- **`.config/vetinari/` for committed config — rejected: buries project
  config under a generic dotfile and splits it from the runtime dir it pairs with.
- **Keep a single root `vetinari.config.mts`** — rejected: config isn't
  alone; the project's `Dockerfile` and prompt override are also versioned config
  and want a home beside it.

## Consequences

vetinari is a shared machine install (ADR 0003), so the app's
`package.json` never references it and nothing runtime-related lives under
`.vetinari.local/` — only credentials, run logs, and run state. All secrets —
including the project's Telegram bot token — stay in `.vetinari.local/`; the
gateway never duplicates them, it reads them from each project's registered base
location (see ADR 0002).

**Migration.** An automated `vetinari migrate` moves an existing project onto
the new layout (config → `vetinari/`, `.sandcastle/` → `.vetinari.local/`,
`orchestrator.env` folded into the gateway, systemd unit rewritten to the
host-level gateway). The old `.sandcastle/config.mts` location keeps resolving —
with a deprecation warning — for one minor release, then is dropped, so a live
setup is not broken the moment it upgrades.
