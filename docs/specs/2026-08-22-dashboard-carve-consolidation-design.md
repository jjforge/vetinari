# One dashboard + inline carve in the tap-detail panel

Source: [ADR 0006](../adr/0006-one-dashboard-registry-backed-aggregated-server.md), [ADR 0005](../adr/0005-carve-is-an-event-that-prunes-the-running-campaign.md), [ADR 0002](../adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) · Glossary: [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

Carving from the dashboard already works (E5 #33/#35), but the UX is heavier than
it should be for a phone-over-the-tailnet flow: the trigger is a ✂️ button on
every carvable chip, and confirming means navigating to a **separate full-page
preview** and back. I want carving to be easy and fast, visually quiet, and still
guarded by an "are you sure" — without leaving the dashboard. Separately, there
are two status servers to maintain (standalone single-project and gateway-hosted
aggregated), which is duplication now that every project auto-registers.

## Solution

There is **one dashboard**: the `status` CLI mode serves the registry-backed
aggregated `serveAllStatus` (a single-project user is a one-entry dropdown); the
standalone `serveStatus` and its full-page `renderCarvePreview` are retired (ADR
0006). Carve moves off the chips entirely: each chip already opens a tap-to-open
**issue-detail panel**, so a **Carve** button lives *in that panel*, shown only
when the issue is carvable. Tapping it fetches the closure on demand and shows an
**inline confirm** right in the panel — "carve #640, also drops #641, #655 —
Confirm / Cancel" — so nothing destructive happens without disclosure, and you
never leave the page. The aggregated site's server-side preview stays as a no-JS
fallback.

## User Stories

1. As a maintainer on my phone, I want to carve by tapping an issue and pressing one button, so that it is fast and thumb-friendly.
2. As a maintainer, I want no carve control cluttering the chips themselves, so that the wave view stays visually quiet.
3. As a maintainer, I want the Carve button to appear only for a carvable issue (unstarted / future-wave / parked), so that I am never offered a carve that would do nothing.
4. As a maintainer, I want tapping Carve to show me exactly what it will remove (the target plus its transitive dependents) before anything happens, so that I do not fat-finger away more than I meant to.
5. As a maintainer, I want to confirm or cancel that carve inline in the detail panel, so that I never navigate away from the dashboard.
6. As a maintainer, I want the closure computed only when I actually intend to carve, so that the dashboard does not do expensive dependency lookups for every chip on every refresh.
7. As a maintainer, I want a brief "carving…" acknowledgement and then the chip to drop from the plan on the next refresh, so that I can see the carve took effect.
8. As a maintainer with JavaScript off or broken, I want a server-side form fallback that still previews-then-carves, so that a destructive action is never left unguarded.
9. As a maintainer, I want one status dashboard, so that I am not maintaining or choosing between two servers.
10. As a maintainer running a single project with no gateway, I want the dashboard to still work, so that retiring the standalone server costs me nothing (I see a one-entry dropdown).
11. As a maintainer, I want the inline carve to route to the selected project in the dropdown, so that on a multi-project view the right project is carved.
12. As a maintainer, I want the confirm to disclose the closure the same way whether I use the inline path or the no-JS fallback, so that the safety guarantee does not depend on JavaScript.

## Implementation Decisions

- **`status` CLI mode serves the aggregated dashboard.** The mode calls
  `serveAllStatus` over the host registry (`listProjects`), not the single-project
  `serveStatus`. No gateway daemon is required — the registry, populated by
  auto-register, is enough (ADR 0006).
- **Retire the standalone path.** Delete `serveStatus` and the standalone
  `renderCarvePreview`. The aggregated `renderAggregatedCarvePreview` (server-side,
  dry-run-based) remains as the no-JS carve fallback.
- **Carve lives in the issue-detail panel, not on chips.** Remove
  `renderCarveControl` from the chips. Each chip carries the data the panel needs
  (`issueNumber`, its `project`, and whether it is carvable). When the panel opens
  for a carvable issue, it renders a **Carve** button; the panel is richer than
  today's plain text.
- **On-demand closure preview.** A new lightweight `GET /carve?preview` (JSON)
  returns the closure `{ target, removed }` for a `taskId`+`project`, computed via
  the project's own `blockedBy` (`computeCarve`). The panel calls it when Carve is
  tapped, then shows the removed list and a Confirm/Cancel.
- **Inline confirm; confirm still POSTs.** Confirming issues the existing
  `POST /carve` with `confirm=1` (which shells the project's `carve`, appending the
  carve event — ADR 0005). After POST, show a transient "carving…" state and let
  the next refresh drop the chip. Cancel just collapses the confirm.
- **Progressive enhancement.** The chip→panel→inline-confirm path is layered on
  top of a plain `<form>` POST that, with no JS, still reaches the server-side
  preview page and carves. The safety guarantee (disclose-then-confirm) holds in
  both paths.
- **Selected-project routing.** On the aggregated view the panel's carve carries
  the selected `project` so both the preview fetch and the confirm target the right
  project's install (parity with the existing `/answer` and `/carve` routing).

## Testing Decisions

- **What makes a good test here.** Assert external behavior on plain inputs. The
  server pieces are pure-ish over state + injected spawn/preview: given a registry
  and a `GET /carve?preview`, the JSON closure returned; given a `POST /carve` with
  `confirm`, the project's `carve` is spawned (spawn injected). The rendered page:
  chips carry the carve data attributes, a carvable issue's panel affords carve, a
  non-carvable one does not, and no ✂️ renders on chips. No browser, no network.
- **Modules tested.** (1) `serveAllStatus` — the new `GET /carve?preview` returns
  the closure for the selected project (preview injected), and `POST /carve`
  confirm spawns the right project's carve. (2) `renderStatusPage` (aggregated) —
  chips carry `issueNumber`/`project`/carvable; the panel markup hosts a carve
  affordance only for carvable issues; chips no longer render an inline ✂️. (3) The
  `status` CLI mode resolves to `serveAllStatus` (the standalone `serveStatus`
  tests are removed with it). Client-side panel JS is exercised by asserting the
  rendered markup/data it keys off, as the existing refresh script is.
- **Prior art.** `status.test.ts` already builds status against tmp state and
  asserts on rendered HTML and on the `/answer` and `/carve` handlers with an
  injected spawn — the direct model for both the render assertions and the route
  handlers.

## Out of Scope

- **Changing what a carve does** — unchanged (ADR 0005: append a carve event, prune
  the running campaign, keep banked work). This is UX + server consolidation only.
- **The Telegram carve flow** (#34) — untouched; this is the dashboard side.
- **Bulk or wave-level carve** — carve stays per-issue.
- **New dependency on the gateway daemon** — explicitly avoided; the dashboard
  needs only the registry.

## Further Notes

- The one load-bearing reversal (retiring the standalone server) is safe only
  because auto-register makes the registry always present; that is recorded in ADR
  0006 so a future reader does not "restore" the standalone server without knowing
  why it went.
- The tap-to-open detail panel already exists in the page script; hosting the
  carve affordance there is why this is a small change rather than new UI — the
  chip is the tap target, the panel is the surface, and the confirm is one more
  fetch + POST the page already knows how to make.
