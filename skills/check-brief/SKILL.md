---
name: check-brief
description: "Check an issue's brief against the code before it goes ready-for-agent: names, contradictions, untestable criteria, line-number cites, missing native blockers, file-set marker. Use when triaging, before labelling ready-for-agent, or asked to check a brief."
---

# Check a brief before it goes ready-for-agent

A vetinari agent works from the issue alone — body and comments — and parks with a question when the brief asks for something the code can't give: a column the format doesn't have, an event the database doesn't record, a criterion its own out-of-scope list rules out, a line-number cite that went stale before the run, or behaviour another open issue hasn't landed yet with no `blocked_by` edge to hold it back. Each such park costs a person's answer and a stalled campaign. This skill catches those mistakes while the brief is still a draft. It **only reports**: it changes nothing on GitHub and nothing in the repo; the person decides what to rewrite.

## Steps

1. **Read.** `gh issue view <n> --json title,body,comments,labels`. Done when you have the brief's text and know the repo it targets (the current one unless the issue says otherwise).

2. **Check.** Launch one general-purpose subagent, briefed with [`checker.md`](checker.md), passing the issue number, the repo path and the base branch (the `baseBranch` in the project's `vetinari/config.mts`, else `main`). Use a fresh subagent even when you could do it yourself: the check is only worth anything from a reader who didn't write the brief. Done when it returns its findings.

3. **Sift.** Re-check each finding the subagent marks as a **blocker** yourself — open the file, run the grep — and drop any you can't confirm. Done when every blocker left is one you've seen.

4. **Report**, in the conversation. Blockers first (a criterion an agent would park on, or a brief that builds on an open issue with no native `blocked_by` edge), then lesser findings (untestable criteria, line-number cites, file-set gaps), each with the criterion quoted, what's wrong, the evidence (file and line, or the search that came up empty) and a suggested rewrite. End with a verdict: **ready** (no blockers), or **fix first** with the list. A brief with no findings gets one line saying so.
