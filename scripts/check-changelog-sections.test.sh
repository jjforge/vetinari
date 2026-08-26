#!/usr/bin/env bash
# Unit tests for check-changelog-sections.sh — drive the pure decision functions
# directly, and the end-to-end report against fixture files under a temp dir. No
# writes to the repo, no network.
#
# Two things carry the weight. The LOOKALIKES: the changelog's intro contains
# strings that resemble a section label (`**Reading this file.**`, an inline
# `` `**Breaking changes:**` ``) and must NOT be counted, or the gate is red on an
# untouched tree and stops being read. The FAIL-CLOSED case: a file with no
# milestone heading is an error, not "0 milestones, all clean".
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=./check-changelog-sections.sh
source ./check-changelog-sections.sh

fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check() { # <label> <expected> <actual>
	if [ "$3" = "$2" ]; then
		echo "  ok    $1 :: ${2:-<none>}"
	else
		echo "  FAIL  $1 :: expected '$2', got '$3'"
		fail=1
	fi
}

# ---------------------------------------------------------------------------
echo "== changelog_label: the things it must catch =="
check "a plain label" "New features" "$(changelog_label '**New features:**')"
check "a two-word label" "Bug fixes" "$(changelog_label '**Bug fixes:**')"
check "improvements" "Improvements" "$(changelog_label '**Improvements:**')"

echo "== changelog_label: the things it must NOT catch =="
check "a reading guide bold, ends in a dot" "" "$(changelog_label '**Reading this file.**')"
check "an inline, backticked mention" "" "$(changelog_label '`**Breaking changes:**` sorts first in a milestone')"
check "a bullet that names a label" "" "$(changelog_label '- the **Improvements:** list now merges')"
check "a plain bullet" "" "$(changelog_label '- Split a review in two (#342)')"
check "a milestone heading" "" "$(changelog_label '### Review model — August 2, 2026')"

echo "== is_milestone_heading =="
is_milestone_heading '### Review model — August 2, 2026' && r=yes || r=no
check "an h3 opens a milestone" yes "$r"
is_milestone_heading '# Changelog' && r=yes || r=no
check "the h1 title does not" no "$r"
is_milestone_heading '**New features:**' && r=yes || r=no
check "a label does not" no "$r"

# ---------------------------------------------------------------------------
echo "== check_changelog end to end =="

# A clean file: two milestones, each label used once. Includes the lookalike
# intro so a clean tree really is clean.
cat >"$tmp/clean.md" <<'EOF'
# Changelog

**Reading this file.** Every change is logged.
`**Breaking changes:**` sorts first in a milestone.

### Second thing — August 3, 2026

**New features:**
- [user] something (#2)

**Improvements:**
- [user] better (#3)

### First thing — August 2, 2026

**Improvements:**
- [user] a (#1)
- [user] b (#1)

**Bug fixes:**
- [user] fixed (#1)
EOF
if check_changelog --file "$tmp/clean.md" >/dev/null 2>&1; then
	check "a clean file passes" pass pass
else
	check "a clean file passes" pass fail
fi

# A milestone with two Improvements blocks fails, and names the label.
cat >"$tmp/dup.md" <<'EOF'
# Changelog

### Review model — August 2, 2026

**Improvements:**
- [user] a (#1)

**New features:**
- [user] feat (#2)

**Improvements:**
- [user] c (#3)

**Bug fixes:**
- [user] fixed (#4)
EOF
out="$(check_changelog --file "$tmp/dup.md" 2>&1)" && rc=0 || rc=1
check "a repeated label fails the run" 1 "$rc"
case "$out" in
*"Improvements"*) check "the report names the label" found found ;;
*) check "the report names the label" found "missing (got: $(printf '%s' "$out" | tr '\n' ' '))" ;;
esac

# The same label in DIFFERENT milestones is fine — the reset is per milestone.
cat >"$tmp/two-milestones.md" <<'EOF'
# Changelog

### Later — August 3, 2026

**Improvements:**
- [user] a (#1)

### Earlier — August 2, 2026

**Improvements:**
- [user] b (#2)
EOF
check_changelog --file "$tmp/two-milestones.md" >/dev/null 2>&1 && rc=0 || rc=1
check "same label across milestones is fine" 0 "$rc"

# Fail closed: a file with no milestone heading is an error, not a pass.
printf '# Changelog\n\nno milestones here\n' >"$tmp/empty.md"
check_changelog --file "$tmp/empty.md" >/dev/null 2>&1 && rc=0 || rc=1
check "no milestone heading is fatal" 1 "$rc"

# Argument handling.
check_changelog --file >/dev/null 2>&1 && rc=0 || rc=1
check "a lone --file errors" 1 "$rc"
check_changelog --file "$tmp/does-not-exist.md" >/dev/null 2>&1 && rc=0 || rc=1
check "a nonexistent file errors" 1 "$rc"

# ---------------------------------------------------------------------------
echo "== the repo's own CHANGELOG.md =="
repo_changelog="$(cd .. && pwd)/CHANGELOG.md"
check_changelog --file "$repo_changelog" >/dev/null 2>&1 && rc=0 || rc=1
check "the checked-in CHANGELOG.md is clean" 0 "$rc"

# ---------------------------------------------------------------------------
echo
if [ "$fail" -ne 0 ]; then
	echo "FAILED"
	exit 1
fi
echo "all green"
