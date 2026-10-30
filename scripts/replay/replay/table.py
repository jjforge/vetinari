"""Markdown table of the >=10-ticket campaigns from results.json."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "results.json")))["results"]
m = lambda s: f"{s/60:.0f}"
p = lambda r, k: f"{100*(r['W']-r[k])/r['W']:+.0f}"
print("| project | date | tix | waves | slots | wave sim | rolling rec (per-merge/batch) | opt batch | pess batch | % saved rec-b / opt-b / pess-b | actual (gaps removed) |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for r in R:
    if r["n"] < 10: continue
    print(f"| {r['project']} | {r['date'][:10]} | {r['n']} | {r['waves']} | {r['slots']} | {m(r['W'])} | {m(r['R'])} / {m(r['Rb'])} | {m(r['Rob'])} | {m(r['Rpb'])} | {p(r,'Rb')} / {p(r,'Rob')} / {p(r,'Rpb')} | {m(r['actual'])} |")
