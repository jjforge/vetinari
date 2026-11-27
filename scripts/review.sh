#!/usr/bin/env bash
# review.sh: the executable half of docs/review-rubric.md.
#
# Runs every [auto] criterion and prints pass/fail per id; prints the [judged] and
# [env] ids as JUDGED / UNVERIFIED so the reviewer knows what still needs a person,
# with the evidence lists a judgement starts from. The score itself is recorded by
# the /score-repo skill: these results plus the judged verdicts.
#
# Usage: scripts/review.sh            # full report; ratchet exit code
#        scripts/review.sh --quick    # skip the full suite and the history secret scan
#        scripts/review.sh --strict   # exit non-zero on ANY fail (ignore the baseline)
#
# Exit code (ratchet): 0 when the failing ids match scripts/review-baseline.txt
# exactly; non-zero on a REGRESSION (a new fail) or a STALE entry (a baselined id
# that now passes: tighten the baseline). Same rubric version as the doc (RUBRIC_VER).
set -uo pipefail

RUBRIC_VER="1.0"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

BASELINE=scripts/review-baseline.txt
QUICK=false
STRICT=false
for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
    --strict) STRICT=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

fails=()
pass() { printf '  pass        %-4s %s\n' "$1" "$2"; }
fail() { printf '  FAIL        %-4s %s\n' "$1" "$2"; fails+=("$1"); }
unverified() { printf '  unverified  %-4s %s\n' "$1" "$2"; }
judged() { printf '  judged      %-4s %s\n' "$1" "$2"; }
evidence() { sed 's/^/                   /'; }
check() { # check <id> <label> <cmd...>: pass when the command exits 0
  local id=$1 label=$2; shift 2
  if "$@" >/dev/null 2>&1; then pass "$id" "$label"; else fail "$id" "$label"; fi
}
has_gh() { command -v gh >/dev/null && gh auth status >/dev/null 2>&1; }

# Non-test sources, and their code lines with comment-only lines dropped.
SRC=()
for f in src/*.ts src/*.mts; do
  case $f in *.test.ts | *.test.mts | *test-support* | src/test-setup.ts) ;; *) SRC+=("$f") ;; esac
done
code_lines() { grep -nE "$1" "${SRC[@]}" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'; }
run_tests() { npx tsx --test --import "$PWD/src/test-setup.ts" "$@"; }

echo "vetinari review: rubric v$RUBRIC_VER at $(git rev-parse --short HEAD)"

echo "1. Safety of the operator's work & credentials"
judged 1.1 "merge reaches the base only on a green merged gate"
hits=$(code_lines '"reset", *"--hard"|reset --hard|"clean", *"-[a-zA-Z]*f|"push",.*"(--force|-f)"|push (--force|-f)|filter-branch|"rebase"')
if [ -z "$hits" ]; then pass 1.2 "no reset --hard / clean -f / forced push / history rewrite"; else
  fail 1.2 "destructive git in the sources"; echo "$hits" | evidence; fi
code_lines '"branch", *"-D"|"worktree", *"remove", *"--force"' | evidence
if $QUICK; then unverified 1.3 "history secret scan (skipped: --quick)"; else
  secrets=$(git log -p --all -- . ':(exclude)src/*.test.ts' ':(exclude)src/*test-support*' |
    grep -E '^\+' | grep -E '[0-9]{8,10}:[A-Za-z0-9_-]{35}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk-ant-[A-Za-z0-9_-]{20,}' |
    grep -vE '\$\{|/\\b|pattern:' | cut -c1-60)
  if [ -z "$secrets" ]; then pass 1.3 "no secret in git history"; else
    fail 1.3 "secret-shaped strings in git history (truncated)"; echo "$secrets" | evidence; fi
fi
check 1.5 "loose credential modes are detected and named" grep -q 'chmod 600' "${SRC[@]}"
if code_lines '\?\? *"127\.0\.0\.1"' >/dev/null && [ -z "$(code_lines '\?\? *"0\.0\.0\.0"')" ]; then
  pass 1.6 "dashboard binds loopback by default"; else fail 1.6 "dashboard default bind is not loopback"; fi
judged 1.4 "credentials stay out of logs, the dashboard and unneeded containers"
judged 1.7 "unsandboxed execution is opt-in and announced"

echo "2. Orchestration correctness & recovery"
judged 2.1 "an interrupted campaign resumes cleanly"
judged 2.2 "every task ends in a named terminal state"
judged 2.3 "shared host state is written atomically under a lock"
echo "                   writeFileSync outside writeFileAtomic:"
code_lines 'writeFileSync\(' | grep -v '^src/atomic-write.ts' | evidence
check 2.4 "pipeline integration tests pass" run_tests src/campaign-e2e.test.ts src/pipeline.test.ts
judged 2.5 "the host lease never oversubscribes"
judged 2.6 "no unbounded external call on a campaign path"
echo "                   synchronous child processes without a timeout:"
code_lines 'spawnSync\(|execFileSync\(|execSync\(' | grep -v timeout | evidence
unverified 2.7 "a supported host completes a real campaign [env: read the newest campaign logs]"

echo "3. Gates & build health"
check 3.1 "typecheck" npm run typecheck
check 3.2 "lint" npm run lint
check 3.3 "format" npm run format:check
if $QUICK; then unverified 3.4 "full suite (skipped: --quick)"; unverified 4.4 "suite under 5 min (skipped: --quick)"; else
  start=$(date +%s)
  if npm test >/tmp/vetinari-review-suite.$$ 2>&1; then pass 3.4 "full suite green"; else
    fail 3.4 "full suite red"; sed -n '/failing tests:/,$p' /tmp/vetinari-review-suite.$$ | grep -E '^✖' | grep -v 'failing tests' | cut -c1-110 | evidence
    grep -E '^ℹ (pass|fail)' /tmp/vetinari-review-suite.$$ | evidence; fi
  secs=$(($(date +%s) - start)); rm -f /tmp/vetinari-review-suite.$$
  if [ "$secs" -lt 300 ]; then pass 4.4 "suite took ${secs}s (< 300s)"; else fail 4.4 "suite took ${secs}s (>= 300s)"; fi
fi
if has_gh; then
  red=$(gh issue list --state open --limit 500 --json number,title,labels --jq \
    '.[] | select((.labels | map(.name) | index("known-red")) or (.title | test("flak|intermittent"; "i"))) | "#\(.number) \(.title)"')
  if [ -z "$red" ]; then pass 3.5 "no open known-red or flaky test"; else fail 3.5 "open known-red / flaky tests"; echo "$red" | evidence; fi
else unverified 3.5 "no gh login"; fi
if grep -q 'ubuntu-' .github/workflows/*.yml && grep -q 'macos-' .github/workflows/*.yml; then
  pass 3.6 "CI runs on Linux and macOS"; else fail 3.6 "CI misses Linux or macOS"; fi
unpinned=$(grep -hE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -vE '@[A-Za-z0-9._-]+\s*$' ; grep -hE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -E '@(main|master|HEAD|develop|trunk)\s*$')
if [ -z "$unpinned" ]; then pass 3.7 "CI actions pinned to a tag or SHA"; else fail 3.7 "CI action on a mutable ref"; echo "$unpinned" | evidence; fi

echo "4. Test quality"
# Exercised = its own test file, imported by a test, imported by a module that has its
# own test file (one hop: a route module served through status.ts), or an entry script
# an npm script runs.
imports() { grep -qE "from \"\./$1(\.m?ts|\.m?js)?\"|import\(\"\./$1(\.m?ts|\.m?js)?\"\)" "${@:2}"; }
untested=()
for f in "${SRC[@]}"; do
  m=$(basename "$f"); m=${m%.*}
  [ -f "src/$m.test.ts" ] && continue
  imports "$m" src/*.test.ts && continue
  grep -q "src/$(basename "$f")" package.json && continue
  hop=false
  for g in "${SRC[@]}"; do
    n=$(basename "$g"); n=${n%.*}
    [ -f "src/$n.test.ts" ] && imports "$m" "$g" && { hop=true; break; }
  done
  $hop || untested+=("$f")
done
if [ ${#untested[@]} -eq 0 ]; then pass 4.1 "every source module is exercised by a test"; else
  fail 4.1 "${#untested[@]} module(s) no test imports"; printf '%s\n' "${untested[@]}" | evidence; fi
judged 4.2 "tests are hermetic"
judged 4.3 "timing-sensitive tests wait on events, not sleeps"
judged 4.5 "fixed bugs carry a reproducing test"

echo "5. Architecture & seams"
check 5.1 "no layer-spanning import cycle" run_tests src/import-cycles.test.ts
big=$(wc -l "${SRC[@]}" | awk '$2 != "total" && $1 > 1500 {print $2 " (" $1 " lines)"}')
if [ -z "$big" ]; then pass 5.2 "no source module over 1500 lines"; else fail 5.2 "god-module(s)"; echo "$big" | evidence; fi
check 5.3 "consumer contract holds" npm run check-contract
check 5.4 "no retired vocabulary" run_tests src/vocabulary.test.ts
judged 5.5 "modules are deep"
judged 5.6 "configuration has one resolution path"

echo "6. Operability & observability"
judged 6.1 "no silent failure path"
echo "                   swallowed errors:"
code_lines 'catch *(\([^)]*\))? *\{ *\}|\.catch\(\(\) => *(\{\}|undefined|null)\)' | cut -c1-120 | evidence
judged 6.2 "refusals are actionable"
hostlog=${VETINARI_GATEWAY_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/vetinari}/logs/host.jsonl
if [ -f "$hostlog" ] && command -v jq >/dev/null; then
  cutoff=$(date -u -v-24H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)
  recurring=$(jq -r --arg c "$cutoff" 'select(.ts > $c and (.event | test("-(failed|unavailable|refused|error)$"))) | .event' "$hostlog" |
    sort | uniq -c | awk '$1 >= 3 {print $2 " x" $1}')
  if [ -z "$recurring" ]; then pass 6.3 "no recurring failure in the last 24h of host.jsonl"; else
    fail 6.3 "recurring failures in the last 24h of host.jsonl"; echo "$recurring" | evidence; fi
else unverified 6.3 "no host log (or no jq) on this machine"; fi
judged 6.4 "every supported platform has a documented, tested service path"

echo "7. Docs, vocabulary & tracker hygiene"
nums=$(grep -nE '#[0-9]{2,}' CLAUDE.md AGENTS.md CONTEXT.md docs/adr/*.md | grep -vE '"#[0-9]')
if [ -z "$nums" ]; then pass 7.1 "no issue numbers in always-on docs"; else
  fail 7.1 "issue numbers in always-on docs"; echo "$nums" | cut -c1-120 | evidence; fi
missing=()
for d in skills/*/; do n=$(basename "$d"); grep -q "/$n\`" docs/user-guide.md || missing+=("$n"); done
if [ ${#missing[@]} -eq 0 ]; then pass 7.2 "the user guide names every operator skill"; else
  fail 7.2 "skills missing from the user guide: ${missing[*]}"; fi
frags=$(find changelog.d -type f ! -name '.*' 2>/dev/null)
if [ -z "$frags" ]; then pass 7.3 "no uncollected changelog fragment"; else fail 7.3 "uncollected fragments"; echo "$frags" | evidence; fi
if has_gh; then
  stale=$(gh issue list --state open --label pending-verify --limit 200 --json number,title,updatedAt --jq \
    "map(select(.updatedAt < \"$(date -u -v-14d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)\"))[] | \"#\(.number) \(.title)\"")
  if [ -z "$stale" ]; then pass 7.5 "pending-verify queue is fresh"; else fail 7.5 "pending-verify older than 14 days"; echo "$stale" | evidence; fi
else unverified 7.5 "no gh login"; fi
judged 7.4 "user-facing changes are logged"
judged 7.6 "docs describe current behaviour"

# Ratchet against the baseline.
echo
actual=$(printf '%s\n' ${fails[@]+"${fails[@]}"} | sed '/^$/d' | sort -V)
expected=$( [ -f "$BASELINE" ] && grep -vE '^\s*(#|$)' "$BASELINE" | awk '{print $1}' | sort -V)
echo "failing: ${actual:-none}" | tr '\n' ' '; echo
if $STRICT; then [ -z "$actual" ]; exit; fi
regressions=$(comm -23 <(echo "$actual") <(echo "$expected") | sed '/^$/d')
stale=$(comm -13 <(echo "$actual") <(echo "$expected") | sed '/^$/d')
$QUICK && stale=$(echo "$stale" | grep -vxE '1\.3|3\.4|4\.4')
[ -n "$regressions" ] && echo "REGRESSION (not in $BASELINE): $(echo $regressions)"
[ -n "$stale" ] && echo "STALE baseline (now passing; remove from $BASELINE): $(echo $stale)"
[ -z "$regressions" ] && [ -z "$stale" ]
