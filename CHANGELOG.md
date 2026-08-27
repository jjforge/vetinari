# Changelog

_**v0.1.0** — August 16, 2026: the first tagged release. Every change since is
grouped into a dated `### <what changed> — <date>` milestone below, newest first;
a future tagged release will fold the milestones above it under a `### vX.Y.Z`
heading._

**Reading this file.** Every change that ships is logged, internal work included,
and each entry opens with a tag saying who it reaches:

| Tag | Visible to |
| --- | --- |
| `[user]` | someone **using** Vetinari — the CLI and its output, the status line, the dashboard, observable behaviour |
| `[ops]` | someone **running** it — config surface, env vars, `migrate`, the host gateway, systemd |
| `[api]` | a **programmatic contract** — exported functions, the event-log schema, the dashboard's HTTP/JSON endpoints |
| `[internal]` | nothing externally observable — refactors, tests, docs, plumbing |

`**Breaking changes:**` sorts first in a milestone and names the contract it broke.
Within a milestone each bold section label appears at most once.

### Collected changes — August 27, 2026

**Breaking changes:**
- [api] Removed the process-global event-log target and the free `log()`: `src/log.ts` no longer exports `setLogFile`, `defaultLogFile`, `logFilePath`, or the module-global `log()`, and `index.ts` drops the `log`/`setLogFile` re-exports (exporting the `Logger` type and its `loggerForRun`/`hostLogger`/`hostLogTarget`/`memoryLogger` factories instead). Every event now emits through an injected `Logger` constructed with an explicit target — there is no default path and no way to emit without one, so the shared-global footgun class is structurally gone. The gateway daemon, the last global caller, now threads `hostLogger()` (#162).

**New features:**
- [user] `campaign --auto-carve` prunes a merge-conflict quarantine's stranded dependents and runs on; without it, a quarantine that orphans dependents in later waves pauses the campaign at the wave boundary for a human (ADR 0013) (#146).
- [ops] A quarantine-pause and an auto-carve each announce over Telegram — the pause on the alert channel (quarantined issue → orphaned dependents, and the two recovery moves), the carve on the progress channel (what it pruned) (#146).
- [user] `campaign --resume` continues a paused campaign on the current base (#144) — after a human fixes a wave-park forward or carves a suspect, it reconstructs the plan from the event log (no external state file) and runs the unrun waves, redoing no already-merged issue; a resume with nothing left to run reports so and exits clean.
- [user] The dashboard now renders the two non-atomic wave-integration states (#148): a merge-conflict `quarantined` issue reads as an attention-class chip whose detail is "resolve the conflict", and a red merged base shows its wave as `wave-parked` — a run-level held state distinct from an issue `parked`. Both use the existing attention (amber) status colour and render identically on live and archived runs.
- [ops] `vetinari tidy [--apply] [--all]` reconciles the drift a by-hand fix-forward or merge leaks (ADR 0013): folds orphaned `changelog.d/` fragments whose issue is merged, GCs `agent/<id>` branches and worktrees that are provably reachable from the base, and clears parked records for issues now merged. It never touches an unmerged, quarantined, parked, or wave-parked branch. Dry-run by default; `--apply` acts and `--all` sweeps every registered project (#147).
- [api] Added an injected `Logger` value alongside the global `log()`: `loggerForRun(cfg)` (event log at `cfg.logFile`, with console echo), `hostLogger()` (host-bound temp path via `hostLogTarget()`), and a silent `memoryLogger()` exposing captured `.events`; `ResolvedConfig` now carries `log`, bound to `loggerForRun` in `loadConfig` (#159).
- [user] `vetinari registry remove <name>` removes one project's pointer from the host registry so the dashboard stops listing it — the explicit counterpart to the auto-register every run performs (not container slots). A name that is not registered is a clean no-op (#163).
- [user] `tidy --all` now drops provably-dead duplicate registry pointers — when two pointers resolve to one `projectRoot`, the non-canonical one is removed and the canonical `<projectRoot>/.vetinari.local` one kept, so the dashboard stops rendering the same repo twice; ambiguous groups (no canonical base, or more than one) are left for the human, and it is dry-run by default (`--apply` acts) (#164).
- [user] `vetinari graft <ids…>` (#166) — the additive mirror of `carve` (ADR 0014): add issues to a running (or paused/wave-parked/resumable) campaign. Appends a graft event the wave-loop re-derives from, so the in-flight wave finishes untouched and the added issues re-layer into future waves (after their in-campaign blockers, basename-disjoint), leaving already-planned waves stable. Validates all-or-nothing — an unknown/closed id, or one already in the campaign, rejects the whole graft naming the offenders — and `--dry-run` prints the placement without appending. Emits a routable `progress:graft` message.
- [user] A grafted issue renders as the transient `grafted` status in the dashboard/status output (shown while it waits in a later wave, becoming `running` on pickup) and the activity feed narrates a graft (#166).
- [ops] `vetinari host log` reads the persistent host log (`<gatewayConfigDir>/logs/host.jsonl`) at the terminal — the host/gateway diagnostics that were write-only until now (#169). Prints the most recent events newest-first, one human-readable line each; `-n <count>` bounds the window (default 50), `--json` passes the raw JSONL through untouched for `jq`/`grep`, and `--tail` (or `-f`) follows live. Reads the file directly off disk, so no daemon need be running; a missing `host.jsonl` prints "no host log yet" and exits clean.
- [ops] `/fileset` skill — a pre-campaign pass that fills in missing file-set markers: it sweeps open `ready-for-agent` issues (or the ids you name), infers each ticket's `Touches:`/`Creates:` marker from the ticket and the tree, and writes it back after you confirm (#173).
- [internal] Each running agent now produces a live-appended `activity-<taskId>.jsonl` under the run's logs dir — a structured, per-tool-use record projected from the run stream and merged with the loop's own `turn`/`gate`/`gate-result`/`commit` events — as the data source the live-tail pane will tail. The shared `OrchestratorEvent` union gains `tool`, `sandbox-exec`, and `commit` members, and `gate`/`gate-result` now carry `taskId`. No user-facing surface yet (#124 renders it) (#182).
- [user] The repo/campaign page now has a collapsible **Live tail · agent logs** pane between the wave cards and the archived runs, shown only when the repo has a running agent. It merges every running agent's raw activity JSONL into one issue-keyed, following stream over the existing `/api/events` SSE (no whole-page refetch), with an all-agents/per-issue dropdown, a case-insensitive line filter, play/pause with a "↓ N new lines" backlog bar, save-visible-to-`.jsonl`, and clear-this-repo (#124).
- [api] Add the `githubFetchTask("owner/repo")` config resolver — a `fetchTask` over `gh issue view` that fixes the correct `--json` field set (including `state`/`closedAt`) in one place so a config can't silently re-drop it (#175).

**Improvements:**
- [ops] Campaign wave integration now wave-parks instead of halting when the merged base gates red (every issue green alone, the combined base red together): the wave's greens stay merged on the base — no more `reset --hard` un-merging the wave — an attention notification is sent, and the campaign pauses for a human to fix forward or carve a suspect. The machine names no culprit, because none is knowable. A red base folds no changelog fragments and applies no `pending-verify` labels for that wave — those wait until it is resolved green (#143).
- [api] `integrateGreens` returns `parked` (replacing `halt`) on a red merged base, and a new `wave-parked` event records the greens left merged and the tail of the gate report (#143).
- [ops] The host gateway/status daemon now logs to a persistent `<gateway config dir>/logs/host.jsonl`, created on first write and appended across restarts, instead of a per-pid temp file lost on restart (#157).
- [api] The host/registry-layer event emitters now take an explicit `Logger` (defaulting to `hostLogger()`) instead of the process-global `log()`: `autoRegister`/`readProject`/`readProjects` (registry), `tgSend` (telegram), and the status readers `buildAllStatus`/`buildFeed`/`buildLanding`/`listArchivedRuns`. A caller — or a test — can now hand a `memoryLogger()` and capture the `status-*-skipped`, `registry-*`, and `telegram-send-failed` diagnostics instead of them landing on the shared global. The CLI hands `hostLogger()` to registration and logs run-family events (`archived`, `carve`) via `cfg.log` (#161).
- [ops] The TDD prompt now directs each agent to read the whole ticket — full body and every comment — and names the body and comments as authoritative for acceptance criteria and design intent, so an agent no longer implements from the title alone (#158).
- [internal] The run-family event emitters (`park`, the gate, merge, the TDD loop, `campaign`/`queue`, sandbox) now emit through the injected `cfg.log` rather than the process-global `log()` — the write-side threading between the injected `Logger` landing (#159) and the global's removal (#162) (#160).
- [internal] Added a Docker-free test harness that drives the campaign wave-loop end-to-end: a fake run-spawner lets a test exercise a ≥2-wave campaign — including the per-wave `reduceCampaign` re-derive surviving a child that archives the parent log — with no containers, tokens, or real issues, pinning the #150 regression class in CI (#151).
- [ops] `campaign-plan` now resolves a ticket's file-set from an anchored `Touches:`/`Files:`/`Creates:` marker line in its **comments** when the title+body carry none — so a marker placed in the agent-brief comment (our convention) no longer has to be hand-copied into the body. A body/title marker still wins, and a filename in ordinary comment prose is still ignored (#173).
- [user] Campaign and queue event lines in the dashboard and cross-project feed now name their run and render the counts they carry: waves read `Campaign “X” — Wave 2 — cache eviction started` / `…merged #hashes`, a finished campaign reads `Campaign “X” complete (3 waves)`, a halt reads `Campaign “X” halted at Wave 2: <reason>`, and queue lines read `Queue started — 4 tasks` / `Queue drained — 3 merged, 1 parked` (#174).
- [ops] The `wave-start` and `wave-merged` Telegram operator notes now carry the campaign name, and a resumed campaign recovers its name from the log so its waves are no longer anonymous (#174).

**Bug fixes:**
- [ops] The event log no longer defaults to a real project path, so the test suite (or any un-redirected `log()`) can't pollute a project's live `.vetinari.local/logs/orchestrator.jsonl`. Tests that emit events — e.g. `park()` — without first calling `setLogFile` were appending to the real log of whatever cwd they ran in, so the dashboard's event feed showed phantom `parked` entries and foreign-project events that no run actually produced. `log.ts` now defaults to an isolated per-process temp file until an entrypoint (the CLI) sets the real target explicitly (#154).
- [user] The dashboard's archived-runs list no longer shows a finished run as `running` (#152). An interrupted archived log (a crash, a kill/OOM) ends with no terminal event, so its in-flight wave and issues are now reconciled to a terminal `interrupted` state on the archived read boundary; the live run keeps deriving `running` as before.
- [user] The dashboard's archived-run detail no longer overlaps on phone-width screens (#153): at ≤640px the campaign/raw toggle and the raw-log pane are dropped, so only the campaign (wave) view shows — a run deep-linked in raw mode falls back to it.
- [ops] `migrate` now refuses to write a host gateway systemd unit whose `ExecStart` was resolved from a test-runner process (a `*.test.*` entrypoint or node `--test` flags), and the migrate tests sandbox the systemd-unit and gateway-config paths — so running the test suite can no longer clobber the real `~/.config/systemd/user/vetinari-gateway.service` and crash-loop the host gateway (#165).
- [user] `graft <closed-id>` now rejects a closed issue whole (naming it) instead of silently placing it in a wave — the `gh`-backed task resolver now fetches issue `state`/`closedAt`, which the shipped config previously omitted (#175).

**Documentation:**
- [user] The README **Modes** table and `vetinari --help` now derive their mode list from one shared source (`src/help.ts`), and a doc test fails the gate if the README table and the CLI's modes diverge — so the table an agent reads in its worktree can no longer drift behind `--help`. Re-synced the table in the process: added the missing `changelog collect` row, split the combined `statusline install`/`statusline uninstall` entry, and folded `--auto-carve` into the `campaign` signature (#167).

### Multi-wave campaigns run every wave again — August 26, 2026

**Bug fixes:**
- [ops] A multi-wave `campaign` no longer stops after wave 0 and falsely reports complete. A child `run` spawned by a queue/campaign shares the project state dir, and its start-of-run leftover-archive (#141) was archiving the parent campaign's own in-flight log — so `reduceCampaign` re-derived an empty plan at the next wave boundary and the loop ended. Children are now marked (`VETINARI_CHILD`) and skip leftover-archiving; only a top-level run/queue/campaign archives a genuine leftover (#150).

### Changelog fragments hand authorship to the orchestrator — August 26, 2026

**Breaking changes:**
- [ops] The static `systemd/vetinari-gateway.service` file is removed — a committed unit could only carry the crash-looping `bash -lc 'exec vetinari gateway'` `ExecStart`, so `install -Dm644 systemd/vetinari-gateway.service …` no longer works. Use `vetinari gateway install` instead (#133).
- [user] `carve <issue>` now **preserves** the carved issue's parked record (branch/worktree/session) instead of clearing it, so the work stays resumable; pass `--purge` for the old drop-everything behaviour (#145).

**New features:**
- [user] Campaign agents write their changelog entry to `changelog.d/<task-id>.md`
  instead of editing the shared `CHANGELOG.md`, and a new `vetinari changelog collect`
  command folds a wave's fragments into `CHANGELOG.md` under today's milestone — grouped
  by section, one block per label, newest milestone first — then deletes the consumed
  fragments (#123). This decouples changelog authorship from the one file every co-wave
  ticket used to touch, so their branches no longer conflict on it and halt the campaign.
  `--title` names a fresh milestone (default "Collected changes").
- [ops] The campaign orchestrator collects each wave's changelog fragments into
  `CHANGELOG.md` in one commit at merge, on the green path only — after the wave's greens
  are merged and the merged base is verified (#123). A halted wave leaves its fragments in
  place for the retry.
- [user] The orchestrator now labels each merged issue `pending-verify` (dropping `ready-for-agent`) the moment a campaign wave's local merge and merged-base gate pass, via a config-provided `onIssueMerged` seam (`githubMarkPendingVerify("owner/repo")` ships for GitHub). Best-effort and a no-op when unconfigured — the core names no labels (#103).
- [user] Tickets can declare files they create with a `Creates:` marker line (peer of `Touches:`/`Files:`); its cites feed wave-disjointness but are exempt from the tree-presence check, so a new-file-only tracer-bullet ticket is now schedulable by `campaign-plan` (#114).
- [ops] `vetinari gateway install [--dry-run]` writes the host-level systemd unit to `~/.config/systemd/user/vetinari-gateway.service` with a fully absolute `node` + tsx-loader + CLI `ExecStart` resolved for this host — no `bash -lc`, `env`, `npx`, or `PATH` dependency. Re-run after a node/tsx upgrade, which re-pins the baked paths (#133).
- [ops] The dogfood config wires `onIssueMerged: githubMarkPendingVerify("jjforge/vetinari")`, so a campaign now auto-labels each merged issue `ready-for-agent` → `pending-verify` once the merged-base gate passes — the first hop of merge→pending-verify→close, previously a manual step (#103).
- [user] `carve --purge <issue>` is the rare true-drop that clears the carved issue's parked record and its resumable session (#145).

**Improvements:**
- [user] `vetinari init`'s next steps now name `.vetinari.local/.env` and the `CLAUDE_CODE_OAUTH_TOKEN` key, so a new project is told where the agent credential lives — the first real `run` no longer fails as the first mention of it (#138).
- [user] The cross-project event log now shows on phone-width screens (≤640px, e.g. iOS Safari) — it renders under the cards instead of being hidden (#125).
- [ops] Campaign wave integration is now non-atomic on a merge conflict: the conflicting green is quarantined (its branch, worktree, and agent session kept intact so it is resumable) while the greens already merged this wave stay on the base and the wave continues — no more `reset --hard` un-merging the whole wave and halting the campaign (#142).
- [internal] `integrateGreens` returns a `quarantined` set and aborts only the conflicting merge; a new `quarantined` event records the held issue and its branch (#142).

**Bug fixes:**
- [ops] Gateway now logs and stamps `destination: "default"` for an outbound record delivered to a project's default chat with no notify mapping, instead of the misleading `destination: undefined` (#106).
- [user] Dashboard raw-log pane now caps its render (500 rows) with a "show more" control and a "showing X of Y lines" footer, so a many-thousand-line orchestrator log keeps a bounded DOM instead of OOM-crashing a memory-constrained tab; deep links to a line past the cap still reach it (#127).
- [user] `statusline install` no longer writes a shadowed entry when a `statusLine` is set in the higher-precedence `.claude/settings.local.json`; it warns (naming that layer) and skips the inert write, and `uninstall` warns symmetrically (#136).
- [ops] The gateway systemd unit no longer crash-loops (`status=127`, `exec: vetinari: not found`) on hosts where a `.bashrc`-hooked node manager (nvm/fnm/mise/asdf) keeps node off systemd's clean `PATH`. Both `gateway install` and `migrate` now bake a PATH-independent absolute launch chain in place of the `bash -lc` `ExecStart` — a non-interactive login shell that never sources `~/.bashrc` (#133).
- [user] `tg-test` now resolves Telegram credentials from the project's `host.env` the same way the gateway does — never from the invoking shell's exported env — so a green `tg-test` guarantees the gateway can actually send. When the creds are missing, the error now names `<baseLocation>/host.env` instead of misdirecting to "the orchestrator's environment" (#117).
- [user] Starting `campaign` or `queue` for a project whose `host.env` resolves no Telegram connection now warns on stderr (naming the `host.env` to fix) and records a `telegram-unconfigured` event the dashboard narrates, so an un-notifiable project — whose parked questions would otherwise wait forever with no ping — is visible instead of silent; the run continues (#116).
- [ops] The activity feed shows exactly one `issue.merged` row per merged issue again — outbound messages were being persisted as spurious `green` events because a payload `event` key clobbered the log kind (#140).
- [internal] `log()` now stamps the event kind last, so a caller's `data.event` key can never override it (#140).
- [ops] Every completed campaign run — halted/failed as well as clean — now enters the archived-runs list, each as its own run with its terminal state; archiving is no longer gated on a clean outcome, only a still-parked run stays live to inspect (#141).
- [ops] Starting a new `campaign`/`queue`/`run` first archives any prior run left in the live log (from a crash or kill that bypassed the end-of-run archive), so it can never be concatenated ahead of the new run and buried by the summary fold (#141).

### The status line installs itself and wraps an existing one — August 25, 2026

**New features:**
- [user] `vetinari statusline install` / `statusline uninstall` (#134) — wire the status
  line into the project's committed `.claude/settings.json` without clobbering one
  already configured there. Install keeps an existing status line as line 1 and adds
  the 🏰 campaign line under it (base64-encoding the wrapped command into a
  `--base-b64` suffix that `vetinari statusline` runs for line 1, falling back to
  Vetinari's own context line when it produces nothing); uninstall restores the
  wrapped line exactly, or drops `statusLine` when Vetinari wrapped nothing. Idempotent
  and non-mutating; `--run-command` sets how the CLI is invoked (default
  `npx vetinari statusline`), `--dry-run` prints the plan and writes nothing.

**Bug fixes:**
- [user] `statusline install` no longer blanks the colours on line 1 when a status line is
  configured at the user level (#135). It only inspected the project
  `.claude/settings.json`; a status line in `~/.claude/settings.json` (which the
  project write shadows) was replaced by Vetinari's plain, uncoloured line. Install now
  wraps the inherited user-level line as line 1 when the project has none of its own,
  so it renders as configured (colours and all) with the 🏰 line under it; uninstall
  drops the project `statusLine` in that case, restoring the original inheritance.
  (A `statusLine` in the higher-precedence `settings.local.json` is still not accounted
  for — see #136.)

### The agent image builds from one command — August 25, 2026

**New features:**
- [user] A `vetinari build` mode (#126) that builds the agent image the run modes use —
  `cfg.image` from `vetinari/Dockerfile`, neither repeated on the CLI — by shelling
  sandcastle's `docker build-image`, then runs `baseline` on success. `--no-baseline`
  builds only. A build failure exits non-zero with sandcastle's output visible and
  skips the probe; a red baseline exits non-zero too.

### Concurrency becomes a host ceiling and a per-project share — August 25, 2026

**Breaking changes:**
- [ops] Removed the per-run parallelism cap `QUEUE_SLOTS` (#121, ADR 0011). Effective
  concurrency is now the project's fair share of `MAX_CONCURRENT_CONTAINERS` alone —
  a lone project fills the ceiling. This also removes the bug where a gateway-spawned
  `carve` child inherited `QUEUE_SLOTS` from the host environment: `carve` is now just
  another run, bounded only by the ceiling and its `containerShare`. `queue`/`campaign`
  no longer read `QUEUE_SLOTS` from the environment.
- [ops] Reworked the concurrency config surface into two named concepts (#121, ADR 0011):
  the host ceiling is `MAX_CONCURRENT_CONTAINERS` (env or a `max-concurrent-containers`
  file), replacing `VETINARI_HOST_SLOTS`/`host-slots`; a project's cut is the tier
  `containerShare: "high" | "medium" | "low"` (default `"medium"`), replacing the raw
  numeric `hostWeight`. `migrate` carries the renames: it translates a numeric
  `hostWeight` to the nearest tier in `vetinari/config.mts`, and renames an existing
  `host-slots` ceiling file to `max-concurrent-containers`.

**New features:**
- [ops] A **host container ceiling** (#87, #121, ADR 0010 + ADR 0011): a host-side cap on
  live containers across every project, honoured by a cooperative filesystem lease
  each `campaign`/`queue` run reads and writes directly under
  `<gatewayConfigDir()>/slots/` — the gateway never allocates. Set it with the
  `MAX_CONCURRENT_CONTAINERS` env var or a `<gatewayConfigDir()>/max-concurrent-containers`
  file; **unset, it resolves to a machine-derived default** (CPU count less one,
  never below one) rather than "unbounded", so a lone project fills the ceiling
  without swamping the host. A run takes a slot only when its project is under its
  current **fair share** — a floor of one slot per active project plus a
  weight-proportional cut of the remainder — so a busy project drains to its share
  as a new project becomes active, with no preemption, and a crashed run's slots
  are reclaimed on contention so the ceiling is never wedged. A project declares its
  cut with the named tier `containerShare: "high" | "medium" | "low"` (default
  `"medium"`, mapping to internal fair-share weights ~7:2:1) in `vetinari/config.mts`.

### The configuration-layers model, and the drift and leaks it exposed — August 25, 2026

**Breaking changes:**
- [ops] Renamed the host-side secrets file `.vetinari.local/orchestrator.env` →
  `.vetinari.local/host.env` (#122, ADR 0011), naming it by container-reach: `host.env`
  stays host-side (the Telegram bot token + chat, read by the orchestrator process and
  live by the gateway), while `.env` is the container gate. The gateway and orchestrator
  now read Telegram creds from `host.env`, and `migrate` renames an existing
  `orchestrator.env` (whether still under `.sandcastle/` or already under
  `.vetinari.local/`) to `host.env`. The container-secrets file keeps its
  sandcastle-imposed name `.env`.
- [ops] Removed the `orchestrator.env`→`gateway.env` fold and the host-level `gateway.env`
  itself (#119). The gateway holds no secrets of its own (ADR 0002) — it reads each
  project's credentials live from the base location — so folding project tokens up
  into one host-level file was wrong and blocked two projects with different bots
  (it refused a second project's differing token as a "conflict"). `migrate` now
  deletes any stale `gateway.env` and rewrites the systemd unit without the
  `source …/gateway.env` line; the shipped `systemd/vetinari-gateway.service` no
  longer sources it.

**Bug fixes:**
- [ops] `migrate` now **strips `VETINARI_TELEGRAM_*` from the container gate `.vetinari.local/.env`**
  (#118, ADR 0011). Sandcastle injects every key of `.env` into every agent container, so a
  bot token declared there rode into each container — contradicting `src/telegram.ts`'s
  contract and the ADR 0011 container-boundary invariant. Whether the `.env` is still under
  the legacy `.sandcastle/` (stripped as it moves) or already under `.vetinari.local/`
  (stripped in place), the host-side Telegram secrets are removed while the in-container
  agent's own token (`CLAUDE_CODE_OAUTH_TOKEN`) and everything else is left verbatim;
  host-side sending is unaffected (creds are read from `host.env`). `migrate` warns which
  keys it stripped and that **any exposed bot token should be rotated**. Idempotent — a
  `.env` already free of them plans nothing.
- [ops] The gateway's **inbound poll loops are now re-derived live** instead of fixed at
  startup (#120), matching the outbound side's per-tick live read (ADR 0011). A
  supervisor reconciles the running loops against the current poll targets each
  reconcile interval: a project that **rotates its bot token** starts being polled
  on the new token (and the dead one is torn down) so inbound replies keep
  arriving, and a project that **registers a brand-new bot** begins being polled —
  both **without a gateway restart**, where before either stalled inbound replies
  until the daemon was restarted. A token that persists keeps its one loop and its
  update offset; sends triggered inside a loop ride the freshly-read connection.

**Documentation:**
- [internal] Recorded the **configuration-layers model** (ADR 0011): every config item is placed
  by scope × secrecy × container-reach; the container gate is exactly
  `.vetinari.local/.env`; and the gateway persists no secrets. The drift/leak follow-ups
  it exposed are the fixes and renames in this milestone (#118, #119, #120, #121, #122).

### The live dashboard stops over-refreshing — August 25, 2026

**Bug fixes:**
- [user] The live dashboard no longer refreshes on **every** appended log line (#131, ADR 0008).
  `GET /api/events` now **filters then debounces** before pushing an SSE frame: appended
  events are dropped through a fail-open denylist of machine-noise kinds (`telegram-send-failed`,
  `outbound-enqueued`) that change no rendered view, and the survivors are coalesced per
  project into one frame per ~300ms window. A burst of appends yields one refresh, not N;
  a pure-noise append yields none; a real state change still reaches the client within a
  window. The per-repo page also stopped doing a full `location.reload()` per frame — it
  soft re-fetches its own HTML and swaps only its `#live-region` (parked cards, campaign
  meta, wave grid), so a refresh no longer blanks the page or loses scroll/compose state,
  leaving the issue sheet, repo dropdown and archived-runs list untouched.

### The demo-dashboard feed test stops rotting on the clock — August 25, 2026

**Bug fixes:**
- [internal] The demo-dashboard integration test no longer fails once wall-clock time passes
  48h from a hardcoded seed date (#115). The fixture seeded events at a fixed instant while
  `/api/feed` filters to a rolling 48h window against the real `now`, so the seeded events
  aged out and `src/dashboard-demo.test.ts` went red on a clock rather than a change — and
  because that file is inside the gate, every agent's baseline was red through no fault of
  its own. `seedDemoRun` is now anchored relative to `now` (30 minutes back, keeping the
  ~13-minute run inside the window with margin), fixing both the test and the live
  `make demo-create` feed in one place.

### The stack is renamed to Vetinari — August 24, 2026

**Breaking changes:**
- [ops] Renamed the project, package, CLI, service, host configuration, environment
  variables, logs, examples, documentation, committed config directory
  (`vetinari/`), and local state directory (`.vetinari.local/`) from
  `sandcastle-tdd` to `vetinari`. The old branded config and environment-variable
  fallbacks were removed; the `.sandcastle/` layout remains migration input.

### Ephemeral state lands under the project's own state dir — August 24, 2026

**Improvements:**
- [ops] The orchestrator now passes its `stateDir` (default `.vetinari.local`) to
  sandcastle's `createSandbox`, so sandcastle's own gitignored runtime artifacts
  (worktrees/, `.env`, patches/, default logs/) land under the project's state
  dir instead of a stray `.sandcastle/`. This keeps all ephemeral state in one
  gitignored place, segmented from the committed `vetinari/` config. Requires a
  sandcastle build carrying the `stateDir` option (ADR 0021 in `@ai-hero/sandcastle`);
  older builds ignore the option and keep writing `.sandcastle/`.

### The all-repos landing lands its visual design — August 24, 2026

**Improvements:**
- [user] The issue-detail sheet gained a **Worktree** meta tile and turns-with-duration
  (#90). The tile surfaces the agent's real preserved worktree path — sourced from
  the `worktree-preserved` event the loop logs when it parks a slot — and stays hidden
  when no such path exists. The Turns tile now reads `N turns · Mm` (its working
  duration) rather than a bare count.
- [user] The all-repos landing's project cards and top counters finish their visual
  design (#80), a frontend/visual change only — everything still derives from the
  existing `/api/landing` payload. Each live card now carries a `percentMerged`-width
  progress bar beneath its `wave · % merged` line, filled in the run state's colour;
  the per-card tally reads as status-dot pill chips, and the four top counters colour
  their values and each carries a client-derived sublabel; the parked counter gains a
  gold border while it holds questions. Pinned by `renderLandingShell` regression tests.
- [user] The landing **Merged today** counter's sublabel now reads **"All repos"** (was
  "issues merged") (#104) — the title already carries the metric, so the sublabel states
  the counter's **scope** instead, matching the **Agents working → "across N repos"**
  sibling. The count itself is unchanged.
- [user] **Campaign wave cards were decluttered** (#99). Each wave used to render its issues
  twice — a wrapping row of status chips *and* a separate title list — reading as two
  competing hierarchies. Those two blocks are now one **member list**: one interactive
  row per issue (status dot · `#NNN` · resolved title), each keeping the old chip's
  behaviours (opens the issue-detail sheet, carvable when carvable, struck-through when
  carved). The **wave header** is now one stable row — **label · `merged/total` · state
  pill · carved tally** — with the label in its own element so a long label wraps within
  itself instead of shoving the state pill onto its own line.
- [user] The repo page's **archived runs** are now a **collapsible list** instead of a bare
  list of links (#98). Each row shows the campaign name, the run's start time, a state dot
  reading **`complete`** or **`interrupted`**, the issue count, and a joined
  **`campaign` / `raw log`** control. Clicking a row expands it inline; campaign mode
  reuses the **live wave renderer** read-only (its chips open the normal issue-detail
  sheet against the archived run's own log), and raw-log mode renders the JSONL verbatim
  with line-number anchors, JSON colouring, and a text filter. Capped at the **20 newest**
  runs with a **"show older"** control; all derived from the archived logs, no new
  persistence.
- [user] The all-repos landing's activity feed now reads as the POC's **event log** (#95).
  The header is **"Event log · all repos"** with a live dot; each row's timestamp is
  compact **HH:MM** for a same-day event; and the event kind renders as a clean lowercase
  `namespace.verb` label (`green → issue.merged`, `campaign-batch-done → wave.closed`,
  …) — a feed-label remap of the **real** orchestrator events (no fabricated kinds, no
  `agent-N` identity).
- [user] The all-repos landing's four counters now match the POC layout (#94): the
  uppercase **label sits on top**, with the **value and sublabel inline on one row**
  below it. Colours, sublabels, and the parked-counter behaviour are unchanged — layout only.

**Bug fixes:**
- [user] Archived-run **when-times** now render in the operator's **local** timezone
  instead of UTC, and the hardcoded ` UTC` suffix is dropped (#102). `formatRunWhen`
  switched from the `getUTC*` accessors to their local equivalents; the raw-log pane keeps
  its UTC stamps verbatim — only the display chrome localizes.
- [user] The landing **EVENT LOG** feed now reads across each project's live run **and its
  recently-archived runs**, over a rolling **48-hour** window by event `ts` (#101). It
  previously read only the live-run log, so completing a run (which archives its log and
  resets the live file) emptied the feed. `buildFeed` now also opens each archived run
  whose runId falls within the window; the feed renders the newest **20** rows with a
  **"show older"** control, and an empty window reads **"No activity in the last 48 hours."**
- [user] The landing **EVENT LOG** feed's "show older" rows now actually stay hidden (#101).
  `.feed-row { display: flex }` beat the UA `[hidden]` rule, so every capped-off row still
  painted (~64,000px tall). Added `.feed-row[hidden] { display: none }`.
- [user] Dashboard pulse motion is now governed by **one control** (#100). A single root
  `data-paused` flag freezes every pulse at once — the green live dots and the blue running
  dots — so **pausing stills all dots**. The **green live dots** track the live *stream*;
  the **blue running dots** track *work* (an idle "0 running" tally dot renders solid, no
  pulse). The **"updated Ns ago"** readout reads **"Paused"** while paused. Reduced-motion
  still disables all pulsing.
- [user] The all-repos landing's **MERGED TODAY** counter under-counted a project that
  ran several campaigns in one day: it read only one run per project (#97). It now sums
  every issue merged (completed) today across the project's live run **and all** archived
  runs, deduped per issue. "Today" is now the operator's **local** calendar day, not the
  UTC day. The sublabel now reads **"issues merged"** (was "issues closed") — a merge is
  pending-verify, not a close.
- [user] The live-bar **play/pause control** rendered as a colourful gradient emoji on
  Apple platforms (#96). The control is now a monotone icon **drawn in CSS with
  `currentColor`** (two bars while live, a triangle once paused), carrying no emoji
  codepoint, so it matches the toolbar text colour on every platform.
- [user] The all-repos landing **activity feed** rendered `#undefined merged` for merge
  events that named their issue only through the branch (`agent/<id>`) rather than an
  explicit `taskId` (#93). The feed formatter now recovers the issue number from the
  branch when `taskId` is absent, so every merge row reads `#<issue> merged`.

### The dashboard becomes a client-rendered, colour-consistent surface — August 23, 2026

**Improvements:**
- [user] The dashboard's native `<select>` project picker is replaced by a **custom repo
  dropdown** (#88) — the toolbar's page heading and the repo switcher in one control,
  shared by the landing and the repo page. Its `.repo-trigger` states the current scope
  as the largest text in the toolbar and toggles a `role="listbox"` popover whose rows
  carry a run-state status dot, the `owner/name` label, and a note; full keyboard/ARIA
  support, 44px touch rows, and a `<noscript>` native `<select>` fallback.
- [user] The dashboard now labels each project by its full **`owner/name`** rather than the
  bare project key (#89), derived at landing-build time from each project's
  `git remote get-url origin` (via a pure, unit-tested `ownerRepoFromRemote`); a project
  with no parseable remote falls back to its bare name. Display-only — the registry key
  and routing stay the bare key.
- [user] The repo/campaign page's closed waves now expand and collapse the way the design
  intends (#82). Each closed wave is a compact toggle chip (`✓ Wave N  M/M`) with a chevron
  that flips `›`⇄`⌄`; clicking it reveals that wave's _full_ card in the shared
  `waves-grid`. Any subset can be open at once; the open set is persisted per repo so a
  live `/api/events` reload no longer collapses everything; keyboard-operable with
  `aria-expanded` and a `<noscript>` fallback.
- [user] The repo/campaign page's header row and section order now match the design, and
  the top bar is one shared control across every page (#81). The live indicator is a dot
  only (its state an accessible label), pause is an icon control (⏸/▶), and the top→bottom
  order is top bar → Parked → campaign-meta → closed waves → open waves. Both pages now
  render one shared `renderTopBar` / `TOP_BAR_STYLES`, so they cannot drift again.
- [user] The dashboard's colour is now one shared model across every surface (#83). One
  `:root` palette is emitted once and consumed by the landing, the repo page and the
  issue-detail sheet, and state→colour is derived through one helper. Concrete changes:
  `failure` renders its own red distinct from the carve action's; issue chips border their
  own status at 40% alpha with a full-strength dot; hover lifts the fill only; the
  run-state precedence is `parked > failure > running`; the live dot pulses while streaming.
- [user] The issue-detail sheet's parked treatment now matches the POC's hierarchy (#92).
  Reply options render as **full-width lettered rows**; the redundant **Elapsed** tile is
  removed (the Turns tile carries the duration, now pluralized — `1 turn`, `2 turns`); the
  parked block leads with **"PARKED — NEEDS YOUR ANSWER"** and the turn log is its own
  **"Agent turns"** section.
- [user] The per-project campaign page (`GET /?project=<repo>`) is restyled to the new
  visual design (#79). Its top-right carries the landing's live-bar updating off the
  `/api/events` stream; parked issues render as clickable question cards that open the
  issue-detail sheet (the old inline `/answer` form is gone); closed waves read as
  `✓ Wave N merged/total` chips and open waves lay out as a responsive grid.
- [user] The all-repos landing's activity feed now colours each event kind by its comms
  category (#78) — merges/dones green, a parked question yellow, a halt red, a carve
  purple, in-flight events blue — instead of one flat teal, so the feed scans at a glance.
- [user] Each project card on the all-repos landing now tints its highlight (top border)
  to its run state — running blue, parked yellow, failure red, completed green, idle grey —
  matching the run-state pill (#75).

**Bug fixes:**
- [user] The all-repos landing's recent-activity feed rendered the progress/blue
  event-kind labels illegibly — the mid-tone blue on tiny bold uppercase read as a
  strikethrough (#85). Each feed kind now reads its comms category as a full-strength
  leading dot with the label at `--color-text`. A follow-up scoped the card progress
  bar's bare `.progress` selector to `.progress-track` so it no longer boxed the feed's
  `feed-kind progress` label.
- [user] The parked-issue detail sheet's action row showed **four** buttons at once because
  the carve-confirm form's own `display: flex` defeated its `hidden` attribute (#90). The
  confirm form now collapses when hidden (`.carve-confirm[hidden]`), so the default row is
  **Resume + Carve** alone and Confirm/Cancel reveal only after Carve is clicked. (Also
  added the progressive carve buttons and the WORKTREE/turns-duration meta.)

**Documentation:**
- [internal] Landed `docs/dashboard-color-rules.md`, the normative card/chip colour spec (#83):
  the six-state palette, the one-coloured-edge rule, state→colour derivation and precedence,
  card/chip application, the running-only motion rule, and the interactive-affordance rules.
- [internal] Codified the CSS convention that a **status/category word only ever appears in a
  scoped selector** (`.dot.running`, never a bare `.running {`) (#91, `docs/dashboard-color-rules.md`
  §8), with a regression asserting neither page emits a bare top-level rule for any
  status/category word.

### The status dashboard is reinvented — client-rendered, live, mobile — August 23, 2026

**New features:**
- [user] All-repos landing view for the dashboard (#55). The aggregated server serves a
  client-rendered shell (vanilla, no build step) at `/`. Four counters run across the top —
  agents working, parked, queued, and merged today — over one card per registered project
  showing its run state, campaign name, wave N of M, percent merged, a tally, and the last
  event in plain words. A single dropdown switches All repos ↔ a project. The landing model
  is a new `GET /api/landing` JSON endpoint. Single-column and touch-friendly on a phone.
- [user] Cross-project event feed on the all-repos landing (#55). A time-ordered activity
  log spanning every registered project, built read-side off the same live-run logs the
  cards read: a pure `formatFeedEvent` folds each event to a plain-words, repo-prefixed
  sentence, and `buildFeed` merges every project's narratable events newest-first. Served
  as `GET /api/feed`.
- [user] The all-repos landing's parked counter expands in place into a cross-repo parked
  queue (#55). Clicking the counter drops a list of every parked question across all
  repos — issue number, repo, the full question, and how long it has waited, oldest first.
  The landing model gains a `parked` array; each row opens that repo's issue detail.
- [user] Live dashboard updates over SSE with a buffered pause (#55, ADR 0008). The
  aggregated server `fs.watch`es every registered project's live-run log and pushes new
  events over a single `GET /api/events` stream. Pause is a client-side presentation
  freeze: the stream keeps flowing, and resume re-reads once to flush the backlog.
- [user] Issue-detail sheet with the agent turn log (#55). Opening an issue raises a detail
  sheet (centred on desktop, a full-width bottom sheet on mobile) with a sticky header,
  meta tiles, and the turn log: each turn's number in its status colour and the agent's own
  one-sentence summary, newest first. Reconstructed by a pure `reconstructIssueDetail` and
  served at `GET /api/issue?project=&issue=`.
- [user] Parked-question reply and Resume in the issue-detail sheet (#55). A parked issue's
  sheet shows the full question, the options the agent offered rendered as buttons that fill
  the reply field, and the field itself; `Resume` submits through the existing `POST /answer`
  path. `GET /api/issue` carries the parked reply payload.
- [user] Carve from the issue-detail sheet, routed through the structured closure (#55). The
  sheet's Carve action confirms against the exact closure the dry-run emits, names the
  dependents that would leave and, separately, the banked work that is kept. `GET /carve?preview`
  returns the full structured closure; carve never executes on first tap.
- [user] Campaign view waves now render carved issues, list their titles, and pulse the
  running chip (#55, #62). A carve no longer makes an issue vanish: the reconstruction
  renders it as a `carved` chip (the sixth ADR 0007 status, derived at render). Each open
  wave lists its issues' titles, and the running chip pulses (reduced-motion aware).
- [user] A selected archived run now reconstructs its carved issues read-only (#55), so an
  operator browsing a finished run sees what it was carved down to — the archived `carve`
  event replays into a `carved` chip through the same fold the live run uses.
- [api] Structured carve closure from `carve --dry-run` (#58). Previewing a carve of the
  running campaign now prints a machine-readable `carve-closure {…}` line after its human
  text — target, dependents dropped, banked work kept, remaining waves — so a consumer can
  name the exact closure without re-parsing prose.
- [api] Each `turn` event now carries an agent-authored one-line summary (#55). The agent's
  signal contract requires a `<turn-summary>` line every turn, which the orchestrator
  extracts and records on the `turn` event; events predating the change carry no summary
  and reconstruct as before.

### `campaign-plan` reads an explicit file-set marker — August 23, 2026

**Bug fixes:**
- [user] `defaultFileSet` was all-or-nothing over a ticket's whole body, so one incidental
  filename-shaped token flipped `confident` to `false` even when the ticket plainly cited
  its real files, and `campaign-plan` could schedule nothing (#37). It now reads an explicit
  `Touches:` / `Files:` marker line first (only that line's cites count), falling back to
  the whole-body scan when no marker is present, and feeds the resolver the ticket's
  title+body only (via `ticketProse`) so a stray token in a comment can't poison confidence.
  The strict confidence contract is unchanged. This repo's own config drops its bespoke
  `fileSet` override in favour of the reworked default.

### Ticket-driven campaigns: planning, naming, and archived runs — August 22, 2026

**New features:**
- [user] `campaign-plan <ids…>` command: turns a selected set of ticket ids into the
  dependency-ordered, file-disjoint wave arguments `campaign` consumes. It layers by the
  `blockedBy` DAG and keeps co-wave tickets from touching the same file, the file-set coming
  from a `fileSet(ticket) → { files, confident }` config seam with a shipped cites-from-body
  default. An under-specified ticket halts the plan rather than being scheduled around
  silently (`--on-underspecified=drop|fail`). It plans only.
- [user] Optional campaign name (#42). `campaign --name "…"` records `name` on the
  `campaign-start` event; the dashboard surfaces it as a header label and as each
  "Archived runs" entry's primary label. `campaign-plan` also prints a suggested
  `--name "…"` line joining the area labels the selected issues span.
- [user] Archived runs in the dashboard (#40). Under the selected project's live run, the
  aggregated status site lists that project's finished runs from
  `logs/archive/orchestrator-*.jsonl`, newest-first, each with a one-line summary folded
  via `reduceCampaign`. Clicking one re-renders `GET /?project=…&run=<timestamp>` read-only;
  a run is resolved by matching the archive listing, never by joining request input.
- [api] Raw event log of an archived run (#41). `GET /archive/log?project=…&run=<timestamp>`
  serves that run's archived JSONL as `text/plain`, as-is; the run is resolved by matching
  the project's archive listing, so a crafted `run` token is a 404. Each "Archived runs"
  entry carries a "raw log" link.
- [user] Wave headers now read as their work (#43). Each dashboard wave label is derived at
  render from the issue titles the dashboard already resolves — a single-issue wave reads as
  that issue's title, a many-issue wave as its lead issue's title + "+N" — with the bare
  `Wave N` index still leading and the plain index kept when a lead title hasn't resolved.
- [api] Dashboard issue titles, wave names, and chip hovers (#44). The orchestrator resolves
  the run's issue titles up front and records them as an id→title map on the start event;
  `reduceCampaign` folds those onto each `issue.name`, so the dumb-router dashboard renders
  real titles and wave names for both live and archived runs with no lookup of its own.

### The committed vetinari/ + .vetinari.local/ layout, migrate, and init — August 22, 2026

**New features:**
- [ops] Committed `vetinari/` + excluded `.vetinari.local/` layout. Config now resolves from
  a committed `vetinari/config.mts` (canonical), with the legacy `.sandcastle/config.mts`
  location retained as migration input.
- [ops] `migrate` command: moves an existing project from the old single-`.sandcastle/`
  layout onto the committed `vetinari/` + excluded `.vetinari.local/` split in one step —
  config → `vetinari/`, old state and secrets → `.vetinari.local/`, `.gitignore` updated.
  `--dry-run` prints the plan; idempotent and non-clobbering. `computeLayoutMigration`,
  `applyLayoutMigration`, `scanLayout`, and `describeMigration` are exported.
- [ops] `init` command: scaffolds a new project onto the layout (a starter
  `vetinari/config.mts`, a Dockerfile, and the excluded `.vetinari.local/`), so a fresh
  project is ready to run with one command.

**Improvements:**
- [ops] Default state directory flipped from `.sandcastle/` to `.vetinari.local/`, and the
  committed config location is `vetinari/config.mts`; `migrate` moves an existing project
  across.

### The host gateway fronts every registered project — August 22, 2026

**Breaking changes:**
- [ops] `dispatch` and `attend` retired — the gateway is now the single Telegram consumer
  and the only path for Telegram round-trips (the `/status`-over-Telegram query is answered
  by the gateway). The standalone single-project status server (`serveStatus`) and its
  full-page carve preview are removed, superseded by the aggregated dashboard.

**New features:**
- [ops] Host gateway + registry. A single host-level gateway daemon fronts every registered
  project as the sole Telegram consumer: it dedupes shared bot tokens so each bot is polled
  once, announces newly parked questions to each project's destination, routes a reply back
  to the exact project + task it answers, and resumes several answered tasks concurrently.
  Projects auto-register on run, handing the gateway only a pointer to their base location.
- [ops] Comms taxonomy + notify map. A project declares named `destinations` (bot + chat,
  optional thread) and a `notify` map routing each message category — `question`, `success`,
  `failure`, `progress`, `finding` — to a destination, with a `*` wildcard default;
  `question` is validated to a single destination at load. A run writes category-tagged
  outbound records the gateway drains and routes. `resolveDestination` is pure and tested.
- [user] Multi-project dashboard. The `status` server aggregates every registered project
  behind a project dropdown (`buildAllStatus`), reading the host registry live and skipping
  a project whose state is missing.

**Improvements:**
- [user] The status dashboard is one registry-backed aggregated server. `status` serves the
  multi-project dropdown view (a single project is a one-entry dropdown); carve moved off the
  chips into the tap-to-open issue-detail panel with an inline preview + confirm; `--host
  0.0.0.0` still exposes it over a tailnet.

**Bug fixes:**
- [ops] The gateway never delivered a project's Telegram messages when its `orchestrator.env`
  annotated the credentials with inline comments (#77). `parseEnvFile` stripped surrounding
  quotes but not inline `#` comments, so the bot token carried the comment and Telegram
  returned 404. It now matches shell `source` semantics.
- [user] Clicking a pending issue in the cross-repo parked queue did a full navigation to the
  old campaign status page instead of opening that issue's detail (#74). The landing now
  hosts the issue-detail sheet and a parked-queue row opens it inline, with a plain `href`
  kept only as the no-JS fallback.
- [user] Idle-project landing cards and sheet CSS collapse (#69, #70, #71, #73): an idle
  project's card now reconstructs its latest archived run for a real merged %; the "Last run"
  summary derives its terminal state from a run-scoped `halted` flag rather than folding a
  stale halt; the parked reply `<textarea>` gained `max-width: 100%`; and the cross-repo
  parked queue and the sheet's flex panels got companion `[hidden] { display: none }` rules
  so they actually collapse.

### Carve, findings, and the status line — August 20, 2026

**New features:**
- [user] Carve a running campaign. `carve <issue>` (no plan) prunes a running campaign by
  appending a carve event the loop honors at the next wave boundary — the in-flight wave
  finishes, future waves shrink, and already-merged/mergeable work is kept while only
  unfinished issues drop. Also triggerable from the dashboard and Telegram (preview-then-
  confirm), each routed to the right project. `reduceCampaign` is extracted so the loop and
  the dashboard reconstruct the plan the same way.
- [api] Config gains an optional `blockedBy(id)` resolver that `carve` and `campaign-plan`
  read. `githubBlockedBy("owner/repo")` ships as a ready implementation over GitHub's native
  "blocked by" issue dependencies.
- [user] Incidental-findings harvest: with a `reportFinding` handler configured, a green run
  ends with one extra turn asking the agent for any defect it noticed but did not fix, and
  files each somewhere durable. `githubFindingReporter("owner/repo", { labels })` ships as a
  GitHub implementation. Runs only on green; a failed filing never turns a green into an error.
- [user] `statusline` command: prints two lines for the Claude Code status bar — line 1
  mirrors Claude Code's default (model, directory, git branch, context-used %), line 2 is
  the Vetinari run (wave in flight, a count per status), shown only where a config lives.
  Reads Claude Code's status JSON on stdin, derives line 2 from the log (no network), and
  always exits zero.
- [user] A `clear` command forces a status reset on demand (archiving the current log and
  clearing parked records) even with questions still parked; finished `campaign`/`queue`
  runs archive their log automatically so `buildStatus` reads idle.

**Improvements:**
- [ops] `carve` is context-aware: `carve <issue>` (no plan) prunes a running campaign, while
  `carve <issue> <batch…>` launches a reduced campaign from a supplied plan.
- [ops] Campaign batches clear the parked records of their non-green tasks once the wave
  finishes, so stale questions from a completed wave do not bleed into the next.
- [user] Issue chips surface the real issue title and current activity (on hover, or tap on
  touch devices) instead of a static placeholder.

**Bug fixes:**
- [user] The `status` server no longer exits immediately after binding — a stray
  `process.exit(0)` was killing the aggregated dashboard the instant it started listening.
- [user] Auto-refresh no longer reloads (and discards) a reply you are mid-typing to a
  parked issue.
- [user] Parked issue chips no longer render oversized (a `.parked` CSS rule was bleeding
  onto the chip status dot); the first row of chips no longer stretches taller than the rest
  on a wrapped wave (Safari flex-wrap stretch); and the tapped-issue detail appears in a
  dismissible bottom bar in a consistent, reachable spot on mobile.

### Vendored skills — August 19, 2026

**Improvements:**
- [internal] Vendored the `mattpocock/skills` set under `.agents/skills/`, pinned by
  `skills-lock.json`.

### v0.1.0 — August 16, 2026

**New features:**
- [user] Initial parallel TDD agent orchestrator built on sandcastle.
- [user] Campaign mode with waves/batches, and mattpocock skills baked into the agent image.

**Documentation:**
- [internal] Team walkthrough deck.

[0.1.0]: https://github.com/jjforge/vetinari/releases/tag/v0.1.0
