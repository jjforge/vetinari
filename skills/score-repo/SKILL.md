---
name: score-repo
description: "Score this repo's health against its pinned principal-level review rubric (docs/review-rubric.md plus its scripts/review.sh checker), record the round in the rubric's score history, and file what it finds. Use when asked to score, grade, or review the codebase as a whole, for a principal review, or 'where are we' on repo health. Not for reviewing a diff."
---

# Score a repo against its rubric

A **rubric** pins the axes of a whole-repo review: weighted categories of criteria, each one checked the same way every round. The score then moves only when the repo moves, not when the reviewer looks somewhere new. This skill runs one **round**: the checker, then the judged criteria, then the gates. It records the result and files the findings.

The method (the four states, provisional grades, the letter bands, the severity gates, the ratchet, the score history) is [`method.md`](method.md). Read it before scoring. A repo's own rubric may amend it; the repo's copy wins.

## Steps

1. **Find the rubric.** Look for `docs/review-rubric.md` and its checker (`scripts/review.sh`) in the repo you are in. Read the whole rubric: the categories, the criteria, the Critical classes, and the newest Score-history entry. That entry is what this round is measured against. Done when you know the rubric version, every criterion id, and the last round's score.
   - **No rubric?** Offer to bootstrap one from [`rubric-template.md`](rubric-template.md). Weight the categories for what this repo's outages are made of. Write criteria as principles. Put every criterion a grep or a command can decide into a new checker. Don't score a round on a rubric written in the same session without saying so: a first round is a baseline, not a grade to compare.

2. **Run the checker.** Run `scripts/review.sh` (add a quick flag if the rubric offers one and the user wants speed; skipped criteria are then `unverified`). Keep its full output. A non-zero exit is the ratchet talking. Separate the two causes:
   - a **regression**: a new failure, which is a finding
   - a **stale** baseline: a fixed criterion, so tighten the baseline file in this round's change

   Done when every `[auto]` id has a verdict.

3. **Judge the rest.** Go through every `[judged]` criterion. Read the code the criterion names, and cite the evidence for the verdict (file:line, a command's output, an issue). Follow the method's rule on `partial`: use it only when the criterion has concrete parts that split. Mark an environment-tagged criterion `unverified` unless you actually ran it in that environment. Done when every criterion has one of the four states and a one-line reason.

   For a large rubric you may hand categories to subagents. Give each one the criterion text and the method, not your expected verdict, and check what comes back before you take it.

4. **Score.** Compute each category score, the weighted overall, and the unverified weight (over 10% makes the grade provisional). Then apply the gates: for each failing criterion, decide whether it is Critical, Major, or Minor against the rubric's Critical classes. Done when you have the number, the band, and any gate that overrides it.

5. **File and record.**
   - **File** each failing criterion that isn't already tracked, following the repo's issue conventions (a vetinari-managed repo: GitHub issues, labelled, one per finding). First search for an existing issue (`gh issue list --state all --search …`) and cite it if there is one.
   - **Record** the round at the top of the rubric's `## Score history`, in the method's format, with the issue numbers. Issue numbers belong in that history: it is a dated record.
   - **Fix the rubric** if this round found a criterion that rotted (it names something that no longer exists) or a failure mode no criterion covers. Change the rubric and the checker together, bump the version, and say so in the history entry.

   Done when every finding is tracked and the history entry is written.

6. **Report.** Lead with:
   - the score, the band, and the gate
   - the movement since the last round, and what moved it

   Then:
   - the failing criteria, most severe first, each with its issue
   - the unverified ones, and what it would take to verify them

   Commit only if the user asks.
