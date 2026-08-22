# Campaign & wave names — make the archive legible

Source: Glossary [CONTEXT.md](../../CONTEXT.md) (`campaign name`, `wave name`, `run`, `archived run`) · builds on the archived-runs dashboard.

## Problem Statement

Skimming the archived-runs list, I cannot tell what any past run was *for*. A run is
a timestamp plus "campaign · N issues · complete" — never a human label — and inside
it every wave is just "Wave 2/4". The goal is simple: **look through the archive and
know what was done.** A run needs an optional name, and a wave needs a label drawn
from what it actually contains.

## Solution

A campaign takes an **optional name** — `campaign --name "…"` — recorded on the
`campaign-start` event and shown as the primary label wherever a run appears: the
live header, the archived-runs list, and the archived-run view (falling back to the
timestamp when unnamed, so tonight's already-archived runs stay readable).
`campaign-plan` **suggests** a name from the area labels the selected issues span
("gateway + comms + dashboard") — a line you paste as `--name` or edit.

A **wave name** is **derived at render** from the titles of the issues the wave holds
— one issue shows that issue's title, several show the lead title + "+N" — so a wave
reads as its work, not a bare index. Wave names are never stored and never an epic:
a wave is a file-disjoint layer that crosses epics, so its issues, not an epic, name
it (epics are the right basis for the *campaign* name, not a wave).

## User Stories

1. As a maintainer, I want to name a campaign with `campaign --name "…"`, so that a run records what it was for.
2. As a maintainer, I want the name recorded on the run's `campaign-start` event, so that it survives into the archive with the run.
3. As a maintainer, I want the campaign name shown as the primary label in the archived-runs list, so that I can skim the archive and know what each run did.
4. As a maintainer, I want the name on the live header and the archived-run view too, so that a run is labelled everywhere it appears.
5. As a maintainer, I want an unnamed run to fall back to its timestamp (with the existing mode · issue-count · outcome summary), so that older and unnamed runs stay legible.
6. As a maintainer, I want `campaign-plan` to suggest a name from the area labels of the selected issues, so that I get a sensible default to paste or edit rather than inventing one.
7. As a maintainer, I want each wave labelled by the titles of its issues, so that a wave reads as its work instead of "Wave 2/4".
8. As a maintainer, I want a single-issue wave to show that issue's title and a multi-issue wave to show the lead title + "+N", so that the label stays scannable while the chips still carry every title.
9. As a maintainer, I want wave names derived at render from the issue titles the dashboard already resolves, so that they need no storage and never go stale.
10. As a maintainer, I want naming to be entirely optional, so that `campaign "17" "18"` with no name still works exactly as before.

## Implementation Decisions

- **`--name` on `campaign`.** The `campaign` CLI mode gains an optional `--name "…"`;
  `campaign` records it on the `campaign-start` event (`{ batches, slots, name? }`).
  Absent, no name is recorded and everything falls back to the timestamp — no
  behaviour change for unnamed runs.
- **Name surfaces via `reduceCampaign`/status.** `reduceCampaign` reads the name off
  `campaign-start`; `buildStatus`/the archived-run summary carry it. The archived-runs
  list shows the name as the primary label, timestamp + parsed summary secondary. The
  live header and archived-run view show it too. Unnamed → timestamp.
- **`campaign-plan` suggests from area labels.** `campaign-plan` fetches the selected
  issues' area labels (the `orchestrator`/`gateway`/`comms`/`dashboard`/`layout`/
  `launcher` set) and prints a suggested `--name` line joining the distinct areas
  ("gateway + comms + dashboard"). It is a suggestion in the provenance output, not
  something the tool stores or enforces.
- **Wave name derived at render.** In the status render, a wave's label is computed
  from its issues' resolved titles (the dashboard already resolves them): one issue →
  its title; several → the lead issue's title + "+N". Nothing is stored on the wave; no
  event changes. The chips keep showing every title on hover/tap.
- **Epics name campaigns, not waves.** The area/epic flavour lives on the *campaign*
  name (the whole selected set has a coherent area span); a *wave* is named by its
  issues because it crosses epics by construction.

## Testing Decisions

- **What makes a good test here.** Assert external behaviour on plain inputs, as
  `status.test.ts` and `plan`'s tests already do. Given a `campaign-start` event with a
  `name`, `reduceCampaign` surfaces it and the rendered list/header show it; given none,
  the timestamp fallback shows. Given a wave of one/several issues with titles, the
  derived wave label is the title / lead-title-plus-N. Given a selected set with area
  labels, `campaign-plan`'s suggestion joins the distinct areas. No browser, no network
  (label/title lookups injected).
- **Modules tested.** (1) `campaign` records `name` on `campaign-start` (event asserted,
  spawn/loop injected as today). (2) `reduceCampaign`/render — name surfaces as the
  primary label; unnamed falls back to timestamp; the derived wave label for one vs many
  issues. (3) `campaign-plan` suggestion — distinct areas joined, over an injected
  label resolver.
- **Prior art.** `status.test.ts` (status from tmp logs, rendered-HTML assertions),
  `reduceCampaign`'s tests (the reduction), and the `campaign-plan` tests (pure planning
  over injected resolvers).

## Out of Scope

- **LLM-suggested names.** The suggestion is a heuristic over area labels; no agent/LLM
  naming step (there is no such job in the loop today).
- **Renaming an existing/archived run.** The name is set at launch via `--name`; editing
  a past run's name is not built.
- **Epic-based wave names.** Rejected — waves cross epics, so an epic does not identify a
  wave. Epics inform the campaign-name suggestion instead.
- **Storing wave names.** Derived at render only.

## Further Notes

- The two halves have different natures, which is why they are built differently: a
  campaign name is *intent* and must be stored on the event; a wave name is *derivable*
  from data the dashboard already has, so it is computed at render. The archive gains
  legibility from both — the name is what you scan, the wave labels are what you read once
  you open a run.
