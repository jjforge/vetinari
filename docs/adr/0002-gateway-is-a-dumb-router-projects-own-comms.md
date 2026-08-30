# The gateway is a dumb router; projects own their comms and register a pointer

Status: recorded in design.md §10.

The host-level gateway holds no project config and no secrets. Each project owns
its full Telegram configuration in its committed `vetinari/` (destinations, and
which message category goes where) with tokens in its excluded
`.vetinari.local/`. A project **registers** with the gateway by handing it a
**base location** (the `.vetinari.local/` path); the gateway reads everything it
needs from there and never copies it. This keeps the gateway's own config trivial
and means a secret lives in exactly one place.

The gateway's jobs are narrow: be the **single Telegram consumer** (deduping
projects that share a bot token so a bot is polled exactly once, satisfying
Telegram's one-consumer-per-bot rule), route each project's outbound messages per
that project's rules, and route inbound replies back to the right project's parked
task by reply-to-message id.

Because the gateway is the sender, it resolves replies with a **send-time index**
`(botToken, messageId) → (project, task, baseLocation)`, not by scanning every
project's `parked/`. On a matching reply it resumes by running `answer <task>
"<text>"` for that project (the shared install, ADR 0003) in that base location.
The old `attend` mode (a single task inline-polling its own answers) is retired:
inline polling violates the single-consumer rule, and gateway-mediation now does
its job for every project.

## Considered Options

- **Gateway owns bot tokens and routing centrally** — rejected: it duplicates
  secrets out of the project that owns them and makes the gateway config grow with
  every project. The user wanted the gateway simple and secrets un-duplicated.

## Consequences

Because only the `question` category is interactive, a project's questions must
resolve to a single destination the gateway can watch for replies; broadcast
categories (success/failure/progress/finding) may fan anywhere. A project whose
base location is moved or deleted leaves a stale registration the gateway must
tolerate.
