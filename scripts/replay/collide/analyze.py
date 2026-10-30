"""Join pairs.json with in-campaign dependencies (as sim.py builds them) and summarise."""
import json, os, re, sys
from collections import Counter, defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, "..", "replay")
cs = json.load(open(os.path.join(R, "campaigns.json"))); iss = json.load(open(os.path.join(R, "issues.json")))
P = json.load(open(os.path.join(HERE, "pairs.json")))

def body_blockers(b):
    out = set(); b = b or ""
    m = re.search(r"(?ims)^#+\s*Blocked by\s*$(.*?)(?=^#+\s|\Z)", b)
    if m: out |= {int(x) for x in re.findall(r"#(\d+)", m.group(1))}
    for line in re.findall(r"(?im)^[ \t>*-]*\**(?:blocked by|depends on)\b.*$", b):
        out |= {int(x) for x in re.findall(r"#(\d+)", line)}
    return out

dep = {}   # (campaign file) -> {ticket: set(transitive ancestors)}
layer = {}
for c in cs:
    T = c["tickets"]; d = {}
    for x in T:
        i = iss.get(f'{c["repo"]}#{x}') or {}
        bs = set(i.get("blockedBy") or []) | body_blockers(i.get("body")) | {int(b) for b in c["graft_blockedBy"].get(x, [])}
        d[x] = {str(b) for b in bs if str(b) in T and str(b) != x and T[str(b)]["wave"] < T[x]["wave"]}
    memo = {}
    def anc(x):
        if x not in memo:
            memo[x] = set()
            for b in d[x]: memo[x] |= {b} | anc(b)
        return memo[x]
    lm = {}
    def lay(x):
        if x not in lm: lm[x] = 1 + max([lay(b) for b in d[x]] or [0])
        return lm[x]
    dep[(c["file"], c["start"])] = {x: anc(x) for x in T}; layer[(c["file"], c["start"])] = {x: lay(x) for x in T}

for p in P:
    A = dep[(p["campaign"], p["start"])]
    p["dependent"] = p["a"] in A[p["b"]] or p["b"] in A[p["a"]]
    L = layer[(p["campaign"], p["start"])]; p["same_layer"] = L[p["a"]] == L[p["b"]]
    p["wave_gap"] = abs(next(c for c in cs if c["file"] == p["campaign"] and c["start"] == p["start"])["tickets"][p["b"]]["wave"] - next(c for c in cs if c["file"] == p["campaign"] and c["start"] == p["start"])["tickets"][p["a"]]["wave"])

def verdict(p):
    if not p["real_overlap"]: return "no-real-overlap"
    r, a = p["result"], p["alt"]
    if "conflict" in (r, a): return "conflict"
    if "clean" in (r, a): return "clean"
    if a == "conflict-entangled": return "entangled"
    return "indeterminate"
for p in P: p["verdict"] = verdict(p)
json.dump(P, open(os.path.join(HERE, "pairs_annot.json"), "w"), indent=1)

def show(title, sel):
    print("==", title)
    for proj in ["goal-tracker", "jjforge", "pike", "vetinari"]:
        ps = [p for p in P if p["project"] == proj and sel(p)]
        print(f"  {proj:13s} n={len(ps):5d}", dict(Counter(p["verdict"] for p in ps)))
    ps = [p for p in P if sel(p)]; print(f"  {'ALL':13s} n={len(ps):5d}", dict(Counter(p["verdict"] for p in ps)))
show("predicted (shared key)", lambda p: p["predicted"])
show("predicted, independent (no dep path)", lambda p: p["predicted"] and not p["dependent"])
show("predicted, independent, same dep layer", lambda p: p["predicted"] and not p["dependent"] and p["same_layer"])
show("predicted, independent, wave gap<=2", lambda p: p["predicted"] and not p["dependent"] and p["wave_gap"] <= 2)
show("real overlap NOT predicted", lambda p: not p["predicted"])
show("actually same wave & real overlap", lambda p: p["same_wave"] and p["real_overlap"])

# ---------------- collisions by path kind + parks-per-100-merges estimate ----------------
def kind(f):
    if f.endswith("_templ.go"): return "generated"
    if f.split("/")[-1] == "CHANGELOG.md": return "changelog"
    if re.search(r"(_test\.go|\.test\.m?ts|/tests?/)", f): return "test"
    if f.endswith(".md") or f.startswith("docs/"): return "docs"
    return "code"
def cpaths(p):
    return (p.get("conflicts") or []) if p["verdict"] == "conflict" and p.get("conflicts") else (p.get("alt_conflicts") or [])
for p in P:
    if p["verdict"] in ("conflict", "entangled"):
        ks = {kind(f) for f in cpaths(p)}
        p["ckinds"] = sorted(ks)
        p["soft"] = ks <= {"generated", "changelog"}   # regenerate / keep-both resolvable
pop = [p for p in P if p["predicted"] and not p["dependent"] and p["same_layer"]]
col = [p for p in pop if p["verdict"] in ("conflict", "entangled")]
print("\n== collisions (conflict+entangled) in predicted/independent/same-layer pairs:", len(col))
print("  kinds-sets:", Counter(tuple(p["ckinds"]) for p in col).most_common(12))
print("  per-path kind (any collision touching):", Counter(k for p in col for k in p["ckinds"]))
print("  soft-only (generated/changelog):", sum(p["soft"] for p in col))
print("  top paths:", Counter(f for p in col for f in cpaths(p)).most_common(15))
for proj in ["goal-tracker", "jjforge", "pike", "vetinari"]:
    c2 = [p for p in col if p["project"] == proj]
    print(f"  {proj}: {len(c2)} soft {sum(p['soft'] for p in c2)}", Counter(k for p in c2 for k in p["ckinds"]))

# park model: no file constraint -> wave = dependency layer (slot cap ignored). Within a layer, merge in actual
# merge order; a ticket parks if it collides with an earlier unparked ticket of its layer.
idx = {(p["project"], p["start"], *sorted((p["a"], p["b"]))): p for p in P}
merged = defaultdict(dict)
for p in P:
    for t, m in ((p["a"], p["A_merge"]), (p["b"], p["B_merge"])): merged[(p["project"], p["start"])][t] = m
def sim(mode):
    out = defaultdict(lambda: [0, 0])  # proj -> [merges, parks]
    for c in cs:
        key = (c["file"], c["start"])
        L = layer[key]; T = c["tickets"]
        mt_ = merged.get((c["project"], c["start"]), {})
        # merged tickets: those that appear in any pair record; others counted via log totals below
        out[c["project"]][0] += 0
        byl = defaultdict(list)
        for t in T: byl[L[t]].append(t)
        for l, ts in byl.items():
            ts.sort(key=lambda t: T[t]["green"])
            kept = []
            for t in ts:
                hit = False
                for u in kept:
                    p = idx.get((c["project"], c["start"], *sorted((t, u))))
                    if not p or p["dependent"]: continue
                    v = p["verdict"]
                    if v in ("conflict", "entangled") and not (mode.endswith("hard") and p.get("soft")): hit = True
                    if v == "indeterminate" and mode.startswith("high"): hit = True
                if hit: out[c["project"]][1] += 1
                else: kept.append(t)
    return out
merges_per = Counter()
for line in open(os.path.join(HERE, "log.txt")):
    w = line.split(); merges_per[w[0]] += int(w[2])
print("\nmerged tickets matched:", dict(merges_per))
for mode in ["low", "high", "low-hard", "high-hard"]:
    o = sim(mode)
    tot_m = sum(merges_per.values()); tot_p = sum(v[1] for v in o.values())
    print(f"  {mode:10s}", {k: f"{v[1]} ({100*v[1]/merges_per[k]:.1f}/100)" for k, v in o.items()}, f"ALL {tot_p} ({100*tot_p/tot_m:.1f}/100)")
