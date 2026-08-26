#!/usr/bin/env bash
# Answer one question about CHANGELOG.md: DOES ANY DATED MILESTONE CARRY THE SAME
# BOLD SECTION LABEL TWICE?
#
# A milestone groups its bullets under bold labels — `**New features:**`,
# `**Improvements:**`, `**Bug fixes:**` and the rest (the set is fixed in
# docs/changelog-conventions.md). Each is meant to appear at most once per
# milestone: a reader scanning for improvements finds the first `**Improvements:**`
# list and stops, so a second one below it is invisible, and "which section does
# this bullet belong in" turns ambiguous for whoever adds the next bullet — which
# is how a split section gets written in the first place.
#
# The convention names the labels but never said "once each", so nothing caught a
# milestone that grew two. This makes the rule checkable.
#
# It FAILS CLOSED when discovery finds no milestone heading at all: a file with no
# `### ` heading is a moved/renamed changelog, not a clean one, and reporting
# "0 milestones, all clean" would be a guard-that-checked-nothing bug.
#
# Usage:
#   scripts/check-changelog-sections.sh              # check the repo CHANGELOG.md
#   scripts/check-changelog-sections.sh --file PATH  # check PATH instead (tests)
#   scripts/check-changelog-sections.sh --help       # this header
#
# Exit codes: 0 = every milestone uses each label at most once, 1 = at least one
# milestone repeats a label, or discovery found no milestone.

# `-e` off, deliberately: this is a report that must keep counting so the first
# duplicate does not hide the rest.
set -uo pipefail

# --- pure decisions (unit-tested by check-changelog-sections.test.sh) ---------

# A milestone boundary. Every changelog milestone is an h3 (`### <name> — <date>`);
# the file's only other headings are the h1 title and none in between, so any
# `### ` line opens a new milestone.
is_milestone_heading() { # <line>
	case "${1-}" in
	'### '*) return 0 ;;
	*) return 1 ;;
	esac
}

# The section label a line carries, or nothing. A label is a whole line of the
# form `**Words:**` — bold, ending in a colon inside the bold. This deliberately
# rejects the lookalikes the file contains: `**Reading this file.**` ends in `.`
# not `:`, and the intro's inline `` `**Breaking changes:**` sorts first`` is not
# a whole-line match because the backtick and trailing prose are outside the
# bold. Returns the inner text (`New features`) so the caller keys on it.
changelog_label() { # <line>
	local line="${1-}"
	if [[ "$line" =~ ^\*\*([^*]+):\*\*$ ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
	fi
}

# --- report ------------------------------------------------------------------

check_changelog() {
	local file=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--file)
			if [ $# -lt 2 ]; then
				echo "ERROR: --file needs a path" >&2
				return 1
			fi
			file="$2"
			shift 2
			;;
		--help | -h)
			awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
			return 0
			;;
		*)
			echo "ERROR: unknown argument '$1' (expected --file PATH or --help)" >&2
			return 1
			;;
		esac
	done
	[ -n "$file" ] || file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CHANGELOG.md"
	if [ ! -f "$file" ]; then
		echo "ERROR: --file '$file' is not a file" >&2
		return 1
	fi

	echo "==> checking section labels in $file"

	local lineno=0 line label
	local milestone="" milestone_line=0
	local milestones=0 problems=0
	# label -> line number where it was first seen in the current milestone.
	local -A seen=()

	while IFS= read -r line || [ -n "$line" ]; do
		lineno=$((lineno + 1))

		if is_milestone_heading "$line"; then
			milestones=$((milestones + 1))
			milestone="${line#### }"
			milestone_line="$lineno"
			seen=()
			continue
		fi

		# A label before the first milestone heading is preamble (the intro table
		# and reading guide), not part of any milestone — ignore it.
		[ "$milestones" -gt 0 ] || continue

		label="$(changelog_label "$line")"
		[ -n "$label" ] || continue

		if [ -n "${seen[$label]+set}" ]; then
			echo "    DUP  '$milestone' (line $milestone_line)"
			echo "         **$label:** appears at line ${seen[$label]} and again at line $lineno"
			problems=$((problems + 1))
		else
			seen[$label]="$lineno"
		fi
	done <"$file"

	echo
	echo "==> result"
	if [ "$milestones" -eq 0 ]; then
		echo "    ERROR: found no '### <name> — <date>' milestone heading." >&2
		echo "    Refusing to report success for a changelog with no milestones." >&2
		return 1
	fi
	if [ "$problems" -eq 0 ]; then
		echo "    $milestones milestone(s); every one uses each section label at most once"
		return 0
	fi
	echo "    $problems repeated label(s) above. Merge each into the milestone's single"
	echo "    block for that label — a second list of the same name reads as absent."
	return 1
}

# Only run when executed, not when sourced by the tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	check_changelog "$@"
fi
