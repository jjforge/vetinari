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

## 2. `collide/`: would tickets that share a file really have conflicted?

Needs a mirror clone of each project in `collide/repos/<project>.git`:

```sh
cd scripts/replay/collide
git clone --mirror --shared ~/Code/<project> repos/<project>.git
python3 collide.py   # test-merges each overlapping pair's real changes → pairs.json
python3 analyze.py   # joins dependencies, models parks per 100 merges → pairs_annot.json
python3 show.py <project> <campaign-start> <a> <b>   # print one pair's conflict hunks
```

`semantic.py` typechecks combined trees of cleanly merged vetinari pairs (slow). The weakest part of the method: a ticket that branched after the other merged and can't apply without it is counted as "entangled", which is a proxy for a collision.

## 3. `retrysim/`: savings once each collision gets one in-wave retry

```sh
python3 scripts/replay/retrysim/retrysim.py   # reads ../replay and ../collide outputs
```

## Using it for a project's config

To decide whether a project should waive a file (`waivedFiles`) or opt in to looser overlap, run 1 → 2 → 3 on that project's archive. Then read its collision rate by path from `pairs_annot.json` and its saving from `retrysim`.
