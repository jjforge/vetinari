# Repository Review Rubric

**Rubric version: 1.0**. Bump it on ANY change to a criterion, a weight, or a scoring rule, and record the version in each Score-history entry. The checker (`scripts/review.sh`) carries the same `RUBRIC_VER` and changes with it.

A pinned, reproducible rubric for principal-level reviews of this repo. The scoring method (states, provisional grades, letter bands, severity gates, the ratchet) is the `score-repo` skill's `method.md`; anything this file says about scoring amends it for this repo.

## Critical classes for this repo

<!-- What is stop-ship HERE, irrespective of the average. Examples: a committed secret; data loss;
     the primary workflow cannot complete on a supported host. -->

## Categories & weights

| # | Category | Weight |
|---|----------|--------|
| 1 | <where outages come from> | 25% |
| 2 | … | … |

<!-- One sentence on the thesis the weights encode: what matters most for THIS kind of repo, and why. -->

Verification tags: **[auto]** = `scripts/review.sh` checks it, detecting the class rather than one string; **[judged]** = needs reading, with the evidence cited; **[env]** = needs an environment the reviewer may lack, and is `unverified` until run there.

### 1. <Category> (25%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 1.1 | <a general principle, not one bug> | 3 | [auto] <the probe; the motivating bug only as an example> |

## Score history

<!-- Newest first. Each round: date, commit, rubric version, overall + letter (+ PROVISIONAL), category scores,
     each non-pass criterion with a one-line reason (auto/judged), the gates applied, the issues filed. -->
