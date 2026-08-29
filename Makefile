.PHONY: check-changelog-sections check-changelog-sections-test

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
