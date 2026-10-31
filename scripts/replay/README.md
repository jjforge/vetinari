# Campaign replay

Throwaway-grade Python analyses that replay archived campaign logs to answer scheduling questions with real durations. They were written on 2026-10-30 to test three ideas: rolling admission (#613), looser file-overlap rules (#623) and an automatic merge-collision retry (#624). The results are on those issues. Every script is read-only toward the projects and GitHub.

The outputs (`*.json`, `out.txt`, `repos/`) are regenerated, not committed.

## 1. `replay/`: waves vs rolling admission

```sh
cd scripts/replay/replay
python3 parse.py   # archived logs → campaigns.json (projects in PROJECTS; root from $CODE_ROOT, default ~/Code)
python3 fetch.py   # today's issue bodies + native blocked-by → issues.json (gh, read-only)
python3 sim.py     # both models through one simulator → results.json, prints the per-campaign table
python3 summary.py # aggregates
```

Blockers and file keys are rebuilt from **today's** issue bodies, because `campaign-start` records only wave ids. The simulated wave model matched real wall clock (gaps removed) within 5% in 88 of 102 campaigns.

## 2. Would tickets that share a file really have conflicted? — now the `/review-logs` config lens

The `collide/` scripts that answered this were ported to TypeScript and removed (commit `41835a6`). The method lives in `src/overlap-replay.ts`, parametrised to one project, with no mirror clone: it test-merges in a temporary `git clone --shared`. `/review-logs` runs it as its **config lens** through `skills/review-logs/overlap.mts`; run it by hand with:

```sh
npx tsx skills/review-logs/overlap.mts <projectRoot>
```

Unlike `collide/`, a ticket that branched after the other merged and can't apply without it is counted as **indeterminate** and left out of the collision rate, instead of being counted as an "entangled" collision.

## 3. `retrysim/`: savings once each collision gets one in-wave retry

`retrysim/` can't run any more: it reads `collide/`'s `pairs_annot.json`, and `collide/` was removed in commit `41835a6`. Check that commit out to rerun it:

```sh
python3 scripts/replay/retrysim/retrysim.py   # reads ../replay and ../collide outputs
```

## Using it for a project's config

To decide whether a project should waive a file (`waivedFiles`), run `/review-logs` in that project: its config lens measures each shared file key's collision rate from the project's own history and suggests waive candidates and hot spots. Whether a project should opt in to looser overlap is not covered yet.
