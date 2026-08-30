# The agent provider is selectable per run; the loop drives resumable and non-resumable providers alike

Status: recorded in design.md §12.

Vetinari runs its per-turn loop against a single **agent provider** seam — the one
place a sandcastle `AgentProvider` is constructed (`agentFor`). We decided to make
that seam **provider-agnostic**: it dispatches on a provider name rather than
hard-wiring Claude Code, so a run or campaign can execute on **Claude, pi, Codex,
GitHub Copilot CLI, Cursor, or OpenCode**. Claude remains the default — a project or
invocation that names no provider runs exactly as before, so the capability is
purely additive.

## Resumable and non-resumable providers both drive the loop

The loop's steady state is **resume-based**: after a red gate it reads the run's
session id and resumes that session on the next turn. The providers that expose
durable session storage — **Claude Code, pi, Codex** — drive it this way unchanged.

The **non-resumable** providers (GitHub Copilot CLI, Cursor, OpenCode) carry no
session to resume. Rather than reject them, the loop drives them by **re-entering
each red turn as a fresh run** through the same path the first turn uses: it
re-reads the issue, the agent sees its own prior work as **commits already on the
branch**, and the prompt carries the gate report plus the **most-recent turn
summary** (bounded — never the full history). A single resumability flag, derived
from the non-resumable set, is the one fact the loop branches on; everything else —
the `maxTurns` ceiling, host budget, and the green / empty-green / `BLOCKED` /
budget-park outcomes — is identical to a resumable run. A one-shot agent is simply
`maxTurns 1`, not a separate mode.

One gap remains: a non-resumable run that `BLOCKED`-parks has no session to resume,
so its question cannot yet be **answered** — the park→answer path for these
providers (posting the human's reply as an issue comment) is a separable follow-up.

## Selection

Selection lives in two places, override winning:

- a **config default** on the `agent` object (`provider`, alongside the existing
  `model`/`effort`), the steady-state choice for a project;
- a **`--agent` override** on `run`/`queue`/`campaign`, the per-invocation lever
  (also carrying optional `model`/`effort`). It applies to the whole invocation and
  is threaded to campaign/queue **child** runs, so every wave uses the chosen agent.

Absent both, the default is Claude. `model` and `effort` are **passed through in the
selected provider's own vocabulary** and validated against that provider's allowed
set — each provider has a different effort enum, so an invalid combination fails
fast rather than silently downgrading; omitted values fall back to a per-provider
default (effort `high`, plus a per-provider default model).

## The image and credentials are per-provider

An agent needs its **CLI in the container image** and its **credentials in the
run's `.env`**. The reference image carries the pi and Codex CLIs alongside Claude
Code, and each provider's credential keys are documented; credentials stay
user-supplied per provider. A run whose selected provider has no credentials present
fails a **preflight** check rather than dying inside the container.

## Consequences

- Token accounting is **Claude-only**: session-usage parsing is implemented only for
  Claude Code, so a pi/Codex run reports zero usage. This is accepted — the figure is
  informational and host concurrency is container-count based, not token based.
- The codebase stops being Claude-specific by assumption; docs and config comments
  that framed the agent as "the Claude CLI" are corrected to the provider-agnostic
  model.

## Considered Options

- **A comparison / bake-off harness** (run one task across N agents, diff outcomes) —
  rejected for now: a separable, larger feature. Selection alone lets an operator
  experiment by running the same ticket under different providers.
- **Per-provider config blocks** (`agents: { pi: {...}, codex: {...} }`) — rejected as
  premature: one `agent` object with a `provider` field and per-provider defaults
  covers the one-agent-per-run reality without the extra surface.
- **A single abstract effort scale** mapped per provider — rejected: it would hide
  each provider's richer levels (`xhigh`/`max`/`off`/`minimal`) that experiments want.
  Pass-through-and-validate keeps the full vocabulary.
- **One fat image with every agent CLI, or leaving the image entirely to the user** —
  rejected at both extremes: the reference image ships the supported CLIs, but
  credentials remain per-provider and user-supplied.
