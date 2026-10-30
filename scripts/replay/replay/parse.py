"""Parse archived vetinari orchestrator logs into per-campaign replay inputs.

Writes campaigns.json next to this script. Read-only over the logs.
"""
import glob, json, os, statistics, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CODE_ROOT = os.environ.get("CODE_ROOT", os.path.expanduser("~/Code"))
PROJECTS = {
    "goal-tracker": "zachthieme/goal-tracker",
    "jjforge": "jjforge/jjforge",
    "pike": "zachthieme/pike",
    "vetinari": "jjforge/vetinari",
}
IDLE_GAP = 600  # seconds: an event gap with nothing in flight longer than this is human/crash time


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def normalize(rows):
    """Map legacy vocabulary to the current set; drop notification noise rows."""
    has_qspawn = any(r.get("event") == "queue-spawn" for r in rows)
    out = []
    for r in rows:
        ev = r.get("event")
        if not isinstance(r.get("ts"), str) or ev is None:
            continue
        if "category" in r and "taskId" not in r and "tasks" not in r:
            continue  # outbound-notification echo rows
        r = dict(r)
        if ev == "campaign-start":
            if "waves" not in r and "batches" in r:
                r["waves"] = r["batches"]
            if "waves" not in r:
                continue
        elif ev == "campaign-batch":
            r["event"] = "wave-start"
        elif ev == "campaign-batch-done":
            r["event"] = "wave-done"
        elif ev == "queue-spawn":
            r["event"] = "spawn"
        elif ev == "queue-start":
            if has_qspawn or "taskIds" not in r:
                continue
            for t in r["taskIds"]:
                out.append({"ts": r["ts"], "event": "spawn", "taskId": t})
            continue
        elif ev == "campaign-merged":
            r["event"] = "merged"
        elif ev == "campaign-merged-base-gate":
            r["event"] = "base-gate"
        elif ev == "wave-parked":
            r["event"] = "campaign-parked"
        elif ev == "campaign-resume":
            r["event"] = "redrive"
        elif ev == "quarantined":
            r["event"] = "parked"
        if r["event"] in ("spawn", "green", "merged", "parked", "failed", "turn") and "taskId" not in r:
            continue
        if r["event"] == "wave-start" and "tasks" not in r:
            continue
        out.append(r)
    out.sort(key=lambda r: r["ts"])
    return out


def segment(rows):
    starts = [i for i, r in enumerate(rows) if r["event"] == "campaign-start"]
    for k, i in enumerate(starts):
        j = starts[k + 1] if k + 1 < len(starts) else len(rows)
        yield rows[i:j]


def analyse(seg, project, fname):
    cs = seg[0]
    plan = [[str(x) for x in w] for w in cs["waves"]]
    nplan = sum(len(w) for w in plan)
    if not (len(plan) >= 2 or nplan >= 3):
        return None
    t0 = ts(cs["ts"])
    notes = []
    pruned = set()
    graft_at = {}
    graft_fk, graft_bb = {}, {}
    waves = {}  # index -> ordered tasks
    wave_order = []
    spawns, greens = {}, {}
    gates = []  # (start, end, green)
    wave_done = {}
    merged_at = {}
    counts = {}
    last_gate_start = None
    for r in seg:
        ev = r["event"]
        counts[ev] = counts.get(ev, 0) + 1
        t = ts(r["ts"])
        if ev == "wave-start":
            idx = r.get("index", len(wave_order))
            if idx not in waves:
                waves[idx] = []
                wave_order.append(idx)
            for x in r["tasks"]:
                if str(x) not in waves[idx]:
                    waves[idx].append(str(x))
        elif ev == "spawn":
            spawns.setdefault(str(r["taskId"]), []).append(t)
        elif ev == "green":
            greens.setdefault(str(r["taskId"]), []).append(t)
        elif ev == "merged":
            merged_at.setdefault(str(r["taskId"]), []).append(t)
        elif ev == "gate" and not r.get("taskId"):
            last_gate_start = t
        elif ev == "base-gate":
            gates.append((last_gate_start, t, r.get("green")))
            last_gate_start = None
        elif ev == "wave-done":
            wave_done.setdefault(r.get("index"), t)
        elif ev == "prune":
            pruned.update(str(x) for x in (r.get("dropped") or r.get("removed") or []))
        elif ev == "graft":
            for x in r.get("ids", []):
                graft_at[str(x)] = t - t0
            graft_bb.update({str(k): [str(v) for v in vs] for k, vs in (r.get("blockedBy") or {}).items()})
            graft_fk.update({str(k): vs for k, vs in (r.get("fileKeys") or r.get("basenames") or {}).items()})

    # per-ticket agent duration: last green, minus the last spawn before it
    tickets = {}
    for tid, gs in greens.items():
        g = gs[-1]
        sp = [s for s in spawns.get(tid, []) if s <= g]
        if not sp:
            continue
        tickets[tid] = {"dur": g - sp[-1], "green": g - t0, "spawn": sp[-1] - t0,
                        "spawns": len(spawns.get(tid, [])), "greens": len(gs)}

    # executed waves (in first-start order), dropping pruned and never-green members
    exec_waves = []
    for idx in sorted(wave_order):
        mem = [x for x in waves[idx] if x not in pruned and x in tickets]
        if mem:
            exec_waves.append(mem)
    seen = set()
    for w in exec_waves:
        w[:] = [x for x in w if not (x in seen or seen.add(x))]
    exec_waves = [w for w in exec_waves if w]
    if not exec_waves:
        return {"skip": "no wave-start events with green members", "project": project, "file": fname, "date": cs["ts"][:10]}
    for wi, w in enumerate(exec_waves):
        for x in w:
            tickets[x]["wave"] = wi
    tickets = {k: v for k, v in tickets.items() if "wave" in v}
    unrun = [x for w in plan for x in w if x not in tickets and x not in pruned]

    # gate durations (gate start -> base-gate). Fallback: last merged -> base-gate
    gate_durs = []
    for s, e, g in gates:
        if s is not None and 0 < e - s < 3600:
            gate_durs.append(e - s)

    # per-wave boundary overhead: wave-done minus the wave's last green, when no park in between
    overheads = []
    for wi, w in enumerate(exec_waves):
        last = max(tickets[x]["green"] for x in w) + t0
        cands = [t for t in wave_done.values() if t >= last]
        if cands:
            d = min(cands) - last
            if d < 3600:
                overheads.append(d)
    merges = []
    for wi, w in enumerate(exec_waves):
        last = max(tickets[x]["green"] for x in w) + t0
        ms = [max(m for m in merged_at.get(x, [0])) for x in w]
        if all(m >= last for m in ms):
            merges.append((max(ms) - last) / len(w))

    # actual wall clock with human/crash gaps removed
    end_ev = [r for r in seg if r["event"] in ("campaign-done", "wave-done", "base-gate", "merged", "campaign-parked", "campaign-failed")]
    t_end = ts(end_ev[-1]["ts"]) if end_ev else ts(seg[-1]["ts"])
    inflight = set()
    removed = 0.0
    parked_since = None
    prev = t0
    for r in seg:
        t = ts(r["ts"])
        if t > t_end:
            break
        ev = r["event"]
        gap = t - prev
        if parked_since is not None and ev in ("redrive", "spawn", "wave-start", "answered", "merged"):
            removed += t - parked_since
            parked_since = None
        elif parked_since is None and not inflight and gap > IDLE_GAP:
            removed += gap
        if ev == "spawn":
            inflight.add(str(r["taskId"]))
        elif ev in ("green", "parked", "failed"):
            inflight.discard(str(r["taskId"]))
        elif ev in ("campaign-parked", "campaign-failed"):
            parked_since = t
            inflight.clear()
        prev = t
    if parked_since is not None:
        removed += t_end - parked_since
    actual = t_end - t0 - removed

    flags = {k: counts.get(k, 0) for k in ("redrive", "campaign-parked", "parked", "failed", "prune", "graft", "campaign-done")}
    return {
        "project": project, "repo": PROJECTS[project], "file": fname, "start": cs["ts"], "date": cs["ts"][:10],
        "slots": cs.get("slots", 8), "plan": plan, "waves": exec_waves, "tickets": tickets,
        "pruned": sorted(pruned), "graft_at": graft_at, "graft_blockedBy": graft_bb, "graft_fileKeys": graft_fk,
        "unrun": unrun, "gate_durs": gate_durs, "overheads": overheads, "merge_per_ticket": merges,
        "actual_raw": t_end - t0, "actual_gap_removed": actual, "flags": flags,
    }


def main():
    out, skipped = [], []
    for project in PROJECTS:
        for f in sorted(glob.glob(f"{CODE_ROOT}/{project}/.vetinari.local/logs/archive/orchestrator-*.jsonl")):
            rows = []
            for line in open(f):
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
            rows = normalize(rows)
            for seg in segment(rows):
                c = analyse(seg, project, os.path.basename(f))
                if c is None:
                    continue
                if "skip" in c:
                    skipped.append(c)
                else:
                    out.append(c)
    json.dump(out, open(os.path.join(HERE, "campaigns.json"), "w"), indent=1)
    json.dump(skipped, open(os.path.join(HERE, "skipped_parse.json"), "w"), indent=1)
    print(len(out), "campaigns;", len(skipped), "skipped at parse")
    for c in out:
        n = len(c["tickets"])
        print(f'{c["project"]:12} {c["start"][:16]} n={n:3} plan={sum(len(w) for w in c["plan"]):3} w={len(c["waves"]):2} slots={c["slots"]} '
              f'gate~{statistics.median(c["gate_durs"]) if c["gate_durs"] else -1:6.0f} oh~{statistics.median(c["overheads"]) if c["overheads"] else -1:6.0f} '
              f'act={c["actual_gap_removed"]/60:6.1f}m raw={c["actual_raw"]/60:6.1f}m unrun={len(c["unrun"])} {c["flags"]}')


main()
