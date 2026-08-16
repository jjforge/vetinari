# Context

## The task you are implementing

{{TASK}}

You are working on branch `{{SOURCE_BRANCH}}`, cut from `{{TARGET_BRANCH}}` in the
**{{PROJECT}}** repository. Work on **this task only**. Do not merge to
`{{TARGET_BRANCH}}` — the orchestrator owns integration.

## You may have been here before

This branch persists across runs, so an earlier attempt may already have
committed work to it. Before planning anything, run
`git log --stat {{TARGET_BRANCH}}..HEAD` and read what is there — continue it
rather than starting over.

# Task

Read the repository's own agent guide first (`CLAUDE.md` or `AGENTS.md` at the
root); it overrides anything here that conflicts. Absent one, follow the
conventions the surrounding code already shows.

- **TDD**: write the failing test before the implementation.
- **Design intent outranks current behaviour.** If the task's acceptance
  criteria and the code disagree, do **not** narrow the criteria to fit — that
  is a question for a human (see Signals).
- **Never swallow a red test run.** Report the command, the failing test names
  and the counts in your final message and in the commit body.
- **Confirm a bug still reproduces** before fixing it. If it does not, stop and
  say so rather than changing working code.

Commit your work as you go — the orchestrator reads commits off this branch —
and run the repository's own formatter before each commit.

**You do not decide when the work is done — the orchestrator does.** When you
believe the implementation is complete and your own test run is green, emit the
COMPLETE signal. The orchestrator then runs the verification suite itself; if it
comes back red you will be resumed with the failure output. Do not weaken, skip,
or narrow tests to reach green.

## Signals

When you believe the work is complete and tests pass, emit exactly:
<promise>COMPLETE</promise>

If you need a decision only a human can make — an ambiguous requirement, a
missing spec, a choice between approaches with real tradeoffs — DO NOT GUESS.
Emit your question first, then the blocked signal:

<question>
  <summary>One line.</summary>
  <detail>What you tried, what is ambiguous, why it blocks you.</detail>
  <options>
    <option>Approach A — consequence</option>
    <option>Approach B — consequence</option>
  </options>
</question>
<promise>BLOCKED</promise>

Blocking is a correct outcome, not a failure. Guessing on an ambiguous
requirement is worse than asking. Your question reaches a human immediately and
your session is preserved: when they answer, you resume with full context.
