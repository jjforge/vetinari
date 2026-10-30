"""Replay archived campaigns under the wave model and rolling admission (same simulator inputs).

Reads campaigns.json (parse.py) and issues.json (fetch.py); prints a table and writes results.json.
"""
import json, os, re, statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
cs = json.load(open(os.path.join(HERE, "campaigns.json")))
iss = json.load(open(os.path.join(HERE, "issues.json")))

TOUCHES_RE = re.compile(r"^[ \t]*(?:[-*+]\s+)?\**(?:Touches|Files)\b[^:\n]*:(.*)$", re.I | re.M)
CREATES_RE = re.compile(r"^[ \t]*(?:[-*+]\s+)?\**Creates\b[^:\n]*:(.*)$", re.I | re.M)
CITE_RE = re.compile(r"`([^`\n]+)`|((?:[\w.\-]+/)+[\w.\-]+)")
FILENAME_RE = re.compile(r"^[\w.\-]+\.[A-Za-z][\w-]*$")
FK_SOURCE = {}


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
    """fileset.ts approximation keyed on basenames: the last Touches/Files line plus the last Creates
    line; failing those, every path-shaped cite in the body (the whole-body fallback). None = no cite."""
    body = body or ""
    keys = set()
    for rx in (TOUCHES_RE, CREATES_RE):
        tails = rx.findall(body)
        if tails:
            keys |= cites(tails[-1], True)
    if keys:
        return keys, "marker"
    keys = cites(body, False)
    return (keys, "fallback") if keys else (None, "none")


def body_blockers(body):
    out = set()
    b = body or ""
    m = re.search(r"(?ims)^#+\s*Blocked by\s*$(.*?)(?=^#+\s|\Z)", b)
    if m:
        out |= {int(x) for x in re.findall(r"#(\d+)", m.group(1))}
    for line in re.findall(r"(?im)^[ \t>*-]*\**(?:blocked by|depends on)\b.*$", b):
        out |= {int(x) for x in re.findall(r"#(\d+)", line)}
    return out


def wave_sim(c, dur, wave_of, release, O):
    t = 0.0
    for w in c["waves"]:
        start = max([t] + [release.get(x, 0) for x in w])
        free = [start] * c["slots"]
        end = start
        for x in w:  # spawn order
            free.sort()
            s = free[0]
            free[0] = s + dur[x]
            end = max(end, free[0])
        t = end + O
    return t


def rolling_sim(c, dur, wave_of, release, O, deps, conflict, batch=False):
    ids = list(dur)
    dependents = defaultdict(list)
    for t, bs in deps.items():
        for b in bs:
            dependents[b].append(t)
    cp = {}

    def crit(x):
        if x not in cp:
            cp[x] = dur[x] + O + max([crit(y) for y in dependents[x]] or [0])
        return cp[x]

    for x in ids:
        crit(x)
    state = {x: "wait" for x in ids}
    finish = {}
    green_q = []
    integ_until, integ_set = None, []
    t = 0.0
    slots = c["slots"]
    n_gates = 0
    while True:
        # completions at time t
        for x in ids:
            if state[x] == "run" and finish[x] <= t + 1e-9:
                state[x] = "green"
                green_q.append(x)
        if integ_until is not None and integ_until <= t + 1e-9:
            for x in integ_set:
                state[x] = "done"
            integ_until, integ_set = None, []
        if integ_until is None and green_q:
            green_q.sort(key=lambda x: finish[x])
            integ_set = green_q[:] if batch else [green_q[0]]
            green_q = [x for x in green_q if x not in integ_set]
            for x in integ_set:
                state[x] = "integ"
            integ_until = t + O
            n_gates += 1
        # admissions
        running = [x for x in ids if state[x] == "run"]
        held = [x for x in ids if state[x] in ("run", "green", "integ")]
        ready = [x for x in ids if state[x] == "wait" and release.get(x, 0) <= t + 1e-9
                 and all(state[b] == "done" for b in deps.get(x, ()))]
        ready.sort(key=lambda x: (-cp[x], wave_of[x]))
        for x in ready:
            if len(running) >= slots:
                break
            if any(conflict(x, y) for y in held):
                continue
            state[x] = "run"
            finish[x] = t + dur[x]
            running.append(x)
            held.append(x)
        if all(state[x] == "done" for x in ids):
            return t, n_gates, max(cp.values())
        nxt = [finish[x] for x in ids if state[x] == "run"]
        if integ_until is not None:
            nxt.append(integ_until)
        nxt += [release[x] for x in ids if state[x] == "wait" and release.get(x, 0) > t]
        nxt = [v for v in nxt if v > t + 1e-9]
        if not nxt:
            if integ_until is None and green_q:
                continue
            raise RuntimeError(f"deadlock in {c['project']} {c['start']}: {[(x, state[x]) for x in ids]}")
        t = min(nxt)


def main():
    proj_O = defaultdict(list)
    proj_G = defaultdict(list)
    for c in cs:
        proj_O[c["project"]] += c["overheads"]
        proj_G[c["project"]] += c["gate_durs"]
    results, excluded = [], []
    for c in cs:
        tag = f'{c["project"]} {c["start"][:16]}'
        if c["unrun"]:
            excluded.append((tag, f'{len(c["unrun"])} planned tickets never went green in this segment (parked/abandoned or re-planned)'))
            continue
        if len(c["tickets"]) < 3:
            excluded.append((tag, f'only {len(c["tickets"])} tickets went green'))
            continue
        tickets = c["tickets"]
        dur = {x: v["dur"] for x, v in tickets.items()}
        wave_of = {x: v["wave"] for x, v in tickets.items()}
        release = {x: c["graft_at"][x] for x in tickets if x in c["graft_at"]}
        # graft release is real-clock offset; cap it to the simulated wave start of its wave to stay in sim time
        oh = [o for o in c["overheads"] if o < 1200] or [o for o in proj_O[c["project"]] if o < 1200]
        O = statistics.median(oh)
        gd = c["gate_durs"] or proj_G[c["project"]]
        G = statistics.median(gd)
        # dependencies: native blocked-by (any state, today) + body "Blocked by" text, in-campaign only
        deps, incons, nedges = {}, 0, 0
        fk = {}
        for x in tickets:
            i = iss.get(f'{c["repo"]}#{x}') or {}
            bs = set(i.get("blockedBy") or []) | body_blockers(i.get("body"))
            if x in c["graft_blockedBy"]:
                bs |= {int(b) for b in c["graft_blockedBy"][x]}
            keep = []
            for b in bs:
                b = str(b)
                if b in tickets and b != x:
                    if wave_of[b] < wave_of[x]:
                        keep.append(b)
                    else:
                        incons += 1
            nedges += len(keep)
            deps[x] = keep
            if x in c["graft_fileKeys"]:
                fk[x] = {k.split("/")[-1] for k in c["graft_fileKeys"][x]}
            else:
                fk[x], src = file_keys(i.get("body"))
                FK_SOURCE[src] = FK_SOURCE.get(src, 0) + 1
        unknown_fk = sum(1 for x in tickets if fk[x] is None)
        # wave release for grafts: in sim time, put a graft no earlier than the sim start of the wave it ran in
        wave_start_sim = {}
        tt = 0.0
        for wi, w in enumerate(c["waves"]):
            wave_start_sim[wi] = tt
            free = [tt] * c["slots"]
            end = tt
            for x in w:
                free.sort(); free[0] += dur[x]; end = max(end, free[0])
            tt = end + O
        release = {x: wave_start_sim[wave_of[x]] for x in release}

        def recon(a, b):
            if wave_of[a] == wave_of[b]:
                return False  # the wave's own disjointness is trusted
            if fk[a] is None or fk[b] is None:
                return True
            return bool(fk[a] & fk[b])

        def pess(a, b):
            return wave_of[a] != wave_of[b]

        def opt(a, b):
            return False

        W = wave_sim(c, dur, wave_of, release, O)
        R, ng, cp = rolling_sim(c, dur, wave_of, release, O, deps, recon)
        Rb, ngb, _ = rolling_sim(c, dur, wave_of, release, O, deps, recon, batch=True)
        Ro, _, _ = rolling_sim(c, dur, wave_of, release, O, deps, opt)
        Rob, _, _ = rolling_sim(c, dur, wave_of, release, O, deps, opt, batch=True)
        Rp, _, _ = rolling_sim(c, dur, wave_of, release, O, deps, pess)
        Rpb, _, _ = rolling_sim(c, dur, wave_of, release, O, deps, pess, batch=True)
        O0 = max(O - G, 0)  # same boundary cost with the base gate itself removed, for both models
        W0 = wave_sim(c, dur, wave_of, release, O0)
        R0, _, _ = rolling_sim(c, dur, wave_of, release, O0, deps, recon)
        depth_memo = {}

        def depth(x):
            if x not in depth_memo:
                depth_memo[x] = 1 + max([depth(b) for b in deps.get(x, ())] or [0])
            return depth_memo[x]
        chain = max(depth(x) for x in tickets)
        # conflict depth: layers needed if deps AND reconstructed file conflicts force ordering (greedy layering in plan order)
        layer = {}
        for wi, w in enumerate(c["waves"]):
            for x in w:
                prior = [y for y in layer if (y in deps.get(x, ()) or recon(x, y))]
                layer[x] = 1 + max([layer[y] for y in prior] or [0])
        cdepth = max(layer.values())
        # how many cross-wave pairs the reconstruction says are file-disjoint
        xs = list(tickets)
        cross = [(a, b) for i_, a in enumerate(xs) for b in xs[i_ + 1:] if wave_of[a] != wave_of[b]]
        cross_conf = sum(recon(a, b) for a, b in cross)
        same = [(a, b) for i_, a in enumerate(xs) for b in xs[i_ + 1:] if wave_of[a] == wave_of[b]]
        same_conf = sum(1 for a, b in same if fk[a] is not None and fk[b] is not None and fk[a] & fk[b])
        ds = sorted(dur.values())
        results.append(dict(
            project=c["project"], date=c["start"][:16], n=len(tickets), waves=len(c["waves"]), slots=c["slots"],
            O=O, G=G, W=W, R=R, Rb=Rb, Ro=Ro, Rob=Rob, Rp=Rp, Rpb=Rpb, W0=W0, R0=R0, chain=chain, cdepth=cdepth, cp=cp, gates_roll=ng, gates_batch=ngb,
            actual=c["actual_gap_removed"], raw=c["actual_raw"], edges=nedges, incons=incons, unknown_fk=unknown_fk,
            cross=len(cross), cross_conf=cross_conf, same=len(same), same_conf=same_conf, dur_med=statistics.median(ds), dur_max=ds[-1],
            dur_cv=statistics.pstdev(ds) / statistics.mean(ds), flags=c["flags"], grafted=len(c["graft_at"]),
            max_wave=max(len(w) for w in c["waves"]),
            sum_wave_max=sum(max(dur[x] for x in w) for w in c["waves"]), sum_dur=sum(ds)))
    json.dump({"results": results, "excluded": excluded}, open(os.path.join(HERE, "results.json"), "w"), indent=1)
    m = lambda s: s / 60
    print(f'{"project":12} {"date":16} {"n":>3} {"wv":>3} {"sl":>2} {"O":>4} {"G":>4} | {"Wsim":>6} {"Rrec":>6} {"Rbat":>6} {"Ropt":>6} {"Rpes":>6} {"%rec":>5} {"%bat":>5} {"%opt":>5} {"%pes":>5} | {"CP":>6} {"act":>6} {"act/W":>5} edges inc unkFK xconf')
    for r in results:
        pct = lambda v: 100 * (r["W"] - v) / r["W"]
        print(f'{r["project"]:12} {r["date"]:16} {r["n"]:3} {r["waves"]:3} {r["slots"]:2} {r["O"]:4.0f} {r["G"]:4.0f} | {m(r["W"]):6.1f} {m(r["R"]):6.1f} {m(r["Rb"]):6.1f} {m(r["Ro"]):6.1f} {m(r["Rp"]):6.1f} '
              f'{pct(r["R"]):5.1f} {pct(r["Rb"]):5.1f} {pct(r["Ro"]):5.1f} {pct(r["Rp"]):5.1f} | {m(r["cp"]):6.1f} {m(r["actual"]):6.1f} {r["actual"]/r["W"]:5.2f} {r["edges"]:5} {r["incons"]:3} {r["unknown_fk"]:5} {r["cross_conf"]}/{r["cross"]}')
    print("file-key sources:", FK_SOURCE)
    print("excluded:")
    for e in excluded:
        print("  ", *e)


main()
