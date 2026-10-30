"""Per-project table from pairs_annot.json (run analyze.py first)."""
import json, re
P = json.load(open("pairs_annot.json"))
src = open("analyze.py").read().split("# ---------------- collisions")[1].split("pop =")[0].split("\n", 1)[1]
exec(src)
for name, sel in [("all predicted", lambda p: True), ("eligible (indep, same layer)", lambda p: not p["dependent"] and p["same_layer"])]:
    print(name)
    for proj in ["goal-tracker", "jjforge", "pike", "vetinari", "ALL"]:
        ps = [p for p in P if p["predicted"] and sel(p) and (proj == "ALL" or p["project"] == proj)]
        r = [p for p in ps if p["real_overlap"]]
        cl = sum(p["verdict"] == "clean" for p in r); co = [p for p in r if p["verdict"] in ("conflict", "entangled")]
        ind = sum(p["verdict"] == "indeterminate" for p in r); soft = sum(p["soft"] for p in co); strict = sum(p["verdict"] == "conflict" for p in co)
        print(f"  {proj:12s} pred {len(ps):5d} real {len(r):5d} clean {cl:4d} coll {len(co):4d} (strict {strict}, soft {soft}) ind {ind:4d}  rate {100*len(co)/max(1,cl+len(co)):.0f}%  hard {100*(len(co)-soft)/max(1,cl+len(co)):.0f}%")
