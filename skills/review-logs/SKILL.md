---
name: review-logs
description: "Mine this project's vetinari run logs for where agents struggled, and suggest changes to the project that would make the next campaign faster and cleaner. Use when asked to review vetinari logs, run history, or what to improve in the project."
---

# Review this project's vetinari logs

Every campaign leaves a trail of agents working on this project: what they read, what they ran, where the gate went red, what parked. This skill reads that trail and finds the **friction** — time, tool calls and failures an agent spent because of something in the project — then turns each into a suggested change to the project, backed by evidence. It is **read-only** until the report: it changes no code, no campaign state and nothing on GitHub.

The subject is the project the skill runs in: its code, tests, docs, briefs and vetinari config. A finding about vetinari itself goes in a short closing note, not the ranked list.

## Where the logs live

Under the project's `.vetinari.local/logs/`:

- `orchestrator.jsonl` and `archive/orchestrator-*.jsonl` — the event log, one JSON object per line with `ts` and `event`.
- `activity-<n>.jsonl` — one task's agent activity: `tool` (with `name` and `path`), `sandbox-exec` (the shell command), `turn` (with `summary`), `gate-result`, `commit`. A turn's `usage` is not a run total; size work by tool calls and minutes.
- `agent-<n>.log` — the turn log; each run starts at a `--- Run started` line and ends with the agent's account, `<turn-summary>` and `<promise>`.
- `gate-<ts>.log` — one gate run's full output, named by a `gate-result` event's `outFile`.

Event schemas drift between versions: older logs lack fields newer ones carry. Treat a missing field as unknown, not zero.

## Steps

1. **Scope.** Settle the window — the one the user gave, or all history. Read the project's agent-facing context (`CLAUDE.md`/`AGENTS.md`, the issue conventions, `vetinari/config.mts` and its Dockerfile) so you can tell what agents were already told. Done when you have a since-date and know what the project tells its agents.

2. **Digest.** Run `digest.sh <projectRoot> [since]` from this skill's directory. It prints event counts, each task's last outcome, per-task activity (turns, tool calls, shell commands, failing gates, minutes) sorted slowest first, and every failing gate. Done when you have the digest.

3. **Hunt.** Work through every lens below, then open the raw logs behind each signal — read the logs, not the counts alone. Done when every lens has been applied and each signal is either a candidate or explained away.

   - **Outcomes** — every `failed`, `parked`, `empty-green`, `halt`, `campaign-merge-conflict`: read its reason, the agent log's last turn, and the gate output. What in the project — a brief, a test, a hotspot file — made it stop?
   - **Red gates** — read each failing `gate-<ts>.log`. A failure class that recurs (a flaky test, a check agents never ran locally, a missing tool in the image) points at the tests, the gate commands or the Dockerfile.
   - **Hotspots** — the files agents read and edit most across tasks (`jq -r 'select(.event=="tool").path'`), and the files behind merge conflicts. A file every task must touch or wade through is a candidate to split or document.
   - **Churn** — the slowest and most tool-heavy tasks. Read their activity log for the same command or file read over and over, long exploration before the first edit, a slow suite re-run after every small change. Name what in the project caused it.
   - **Repeated orientation** — commands most agents run at the start of every task (`jq -r 'select(.event=="sandbox-exec").cmd'` across activity logs, normalised and counted). A fact every agent rediscovers belongs in `CLAUDE.md`/`AGENTS.md`; a slow lookup belongs in a script.
   - **Agent accounts** — the `summary` of each `turn` and the agent log's closing account. Agents report faults in passing ("in the touches hint but needed no change", "the brief named a field that doesn't exist", "the docs say X but the code does Y"): these are brief-quality, file-set and stale-doc findings.

4. **Verify.** Logs are history; the project has moved since. For each candidate, check that the cause still exists on the current base — read the file, test or doc, and `git log` for a fix since the run's date. Search the project's tracker (`gh issue list --state all --search "<terms>"`) for an existing issue. Drop what is already fixed; attach the issue number to what is already filed. Done when every surviving suggestion rests on evidence you checked against today's code.

5. **Report.** Rank the suggestions by the friction they remove — failures first, then time, then smaller paper cuts. For each:
   - the friction, in one line, with its size (how many tasks or runs, how many minutes or tool calls);
   - the evidence: two or three concrete events or log excerpts, each with its file and `ts`;
   - the cause in the project — the file, test, doc line, brief convention or config entry;
   - the change you suggest, as small as fixes it;
   - the existing issue, or a one-line title for a new one.

   Then, briefly, any finding about vetinari itself, and the signals you explained away, one line each, so the next review does not re-chase them. Ask which suggestions to file; file the chosen ones per the project's issue conventions.
