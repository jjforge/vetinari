# Vetinari from the operator's seat

This is the user model: what vetinari is for, how it should behave, and what you get out of it. Every other document — the README, the design doc, the glossary, the CLI help — is supposed to agree with this one. Where the implementation does not yet match it, [`design.md`](design.md) says so.

## The deal

You have a backlog of issues that are specified well enough for someone to just do them. You want them done, and you do not want to sit beside a coding agent while it works — and you especially do not want an agent that marks its own broken work "done".

Vetinari's deal is this: hand it the issues and walk away. It runs one agent per issue, in parallel, each sealed in its own container on its own branch. **It runs your tests and decides what "done" means — the agent never does.** Anything an agent cannot finish without you becomes a question on your phone. When you come back you find two things and nothing in between:

1. a base branch that is green and has the finished work merged onto it, and
2. a short list of things that need a human, each with one obvious next move.

Three properties carry the whole value. Everything else in the tool exists to serve them, and anything that does not is a candidate for removal.

- **The verdict is yours, not the agent's.** Green means your gate commands exited zero, run by the orchestrator inside the sandbox after the agent said it was done. A red gate sends the failure back to the same agent session to fix. No other signal counts.
- **Nothing is lost, and nothing is guessed.** An agent that hits a decision only you can make parks: its question comes to you, its branch and session are kept, and its container slot goes to the next issue. Work that merged stays merged. Every step is in a log that the tool — and you — can replay.
- **The base never advances onto unresolved work.** A campaign runs in waves, and the next wave starts only when every issue in the current one is merged and the merged base is green. Throughput never buys the right to build on a broken or unfinished base.

## The model in one screen

**Objects you deal with**

| Thing | What it is |
| --- | --- |
| **Project** | A repo you run vetinari in. It has a committed `vetinari/` (config, Dockerfile) and an ignored `.vetinari.local/` (this machine's secrets, logs, run state). |
| **Issue** | The unit of work, from your tracker. Runnable unattended only if the body says what to build and which files it touches. |
| **Agent** | One per issue, in a container, on branch `agent/<id>`. Commits as it goes. Ends each turn by saying COMPLETE or BLOCKED-with-a-question. |
| **Gate** | Your test commands. The orchestrator runs them after every COMPLETE. Red resumes the agent with the output; green means the issue is done. |
| - [ ] make it more clear that these are tests that are run at two levels by the agent while it is trying to complete and then again at the end of a wave. |
| **Campaign** | A set of issues, planned into waves and run wave by wave. The unit you launch, watch, and pick back up. |
| **Wave** | The issues that run at the same time: no dependency between them, no shared files. When a wave finishes, its greens are merged onto the base, the base is gated as a whole, and the next wave starts from there. |
| **Base** | The branch you had checked out when you launched. Merges land on it, locally. Pushing is yours. |

**Issue states — five words, one per situation**

| State | Meaning |
| --- | --- |
| `unstarted` | in the plan, no agent yet |
| `running` | an agent is on it (or waiting for a container slot), or it is green but not yet merged onto the base |
| `parked` | held on you; work preserved; the **reason** says what happened and what to do |
| `failed` | the agent could not make it green; terminal until you change something |
| `completed` | merged onto the base |

Waves, campaigns and the project card roll up from their issues in this order: failed > parked > running > completed. A campaign with one parked issue reads _parked_ until you resolve it. It cannot read _complete_ while anything is unresolved.

**Park reasons, and the move each one asks of you**

| Reason | What happened | Your move |
| --- | --- | --- |
| `question` | the agent asked you something | answer it |
| `stalled` | turn budget spent, or the agent went quiet, or it produced no change | read the turn log; answer with guidance, or prune |
| `conflict` | its green branch conflicts with the base at merge | resolve the conflict on the base, then redrive |
| `red-base` | every issue passed alone; the merged base fails together | fix forward on the base, then redrive |
| `crash` | the run died with no verdict | redrive |

**Your five moves.** These are the only things a human ever does to a campaign:

1. **Answer** a question. The answer is delivered to the parked issue; the campaign — live, or picked up by the answer — puts the issue back to work with it and continues on its own. You do not answer and then separately ask it to continue.
2. **Prune** an issue — and everything that depends on it — out of the plan. Against a running campaign it takes effect at the next wave boundary; the wave in flight finishes. Work already merged is never undone; a pruned issue's branch is kept.
3. **Graft** issues in. Each one lands in the **earliest unstarted wave** that comes after its blockers and whose members touch none of its files — only a `blocked_by` link or a shared file ever pushes it later. The wave in flight is never touched.

4. **Fix forward** by hand on the base (resolve a conflict, repair a red base).
5. **Redrive** the campaign: pick it up where it stopped. A redrive never redoes work that already merged, and it lands work that is green but not yet merged instead of re-running it. After a prune, a graft, a fix-forward, a crash, or a failure, redrive is how the campaign moves again.

## A campaign, start to finish

1. **Select.** `vetinari campaign 436 611 640` or `vetinari campaign ready-for-agent` — ids, or a label expanded to its open issues.
2. **Plan.** The issues are layered by their tracker dependencies, then each layer is split so no two issues in a wave touch the same file (by basename, from the `Touches:`/`Creates:` line on the issue). An issue that cites no files, or one whose only open blocker is outside the selection, is reported and left out — never scheduled silently. `--dry-run` prints the plan and stops.
3. **Run a wave.** Agents start as container slots allow. Each one loops: turn → gate → fix → gate, until green, parked, or failed. A park frees its slot immediately.
4. **Integrate the wave.** Greens merge onto the base one at a time; a merge conflict parks that one issue (`conflict`) and the rest keep merging. The merged base is gated as a whole; if it is red, the wave parks (`red-base`) with everything left merged and the base sitting red — never pushed, never built on.
5. **Resolve or stop.** A wave is done only when every issue in it is `completed`. One issue parking or failing never stops its siblings: the wave drains, every green still merges, and only then does the campaign park (an issue parked) or stop as failed (an issue failed). A merge conflict parks only the issue that conflicted; nothing merged is rolled back. Either way the state is on disk and the dashboard and Telegram both show it until you act.

6. **Next wave** starts from the advanced base. Repeat.
7. **Done.** The run is archived and the project card reads idle, showing the last run's outcome, its campaign name and when it finished; tap the card and that run is at the top of the project's archived list. Pushing the base is yours.

When something stops the campaign, you take one of the five moves. An answer continues it by itself; the other moves are followed by a redrive.

## Where you see things

- **Terminal**: the plan, per-wave progress, a one-line reason whenever it stops, and the exact command that resumes it — all as human-readable lines, never raw JSON. The event log is for the file (and `--json`), not the screen. The exit code says green, parked, or failed.
- **Telegram**: a parked question arrives as a message; **reply to it** to answer. Wave and campaign progress, failures, and filed findings arrive as fire-and-forget notices. Each project names its own bot and chat in its `host.env` (projects may share a bot or each have their own), and replies route back to the project that asked. `/status` answers with a summary; `prune <issue>` previews and, on `yes`, prunes (`prune <project> <issue>` when projects share a bot).
- **Dashboard**: one page over every project on the machine, live. A card per project with its wave and counts; open a project for its waves and issues; tap an issue for its turn log — one sentence per turn in the agent's own words — and the moves available for its state. Past runs are listed under the live one and open read-only.
- **Status line** (optional): the wave in flight, a count per state, and the reason words for any parked work, in the Claude Code status bar.

## Setup, once per project

1. `vetinari init` scaffolds `vetinari/` and `.vetinari.local/` and updates `.gitignore`.
2. Fill in `vetinari/config.mts`: the image, the gates, any setup commands, and how to fetch an issue and its blockers from your tracker. Fill in `vetinari/Dockerfile` with your toolchain.
3. `vetinari build` builds the image and runs `baseline`: the toolchain probe and every gate, with no agent. A red baseline is the cheapest failure you will ever buy; do not run an agent until it is green.
4. Pick the agent in `config.mts` and put its provider key in `.vetinari.local/.env` — the one file that crosses into the container. `claude`, `pi` and `codex` keep their session, so an answer resumes the same agent with everything it had. `copilot`, `cursor` and `opencode` cannot: an answer is posted to the issue as a comment (`postComment` must be configured) and a fresh agent starts from the issue. Put the Telegram bot token and chat in `.vetinari.local/host.env` — which never crosses.
5. `vetinari run <issue>` once, to see a single loop go green or park.
6. Then `vetinari campaign …`.

Once per machine: run the gateway as a service (`vetinari gateway install`) so questions reach you when no terminal is open, and set `MAX_CONCURRENT_CONTAINERS` to what the host can carry. Every project on the machine shares that ceiling.

## Writing an issue that can run unattended

- Label it `ready-for-agent` only when the body is the whole spec: what to build, how you will know it is done, the edge cases.
- Add one line listing the files it touches, and one for files it creates. If the issues are missing these, run `/fileset` before the campaign: it reads each issue against the tree, proposes the marker, and writes it back after you confirm.

  ```
  Touches: `a.ts`, `b/c.ts`
  Creates: `d.ts`
  ```

  This is what lets the planner keep a wave conflict-free.

- Record dependencies as the tracker's native blocked-by links, not prose.
- Anything the agent notices but does not fix is filed as a new issue, not folded in.

## How work leaves the container

The agent can reach only its branch. Everything else goes through the orchestrator on the host:

- **Code** is the branch, `agent/<id>`. Merging it onto the base is the orchestrator's job (step 4 above).
- **Changelog entries** are a fragment the agent commits on its branch, `changelog.d/<issue>.md`. When a wave merges, the orchestrator folds the wave's fragments into `CHANGELOG.md` in one commit. This is what keeps parallel issues from all editing the same file and conflicting on it.
- **Findings** — things the agent noticed but did not fix — are harvested from the session after it goes green and filed by the orchestrator through your tracker seam (`reportFinding`). The container never holds tracker credentials.

## Rules that were paid for

- **Never two runs of one issue.** One branch, one worktree. A review worktree you leave on `agent/<id>` blocks that issue's resume until you remove it.
- **Share package caches; never share build outputs.** Caches are safe to mount into every container and are the single biggest speed-up. A shared build directory turns parallelism back into lock contention.
- **Only `.env` reaches the container.** Anything the host needs but the agent must not see — a bot token, `GIT_CONFIG_GLOBAL` — lives in `host.env` or `hostEnv`.
- **Cap containers at the host level.** Gates are CPU-bound and agents share your account's rate limits. A lone project fills the ceiling; contending projects share it, with a floor of one. Mark a project's importance with `containerShare: high | medium | low` in its `config.mts` — that sets its share of the ceiling when projects contend (weights 7:2:1).
- **Waves need disjoint files and no hidden dependencies.** A shared file shows up as a conflict you can see; a dependency the tracker does not know about does not show up at all — the second issue merges green against the pre-change contract.

## What it is not

- Not a merge queue to your remote. It merges locally and never pushes.
- Not a reviewer. Green is the gate; review is yours.
- Not a tracker. It reads issues and, optionally, advances a label when one merges; closing is a human step after verification.
- Not a pair-programming session. The only interaction is a question and an answer.
- Not a scheduler that hides decisions from you. It never guesses a culprit for a red base, never drops an under-specified issue silently, and never un-parks anything on its own.

## What you get, and what it costs

You get throughput without babysitting, a base that is green by construction, and a stopping rule you can trust: if it says done, your tests said so; if it stopped, it tells you exactly why and what to do. You get it across every project on the machine from one phone and one dashboard.

It costs a container image per project, agent tokens per turn, a Telegram bot, and — the real price — issues written well enough that an agent can act on them without asking. Vetinari makes a vague issue _visible_ (it parks, or the planner refuses it); it cannot make it _good_.
