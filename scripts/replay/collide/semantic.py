"""Typecheck combined A+B' trees for a sample of textually clean vetinari pairs (scratch worktree ./wt)."""
import json, random, subprocess
R = "repos/vetinari.git"; W = "wt"
P = [p for p in json.load(open("pairs_annot.json")) if p["project"] == "vetinari" and p.get("result") == "clean" and p["predicted"] and not p["dependent"]]
random.seed(7); S = random.sample(P, min(80, len(P)))
def g(*a, cwd=R): return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True)
def tc(treeish):
    g("checkout", "-q", "-f", "--detach", treeish, cwd=W) if len(treeish) == 40 and g("cat-file", "-t", treeish).stdout.strip() == "commit" else None
    return subprocess.run("npm run -s typecheck", shell=True, cwd=W, capture_output=True, text=True).returncode == 0
res = []
for p in S:
    MA, PA = p["A_merge"], g("rev-parse", p["A_merge"] + "^1").stdout.strip()
    out = g("merge-tree", "--write-tree", "--merge-base", PA, MA, p["bprime"]).stdout.split()[0]
    comb = g("commit-tree", out, "-p", MA, "-m", "comb").stdout.strip()
    ok = tc(comb)
    r = dict(a=p["a"], b=p["b"], start=p["start"], comb_ok=ok)
    if not ok:
        r["A_ok"], r["B_ok"] = tc(MA), tc(p["bprime"])
    res.append(r); print(r, flush=True)
json.dump(res, open("semantic.json", "w"), indent=1)
