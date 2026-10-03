---
name: unpark
description: "Diagnose why a vetinari issue is parked and recommend the move that frees it. Use when a campaign or run is parked, an agent asked a question, or asked what is parked."
---

# Unpark a parked issue

A vetinari park stops one issue (or a whole wave) until a person makes a move. This skill does the investigation before that move: it reads what the run left behind, checks the agent's claim against the code, recommends one move with its reason, and prints the exact command. The person runs it. This skill is **read-only**: it never runs `vetinari answer`, `redrive`, `prune`, `graft` or anything else that changes campaign state, changes nothing on GitHub, and leaves the operator's checkout as it found it — read other branches with `git show <ref>:<path>` and `git grep <pattern> <ref>`, never by checking them out.

## Where the evidence lives

The **base** is the `baseBranch` in the project's `vetinari/config.mts`. Everything else is under the project's `.vetinari.local/`:

- `parked/<n>.json` — the parked record: `reason`, `detail`, `branch`, and `question` (the agent's `<question>` block, or a one-line stall message). Red-base and crash parks leave no record; `vetinari parked` names them from the event log.
- `logs/agent-<n>.log` — the turn log. Its last turn (from the last `--- Run started` line) ends with the agent's account of what it built, then any `<question>`, `<turn-summary>` and `<promise>`. Read it from the tail; tool-call lines are long, so cut them.
- `logs/orchestrator.jsonl` — the event log: `parked`, `campaign-parked`, `gate-result` (with `outFile`, the gate's output) and `base-gate` events. Older runs are in `logs/archive/orchestrator-*.jsonl`.
- `agent/<n>` — the issue's branch, in the project repo.

## Steps

1. **List.** Run `vetinari parked` (if it fails, read `parked/*.json` directly). With no issue given, report each parked issue with its reason and the agent's one-line summary, and stop. With an issue, read its record and go on. Done when you know the issue's reason and detail.

2. **Read.** Read the issue (`gh issue view <n> --json title,body,comments`), the last turn of its turn log, and `git log --oneline <base>..agent/<n>` with `git diff --stat <base>...agent/<n>`. Done when you can say what the agent built, what it committed, and where it stopped.

3. **Diagnose**, by reason:

   - **`question`** — The agent's claim is a hypothesis, not a fact. Check every factual claim in its `<detail>` against the code, schema and docs on the branch, and against the base where the brief promises nothing is lost: the column that "isn't in the format", the table that "doesn't record it", the file the brief "didn't list". Then read the brief against itself: does a criterion contradict the column spec, the out-of-scope list or another criterion? Say where the fault lies — the **brief** (it asked for something that doesn't exist or that it ruled out), the **agent** (the answer was in the brief or the code), or both. Then sort what the brief asked for and can't get:
     - a **slip** — a wrong word for something already covered (a column name that was never meant, a term for a thing the work already does). Accepting the work as built loses nothing the brief meant.
     - a **gap** — something real that the code can't yet provide, often one the brief also ruled out of scope. Accepting the work as built drops it — even when the old code never had it either — so it becomes a follow-up (step 4), and the option that splits it out is the one to recommend.

     Recommend one option, citing the evidence. Name a different answer when no option fits.
   - **`stalled`** — `no-commit`: check whether the branch has the work anyway (commits past the base, or uncommitted changes in its worktree). The turn log says whether the agent signalled `COMPLETE`. `budget` or `idle`: find in the turn log where it went round in circles or went quiet. Recommend guidance to answer with, or `prune` when the brief needs rewriting first.
   - **`conflict`** — Name the conflicting files and the commits on each side (`git log <base>...agent/<n> -- <file>`). Recommend how to resolve it on the base.
   - **`red-base`** — Read the failing gate's output (the last `gate-result` with a non-zero `exitCode`; its `outFile`) and the commits merged this wave. Name the suspects the failure points at. The machine guesses no culprit, so present evidence, not a verdict. Recommend fixing forward or pruning a suspect.
   - **`crash`** — Name the last thing the turn log shows before it stops.

   Done when the recommendation rests on evidence you checked yourself, not on the agent's account alone.

4. **Follow-up.** Every gap from step 3 is a new issue. Report whether one already exists (`gh issue list --state all --search`) or needs filing, with a one-line title. File nothing yourself.

5. **Report.** In this order:
   - the issue, reason and the agent's question or stall, in a line or two;
   - what you checked and found, each claim marked confirmed or refuted;
   - where the fault lies, and slip or gap;
   - the recommendation and its reason;
   - the follow-up, if any;
   - the command to run, exactly. A `question` or `stalled` park is freed by its answer alone: `vetinari answer <n> "<text>"` resumes the campaign, with no redrive after it. Write the answer for the resumed agent: name the option, state the decision and what to do next, so it can act without asking again. A `conflict`, `red-base` or `crash` park has nothing to answer: the move is the fix (or `vetinari prune <n>`), then `vetinari redrive`.
