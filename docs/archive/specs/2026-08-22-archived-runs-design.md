# Archived runs in the dashboard

Source: [ADR 0006](../../adr/0006-one-dashboard-registry-backed-aggregated-server.md) · Glossary: [CONTEXT.md](../../../CONTEXT.md) (`run`, `archived run`)

## Problem Statement

The dashboard shows only a project's **live run** — the current `orchestrator.jsonl`.
But every finished `campaign`/`queue` already archives its event log to
`logs/archive/orchestrator-<timestamp>.jsonl` (kept, never deleted), and there is no
way to see those past runs. I want to browse a project's archived runs from the
dashboard, open any one and see its wave/issue view exactly as it looked, and drop
to its raw event log when I need the detail.

## Solution

The aggregated dashboard grows an **"Archived runs"** section under the selected
project's live status: a list of that project's archived runs, newest first, each
line a parsed one-line summary (mode, issue count, outcome) so a run is findable by
more than a bare timestamp. Selecting a run re-renders the page for that run — the
same wave/issue view as live, driven by the existing `buildStatus` reading the
archived log instead of the current one — but **read-only** (a finished run has
nothing to carve or answer). From an archived run you can open its **raw event log**
(the JSONL, as text). Agent/gate logs are live-only scratch and out of scope (see
Out of Scope). No new server, no new render engine — it is the existing
`serveAllStatus` + `buildStatus` pointed at an archived log.

## User Stories

1. As a maintainer, I want an "Archived runs" list for the selected project, so that I can see every past campaign/queue run without digging through the filesystem.
2. As a maintainer, I want each archived run shown with a one-line summary (mode, issue count, complete/halted), so that I can find the run I mean without opening it.
3. As a maintainer, I want the list newest-first, so that the most recent run is at the top.
4. As a maintainer, I want to click an archived run and see its full wave/issue view exactly as the live dashboard renders it, so that I read a past run with no new UI to learn.
5. As a maintainer, I want the archived-run view to be read-only — no carve buttons, no answer form — so that a finished run's controls do not imply I can act on it.
6. As a maintainer, I want to open an archived run's raw event log (the JSONL) as plain text, so that I can inspect the exact events when the rendered view is not enough.
7. As a maintainer, I want a run addressed by its archive timestamp and resolved against the actual archive listing, so that a crafted request cannot read files outside the archive.
8. As a maintainer on a single-project setup, I want the archived section to work the same (one-entry dropdown), so that archiving is not a multi-project-only feature.
9. As a maintainer, I want the live run to keep showing at the top regardless, so that opening an archived run is an addition, not a mode switch that hides the present.
10. As a maintainer, I want an archived run that is unreadable or malformed to be skipped rather than break the page, matching how the dashboard already tolerates missing project state.

## Implementation Decisions

- **List comes with the page.** `buildAllStatus` (or a sibling) additionally lists
  each project's `logs/archive/orchestrator-*.jsonl`, so the "Archived runs" section
  renders from data the page already loads. Each entry's summary is produced by
  running the existing `reduceCampaign` over that archived log and reading its
  mode/issues/outcome — the same reducer the live view uses.
- **Render a past run via a `run` query param.** The archived-run view reuses
  `GET /` with a `run=<timestamp>` parameter beside `project=` (mirroring the project
  dropdown): when present, `buildStatus` reads that archived log instead of the live
  one, and `renderStatusPage` renders it. No new page.
- **Archived render is read-only.** The archived view renders with `carve: false`
  and no parked-answer form — a completed run has nothing to act on. This is the only
  behavioural difference from the live render.
- **Raw event log via one small route.** `GET /archive/log?project=…&run=…` returns
  the archived JSONL as `text/plain` (as-is, no pretty-printing). The "Archived runs"
  section and the archived-run view link to it.
- **Run identity is a timestamp token, resolved against the listing.** A run is
  addressed by its archive timestamp; the server resolves it by listing the project's
  archive directory and matching, never by joining request input into a path. Anything
  not in the listing is a 404 — the guardrail against path traversal.
- **Tolerate a bad archive.** An archived log that is missing or unparseable is
  skipped from the list (with a log line), the same tolerance `buildAllStatus` already
  applies to a project with missing state.

## Testing Decisions

- **What makes a good test here.** Assert external behaviour on plain inputs, as
  `status.test.ts` already does against tmp state. Given a project whose archive dir
  holds a few `orchestrator-*.jsonl` files, the archived-runs list returns them
  newest-first with the right per-run summary; a malformed one is skipped. Given
  `GET /` with a `run=` param, the page renders that archived log's status, read-only
  (no carve control, no answer form in the markup). Given the raw-log route, a valid
  `run` returns its JSONL and a `run` not in the listing returns 404 (the traversal
  guard). No browser, no network.
- **Modules tested.** (1) The archived-runs lister — several archive files → summaries
  newest-first; a malformed file skipped. (2) `serveAllStatus` — `GET /?run=` renders
  the archived status read-only; `GET /archive/log` returns the log for a listed run
  and 404s an unlisted/crafted `run`. (3) The summary derivation over `reduceCampaign`
  for a plain archived event array.
- **Prior art.** `status.test.ts` (builds status against tmp logs, asserts on rendered
  HTML and on route handlers) is the direct model; `reduceCampaign`'s own tests cover
  the reduction the summary reuses.

## Out of Scope

- **Agent/gate logs per archived run.** `agent-*.log`/`gate-*.log` are live-only
  scratch — overwritten across runs and not archived — so historical per-run agent/gate
  logs do not exist. Snapshotting them into the archive is a separate follow-up; this
  feature exposes the **event log** only.
- **Pretty-printing or a rendered event timeline** for the raw log — it is served
  as-is.
- **Retention / pruning.** Archives are listed in full (never deleted today);
  bounding their growth is a later concern, not built here.
- **Acting on an archived run** (carve/answer) — it is read-only by construction.

## Further Notes

- The feature is deliberately thin because the reconstruction already exists:
  `buildStatus` reads whatever log it is handed, so a past run renders through the
  same path as the present one — the work is listing the archives, a summary line, a
  `run=` param, one raw-log route, and suppressing the action controls.
