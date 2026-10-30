"""Replay: would file-key-sharing campaign tickets have textually conflicted had they run in one wave?

Works only in the mirror clones under ./repos (git clone --mirror --shared); never touches the projects themselves.
Writes pairs.json.
"""
import json, os, re, subprocess, sys
from datetime import datetime, timedelta
from itertools import combinations

HERE = os.path.dirname(os.path.abspath(__file__))
REPLAY = os.path.join(HERE, "..", "replay")
cs = json.load(open(os.path.join(REPLAY, "campaigns.json")))
iss = json.load(open(os.path.join(REPLAY, "issues.json")))

# ---- copied verbatim from replay/sim.py (sim runs main() at import) ----
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
        return keys, "marker"
    keys = cites(body, False)
    return (keys, "fallback") if keys else (None, "none")
# -----------------------------------------------------------------------


def git(repo, *args, ok=(0,)):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if p.returncode not in ok:
        raise RuntimeError(f"{args}: {p.stderr}")
    return p.returncode, p.stdout


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def merges(repo):
    _, out = git(repo, "log", "--all", "--merges", "--format=%H %P %cI %s")
    res = {}
    for line in out.splitlines():
        parts = line.split(" ", 4)
        if len(parts) < 5 or len(parts[1]) != 40:
            continue
        h, p1, p2, date, subj = parts
        m = re.fullmatch(r"campaign: merge agent/(\S+)", subj)
        if not m:
            continue
        res.setdefault(m.group(1), {})[h] = (p1, p2, ts(date))
    return res


def mt(repo, base, ours, theirs):
    """git merge-tree; returns (tree, conflicted paths)."""
    rc, out = git(repo, "merge-tree", "--write-tree", "--name-only", "--no-messages",
                  "--merge-base", base, ours, theirs, ok=(0, 1))
    lines = out.splitlines()
    return lines[0], sorted(set(lines[1:])) if rc == 1 else []


def commit_tree(repo, tree, parent):
    _, out = git(repo, "commit-tree", tree, "-p", parent, "-m", "sim")
    return out.strip()


def names(repo, a, b):
    _, out = git(repo, "diff", "--name-only", "--no-renames", a, b)
    return set(out.split())


def main():
    by_proj = {}
    for c in cs:
        by_proj.setdefault(c["project"], []).append(c)
    pairs = []
    for proj, camps in by_proj.items():
        repo = os.path.join(HERE, "repos", proj + ".git")
        M = merges(repo)
        camps.sort(key=lambda c: c["start"])
        for i, c in enumerate(camps):
            lo = ts(c["start"]) - timedelta(minutes=1)
            hi = ts(camps[i + 1]["start"]) if i + 1 < len(camps) else lo + timedelta(days=30)
            hi = min(hi, lo + timedelta(days=4))
            info = {}
            for tid, t in c["tickets"].items():
                cands = [(d, h, p1, p2) for h, (p1, p2, d) in M.get(tid, {}).items() if lo <= d < hi]
                if not cands:
                    continue
                d, h, p1, p2 = min(cands)
                body = (iss.get(f"{c['repo']}#{tid}") or {}).get("body")
                keys, src = file_keys(body)
                info[tid] = dict(merge=h, p1=p1, tip=p2, date=d, keys=keys or set(), src=src, wave=t["wave"])
            for a, b in combinations(sorted(info), 2):
                A, B = info[a], info[b]
                shared = A["keys"] & B["keys"]
                rec = dict(project=proj, campaign=c["file"], start=c["start"], a=a, b=b, shared_keys=sorted(shared))
                if A["date"] > B["date"]:
                    A, B, rec["a"], rec["b"] = B, A, b, a
                rec["same_wave"] = A["wave"] == B["wave"]
                rec["A_merge"], rec["B_merge"] = A["merge"], B["merge"]
                pa = names(repo, A["p1"], A["merge"])
                pb = names(repo, B["p1"], B["merge"])
                rec["real_overlap"] = sorted(pa & pb)
                if not shared and not rec["real_overlap"]:
                    continue
                rec["predicted"] = bool(shared)
                if rec["real_overlap"]:
                    classify(repo, A, B, rec)
                pairs.append(rec)
            print(proj, c["file"], len(info), "merged of", len(c["tickets"]), file=sys.stderr)
    json.dump(pairs, open(os.path.join(HERE, "pairs.json"), "w"), indent=1, default=str)


def classify(repo, A, B, rec):
    _, base_b = git(repo, "merge-base", B["p1"], B["tip"])
    base_b = base_b.strip()
    rc = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", A["merge"], base_b]).returncode
    rec["b_saw_a"] = rc == 0
    # Primary: B's change (base_b..B tip) cherry-picked onto A's pre-merge base PA.
    tree, conf = mt(repo, base_b, A["p1"], B["tip"])
    if conf:
        rec["result"] = "indeterminate"
        rec["apply_conflicts"] = conf
        rec["apply_conflicts_in_A"] = sorted(set(conf) & names(repo, A["p1"], A["merge"]))
    else:
        bprime = commit_tree(repo, tree, A["p1"])
        # A' is A's merge commit itself: PA + A's change. Merge A' and B' with base PA.
        _, conf2 = mt(repo, A["p1"], A["merge"], bprime)
        rec["result"] = "conflict" if conf2 else "clean"
        rec["conflicts"] = conf2
        rec["bprime"] = bprime
    # Secondary counterfactual: everything else as it really happened, only A reverted out of B's base.
    #   X = PB with A reverted; B'' = X + B's change; then merge PB (=X+A) and B'' over X.
    X, c1 = mt(repo, A["merge"], B["p1"], A["p1"])
    if c1:
        rec["alt"] = "indeterminate"
        return
    Xc = commit_tree(repo, X, B["p1"])
    t2, c2 = mt(repo, base_b, Xc, B["tip"])
    if c2:
        rec["alt"] = "conflict-entangled"  # B's patch only applies on top of A's text
        rec["alt_conflicts"] = c2
        return
    B2 = commit_tree(repo, t2, Xc)
    _, c3 = mt(repo, Xc, B["p1"], B2)
    rec["alt"] = "conflict" if c3 else "clean"
    rec["alt_conflicts"] = c3


if __name__ == "__main__":
    main()
