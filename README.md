# sandcastle-tdd

Run your backlog as parallel coding agents that **cannot mark their own work
done** and **ask you instead of guessing**. Each task gets a container, a
branch, and a TDD loop the orchestrator drives; you get a Telegram message when
one needs a decision, and commits on a branch when one succeeds.

**Green means your test command passed.** After every "I'm done" signal, the
orchestrator runs the gates from your config inside the sandbox and reads the
exit code; only zero returns green. A red gate resumes that same agent session
with the failure output attached, so the agent keeps its context and fixes the
actual failure instead of restarting. An agent's own claim of completion never
decides anything — which matters because agents do emit it over red suites.

**A blocked agent parks: question to you, slot back to the pool.** On a
`BLOCKED` signal, an exhausted turn budget, or an idle stall, the question and
the session id are written to disk, the container is torn down, and you get a
Telegram message. Reply to it and that agent resumes with full context — new
container, fresh process, days later if you like. Parking is terminal for the
slot, never a held container, so one stuck task cannot starve the other nine.

**Parallelism is the default, not a mode.** One branch, worktree, and container
per task means concurrent tasks cannot corrupt each other's state; a bounded
pool keeps N slots full and a park frees its slot immediately.

## Quickstart

```bash
npm install github:jjforge/sandcastle-tdd
```

Needs Docker, Node 22+, and `.sandcastle/.env` holding `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`) or `ANTHROPIC_API_KEY`. Prefer the API key for
automation: subscription OAuth tokens are meant for first-party surfaces, and
the key also gives you per-run cost tracking.

Put everything project-specific in `sandcastle-tdd.config.mts` (or
`.sandcastle/config.mts`) at your project root — nothing else needs editing:

```ts
import { execFileSync } from "node:child_process";
import { defineConfig } from "sandcastle-tdd";

export default defineConfig({
  project: "myapp",
  image: "sandcastle-myapp",          // templates/Dockerfile + your toolchain
  baseBranch: "main",

  // What decides green. `when` scopes a gate to branches that touched matching
  // files — explicit and logged, never a silent skip.
  gates: [
    { cmd: "npm test" },
    { cmd: "npm run test:e2e", when: /^(src\/routes|e2e)\// },
  ],

  setup: ["npm ci"],                   // once per sandbox, before the agent starts
  fetchTask: (id) => execFileSync("gh", ["issue", "view", id, "--json", "title,body,comments"], { encoding: "utf8" }),
});
```

Build the image, then prove it before spending anything on an agent:

```bash
npx sandcastle docker build-image --dockerfile .sandcastle/Dockerfile --image-name sandcastle-myapp
npx sandcastle-tdd baseline          # toolchain probe + every gate, no agent
```

A failing `baseline` is the cheapest failure available. A passing one means any
red gate later is the agent's doing, not the image's.

## Run

```bash
npx sandcastle-tdd run 436                    # one task: loop until green or parked
npx sandcastle-tdd queue 436 611 623 640      # bounded pool, QUEUE_SLOTS (default 3)
npx sandcastle-tdd parked                     # what's waiting on you, and why
npx sandcastle-tdd answer 436 "use approach B, and say why in the commit"
```

Commits land on `agent/<task>`. Merging stays yours.

## Answer from your phone

Set `WAVE_TELEGRAM_BOT_TOKEN` and `WAVE_TELEGRAM_CHAT_ID` in the
**orchestrator's** environment — never in `.sandcastle/.env`, which is injected
into agent containers and must not carry a bot credential.

```bash
npx sandcastle-tdd tg-test           # prove the round-trip first
npx sandcastle-tdd dispatch &        # the ONE poller; routes replies to tasks
npx sandcastle-tdd queue 436 611 623
```

Every park sends its question as a message; **reply to that message** and the
dispatcher resumes that specific task, running concurrent resumes as needed.
Run at most one poller (`dispatch`, `attend`, or `tg-test`): Telegram permits a
single consumer of a bot's updates, so a second silently steals the first's
replies. `attend <task>` is the single-task variant when you aren't queuing.

## Operating rules that are load-bearing

Each of these was paid for in a failed run. They are not style preferences.

1. **Never two runs of one task.** Git refuses one branch in two worktrees and
   the second run fails fast. This binds you too: a manual review worktree on
   `agent/<task>` blocks that task's resume until you remove it.
2. **Share package caches; never share build outputs.** Module caches are
   concurrency-safe and are the single biggest win — a cold gate of 2571s
   became 330s warm, measured. A shared build-output directory converts your
   parallelism back into lock contention, the exact thing containers fix.
3. **Host-only environment goes in `hostEnv`, not `.env`.** `.env` reaches the
   container. `GIT_CONFIG_GLOBAL` is the classic trap: sandcastle needs it
   host-side for `safe.directory`, and inside a container it overrides the HOME
   a project's own git tests depend on.
4. **Your gates set the concurrency ceiling.** A full suite per turn is
   CPU-bound; 2–3 slots is realistic on one workstation, and parallel agents
   also share your account's rate limits.
5. **Batch tasks with disjoint files and no dependencies.** Crossover surfaces
   as merge conflicts you can see; a dependency doesn't surface at all — task B
   builds green against the pre-A contract and merges clean.

## Update this package

**Installed from git** (`github:jjforge/sandcastle-tdd`) — npm copies the repo
at a commit, so updates are explicit:

```bash
npm update sandcastle-tdd                          # move to the tip of main
npm install github:jjforge/sandcastle-tdd#<sha>    # or pin to a commit
```

Then re-run `npx sandcastle-tdd baseline` in that project. Its image, gates, and
config are what an update has to keep working, and `baseline` exercises all
three without agent cost.

**Installed from a local path** (`file:../sandcastle-tdd`) — npm creates a
**symlink**, so the consuming project always runs your working tree and a `git
pull` in the package directory takes effect immediately with no reinstall.
Convenient while developing the orchestrator, and worth knowing when debugging:
a consuming project has no pinned version to blame, because it has no pin.

Config changes are the other update path. `defineConfig` is typed, so `npx tsc
--noEmit` in the consuming project catches a renamed or dropped field.

## Update `@ai-hero/sandcastle`

Bumps never happen silently: the dependency is pinned `^0.12.0`, and on a 0.x
version npm's caret allows patches only. That's deliberate — upstream is pre-1.0
and ships behavioural changes in minors.

```bash
npm install @ai-hero/sandcastle@latest   # here, and in each consuming project
npm run check-contract                   # ~1s, no Docker: is the surface intact?
npx sandcastle-tdd baseline              # container + gate path still work
npx sandcastle-tdd run <small task>      # agent + session + resume still work
```

Climb all four rungs, because each sees what the one below cannot.
`check-contract` catches a renamed export or dropped option in about a second;
`tsc` alone will **not**, since the library's result objects carry optional
members this orchestrator probes at runtime. `baseline` proves the container
path. Only a real `run` exercises the agent, the gate→resume cycle, and session
capture.

Four behaviours no static check can see — `check-contract` prints them, and
they're worth reading against the upstream changelog on any minor bump:

1. **A sandbox command returns a non-zero exit code rather than throwing.** If
   that inverts, every red gate reads as a pass — the one change that would
   silently destroy this tool's whole guarantee.
2. **`resumeSession` stays incompatible with `maxIterations > 1`.**
3. **An idle agent throws** a catchable timeout; a returned result instead would
   strand blocked work.
4. **Session capture writes host-side JSONL, and re-creating a sandbox on an
   existing branch reuses that worktree** — together, what make park→answer
   survive a fresh process.

Consuming projects pin the library themselves (it's a peer in practice), so bump
it there too and re-run that project's `baseline`.

## Modes

| Mode | What it does |
| --- | --- |
| `baseline` | toolchain probe + all gates, no agent |
| `run <task>` | the TDD loop; exit 0 green, 2 parked |
| `queue <task…>` | bounded pool; a park frees its slot |
| `answer <task> <text>` | resume a parked task with your answer |
| `attend <task>` | one task, self-answering via Telegram |
| `dispatch` | the single poller; routes replies to parked tasks |
| `parked` | list what is waiting and why |
| `tg-test` | prove the Telegram round-trip |

## What lands where

| Path | Contents |
| --- | --- |
| `.sandcastle/parked/<task>.json` | pending question, session id, branch, Telegram message id |
| `.sandcastle/logs/orchestrator.jsonl` | every event: sandbox, turn, gate, park, green |
| `.sandcastle/logs/gate-<ts>.log` | full stdout/stderr of each gate run |

## Known limits

- **Token accounting under-reports.** `IterationResult.usage` reflects the final
  message, not the session; read the session JSONL for real cost.
- **Dispatcher resumes sit outside the queue's slot accounting**, so heavy
  answering can briefly exceed `QUEUE_SLOTS` containers.
- **Session capture is required.** Non-resumable providers (`cursor`,
  `opencode`, `copilot`) can't drive this loop; the run fails with a clear
  message rather than degrading silently.

Built on [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle).
`examples/jjforge/` is a real config over a Go + Rust monorepo with GitHub-issue
tasks.
