#!/usr/bin/env bash
# Symlink vetinari's operator skills (./skills) into ~/.claude/skills, so every
# project on this machine sees one copy that tracks this checkout.
# Safe to re-run. Refuses to clobber a real (non-symlink) entry, links the
# rest, and exits non-zero if any skill was skipped.
set -euo pipefail
shopt -s nullglob

script="$(readlink -f "${BASH_SOURCE[0]}")"
repo="$(cd "$(dirname "$script")/.." && pwd)"
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

skills=("$repo"/skills/*/)
if [ ${#skills[@]} -eq 0 ]; then
  echo "no skills found in $repo/skills" >&2
  exit 1
fi

mkdir -p "$dest"
skipped=0
for skill in "${skills[@]}"; do
  name="$(basename "$skill")"
  target="$dest/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip  $name: $target exists and is not a symlink" >&2
    skipped=$((skipped + 1))
    continue
  fi
  ln -sfn "${skill%/}" "$target"
  echo "link  $name -> $target"
done

if [ "$skipped" -gt 0 ]; then
  echo "$skipped skill(s) not linked; move the real entries aside and re-run" >&2
  exit 1
fi
