# sandcastle-tdd — working agreement

This file is always-on context, so it is read as _current truth_. Keep it number-free (see the no-numbers rule) and keep it to rules, not state.

## How to work

These govern every change — yours interactively and every campaign agent's (the TDD prompt reads this file first and lets it override).

**1. Think before coding.** State your assumptions explicitly, and when an ambiguity actually changes the outcome, lay out the interpretations instead of silently picking one; point out a simpler alternative and push back when you see one. _Where you would "ask":_ interactively, ask. In a **headless campaign run** there is no one to ask, so the only "ask" is the `BLOCKED` signal (`prompts/tdd.md`) — used **only** for genuine ambiguity in the interface or intent, never as a routine gate; otherwise treat the acceptance criteria and the existing seams as the agreement and proceed.

**2. Simplicity first.** Write the minimum code the request needs — nothing speculative. No unrequested features, no abstraction for one-time code, no hypothetical flexibility, no handling for impossible scenarios. If 200 lines could reasonably be 50, make it 50. The test: _would a senior engineer call this overcomplicated?_

**3. Make surgical changes.** Touch only what the request requires, and clean up only the mess your own change makes — every changed line should trace back to the request. Leave neighbouring code, comments, and formatting as they are; _mention_ unrelated dead code rather than deleting it; remove an import or function only when your change made it obsolete. (Refactoring the code your slice **touches** is the TDD loop's refactor step and is fine — this bans the _drive-by_ kind on code you were not sent to touch.)

**4. Goal-driven execution.** Define the success criteria and drive to them: a failing test that pins the target ("fix the bug" → a test that reproduces it; "add validation" → invalid-input tests), then green — and pair each step of multi-step work with an explicit check. For campaign work this _is_ the `tdd` skill's loop; let it drive.

**5. Defined vocabulary wins over mockups.** A POC, prototype, mockup, or design handoff may use the wrong word for a thing we have already named — our defined vocabulary (the ADRs, the domain model) is the correct one, so translate the artifact's words into ours rather than adopting the artifact's. A word that conflicts with a defined term is not a naming decision, it is a translation; only a genuinely _net-new_ concept our vocabulary has no word for is a decision — and there you **ask** (rule 1's `BLOCKED` in a headless run). This keeps the UI, the logs, and the code speaking one language rather than drifting toward whatever the last handoff called things.

## Work tracking — GitHub issues are the single source of truth

**GitHub issues on `jjforge/sandcastle-tdd` are the single source of truth for all work** — bugs, features, follow-ups, deferred items. Every loose end gets an issue; there is **no backlog file** (no `NEXT-STEPS.md`, no `ROADMAP.md` — do not create one). "What's next" is the highest-priority open `ready-for-agent` issue whose blockers are all closed — read it from the tracker.

**File one the moment you find it — no permission needed.** An issue changes no code and ships nothing, so it is not an outward action that needs a confirm; a finding you carry to the end of a turn instead of filing is lost. Say what you saw and where, label it, and **file it separately** — do not fold the finding into the change you are making.

**No issue numbers in always-on / current-truth context** — this file, `CONTEXT.md`, `docs/adr/`, the memory store. A number there rots: the issue closes and the text still implies pending work. Describe the _behaviour_ ("a carve of a merged target still dropped its dependents") and let the tracker hold the number; query the live set when you need it (`gh issue list --label …`). **Cite numbers freely in dated records** — commits, `CHANGELOG.md`, issue comments, what you report to the user — those are pinned to a moment and stay accurate.

## Changelog — log every user-facing change as part of landing it

**Every change that adds or alters a command, flag, behaviour, config surface, or output gets a [`CHANGELOG.md`](CHANGELOG.md) `[Unreleased]` entry** (under `Added`/`Changed`/`Removed`/`Fixed`), citing the issue — in the same change that lands it, not a later pass. A purely internal refactor with no user-visible effect needs none. This is enforced on the implementing agent via `prompts/tdd.md` (the TDD prompt every campaign drives), not in `to-tickets`/`/implement` — those are external skills we do not own, so the rule lives where we control it: this file and the prompt.

## Handling issues & running campaigns

- **Filing, labeling, structuring, or closing an issue** → [`docs/issue-conventions.md`](docs/issue-conventions.md).
- **Running a campaign** → [`docs/campaigns.md`](docs/campaigns.md).
