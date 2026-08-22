# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Committed `sandcastle/` + excluded `.sandcastle.local/` layout. Config now
  resolves from a committed `sandcastle/config.mts` (canonical), with the legacy
  `sandcastle-tdd.config.*` and `.sandcastle/config.mts` locations kept as
  deprecated fallbacks that warn and point at the canonical path.
- `migrate` command: moves an existing project from the old single-`.sandcastle/`
  layout onto the committed `sandcastle/` + excluded `.sandcastle.local/` split in
  one step — config → `sandcastle/`, old `.sandcastle/` state and secrets →
  `.sandcastle.local/`, and `.gitignore` gains `.sandcastle.local/` while keeping
  `.sandcastle/` ignored during the transition. `migrate --dry-run` prints the plan
  and changes nothing. Idempotent and non-clobbering (a move whose destination
  exists is refused, never overwritten). The `migrate` extension also folds a
  project's `orchestrator.env` and rewrites its systemd unit into the host-level
  gateway service. `computeLayoutMigration`, `applyLayoutMigration`, `scanLayout`,
  and `describeMigration` are exported.
- `init` command: scaffolds a new project onto the layout (a starter
  `sandcastle/config.mts`, a Dockerfile, and the excluded `.sandcastle.local/`), so
  a fresh project is ready to run with one command.
- `campaign-plan <ids…>` command: turns a selected set of ticket ids into the
  dependency-ordered, file-disjoint wave arguments `campaign` consumes. It layers
  by the `blockedBy` DAG (`layerWaves`) and keeps co-wave tickets from touching the
  same file (`partitionWaves`), the file-set coming from a
  `fileSet(ticket) → { files, confident }` config seam with a shipped
  cites-from-body default. An under-specified ticket (no confident file-set) halts
  the plan rather than being scheduled around silently
  (`--on-underspecified=drop|fail`). It plans only — it never runs sandcastle.
- Host gateway + registry. A single host-level gateway daemon fronts every
  registered project as the sole Telegram consumer: it dedupes shared bot tokens so
  each bot is polled once, announces newly parked questions to each project's
  destination, routes a reply back to the exact project + task it answers, and
  resumes several answered tasks concurrently. Projects auto-register on run,
  handing the gateway only a pointer to their base location (no config or secrets
  copied). Telegram send/poll is parameterized by an explicit bot connection.
- Comms taxonomy + notify map. A project declares named `destinations` (bot + chat,
  optional thread) and a `notify` map routing each message category — `question`,
  `success`, `failure`, `progress`, `finding` (or a specific `category:event`) — to
  a destination, with a `*` wildcard default; `question` is validated to a single
  destination at load. A run writes category-tagged outbound records into an outbox
  that the gateway drains and routes, so the gateway is the sole sender.
  `resolveDestination` is pure and tested.
- Multi-project dashboard. The `status` server aggregates every registered project
  behind a project dropdown (`buildAllStatus`), reading the host registry live and
  skipping a project whose state is missing.
- Carve a running campaign. `carve <issue>` (no plan) prunes a running campaign by
  appending a carve event the loop honors at the next wave boundary — the in-flight
  wave finishes, future waves shrink, and already-merged/mergeable work is kept
  while only unfinished issues drop (their parked records cleared). Carve is
  triggerable from the dashboard (in the tap-to-open issue-detail panel) and from
  Telegram (a gateway command with preview-then-confirm), each routed to the right
  project. `reduceCampaign` is extracted so the campaign loop and the dashboard
  reconstruct the plan from the event log the same way. A confirmed carve emits a
  `progress:carve` message.
- Config gains an optional `blockedBy(id)` resolver (the ids that block an id) that
  `carve` and `campaign-plan` read. `githubBlockedBy("owner/repo")` ships as a ready
  implementation over GitHub's native "blocked by" issue dependencies.
- Incidental-findings harvest: with a `reportFinding` handler configured, a green
  run ends with one extra turn asking the agent for any defect it noticed but did
  not fix, and files each somewhere durable. `githubFindingReporter("owner/repo",
  { labels })` ships as a GitHub implementation. Runs only on green; a failed filing
  never turns a real green into an error.
- `statusline` command: prints two lines for the Claude Code status bar — line 1
  mirrors Claude Code's default (model, directory, git branch, context-used %), line
  2 is the sandcastle run (wave in flight, a count per status), shown only where a
  config lives. Reads Claude Code's status JSON on stdin, derives line 2 from the
  log (no network), and always exits zero.
- Campaign batches clear the parked records of their non-green tasks once the wave
  finishes, so stale questions from a completed wave do not bleed into the next.
- A `clear` command forces a status reset on demand (archiving the current log and
  clearing parked records) even with questions still parked; finished `campaign`/
  `queue` runs archive their log automatically so `buildStatus` reads idle.
- Vendored the `mattpocock/skills` set under `.agents/skills/`, pinned by
  `skills-lock.json`.

### Changed

- Default state directory flipped from `.sandcastle/` to `.sandcastle.local/`, and
  the committed config location is `sandcastle/config.mts`; `migrate` moves an
  existing project across.
- The status dashboard is one registry-backed aggregated server. `status` serves
  the multi-project dropdown view (a single project is a one-entry dropdown); carve
  moved off the chips into the tap-to-open issue-detail panel with an inline,
  on-demand preview + confirm; `--host 0.0.0.0` still exposes it over a tailnet.
- `carve` is context-aware: `carve <issue>` (no plan) prunes a running campaign,
  while `carve <issue> <batch…>` keeps launching a reduced campaign from a supplied
  plan.
- Issue chips surface the real issue title and current activity (on hover, or tap on
  touch devices) instead of a static placeholder.
- Simplified the refresh control to a compact "☑ Refresh (45)" and removed the pill
  background; enlarged the checkbox to match the label text.
- Closed waves collapse into chips marked with a green check instead of a separate
  "Completed:" label.

### Removed

- `dispatch` and `attend` retired — the gateway is now the single Telegram consumer
  and the only path for Telegram round-trips (the `/status`-over-Telegram query is
  answered by the gateway).
- The standalone single-project status server (`serveStatus`) and its full-page
  carve preview are removed, superseded by the aggregated dashboard; the aggregated
  server-side preview remains as the no-JS carve fallback.

### Fixed

- The `status` server no longer exits immediately after binding — a stray
  `process.exit(0)` was killing the aggregated dashboard the instant it started
  listening.
- Auto-refresh no longer reloads (and discards) a reply you are mid-typing to a
  parked issue.
- Parked issue chips no longer render oversized (a `.parked` CSS rule was bleeding
  onto the chip status dot).
- The first row of issue chips no longer stretches taller than the rest when a wave
  wraps to multiple rows (Safari flex-wrap stretch).
- The tapped-issue detail appears in a dismissible bottom bar that stays in a
  consistent, reachable spot on mobile instead of mid-page.

## [0.1.0] - 2026-08-16

### Added

- Initial parallel TDD agent orchestrator built on sandcastle.
- Campaign mode with waves/batches, and mattpocock skills baked into the agent
  image.
- Team walkthrough deck.

[Unreleased]: https://github.com/jjforge/sandcastle-tdd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jjforge/sandcastle-tdd/releases/tag/v0.1.0
