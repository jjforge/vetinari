---
name: ask-vetinari
description: Ask which vetinari command, move, or operator skill fits your situation. A router over running vetinari.
disable-model-invocation: true
---

# Ask Vetinari

You don't remember every command and skill, so ask.

Vetinari runs one agent per issue, in its own container on its own branch, and **the gate decides done, never the agent**. Everything below is a path through that: get issues ready, land them on a green base, and make the one move a park asks of you. Flags live in `vetinari --help`; the operator's model lives in `docs/user-guide.md`. This skill only tells you which one to reach for.

## Precondition: a project vetinari can run in

Once per project, in order:

1. **`vetinari init`** scaffolds the committed `vetinari/` (config + Dockerfile) and the ignored `.vetinari.local/`. An older `.sandcastle/` layout moves over with **`vetinari migrate`** instead.
2. Fill in `vetinari/config.mts` (image, gates, setup, `fetchTask`, the `blocked_by` / `listByLabel` resolvers) and the Dockerfile. Put the provider key in `.vetinari.local/.env`, the only file that crosses into the container.
3. **`vetinari build`** builds the image and runs **`baseline`**: every gate, no agent. Do not spend a token on an agent until it is green. Re-run `baseline` alone after a toolchain change.
4. **`vetinari tg-connect`** puts the project's Telegram bot and chat in `host.env`; **`vetinari tg-test`** proves the round-trip.

Once per machine: **`vetinari gateway install`** (questions reach your phone with no terminal open), `MAX_CONCURRENT_CONTAINERS`, and `scripts/install-skills.sh` from the vetinari checkout to link the operator skills named here.

## The main flow: issues → green base

The route most work travels.

1. **Shape the work.** Vetinari runs specified issues; it does not write them. A foggy idea goes through the engineering flow first (`/ask-matt`: `/grill-with-docs` → `/to-spec` → `/to-tickets`). Raw incoming reports go through `/triage`.
2. **Make each issue runnable unattended.** An issue is runnable when its body is the whole spec and it declares its file-set.
   - **`/check-brief`** reads a brief against the code before it gets `ready-for-agent`: names that don't exist, criteria that contradict each other or the out-of-scope list, criteria no test could check. A brief it flags parks later as a `question`; fixing it now is cheaper.
   - **`/triage-placement`** puts the issue under its epic and wires native `blocked_by` edges. A dependency the tracker doesn't know about is invisible to the planner: the second issue merges green against the old contract.
   - **`/fileset`** fills in missing `Touches:` / `Creates:` marker lines across the selection. Without them the planner can't keep a wave file-disjoint, so it halts on the issue.
3. **Prove one loop (optional).** **`vetinari run <id>`** runs the TDD loop for one issue and banks its commits on `agent/<id>`. It **merges nothing**: it proves the loop, it doesn't land work. To land a single issue, use `vetinari campaign <id>`.
4. **Inspect the plan.** **`vetinari campaign --dry-run <ids-or-labels>`** prints the waves and every issue it left out, and why. An issue dropped as under-specified sends you back to step 2.
5. **Launch.** `git checkout` the base, then **`vetinari campaign <ids-or-labels>`** (a label expands to its open issues, e.g. `ready-for-agent`). Each wave's greens merge onto the base, the merged base is gated, then the next wave starts. It merges locally and never pushes.
6. **Watch.** **`vetinari status`** is the live dashboard over every project on the machine; **`vetinari statusline install`** puts the campaign in the Claude Code status bar; Telegram brings questions and progress to your phone.
7. **Close out.** A merged issue is `pending-verify`, not closed. **`/verify-pending`** checks each one on the base and closes the resolved ones. Pushing the base is yours.

## When it stops: the park reason picks the move

A park keeps the branch, the session, and the question; nothing un-parks on its own. **`vetinari parked`** lists what's waiting. Before choosing a move, run **`/unpark`**: it reads the parked record, turn log, and branch, checks the agent's claim against the code, says whether the brief was at fault, and prints the exact command. It changes nothing.

| Reason | Your move |
| --- | --- |
| `question` | **`vetinari answer <id> "…"`** (or reply to the Telegram message). The campaign continues by itself. |
| `stalled` | Read the turn log; answer with guidance, or `prune` it and rewrite the brief. |
| `conflict` | Resolve the conflict on the base by hand, then **`vetinari redrive`**. |
| `red-base` | Fix forward on the base, or `prune` a suspect, then **`vetinari redrive`**. No culprit is guessed. |
| `crash` | **`vetinari redrive`**. |
| `failed` (a state, not a park) | Change something (the brief, the code, the gate), then **`vetinari redrive`**. |

**Answer continues on its own; every other move is followed by `redrive`.** Redrive never redoes merged work and lands green-but-unmerged work instead of re-running it, so it is safe to reach for whenever a campaign stopped.

When a gap turns up during unparking (something the brief asked for that the code can't provide yet), it becomes a new issue, not part of the answer.

## Changing a running campaign

Both take effect at the next wave boundary; the wave in flight finishes untouched.

- **`vetinari prune <id>`** removes the issue and everything blocked by it. Merged work stays merged; the branch is kept. From Telegram: reply `prune <id>`.
- **`vetinari graft <ids…>`** adds issues; each lands in the earliest unstarted wave after its blockers that shares none of its files. Run them through step 2 of the main flow first.

## Housekeeping

- **`vetinari tidy`** reconciles what a by-hand fix-forward or merge leaks: orphaned `changelog.d/` fragments, `agent/<id>` branches provably merged, parked records for merged issues. Dry-run by default; `--apply` acts. Reach for it after any manual resolution.
- **`vetinari clear`** archives the run log and resets the dashboard to idle. Automatic on a clean finish; use it to force idle after abandoning a run.
- **`vetinari changelog collect`** folds `changelog.d/` fragments into `CHANGELOG.md` by hand, the same fold a wave runs at merge.
- **`vetinari registry remove <name>`** stops the dashboard listing a project.
- **`/review-logs`** reads this project's `.vetinari.local/logs/` for where agents struggled — stops, red gates, hotspot files, churn, facts every agent rediscovers — and suggests changes to the project's code, tests, docs and briefs. It changes nothing until you pick which to file.

## The host gateway

The gateway is the one Telegram consumer for every project on the machine.

- **`vetinari gateway status`** / **`start`** / **`stop`** / **`restart`**. Restart after pulling new vetinari code; that is how merged changes go live. Re-run **`gateway install`** after a node upgrade.
- **`vetinari host log`** (`--tail` to follow) reads the host diagnostics no per-project feed shows: start here when a question never reached your phone.

## Rules that were paid for

- **One run per issue.** A review worktree you leave on `agent/<id>` blocks that issue's resume; remove it first.
- **Only `.env` reaches the container.** Bot tokens and anything the agent must not see go in `host.env`.
- **Waves need disjoint files and no hidden dependencies.** A shared file shows up as a conflict; an unrecorded dependency doesn't show up at all.
- **Vetinari makes a vague issue visible, never good.** It parks or the planner refuses it; the fix is upstream, at step 2.
