# Configuration lives in layers keyed by scope, secrecy, and whether it reaches the container

Vetinari's configuration had drifted into conflation, and the symptoms all traced to a
missing model: the migration folded every project's Telegram token up into a single
host-level `gateway.env` (making the gateway look like it needed its own credentials,
and refusing a second project's differing token as a conflict); the Telegram token was
also declared in the container-bound `.env` and so rode into every agent container; and
per-host, per-project, and per-run concurrency knobs were tangled, a run's parallelism
cap even reaching gateway-spawned children through the gateway's own environment. This
ADR records the model those symptoms came from.

**Every configuration item is placed by three orthogonal questions, and the answers
determine which file it lives in:**

- **Scope — whose property is it?** *Host* (a property of the machine, shared by every
  project, set host-side and never in a repo), *Project* (the same for every run of one
  project), or *Run* (one invocation).
- **Secret?** No → the project's **committed** `vetinari/config.mts` (versioned, shared,
  holds zero secrets). Yes → the project's **excluded** `.vetinari.local/`.
- **Container-reach — does it cross into the agent container?** The axis the other two
  miss: two secrets of the same scope can differ here — the model-harness token the
  agent needs versus the Telegram token only the host sends with. It splits the excluded
  secrets into container-bound and host-only.

From those axes, the homes:

| Home | Holds |
| --- | --- |
| Host — env `MAX_CONCURRENT_CONTAINERS`, or a file in the gateway config dir | the machine-wide ceiling on live containers |
| `vetinari/config.mts` — committed, **no secrets** | image, gates, setup, mounts, prompt, agent (container behaviour); `containerShare`, `stateDir`, `hostEnv`, branch settings (host-only knobs); destinations + notify, fetchTask, fileSet (routing / planning) |
| `.vetinari.local/.env` — **the container gate** | only secrets the in-container agent needs (the model-harness token) |
| `.vetinari.local/host.env` — host-side secrets | the Telegram bot token + chat, read by the orchestrator process and live by the gateway — **never** into a container |

**Two invariants hold this together.** First, **the container gate is exactly one
file**: only keys declared in `.vetinari.local/.env` cross into the sandbox (sandcastle
injects them as container environment), so any secret that must not reach the agent — the
Telegram token, and `GIT_CONFIG_GLOBAL` — stays out of it by construction. Second, **the
gateway persists none of the project or run layers** (reaffirming ADR 0002): it holds no
credential of its own, reads each project's connection live from its registered base
location, and is reconstructable from the pointer registry alone. A corollary rule:
`hostEnv` values are **non-secret** (paths, flags — e.g. `GIT_CONFIG_GLOBAL` points at a
writable gitconfig path, not a credential); a secret the host process needs belongs in
`host.env`, never as a literal in committed config.

**Concurrency is three named, separated concepts** — revising the *config surface* of
ADR 0010, whose cooperative-lease mechanism (drain-to-share, no preemption) is unchanged:

- **`MAX_CONCURRENT_CONTAINERS`** (Host) — the machine's ceiling; a project running
  alone consumes all of it. Unset resolves to a sensible machine-derived default rather
  than "unbounded", so the machine is never swamped.
- **`containerShare: high | medium | low`** (Project, default `medium`) — a project's
  cut of the ceiling *when projects contend*. It is a **weighted share with a floor of
  one, never preemptive and never starving**: "high" takes more of the remainder, not
  all of it. A named tier replaces a raw numeric weight so nobody has to reason about why
  a given number of containers is running.
- The per-run parallelism cap is **eliminated** — it was the knob that made effective
  concurrency opaque and that leaked into gateway-spawned children. A run simply fills up
  to its current fair share; a lone project fills the ceiling.

## Considered Options

- **A two-axis "config vs secrets" split.** Rejected: it cannot express why the Telegram
  token and the model token — same scope, same secrecy — belong in different files. The
  container-reach axis is load-bearing.
- **Keep the per-run parallelism cap.** Rejected: it is the source of "why are only N
  containers running?" opacity and of the run-knob-through-the-gateway conflation. The
  host ceiling plus the priority-weighted share expresses the same intent with no
  per-project number.
- **A numeric project weight (the status quo).** Rejected for the named `containerShare`
  tiers: three legible levels beat arbitrary integers whose emergent effect on
  parallelism is hard to predict.

## Consequences

- The Telegram token must be **removed from `.vetinari.local/.env`** (it currently leaks
  into every container) and live only in `host.env`; a token already exposed there should
  be rotated.
- **`gateway.env` and its systemd sourcing are removed** — nothing legitimate lived
  there once secrets are host-read and `GIT_CONFIG_GLOBAL` is self-applied per project.
- The renames (numeric weight → `containerShare`, the host-ceiling env var →
  `MAX_CONCURRENT_CONTAINERS`, `orchestrator.env` → `host.env`, and dropping the per-run
  cap) are breaking config / env changes carried by `migrate`. The container-secrets file
  keeps its sandcastle-imposed name `.env`.
- Where a new knob goes is now mechanical: answer the three axes.
