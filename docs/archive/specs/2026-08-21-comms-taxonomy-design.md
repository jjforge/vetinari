# E4: Comms taxonomy + notify map

Epic: [#15](https://github.com/jjforge/vetinari/issues/15) · Source: [ADR 0002](../../adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) · Glossary: [CONTEXT.md](../../../CONTEXT.md)

## Problem Statement

Every notification the orchestrator sends today goes to one hard-wired Telegram
chat — the single global chat the process was configured with. I cannot say "send
me failures on my alerts bot but keep the noisy progress chatter on a different
one," and across several projects I cannot separate one project's traffic from
another's. Different kinds of message deserve different destinations — a parked
question I must answer is not the same as a routine "wave started" — but there is
no vocabulary for the kinds and no way to route them. On top of that, once the
gateway is the sole sender (E3), the broadcast messages (green, progress, findings)
need a path from the run to the gateway at all.

## Solution

Each project declares, in its committed `vetinari/` config, a set of named
**destinations** (a bot + chat, optionally a thread) and a **notify map** that
routes each **message category** to a destination — with a wildcard default and the
option to target a specific event under a category. A run no longer talks to
Telegram directly: it writes a category-tagged **outbound record** into its
`.vetinari.local/`, and the gateway drains that outbox and routes each record to
the destination the project's notify map resolves. The `question` category is the
only interactive one, so it must resolve to a single destination the gateway can
watch for the reply. The result: "all → ops bot, failures → alerts bot, wave-start
→ alerts bot" is just three lines of config, owned by the project.

## User Stories

1. As a maintainer, I want to define named destinations in my project config, so
   that I can name the bots/chats my project talks to.
2. As a maintainer, I want to map each message category to a destination, so that
   different kinds of message reach the right place.
3. As a maintainer, I want a wildcard default in the notify map, so that I can route
   everything to one destination and override only the exceptions.
4. As a maintainer, I want to route a specific event under a category (e.g.
   `progress:wave-start`, `progress:carve`) to its own destination, so that I can
   split out just the events I care about without listing every other one.
5. As a maintainer, I want parked questions to route to a destination I choose, so
   that the questions I must answer arrive where I am watching.
6. As a maintainer, I want the `question` category constrained to a single
   destination, so that there is one unambiguous place the gateway watches for my
   reply.
7. As a maintainer, I want a clear config error at load time if `question` resolves
   to more than one destination, so that I find the mistake before a run, not during.
8. As a maintainer, I want success messages (green, merged, campaign complete)
   routed by their category, so that good news can go to a low-noise channel.
9. As a maintainer, I want failure messages (halt, resume error) routed by their
   category, so that things that need my attention can go to an alerts channel.
10. As a maintainer, I want progress messages (queue/campaign/wave/batch lifecycle,
    including a carve) routed by their category, so that routine chatter can be kept
    separate or muted.
11. As a maintainer, I want finding messages (an incidental defect was filed) routed
    by their category, so that I can send them wherever I track quality.
12. As a maintainer, I want a run to write its outbound messages as records rather
    than sending them itself, so that the gateway remains the sole sender.
13. As a maintainer, I want the gateway to route each outbound record per my notify
    map, so that my routing choices are actually honored.
14. As a maintainer, I want the outbox to survive a gateway restart, so that a
    message emitted while the gateway was down is still sent when it comes back.
15. As a maintainer, I want a carve (dropping an issue and its dependents from a
    campaign) to emit a `progress:carve` message, so that I am told when it happens
    and can route it.
16. As a maintainer, I want a message whose category is not in my notify map to fall
    back to the wildcard default, so that nothing is silently dropped.
17. As a maintainer, I want to route two projects' traffic to two different bots, so
    that I can tell them apart or isolate them.
18. As a maintainer sharing one bot across projects, I want each project's notify map
    to still decide its own destinations, so that sharing a bot does not mean sharing
    routing.

## Implementation Decisions

- **Destinations + notify map in config.** A project's `vetinari/` config gains a
  `destinations` map (name → `{bot, chat, thread?}`, tokens read by reference from
  `.vetinari.local/`) and a `notify` map (category or `category:event` →
  destination name), with a `*` wildcard entry as the default.
- **Pure `resolveDestination(notifyMap, category, event?)`.** Returns the destination
  name for a message: an exact `category:event` entry wins over a bare `category`
  entry, which wins over `*`. This is the highest seam and the heart of the feature.
- **`question` single-destination, validated at load.** The config validation (E1)
  is extended so that if the notify map would route `question` (via its entry, or via
  the wildcard) to more than one destination, loading fails with a clear error. Only
  `question` carries this rule; broadcast categories may fan anywhere.
- **Outbox (chosen mechanism).** A run writes a category-tagged **outbound record**
  (`{category, event?, text}`) into its `.vetinari.local/` outbox instead of calling
  Telegram. The gateway drains the outbox across registered projects and routes each
  record via `resolveDestination` against that project's notify map. This unifies all
  outbound through the gateway (E3's sole-sender stance) and reuses the base-location
  scan the gateway already does — a parked question is simply the interactive kind of
  outbound record, and it additionally registers in the reply index.
- **Emit sites tagged.** Every place that sends a notification today is changed to
  write an outbound record with its category (and event where relevant) rather than
  sending inline. This includes emitting `progress:carve` from the carve path, which
  has no notification today.
- **Draining is idempotent.** A record is marked sent once routed, so a gateway
  restart neither drops nor duplicates a message.
- **Categories are the five, fixed.** `question`, `success`, `failure`, `progress`,
  `finding`. Adding new categories is not part of this work.

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs: given a
  notify map and a message's category/event, which destination name is resolved;
  given a config whose `question` fans out, that load fails. The resolver is pure — no
  Telegram, no gateway, no filesystem.
- **Modules tested.** (1) `resolveDestination` — exact event over category over
  wildcard, an unmapped category falling to the default, and the `question`
  single-destination validation (a fan-out config rejected). (2) The outbox
  drain-and-route step, with the actual send **injected**, asserting each record goes
  to the destination the map resolves and is marked sent once. (3) Config validation
  extended for the notify map.
- **Prior art.** `carve.test.ts` for the pure resolver and validation; `state.test.ts`
  / `archive.test.ts` for the outbox records against a `tmpdir()`. The send stays
  behind the injected boundary, as in E3.

## Out of Scope

- **The gateway daemon itself** — E3 (#14). E4 *extends* the gateway's outbound path
  from the single question-destination to full notify-map routing and the outbox; it
  does not build the gateway.
- **The multi-project dashboard** — E5 (#16).
- **Adding message categories** beyond the fixed five, or per-message dynamic routing
  logic beyond category/event → destination.
- **Reply routing** (inbound) — that is the gateway's reply index (E3); E4 is about
  outbound destinations.

## Further Notes

- The interactive/broadcast split is the load-bearing distinction: only `question`
  needs a reply, so only it carries the single-destination rule. Everything else is
  fire-and-forget and may fan freely.
- The outbox makes "questions" and "everything else" one mechanism: all outbound is a
  record the gateway drains; the question kind additionally feeds the reply index. This
  keeps the gateway the sole sender without a bespoke channel per message kind.
