# Dashboard card and chip colouring rules

Normative. These rules describe every coloured surface in the dashboard. If a new
surface does not fit a rule below, it is not a new rule — pick the existing one it
most resembles.

This spec is the **single source of truth** for dashboard colour. It is implemented
as shared code, not per-renderer copies: one palette (`DASHBOARD_PALETTE_CSS`), one
state→colour derivation (`stateColor` / `stateBorderColor` and `projectRunState`),
and one card/chip application, all in `src/dashboard-render.ts` (with the run-state
roll-up in `src/dashboard-model.ts`) and consumed verbatim by every surface — the
all-repos landing (`renderLandingShell`), the repo/campaign page (`renderStatusPage`),
and the issue-detail sheet they share. No surface defines a colour or re-derives a
state locally, so a token can never be "defined in one root, missing in the other".

The status vocabulary is ADR 0007's: **running · parked · failure · completed ·
unstarted · carved**. The landing's cross-repo aggregate counters keep their own
wording (`working` / `parked` / `queued` / `merged today`) because those are
cross-repo counts, not per-issue statuses — the colours map the same, the labels
differ.

## 1. The state palette

Every colour that carries meaning comes from this table. There are six states and
one action.

| State          | Hex       | Used for                                                    |
| -------------- | --------- | ----------------------------------------------------------- |
| `running`      | `#6cb6ff` | an agent is working it now                                  |
| `parked`       | `#c8a24e` | agent asked a question, waiting on a human                  |
| `failure`      | `#f85149` | a run errored out without parking                           |
| `unstarted`    | `#5f6b78` | in a later wave, no agent assigned                          |
| `completed`    | `#3fb984` | landed on the base                                          |
| `carved`       | `#a371f7` | removed from the running campaign                           |
| _carve action_ | `#f79287` | the carve control and its confirmation only — never a state |

`unstarted` is the grey `#5f6b78` — planned but not being worked, needs nothing from
you. `carved` keeps its own purple `#a371f7`, so an issue removed from the campaign
reads distinctly from one merely not yet started.

`failure` (`#f85149`, Primer `danger.fg`) is deliberately a **different red** from
the carve action `#f79287` — the carve action is a control, never a state, so the two
reds never mean the same thing and must not look identical.

`#3fb9b0` (teal) is the product accent — primary buttons, links, focus. It is **not**
a state and must never appear on a status chip or a card edge.

Neutral surfaces, shared by everything:

| Token        | Hex       | Role                                             |
| ------------ | --------- | ------------------------------------------------ |
| page         | `#090c10` | app background                                   |
| panel / chip | `#0b0e12` | toolbar, sheet foot, chip fill                   |
| card         | `#10151b` | every card fill                                  |
| border       | `#232b35` | default 1px card edge                            |
| hairline     | `#1b212a` | in-card dividers, list rows                      |
| text         | `#e6edf3` | primary                                          |
| muted        | `#8b98a5` | secondary, labels                                |
| dim          | `#5f6b78` | tertiary, counts, timestamps, `unstarted`/`idle` |

## 2. Which edge gets the colour

A card carries state colour on exactly one edge. Which edge encodes what kind of
thing it is.

**Top border, 2px — "this thing has a state."**
The card represents a unit of work whose state changes over time. The colour is that
state.

- Repo card → the repo's run state
- Open wave card → the wave's state
- Expanded closed wave card → always `completed`
- Issue detail sheet → the issue's state

**Left border, 3px — "this thing needs you."**
Reserved for the human-action queue. Always `parked` amber, because parked is the
only state that waits on a person. Never any other colour.

- Parked row in the cross-repo queue
- Parked card at the top of a campaign
- The parked-question block inside the issue sheet

**Full border, 1px — "this is a control or a confirmation."**
The whole outline takes the colour.

- Status pills and issue chips (§4)
- The parked counter when it is non-zero (`#c8a24e`)
- The carve confirmation box (`#f79287`)

Never two coloured edges on one element. Never a coloured bottom or right border.

## 3. How the colour is selected

Always derived, never authored per instance (`stateColor` / `projectRunState`):

- **Issue** → its own status.
- **Wave** → the state of the work in it. An open wave takes its own status; a closed
  wave is `completed` by definition.
- **Repo** → its run state: `running` if any agent is working, `parked` if the oldest
  thing blocking is a question, and the dim grey `#5f6b78` when idle.
- **Counter** → the state it counts. Only the parked counter is ever coloured on its
  edge, because it is the only actionable one.

Precedence when a card could claim two states:
`parked > failure > running > unstarted > completed`. The most human-blocking state
wins — a repo with one parked issue and four running agents reads parked, because
that is the thing that needs a person. `failure` ranks just below `parked`: it also
needs a human, but a parked question is the more direct ask.

## 4. What cards and chips share

Chips (status pills, issue chips) and cards use the same palette and the same
derivation, and differ only in how the colour is applied:

|                  | Card                    | Chip                                              |
| ---------------- | ----------------------- | ------------------------------------------------- |
| Fill             | `#10151b`               | `#0b0e12` (darker — chips sit _on_ cards)         |
| Colour placement | one edge (§2)           | full 1px border at 40% alpha (`stateBorderColor`) |
| Radius           | 12px                    | 999px                                             |
| Text             | full-strength `#e6edf3` | number `#e6edf3`, status word `#8b98a5`           |
| Dot              | none                    | 8px, full state colour                            |

The chip's dot is the only element that renders a state colour at full strength on a
small surface. Chip borders are muted to 40% so a wave of a dozen chips does not
vibrate; the dots still let you count states at a glance.

Chips never take a coloured fill. A tinted chip would compete with the card it sits
on. Tally chips (counts, not states) keep a neutral `#232b35` border.

## 5. Motion tied to colour

Motion is a second channel for one state only: `running`.

- A running chip's dot pulses (`chip-pulse`).
- The live indicator dot pulses only while an agent is running (motion signals
  active work, not merely a connected stream): idle (0 running) is still, and it
  goes still and `#5f6b78` when paused.

Nothing else animates its colour. No pulsing on parked — parked is urgent but
static, and a blinking amber row across a long queue is unreadable. All motion is
reduced-motion aware.

## 6. Interactive affordance

Colour also signals whether a surface is clickable, consistently:

- **Non-zero parked counter**: amber border, amber arrow, pointer cursor.
- **Zero parked counter**: `#232b35` border, transparent arrow, default cursor.
- **Other counters**: never interactive, never coloured on the edge.
- **Hover on a card**: fill lifts `#10151b` → `#131a21`. The edge colour never
  changes on hover.
- **Hover on a chip**: fill lifts `#0b0e12` → `#151d24`. Border unchanged.

If a surface carries `cursor: pointer` it must do something. A coloured edge alone
does not imply clickability — repo cards and parked rows are clickable, wave cards
are not.

## 7. Worked examples

**Repo card, two agents running, one parked issue**
Top border `#c8a24e` (parked wins by precedence). Fill `#10151b`, 1px `#232b35` on
the other three edges. Tally chips inside: "2 running" with a `#6cb6ff` dot, "1
parked" with `#c8a24e`, "5 queued" with `#5f6b78` — each on `#0b0e12` with a
`#232b35` border, since tally chips are counts, not states, and take no coloured
border.

**Open wave, mixed statuses**
Top border is the wave's own status colour. Inside, each issue chip borders its own
status at 40%. A wave holding a parked issue does not turn amber — only the chip
does. The parked card lifted to the top of the campaign is what surfaces it.

**Issue sheet, parked**
Sheet top border `#c8a24e`. Status dot `#c8a24e`. Question block left border 3px
`#c8a24e`. `Resume` filled teal `#3fb9b0` (accent, not state). `Carve` outlined
`#f79287` (action, not state). Three colours, three different jobs, no ambiguity.

**Issue sheet, completed**
Sheet top border `#3fb984`. No carve control at all — carving something already
landed is not an action, and offering it would contradict the explainer text.

## 8. Status and category words are only ever scoped selectors

A status word (§1: `running` · `parked` · `failure` · `completed` · `unstarted` ·
`carved`, plus the landing's `queued`/`idle` aliases and a wave's `closed`) and a
feed comms category (`feedKindClass`: `success` · `attention` · `failure` ·
`carved` · `progress`) are **modifiers**, applied to an element that already has a
component base class — `<a class="card running">`, `<span class="feed-kind
progress">`, `<span class="dot parked">`. So they only ever appear in **compound**
selectors: `.card.running`, `.feed-kind.progress`, `.dot.parked`. **Never write a
bare `.running { … }` or `.progress { … }` top-level rule.**

The hazard is a _dual-use_ word — one used both as a component base and as a
modifier. A bare `.progress { height; background; overflow }` for the card's
progress bar also matched the feed's `feed-kind progress` category label and boxed
it (#85, twin of the #81/#83 status-word leak that filled whole wave rows). The
fix each time is to scope: the bar became `.progress-track`; the status words moved
to `.dot.<word>`. A component base class _may_ be a bare single word (`.card`,
`.feed`, `.counter`, `.wave`, `.chip`, `.dot`) — that is legitimate — **provided
its word is not also a status/category modifier**. Prefix or `.dot`-style-scope the
moment those two uses would share a word.

This is guarded: a test asserts neither page emits a bare top-level rule for any
status/category word, so a re-introduced collision fails the suite.
