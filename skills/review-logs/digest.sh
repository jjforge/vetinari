#!/usr/bin/env bash
# Digest one project's vetinari logs into per-task and per-event summaries.
# Usage: digest.sh <project-root> [since-iso-date]
# Prints TSV blocks; reads only, writes nothing. Notification, gateway and
# dashboard events are dropped: the subject is the run, not its plumbing.
set -euo pipefail
root=${1:?project root}
since=${2:-0000}
logs="$root/.vetinari.local/logs"
[ -d "$logs" ] || { echo "no logs at $logs" >&2; exit 1; }

orch() { cat "$logs"/archive/orchestrator-*.jsonl "$logs"/orchestrator.jsonl 2>/dev/null \
  | jq -c --arg s "$since" 'select((.ts // "") >= $s)
      | select((.event // "") | test("^(outbound-|telegram-|status-|gateway-)") | not)' 2>/dev/null; }

echo "## event counts (orchestrator logs)"
orch | jq -r '.event // "null"' | sort | uniq -c | sort -rn

echo; echo "## task outcomes (last outcome per task)"
orch | jq -r 'select(.taskId and (.event|test("^(green|failed|parked|empty-green|merged)$")))
  | [.ts, .taskId, .event, (.reason // ""), (.detail // "")] | @tsv' \
  | sort | awk -F'\t' '{last[$2]=$0} END {for (t in last) print last[t]}' | sort -t$'\t' -k3,3 -k2,2n

echo; echo "## per-task activity: task turns tools execs gateFails minutes"
for f in "$logs"/activity-*.jsonl; do
  [ -e "$f" ] || continue
  jq -s -r --arg s "$since" '
    map(select((.ts // "") >= $s)) | select(length > 0) |
    def mins: ((.[-1].ts | sub("\\.[0-9]+Z$";"Z") | fromdate) - (.[0].ts | sub("\\.[0-9]+Z$";"Z") | fromdate)) / 60 | floor;
    [ .[0].taskId,
      (map(select(.event=="turn")) | length),
      (map(select(.event=="tool")) | length),
      (map(select(.event=="sandbox-exec")) | length),
      (map(select(.event=="gate-result" and (.exitCode // 0) != 0)) | length),
      mins ] | @tsv' "$f" 2>/dev/null || echo "$(basename "$f")	unparseable"
done | sort -t$'\t' -k6,6nr

echo; echo "## failing gate runs (cmd, exit, outFile)"
orch | jq -r 'select(.event=="gate-result" and (.exitCode // 0) != 0) | [.ts, .cmd, .exitCode, (.outFile // "")] | @tsv'

echo; echo "## hotspot files: tasks-that-touched  edits  path"
cat "$logs"/activity-*.jsonl 2>/dev/null | jq -r --arg s "$since" '
  select(.event=="tool" and .path and (.ts // "") >= $s)
  | [.taskId, (if (.name|test("Edit|Write")) then "e" else "r" end), (.path | sub("^/home/agent/workspace/";""))] | @tsv' 2>/dev/null \
  | awk -F'\t' '{k=$3; if (!seen[k SUBSEP $1]++) tasks[k]++; if ($2=="e") edits[k]++}
      END {for (k in tasks) printf "%d\t%d\t%s\n", tasks[k], edits[k], k}' | sort -rn | head -25
