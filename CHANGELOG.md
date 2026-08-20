# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Auto-refresh on/off checkbox on the status dashboard; both the toggle and the
  interval persist across reloads, and the interval field disables when off.
- The dashboard leads with parked issues, above the waves, whenever any are
  awaiting a response — with an "N awaiting you" badge and a yellow accent. When
  nothing is parked, the page leads with the waves as before.

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
- Local campaign/wave status dashboard (`sandcastle-tdd status`) with parked-issue
  review and inline responses.
- Team walkthrough deck.

[Unreleased]: https://github.com/jjforge/sandcastle-tdd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jjforge/sandcastle-tdd/releases/tag/v0.1.0
