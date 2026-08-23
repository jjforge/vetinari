# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **host slot budget** (#87, ADR 0010): an opt-in host-side ceiling on live
  containers across every project, honoured by a cooperative filesystem lease each
  `campaign`/`queue` run reads and writes directly under
  `<gatewayConfigDir()>/slots/` — the gateway never allocates. Set it with the
  `SANDCASTLE_HOST_SLOTS` env var or a `<gatewayConfigDir()>/host-slots` file;
  **unset leaves today's behaviour untouched** (each run bounded only by its own
  `QUEUE_SLOTS`, uncoordinated). A run takes a slot only when under both its
  `QUEUE_SLOTS` and its current **fair share** — a floor of one slot per active
  project plus a weight-proportional cut of the remainder — so a busy project
  drains to its share as a new project becomes active, with no preemption, and a
  crashed run's slots are reclaimed on contention so the budget is never wedged.
  New optional `hostWeight` (default 1) in `sandcastle/config.mts` sets a project's
  cut of the remainder when projects contend.

- `docs/dashboard-color-rules.md`, the normative card/chip colour spec (#83): the
  six-state palette (§1), the one-coloured-edge rule (§2), the state→colour
  derivation and precedence (§3), the card/chip application (§4), the running-only
  motion rule (§5), and the interactive-affordance rules (§6), each tied to the
  shared implementation so it stays the reference.

- `docs/gateway.md`, an operator how-to for standing up and running the aggregated
  gateway (#68): credentials in `.sandcastle.local/orchestrator.env` and how the
  sole-sender gateway reads them live from each project's base location (vs. the
  retired per-project `dispatch`), declaring `destinations`/`notify` in
  `sandcastle/config.mts` and how `autoRegister` materializes them into
  `routing.json`, `autoRegister`-on-run + the `gateway` daemon, the
  dispatch→gateway `migrate`, and verification via `tg-test` and a draining outbox.
  Cross-links ADR 0002 and ADR 0006. Notes the `routing.json = {}` case truthfully:
  an empty routing map falls back to the default chat (delivery is not silenced) —
  the real silent no-delivery is missing credentials — which corrects the "`{}` =
  no delivery" wording in the issue.
- The all-repos landing's project cards and top counters finish their visual
  design (#80), a frontend/visual change only — everything still derives from the
  existing `/api/landing` payload, with no backend change. Each live card now
  carries a `percentMerged`-width progress bar beneath its `wave · % merged` line,
  filled in the run state's colour (running blue, parked yellow, completed green;
  idle/other grey). The per-card tally reads as status-dot pill chips
  (`● N running · ● N parked · ● N queued`) matching the campaign page's chip
  treatment, the dots scoped to `.dot` so they never tint the pills. The four top
  counters colour their values (working blue, parked yellow, merged-today green;
  queued neutral) and each carries a client-derived sublabel — working `across N
  repos` (repos with a running agent), parked `oldest <Nm>` (the oldest parked
  question's wait), queued `in later waves`, merged-today `issues closed`; the
  parked counter, the one actionable tile, gains a gold border while it holds
  questions. Pinned by `renderLandingShell` regression tests and verified by
  driving the served landing in a DOM against the live `/api/landing`.

- A selected archived run now reconstructs its carved issues read-only, so an
  operator browsing a finished run in the campaign view's "Archived runs" section
  sees what it was carved down to (#55). The read-only archived render reduces the
  archived log through the same `buildStatus`/`reduceCampaign` fold the live run
  uses, so a `carve` event in the archive replays into a `carved` chip in the wave
  it left (ADR 0007) — inert, in the shared wave/chip treatment that wraps on
  mobile. Pinned by a test that drives the archived-run HTTP surface end to end.
- Carve from the issue-detail sheet, routed through the structured closure (#55).
  The sheet's Carve action now confirms against the exact closure E2's dry-run emits
  (`carve-closure {json}`) rather than re-parsing the CLI's prose: the confirmation
  names the dependents that would leave and, separately, states the banked (merged
  or mergeable) work that is kept — so a confirm never implies banked work is
  discarded. `GET /carve?preview` returns that full structured closure
  (`{ target, dropped, keptBanked, remaining }`); `parseCarveClosure` reads the
  machine-readable line instead of the prose. A standalone Carve (offered on an
  unstarted/future-wave issue, with no Resume beside it) carries a plain-words
  explainer of what a carve does; a parked issue's Resume gives the context instead.
  Carve still never executes on first tap — a Cancel path collapses the confirm with
  no change — and confirming routes to the project's own install (ADR 0002),
  appending the carve event the loop honours at the next wave boundary (ADR 0005).
  Each wave a carve pruned now shows a carved tally in its header beside the issue
  count, so the carve reads at a glance next to the carved chips (ADR 0007).
- Parked-question reply and Resume in the issue-detail sheet (#55). When the opened
  issue is parked, the sheet now shows a reply block — the full question, the options
  the agent offered rendered as buttons that fill (not submit) the free-text reply
  field, and the field itself — pinned to the sheet foot beside Carve so both are
  reachable one-handed on a phone. `Resume` submits the reply through the existing
  `POST /answer` path, resuming the parked task in that project's own install (ADR
  0002); the redirect reload reflects the resumed state. Options are best-effort
  parsed; when absent, only the free-text field shows. `GET /api/issue` carries the
  parked reply payload (`parked: { question, options }`, from the pure `parkedReplyFor`)
  for a parked issue and omits it otherwise.
- Issue-detail sheet with the agent turn log (#55). Opening an issue — from a live
  wave chip or a parked row — now raises a detail sheet (centred on desktop, a
  full-width bottom sheet on mobile) with a sticky header (issue number, status,
  title, repo · campaign), meta tiles for the turn count and elapsed working time,
  and the turn log: each turn's number in its status colour and the agent's own
  one-sentence summary of that turn, newest first (ADR 0009) — the sheet's reason to
  exist. The data is reconstructed from the event log by a pure `reconstructIssueDetail`
  (turn log, count, elapsed span, status and title, the last reusing `reduceCampaign`
  so the sheet can't disagree with the chip that opened it) and served at a new
  `GET /api/issue?project=&issue=` JSON endpoint the sheet fetches. Archived-run
  chips stay inert (their turns live in a different log).
- Cross-project event feed on the all-repos landing (#55). Under the repo cards
  on desktop, a time-ordered activity log spanning every registered project — each
  row showing the time, the event kind, and a one-sentence, repo-prefixed
  description. It is built read-side off the same live-run logs the cards read: a
  pure `formatFeedEvent` folds each event to `describeEvent`'s plain-words sentence
  with the project name in front (machine-noise events carry no row), and `buildFeed`
  merges every project's narratable events newest-first. Served as a new
  `GET /api/feed` JSON endpoint the client shell fetches; the feed is cut on mobile.
- The all-repos landing's parked counter expands in place into a cross-repo parked
  queue (#55). Clicking the counter drops a list of every parked question across all
  repos — issue number, repo, the full question, and how long it has waited, oldest
  first — between the counters and the cards, pushing the cards down while keeping
  them visible; clicking again collapses it. The counter is inert (no arrow, cursor,
  or click) when nothing is parked, and each row opens that repo's issue detail. The
  landing model (`GET /api/landing`) gains a `parked` array carrying those questions;
  the rows are touch-friendly on a phone.
- Campaign view waves now render carved issues, list their titles, and pulse the
  running chip (#55). A carve no longer makes an issue vanish from the campaign
  view: the reconstruction remembers what a carve dropped and renders it as a
  `carved` chip — the sixth ADR 0007 status, derived at render, in its own colour
  and struck through in the wave it left — so a browsing operator sees what was
  carved out (the agent loop and `IssueStatus` are untouched; carved is a view-only
  overlay). Each open wave now lists its issues' titles under the chips, and a
  running chip pulses (reduced-motion aware). Waves stay stacked and full-width on a
  phone.
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

### Changed

- The dashboard now labels each project by its full **`owner/name`** rather than the
  bare project key (#89), everywhere a project is named: the repo-dropdown trigger and
  its rows, and the landing card headings. The `owner/name` is derived at landing-build
  time from each project's `git remote get-url origin` (both the SSH
  `git@github.com:owner/name.git` and HTTPS `https://github.com/owner/name(.git)` forms,
  via a pure, unit-tested `ownerRepoFromRemote` helper); a project with no parseable
  remote (e.g. the demo) falls back to its bare project name. Display-only — the
  `project` registry key, `/?project=<key>` routing, and `data-project` attributes stay
  the bare key.

- The dashboard's native `<select>` project picker is replaced by a **custom repo
  dropdown** (#88) — the toolbar's page heading and the repo switcher in one control,
  shared by the landing and the repo page (#81). Its `.repo-trigger` states the
  current scope as the largest text in the toolbar (`All repos` for the aggregate, the
  full `owner/name` for a repo; mono/600/17px, 15px on mobile, hover teal) and toggles
  a `role="listbox"` popover whose rows carry a run-state status dot (from the shared
  palette #83; `All repos` the teal accent), the `owner/name` label, and a note (the
  repo's run state, or the repo count for `All repos`); the current scope's row is
  filled. Full keyboard/ARIA support (`aria-haspopup`/`aria-expanded`/`aria-controls`,
  Enter/Space/↑↓/Enter/Escape, focus trapped while open and restored on close, a
  visible focus ring), 44px touch rows, and a menu layered above the cards but below
  the issue sheet (so opening the sheet or switching scope closes it). Switching scope
  navigates (resetting the open sheet and per-repo closed-wave state); a `<noscript>`
  keeps the native `<select>` as the no-JS switch.

- `README.md` is brought back in line with the current CLI and layout (#86). The
  Telegram sections now document the host-level `gateway` daemon (sole Telegram
  consumer and sender) and its systemd user service in place of the retired
  per-project `dispatch`/`attend` poller, and link the routing model
  (`destinations`/`notify`) to `docs/gateway.md`. The Modes table matches
  `sandcastle-tdd --help` — `init` and `gateway` added, `dispatch` and `attend`
  dropped. Config/state paths reflect the committed `sandcastle/config.mts` +
  excluded `.sandcastle.local/` layout (including the agent-credential `.env`, now
  `.sandcastle.local/.env`, vs. the host-only bot creds in `orchestrator.env` /
  `gateway.env`). The dashboard prose describes the reinvented all-repos landing —
  counters, per-repo cards, a cross-repo activity feed, an issue-detail sheet with
  carve, and live SSE updates.
- The shipped systemd unit is now `systemd/sandcastle-gateway.service`, the
  host-level gateway service (no `WorkingDirectory`, sourcing
  `~/.config/sandcastle/gateway.env`), replacing the retired
  `systemd/sandcastle-dispatch.service` (#86).

- The repo/campaign page's closed waves now expand and collapse the way the design
  intends (#82), a frontend interaction + render change only. Each closed wave is a
  compact toggle chip (`✓ Wave N  M/M`) in a row under the campaign-meta line, with a
  chevron that flips `›`⇄`⌄` and a green accent while its wave is open; clicking a
  chip reveals that wave's *full* card — the same component an open wave renders (a
  `CLOSED` status pill, its merged issue chips and the `#num title` list) — in the
  shared `waves-grid`, before the open waves and in wave order. Any subset can be open
  at once and each chip toggles only its own card. Previously a closed wave was a
  native `<details>` whose summary dropped a full-width block of *just the issue chips*
  into the chip row. The open set is persisted per repo so a live `/api/events` reload
  no longer silently collapses everything the operator opened; the toggle is keyboard-
  operable with `aria-expanded`, and a `<noscript>` fallback reveals every closed card
  when JS is off. Pinned by `renderStatusPage` regression tests.

- The repo/campaign page's header row and section order now match the design, and
  the top bar is one shared control across every page (#81), a frontend-only
  change. The live indicator is a dot only — its "Live"/"Paused" state is an
  accessible label rather than a visible word — and pause is an icon control (⏸/▶,
  the glyph carried in CSS and flipped by a `data-paused` attribute) instead of the
  "Pause" text button. The top→bottom order on the repo page is now top bar →
  Parked → campaign-meta line → closed waves → open waves (the meta line no longer
  sits above Parked), and the campaign name reads as plain bold text, not the teal
  product accent. The landing and the repo page previously each hand-built their own
  top bar (project dropdown/heading + live-bar), which is how the "Live"-word and
  pause-word survived on the repo page; both now render one shared `renderTopBar` /
  `TOP_BAR_STYLES`, so they cannot drift again. Pinned by `renderStatusPage` /
  `renderLandingShell` regression tests. (The status-colour scoping to `.dot`, this
  issue's other half, landed with the shared colour model in #83.)

- The dashboard's colour is now one shared model across every surface (#83), a
  frontend/visual change only. One `:root` palette is emitted once and consumed by
  the landing, the repo/campaign page and the issue-detail sheet — no per-renderer
  copy — so a token can no longer be defined on one page and missing on another
  (#78: `--color-carved` was absent from the landing root, so carved rendered
  uncoloured across the landing feed, status dots and turn log; it now resolves
  everywhere). State→colour is derived through one helper (`stateColor` /
  `projectRunState`). Concrete visual changes: `failure` renders its own red
  `#f85149`, distinct from the carve action's `#f79287`; `unstarted`/`idle`/`queued`
  render the dim grey `#5f6b78`; issue chips now border their own status at 40%
  alpha with a full-strength dot; card/chip/parked-row hover lifts the fill only and
  never recolours the edge to teal; the run-state precedence is now
  `parked > failure > running` (a parked question outranks a failure); the campaign
  page's status colours are scoped to `.dot` so a state no longer tints whole list
  rows (#81); and the live indicator dot pulses while streaming, going still and dim
  when paused. Pinned by `renderLandingShell`/`renderStatusPage` regression tests
  (palette resolution, derivation + precedence, edge/chip application) and verified
  headless against the served landing, repo page and issue sheet.

- The per-project campaign page (`GET /?project=<repo>`) is restyled to the new
  visual design the all-repos landing already uses (#79). Its top-right now carries
  the landing's live-bar (`● Live · updated Ns ago · Pause`) instead of the old
  fixed-interval `Refresh ☑ [45]` widget: it updates live off the `/api/events`
  stream (ADR 0008), reloading the server-rendered page on a ping — guarded so it
  never reloads while a reply is being composed, and pausable as a client-side
  freeze that flushes on resume. The heading drops the "<project> status" wording
  (the project dropdown serves as the heading, falling back to a bare `<h1>` when no
  dropdown), and a `<name> · N issues · M waves` meta line summarises the campaign.
  Parked issues now render as clickable question cards (yellow left-border, `#num
  question` + a `waiting Nm · reason` meta line) that open the existing issue-detail
  sheet — the reply happens there, so the old inline `/answer` form is gone from the
  campaign page. Closed waves read as `✓ Wave N merged/total` chips, and open waves
  lay out as a responsive grid of wave cards, each with its `Wave N` label, status
  pill, and `merged/total`, plus a status-coloured top accent (blue for the running
  wave, neutral otherwise). State words keep the ADR 0007 vocabulary (`unstarted`,
  not "queued"). The all-repos landing render is unchanged.

### Fixed

- The all-repos landing's recent-activity feed rendered the progress/blue
  event-kind labels (`CAMPAIGN-BATCH`, `QUEUE-START`, `TURN`, …) illegibly — the
  mid-tone `--color-blue` on tiny bold uppercase text over near-black read as a
  strikethrough through the glyphs (#85). Each feed kind now reads its comms
  category as a full-strength leading dot with the label at `--color-text`,
  legible and consistent across every category (matching the shared dot colour
  model, #83). A follow-up removed the remaining squish: the card progress bar's
  bare `.progress` selector (#80) also matched the feed's `feed-kind progress`
  label, boxing and clipping it inside a `.4rem`-tall `--color-secondary`
  background. The bar's selector is now scoped to `.progress-track`, so it no
  longer collides with the feed category class `progress` (#85).

- `defaultFileSet` was all-or-nothing over a ticket's whole body, so one
  incidental filename-shaped token — an env file, a config name, a spec/ADR link
  whose basename the tree lacks — flipped `confident` to `false` even when the
  ticket plainly cited its real files, and `campaign-plan` could schedule nothing
  (#37). It now reads an explicit `Touches:` / `Files:` marker line first (only
  that line's cites count, so incidental prose no longer poisons confidence),
  anchored at a line start (an inline mention of the phrase is not the marker) with
  the last marker line winning; it falls back to the whole-body scan when no marker
  is present. `campaign-plan` also now feeds the resolver the ticket's title+body
  only (via `ticketProse`), so a stray token in any comment can no longer poison
  confidence. The strict confidence contract is unchanged — a cited basename the
  tree lacks still yields `confident: false`, preserving the under-specified halt.
  This repo's own `sandcastle/config.mts` drops its bespoke `fileSet` override in
  favour of the reworked default, so there is one resolver rather than two that
  drift.

- The gateway never delivered a project's Telegram messages when its
  `orchestrator.env` annotated the credentials with inline comments (the shipped
  template's own style: `SANDCASTLE_TELEGRAM_BOT_TOKEN=<token>  # from @BotFather`)
  (#77). `parseEnvFile` stripped surrounding quotes but not inline `#` comments, so
  the bot token carried the comment and Telegram returned 404. It now matches shell
  `source` semantics — an unquoted whitespace-then-`#` starts a comment; a quoted
  value keeps a literal `#` — so the same file the old `dispatch` poller sourced now
  parses identically for the gateway.

- Clicking a pending issue in the all-repos landing's cross-repo parked queue did a
  full navigation to the campaign status page (the older view with the auto-refresh
  control) instead of opening that issue's detail — and it didn't even target the
  specific issue (#74). The landing now hosts the issue-detail sheet and a parked-queue
  row opens it inline (turn log, the parked question with its options, Resume, and
  Carve), with a plain `href` kept only as the no-JS fallback. (The sheet is currently
  duplicated with the campaign page's; unifying them is tracked in #76.)

- The parked-issue reply `<textarea>` overflowed its container, spilling past the
  right edge of the sheet and the parked card (most visible on a narrow phone
  column) (#73). Added `max-width: 100%` to the textarea rule so `width: 100%`
  resolves against its padded content box and introduces no horizontal scroll.

- Hardened the issue-detail sheet's carve panel against the same `[hidden]`-defeat
  bug as the parked queue (#72): `.carve-panel { display: flex }` would override the
  UA `[hidden]` rule, so a non-carvable issue could not hide it. Added
  `.carve-panel[hidden] { display: none }`. (The reported "no Carve on a parked
  issue" symptom did not reproduce on this build — the sheet reveals Carve beside
  Resume for a parked issue — and was traced to a stale deployment predating the
  carve-from-the-sheet feature; this rule is defensive hardening.)

- The cross-repo parked queue on the all-repos landing never collapsed (#71).
  `.parked-queue { display: grid }` overrode the `[hidden]` attribute's UA
  `display: none`, so toggling the parked counter flipped the caret but left the
  panel open. Added the companion `.parked-queue[hidden] { display: none }` rule
  (the same guard the sheet's flex panels already carry).

- An idle project's landing card showed 0% merged and contributed nothing to
  "merged today" even when its last run merged every issue today (#70). Both numbers
  were read from the cleared live log: `buildProjectCard`'s idle branch hardcoded
  `percentMerged: 0`, and `buildLanding`'s merged-today summed only the live log. The
  idle card now reconstructs its latest archived run for a real merged %, and
  merged-today reads that archived run when no live run is in flight — so a completed
  run's merges still surface. Live-run cards are unchanged.

- An idle project's "Last run" summary read `halted` on a run that actually
  completed (#69). `summarizeRun` scanned the whole archived log for a
  `campaign-halt`, so an archive whose live log had accumulated more than one run
  before being archived would fold a stale halt from a superseded earlier run into
  a completed run's summary (and count the wrong run's issues). The run's terminal
  state now derives from `reduceCampaign`'s new run-scoped `halted` flag — everything
  the summary reports is the latest `campaign-start` onward — so a completed run
  reads `complete` and a genuinely halted one still reads `halted`.

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

- Each project card on the all-repos landing now tints its highlight (top border)
  to its run state — running=blue, parked=yellow, failure=red, completed=green,
  idle=grey — matching the run-state pill, instead of a fixed primary/teal for all
  (#75).

- The all-repos landing's activity feed now colours each event kind by its comms
  category (#78) — merges/dones green, a parked question yellow, a halt red, a carve
  purple, in-flight events (starts, waves, turns) blue — instead of one flat teal, so
  the feed scans at a glance.

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
