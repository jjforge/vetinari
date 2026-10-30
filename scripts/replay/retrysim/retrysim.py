"""Variant 2/3 of #623: drop file-disjointness from wave planning, retry merge collisions inside the wave (#624).

Inputs: ../replay/campaigns.json, ../replay/issues.json, ../collide/pairs_annot.json. Prints tables; writes results.json.
"""
import json, os, re, statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REP = os.path.join(HERE, "..", "replay")
cs = json.load(open(os.path.join(REP, "campaigns.json")))
iss = json.load(open(os.path.join(REP, "issues.json")))
P = json.load(open(os.path.join(HERE, "..", "collide", "pairs_annot.json")))

# ---- copied from replay/sim.py ----
TOUCHES_RE = re.compile(r"^[ \t]*(?:[-*+]\s+)?\**(?:Touches|Files)\b[^:\n]*:(.*)$", re.I | re.M)
CREATES_RE = re.compile(r"^[ \t]*(?:[-*+]\s+)?\**Creates\b[^:\n]*:(.*)$", re.I | re.M)
CITE_RE = re.compile(r"`([^`\n]+)`|((?:[\w.\-]+/)+[\w.\-]+)")
FILENAME_RE = re.compile(r"^[\w.\-]+\.[A-Za-z][\w-]*$")


def cites(text, on_marker):
    out = set()
    for m in CITE_RE.finditer(text.replace("\\`", "`")):
        tok = (m.group(1) or m.group(2) or "").strip()
        tok = re.sub(r":\d+(?::\d+)?$", "", tok)
        if not tok or " " in tok:
            continue
        if not on_marker and "/" not in tok and not FILENAME_RE.match(tok):
            continue
        out.add(tok.rstrip("/").split("/")[-1])
    return out


def file_keys(body):
    body = body or ""
    keys = set()
    for rx in (TOUCHES_RE, CREATES_RE):
        tails = rx.findall(body)
        if tails:
            keys |= cites(tails[-1], True)
    if keys:
        return keys
    keys = cites(body, False)
    return keys if keys else None


def body_blockers(body):
    out = set()
    b = body or ""
    m = re.search(r"(?ims)^#+\s*Blocked by\s*$(.*?)(?=^#+\s|\Z)", b)
    if m:
        out |= {int(x) for x in re.findall(r"#(\d+)", m.group(1))}
    for line in re.findall(r"(?im)^[ \t>*-]*\**(?:blocked by|depends on)\b.*$", b):
        out |= {int(x) for x in re.findall(r"#(\d+)", line)}
    return out


def wave_sim(c, dur, release, O):
    t = 0.0
    for w in c["waves"]:
        start = max([t] + [release.get(x, 0) for x in w])
        free = [start] * c["slots"]
        end = start
        for x in w:
            free.sort()
            s = free[0]
            free[0] = s + dur[x]
            end = max(end, free[0])
        t = end + O
    return t
# -----------------------------------

# ---- pair verdicts (soft = collision only on generated *_templ.go / CHANGELOG.md, as collide/analyze.py) ----
def kind(f):
    if f.endswith("_templ.go"): return "generated"
    if f.split("/")[-1] == "CHANGELOG.md": return "changelog"
    return "other"


def cpaths(p):
    return (p.get("conflicts") or []) if p["verdict"] == "conflict" and p.get("conflicts") else (p.get("alt_conflicts") or [])


VERD = {}
for p in P:
    v = p["verdict"]
    if v in ("conflict", "entangled"):
        v = "soft" if {kind(f) for f in cpaths(p)} <= {"generated", "changelog"} else "collide"
    elif v in ("no-real-overlap",):
        v = "clean"
    VERD[(p["project"], p["start"], *sorted((p["a"], p["b"])))] = v
HAVE_MERGE = defaultdict(set)  # tickets the collide replay found a merge for (pairs only exist among these)
for p in P:
    HAVE_MERGE[(p["project"], p["start"])] |= {p["a"], p["b"]}

HOT = {"goal-tracker": {"goals_test.go", "goals.templ", "reports.templ"}}


def setup(c):
    tickets = c["tickets"]
    dur = {x: v["dur"] for x, v in tickets.items()}
    wave_of = {x: v["wave"] for x, v in tickets.items()}
    oh = [o for o in c["overheads"] if o < 1200] or [o for o in PO[c["project"]] if o < 1200]
    O = statistics.median(oh)
    deps, fk = {}, {}
    for x in tickets:
        i = iss.get(f'{c["repo"]}#{x}') or {}
        bs = set(i.get("blockedBy") or []) | body_blockers(i.get("body"))
        if x in c["graft_blockedBy"]:
            bs |= {int(b) for b in c["graft_blockedBy"][x]}
        deps[x] = [str(b) for b in bs if str(b) in tickets and str(b) != x and wave_of[str(b)] < wave_of[x]]
        if x in c["graft_fileKeys"]:
            fk[x] = {k.split("/")[-1] for k in c["graft_fileKeys"][x]}
        else:
            fk[x] = file_keys(i.get("body"))
    # graft release, in sim time, as sim.py
    wave_start_sim, tt = {}, 0.0
    for wi, w in enumerate(c["waves"]):
        wave_start_sim[wi] = tt
        free = [tt] * c["slots"]; end = tt
        for x in w:
            free.sort(); free[0] += dur[x]; end = max(end, free[0])
        tt = end + O
    release = {x: wave_start_sim[wave_of[x]] for x in tickets if x in c["graft_at"]}
    return dur, wave_of, O, deps, fk, release


def relayer(c, deps, fk, hot=None):
    """Dependency-only layering in plan order; with `hot`, tickets sharing a hot key also go to later layers."""
    order = [x for w in c["waves"] for x in w]
    layer = {}
    for x in order:
        prior = [y for y in layer if y in deps[x] or (hot and fk[x] and fk[y] and (fk[x] & fk[y] & hot))]
        layer[x] = 1 + max([layer[y] for y in prior] or [0])
    byl = defaultdict(list)
    for x in order:
        byl[layer[x]].append(x)
    waves = []
    for l in sorted(byl):
        ts = byl[l]
        for i in range(0, len(ts), c["slots"]):
            waves.append(ts[i:i + c["slots"]])
    return waves


def run_retry(c, waves, dur, O, release, f, indet_collides, no_collisions=False):
    key = (c["project"], c["start"])

    def collides(a, b):
        if no_collisions:
            return False
        v = VERD.get((c["project"], c["start"], *sorted((a, b))), "clean")
        return v == "collide" or (v == "indeterminate" and indet_collides)

    t, retries, parks, first_park_t = 0.0, 0, 0, None
    for w in waves:
        S = max([t] + [release.get(x, 0) for x in w])
        # wave fits the slot cap, so every ticket starts at S
        merged, retry = [], []
        for x in sorted(w, key=lambda x: dur[x]):  # green order
            (retry if any(collides(x, y) for y in merged) else merged).append(x)
        end = S + max(dur[x] for x in w) + O
        if retry:
            retries += len(retry)
            rmerged = []
            for x in sorted(retry, key=lambda x: f * dur[x]):  # retry-green order; base already holds first-pass merges
                if any(collides(x, y) for y in rmerged):
                    parks += 1
                    if first_park_t is None:
                        first_park_t = end + max(f * dur[y] for y in retry) + O
                else:
                    rmerged.append(x)
            end += max(f * dur[x] for x in retry) + O
        t = end
    return t, retries, parks, first_park_t


PO = defaultdict(list)
for c in cs:
    PO[c["project"]] += c["overheads"]

FS = (0.3, 0.6, 1.0)
rows = []
for c in cs:
    if c["unrun"] or len(c["tickets"]) < 3:
        continue
    dur, wave_of, O, deps, fk, release = setup(c)
    W = wave_sim(c, dur, release, O)
    w2 = relayer(c, deps, fk)
    r = dict(project=c["project"], date=c["start"][:16], n=len(dur), O=O, W=W, waves=len(c["waves"]), waves2=len(w2),
             cover=len(HAVE_MERGE[(c["project"], c["start"])] & set(dur)) / len(dur), grafts=len(release))
    r["V0"] = run_retry(c, w2, dur, O, release, 0, False, no_collisions=True)[0]
    for ind in (False, True):
        for f in FS:
            T, rt, pk, fp = run_retry(c, w2, dur, O, release, f, ind)
            r[f"V_{ind:d}_{f}"] = T
            r[f"rt_{ind:d}"] = rt; r[f"pk_{ind:d}"] = pk; r[f"halt_{ind:d}"] = fp
    if c["project"] in HOT:
        w3 = relayer(c, deps, fk, HOT[c["project"]])
        r["waves3"] = len(w3)
        for ind in (False, True):
            for f in FS:
                T, rt, pk, fp = run_retry(c, w3, dur, O, release, f, ind)
                r[f"H_{ind:d}_{f}"] = T; r[f"hrt_{ind:d}"] = rt; r[f"hpk_{ind:d}"] = pk
    rows.append(r)
json.dump(rows, open(os.path.join(HERE, "results.json"), "w"), indent=1)

# sanity: W matches replay/results.json
old = {(x["project"], x["date"]): x["W"] for x in json.load(open(os.path.join(REP, "results.json")))["results"]}
assert all(abs(old[(r["project"], r["date"])] - r["W"]) < 1e-6 for r in rows), "baseline mismatch"


def summ(rs, col):
    W = sum(r["W"] for r in rs); V = sum(r[col] for r in rs)
    return 100 * (W - V) / W, statistics.median([100 * (r["W"] - r[col]) / r["W"] for r in rs])


groups = [(p, [r for r in rows if r["project"] == p]) for p in ("goal-tracker", "vetinari", "jjforge", "pike")] + [("ALL", rows)]
print(f'{"project":12} {"camps":>5} {"merges":>6} {"cover":>5} | {"relayer-only":>12} | ' +
      " | ".join(f"ind={nm} f={f}" for nm in ("clean", "coll") for f in FS) + " | retry/100 park/100 (clean,coll) | halted camps")
for name, rs in groups:
    n = sum(r["n"] for r in rs)
    cells = [f"{summ(rs, f'V_{i}_{f}')[0]:5.1f}/{summ(rs, f'V_{i}_{f}')[1]:5.1f}" for i in (0, 1) for f in FS]
    cover = sum(r["cover"] * r["n"] for r in rs) / n
    print(f'{name:12} {len(rs):5} {n:6} {cover:5.2f} | {summ(rs, "V0")[0]:5.1f}/{summ(rs, "V0")[1]:5.1f} | ' + " | ".join(cells) +
          f' | {100*sum(r["rt_0"] for r in rs)/n:4.1f} {100*sum(r["pk_0"] for r in rs)/n:4.1f}, {100*sum(r["rt_1"] for r in rs)/n:4.1f} {100*sum(r["pk_1"] for r in rs)/n:4.1f}'
          f' | {sum(1 for r in rs if r["halt_0"] is not None)},{sum(1 for r in rs if r["halt_1"] is not None)}')
print("cells: % saved vs baseline, total/median over campaigns")
gt = [r for r in rows if r["project"] == "goal-tracker"]
n = sum(r["n"] for r in gt)
print("variant 3 goal-tracker (hot keys strict):", " | ".join(f"ind={nm} f={f}: {summ(gt, f'H_{i}_{f}')[0]:.1f}/{summ(gt, f'H_{i}_{f}')[1]:.1f}" for i, nm in ((0, "clean"), (1, "coll")) for f in FS),
      f'| retry/100 {100*sum(r["hrt_0"] for r in gt)/n:.1f},{100*sum(r["hrt_1"] for r in gt)/n:.1f} park/100 {100*sum(r["hpk_0"] for r in gt)/n:.1f},{100*sum(r["hpk_1"] for r in gt)/n:.1f}')
print("waves baseline vs dep-only:", {p: (sum(r["waves"] for r in rs), sum(r["waves2"] for r in rs)) for p, rs in groups})
print("campaigns with grafts:", sum(1 for r in rows if r["grafts"]), "; campaigns with cover<1:", [(r["project"], r["date"], round(r["cover"], 2)) for r in rows if r["cover"] < 1])
