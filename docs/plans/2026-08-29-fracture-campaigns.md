# The fracture plan — four campaigns to land `docs/design.md`

_Dated record, 2026-08-29. Issue numbers are cited freely here because this is a snapshot, not current truth: the tracker is the source of truth for state, and `docs/design.md` is the source of truth for the target. If this file and an issue disagree, the issue wins._

The review that produced [`user-guide.md`](../user-guide.md) and [`design.md`](../design.md) found the project fractured along three lines: vocabulary renamed at every layer with every layer left standing, a core loop with open holes while optional surface kept growing, and a documentation set with no single statement of the current design. The fix is executed **with vetinari, on vetinari**, as four campaigns in the order design §13.4 asks for: loop first, then words, then docs, then dashboard. The existing backlog was labelled `PRE-FABLE` and is superseded issue by issue (mapping at the end).

## Two constraints on running this

**The tool is the target.** `campaign` spawns each child `run` as the `cli.mts` of the checkout that launched it, and `tsx` loads source fresh per child — so a multi-wave campaign launched from this repo runs wave 2's children on whatever wave 1 merged. For campaign 2 that is fatal (the parent reduces the old event schema while children write the new one). Rule: **from campaign 2 on, drive from a pinned worktree** and refresh it between campaigns:

```
git worktree add ../vetinari-driver main        # once; `git -C ../vetinari-driver pull` before each campaign
npx tsx ../vetinari-driver/src/cli.mts campaign …   # run from this repo's root
```

The project's `config.mts` imports its helpers from `"vetinari"` by self-reference, so those resolve to _this_ tree, not the driver's — harmless as long as config fields are not renamed, which design §13.1 forbids.

**Until campaign 1 lands, a park is expensive.** Today an answered park never rejoins its campaign, `--resume` skips the parked wave, and a failure does not hold. So campaign 1 runs as **four one-wave campaigns** (a selection with no dependencies inside it is one wave): nothing to resume, nothing to hold. Within one wave every child spawns before anything merges, so the driver pin is optional for these four. Recovery from a park in this phase is `answer`, then merge `agent/<id>` onto `main` by hand.

## Campaign 0 — prep (interactive, no agents)

- [ ] `vetinari build` → `baseline` green on `main`.
- [ ] Driver worktree created (above).
- [ ] Decide the three PRE-FABLE items that need a call (table at the end): #266, #9, #253.
- [ ] Close each superseded PRE-FABLE issue with a dated comment naming its replacement (mapping below). Leave the won't-fix candidates for a separate decision.
- [ ] `vetinari campaign --dry-run 285 286` confirms the planner reads every marker line.

## Campaign 1 — the loop is whole · epic #281

Exit: an end-to-end test through the local sandbox exercises park → answer → rejoin → merge, failure → hold, and a redrive that lands green-but-unmerged work; every loop bullet in design §15 is gone.

| Run | Issues | Hot files | Command (after the previous run is merged → `pending-verify` → closed) |
| --- | --- | --- | --- |
| 1a | #285 failed issue holds its wave · #286 prune/graft gate on unsettled | `modes.ts`, `dashboard-model.ts` · `prune.ts`, `graft.ts` | `vetinari campaign 285 286` |
| 1b | #287 redrive from the parked wave, lands green-unmerged, answer triggers it · #288 issue reason outranks wave reason | `modes.ts`, `merge.ts`, `cli-dispatch.ts` · `dashboard-model.ts` | `vetinari campaign 287 288` |
| 1c | #289 re-admit mid-wave + `parkGraceSeconds` · #290 crash detection | `modes.ts`, `config.ts` · `host-slots.ts`, `dashboard-model.ts`, `state.ts` | `vetinari campaign 289 290` |
| 1d | #291 end-to-end campaign test (local sandbox) | `campaign-e2e.test.ts` (new), `sandbox-local.ts` | `vetinari campaign 291` |

`blocked_by`: 287, 288 ← 285 · 289 ← 287 · 290 ← 288 · 291 ← 289, 290. Each run's blockers must be closed before it is selected, or the planner drops it as unreachable.

## Campaign 2 — one vocabulary, one schema, trimmed surface · epic #282

Exit: one park-reason enum; the §2.1 event set with an alias reader for archived logs; the CLI says `redrive`; the §12 retire list gone; `demo` is a `make` target; the changelog fold gated on `CHANGELOG.md`.

**Pinned driver mandatory.** One command once #291 is closed — `… campaign campaign:vocabulary` — and the planner layers it into three waves from `blocked_by` and the marker lines (the driver and every child it spawns keep running the pre-schema code; only the gates exercise the new code):

| Wave | Issues |
| --- | --- |
| 1 (alone, indivisible) | #292 one event schema + one reason enum + alias table |
| 2 | #293 CLI: `redrive`, retire prune-batch / `fileset-check` / demo modes → `make` · #294 gateway words · #295 dashboard + status-line words, `/resume`→`/redrive` · #296 `migrate` without shims · #298 non-resumable providers warn · #300 CONTEXT.md domain-only |
| 3 | #297 changelog fold gated on `CHANGELOG.md`, lint removed · #299 human-readable terminal output (`report.ts`) |

A blocker outside the selection that is still open makes its dependents _unreachable_ — reported, never silently skipped — so close #291 before selecting, or nothing schedules.

`blocked_by`: 292 ← 291 · 293–296, 298, 300 ← 292 · 297, 299 ← 293.

## Campaign 3 — one documentation set · epic #283

Exit: README ≤ 1,500 words with no modes table; `docs/reference.md` generated from `help.ts`; `docs/operations.md`; ADRs carry superseded notes; specs under `docs/archive/`; colour rules as design appendix A; `.out-of-scope/` folded into design §14.

One wide wave, every issue file-disjoint: `… campaign campaign:docs`

| Issue | Creates / touches |
| --- | --- |
| #301 README rewrite + `docs/reference.md` + drift test retargeted | `reference.md` · `README.md`, `help.test.ts` |
| #302 `docs/operations.md` replaces gateway/upgrading/statusline docs | `operations.md` · the three deleted |
| #303 ADR superseded notes + `docs/adr/README.md` | every ADR |
| #304 specs → `docs/archive/`, colour rules → appendix A, out-of-scope → §14 | `design.md`, specs, out-of-scope |
| #305 process docs in the settled words | `campaigns.md`, conventions, `CLAUDE.md`, `AGENTS.md` |

`blocked_by`: 301 ← 293 · 302 ← 296 · 304 ← 300 · 305 ← 297. All closed by the end of campaign 2, so the label selection is one wave.

## Campaign 4 — dashboard matches the guide · epic #284

Exit: the issue sheet offers exactly the moves the reason allows; the idle card shows the last run; `dashboard-render.ts` split.

`… campaign campaign:dashboard` — the planner layers it: wave 1 is the split, wave 2 is parallel.

| Wave | Issues |
| --- | --- |
| 1 | #306 split `dashboard-render.ts` into landing / project / issue-sheet renderers |
| 2 | #307 moves per park reason on the issue sheet · #308 idle card shows the last run · #309 live tail follows the wave in flight (`needs-triage` — reproduce first, or run by ids without it) |

`blocked_by`: 306 ← 295 · 307, 308, 309 ← 306.

## Found in flight

- **A label selection pulls the epic in.** `campaign campaign:vocabulary` scheduled epic #282 because the epics carry the `campaign:*` labels too; the agent correctly changed nothing and it parked `stalled/no-commit`. Select by ids, or strip the label from #283/#284 before `campaign campaign:docs` / `campaign campaign:dashboard`.
- **A shared file the marker lines did not declare.** #301 (README rewrite) and #302 (delete three docs) both edited `README.md` — #302 to retarget links — so #302 parked `conflict`. The marker line lists the files an issue *edits*, including link fix-ups; the planner cannot see an edit the body does not name.
- **A conflict park does not hold the campaign** (#310, P1). The run went on to `CAMPAIGN COMPLETE` with #302's green unmerged and `redrive` had nothing to land; the recovery was by hand (merge `main` into `agent/302` taking the rewritten README, then `--no-ff` onto `main`). Fix before campaign 4.

## Between campaigns

1. Merge → the orchestrator labels `pending-verify` → verify locally → `gh issue close`. An epic closes when its last child does.
2. `git -C ../vetinari-driver pull` so the next campaign runs on the previous one's fixes.
3. The campaign's exit criterion is checked against `docs/design.md`; if the design had to change to land the work, it changed in the same commit (§13.3).

## PRE-FABLE disposition

Superseded — close with a dated comment pointing at the replacement:

| PRE-FABLE | Replaced by |
| --- | --- |
| #279 failed issue does not hold its wave | #285 |
| #277 prune/graft gate on campaign-done | #286 |
| #275 resume skips the parked wave · #276 redrive and green-unmerged · #273 redrive epic (loop half) | #287 |
| #274 wave-park overwrites the issue's reason | #288 |
| #280 answer mid-wave re-enters the wave | #289 |
| #269 crash detection | #290 |
| #181 loop test-coverage gaps · #230 invariant: never complete while parked | #291 |
| #257 one derived four-level model | #292 |
| #278 demo fixture omits the park event · #250 dispatch seam | #293 |
| #242 split the dashboard god-file | #306 |
| #260 no prune control · #261 resume control never rendered · #263 graft affordance on a settled campaign · #264 park→answer panel · #265 grafted row without a dot · #251 graft pulse | #307 |
| #237 live tail empty on wave advance · #238 live tail lists an unstarted agent | #309 |

Need a decision (left open, untouched):

| PRE-FABLE | Question |
| --- | --- |
| #266 agent generates issue stubs in-container | competes with the design's host-side findings harvest (user guide, "How work leaves the container") — pick one mechanism |
| #9 A/B harness across agent variants | the deferred bake-off (design §14) — keep open as the marker, or close and rely on §14 |
| #253 external-blocked selection, `--override` never landed | `--override` is "optional, advanced" in design §12 — keep, or drop the flag |

Won't-fix candidates (design §11 asks for less log surface, not more; the colour and log-view details are appendix-level):

#270, #203, #216 unified log views · #255 collapse on wrapped lines · #254 dead CSS rule · #271 dot alignment in host-log rows · #252 CHANGELOG milestone claims (a `CHANGELOG.md` edit, which campaign agents must not make — do it by hand when convenient).
