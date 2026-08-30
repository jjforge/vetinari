# E5: Multi-project dashboard

Epic: [#16](https://github.com/jjforge/vetinari/issues/16) · Source: [ADR 0002](../../adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) · Glossary: [CONTEXT.md](../../../CONTEXT.md)

## Problem Statement

The status dashboard shows exactly one project — the one whose config the server was
started with, on its own port. Once I am running agents across several projects at
once, that is not enough: to watch them all I would have to start a separate server
per project, each on a different port, and keep a mental note of which is which.
There is no single page that shows me every project the gateway is serving.

## Solution

The gateway — which already knows every registered project and where its state lives
— hosts one status site with a **project dropdown**. I pick a project from the
dropdown and the page shows that project's campaign/wave and parked status, exactly
as the single-project dashboard does today. The per-project standalone status server
stays available for running one project on its own port without a gateway.

## User Stories

1. As a maintainer, I want one status site that lists every registered project, so
   that I can watch all my running projects from one place.
2. As a maintainer, I want a dropdown to switch between projects, so that I can move
   from one project's status to another without changing URLs by hand.
3. As a maintainer, I want the selected project's campaign/wave and parked status to
   render just as the single-project dashboard does, so that I lose no detail by using
   the aggregated view.
4. As a maintainer, I want the site to default to a project when I open it with no
   selection, so that I see something useful immediately.
5. As a maintainer, I want the project list to come from the gateway registry, so that
   a project I have run shows up with no extra configuration.
6. As a maintainer, I want a registered project whose state directory is missing to be
   skipped rather than breaking the page, so that one stale registration cannot take
   down the whole dashboard.
7. As a maintainer, I want the aggregated site hosted by the gateway on one port, so
   that there is a single place to point my browser.
8. As a maintainer, I want the existing per-project status server to still work on its
   own port, so that I can run one project standalone without a gateway.
9. As a maintainer, I want the parked-question answer control to keep working in the
   aggregated view for the selected project, so that I can act on a question from the
   same page I monitor from.
10. As a maintainer, I want the page to reflect each project's own campaign/wave state
    accurately, so that switching projects never shows me stale or mixed data.

## Implementation Decisions

- **Reuse `buildStatus` per project.** The existing single-project status builder is
  unchanged; the multi-project view is a thin layer over it.
- **New `buildAllStatus(registry)`.** For each registered project, load its config from
  its base location and call the existing `buildStatus`, returning the per-project
  statuses. A project whose state/base location is missing is skipped (with a log
  line), matching the gateway's tolerance for stale registrations.
- **Extend `renderStatusPage` with a project selector.** The rendered page gains a
  dropdown of the registered projects and renders the selected one. The existing
  per-project rendering is reused for the body.
- **Gateway hosts the aggregated server.** The gateway serves the site, reads the
  registry for the project list, and selects the project from a request parameter,
  defaulting to the first. The existing standalone `serveStatus` on its own port
  remains as the no-gateway fallback.
- **Answer control stays.** The dashboard's existing parked-question answer action
  continues to work for the selected project, routing to that project.
- **Read-only over state.** Like today, the dashboard reads state files; it does not
  drive Docker, the agent, or Telegram.

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs: given a
  registry of projects with state on disk, the aggregated status lists them and each
  carries that project's data; given a project with missing state, it is skipped;
  given a rendered page, the HTML contains the project dropdown and the selected
  project's content. No browser, no network.
- **Modules tested.** (1) `buildAllStatus` — several registered projects each with tmp
  state, and a stale (missing) one skipped, driven by a fake registry. (2) The extended
  `renderStatusPage` — the dropdown lists the projects and the selected project's
  status renders. (3) The existing `buildStatus` continues to pass its current tests
  unchanged.
- **Prior art.** `status.test.ts` is the direct model — it already builds status against
  tmp state dirs and asserts on rendered HTML. `carve.test.ts` for the registry-as-fake
  pattern.

## Out of Scope

- **The gateway daemon and the registry themselves** — E3 (#14). E5 only *reads* the
  registry to list projects.
- **The comms taxonomy / notify map** — E4 (#15). The dashboard is monitoring, not
  outbound routing.
- **Triggering actions across projects** (e.g. carve from the dashboard) — that is the
  separate follow-up #11.
- **Authentication / remote hosting** — the dashboard's existing host/port model is
  unchanged.

## Further Notes

- The whole epic is a thin extension over well-tested existing code (`buildStatus`,
  `renderStatusPage`, `status.test.ts`), which is why it is the smallest of the five
  and depends only on the registry (#22).
- The per-project standalone server staying as a fallback keeps a single project usable
  with no gateway at all — consistent with the dashboard being read-only over state.
