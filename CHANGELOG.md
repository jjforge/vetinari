# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `migrate` command: moves an existing project from the old single-`.sandcastle/`
  layout onto the committed `sandcastle/` + excluded `.sandcastle.local/` split in
  one step — config → `sandcastle/`, old `.sandcastle/` state and secrets →
  `.sandcastle.local/`, and `.gitignore` gains `.sandcastle.local/` while keeping
  `.sandcastle/` ignored during the transition. `migrate --dry-run` prints the plan
  and changes nothing. Idempotent (a re-run on an already-migrated project reports
  "nothing to do") and non-clobbering (a move whose destination exists is refused,
  never overwritten). Warns that folding host-only orchestrator secrets and
  rewriting the systemd unit are deferred to the gateway epic (E3). The pure
  `computeLayoutMigration` planner, `applyLayoutMigration`, `scanLayout`, and
  `describeMigration` are exported.

- Run cleanup so a finished run stops showing as current in the dashboard and
  status line. On clean completion of a `campaign` or `queue` (not on a halt, and
  only when nothing is still parked) the orchestrator log is archived to
  `.sandcastle/logs/archive/orchestrator-<ts>.jsonl` — moved aside, never deleted
  — and a fresh empty log takes its place, so `buildStatus` reads idle. Parked
  records are cleared as part of the reset. A new `clear` command forces the same
  reset on demand, even with questions still parked. `archiveRun` is exported.

- Incidental-findings harvest: with a `reportFinding` handler configured, a green
  run ends with one extra turn on the agent's live session asking for any defect
  it noticed but did not fix — context that otherwise dies with the container —
  and files each somewhere durable. `githubFindingReporter("owner/repo", { labels })`
  ships as a GitHub implementation that opens a labelled issue cross-referenced to
  the task it was found on. Runs only on green; a failed filing is logged per
  finding and never turns a real green into an error. Absent the handler, no
  harvest turn runs. `parseFindings`/`reportFindings`/`githubFindingReporter` and
  the `Finding` types are exported from the entry point.
- `statusline` command: prints two lines for the Claude Code status bar. Line 1
  mirrors Claude Code's default — model, directory, git branch, context-used % —
  with the model name trimmed of its `(1M context)` suffix; line 2 is the
  sandcastle run (wave in flight, a count per status; no project name, since line
  1 already shows the directory), shown only where a config lives. Reads Claude Code's status JSON on stdin, resolves the config from
  the workspace directory, and derives line 2 from the log (no network) to stay
  fast on every refresh. Outside a sandcastle project line 2 is omitted; it always
  exits zero (a non-zero exit would blank the bar). Wire it via
  `.claude/settings.json` `statusLine` with a `refreshInterval` so it stays live
  during a run; documented in the README.
- `carve <issue> <batch…>` command: drops an issue and the transitive closure of
  everything blocked by it from a campaign, then runs the reduced campaign
  (`--dry-run` prints the plan instead). Removal cascades across every branch and
  diamond — an issue falls if any of its blockers falls — and is computed over
  the campaign's own issues, so a blocker outside the named campaign is out of
  scope. Since carve only drops issues, each remaining wave stays as conflict-free
  as it was built.
- Config gains an optional `blockedBy(id)` resolver (the ids that block an id)
  that `carve` reads. `githubBlockedBy("owner/repo")` ships as a ready
  implementation over GitHub's native "blocked by" issue dependencies; both are
  exported from the package entry point.
- Inbound `/status` command over Telegram: while `dispatch` is running, sending
  `/status` (bare, or `/status@yourbot` in a group) replies in-chat with a live
  summary — each wave, its issue chips with status, and any parked issues
  awaiting you. Read-only and built on the same status model as the web
  dashboard, so it never disturbs a run. Handled in the single `dispatch` poller
  (Telegram permits only one consumer of a bot's updates), so it needs no extra
  process. Documented in the README.
- `status [--port <port>] [--host <host>]` CLI command that serves a local
  campaign/wave web dashboard (default `http://127.0.0.1:8765`). It shows each
  wave, per-issue status chips, and parked-issue cards you can respond to inline;
  `--host 0.0.0.0` exposes it over a tailnet. Documented in the README.
- Campaign batches now clear the parked records of their non-green tasks once the
  wave finishes (`clearParkedForTasks`), so stale questions from a completed wave
  no longer bleed into the next wave's dashboard.
- Auto-refresh on/off checkbox on the dashboard; both the toggle and the interval
  persist across reloads, and the interval field disables when off.
- The dashboard leads with parked issues, above the waves, whenever any are
  awaiting a response — with an "N awaiting you" badge and a yellow accent. When
  nothing is parked, the page leads with the waves as before.
- Vendored the `mattpocock/skills` set under `.agents/skills/`, pinned by
  `skills-lock.json` (each skill's source path and content hash).

### Changed

- Issue chips now surface the real issue title and current activity (on hover, or
  tap on touch devices) instead of a static placeholder.
- Simplified the refresh control to a compact "☑ Refresh (45)" and removed the
  pill background around it; enlarged the checkbox to match the label text.
- Closed waves collapse into chips marked with a green check instead of a
  separate "Completed:" label, so the row describes itself.

### Fixed

- Auto-refresh no longer reloads (and discards) a reply you are in the middle of
  typing to a parked issue.
- Parked issue chips no longer render oversized — a `.parked` CSS rule for the
  section was bleeding onto the chip status dot.
- The first row of issue chips no longer stretches taller than the rest when a
  wave wraps to multiple rows (Safari flex-wrap stretch).
- The tapped-issue detail now appears in a dismissible bottom bar that stays in a
  consistent, reachable spot on mobile instead of mid-page.

## [0.1.0] - 2026-08-16

### Added

- Initial parallel TDD agent orchestrator built on sandcastle.
- Campaign mode with waves/batches, and mattpocock skills baked into the agent
  image.
- Team walkthrough deck.

[Unreleased]: https://github.com/jjforge/sandcastle-tdd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jjforge/sandcastle-tdd/releases/tag/v0.1.0
