.PHONY: check-changelog-sections check-changelog-sections-test demo-create demo-remove

# Seed / tear down the demo dashboard fixture — a dev fixture, not an operator mode
# (design §12): a set of registered projects that between them render every dashboard
# state, so the status UI can be clicked through without running real agents. Both call
# the same createDemo/removeDemo the coverage test drives, via tsx. `create` is
# idempotent (clear-then-reseed); `remove` deletes only the demo root and its pointers.
demo-create:
	npx tsx scripts/demo.ts create

demo-remove:
	npx tsx scripts/demo.ts remove

# Does any dated CHANGELOG.md milestone repeat a bold section label? A split
# `**Improvements:**` (one block, then another below `**New features:**`) reads as
# absent — a reader finds the first list and stops — and makes "which section does
# this bullet belong in" ambiguous, which is how the split gets written. See
# docs/changelog-conventions.md.
check-changelog-sections:
	scripts/check-changelog-sections.sh

# Unit tests for the lint above (the pure decision functions + end-to-end fixtures).
check-changelog-sections-test:
	bash scripts/check-changelog-sections.test.sh
