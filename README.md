# sandcastle-tdd

Parallel TDD agents on [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle),
with two properties the raw library leaves to you:

**The orchestrator owns the test gate.** An agent's "I'm done" is a claim, not
evidence — it can be emitted over a red suite. Here every completion signal is
followed by *your* test command, run on the host's terms inside the sandbox, and
only a zero exit returns green. A red gate resumes the same agent session with
the failure output rather than restarting it.

**A blocked agent parks instead of guessing.** Sandcastle has no ask-a-human
channel, so an agent that stops to think produces no output and dies on the idle
timeout with its work stranded. Here a `BLOCKED` signal (or a budget exhaustion,
or an idle timeout) writes the question and the session id to disk, tears the
container down, frees the slot, and messages you on Telegram. Reply and the
agent resumes with full context — in a new container, possibly days later, from
a completely fresh process.

## Install

```bash
npm install file:../sandcastle-tdd    # or a git URL
```

Needs Docker, Node 22+, and a `.sandcastle/.env` holding
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`.
An API key is the cleaner choice for automation: subscription OAuth tokens are
intended for first-party surfaces, and the API key also gives you per-run cost
tracking.

## Configure

Create `sandcastle-tdd.config.mts` (or `.sandcastle/config.mts`) in your project
root. Everything project-specific lives here; nothing else needs editing.

```ts
import { execFileSync } from "node:child_process";
import { defineConfig } from "sandcastle-tdd";

export default defineConfig({
  project: "myapp",
  image: "sandcastle-myapp",          // built from templates/Dockerfile + your toolchain
  baseBranch: "main",

  // What the ORCHESTRATOR runs to decide green. `when` scopes a gate to
  // branches that touched matching files — explicit and logged, never silent.
  gates: [
    { cmd: "npm test" },
    { cmd: "npm run test:e2e", when: /^(src\/routes|e2e)\// },
  ],

  setup: ["npm ci"],                   // once per sandbox, before the agent starts
  fetchTask: (id) => execFileSync("gh", ["issue", "view", id, "--json", "title,body,comments"], { encoding: "utf8" }),
});
```

Then build the image and prove it before spending anything on an agent:

```bash
npx sandcastle docker build-image --dockerfile .sandcastle/Dockerfile --image-name sandcastle-myapp
npx sandcastle-tdd baseline          # toolchain probe + every gate, no agent
```

`baseline` failing is the cheapest possible failure. `baseline` passing means a
red gate later is the agent's doing, not the image's.

## Run

```bash
npx sandcastle-tdd run 436                    # one task, loop until green or parked
npx sandcastle-tdd queue 436 611 623 640      # bounded pool, QUEUE_SLOTS (default 3)
npx sandcastle-tdd parked                     # what is waiting on you, and why
npx sandcastle-tdd answer 436 "use approach B, and note why in the commit"
```

Each task gets its own branch (`agent/<task>`), worktree, and container, so
parallel tasks cannot corrupt each other. Commits land on the branch; merging
stays yours.

## Answer questions from your phone

Set `WAVE_TELEGRAM_BOT_TOKEN` and `WAVE_TELEGRAM_CHAT_ID` **in the
orchestrator's environment** — never in `.sandcastle/.env`, which is injected
into agent containers and must not carry a bot credential.

```bash
npx sandcastle-tdd tg-test           # prove the round-trip first
npx sandcastle-tdd dispatch &        # the ONE poller, routes replies to tasks
npx sandcastle-tdd queue 436 611 623
```

Every park sends its question as a message; **reply to that message** and the
dispatcher resumes that specific task, spawning concurrent resumes as needed.
Telegram permits exactly one consumer of a bot's updates, so run at most one
poller (`dispatch`, `attend`, or `tg-test`) at a time — a second silently steals
the first's messages. `attend <task>` is the single-task variant when you are
not using a queue.

## Operating rules that are load-bearing

These were paid for in failed runs; they are not style preferences.

1. **Never two runs of the same task.** Git refuses one branch in two
   worktrees, and the second run fails fast. The same applies to *you*: a
   manual review worktree on `agent/<task>` blocks that task's resume, so
   remove it when done.
2. **Share caches, never build outputs.** Module/package caches are
   concurrency-safe and give the biggest single win (a cold gate of 2571s
   became 330s warm, measured). A shared build-output directory converts
   parallelism back into lock contention — the exact thing containers fix.
3. **Anything host-only goes in `hostEnv`, not `.env`.** `.env` reaches the
   container. `GIT_CONFIG_GLOBAL` is the classic trap: sandcastle needs it
   host-side for `safe.directory`, and inside a container it overrides the HOME
   that a project's own git tests depend on.
4. **Concurrency is bounded by your gates, not your patience.** A full test
   suite per turn is CPU-bound; 2–3 slots is a realistic ceiling on one
   workstation. Parallel agents also share your account's rate limits.
5. **Pick tasks with disjoint files and no dependencies between them.**
   Crossover surfaces as merge conflicts; a dependency does not surface at all
   — task B builds green against the pre-A contract and merges clean.

## What lands where

| Path | Contents |
| --- | --- |
| `.sandcastle/parked/<task>.json` | pending question, session id, branch, Telegram message id |
| `.sandcastle/logs/orchestrator.jsonl` | every event: sandbox, turn, gate, park, green |
| `.sandcastle/logs/gate-<ts>.log` | full stdout/stderr of each gate run |

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

## Known limits

- **Token accounting under-reports.** `IterationResult.usage` reflects the final
  message, not the session; for real cost, read the session JSONL.
- **Dispatcher resumes are outside the queue's slot accounting**, so heavy
  answering can briefly exceed `QUEUE_SLOTS` containers.
- **Session capture is required.** Non-resumable providers (`cursor`,
  `opencode`, `copilot`) cannot drive this loop; the run fails with a clear
  message rather than silently degrading.

See `examples/jjforge/` for a real config over a Go + Rust monorepo with
GitHub-issue tasks.
