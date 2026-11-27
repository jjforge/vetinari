# Repository Review Rubric

**Rubric version: 1.0**. Bump it on ANY change to a criterion, a weight, or a scoring rule, and record the version in each Score-history entry; scores under different versions aren't directly comparable. The checker (`scripts/review.sh`) carries the same `RUBRIC_VER` and changes with it.

This is a pinned, reproducible rubric for principal-level reviews of vetinari. It exists so we can gauge where the repo stands, round over round, on fixed axes.

- **Scoring a round:** run the `/score-repo` skill.
- **The scoring method** (the four states, provisional grades, letter bands, severity gates, the ratchet, the score-history format) is that skill's [`method.md`](../skills/score-repo/method.md). This file adds only what is specific to vetinari.

## Critical classes for vetinari

These are stop-ship irrespective of the average:

- **Red advances.** A campaign starts new work on, pushes, or reports as merged a base its gate failed. Wave integration is non-atomic by design (ADR 0013): greens merge onto the base before the merged-base gate, and a red result stays there, parked, to be fixed forward. That is not this class. Building on it or shipping it is.
- **The operator's work is destroyed.** vetinari discards uncommitted changes, rewrites history, or deletes a branch or worktree it didn't create.
- **A credential leaks.** A bot token, an API key, or an OAuth token is committed, logged, sent to the dashboard, or exposed beyond the private network.
- **A campaign can't run on a supported host.** No supported platform/sandbox pair (Linux + Docker, macOS + Docker, macOS + host sandbox) can complete a campaign.

## Categories & weights

| # | Category | Weight |
|---|----------|--------|
| 1 | Safety of the operator's work & credentials | 20% |
| 2 | Orchestration correctness & recovery | 20% |
| 3 | Gates & build health | 15% |
| 4 | Test quality | 15% |
| 5 | Architecture & seams | 10% |
| 6 | Operability & observability | 10% |
| 7 | Docs, vocabulary & tracker hygiene | 10% |

**The thesis the weights encode.** vetinari runs unattended against the operator's own repos, with their credentials. Its outages are therefore made of two things: lost or corrupted work, and campaigns that hang, mis-merge, or fail silently. Categories 1–2 are 40% for that reason. Build health and test quality come next (30%): a red or flaky suite turns every campaign's gate into noise. The rest is how cheaply the next change lands.

**Verification tags.**
- **[auto]**: `scripts/review.sh` checks it. It detects the class, not one string.
- **[judged]**: needs reading, with the evidence cited.
- **[env]**: needs a host the reviewer may lack, e.g. Linux with Docker or a Mac with Xcode. It is `unverified` until run there.

`scripts/review.sh --quick` skips the slow checks (the full suite and the git-history secret scan) and prints them `unverified`.

### 1. Safety of the operator's work & credentials (20%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 1.1 | Red never advances past the merged-base gate | 3 | [judged] Read the wave-integration path (`merge.ts`, `modes.ts`). Each branch's own gate is green before it merges. A red merged base parks the campaign (`red-base`) and is announced. No later wave starts on it, and nothing pushes it. Name the tests that pin each part. |
| 1.2 | Destructive git touches only refs and worktrees vetinari created | 3 | [auto] The non-test sources have no `reset --hard`, `clean -f`, forced push, or history rewrite. The checker lists each `branch -D` / `worktree remove --force` as evidence; each must target the run's branch prefix or its own worktree. |
| 1.3 | No secret is in the repo's history | 3 | [auto] A pattern scan of the whole `git log -p` (Telegram bot tokens, `ghp_`/`github_pat_`, `sk-ant-`) finds nothing outside test fixtures and redaction-pattern definitions. |
| 1.4 | Credentials stay out of logs, the dashboard, and agent containers they aren't meant for | 2 | [judged] Event rows and the dashboard never carry a token. Redaction covers agent output. Only the credentials a run needs are injected (ADR 0011's layers). |
| 1.5 | Loose credential-file modes are detected and named | 1 | [auto] Some start path checks `.env`/`host.env` modes and prints the `chmod` that fixes them. |
| 1.6 | The dashboard is private-network only by default | 1 | [auto] The default bind is loopback. A wider bind is an explicit flag or env, per ADR 0021. |
| 1.7 | Running without isolation is opt-in and announced on every start | 1 | [judged] Every sandbox provider that doesn't isolate the agent is chosen explicitly in config, and every launch names it. |

### 2. Orchestration correctness & recovery (20%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 2.1 | A campaign interrupted at any point resumes without redoing merged work or losing parked work | 3 | [judged] Kill a running campaign (or read the crash paths), then `redrive`. Merged issues aren't re-run, parked issues keep their reason, and in-flight runs are recovered or re-queued. Cite the tests. |
| 2.2 | Every task ends in a named terminal state; none silently disappears | 2 | [judged] Each exit path of a run (error, timeout, signal, empty-green, question, conflict) maps to an outcome in the status vocabulary (ADR 0007, ADR 0019). |
| 2.3 | Shared host state is written atomically and under a lock | 2 | [judged] The registry, lease, and state files go through `writeFileAtomic` plus `withFileLock*`. List every other `writeFileSync` on a shared path, and justify it or file it. |
| 2.4 | The pipeline is integration-tested end to end through a local sandbox | 2 | [auto] `campaign-e2e.test.ts` and `pipeline.test.ts` pass (ADR 0018). |
| 2.5 | The host lease never oversubscribes the machine | 1 | [judged] `MAX_CONCURRENT_CONTAINERS` and each project's cap bound concurrent runs across all projects. Cite the lease tests. |
| 2.6 | No external call on a campaign path can hang unbounded | 2 | [judged] Every git, gh, docker, Telegram, or agent call on the campaign path has a timeout, a cap, or a documented reason it can't hang. List the synchronous child-process calls that have none. |
| 2.7 | A supported host completes a real campaign | 2 | [env] A campaign on each supported platform/sandbox pair you can reach merges at least one issue green. Read the newest campaign logs; a pair not run recently is `unverified`. |

### 3. Gates & build health (15%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 3.1 | Typecheck is clean | 2 | [auto] `npm run typecheck` |
| 3.2 | Lint is clean | 1 | [auto] `npm run lint` |
| 3.3 | Formatting is clean | 1 | [auto] `npm run format:check` |
| 3.4 | The full suite is green | 3 | [auto] `npm test` exits 0. |
| 3.5 | No open known-red or flaky test | 2 | [auto] `gh`: no open issue labelled `known-red`, and none titled as a flake or intermittent failure. |
| 3.6 | CI runs every gate on every supported OS | 1 | [auto] The workflow runs the gates on Linux and macOS. |
| 3.7 | Third-party CI actions are pinned to an immutable ref | 1 | [auto] Every `uses:` is pinned to a tag or SHA, never a branch (`@main`, `@master`). |

### 4. Test quality (15%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 4.1 | Every source module is exercised by the suite | 3 | [auto] Each non-test module in `src/` meets one of these, checked against a discovered list, not a fixed one: it has its own test file; a test imports it; a module with its own test file imports it (for example, a route served through `status.ts`); or an npm script runs it. |
| 4.2 | Tests are hermetic | 2 | [judged] Each test uses its own temp dirs and env. None reads the operator's `~/.config/vetinari`, a real `.vetinari.local`, or the network. Check `test-setup.ts` and sample the tests that touch HOME. |
| 4.3 | Timing-sensitive tests synchronise on events, not wall-clock sleeps | 2 | [judged] Sample the suite's `setTimeout`/sleep waits. A test that races a fixed delay is how load-dependent flakes start. |
| 4.4 | The suite is fast enough to run before every commit | 1 | [auto] `npm test` takes under 5 minutes, timed with 3.4. |
| 4.5 | Fixed bugs carry a test that reproduces them | 2 | [judged] Sample the five most recently closed `Bug` issues. Each fix commit adds or changes a test that fails without it. |

### 5. Architecture & seams (10%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 5.1 | No runtime import cycle spans a layer | 1 | [auto] `import-cycles.test.ts` passes. |
| 5.2 | No source module is a god-module | 2 | [auto] No non-test source over 1,500 lines. A module that size is a hotspot that every wave collides on. |
| 5.3 | The external consumer contract holds | 2 | [auto] `npm run check-contract` passes (ADR 0027). |
| 5.4 | The defined vocabulary is the only vocabulary | 1 | [auto] `vocabulary.test.ts` passes: no retired term survives in the sources. |
| 5.5 | Modules are deep: small interfaces over real behaviour | 2 | [judged] Sample the modules the newest waves touched most. Each change landed behind an existing seam, not by threading a new parameter through several layers. |
| 5.6 | Configuration has one resolution path | 1 | [judged] Every config value resolves through ADR 0011's layers. No module reads env or files that the layers already own. |

### 6. Operability & observability (10%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 6.1 | No failure path is silent | 2 | [judged] Each swallowed error, such as an empty `catch` or `.catch(() => null)`, either logs a named event, falls back to a state the caller reports, or is a deliberate best-effort with a reason. The checker lists them as evidence. |
| 6.2 | Refusals are actionable | 2 | [judged] Sample `Refusal` messages. Each one names the condition and the command or edit that fixes it. |
| 6.3 | The host log carries no unexplained recurring failure | 2 | [auto] No failure event (`*-failed`, `*-unavailable`, `*-refused`, `*-error`) appears three or more times in the last 24h of `~/.config/vetinari/logs/host.jsonl`. An open issue tracks a failure; it doesn't make it pass. It is `unverified` with no host log on this machine. |
| 6.4 | Every supported platform has a documented, tested service path | 1 | [judged] The gateway's service install (systemd, launchd) and its lifecycle verbs are documented in `operations.md` and covered by tests. |

### 7. Docs, vocabulary & tracker hygiene (10%)

| Id | Criterion | Weight | How to verify |
|----|-----------|--------|---------------|
| 7.1 | Always-on docs carry no issue numbers | 2 | [auto] `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md` and `docs/adr/` cite no `#<number>`. A quoted example (`"#42 …"`) is exempt. |
| 7.2 | The docs name every operator skill | 1 | [auto] Every `skills/*` directory is named in the user guide's skill list. |
| 7.3 | No changelog fragment is left uncollected | 1 | [auto] `changelog.d/` holds no fragment on the base branch: fragments are folded into `CHANGELOG.md` at merge. |
| 7.4 | User-facing changes are logged | 2 | [judged] Sample the ten newest non-merge commits that change `src/` behaviour. Each has its `CHANGELOG.md` entry citing an issue. |
| 7.5 | The verify queue is fresh | 1 | [auto] No open `pending-verify` issue was last updated more than 14 days ago. |
| 7.6 | ADRs, `CONTEXT.md` and the guides describe current behaviour | 2 | [judged] Sample the sections that the newest milestones in `CHANGELOG.md` touch. The docs match the code. A stale description is the failure a grep can't catch. |

## Score history

<!-- Newest first. The format is the score-repo skill's method.md. -->

### 2026-11-27 — round 1 [rubric v1.0] — baseline: 0.66, D/F (not provisional)

At `e065f23`, plus the uncommitted rubric. This is the first round, so it is the baseline to move from, not a grade to compare. An October 2026 grade used a different, unpinned method (C+), so the two aren't comparable.

**Before scoring:** 1.1 and the "red advances" Critical class were reworded. As first drafted they contradicted ADR 0013's accepted non-atomic integration, where greens merge before the merged-base gate and a red result is parked and fixed forward. A literal reading fails 1.1 and caps the grade at C; the overall would be 0.62, still D/F.

| Category | Weight | Score |
|---|---|---|
| 1. Safety | 20% | 0.93 |
| 2. Orchestration | 20% | 0.71 |
| 3. Gates & build | 15% | 0.55 |
| 4. Test quality | 15% | 0.80 |
| 5. Architecture | 10% | 0.44 |
| 6. Operability | 10% | 0.29 |
| 7. Docs & tracker | 10% | 0.56 |

Overall 0.659. No unverified weight: 2.7 was verified on one supported pair.

**Gates:** no Critical. One Major, 3.4 (a flaky suite turns campaign gates into noise). The band is already below the gate caps.

**Not a plain pass:**

| Id | Verdict | Check | Reason | Issue |
|---|---|---|---|---|
| 1.4 | partial | judged | vetinari's own tokens are kept out; agent output is scrubbed only in findings | #747 |
| 2.3 | partial | judged | lease and parked state are atomic and locked; `tg-connect` rewrites `host.env` in place | #748 |
| 2.5 | fail | judged | the integration and baseline gate containers take no host slot | #749 |
| 2.6 | fail | judged | `docker image inspect` at launch has no timeout | #750 |
| 2.7 | pass | env | macOS + host sandbox merged 23 green today (notes); macOS + Docker and Linux + Docker not observed | — |
| 3.4 | fail | auto, **Major** | 1–2 of 2,524 tests fail per full run under load; they pass in isolation | #743 |
| 3.5 | fail | auto | the same flake, open (it counts against 3.4 and 3.5) | #743 |
| 4.3 | fail | judged | SSE tests in `status.test.ts` time on fixed sleeps | #751 |
| 5.2 | fail | auto | `modes.ts` is 1,816 lines | #752 |
| 5.5 | fail | judged | `queue()` has ten positional parameters re-threaded at every call | #753 |
| 5.6 | fail | judged | `overlap-replay` ignores `stateDir`; a dead `process.env` path to the Telegram credentials | #754, #755 |
| 6.1 | fail | judged | the dashboard `softRefresh` swallows failures | #756 |
| 6.2 | partial | judged | every refusal names its condition; a few omit the fix | #757 |
| 6.3 | fail | auto | `telegram-poll-failed` ×39 in 24h: a second gateway on the same bot | #745 |
| 7.1 | fail | auto | issue numbers in ADRs 0006 and 0012 | #758 |
| 7.6 | fail | judged | `reference.md` said the gateway verbs refuse on macOS, and `operations.md` lacked the macOS steps. Both were fixed in this same change | — |

7.2 failed on the first quick pass because two skills were missing from the user guide. It was fixed before the scored run, and the history row records the result of that run.
