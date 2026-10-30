"""Aggregate results.json into the report numbers."""
import json, os, statistics
HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, "results.json")))
R = d["results"]
pct = lambda r, k: 100 * (r["W"] - r[k]) / r["W"]
def agg(rs, label):
    print(f"\n== {label}: {len(rs)} campaigns, {sum(r['n'] for r in rs)} tickets, sum W={sum(r['W'] for r in rs)/3600:.1f}h")
    for k, name in [("R", "recon per-merge"), ("Rb", "recon batch"), ("Ro", "optimistic per-merge"), ("Rob", "optimistic batch"),
                    ("Rp", "pessimistic per-merge"), ("Rpb", "pessimistic batch")]:
        ps = [pct(r, k) for r in rs]
        tot = 100 * (sum(r["W"] for r in rs) - sum(r[k] for r in rs)) / sum(r["W"] for r in rs)
        print(f"  {name:24} median {statistics.median(ps):6.1f}%  total {tot:6.1f}%  worse-than-wave in {sum(p < -0.5 for p in ps)}  >=10% better in {sum(p >= 10 for p in ps)}")
agg(R, "all included")
multi = [r for r in R if r["waves"] >= 2]
agg(multi, ">=2 waves")
big = [r for r in R if r["n"] >= 10]
agg(big, ">=10 tickets")
for proj in ["goal-tracker", "jjforge", "pike", "vetinari"]:
    agg([r for r in R if r["project"] == proj], proj)
# validation
ratios = [r["actual"] / r["W"] for r in R]
print("\nactual/Wsim median", statistics.median(ratios), "within 5%:", sum(0.95 <= x <= 1.05 for x in ratios), "/", len(ratios))
print("outliers:", [(r["project"], r["date"], round(r["actual"] / r["W"], 2), r["flags"]) for r in R if not 0.9 <= r["actual"] / r["W"] <= 1.1])
# critical path floor
print("\nCP floor: rolling-batch-recon within 5% of CP:", sum(r["Rb"] <= 1.05 * r["cp"] for r in R), "/", len(R),
      "; optimistic-batch within 5% of CP:", sum(r["Rob"] <= 1.05 * r["cp"] for r in R))
print("W/CP median", statistics.median(r["W"] / r["cp"] for r in R), " Rob/CP median", statistics.median(r["Rob"] / r["cp"] for r in R))
# drivers
print("\nsame-wave pairs my reconstruction calls conflicting:", sum(r["same_conf"] for r in R), "/", sum(r["same"] for r in R))
print("cross-wave pairs conflicting (recon):", sum(r["cross_conf"] for r in R), "/", sum(r["cross"] for r in R))
print("dependency edges (in-campaign):", sum(r["edges"] for r in R), " inconsistent with plan:", sum(r["incons"] for r in R))
gap_cp = [(r["W"] - r["Rob"]) for r in R]
# wave-tail waste: sum over waves of (max - mean) is approximated by W - sum_dur/slot style; report dur CV
import math
hi = [r for r in R if r["dur_cv"] >= statistics.median(x["dur_cv"] for x in R)]
lo = [r for r in R if r["dur_cv"] < statistics.median(x["dur_cv"] for x in R)]
for grp, nm in [(hi, "high turn-length spread"), (lo, "low spread")]:
    print(nm, "median opt-batch %", statistics.median(pct(r, "Rob") for r in grp), "median recon-batch %", statistics.median(pct(r, "Rb") for r in grp))
# gate cost
print("\ngate: per-campaign median G (s) by project:", {p: statistics.median(r["G"] for r in R if r["project"] == p) for p in ["goal-tracker","jjforge","pike","vetinari"]})
print("gate runs wave:", sum(r["waves"] for r in R), " per-merge:", sum(r["gates_roll"] for r in R), " batch:", sum(r["gates_batch"] for r in R))
print("extra gate machine-hours per-merge:", sum((r["gates_roll"] - r["waves"]) * r["G"] for r in R) / 3600,
      " batch:", sum((r["gates_batch"] - r["waves"]) * r["G"] for r in R) / 3600)
print("makespan cost of per-merge vs batch (recon), total h:", sum(r["R"] - r["Rb"] for r in R) / 3600)
print("both models with base gate removed (O-G): recon per-merge total %", 100*(sum(r["W0"] for r in R)-sum(r["R0"] for r in R))/sum(r["W0"] for r in R),
      "median", statistics.median(100*(r["W0"]-r["R0"])/r["W0"] for r in R))
print("waves vs dep-chain depth vs dep+recon-conflict depth (medians):", statistics.median(r["waves"] for r in R), statistics.median(r["chain"] for r in R), statistics.median(r["cdepth"] for r in R))
print("campaigns where waves > dep chain depth:", sum(r["waves"] > r["chain"] for r in R), "/", len(R), "; waves summed", sum(r["waves"] for r in R), "chain summed", sum(r["chain"] for r in R), "conflict-depth summed", sum(r["cdepth"] for r in R))
print("integrator saturation (n*O > Rb):", sum(r["n"] * r["O"] > r["Rb"] for r in R), "/", len(R))
