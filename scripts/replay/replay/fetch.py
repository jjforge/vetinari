"""Fetch today's issue body + native blocked-by for every ticket in need.json (read-only GraphQL)."""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
need_path = os.path.join(HERE, "need.json")
if os.path.exists(need_path):
    need = json.load(open(need_path))
else:
    # Every ticket each parsed campaign planned, keyed by its repo.
    cs = json.load(open(os.path.join(HERE, "campaigns.json")))
    need = sorted({(c["repo"], str(t)) for c in cs for w in c["waves"] for t in w})
out_path = os.path.join(HERE, "issues.json")
out = json.load(open(out_path)) if os.path.exists(out_path) else {}
by_repo = {}
for repo, n in need:
    if f"{repo}#{n}" not in out:
        by_repo.setdefault(repo, []).append(int(n))
for repo, nums in by_repo.items():
    owner, name = repo.split("/")
    for i in range(0, len(nums), 40):
        chunk = nums[i:i + 40]
        fields = " ".join(
            f"i{n}:issue(number:{n}){{ number title body createdAt blockedBy(first:50){{nodes{{number}}}} }}" for n in chunk)
        q = f'{{ repository(owner:"{owner}",name:"{name}"){{ {fields} }} }}'
        r = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True)
        data = json.loads(r.stdout or "{}").get("data") or {}
        repo_d = data.get("repository") or {}
        for n in chunk:
            iss = repo_d.get(f"i{n}")
            out[f"{repo}#{n}"] = None if iss is None else {
                "title": iss["title"], "body": iss["body"], "createdAt": iss["createdAt"],
                "blockedBy": [x["number"] for x in iss["blockedBy"]["nodes"]]}
        print(repo, i, len(chunk), "errors" if r.returncode else "ok", flush=True)
json.dump(out, open(out_path, "w"))
print(len(out), "issues;", sum(v is None for v in out.values()), "missing")
