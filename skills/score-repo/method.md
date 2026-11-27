# The scoring method

This is how a repo's rubric is scored. A repo's own `docs/review-rubric.md` may restate or amend these rules under its own version number; where it does, the repo's copy wins. Otherwise this file is the method.

## Why a pinned rubric

Ad-hoc letter grades drift between review sessions. The same code scores "A-" one round and "B+" the next, not because the repo changed but because each round audited different territory. A grade anchored to that round's findings measures what the reviewer happened to look at, not the repo.

A rubric fixes the axes. Score every category the same way each round, so the number moves only when the repo moves. When a review finds a new failure mode, add a criterion under the right category rather than letting it silently deflate an unrelated score.

## Criteria state principles, not bugs

Each criterion states a **general principle**. The finding that motivated it appears only as an *example*. A criterion that hardcodes the one bug ("no `reset --hard` in `merge.ts`") is a regression checklist: it stops discriminating the moment that bug is fixed. A principle ("destructive git only touches refs the tool created") keeps measuring health and catches the next instance of the class. An automated check must likewise detect the class, not one string.

Each criterion has a verification tag:

- **[auto]**: the repo's checker script verifies it mechanically, the same way every round.
- **[judged]**: needs a person (or agent) reading code, with the evidence cited.
- **[hw]**, or another environment tag: needs an environment the reviewer may lack. It is `unverified` until run there.

## The four states

- `pass`: full points; verified true.
- `partial`: half points. Use it ONLY when the criterion breaks into concrete pass/fail parts and some pass. Never use it as a hedge for "seems okay"; if you're tempted, split the criterion instead.
- `fail`: zero points; verified false.
- `unverified`: **excluded from the denominator.** Use it when the criterion could not be checked this round. Never score an unchecked criterion `pass` "because no known defect": absence of evidence is `unverified`, not `pass`.

## Scores

- Category score = `sum(earned) / sum(possible over pass + partial + fail)`.
- Overall = the category scores' weighted mean, using the category weights.
- **Provisional:** if the `unverified` criteria's weight exceeds **10% of the total weight**, the grade is `PROVISIONAL`. Report it as a range and say what's unverified.
- The instrument's noise floor is about ±0.03, since one criterion's interpretation can swing the total that far. **Report two decimals and the letter band; imply no finer resolution.** Within ±0.02 of a band edge, say "borderline X/Y".
- Never reverse-engineer criteria to hit a target letter.

### Letter bands (fixed)

| Score  | Letter |
|--------|--------|
| ≥ 0.97 | A+     |
| ≥ 0.93 | A      |
| ≥ 0.90 | A-     |
| ≥ 0.87 | B+     |
| ≥ 0.83 | B      |
| ≥ 0.80 | B-     |
| ≥ 0.70 | C      |
| < 0.70 | D / F  |

## Severity and gates

The weighted score measures breadth. Some findings are stop-ship however good the average is: a leaked secret isn't laundered by an elegant module tree. Every finding gets a severity:

- **Critical**: stop-ship regardless of the score. Each rubric names its own Critical classes; typical ones are a committed secret, data loss, or the primary workflow being unable to complete on a supported host.
- **Major**: a failing criterion, in a category weighted 15% or more, that breaks a real workflow but isn't stop-ship.
- **Minor / nit**: everything else.

The gates override the band:

| Condition | Effect |
|-----------|--------|
| Any open Critical | grade capped at **C** |
| An open Critical in the security category, or any data-loss Critical | capped at **D** until fixed |
| A grade above **A-** | also requires no failing criterion in the rubric's top-weighted category, and no open Major |

## The executable half and its ratchet

A rubric's `[auto]` criteria live in a checker script (conventionally `scripts/review.sh`). It prints `pass`/`fail` for each automated id, and `judged`/`unverified` for the rest, so the reviewer knows exactly what still needs a person. The script carries the same `RUBRIC_VER` as the rubric document, and the two change together.

**Ratchet.** The checker exits 0 when the set of failing automated criteria exactly matches a baseline file. It exits non-zero on:

- a **regression**: a new failure not in the baseline
- a **stale** baseline entry: a criterion in the baseline that now passes. Tighten the baseline.

So a gate can block backsliding without requiring the whole accepted backlog to be fixed first.

## Score history

Record each round in the rubric's `## Score history`, newest first:

- the date, the commit, the rubric version
- the overall score, its letter, and whether it is provisional
- each category's score
- every criterion that isn't a plain pass, with a one-line reason, marked auto or judged
- the gates that applied
- the issues filed this round

Scores under different rubric versions aren't directly comparable; say so when the version moved.

## Maintenance

When a change makes a criterion's verification text wrong (a module, flag, or file it names stops existing), update the criterion **in the same change**, bump the rubric version, and update the checker. A rubric describing a moving repo rots otherwise, and a rotted criterion silently mis-scores.
