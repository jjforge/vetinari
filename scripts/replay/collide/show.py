"""show.py project start a b [path]: redo a pair's simulated merge and print the conflict-marker regions."""
import json, sys, subprocess, re
proj, start, a, b = sys.argv[1:5]
only = sys.argv[5] if len(sys.argv) > 5 else None
repo = f"repos/{proj}.git"
p = next(x for x in json.load(open("pairs_annot.json")) if x["project"] == proj and x["start"] == start and x["a"] == a and x["b"] == b)
def g(*args): return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True).stdout
def mt(base, o, t):
    out = g("merge-tree", "--write-tree", "--name-only", "--no-messages", "--merge-base", base, o, t).splitlines()
    return out[0], out[1:]
MA, MB = p["A_merge"], p["B_merge"]
PA, PB, TB = g("rev-parse", MA + "^1").strip(), g("rev-parse", MB + "^1").strip(), g("rev-parse", MB + "^2").strip()
baseb = g("merge-base", PB, TB).strip()
print({k: p.get(k) for k in ["shared_keys", "real_overlap", "result", "alt", "conflicts", "alt_conflicts", "apply_conflicts", "wave_gap"]})
print("A:", g("log", "-1", "--format=%s", MA + "^2").strip(), "| B:", g("log", "-1", "--format=%s", TB).strip())
if p["verdict"] == "entangled":
    X, _ = mt(MA, PB, PA); Xc = g("commit-tree", X, "-p", PB, "-m", "x").strip()
    tree, conf = mt(baseb, Xc, TB)
else:
    tree, conf = mt(PA, MA, p["bprime"]) if p.get("bprime") else (None, [])
for f in conf:
    if only and f != only: continue
    txt = g("show", f"{tree}:{f}").splitlines()
    print(f"---- {f}")
    i = 0
    while i < len(txt):
        if txt[i].startswith("<<<<<<<"):
            j = i
            while j < len(txt) and not txt[j].startswith(">>>>>>>"): j += 1
            blk = txt[i:j + 1]
            print("\n".join(l[:140] for l in (blk if len(blk) < 30 else blk[:14] + ["   ...."] + blk[-14:])))
            i = j
        i += 1
