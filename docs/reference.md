# vetinari reference

The exhaustive lists. The [README](../README.md) is the pitch, the
[user guide](user-guide.md) is the operator's model, and [design.md](design.md) is
current implementation truth — this document is where every CLI mode, config
field, on-disk file, environment variable, event kind, and Telegram routing rule
is enumerated. Where a rule needs a *why*, it points back to a design section.

## CLI modes

The one exhaustive command list. It is **generated from `MODES` in
[`src/help.ts`](../src/help.ts)** — the same source `vetinari --help` renders — so
this table and `--help` cannot drift (design §13.3). Add, rename, or remove a mode
in `src/help.ts`, then run `npm run gen-reference`; `help.test.ts` fails until the
block below matches. Do not hand-edit between the markers.

The global option `--config <path>` (default `vetinari/config.mts` in the cwd)
applies to every mode and is not itself a mode.

<!-- BEGIN GENERATED MODES — from src/help.ts (MODES); regenerate with `npm run gen-reference`, do not hand-edit -->
| Mode | What it does |
| --- | --- |
| `build [--no-baseline]` | build the agent image (cfg.image from vetinari/Dockerfile, neither repeated on the CLI) via sandcastle, then run baseline on success. --no-baseline builds only. A build or baseline failure exits non-zero with sandcastle's output shown |
| `baseline` | prove the image runs every gate green — no agent, no cost |
| `run <task> [--agent <name>] [--model <m>] [--effort <e>]` | the TDD loop: agent turn → gate → resume on red. Banks its commits on agent/<task> and MERGES NOTHING — integration (the merge onto the base and the merged-base gate) is the campaign's, so a green run leaves work on its branch, not on the base; `campaign <task>` is the one-issue campaign that lands it. --agent picks the provider (claude \| pi \| codex, default claude or cfg.agent.provider; copilot \| cursor \| opencode are experimental — non-resumable, so a parked question needs postComment to be answered); --model/--effort override that provider's defaults, effort in the provider's own vocabulary. A bad provider/effort or missing provider credentials fails fast before the container (ADR 0016). --json streams the raw event log to stdout for tooling; without it the terminal shows human-readable lines only and no JSON reaches stdout (design §11) |
| `campaign [--dry-run] [--override] [--name "…"] [--auto-prune] [--agent <name>] <ids-or-labels…>` | select issues, plan them into dependency-ordered file-disjoint waves, then run them (run a wave, merge greens → gate base → next). A numeric token is an issue id; a NON-numeric token is a label expanded to the open issues carrying it (needs a listByLabel resolver — githubIssuesByLabel(repo) — else a label fails fast). --dry-run plans only, printing the wave plan + provenance + suggested --name and running nothing. --override skips the planner and runs each positional as one literal wave (labels inside still expand). --on-underspecified=drop\|fail pre-decides the planner's not-confident halt for non-interactive runs. --name labels the run; --agent (with --model/--effort) selects the provider for the whole campaign and every child wave (claude \| pi \| codex; copilot \| cursor \| opencode experimental; ADR 0016). If a merge conflict parks an issue whose dependents sit in later waves the campaign pauses for a human by default; --auto-prune prunes the stranded closure and runs on (ADR 0013). The terminal shows human-readable lines — the plan, per-wave progress, the one-line stop reason and the exact recovery command; --json streams the raw event log to stdout for tooling instead, and without it no JSON reaches stdout (design §11) |
| `redrive` | pick an unfinished campaign back up on the current base — the umbrella verb (ADR 0020): reconstructs the plan from the event log and re-enters the first wave that did not close, reconciling it before running (design §7) — a green-but-unmerged member is integrated without a rerun, an answered park (its record gone) re-runs, an unresolved park re-parks the wave, and a failed member stops the campaign as failed again unless --override re-runs it. Redoes no already-merged issue. Takes no issue args; use it after a prune, graft, fix-forward, crash, or failure. Nothing left to run reports so and exits clean (`campaign --resume` is a one-release alias). --json streams the raw event log to stdout for tooling; without it the terminal shows human-readable lines only (design §11) |
| `prune [<project>] <issue>` | prune <issue> + everything blocked by it from the RUNNING campaign: appends a prune event the loop honors at the next wave boundary (the in-flight wave finishes; only future waves shrink). Leads with what it acts on — the project, the derived owner/repo and the issue title (`vetinari · owner/repo#42 — "…"`). Banked work stays — a merged/green member is kept, only parked/not-yet-started ones leave. A dropped member's parked record is cleared as it leaves (the record only NAMES the work — its branch, worktree and session survive, so it stays resumable); --purge is the rare true-drop that additionally deletes each dropped member's branch + worktree, disclosing per member the branch, its commit count not reachable from the base, and the worktree path before acting (--purge --dry-run previews exactly that, deleting nothing). An optional <project> qualifier (the spelling the gateway accepts) asserts which project you mean and refuses if it names a different one or the repo identity can't be derived — it never dispatches across projects. Needs a running campaign (--dry-run to only preview). |
| `graft [<project>] <ids…>` | add issues to a RUNNING (or paused/parked/redrivable) campaign — the additive mirror of prune (ADR 0014): appends a graft event the loop honors at the next wave boundary. Leads with what it acts on — the project, the derived owner/repo and each id's title — so an id from the wrong repo is recognizable. The in-flight wave finishes untouched; the added issues re-layer into future waves (after their blockers, basename-disjoint), leaving already-planned waves stable. Rejected whole — naming the offenders — if any id is malformed (not an issue id), unknown/closed, or already in the campaign. An optional <project> qualifier asserts which project you mean and refuses if it names a different one or the repo identity can't be derived. Needs a campaign that has not finished (--dry-run to only print the resulting placement). |
| `init [--dry-run]` | scaffold a NEW project onto the layout: create the committed vetinari/ (a defineConfig skeleton + a Dockerfile template), the excluded .vetinari.local/, and add .vetinari.local/ to .gitignore. Idempotent and non-clobbering — an existing vetinari/ config is never overwritten (--dry-run to print the plan and write nothing). Installs and vendors nothing |
| `migrate [--dry-run]` | move this project onto the vetinari/ + .vetinari.local/ layout: config → vetinari/, old .sandcastle/ state → .vetinari.local/, .gitignore updated, and the host-side orchestrator.env renamed to host.env. A one-time layout move — it carries no other rename shims (--dry-run to print the plan and change nothing) |
| `changelog collect [--title "…"]` | fold this repo's changelog.d/*.md fragments into CHANGELOG.md under today's milestone (append to the top milestone if it is dated today, else start one), then delete the consumed fragments. What the orchestrator runs per wave at merge; a human may run it directly. --title sets a fresh milestone's title (default: "Collected changes") |
| `tidy [--apply] [--all]` | reconcile the drift a by-hand fix-forward or merge leaks (ADR 0013): fold orphaned changelog.d/ fragments whose issue is merged, GC agent/<id> branches + worktrees that are PROVABLY reachable from the base, and clear parked records for issues now merged. Never touches an unmerged, parked, or conflicted branch. Dry-run by default (prints what it would do); --apply acts. --all sweeps every registered project, not just this one, and drops duplicate-projectRoot registry pointers (keeping the canonical .vetinari.local one) |
| `answer <task> <text>` | resume a parked task with a human answer |
| `gateway` | the host daemon fronting every registered project: the sole Telegram consumer and sender — announces parked questions, routes replies to the right project+task, and resumes them concurrently via the shared install. Also recognizes `prune <issue>` (and `prune <project> <issue>` when several campaigns run on one bot): previews the closure and prunes the resolved project on a `yes` reply to the preview |
| `gateway install [--dry-run]` | write the host-level systemd unit for THIS install to ~/.config/systemd/user/vetinari-gateway.service, with a fully absolute node + tsx-loader + cli ExecStart — no bash -lc, env, npx, or PATH dependency, so it starts under systemd's clean environment (fixes the nvm/fnm/mise/asdf crash-loop). Re-run after a node/tsx upgrade (--dry-run to print the unit and write nothing) |
| `gateway status` | show whether the host gateway service is running — wraps `systemctl --user status vetinari-gateway --no-pager` and propagates its exit code. A missing/uninstalled service (or absent systemctl) points you at `gateway install` rather than a raw failure |
| `gateway start` | start the host gateway service — `systemctl --user start vetinari-gateway` (the unit `gateway install` wrote) |
| `gateway stop` | stop the host gateway service — `systemctl --user stop vetinari-gateway` |
| `gateway restart` | restart the host gateway service so it serves the current code (tsx compiles at startup, so a restart is how merged changes go live) — `systemctl --user restart vetinari-gateway`, then reports is-active |
| `host log [-n <count>] [--tail] [--json]` | read the persistent host log (<gatewayConfigDir>/logs/host.jsonl) at the terminal — the host/gateway diagnostics that land nowhere a per-project feed shows. Prints the most recent events newest-first, one human-readable line each; -n bounds the window (default 50). --json passes the raw JSONL through untouched (for jq/grep); --tail (or -f) follows live, printing new events as they append. Reads the file directly, so no daemon need be running — a missing host.jsonl prints "no host log yet" and exits clean |
| `parked` | list parked tasks and their questions |
| `clear` | archive the run log + clear parked, resetting the dashboard/status line to idle (automatic on clean campaign completion; this forces it now) |
| `status [--port <port>] [--host <host>]` | one dashboard over the host registry: campaign/wave and parked status for every registered project, a dropdown to switch between them (a single project is one entry). Reads the registry, so no gateway daemon is required |
| `registry remove <name>` | remove one project's pointer from the host registry, so the dashboard stops listing it (the explicit counterpart to the auto-register every run performs — not container slots). A name that is not registered is a clean no-op |
| `statusline` | one compact line for the Claude Code status bar (reads Claude Code's JSON on stdin; wire into settings.json) |
| `statusline install [--run-command "<cmd>"] [--dry-run]` | wire the status line into the project's committed .claude/settings.json. A status line already configured there is kept as line 1 with the 🏰 campaign line added under it (never replaced). Idempotent. --run-command sets how the CLI is invoked (default: npx vetinari statusline) |
| `statusline uninstall [--dry-run]` | remove it, restoring whatever status line it wrapped |
| `tg-test` | prove the Telegram round-trip |
| `tg-connect [--token <t>] [--chat <c>] [--no-verify] [--force]` | collect this project's Telegram bot connection — its bot token and default chat — into its own .vetinari.local/host.env (host-side, never the container gate; ADR 0002/0011). On a terminal with no flags it prompts for the two values; --token/--chat supply them for a scripted run and then it never prompts (non-interactively, a missing value exits non-zero naming it). Before writing it sends one message to verify the token and chat; on failure nothing is written (a terminal re-prompts, non-interactive exits non-zero) — --no-verify skips the send. A host.env that already carries a connection is left alone unless you confirm (terminal) or pass --force; re-running is safe and other keys in the file are preserved. `init` offers this same step after its scaffold |
<!-- END GENERATED MODES -->

## Configuration fields

Declared in the committed `vetinari/config.mts` via `defineConfig`. Placement of a
value across the config *files* (which layer holds a secret, which crosses into the
container) is the on-disk layout below and design §9; this table is the fields of
the config object itself.

| Field | Purpose |
| --- | --- |
| `project` | this project's name in the host registry, dashboard, and notices |
| `image` | the agent image name — built from `vetinari/Dockerfile`, used by `build`/`baseline`/`run`/`campaign` alike |
| `baseBranch` | the branch merges land on (the base a campaign advances) |
| `gates` | the test commands that decide green; `{ cmd, label?, when? }` — `when` scopes a gate to branches that touched matching files |
| `setup` | commands run once per sandbox, before the agent starts (e.g. `npm ci`) |
| `mounts` | host paths mounted into the container — shared package caches, never build outputs |
| `agent` | the default provider selection (`provider`, `model`, `effort`); a per-invocation `--agent`/`--model`/`--effort` overrides it |
| `maxTurns` | turn budget per task before a `stalled` park (default 6) |
| `idleTimeoutSeconds` | idle-stall ceiling before a `stalled` park (default 600) |
| `parkGraceSeconds` | grace before a no-commit turn parks `stalled` (default 0) |
| `containerShare` | this project's cut of the container ceiling when projects contend — `high` \| `medium` \| `low` (default `medium`; weights 7:2:1) |
| `hostEnv` | host-only, non-secret env values (e.g. `GIT_CONFIG_GLOBAL`) — set host-side, never crosses into the container |
| `promptFile` | override the TDD prompt handed to the agent |
| `fetchTask` | tracker seam: fetch an issue's title/body/comments/labels **and** state/closedAt (`githubFetchTask(repo)`) |
| `blockedBy` | tracker seam: an issue's blockers, for wave layering (`githubBlockedBy(repo)`, closed blockers filtered at the edge) |
| `listByLabel` | tracker seam: expand a label token to its open issues (`githubIssuesByLabel(repo)`) |
| `fileSet` | seam: the files an issue touches/creates, for keeping a wave file-disjoint |
| `reportFinding` | hook: file a finding harvested from a green run (`githubFindingReporter(repo, opts)`); absent → no harvest turn |
| `onIssueMerged` | hook: advance a merged issue's label (`githubMarkPendingVerify(repo)`); absent → no-op |
| `postComment` | hook: post a comment to the tracker (used to answer a non-resumable provider's park) |
| `destinations` | named Telegram targets `{ chat, thread? }` on the project's one bot |
| `notify` | routing rules mapping a `category` / `category:event` / `*` to a destination name |

## On-disk layout

Every file vetinari reads or writes, and which files cross into the agent
container. The **container-boundary invariant**: the only file that crosses into
the container is `.vetinari.local/.env` (design §9, ADR 0011).

| Path | Contents |
| --- | --- |
| `vetinari/config.mts` | committed, no secrets — the config object above |
| `vetinari/Dockerfile` | committed — the agent image's toolchain |
| `.vetinari.local/.env` | **the container gate** — only the agent provider's credential; the one file injected into the container |
| `.vetinari.local/host.env` | host-only secrets — this project's Telegram bot token and chat; never crosses into the container |
| `.vetinari.local/parked/<task>.json` | parked record: `taskId`, `parkedAt`, `reason`, `detail`, `branch`, `sessionId?`, `question`, `tgMessageId?` (design §2.5) |
| `.vetinari.local/outbox/<id>.json` | a category-tagged outbound record a run enqueues for the gateway to send (design §2.6) |
| `.vetinari.local/routing.json` | this project's `destinations`/`notify` materialized for the gateway to read |
| `.vetinari.local/logs/orchestrator.jsonl` | the event log — one JSON object per line, append-only for the life of a run (design §2.1) |
| `.vetinari.local/logs/gate-<ts>.log` | full stdout/stderr of one gate run |
| `.vetinari.local/logs/archive/orchestrator-<ts>.jsonl` | a finished run's log, moved aside on clean completion or `clear` (kept, never deleted) |
| host config dir | the registry, the container lease, the `max-concurrent-containers` file, and the host log — beside each other, not per-project (e.g. `~/.config/vetinari/`) |
| `<host config dir>/logs/host.jsonl` | host-level diagnostics: the `gateway`/`status` daemon's own events, appended across restarts |

## Environment variables

| Variable | Where | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_CONTAINERS` | host env, or a `max-concurrent-containers` file in the host config dir | caps live containers across **all** projects; unset resolves to a machine-derived default (never unbounded) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `.vetinari.local/.env` | Claude Code credential (from `claude setup-token`) — runs on your subscription |
| `ANTHROPIC_API_KEY` | `.vetinari.local/.env` | Claude (drop-in alternative, per-run cost attribution) or `pi` credential |
| `OPENAI_API_KEY` | `.vetinari.local/.env` | Codex credential |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | `.vetinari.local/.env` | GitHub Copilot CLI credential (experimental provider) |
| `CURSOR_API_KEY` | `.vetinari.local/.env` | Cursor credential (experimental provider) |
| `OPENCODE_API_KEY` | `.vetinari.local/.env` | OpenCode credential (experimental provider) |
| `VETINARI_TELEGRAM_BOT_TOKEN` | `.vetinari.local/host.env` | this project's Telegram bot token — host-only, never crosses into the container |
| `VETINARI_TELEGRAM_CHAT_ID` | `.vetinari.local/host.env` | this project's default Telegram chat |
| `GIT_CONFIG_GLOBAL` | `hostEnv` (host-side only) | sandcastle's host-side `safe.directory`; must **not** reach the container, where it would override the agent's `HOME` (see the operating rules) |
| `TZ` | process env | the zone the CLI renders timestamps in (the log stores ISO-8601 UTC only; the dashboard uses the browser's zone) |

## Event kinds

The event log (`logs/orchestrator.jsonl`) is one JSON object per line,
`{ ts, event, … }`, `ts` in ISO-8601 UTC. The state-bearing vocabulary
(design §2.1); the reducer folds these into issue/wave/campaign state:

| Event | Fields | Emitted by |
| --- | --- | --- |
| `campaign-start` | `waves`, `name?`, `titles?` (id → title, recorded once) | campaign |
| `wave-start` | `index`, `tasks` | campaign |
| `spawn` | `task` | campaign (queue) |
| `turn` | `task`, `turn`, `summary`, `signal`, `sessionId?`, `commits?` | run |
| `green` | `task`, `branch`, `commits` | run |
| `parked` | `task`, `reason`, `detail` | run (question/stalled), integrator (conflict), campaign (red-base) |
| `failed` | `task`, `detail` | run |
| `merged` | `task` | integrator |
| `base-gate` | `index`, `green`, `detail` | integrator |
| `wave-done` | `index` | campaign — only when every member is `completed` |
| `campaign-parked` / `campaign-failed` | `index`, `detail` | campaign — the two stop markers |
| `campaign-done` | `waves` | campaign |
| `prune` | `target`, `removed`, `dropped` | prune |
| `graft` | `ids`, `blockedBy`, `basenames`, `titles?` | graft |
| `redrive` | `fromWave`, `landed`, `skipped` | campaign |

Diagnostic rows — `gate`, `gate-result`, `commit`, `tool`, `sandbox-exec`,
sandbox setup, hook failures — are activity, not state: the reducer ignores them;
the issue sheet and live tail read them.

**Park reasons** (design §2.3) — the one enum on the parked record, the `parked`
event, and the dashboard: `question | stalled | conflict | red-base | crash`.
`detail` carries the specifics. `question` and `stalled` are resumable by an
answer; `conflict`, `red-base`, and `crash` need a redrive after a human move.

## Telegram routing

One host daemon, the `gateway`, is the single Telegram consumer and sole sender;
a run never talks to Telegram — it writes an outbound record and the gateway
sends it (design §10).

- **Categories** — four, the `category` on every outbound record: `success`,
  `failure`, `progress`, `finding`. A record may carry an event name too, e.g.
  `progress:wave-start`; the event names are the §2.1 words (`wave-start`,
  `wave-done`, `campaign-parked`, `campaign-failed`, `campaign-done`, `prune`,
  `graft`, `redrive`). A question is not an outbound record — it is a parked
  record announced under the `question` routing key.
- **Destinations** — one bot per project (its token read from `host.env`);
  `destinations` names `{ chat, thread? }` targets on that bot.
- **`notify` rules** — map a `category`, a `category:event`, or `*` (default) to a
  destination name. With no `notify` map, every category falls back to the
  project's default chat (`VETINARI_TELEGRAM_CHAT_ID`). `question` **must** resolve
  to exactly one destination, because the gateway watches it for the reply.
- **Replies and commands** — a reply to a question message routes by
  `(bot, messageId)` to the project and issue, and the gateway shells `answer` in
  that project's root. `/status` (a live summary) and `prune <issue>` (preview,
  then `yes`) are the only recognized commands.
- **Notice skeleton** — every notice is header (`<emoji> <project> · <STATE> ·
  <context>`), one signal line, and the exact recovery command where there is one.
