# Held work is one `parked` state at every level; the reason is metadata, not a status

Status: superseded by design.md §2.3. Amends [ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md) and builds on [ADR 0017](0017-a-wave-gates-the-next-on-a-healthy-base-and-zero-parks.md).

## Context

Campaign state is shown at four levels — issue, wave, campaign, and the repo card — but only the issue level has a **stored** status; wave, campaign, and card states are all derived at render time, ad hoc, with no shared vocabulary. Over time the "something needs a human" situation sprouted a separate word at each level and for each cause: an issue `parked` (a question), an issue `quarantined` (a merge conflict), a wave `wave-parked` (a red combined base), and an archived `interrupted` (a run that stopped with no verdict).

[ADR 0013](0013-wave-integration-is-non-atomic-quarantine-and-wave-park.md) deliberately kept those words distinct — "one word for three situations bred the original confusion." But to an operator they all mean the same thing: *the campaign is paused, work is preserved, a human acts, then it resumes.* The dashboard already paints that whole family one amber and reserves red for `failure` alone — so the words disagree with the colour that ships. Meanwhile the true terminal-failure path (`campaign-halt`) has become dead code: every stuck path now resolves to a resumable park.

## Decision

There is **one held state, `parked`**, at every level — issue, wave, campaign, and card. It means: *held on a human, work preserved, resumable.* What differs between a question, a conflict, a red base, and a crash is the **reason**, which is **metadata** that selects the recovery affordance — never a distinct top-level status word.

- **The park reasons** are `question`, `conflict` (was `quarantined`), `red-base` (the combined-gate wave-park), and `crash` (was the archived `interrupted`). The integration mechanics ADR 0013 defined are unchanged; only their **surface word** collapses to `parked` plus a reason. Each reason selects its own recovery: answer a question, resolve the conflict, fix the base forward, or just resume — and prune is available on any held or failed issue.
- **`failure` is the single red terminal** — an issue the agent could not make green — and it **outranks `parked`** on roll-up: a level with any failed issue reads `failed`, otherwise a held level reads `parked`. Both need a human; the colour (red vs amber) signals *broken* versus *waiting*.
- **State is one event-driven machine, tested by replaying events.** The issue lifecycle is a single state machine fed by the event log — `unstarted → running → {parked(reason) | completed | failure}` — and the wave, campaign, and card states are **pure aggregations** (folds) of the level below, not independent derivations. `completed` and "no campaign" fold to a card `idle` (never a parked or failed campaign hidden). Two **orthogonal axes** stay separate: an issue's **lifecycle** (the machine) and its **membership** (`member | grafted | pruned`), so neither needs a precedence ladder over the other. The render-time casing that let the four levels disagree is deleted in favour of the machine's snapshot.
- **Events.** The dead `campaign-halt` path is retired. A quarantine that pauses the campaign now emits an explicit `wave-parked` rather than stopping silently, so a pause is never indistinguishable from a crash. A crash is recognised by process liveness plus a missing terminal event, and reconciles to `parked` (reason `crash`) rather than a terminal `interrupted`.

This **amends ADR 0013**: the distinction between a question, a conflict, and a red base is preserved — but it lives in the **reason and the recovery affordance**, not in three separate status words. The glossary keeps the *concepts* distinct while the *surface label* is one.

## Consequences

- The operator learns one word, `parked`, and reads the specific situation from the detail and the offered controls, instead of memorising `quarantined` versus `wave-parked` versus `interrupted`.
- The amber "needs-a-human, resumable" family and the lone red `failure` now match the colour that already ships — the word follows the colour.
- `interrupted` disappears as a status; a stopped-without-verdict run is either a resumable `parked` (reason `crash`) or, if an issue truly failed, `failed`.
- Because the four levels fold from one machine, they cannot disagree — a wave reading `running` under a red issue, or a card reading `idle` under an unfinished campaign, were symptoms of scattered derivation, not real states. The whole model is tested by replaying an event sequence and asserting the resulting states, rather than by exercising render-time precedence.
- `failed` outranking `parked` on roll-up is a deliberate reversal of the earlier precedence: a broken issue is a louder signal than a pending question.
