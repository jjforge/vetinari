# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Live dashboard updates over SSE with a buffered pause (#55). The aggregated
  server `fs.watch`es every registered project's live-run log and pushes the events
  appended since each connection last read over a single server→client SSE stream
  (`GET /api/events`, ADR 0008), carrying `{ project, events }` per frame. The
  all-repos landing shell subscribes to it and re-reads `/api/landing` as events
  land, with an "updated Ns ago" readout counting from the last refresh and a
  live/paused indicator in the toolbar. Pause is a client-side presentation freeze:
  the stream keeps flowing and events keep being collected while paused, and resume
  re-reads once to flush the whole backlog. A moved or deleted project base location
  is a watcher that never arms, tolerated like any stale registration (ADR 0002).
- All-repos landing view for the dashboard (#55). The aggregated server now serves
  a client-rendered shell (vanilla, no build step) at `/`, replacing the old
  server-rendered status page as the thing you land on. Four counters run across the
  top — agents working, parked, queued, and merged today (the last derived from the
  reconstruction's per-issue merge timestamps) — over one card per registered
  project showing its run state, campaign name, wave N of M, percent merged, a
  running/parked/queued tally, and the last event in plain words; a project with no
  live run reads idle with its last campaign. A single dropdown switches All repos ↔
  a project and a card opens that project's campaign view. The landing model is a
  new `GET /api/landing` JSON endpoint. Uses the ADR 0007 status vocabulary, and is
  single-column and touch-friendly (44px tap targets) on a phone.
- Each `turn` event now carries an agent-authored one-line summary (#55). The
  agent's signal contract requires a `<turn-summary>` line every turn — its own
  account of what it did and why — which the orchestrator extracts (a pure helper,
  mirroring the `<question>` extractor) and records on the `turn` event, so the
  dashboard can render a per-turn log in the agent's own words. Events predating
  the change simply carry no summary and reconstruct as before.

### Fixed

- Dashboard issue titles, wave names, and chip hovers (#44). The aggregated web
  dashboard is a dumb router with no per-project `fetchTask`, so since the
  one-dashboard consolidation it resolved no issue titles — chip hovers showed only
  `number:status` and wave names always fell back to the bare `Wave N`, live and
  archived alike. The orchestrator (which has `fetchTask`) now resolves the run's
  issue titles up front and records them as an id→title map on the start event —
  `campaign` on `campaign-start`, a standalone `queue` on `queue-start`.
  `reduceCampaign` folds those onto each `issue.name`, so the dashboard renders real
  titles and wave names for both live and archived runs with no lookup of its own. A
  run whose titles could not be fetched simply omits them and degrades to
  `number:status` (no crash); an unnamed run without titles writes the same start
  event it always did.

### Changed

- Wave headers now read as their work (#43). Each dashboard wave label is derived
  at render from the issue titles the dashboard already resolves — no storage, no
  event change: a single-issue wave reads as that issue's title, a many-issue wave
  as its lead issue's title + "+N" for the rest (e.g. `Wave 2 — config resolution +3`).
  The bare `Wave N` index still leads, the chips still carry every issue's title on
  hover/tap, and a wave whose lead title has not resolved yet keeps the plain index.

### Added

- Structured carve closure from `carve --dry-run` (#55). Previewing a carve of the
  running campaign (`carve <issue> --dry-run`) now prints a machine-readable
  `carve-closure {…}` line after its human text — the target, the dependent issues
  it would drop, the banked (merged/mergeable) work it keeps, and the remaining
  waves. The human dry-run output is unchanged, so a consumer (the aggregated
  dashboard's carve preview) can name the exact closure without re-parsing the CLI's
  prose.

- Optional campaign name (#42). `campaign --name "…"` records `name` on the
  `campaign-start` event (omitting it writes the exact same event as before), and
  `reduceCampaign` reads it back. The dashboard surfaces it as a header label on
  the live run and on a selected archived run, and the "Archived runs" list uses
  the name as each entry's primary label — falling back to the run's timestamp
  token when unnamed — with the mode·issues·outcome summary kept as a secondary
  label. `campaign-plan` also prints a suggested `--name "…"` line joining the
  distinct area labels (`orchestrator`/`gateway`/`comms`/`dashboard`/`layout`/`launcher`)
  the selected issues span, in a stable order, to paste or edit (it suggests only —
  nothing is stored). `suggestCampaignName` and `AREA_LABELS` are exported.
- Raw event log of an archived run (#41). `GET /archive/log?project=…&run=<timestamp>`
  on the aggregated status site serves that run's archived
  `logs/archive/orchestrator-<timestamp>.jsonl` as `text/plain`, as-is (no
  pretty-printing). The run is resolved by matching the project's archive listing
  — the same guard as the archived-run render — so an unlisted or crafted `run`
  token is a 404, never a path joined from request input. Each entry in the
  dashboard's "Archived runs" list now carries a "raw log" link to it.
- Archived runs in the dashboard (#40). Under the selected project's live run, the
  aggregated status site now lists that project's finished runs from
  `logs/archive/orchestrator-*.jsonl`, newest-first, each with a one-line summary
  (mode · issue count · complete/halted) folded from the archived log via
  `reduceCampaign`. Clicking one re-renders `GET /?project=…&run=<timestamp>`,
  which reads that archived log through the existing `buildStatus`/`renderStatusPage`
  and shows its wave/issue view read-only (no carve control, no answer form) below
  the still-live run. A run is addressed by its timestamp token and resolved by
  matching the archive listing (never by joining request input into a path); a
  malformed archive is skipped with a log line. `listArchivedRuns` and
  `summarizeRun` are exported.
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
