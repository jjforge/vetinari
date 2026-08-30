# Architecture decisions

These ADRs are **frozen history**: each records *why* a decision was taken, in the
context it was taken. They are not the current spec. [`docs/design.md`](../design.md)
is the current implementation truth; where an ADR and the design disagree, the
**design wins**.

Every ADR here carries a one-line `Status:` under its title pointing at the design
section that now holds its decision:

- **`recorded in design.md §N`** — the design states the same decision; the ADR keeps
  the reasoning behind it.
- **`superseded by design.md §N`** — the design changed or consolidated the decision;
  read the design for the current rule, this ADR for how it got there. (The rule for
  what stops a wave, for one, was spread across several amending ADRs and is now stated
  once in the design.)

## When to add a new ADR

Add one **only for a genuinely new decision** — a choice the design does not already
make. Refining, renaming, or reversing something the design already states is a change
to the design, not a new ADR.

When you do add one, **change `docs/design.md` in the same commit**: the ADR captures
the why, the design captures the resulting current truth, and the two never drift.
Number the file with the next free `NNNN-` prefix and give it a `Status:` line the day
it lands (`recorded in design.md §N`).
