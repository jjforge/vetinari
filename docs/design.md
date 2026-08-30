# Vetinari — design

This is the current design: the one document the implementation is meant to match. It is written from the operator's model in [`user-guide.md`](user-guide.md) — each section says what the user sees and then what implements it. ADRs under [`adr/`](adr/) record _why_ a decision was taken and stay as history; when an ADR and this document disagree, this document wins and the ADR gets a one-line superseded note. Dated specs are build-time artifacts and are not current truth; they are kept for provenance under [`archive/`](archive/) and are not linked from current docs.

The document has three parts: the system as it should be (§1–§11), the surface inventory that says what is core and what is not (§12), and the consolidation this design asks for — vocabulary, schema, documentation — with the places the implementation diverges today (§13–§15).

---

## 1. Shape

One process per CLI invocation; the working directory selects the project. A campaign is a parent process that spawns one child `run` per issue. Two long-lived host processes exist: the gateway (Telegram) and the dashboard (HTTP), and neither holds state of its own — both read every project live from a pointer registry.

```
                    ┌─────────────── host (~/.config/vetinari/) ───────────────┐
                    │  registry/   (project pointers)     slots  (lease file)  │
                    │  logs/host.jsonl                                          │
                    └────────▲───────────────────────────────────▲─────────────┘
                             │ reads pointers                     │ reads pointers
  ┌──────────────┐   ┌───────┴────────┐                  ┌───────┴────────┐
  │  Telegram    │◄──┤    gateway     │                  │   dashboard    │◄── browser
  └──────────────┘   │ poll · route · │                  │ SSE · pages ·  │
        replies ────►│ drain outboxes │                  │ actions        │
                     └───────┬────────┘                  └───────┬────────┘
                             │ shells `answer` / `prune`          │ shells CLI
                             ▼         in the project root        ▼
  ┌────────────────────────── project (<root>/.vetinari.local/) ───────────────────┐
  │  logs/orchestrator.jsonl   ← the event log: single source of truth for a run   │
  │  parked/<id>.json          ← durable park records (question, session, branch)  │
  │  outbox/<uuid>.json        ← outbound messages the gateway drains              │
  │  worktrees/, logs/agent-*, gate-*, activity-*   ← live-only scratch           │
  │  .env (→ container)   host.env (host only)   routing.json (materialized)      │
  └──────────────────────────▲──────────────────────────────────────────────────────┘
                             │ appends events, writes records
                   ┌─────────┴──────────┐        spawns        ┌──────────────────┐
                   │  campaign (parent) ├─────────────────────►│  run <issue>     │
                   │  plan → waves →    │                      │  (child, 1/issue)│
                   │  integrate → gate  │                      │  container via   │
                   └────────────────────┘                      │  sandcastle      │
                                                               └──────────────────┘
```

Components and the one job of each:

| Component | Job | Lives in |
| --- | --- | --- |
| CLI | parse a mode, load the project config, dispatch | `cli.mts`, `cli-dispatch.ts`, `help.ts` |
| Run loop | one issue in one container: turn → gate → fix → … → green / parked / failed | `loop.ts`, `gate.ts`, `sandbox.ts` |
| Planner | selection → dependency layers → file-disjoint waves | `plan.ts`, `fileset.ts`, `prune.ts` |
| Campaign loop | run waves; integrate; enforce the wave gates; stop or continue; redrive | `modes.ts` |
| Integrator | merge greens one by one; gate the merged base; post-merge hooks | `merge.ts` |
| State store | event log, parked records, outbox, archive | `event-log.ts`, `state.ts`, `archive.ts` |
| Reducer | event log → issue / wave / campaign / card state — one fold, used everywhere | `dashboard-model.ts` (`reduceCampaign`) |
| Host registry + lease | project pointers; the container-count lease | `registry.ts`, `host-slots.ts` |
| Gateway | sole Telegram consumer and sender; routes replies and commands to projects | `gateway.ts`, `gateway-service.ts` |
| Dashboard | HTTP over the registry; renders the reducer's output; actions shell the CLI | `dashboard-*.ts`, `status.ts` |

Two rules hold this shape together:

- **The event log is the only durable truth about a run.** The campaign loop decides its next wave by folding the log; the dashboard renders by folding the log; a redrive reconstructs the campaign by folding the log. There is no plan file, no in-memory plan that outlives a wave boundary, and no state the dashboard has that the loop does not.
- **The host processes are dumb.** The gateway and the dashboard hold pointers, not state; any action they offer is the same CLI verb shelled in the project's root. Every recovery is therefore reachable from the terminal, and the host processes are reconstructable from the registry alone.

## 2. Data model

### 2.1 Event log

`logs/orchestrator.jsonl`, one JSON object per line, `{ ts, event, … }`, append-only for the life of a run, moved to `logs/archive/orchestrator-<ts>.jsonl` when the run finishes clean (or on `clear`). Archived logs are kept, never deleted, and render in the dashboard read-only through the same reducer. `ts` is ISO-8601 UTC; nothing on disk holds a local time. Display converts to the viewer's zone — the browser's for the dashboard, the process `TZ` for the CLI.

The event vocabulary after consolidation (§13.2) is small and uses the user's words:

| Event | Fields | Emitted by |
| --- | --- | --- |
| `campaign-start` | `waves`, `slots`, `name?`, `titles?` (id → title, recorded once) | campaign |
| `wave-start` | `index`, `tasks` | campaign |
| `spawn` | `taskId` | campaign |
| `turn` | `taskId`, `turn`, `summary`, `signal`, `sessionId?`, `commits?` | run |
| `green` | `taskId`, `branch`, `commits` | run |
| `parked` | `taskId`, `reason`, `detail` | run (question/stalled), integrator (conflict). A red base is the *wave's* reason and is written, not inferred: `campaign-parked` carries `reason: red-base` for that wave index; no per-member `parked` event is written |
| `failed` | `taskId`, `detail` | whichever process observes it: the run loop on a throw, the campaign on a child's non-zero exit |
| `merged` | `taskId` | integrator |
| `base-gate` | `index`, `green`, `detail` | integrator |
| `wave-done` | `index`, `merged` | campaign — only when every member is `completed` |
| `grace-wait` | `seconds`, `tasks` | campaign (§5 step 3) |
| `campaign-parked` / `campaign-failed` | `index`, `reason` (`red-base`, `question`, `stalled`, `conflict` — the wave's reason, written by the code that stopped), `detail` | campaign — the two stop markers |
| `campaign-done` | `waves` | campaign |
| `prune` | `target`, `removed`, `dropped` | prune |
| `graft` | `ids`, `blockedBy`, `basenames`, `titles?` | graft |
| `redrive` | `fromWave`, `landed`, `skipped` | campaign |

Diagnostic rows (`gate`, `gate-result`, `commit`, `tool`, `sandbox-exec`, sandbox setup, hook failures) are activity, not state: the reducer ignores them, the issue sheet and live tail read them. Two rules:

- **An event records what happened, not how to render it.** Titles are recorded once on `campaign-start`; a single-event reader that wants a name looks it up. No presentation state (theme, cosmetic naming offsets) is ever written to the log.
- **State is emitted by the transition that caused it.** The park reason is written by the code that parked, never inferred later from surrounding events.

### 2.2 The issue lifecycle

One state machine, fed by the log, with the five states of the user guide:

```
unstarted ──spawn──► running ──green+merged──► completed
                        │
                        ├──parked(reason)──► parked ──answer / redrive──► running
                        │
                        └──failed──────────► failed ──redrive (after prune/fix)──► running
```

`completed` means merged onto the base. A green that is not yet merged (an answered park that went green outside its wave, or a green pulled out of integration by a conflict) is **`running` with a pending green**, not `completed` — the word for banked work is reserved for work on the base.

Membership is an orthogonal axis — `member | grafted | pruned` — so a chip shows its lifecycle as the dot and its membership as a badge, with no precedence between them.

### 2.3 Park reasons — one enum

`question | stalled | conflict | red-base | crash`. This is the reason on the parked record, the reason on the `parked` event, the reason the reducer exposes, and the reason the dashboard and the docs use. `detail` carries the specifics (which budget, idle vs no-commit, the conflict output, the gate tail). The reason selects the recovery affordance:

| Reason | Set by | Resumable by an answer | Needs a redrive |
| --- | --- | --- | --- |
| `question` | run loop on BLOCKED | yes | no — the answer continues |
| `stalled` | run loop on turn budget, idle timeout, or an empty COMPLETE | yes (an answer is guidance) | no |
| `conflict` | integrator on merge conflict | no | yes, after the human resolves it |
| `red-base` | campaign on a red merged base — the wave's reason, carried by `campaign-parked` | no | yes, after fix-forward or prune |
| `crash` | reconciliation (dead process, no stop marker) | no | yes |

### 2.4 Roll-ups

Wave, campaign and card states are pure folds of the level below, never stored:

- wave: `failed` if any member failed; else `parked` if any parked; else `running` if any running; else `completed` if all completed; else `unstarted`.
- campaign: the same fold over its waves.
- card: campaign state, with `completed`/`unstarted`/no-campaign folding to `idle`.

A parked record that survives a run (it always does, until resolved) keeps the card out of `idle` even if the log was archived out of band.

### 2.5 Parked record

`parked/<id>.json`: `{ taskId, parkedAt, reason, detail, branch, sessionId?, question, tgMessageId? }`. Written by whatever parks; never cleared at a wave boundary or at archive; cleared only when the issue goes back to `running` (answer, redrive) or is purged by an explicit prune `--purge`. `tgMessageId` is stamped by the gateway when announced and is the announce-once guard across restarts; it also lets the gateway rebuild its reply index from disk.

### 2.6 Outbound record

`outbox/<uuid>.json`: `{ id, category, event?, text, enqueuedAt, sentAt?, destination? }`, `category` one of `success | failure | progress | finding`. A question is never an outbound record — it is the parked record (§2.5), which the gateway announces. A run writes; the gateway drains, routes by the project's notify map, and stamps `sentAt`. Unsent records survive a gateway outage and an archive; sent ones are cleared at archive.

## 3. The run loop

`run <issue>` is one container, one branch, one agent session, and returns exactly one of green / parked / failed as its exit code (0 / 2 / 1).

1. Preflight: the provider's credential key is present in `.env`; the working tree is not already checked out on `agent/<id>` (one run per issue, enforced by git).
2. Create the sandbox: branch `agent/<id>` cut from the base (or reused with its commits if it exists), worktree, container from `cfg.image`, `setup` commands, the mounts.
3. Prompt: the bundled TDD prompt with the issue text substituted. The prompt tells the agent it does not decide "done", that it ends every turn with a one-line summary, and that BLOCKED-with-a-question is a correct outcome.
4. Turn: run the agent until it emits COMPLETE or BLOCKED, or the idle timeout fires. Log `turn` with the summary and session id.
5. On BLOCKED: write the parked record (`question`), log `parked`, tear the container down, exit 2.
6. On COMPLETE with no commits ahead of the base: park as `stalled` (an agent that says done and changed nothing is not green).
7. On COMPLETE: run the gates (`when`-scoped by the branch's diff; the scoping is logged). Green → log `green`, run the optional findings harvest, exit 0. Red → go to 4 with the gate report attached: on the same session for a resumable provider; as a fresh run with the report and the prior summary appended to the issue text for a non-resumable one.
8. After `maxTurns` red cycles (`config.mts`, default 6 — §9): park as `stalled` with the budget in `detail` (`budget:6`), so `detail` carries the specifics as §2.3 says.
9. On idle timeout (`idleTimeoutSeconds` in `config.mts`, default 600 — §9): park as `stalled`, `detail: idle`. On anything else thrown: log `failed`, exit 1. `answer <issue> "<text>"` re-enters step 4 on the parked session with the answer as the prompt (resumable providers), or posts the answer as an issue comment and re-enters step 3 fresh (non-resumable providers, which re-read the issue).

## 4. Planning

`campaign <selection>` turns a selection into waves before anything runs:

1. **Expand**: numeric tokens are ids; a non-numeric token is a label expanded through `listByLabel` to the open issues carrying it that are *work* — an issue whose tracker type is `Epic` (a container that owns no work, `docs/issue-conventions.md`) is never scheduled, even when it carries the label.
2. **Restrict and layer**: fetch each issue's _open_ blockers through `blockedBy`; keep only edges inside the selection; topologically layer. An issue with an open blocker outside the selection is unreachable — reported, and dropped with its dependents. A closed blocker does not gate, and neither does a `pending-verify` one: its work is already on the base (`docs/issue-conventions.md`), so it is treated as satisfied and named as such in the provenance.
3. **Partition**: resolve each issue's file-set (`fileSet`, default: the `Touches:`/`Creates:` marker line → basenames, validated against the tree); split each layer greedily so no two issues in a wave share a basename.
4. **Under-specified halt**: an issue whose file-set is not confident stops the plan and asks — drop it (and dependents) or fail so the issue can be fixed. A non-interactive run pre-decides with `--on-underspecified`.
5. Print the plan with per-issue provenance (`--dry-run` stops here); record it on `campaign-start`.

The planner is pure over injected resolvers; `prune` re-layers through it, and `graft` places with the same two invariants (after blockers, basename-disjoint) into the earliest unstarted wave.

## 5. The campaign loop

The loop runs on the checked-out base branch and refuses to start anywhere else. At every wave boundary it re-folds the log to get the remaining waves, which is how prune and graft events take effect without a mutable plan.

For each wave:

1. Log `wave-start`; notify.
2. **Drain.** Spawn a child `run` per issue as the host lease allows (§8). A park or failure frees its slot at once and never aborts a sibling. The wave is drained when every member has an outcome.
3. **Re-admit.** An answer is *delivered*, not run: `answer` writes the text into the parked record and marks it answered. While a campaign process is live, it is the campaign that re-admits the member — re-queued with the answer as its prompt, spawning when a slot frees, its earlier outcome discarded — so no second process ever runs the issue beside the campaign. With no live campaign, `answer` runs the redrive (§7), which does the same. A parked member may be re-admitted more than once; a second park is a park, not a loop. At the end of the drain, a member parked as `question` or `stalled` holds the wave open for up to `parkGraceSeconds` (`grace-wait` is logged); an answer in that window re-admits it into *this* wave, expiry falls through.
4. **Integrate** the greens (§6).
5. **Resolve.** The wave is done only when every member is `completed`, in this order:
   - any member `failed` → log `campaign-failed`, notify, exit non-zero (failure outranks a red base or a park, §2.4);
   - the merged base red → log `campaign-parked` (the wave's reason `red-base`), notify, exit non-zero;
   - any member `parked` (question, stalled, conflict) → log `campaign-parked`, notify, exit non-zero. A conflict that strands dependents in later waves is named in the notice; `--auto-prune` prunes the stranded closure instead of stopping — it decides what happens to the *dependents*, never whether the conflicted member itself holds the wave;
   - otherwise log `wave-done` and continue.
6. On the last wave: log `campaign-done`, notify, archive the run, exit zero. Every exit code is set by the campaign's outcome: zero only for `campaign-done`.

The exit is deliberate: a paused campaign holds no container budget and no state that is not on disk, so keeping a process alive to wait for a human buys latency, not correctness. The durable path (§7) is the mechanism; the grace window (`parkGraceSeconds`, §9) is an optimization on top of it — a fast answer means the wave never parked at all — and is part of this plan, not a maybe.

## 6. Integration

For a wave's greens, in order:

1. `git merge --no-ff agent/<id>` onto the base. A conflict aborts **that merge only**: the issue is parked as `conflict` with its branch, worktree and session intact, and integration continues with the next green. Merged work stays merged.
2. When all greens are merged, run every gate on the base. Red → the wave is parked as `red-base`: everything stays merged, the base sits red and is never pushed or built on, and the campaign stops. The machine never guesses a culprit — none is knowable when every branch was green alone.
3. Green → post-merge steps on the green path only: delete merged branches and worktrees, run the configured post-merge hooks (advance a tracker label; fold changelog fragments — §12 makes both optional hooks), log `merged` per issue.

## 7. Redrive

Redrive is the umbrella act of picking an unfinished campaign back up: reconcile what the log says, then continue. `answer` triggers it implicitly for a `question` or `stalled` park; `vetinari redrive` triggers it explicitly after a prune, graft, fix-forward, crash, or failure. Resume-from-here is one path through it, not a separate concept — the CLI, dashboard, notices and glossary all say _redrive_.

Reconciliation, per member of the first wave that is not fully `completed`:

| Member state | Redrive does |
| --- | --- |
| `completed` | nothing — never respawned, never re-merged |
| green but unmerged (answered park, conflict-parked green) | integrate it (§6) without an agent |
| `parked(question)` / `parked(stalled)` with an answer (record marked answered) | re-enter the run loop with the answer as the prompt |
| `parked(conflict)` after the human resolved it on the base | integrate |
| `parked(red-base)` after a fix-forward | re-gate the base — even when nothing new merges — then continue |
| `parked(crash)` | treat as unstarted if no commits, else resume the session |
| `failed` | refused — prune it or fix it first; redrive names it. `redrive --override` re-runs it instead (the only meaning `--override` has on redrive) |
| `pruned` membership | skipped |
| `unstarted` / `grafted` | run |

Then the loop continues from that wave as in §5. Redrive is idempotent against a human who answers twice or answers something a prune already removed: an answer for an issue that is not parked is reported and ignored. A redrive refuses to start while a campaign process for the project is live (the lease says so); an answer then only delivers (§5 step 3). Whichever process finishes the last wave archives the run. Crash is recognised by liveness — a campaign process that is gone with no `campaign-*` stop marker — and is reconciled to `parked(crash)` on the next read, never stored as a separate status.

## 8. Concurrency

- **`MAX_CONCURRENT_CONTAINERS`** is a property of the host: an env var or a file in the host config dir; unset resolves to a machine-derived default, never unbounded.
- **`containerShare: high | medium | low`** is a project's declared cut when projects contend: a floor of one per active project while the ceiling has a slot for each, a weighted share of the remainder, never preemptive. When more projects contend than the ceiling has slots, the heaviest are seated and the rest wait — the ceiling is never exceeded to honour the floor. A lone project fills the ceiling.
- **The lease** is a file under the host config dir that every run reads and writes directly: what each run holds, its share, and its liveness. A run takes a container only when under its share; it releases on park, finish or death (a dead holder's containers are reclaimed on contention). A busy run drains to a smaller share as turns finish rather than being killed.

The gateway is not the allocator; a gateway-spawned `answer` takes a slot like any run.

## 9. Configuration

Every item is placed by three questions — scope (host / project / run), secret or not, and whether it crosses into the container — and the answers name the file:

| Home | Holds |
| --- | --- |
| host env / host config dir | `MAX_CONCURRENT_CONTAINERS`; the registry; the lease; the host log |
| `vetinari/config.mts` (committed, no secrets) | `project`, `image`, `baseBranch`, `gates`, `setup`, `mounts`, `agent`, `maxTurns` (default 6), `idleTimeoutSeconds` (default 600), `parkGraceSeconds` (default 0), `containerShare`, `hostEnv`, `promptFile`, `branchPrefix`, `stateDir`, `setupTimeoutMs`, `toolchainProbe`, `festiveWaveNames` (cosmetic, optional); the tracker seams `fetchTask`, `blockedBy`, `listByLabel`, `fileSet`; the hooks `reportFinding`, `onIssueMerged`, `postComment`; comms `destinations`, `notify` |
| `.vetinari.local/.env` | **the container gate** — only the agent provider's credential |
| `.vetinari.local/host.env` | host-only secrets — this project's Telegram bot token and chat (per project; projects may share a bot or not) |

Invariants: the container gate is exactly one file; the gateway persists none of the project layers; `hostEnv` values are non-secret. `init` scaffolds the layout; `migrate` moves a pre-layout project once and does not accumulate shims for later renames (§13.1).

## 10. Communications

- A run never talks to Telegram. It writes an outbound record (§2.6) in one of four categories — `success`, `failure`, `progress`, `finding` — optionally with an event name (`progress:wave-start`). A question is a parked record; the gateway announces it under the `question` routing key.
- One bot per project: its `host.env` names the token; `destinations` choose chats and threads on that bot. The gateway is the one process that consumes each bot (Telegram allows one consumer per bot) and the sole sender, so any number of projects and bots share one gateway. Each tick it reads every registered project live: credentials from `host.env`, routing from the materialized `routing.json`, the outbox, the parked records. It announces new parks once (stamping `tgMessageId`), drains outboxes, and runs one poll loop per distinct bot.
- A project's `notify` map routes `category` or `category:event` to a named destination `{ chat, thread? }`, with `*` as default; with no map everything goes to the project's default chat. `question` must resolve to exactly one destination because the gateway watches it for the reply, and the park announcement goes there — not unconditionally to the default chat. A project with no credentials is skipped and its outbox simply fills.
- A reply to a question message routes by `(bot, messageId)` to the project and issue, and the gateway shells `answer` in that project's root. `/status` and `prune <issue>` (preview, then `yes`; `prune <project> <issue>` when several projects share the bot) are the only commands.
- Every notice uses one skeleton: header (`<emoji> <project> · <STATE> · <context>`), one signal line, and the exact recovery command where there is one.

## 11. Dashboard

The dashboard is a read-mostly HTTP server over the registry (no gateway needed):

- **Landing**: counters, a card per project (its card state, wave in flight, counts — an idle card shows the last run's outcome, campaign name and finish time, and opens the project page with that run first), the cross-project parked queue, a recent-events feed.
- **Project page**: the campaign's waves and issue chips; parked cards lifted to the top; archived runs listed beneath, opening read-only.
- **Issue sheet**: state and reason, elapsed, the turn log (the agent's one-line summaries), and exactly the issue-level moves the reason allows: reply (question/stalled) and prune. Each action POSTs to a route that shells the CLI verb in the project root; nothing is decided in the server.
- **Campaign controls** live on the project page, never on an issue: **graft** while the campaign is unsettled, and **redrive** — a risky, whole-campaign action — rendered greyed-out with the reason unless it is safe (the campaign is stopped: `campaign-parked`, `campaign-failed` or crashed, and no campaign process for the project holds the lease) and confirmed in a dialog before it POSTs.
- **Live tail**: per-agent activity projected from the agent's run stream, live-only.
- **Terminal output** (the CLI's own view): human-readable lines only — plan, wave progress, stop reason, resume command. JSONL goes to the log file and to `--json`; it is never the default screen output.
- **Live updates**: the server watches each project's logs directory and pushes SSE; the client patches in place. State → visual mapping is a set of pure reducers with node tests; colour follows state by one rule set (appendix A). Nothing animates except the running dot and the live indicator.

## 12. Surface inventory — core, optional, and not ours

The user guide names three properties as the value. This table sorts every current surface by whether it serves them. "Optional" means it stays, off by default or out of the primary docs; "retire" means the design asks for its removal; "hook" means it becomes a config seam rather than built-in behaviour.

| Surface | Verdict | Reason |
| --- | --- | --- |
| `init`, `build`, `baseline`, `run`, `answer`, `campaign`, `redrive`, `prune <issue>`, `graft`, `parked`, `clear` | **core** | the loop and the five moves |
| `gateway` (+ `install/status/start/stop/restart`), `tg-test`, `status` | **core** | where the user sees and answers things |
| `campaign --dry-run`, `--name`, `--on-underspecified` | core | planning is the safety net |
| `--auto-prune` | optional | a policy flag on one park reason |
| `campaign --override` (hand-typed waves, invariants skipped) | optional, advanced | an escape hatch; out of the guide |
| `prune <issue> <batch…>` (launch a fresh reduced campaign) | **retire** | a second meaning on one verb; `campaign --dry-run` + editing the selection covers it |
| `fileset-check` | **retire** as a mode | `campaign --dry-run` already reports NOT-confident issues; keep the function for the sweep skill |
| Festive wave names (`festiveWaveNames`, cookie, host cursor, `festiveOffset` on the event) | **optional**, rework and remove bugs | cosmetics that reached the durable log and the host lease |
| `demo create/remove` | **retire** as CLI modes | a dev fixture; becomes `make demo-create` / `make demo-remove` calling the same `demo.ts` functions — out of `--help` and the Modes table |
| `host log` | optional | diagnostics; reference only |
| `registry remove`, `tidy` | optional | reconciliation tools; reference only |
| `statusline`, `statusline install/uninstall` | optional | an editor integration; its own doc |
| `changelog collect` + fragment fold at merge | **core** | the merge-conflict fix for a shared changelog: agents write `changelog.d/<id>.md`, the integrator folds a wave's fragments in one commit; enabled when the project has a `CHANGELOG.md`. The separate section-lint and its shell tests are what can go |
| `onIssueMerged` (label hop), `reportFinding` (harvest), `postComment` | hook (as today) | tracker workflow stays behind seams |
| Agent providers: `claude`, `pi`, `codex` | core seam | resumable; park → answer works |
| Providers `copilot`, `cursor`, `opencode` | optional, **experimental** | non-resumable; a park cannot be answered without `postComment`; out of the guide until the loop is whole |
| Telegram `destinations`/`notify` routing | optional | the one-chat default is the documented path; routing is reference |
| Live tail / activity stream | core | answers "what is it doing right now" — the question every operator asks first; live-only |
| Archived runs | core | "come back and see what happened" |
| `.out-of-scope/` decisions | fold into the non-goals here | decisions belong in one place |

## 13. Consolidation this design asks for

### 13.1 One vocabulary, then stop renaming

The codebase carries every layer of its own history: `carve`→`prune`, `campaign-plan`→`campaign --dry-run`, `queue` (removed as a mode, kept as an event prefix), `dispatch`/`attend`→`gateway`, `QUEUE_SLOTS`→`MAX_CONCURRENT_CONTAINERS`, `hostWeight`→`containerShare`, `orchestrator.env`→`host.env`, `batch` (events) vs `wave` (everything else), `quarantined`/`wave-parked`/`interrupted`→`parked`+reason, `resume` vs `redrive` — and three different park-reason enums (`blocked | budget | idle-timeout | no-commit` on the record, `question | conflict | red-base | stalled` in the reducer, `question | conflict | red-base | crash` in the glossary). The README still explains quarantine and wave-parks in the retired words; the specs are written in `carve`; `migrate` knows six renames.

The ask: adopt the user guide's words everywhere — **wave, parked + one reason enum, failed, completed, prune, graft, redrive** — in one pass across code, log, dashboard, notices, glossary and docs, with a single alias table in the log reader for archived logs. Then treat a rename as a breaking change that needs a stated user-facing benefit, and stop adding compatibility shims to `migrate`.

### 13.2 One event schema

Rename the events to §2.1's set (`campaign-batch`→`wave-start`, `queue-*`→`spawn`, the three `wave-parked` sites and the `quarantined` event→`parked` with a reason, an explicit `failed`, `campaign-parked`/`campaign-failed` as the two stop markers). Record `name` and `titles` once on `campaign-start` and drop them from every wave event. Remove `festiveOffset`. Retire the `quarantined` and `wave-parked` events.

### 13.3 One documentation set

Today the current design is spread over the README (5.7k words, half of it a modes table and operating prose), a 60-term glossary that includes dashboard widgets, seven guides, twenty ADRs that amend each other in chains (0013 → 0017 → 0019 → 0020), ten dated specs in retired vocabulary, two out-of-scope notes, a normative colour spec, and design rules recorded only in issue comments. A reader who wants "the current rule for what stops a wave" must read four ADRs and an issue.

After consolidation:

| Document | Role | Rule |
| --- | --- | --- |
| `README.md` | the pitch and the first hour: what it is, quickstart, pointers | ≤ 1,500 words; no modes table |
| `docs/user-guide.md` | the operator's model (this design's source) | the words here are the vocabulary |
| `docs/design.md` | this document — current implementation truth | updated in the same change as a behaviour change |
| `docs/reference.md` | CLI modes (generated from `help.ts`), config fields, files on disk, env vars, event kinds, Telegram routing | the only exhaustive list; the README/help drift test points here |
| `docs/operations.md` | gateway as a service, upgrading, status line, tidy | the "how do I run it on a host" material from `gateway.md`, `upgrading.md`, `statusline.md` |
| `CONTEXT.md` | glossary of _domain_ terms only | terms that appear in the user guide; no UI widgets, no retired entries, no testing terms |
| `docs/adr/` | history: why a decision was taken | frozen; a superseded ADR gets a one-line pointer to the design section; a new ADR only for a genuinely new decision, and the design doc changes in the same commit |
| `docs/specs/` | build-time artifacts | moved under `docs/archive/`; not linked from current docs |
| `docs/issue-conventions.md`, `docs/changelog-conventions.md`, `CLAUDE.md` | process for working on this repo | unchanged in role; retired names fixed |
| `docs/dashboard-color-rules.md` | appendix A of this document | shortened to the palette, the edge rule and the precedence |
| `.out-of-scope/` | folded into §14 | removed |

### 13.4 Depth before breadth

Two weeks of commits added six agent providers, festive names, a demo fixture, a host log viewer, a status-line wrapper, a changelog subsystem with its own lint and shell tests, three dashboard log views and a normative colour spec — while the core promise has an open hole: an answered question does not rejoin its campaign, a failed issue does not hold its wave, and a resume steps over the wave it parked in (§15). The design's ordering is: the loop in §3–§7 is correct end to end and integration-tested through the local sandbox before any surface in §12 marked optional grows.

## 14. Non-goals

- Pushing to a remote, opening pull requests, or acting as a merge queue.
- Reviewing code. Green is the gate; review is a human's.
- Owning issue state. The tracker is the source of truth; vetinari reads it and, via hooks, may advance a label.
- Guessing. No culprit for a red base, no silent drop of an under-specified issue, no auto-answer, no un-parking without a human move.
- A quarantine verb. A conflict is resolved on the base by a human and picked up by a redrive; there is no "release" or "retry the merge" command.
- Making `host log`'s two outputs agree on order: humans get newest-first (no scrolling to the latest); `--json` is chronological for jq/tail. That difference is intended.
- Retention of archives, killing in-flight containers on prune, reverting merged work.

Deferred — wanted, not now:

- A bake-off harness across providers.

## 15. Where the implementation diverges today

Described by behaviour; the tracker holds the numbers (`gh issue list --label campaign:audit`). Audited 2026-08-30 against every claim in §2–§11; what is not listed here was verified to hold.

**Verdicts and exits**

- `campaign` and `redrive` exit zero whatever happened; only `run` and `answer` set a code, and `run` reports parked and failed as the same code.
- A run that throws logs no `failed`; the event exists only when a campaign parent infers it from the child's exit.
- A standalone `run` or an `answer` takes no host slot, so the ceiling and the crash-liveness probe see only campaign children; `answer` also skips the credential preflight. The sandbox cuts a new branch from `HEAD`, not `baseBranch`, and there is no one-run-per-issue preflight — git errors raw.

**Redrive and resolve**

- An answer runs the loop itself and then redrives, instead of delivering to the record; so a live campaign's re-admit fires only after that run goes green (respawning a green issue), the redrive's own rerun carries no answer, and a second campaign process can start over a live one. The answer path never archives a finished run.
- `answer` on an unparked issue throws instead of reporting.

**Records and states**

- A conflict park writes no parked record; archive clears every parked record; the wave boundary clears held members' records — all against §2.5.
- An unmerged green reads `completed` (and counts as merged today) instead of `running` with a pending green.
- The state words in code are `failure` and `closed` where this design says `failed` and `completed`; the issue sheet's move rule keys on `failed` while the API ships `failure`, so a failed issue's sheet offers no moves.
- The idle card has no last-run line when the finished campaign is still in the live log; the sheet never prints the park reason as a word.

**Comms**

- Notices still say `WAVE-PARKED`, `QUARANTINE-PAUSED`, `BATCH` in their text and give `campaign --resume` as the recovery command; the outbound `event` names (the `notify` routing keys) are the settled §2.1 words, but the notice *wording* has not caught up and notices do not share one skeleton.

**Vocabulary that stopped short**

- `--help` blurbs (and so `docs/reference.md`) still say campaign-plan, queue, wave-parked, quarantine; `templates/config.mts` ships `campaign --resume` and `carve` into every new project; `init`'s next-steps names one provider's key regardless of `agent`; `quarantined`/`waveParked` remain live identifiers; the `/fileset` skill calls the removed `fileset-check`; the triage skill points at the removed `.out-of-scope/`.
- Two dashboard pages hand-author colours outside the palette and put the prune coral on the 3px edge; three elements pulse.

---

## Appendix A — dashboard colour rules

Six states, one action, one accent; colour is always derived from state, never authored per element (`stateColor` and the one palette in `src/dashboard-assets.ts`, the `cardState` roll-up in `src/dashboard-model.ts`, the pure reducers in `src/dashboard-visual-state.ts`).

**The palette.** Every colour that carries meaning is one of these.

| State          | Hex       | Note                                               |
| -------------- | --------- | -------------------------------------------------- |
| running        | `#6cb6ff` | blue; dot pulses while work is in flight           |
| parked         | `#c8a24e` | amber; the only colour a "needs you" left edge takes |
| failed         | `#f85149` | red (Primer `danger.fg`); distinct from the prune action's red |
| unstarted      | `#5f6b78` | grey; also `idle`                                  |
| completed      | `#3fb984` | green                                              |
| pruned (badge) | `#a371f7` | purple; membership, not lifecycle                  |
| prune action   | `#f79287` | coral; a control, never a state                    |
| accent         | `#3fb9b0` | teal; buttons, links, focus — never a state        |

Neutral surfaces carry no meaning: card fill `#10151b`, panel/chip fill `#0b0e12`.

**The edge rule.** A card carries state on exactly one edge — the 2px top edge for "this has a state", the 3px left edge (always amber `#c8a24e`) for "this needs you", the full 1px outline for a chip or a confirmation. Never two coloured edges, never a coloured bottom or right border.

**The precedence.** When a card could claim two states its colour is the §2.4 roll-up fold — `failed > parked > running > completed > unstarted` — the most human-blocking state wins.
