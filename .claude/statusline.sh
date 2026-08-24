#!/usr/bin/env bash
# sandcastle-tdd status line: two lines for the Claude Code status bar (matches
# jjforge's setup).
#   line 1 — the user's default status line (model · dir · branch · context%),
#            i.e. ~/.claude/statusline.sh.
#   line 2 — the sandcastle campaign line (🏰 …), so this repo keeps its
#            wave/ticket status under the richer first line.
# Claude Code feeds one JSON blob on stdin and blanks the bar on a non-zero
# exit, so this reads stdin once, feeds it to both, and never fails hard: a
# missing piece just narrows what prints.
input=$(cat)

default_sl="$HOME/.claude/statusline.sh"
proj="${CLAUDE_PROJECT_DIR:-.}"

# Line 1: prefer the user's default status line (it carries the context%).
line1=""
if [ -x "$default_sl" ]; then
  line1=$(printf '%s' "$input" | "$default_sl" 2>/dev/null)
fi

# Sandcastle emits its own model·dir·branch line then the 🏰 campaign line.
# Keep the campaign line; fall back to its first line only if the default
# status line above produced nothing. This repo IS sandcastle-tdd, so invoke
# its CLI through the package's own tsx (no npm layer — fast enough for a 5s
# refresh); stderr carries a deprecation notice, so drop it.
sc_out=""
if [ -x "$proj/node_modules/.bin/tsx" ]; then
  sc_out=$(printf '%s' "$input" | "$proj/node_modules/.bin/tsx" "$proj/src/cli.mts" statusline 2>/dev/null)
fi
sc_line1=$(printf '%s\n' "$sc_out" | sed -n '1p')
sc_rest=$(printf '%s\n' "$sc_out" | sed -n '2,$p')

[ -z "$line1" ] && line1="$sc_line1"

[ -n "$line1" ] && printf '%s\n' "$line1"
[ -n "$sc_rest" ] && printf '%s\n' "$sc_rest"
