# vetinari

> **vetinari** /ˌvɛtɪˈnɑːri/ *n.*: a parallel TDD agent orchestrator in which the
> agents do all the work but never get a vote on whether it is *done*. That vote
> belongs to the test gate.
>
> *"Ankh-Morpork had dallied with many forms of government and had ended up with
> that form of democracy known as One Man, One Vote. The Patrician was the Man; he
> had the Vote."*
> Terry Pratchett, *Mort*

---

You don't want to babysit a coding agent, and you *really* don't want it quietly
marking its own broken work as done. You want to hand over your backlog, walk away,
and get back a green branch, or a straight question when it's genuinely stuck. That's
vetinari: your issues run as parallel agents, each in its own container and branch,
under an orchestrator that owns the one verdict that matters (is it done?) and never
lets the agent cast that vote itself.

![The vetinari dashboard: one live landing over every project on the host, with per-repo cards, four fleet counters, and a cross-repo event log.](docs/dashboard.png)

**Green means your test command passed.** After every "I'm done" signal, the
orchestrator runs the gates from your config inside the sandbox and reads the
exit code; only zero returns green. A red gate resumes that same agent session
with the failure output attached, so the agent keeps its context and fixes the
actual failure instead of restarting. An agent's own claim of completion never
decides anything, which matters because agents do emit it over red suites.

**A blocked agent parks: question to you, slot back to the pool.** On a
`BLOCKED` signal, an exhausted turn budget, or an idle stall, the question and
the session id are written to disk, the container is torn down, and you get a
Telegram message. Reply to it and that agent resumes with full context: new
container, fresh process, days later if you like. Parking is terminal for the
slot, never a held container, so one stuck task cannot starve the other nine.

**Parallelism is the default, not a mode.** One branch, worktree, and container
per task means concurrent tasks cannot corrupt each other's state; a bounded
pool keeps N slots full and a park frees its slot immediately.

## Quickstart

```bash
npm install github:jjforge/vetinari
```

Needs Docker, Node 22+, and `.vetinari.local/.env` holding `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token`: your Claude Code subscription, which is what these
agents run on. The container runs the official `claude` CLI and reads that
token exactly as Claude Code GitHub Actions does; nothing here handles your
credential itself.

`ANTHROPIC_API_KEY` works as a drop-in alternative, and is worth switching to
when billing is the constraint rather than convenience: it gives per-run cost
attribution and spend limits in the Console, and it doesn't consume the
subscription rate windows that a parallel queue can exhaust. Neither choice
changes how the loop behaves.

Run `npx vetinari init` to scaffold the layout: a committed
`vetinari/config.mts` (below) plus a `vetinari/Dockerfile`, and the excluded
`.vetinari.local/` for machine-local state (logs, parked tasks, and the `.env`
above), added to `.gitignore`. Put everything project-specific in
`vetinari/config.mts`, nothing else needs editing:

```ts
import { execFileSync } from "node:child_process";
import { defineConfig } from "vetinari";

export default defineConfig({
  project: "myapp",
  image: "vetinari-myapp",          // templates/Dockerfile + your toolchain
  baseBranch: "main",

  // What decides green. `when` scopes a gate to branches that touched matching
  // files: explicit and logged, never a silent skip.
  gates: [
    { cmd: "npm test" },
    { cmd: "npm run test:e2e", when: /^(src\/routes|e2e)\// },
  ],

  setup: ["npm ci"],                   // once per sandbox, before the agent starts
  fetchTask: (id) => execFileSync("gh", ["issue", "view", id, "--json", "title,body,comments"], { encoding: "utf8" }),
});
```

Build the image, then prove it before spending anything on an agent: `build`
does both, reading the image name and Dockerfile from your config and layout so
neither is repeated on the CLI:

```bash
npx vetinari build             # build cfg.image from vetinari/Dockerfile, then baseline
npx vetinari build --no-baseline   # build only, skip the probe
```

`build` shells sandcastle's `docker build-image` and, on success, runs
`baseline` (below); a build failure exits non-zero with sandcastle's output
visible and skips the probe, and a red baseline exits non-zero too. It uses the
same `cfg.image` the run/queue/campaign modes use, so "build" and "run" can
never disagree on the image.

`baseline` on its own proves an already-built image: toolchain probe + every
gate, no agent:

```bash
npx vetinari baseline          # toolchain probe + every gate, no agent
```

A failing `baseline` is the cheapest failure available. A passing one means any
red gate later is the agent's doing, not the image's.

## Skills in the agent container

The template image mirrors the [`mattpocock-skills` plugin](https://github.com/mattpocock/skills)
(v1.2.3) at **personal scope** (`/home/agent/.claude/skills/`). Sandcastle runs
the plain `claude --print` CLI (not `--bare`, not the SDK) with `HOME=/home/agent`,
so the CLI auto-discovers `~/.claude/skills/<name>/SKILL.md` with no flag,
setting, or per-run cost; every task's agent gets them. Personal scope keeps
them out of your repo and off every agent branch.

The image has no plugin machinery, so rather than "install a plugin" it clones
at the plugin's pinned commit (`SKILLS_REF`) and copies exactly the skills that
version's `.claude-plugin/plugin.json` declares: the same curated set the
plugin exposes on the host, flattened one level (discovery is not recursive into
the repo's `engineering/`, `productivity/`, and other category dirs).

Two things to know:

- **Your loop still owns "done".** `prompts/tdd.md` tells the agent that the
  signal contract and the orchestrator's gate outrank any skill: a skill's own
  TDD loop or completion notion never ends a turn or decides green. Keep that
  clause if you edit the prompt.
- **Updating is a rebuild.** Bump `SKILLS_REF` in `templates/Dockerfile` to the
  plugin's new commit (match it to your host install), rebuild, and re-run
  `baseline`. Don't want them? Delete that `RUN` block.

## Run

```bash
npx vetinari run 436                    # one task: loop until green or parked
npx vetinari queue 436 611 623 640      # fair-share pool, bounded by MAX_CONCURRENT_CONTAINERS + containerShare
npx vetinari parked                     # what's waiting on you, and why
npx vetinari status                     # all-repos landing dashboard at http://127.0.0.1:8765 (live)
npx vetinari answer 436 "use approach B, and say why in the commit"
```

Commits land on `agent/<task>`. Merging stays yours, or hand the whole
merge→test→next-queue chain to `campaign`:

```bash
git checkout main                                     # the merges land on the checked-out base
npx vetinari campaign "436 611 623" "640 655"   # each quoted arg is one batch
```

`campaign` drains a batch, merges **only its green** branches into the base with
`--no-ff`, runs the full gate on the *merged* base (the each-green-but-together-red
case a per-task gate can't catch), then deletes those branches, prunes their
worktrees, and starts the next batch on the now-advanced base. A merge conflict
or a red merged base **halts the campaign**, rolls the base back to where that
batch began, and leaves every branch intact; you get a Telegram message and no
later batch runs on a broken base. When a batch finishes, any parked records
for non-green tasks in that completed wave are cleared from `.vetinari.local/parked/`
so stale questions do not bleed into the next wave's dashboard. Pushing stays
yours.

On clean completion, a `campaign` or `queue` **archives the run** so a finished
run stops lingering in the dashboard and status line: the orchestrator log is
moved aside to `.vetinari.local/logs/archive/orchestrator-<ts>.jsonl` (kept, never
deleted) and replaced with an empty one, so the status reads idle. It only fires
on a clean finish with nothing still parked; a halt or an open question leaves
the state in place to inspect. Run `vetinari clear` to force the same reset
yourself. Archived runs stay browsable: each project's past runs (newest-first,
with a one-line summary) sit under its live run, and clicking one renders its
wave/issue view read-only.

`status` opens **one landing over every registered project on the host**: no
per-project server, no dropdown to find the right one. The page leads with four
counters and a card per repo (its wave and per-status counts), a cross-repo
**activity feed** flattening every project's live events newest-first underneath,
and it **updates live** over Server-Sent Events as runs advance, no reload.
Tapping an issue opens a **detail sheet** (status, turns, elapsed, the full turn
log) from which you can **carve** it out of the running campaign; the layout
reflows for a phone, so it is the same view you reach from the Telegram message
on your way past. It reads the host registry, so no gateway daemon is required.

![A single project's view with an archived campaign expanded into its waves and per-issue status: the epic #107 run, all green.](docs/dashboard-campaign-107.png)

**Carve one issue out of a campaign.** When an issue turns out not to be ready,
`carve` drops it *and everything that can't proceed without it* (the transitive
closure of its dependents), then runs the rest:

```bash
npx vetinari carve 640 "611 640" "623 701"   # 701 is blocked by 640
# carve #640 → removed #640, #701 (dependents: #701)
# remaining campaign: "611" "623"   ← runs this
```

Dependents come from your tracker via the config's `blockedBy` resolver;
`githubBlockedBy("owner/repo")` ships as a ready implementation over GitHub's
native "blocked by" links. Removal is transitive across every branch and
diamond (an issue falls if *any* of its blockers falls), and is computed over
the campaign's own issues: a blocker outside the named campaign is out of
scope. It runs the reduced campaign immediately; `--dry-run` only prints the
plan. Because carve only *drops* issues, each remaining wave stays as
conflict-free as you built it.

**Plan the waves from a selected set.** Building the batch list by hand is where
the dependency order gets encoded. `campaign-plan` does it for you: hand it the
ids you selected and it layers them by the `blockedBy` graph *restricted to that
set*, then prints the bare wave args (ready to paste after `campaign`) and a
provenance report explaining each ticket's wave:

```bash
npx vetinari campaign-plan 611 623 640 701   # 640←611, 701←640
# "611 623" "640" "701"
#
# campaign-plan: 3 wave(s), 4 ticket(s) scheduled, 0 unreachable.
#   wave 0  #611: no open blocker in the selected set
#   wave 0  #623: no open blocker in the selected set
#   wave 1  #640: after #611
#   wave 2  #701: after #640
```

Wave 0 is the tickets with no *open* in-set blocker: a closed (already-merged)
blocker does not hold a ticket back. A ticket whose only open blocker sits
*outside* your selection cannot run against this set; it is reported as
unreachable and dropped, along with everything that in turn depends on it, never
scheduled silently. Blocker state comes from the same `blockedBy` resolver as
`carve` (`githubBlockedBy` filters closed blockers at the edge). It **plans
only**: it never runs `campaign` and never pushes; paste the wave args into
`campaign` when you are ready.

### In your Claude Code status bar

`statusline` prints two lines for the Claude Code status bar: line 1 mirrors
Claude Code's own default (model, directory, git branch, context-used %) with the
model name trimmed of its `(1M context)` suffix; line 2 is the Vetinari run:
the wave in flight and a count per status (the 🏰 marks it; no project name,
since line 1 already shows the directory), so a running campaign is visible
without leaving the editor:

```
Opus 4.8 · jjforge · develop · 24%
🏰 wave 2/3 · ✅2 🔄1 ⏸1 ⚪1
```

Wire it in with `vetinari statusline install`, which edits the project's committed
`.claude/settings.json` for you:

```
vetinari statusline install                      # default: npx vetinari statusline
vetinari statusline install --run-command ".vetinari.local/run statusline"
vetinari statusline install --dry-run            # print the plan, write nothing
vetinari statusline uninstall                    # restore what it wrapped
```

Install **respects a status line you already have**: whatever is configured stays
as line 1 and the 🏰 campaign line is added *under* it (never replaced), so a
customized bar keeps working — Vetinari runs your original command for line 1 and
falls back to its own only when yours produces nothing. It is idempotent, and
`uninstall` restores your previous status line exactly (or removes `statusLine`
when Vetinari wrapped nothing). Pass `--run-command` to match however you invoke the
CLI in your project so the `vetinari` import and the config both resolve (default
`npx vetinari statusline`).

Or wire it by hand — the installed entry is just:

```json
{
  "statusLine": { "type": "command", "command": ".vetinari.local/run statusline", "refreshInterval": 5 }
}
```

 `refreshInterval` matters: Claude Code
refreshes the status line on its own events, but nothing tells it when the
orchestrator's log changes; polling every few seconds keeps the line live
during a run. It reads Claude Code's JSON on stdin, resolves the config from the
workspace directory, and derives line 2 from the log alone (no network), so it
stays fast. Line 1's fields come from Claude Code's own stdin JSON
(`model.display_name`, `workspace.current_dir`, `context_window.used_percentage`)
plus a `git` call for the branch. Outside a Vetinari project line 2 is simply
omitted, leaving line 1; a non-zero exit would blank the bar, so it never
errors out.

### Capture what the agent notices in passing

An agent fixing one task often spots a *different* defect it won't fix, and that
knowledge dies with the container. Set a `reportFinding` handler and a green run
ends with a **harvest turn**: on its own live session, the agent is asked for any
unrelated defect it saw (summary, location, repro), and each is filed somewhere
durable instead of evaporating.

```ts
import { githubFindingReporter } from "vetinari";

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

One host-level daemon, the **`gateway`**, fronts every project on the machine: it
is the **single Telegram consumer** (one poll per bot, so Telegram's
one-consumer-per-bot rule is never violated) and the **sole sender**: a run never
talks to Telegram itself. A run that parks or emits a notification writes a record
into its own `.vetinari.local/`; the gateway drains it and sends. Until the
gateway is up, notifications silently do not fire. The full standing-up guide,
end to end, is [`docs/gateway.md`](docs/gateway.md); the short path:

Put each project's Telegram credentials in its **base location**, in
`.vetinari.local/host.env` (gitignored, host-only), never in
`.vetinari.local/.env`, which is injected into agent containers and must not
carry a bot credential:

```bash
# <project>/.vetinari.local/host.env
VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
VETINARI_TELEGRAM_CHAT_ID=-1001234567890
```

```bash
set -a; source .vetinari.local/host.env; set +a
npx vetinari tg-test            # prove the round-trip first
npx vetinari gateway            # the ONE daemon (quick try; prefer the service below)
npx vetinari queue 436 611 623  # in another shell; registers itself with the gateway
```

Every run **registers itself** with the gateway automatically (it reads each
project live from a host registry, nothing to enrol by hand), so a queue in one
shell and the gateway in another find each other. Every park sends its question as
a message; **reply to that message** and the gateway resumes that exact task,
running concurrent resumes as needed. Send **`/status`** (bare, or `/status@yourbot`
in a group) for a live summary back in the chat, and **`carve <issue>`** to preview
a carve and, on a `yes` reply, drop it from the running campaign.

**Where messages land** is declared in the committed `vetinari/config.mts` with
two maps: `destinations` (named `{ bot, chat, thread? }` targets) and `notify`
(routing rules: a bare `category`, a `category:event`, or a `*` default → a
destination name), so you can split failures onto an alerts bot or a thread. The
five categories and the full routing model are in
[`docs/gateway.md`](docs/gateway.md). With no `notify` map, every category falls
back to the project's default chat.

### Run the gateway as a service (survives reboot)

A backgrounded `gateway &` dies with its shell, so a park raised after you close
the terminal goes unanswered. Run it as a **systemd user service** instead: one
always-on daemon, restarted on crash, brought back at boot. The host-level unit is
tracked in this repo at [`systemd/vetinari-gateway.service`](systemd/vetinari-gateway.service);
it has **no `WorkingDirectory`** (the gateway fronts every project, not one) and
sources no env file; the gateway holds no secrets of its own:

```bash
install -Dm644 systemd/vetinari-gateway.service \
  ~/.config/systemd/user/vetinari-gateway.service

systemctl --user daemon-reload
systemctl --user enable --now vetinari-gateway   # start now + at every login
loginctl enable-linger "$USER"                      # and at boot, without a login session
```

The gateway reads each project's bot credentials live from that project's
`.vetinari.local/host.env` (above); it holds no credentials of its own, so
there is no host-level `gateway.env` to source (`migrate` deletes any stale one left
by an older layout). Keep bot creds out of `.vetinari.local/.env`, which is injected
into agent containers.

`enable --now` alone brings the daemon back only when you log in; **`enable-linger`
is what makes it survive a headless reboot**: it tells systemd to start your user
manager at boot. Operate it with `systemctl --user status|restart vetinari-gateway`;
gateway detail goes to `journalctl --user -u vetinari-gateway`. **This replaces
the inline `gateway &`**: do not run both, or the two consumers fight over the
bot's updates. Migrating from the retired per-project `dispatch` poller?
`npx vetinari migrate` rewrites your old unit into this one; see
[`docs/gateway.md`](docs/gateway.md).

## Operating rules that are load-bearing

Each of these was paid for in a failed run. They are not style preferences.

1. **Never two runs of one task.** Git refuses one branch in two worktrees and
   the second run fails fast. This binds you too: a manual review worktree on
   `agent/<task>` blocks that task's resume until you remove it.
2. **Share package caches; never share build outputs.** Module caches are
   concurrency-safe and are the single biggest win: a cold gate of 2571s
   became 330s warm, measured. A shared build-output directory converts your
   parallelism back into lock contention, the exact thing containers fix.
3. **Host-only environment goes in `hostEnv`, not `.env`.** `.env` reaches the
   container. `GIT_CONFIG_GLOBAL` is the classic trap: sandcastle needs it
   host-side for `safe.directory`, and inside a container it overrides the HOME
   a project's own git tests depend on. This is the **container-boundary
   invariant**: the only file that crosses into the agent container is
   `.vetinari.local/.env`, so any host-only value (`GIT_CONFIG_GLOBAL`, and a
   Telegram bot credential) must live elsewhere (`hostEnv`, or the host-side
   secrets file `.vetinari.local/host.env`), never in `.env`. See
   [ADR 0011](docs/adr/0011-configuration-layers.md) for the full
   configuration-layers model (scope × secrecy × container-reach).
4. **Cap live containers with `MAX_CONCURRENT_CONTAINERS`.** A full suite per
   turn is CPU-bound, and parallel agents also share your account's rate limits.
   Set `MAX_CONCURRENT_CONTAINERS` (env, or a `max-concurrent-containers` file in
   the gateway config dir) to bound live containers across every project; unset,
   it resolves to a machine-derived default (never unbounded). There is no
   per-run cap; a lone project fills the ceiling. When projects contend, each
   takes a cut by its `containerShare` (`high` | `medium` | `low`, default
   `medium`), with a floor of one and no starvation. See
   [ADR 0011](docs/adr/0011-configuration-layers.md).
5. **Batch tasks with disjoint files and no dependencies.** Crossover surfaces
   as merge conflicts you can see; a dependency doesn't surface at all: task B
   builds green against the pre-A contract and merges clean.

## Update this package

**Installed from git** (`github:jjforge/vetinari`): npm copies the repo
at a commit, so updates are explicit:

```bash
npm update vetinari                          # move to the tip of main
npm install github:jjforge/vetinari#<sha>           # or pin to a commit
```

Then re-run `npx vetinari baseline` in that project. Its image, gates, and
config are what an update has to keep working, and `baseline` exercises all
three without agent cost.

**Installed from a local path** (`file:../vetinari`): npm creates a
**symlink**, so the consuming project always runs your working tree and a `git
pull` in the package directory takes effect immediately with no reinstall.
Convenient while developing the orchestrator, and worth knowing when debugging:
a consuming project has no pinned version to blame, because it has no pin.

Config changes are the other update path. `defineConfig` is typed, so `npx tsc
--noEmit` in the consuming project catches a renamed or dropped field.

## Update `@ai-hero/sandcastle`

> **Temporary fork pin.** `@ai-hero/sandcastle` is pinned to a fork,
> `git+https://github.com/zachthieme/sandcastle.git`, at the `state-dir-prebuilt`
> commit, for the `stateDir` option vetinari needs (it routes sandcastle's own
> artifacts under `.vetinari.local/` instead of a stray `.sandcastle/`). That
> branch carries a prebuilt `dist/`, because npm 11 blocks a dependency's
> build-on-install scripts by default and a git install could not otherwise build
> it. The change itself is upstream as
> [mattpocock/sandcastle#961](https://github.com/mattpocock/sandcastle/pull/961);
> this pin is temporary, to be dropped for a published `@ai-hero/sandcastle` (the
> flow below) once that PR lands in a release. The clean feature branch
> (`configurable-state-dir`, what the PR tracks) carries no `dist/`.

When on a published release, the dependency is pinned `^0.12.0`, so npm's caret
allows patches only. sandcastle is pre-1.0, so a minor can carry behavioural
changes; pinning to patches lets us adopt a minor deliberately, after re-verifying
the integration points below, rather than by surprise.

```bash
npm install @ai-hero/sandcastle@latest   # here, and in each consuming project
npm run check-contract                   # ~1s, no Docker: is the surface intact?
npx vetinari baseline              # container + gate path still work
npx vetinari run <small task>      # agent + session + resume still work
```

Climb all four rungs, because each sees what the one below cannot.
`check-contract` catches a renamed export or dropped option in about a second;
`tsc` alone will **not**, because vetinari probes a few optional members of
sandcastle's result objects at runtime. `baseline` proves the container path.
Only a real `run` exercises the agent, the gate→resume cycle, and session capture.

vetinari builds on four sandcastle behaviours that no static check can see. These
are the integration points `check-contract` prints, and the ones we re-verify on
any minor bump:

1. **A sandbox command returns a non-zero exit code rather than throwing.** This
   is what lets a red gate read as red, so it is the behaviour we depend on most
   and the first we check on an upgrade.
2. **`resumeSession` is used without `maxIterations > 1`.**
3. **An idle agent throws a catchable timeout**, which is how a stall is detected
   and parked.
4. **Session capture writes host-side JSONL, and re-creating a sandbox on an
   existing branch reuses that worktree**: together, what make park→answer
   survive a fresh process.

Consuming projects pin the library themselves (it's a peer in practice), so bump
it there too and re-run that project's `baseline`.

## Modes

| Mode | What it does |
| --- | --- |
| `build [--no-baseline]` | build `cfg.image` from `vetinari/Dockerfile` (neither repeated on the CLI) via sandcastle, then `baseline` on success; `--no-baseline` builds only. A build or baseline failure exits non-zero with sandcastle's output shown |
| `baseline` | toolchain probe + all gates, no agent |
| `run <task>` | the TDD loop; exit 0 green, 2 parked |
| `queue <task…>` | bounded pool; a park frees its slot |
| `campaign <batch…>` | drain each batch, merge its greens, gate the merged base, then start the next |
| `carve <issue> <batch…>` | drop the issue + its transitive dependents, then run the rest as a campaign (`--dry-run` to just print) |
| `campaign-plan <ids…>` | layer a selected set into dependency-ordered wave args (paste after `campaign`) + a provenance report; plans only, never runs |
| `init [--dry-run]` | scaffold a **new** project onto the layout: committed `vetinari/` (config skeleton + Dockerfile), excluded `.vetinari.local/`, `.gitignore` updated (idempotent, never clobbers an existing config; `--dry-run` to just print the plan) |
| `migrate [--dry-run]` | move an **existing** project onto the `vetinari/` + `.vetinari.local/` layout: config → `vetinari/`, old `.sandcastle/` state → `.vetinari.local/`, `.gitignore` updated, the host-side `orchestrator.env` renamed to `host.env`, a stale `gateway.env` deleted, and the systemd unit rewritten into the gateway service (`--dry-run` to just print the plan) |
| `answer <task> <text>` | resume a parked task with your answer |
| `gateway` | the one host daemon fronting every registered project: sole Telegram consumer and sender: announces parked questions, routes replies (and `carve <issue>`) to the right project+task, resumes them concurrently, and hosts the status dashboard |
| `parked` | list what is waiting and why |
| `clear` | archive the run log + clear parked, resetting the dashboard/status line to idle (automatic on clean campaign/queue completion) |
| `status [--port <port>] [--host <host>]` | the all-repos landing over the host registry: counters, a card per registered project, a cross-repo activity feed, and each project's archived runs, live over SSE. Reads the registry, so no gateway daemon required |
| `statusline` | one compact line for the Claude Code status bar; reads Claude Code's JSON on stdin |
| `statusline install` / `statusline uninstall` | wire the status line into the project's `.claude/settings.json`, keeping any existing status line as line 1 with the 🏰 line under it (`--run-command`, `--dry-run`) |
| `tg-test` | prove the Telegram round-trip |

## What lands where

| Path | Contents |
| --- | --- |
| `.vetinari.local/parked/<task>.json` | pending question, session id, branch, Telegram message id |
| `.vetinari.local/outbox/<id>.json` | a category-tagged record a run enqueues for the gateway to send |
| `.vetinari.local/routing.json` | this project's `destinations`/`notify` materialized for the gateway to read |
| `.vetinari.local/logs/orchestrator.jsonl` | every event: sandbox, turn, gate, park, green |
| `.vetinari.local/logs/gate-<ts>.log` | full stdout/stderr of each gate run |
| `.vetinari.local/logs/archive/orchestrator-<ts>.jsonl` | a finished run's log, moved aside on completion or `clear` |

## Known limits

- **Token accounting under-reports.** `IterationResult.usage` reflects the final
  message, not the session; read the session JSONL for real cost.
- **Gateway resumes sit outside the queue's slot accounting**, so heavy
  answering can briefly exceed a project's fair share of `MAX_CONCURRENT_CONTAINERS`.
- **Session capture is required.** Non-resumable providers (`cursor`,
  `opencode`, `copilot`) can't drive this loop; the run fails with a clear
  message rather than degrading silently.

Built on [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle).
`examples/jjforge/` is a real config over a Go + Rust monorepo with GitHub-issue
tasks.
