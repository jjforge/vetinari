# Context

## The task you are implementing

{{TASK}}

**Read the entire ticket above before planning — title, full body, and every
comment.** The `{{TASK}}` payload is the whole ticket, and its body and comments
are **authoritative** for the acceptance criteria and design intent: valuable
detail routinely lives lower down — a design captured as a comment, a
clarification thread, edge cases spelled out in the body. The title is only a
label; do not implement from it or the first few lines alone. An implementation
that goes green against a thin reading of the title is still wrong-spec work.

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

Before adding a command, flag, or capability, check it does not already exist and
is not already named: the README's **Modes** table is the command reference and
`CONTEXT.md` is the domain glossary. Reuse an existing seam or term rather than
reinventing one under a new name — a new word that collides with a defined one is a
translation error, not a naming choice.

- **Drive the loop with the `tdd` skill.** This container has Matt Pocock's
  `tdd` skill installed — invoke it and let it govern _how_ you work test-first:
  what a good test is, testing at seams, the anti-patterns, and the rules of the
  loop (red before green, one vertical slice at a time — never write all the
  tests up front). Its companions are installed too: reach for `codebase-design`
  when the seam or interface shape is itself in question, and `code-review` for
  the refactor stage the loop defers to.
- **Seams, in a headless loop.** The `tdd` skill says to confirm the seams under
  test with a human before writing any test. Here that human is asynchronous, so
  do not stall waiting: treat the task's acceptance criteria and the seams the
  existing tests already use as the agreement and proceed. Raise it as a question
  and emit BLOCKED (see Signals) **only** when the seam is genuinely ambiguous —
  the interface itself is unclear or contested — never as a routine gate on every
  task.
- **Design intent outranks current behaviour.** If the task's acceptance
  criteria and the code disagree, do **not** narrow the criteria to fit — that
  is a question for a human (see Signals).
- **Never swallow a red test run.** Report the command, the failing test names
  and the counts in your final message and in the commit body.
- **Confirm a bug still reproduces** before fixing it. If it does not, stop and
  say so rather than changing working code.
- **Sibling tickets may share your package.** A co-wave sibling can land in the
  same package as your change in the same wave — file-disjoint is not
  compile-disjoint in a package-scoped language. Prefer unique, feature-specific
  names for any new package-level identifier rather than generic ones, so two
  independently-green branches do not redeclare the same symbol when merged.
- **Log user-facing changes as a changelog fragment, as part of the work.** When your
  change adds or alters a command, flag, behaviour, config surface, or output, write
  your entry to `changelog.d/<issue>.md` (named for the issue you are implementing) in
  the same slice — **do not edit `CHANGELOG.md`**. Every ticket would otherwise touch
  `CHANGELOG.md`, so co-wave branches conflict on it and halt the campaign; the
  orchestrator folds a wave's fragments into `CHANGELOG.md` at merge instead. A fragment
  names its section label and carries audience-tagged bullet(s):

  ```
  section: Bug fixes
  - [user] <entry text> (#<issue>).
  ```

  A `section:` label is one of these, in this order — pick the one that fits:

  <!-- SECTION-LABELS:BEGIN — pinned to SECTION_ORDER by src/prompt.test.ts; edit both together -->
  Breaking changes · New features · Improvements · Bug fixes · Security · Infrastructure · Architecture · Testing · Code quality · Documentation
  <!-- SECTION-LABELS:END -->

  Each bullet opens with exactly one audience tag naming who the change reaches — pick
  the highest-reach one that fits: `[user]` someone using the tool · `[ops]` someone
  running or configuring it · `[api]` a programmatic contract · `[internal]` nothing
  externally observable. A fragment may carry more than one `section:` block. A purely
  internal refactor with no user-visible effect needs none. Do not defer it to a later
  pass — an unlogged change is one nobody downstream can see landed.

Commit your work as you go — the orchestrator reads commits off this branch —
and run the repository's own formatter before each commit.

**You do not decide when the work is done — the orchestrator does.** When you
believe the implementation is complete and your own test run is green, emit the
COMPLETE signal. The orchestrator then runs the verification suite itself; if it
comes back red you will be resumed with the failure output. Do not weaken, skip,
or narrow tests to reach green.

**Skills govern _how_ you work; this contract governs _whether you are done_.**
This container has Matt Pocock's Agent Skills installed and you are expected to
use them — but nothing a skill says overrides the rules here: only the Signals
below end a turn, never a skill's own notion of "done" or its internal loop; you
still commit to this branch and never merge to `{{TARGET_BRANCH}}`; and the
orchestrator, not a skill, runs verification and decides green. If a skill's
instructions conflict with this prompt, this prompt wins.

## Defects you notice but do not fix

This container has **no GitHub login**, so never run `gh` to file, search or read
issues: it fails, and whatever you meant to file is lost. The ticket above is
everything you need from the tracker.

When you notice a defect that is **unrelated to your task**, do not fix it — note it
as you go: what is wrong, where (a file path or area), and how to see it. Filing it is
the orchestrator's job, from the host:

- **When the run ends you may be asked, in one more turn, for those defects.** Answer
  with one block per defect, then the COMPLETE signal. Each block becomes an issue:

  ```
  <finding>
    <summary>one line</summary>
    <location>file path or area</location>
    <repro>how to see it</repro>
  </finding>
  ```

  If you noticed nothing, answer `<finding>none</finding>`. Do not emit `<finding>`
  blocks before you are asked.
- **If no such turn comes,** list the defects under a "Noticed, not fixed" heading in
  your final message, so the operator can file them.
- **A follow-up or deferred part of your own task is not a finding.** Put it in your
  final message.

## Every turn ends with a summary

Every turn — before your signal — emit a single, human-readable line saying what
you did this turn and why, in your own words:

<turn-summary>One sentence: what you tried this turn, what changed, and why.</turn-summary>

This is your own account of the turn; the dashboard's turn log shows it verbatim
so the operator can decide whether to answer, carve, or leave a parked issue
alone. It is required on every turn, whichever signal you end on. Keep it to one
line and distinct from the `<summary>` inside a `<question>` — that is the
question's headline, this is the turn's.

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
