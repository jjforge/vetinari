# Changelog conventions

Reference for how [`CHANGELOG.md`](../CHANGELOG.md) is written. The always-true rules — log every user-facing change as part of landing it, cite the issue, do it in the same slice — live in [`CLAUDE.md`](../CLAUDE.md) and are enforced on every campaign agent by [`prompts/tdd.md`](../prompts/tdd.md); this is the format and the vocabulary.

The shape follows the sibling [`jjforge`](https://github.com/jjforge/jjforge) project's `docs/agents/changelog.md`: **dated milestones, newest first, each with audience-tagged bullets grouped under bold section labels.** It is deliberately *not* the Keep-a-Changelog `[Unreleased]` + `Added/Changed/Removed/Fixed` structure — that older shape is what this format replaced.

## Audience tags — every bullet opens with exactly one

Each bullet starts with a tag naming who the change reaches, so a reader scanning for their concern can filter by it:

| Tag | Visible to |
| --- | --- |
| `[user]` | someone **using** Vetinari — the CLI and its output, the status line, the dashboard, observable behaviour |
| `[ops]` | someone **running** it — config surface, env vars, `migrate`, the host gateway, systemd |
| `[api]` | a **programmatic contract** — exported functions, the event-log schema, the dashboard's HTTP/JSON endpoints |
| `[internal]` | nothing externally observable — refactors, tests, docs, plumbing |

Pick the highest-reach tag that fits: a change a user sees is `[user]` even if it also touched internals. `[internal]` is for work with *no* externally observable effect.

## Milestones — a dated heading per shipped theme, newest first

A milestone is a `### <what changed> — <Month DD, YYYY>` heading. The title is a plain descriptive sentence (what changed, not an issue number or a bracketed prefix); the date is when the work landed. Milestones are ordered **newest first**, directly under the header. A tagged release folds the milestones above it under a `### vX.Y.Z — <date>` heading (the format is otherwise identical).

**Which milestone does a new entry go in?** If the top milestone's title and date already describe your work (same theme, same day), add your bullet to it. Otherwise add a **new milestone at the top**, dated today, with a short title naming what you changed. Do not resurrect a `[Unreleased]` bucket.

## Section labels — bold, one block per label per milestone

Within a milestone, bullets are grouped under bold section labels, in this order:

1. `**Breaking changes:**` — sorts first; names the contract it broke (a removal, a rename, a changed default).
2. `**New features:**` — a new command, flag, endpoint, or capability.
3. `**Improvements:**` — a refinement to existing behaviour or output.
4. `**Bug fixes:**` — something that was broken now works.
5. `**Documentation:**` — docs/ADR/README changes worth surfacing.

A milestone uses only the labels it needs, and **each label appears at most once** per milestone — collect every bullet of a kind under the single block, never a second header for the same label.

## Issue numbers are welcome here

`CHANGELOG.md` is a **dated record**, so citing issue numbers is correct and expected — `(#134)`, `(#118, #121)` — unlike the always-on / current-truth docs where CLAUDE.md's no-numbers rule applies. Cite the issue the change implements; a change spanning several cites them all.

## Example

```markdown
### The status line installs itself and wraps an existing one — August 25, 2026

**New features:**
- [user] `vetinari statusline install` / `statusline uninstall` (#134) — wire the status
  line into the project's committed `.claude/settings.json` …

**Bug fixes:**
- [user] `statusline install` no longer blanks the colours on line 1 when a status line is
  configured at the user level (#135). …
```
