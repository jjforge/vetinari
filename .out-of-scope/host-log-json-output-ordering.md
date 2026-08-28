# `host log` output ordering (human newest-first vs `--json` chronological)

`vetinari host log` deliberately orders its two output formats differently, and we
do **not** intend to make them match.

- The **human-readable** default returns rows **newest-first** (`readHostLog` —
  `slice(-limit).reverse()`), because when you eyeball a log at the terminal you
  want the most recent events at the top.
- **`--json`** returns the same most-recent-`N` rows in **chronological (file)
  order** (`readHostLogLines` — `slice(-limit)`, no reverse), because `--json` is a
  raw passthrough meant to be piped into `jq`, `grep`, or another stream processor,
  and those consume events forward in time.

## Why this is out of scope

The divergence is intentional, and both directions are the *right* default for their
audience:

- Both paths already select the **same set** — the most recent `N` events. There is
  no "you asked for the newest 5 but got the oldest 5" bug; `--json -n 5` yields the
  newest 5, emitted oldest→newest.
- Reversing `--json` to match the human view would make the common `host log --json |
  jq` pipeline read events in reverse-time order, which is the surprising one for
  stream tooling. Anyone who wants newest-first from `--json` can `| tac`.

So aligning the two would trade a well-motivated, audience-appropriate default for a
worse one, to satisfy a symmetry that has no practical payoff. If the split ever
causes real confusion, the lighter fix is a one-line note in `--help`/README, not a
behavior change.

## Prior requests

- #184 — "host log --json orders oldest-first while default is newest-first"
  (filed as a self-flagged minor finding during #169 verification; on inspection the
  behavior is by design).
