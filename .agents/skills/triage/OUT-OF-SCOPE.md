# Recording rejected requests as non-goals

In this repo, rejected feature requests are not a separate `.out-of-scope/` knowledge base — they are folded into **`docs/design.md` §14 (Non-goals)**, the one place that says what vetinari deliberately does not do (design §13.3). A non-goal serves two purposes:

1. **Institutional memory**: why a feature was rejected, so the reasoning isn't lost when the issue is closed
2. **Deduplication**: when a new issue comes in that matches a prior rejection, triage surfaces the existing non-goal instead of re-litigating it

## Where it lives

One list, `## 14. Non-goals` in `docs/design.md`. Each rejected concept is one bullet (or a short sub-list where the reasoning needs it), stated as a thing the system does not do. The design doc is current-truth, so a new non-goal is added in the **same commit** as the triage decision that made it (§13.3), never carried as a loose file.

## How to write a non-goal

State the boundary, not just the refusal — "why", in the system's own vocabulary. A good non-goal reads like the ones already there: a crisp statement of the thing not done, and, where it isn't obvious, the reason.

```markdown
- A quarantine verb. A conflict is resolved on the base by a human and picked up by a
  redrive; there is no "release" or "retry the merge" command.
```

Good reasons reference:

- Project scope or philosophy ("Green is the gate; review is a human's")
- Technical constraints ("Supporting this would require Y, which conflicts with Z")
- Strategic decisions ("The tracker is the source of truth; vetinari reads it")

The reason should be durable. Avoid referencing temporary circumstances ("we're too busy right now"); those aren't real rejections, they're deferrals — and §14 keeps a separate **Deferred — wanted, not now** list for those.

## When to check §14

During triage (Step 1: Gather context), read `docs/design.md` §14. When evaluating a new issue:

- Check whether the request matches an existing non-goal
- Matching is by concept, not keyword: "retry the merge" matches the quarantine-verb non-goal
- If there's a match, surface it to the maintainer: "This is already a non-goal in design §14 — we rejected this because [reason]. Do you still feel the same way?"

The maintainer may:

- **Confirm**: the new issue is closed `wontfix`, its number cited in the closing comment (not in §14 — the design doc stays number-free, per CLAUDE.md)
- **Reconsider**: the non-goal is removed or narrowed in `docs/design.md`, and the issue proceeds through normal triage
- **Disagree**: the requests are related but distinct, proceed with normal triage

## When to add a non-goal

Only when an **enhancement** (not a bug) is *rejected* as `wontfix`. This applies to enhancement PRs exactly as it does to issues: a rejected PR's boundary is recorded here so the same request doesn't return as fresh code.

Do **not** add one when something is closed as `wontfix` because it's **already implemented**. That's a built feature, not a rejected one; recording it would poison the dedup checks with false rejections. Instead, the closing comment points to where the feature already lives.

The flow:

1. Maintainer decides a feature request is out of scope
2. Check whether a matching non-goal already exists in §14
3. If yes: the concept is already recorded — just close, citing the issue in the comment
4. If no: add a non-goal bullet to `docs/design.md` §14 in the same commit
5. Post a comment on the issue explaining the decision and pointing at design §14
6. Close the issue with the `wontfix` label

## Reconsidering a non-goal

If the maintainer changes their mind about a previously rejected concept:

- Remove or narrow the bullet in `docs/design.md` §14 (in the commit that reopens the direction)
- The skill does not need to reopen old issues; they're historical records
- The new issue that triggered the reconsideration proceeds through normal triage
