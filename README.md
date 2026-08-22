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
from `claude setup-token` — your Claude Code subscription, which is what these
agents run on. The container runs the official `claude` CLI and reads that
token exactly as Claude Code GitHub Actions does; nothing here handles your
credential itself.

`ANTHROPIC_API_KEY` works as a drop-in alternative, and is worth switching to
when billing is the constraint rather than convenience: it gives per-run cost
attribution and spend limits in the Console, and it doesn't consume the
subscription rate windows that a parallel queue can exhaust. Neither choice
changes how the loop behaves.

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

## Skills in the agent container

The template image mirrors the [`mattpocock-skills` plugin](https://github.com/mattpocock/skills)
(v1.2.3) at **personal scope** (`/home/agent/.claude/skills/`). Sandcastle runs
the plain `claude --print` CLI (not `--bare`, not the SDK) with `HOME=/home/agent`,
so the CLI auto-discovers `~/.claude/skills/<name>/SKILL.md` with no flag,
setting, or per-run cost — every task's agent gets them. Personal scope keeps
them out of your repo and off every agent branch.

The image has no plugin machinery, so rather than "install a plugin" it clones
at the plugin's pinned commit (`SKILLS_REF`) and copies exactly the skills that
version's `.claude-plugin/plugin.json` declares — the same curated set the
plugin exposes on the host, flattened one level (discovery is not recursive into
the repo's `engineering/`, `productivity/` … category dirs).

Two things to know:

- **Your loop still owns "done".** `prompts/tdd.md` tells the agent that the
  signal contract and the orchestrator's gate outrank any skill — a skill's own
  TDD loop or completion notion never ends a turn or decides green. Keep that
  clause if you edit the prompt.
- **Updating is a rebuild.** Bump `SKILLS_REF` in `templates/Dockerfile` to the
  plugin's new commit (match it to your host install), rebuild, and re-run
  `baseline`. Don't want them? Delete that `RUN` block.

## Run

```bash
npx sandcastle-tdd run 436                    # one task: loop until green or parked
npx sandcastle-tdd queue 436 611 623 640      # bounded pool, QUEUE_SLOTS (default 3)
npx sandcastle-tdd parked                     # what's waiting on you, and why
npx sandcastle-tdd status                     # local campaign/wave dashboard at http://127.0.0.1:8765
npx sandcastle-tdd answer 436 "use approach B, and say why in the commit"
```

Commits land on `agent/<task>`. Merging stays yours — or hand the whole
merge→test→next-queue chain to `campaign`:

```bash
git checkout main                                     # the merges land on the checked-out base
npx sandcastle-tdd campaign "436 611 623" "640 655"   # each quoted arg is one batch
```

`campaign` drains a batch, merges **only its green** branches into the base with
`--no-ff`, runs the full gate on the *merged* base — the each-green-but-together-red
case a per-task gate can't catch — then deletes those branches, prunes their
worktrees, and starts the next batch on the now-advanced base. A merge conflict
or a red merged base **halts the campaign**, rolls the base back to where that
batch began, and leaves every branch intact — you get a Telegram message and no
later batch runs on a broken base. When a batch finishes, any parked records
for non-green tasks in that completed wave are cleared from `.sandcastle/parked/`
so stale questions do not bleed into the next wave's dashboard. Pushing stays
yours.

On clean completion, a `campaign` or `queue` **archives the run** so a finished
run stops lingering in the dashboard and status line: the orchestrator log is
moved aside to `.sandcastle/logs/archive/orchestrator-<ts>.jsonl` (kept, never
deleted) and replaced with an empty one, so the status reads idle. It only fires
on a clean finish with nothing still parked — a halt or an open question leaves
the state in place to inspect. Run `sandcastle-tdd clear` to force the same reset
yourself.

**Carve one issue out of a campaign.** When an issue turns out not to be ready,
`carve` drops it *and everything that can't proceed without it* — the transitive
closure of its dependents — then runs the rest:

```bash
npx sandcastle-tdd carve 640 "611 640" "623 701"   # 701 is blocked by 640
# carve #640 → removed #640, #701 (dependents: #701)
# remaining campaign: "611" "623"   ← runs this
```

Dependents come from your tracker via the config's `blockedBy` resolver;
`githubBlockedBy("owner/repo")` ships as a ready implementation over GitHub's
native "blocked by" links. Removal is transitive across every branch and
diamond (an issue falls if *any* of its blockers falls), and is computed over
the campaign's own issues — a blocker outside the named campaign is out of
scope. It runs the reduced campaign immediately; `--dry-run` only prints the
plan. Because carve only *drops* issues, each remaining wave stays as
conflict-free as you built it.

### In your Claude Code status bar

`statusline` prints two lines for the Claude Code status bar: line 1 mirrors
Claude Code's own default (model, directory, git branch, context-used %) with the
model name trimmed of its `(1M context)` suffix; line 2 is the sandcastle run —
the wave in flight and a count per status (the 🏰 marks it; no project name,
since line 1 already shows the directory) — so a running campaign is visible
without leaving the editor:

```
Opus 4.8 · jjforge · develop · 24%
🏰 wave 2/3 · ✅2 🔄1 ⏸1 ⚪1
```

Wire it into the project's `.claude/settings.json` with the same command you
already run sandcastle through, so the `sandcastle-tdd` import and the config
both resolve:

```json
{
  "statusLine": { "type": "command", "command": ".sandcastle/run statusline", "refreshInterval": 5 }
}
```

(Use whatever invokes the CLI in your project — an installed dep is
`npx sandcastle-tdd statusline`.) `refreshInterval` matters: Claude Code
refreshes the status line on its own events, but nothing tells it when the
orchestrator's log changes — polling every few seconds keeps the line live
during a run. It reads Claude Code's JSON on stdin, resolves the config from the
workspace directory, and derives line 2 from the log alone (no network), so it
stays fast. Line 1's fields come from Claude Code's own stdin JSON
(`model.display_name`, `workspace.current_dir`, `context_window.used_percentage`)
plus a `git` call for the branch. Outside a sandcastle project line 2 is simply
omitted, leaving line 1 — a non-zero exit would blank the bar, so it never
errors out.

### Capture what the agent notices in passing

An agent fixing one task often spots a *different* defect it won't fix — and that
knowledge dies with the container. Set a `reportFinding` handler and a green run
ends with a **harvest turn**: on its own live session, the agent is asked for any
unrelated defect it saw (summary, location, repro), and each is filed somewhere
durable instead of evaporating.

```ts
import { githubFindingReporter } from "sandcastle-tdd";

export default defineConfig({
  // …
  reportFinding: githubFindingReporter("owner/repo", { labels: ["P2", "bug", "needs-triage"] }),
});
```

`githubFindingReporter` files each finding as a GitHub issue, labelled and
cross-referenced to the task it was found on; write your own handler to send
findings anywhere. The harvest is one extra turn and runs **only on green** (a
task that never goes green is retried or abandoned, so nothing is filed for it),
and a failed filing is logged per finding without ever turning a real green into
an error. Absent `reportFinding`, no harvest turn runs.

## Answer from your phone

Set `SANDCASTLE_TELEGRAM_BOT_TOKEN` and `SANDCASTLE_TELEGRAM_CHAT_ID` in the
**orchestrator's** environment — never in `.sandcastle/.env`, which is injected
into agent containers and must not carry a bot credential.

```bash
npx sandcastle-tdd tg-test           # prove the round-trip first
npx sandcastle-tdd dispatch &        # the ONE poller (quick try; prefer the service below)
npx sandcastle-tdd queue 436 611 623
```

Every park sends its question as a message; **reply to that message** and the
dispatcher resumes that specific task, running concurrent resumes as needed.
Run at most one poller (`dispatch`, `attend`, or `tg-test`): Telegram permits a
single consumer of a bot's updates, so a second silently steals the first's
replies. `attend <task>` is the single-task variant when you aren't queuing.

While `dispatch` is up, send **`/status`** (bare, or `/status@yourbot` in a
group) to get a live summary back in the chat — each wave, its issue chips with
status, and any parked issues waiting on you. It is read-only and shares the web
dashboard's model, so it never disturbs a run; questions are still answered by
replying to their message.

### Run the poller as a service (survives reboot)

A backgrounded `dispatch &` dies with its shell, so a park raised after you close
the terminal goes unanswered. Run it as a **systemd user service** instead — one
always-on poller, restarted on crash, brought back at boot. The unit is tracked
in this repo at [`systemd/sandcastle-dispatch.service`](systemd/sandcastle-dispatch.service);
install it, editing `WorkingDirectory` to your project checkout:

```bash
install -Dm644 systemd/sandcastle-dispatch.service \
  ~/.config/systemd/user/sandcastle-dispatch.service
$EDITOR ~/.config/systemd/user/sandcastle-dispatch.service   # set WorkingDirectory

systemctl --user daemon-reload
systemctl --user enable --now sandcastle-dispatch   # start now + at every login
loginctl enable-linger "$USER"                       # ...and at boot, without a login session
```

The unit sources the host-only `orchestrator.env` before `exec`ing the poller —
`dispatch` sends too (the "dispatcher up" message), so it needs the bot creds in
its own env; never point it at `.sandcastle/.env`, which is injected into agent
containers.

`enable --now` alone brings the poller back only when you log in; **`enable-linger`
is what makes it survive a headless reboot** — it tells systemd to start your user
manager at boot. Operate it with `systemctl --user status|restart sandcastle-dispatch`
(restart after editing `orchestrator.env`); poll detail is in the project's
`.sandcastle/logs/orchestrator.jsonl`, not journald. The `run` wrapper resolves the
package's own `tsx`, so the unit needs no global install. **This replaces the inline
`dispatch &`** — do not run both, or the two pollers fight over the bot's updates.

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
| `campaign <batch…>` | drain each batch, merge its greens, gate the merged base, then start the next |
| `carve <issue> <batch…>` | drop the issue + its transitive dependents, then run the rest as a campaign (`--dry-run` to just print) |
| `migrate [--dry-run]` | move an existing project onto the `sandcastle/` + `.sandcastle.local/` layout: config → `sandcastle/`, old `.sandcastle/` state → `.sandcastle.local/`, `.gitignore` updated (`--dry-run` to just print the plan) |
| `answer <task> <text>` | resume a parked task with your answer |
| `attend <task>` | one task, self-answering via Telegram |
| `dispatch` | the single poller; routes replies to parked tasks, and answers `/status` with a live summary |
| `parked` | list what is waiting and why |
| `clear` | archive the run log + clear parked, resetting the dashboard/status line to idle (automatic on clean campaign/queue completion) |
| `status [--port <port>]` | local web page showing campaign waves, issue status chips, and parked-response cards |
| `statusline` | one compact line for the Claude Code status bar; reads Claude Code's JSON on stdin |
| `tg-test` | prove the Telegram round-trip |

## What lands where

| Path | Contents |
| --- | --- |
| `.sandcastle/parked/<task>.json` | pending question, session id, branch, Telegram message id |
| `.sandcastle/logs/orchestrator.jsonl` | every event: sandbox, turn, gate, park, green |
| `.sandcastle/logs/gate-<ts>.log` | full stdout/stderr of each gate run |
| `.sandcastle/logs/archive/orchestrator-<ts>.jsonl` | a finished run's log, moved aside on completion or `clear` |

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
