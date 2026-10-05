# The ticket contract — what vetinari reads from and writes to a ticket

This is the one page a project that runs vetinari can point its triage tooling at — a `/triage` skill, `/check-brief`, a hand-written brief template. It covers only what vetinari reads off a ticket and what it writes back. How vetinari's _own_ tracker is organised (issue types, priority and area labels) is [`issue-conventions.md`](issue-conventions.md), and is not part of this contract.

It describes the **shipped defaults**: the `defaultFileSet` resolver and the `github*` tracker seams (`githubTracker()` wires all of them). A project that wires its own `fileSet`, `fetchTask`, `blockedBy`, `listByLabel`, `onIssueMerged` or `reportFinding` changes the rule for that seam.

## Where the file-set is read

The planner keeps co-wave tickets file-disjoint, so it needs to know which files each ticket touches. It reads that from the ticket's text (`ticketProse`):

- **Title + body first.** When the title or body carries a marker line from which at least one cite parses, the comments are ignored entirely. Any such line counts, even one a later line supersedes. "Carries a marker" means a cite _parses_, not that it exists in the tree: a body marker naming an absent file still shadows every comment, and the ticket resolves not confident.
- **Otherwise, the comments' marker lines.** The marker lines across all comments are joined into one: the union of their cites. This is how a brief posted as a comment is read. A title + body whose marker lines cite nothing (only `Touches: none`, say) carry no marker, so the comments' marker lines are read.
- **Comment prose is never scanned.** Only anchored marker lines are read from a comment; a filename mentioned elsewhere in a comment is ignored.
- **Within title + body, the last marker line of each kind wins.** A later, corrected line supersedes an earlier one. This holds even when the last line cites nothing: a closing cite-less line (`Touches: none`) after a cited one leaves the ticket with no files and not confident.
- **No marker line of either kind anywhere** → a whole-body scan of title + body is the fallback. Every path-shaped token counts and every one must exist in the tree, so an incidental filename in the prose forbids confidence. It is far likelier to resolve not confident; add a marker line.
- **A one-issue selection skips the file-set check.** It has no co-wave to collide with, so `campaign <id>` runs a lone ticket with no marker at all.

## Marker syntax

```
Touches (existing files): `src/report.ts`, `docs/reference.md`
Creates (new files): `src/report-format.ts`, `src/report-format.test.ts`
```

**The marker line.** A marker line starts a line with `Touches`, `Files` or `Creates`. Matching is case-insensitive.

- It may be indented, and may open with one list bullet (`-`, `*` or `+`) and any number of `*`, so `- **Touches:**` anchors.
- Any text may follow the keyword up to the first colon: `Touches (existing files):`, `Files changed:`.
- Numbered items (`1. Touches:`) and blockquotes (`> Touches:`) do **not** anchor. Neither does a longer word such as `Filesystem:`.
- A marker line inside a code fence **does** anchor.

**Cites on a marker line.** Everything after the colon is read for cites:

- Every backticked token is a cite, so an extensionless `` `Makefile` `` or a dotfile `` `.gitignore` `` counts. A backticked non-file word (`` `campaign` ``) is a cite too, so it forbids confidence.
- An unbackticked token counts only as a slash path (`src/report.ts`). An unbackticked `Makefile` or `report.ts` is not a cite.
- Backslash-escaped backticks (`` \`src/report.ts\` ``) are read as plain backticks.
- A trailing `:line` or `:line:col` is stripped, so `` `src/report.ts:42` `` cites `src/report.ts`.
- Off a marker line (the whole-body fallback), a backticked token counts only if it contains a `/` or has an alphabetic extension (`report.ts`). This keeps ordinary words in backticks from becoming cites.

**`Touches:` and `Files:`** are one kind, so a later `Files:` line supersedes an earlier `Touches:`. Their cites are checked against the tree: the working directory the campaign runs in, minus `.git` and `node_modules`.

- A cite resolves by longest-suffix match on path segments. A bare `report.ts` and a full `src/report.ts` find the same file.
- A cite whose basename the tree lacks forbids confidence; the planner reads it as a stale or mistyped note.
- Absence is judged by basename, so a cite with the wrong directory still resolves to the file of that name.
- A bare name the tree holds several times, with nothing in the cite to narrow it, stays confident. It collides with **every** file of that name, so cite enough of the path to make it unique.

**`Creates:`** cites name files the ticket will add. They are compared by basename and never checked against the tree.

**Don't cite the changelog fragment.** Each ticket's `changelog.d/<issue>.md` is unique to that ticket, so it can never collide. Citing the placeholder gives every ticket the same `<issue>.md` basename, so they all collide and the planner runs one ticket per wave.

## Dependencies

Read by `blockedBy` (`githubBlockedBy`):

- Only native GitHub `blocked_by` edges count. A `Blocked by: #12` line in the body or a comment is ignored.
- Closed blockers don't gate.
- Blockers in another repo don't gate.
- Blockers labelled `pending-verify` don't gate: their work is already merged. The planner names them under `Excluded:` in its output.

## Labels vetinari reads

- **`campaign <label>`** expands, through `listByLabel` (`githubIssuesByLabel`), to the open issues carrying that label, up to 1000. It leaves out issues whose issue type is `Epic` and issues labelled `pending-verify`, and names each one it leaves out. An issue id you name explicitly is never filtered this way.
- **The area labels** (`AREA_LABELS` — `orchestrator`, `gateway`, `comms`, `dashboard`, `layout`, `launcher`) on the selected issues feed the dry run's suggested `--name`. No other label changes planning.

## What vetinari writes

- **On a green merge** the `onIssueMerged` handler runs. With `githubMarkPendingVerify` (the one `githubTracker()` wires), that adds `pending-verify` and removes `ready-for-agent`, once the merged base passes its gate. Closing the issue stays a human step.
- **Harvested findings** are filed by `reportFinding` as new issues. Each cites the task it was found on. With `githubFindingReporter`, a finding carries exactly the labels passed in its `labels` option, and none if none are passed. The `githubTracker()` preset passes its `findingLabels` option, which defaults to `["needs-triage"]`.
- **An answer to a parked question**, for an agent provider that cannot resume its session, is posted as a comment on the issue through `postComment` (`githubIssueComment`). The fresh run then reads it with the rest of the ticket.

## What the agent sees

The agent's prompt receives the raw `fetchTask` payload in place of `{{TASK}}`. With `githubFetchTask` that is the issue's JSON with `title`, `body`, `comments`, `labels`, `state` and `closedAt`, and nothing else: no linked issues, no pull requests, no sub-issues. A brief that depends on text in another issue has to quote it. The payload is fetched when the run starts, so an edit made after that may not reach a running agent.

## Self-check before a campaign

```
vetinari campaign --dry-run <ids-or-label>
```

This plans the selection and runs nothing. After the plan, it prints one line per selected ticket: the files it resolved to, or `NOT confident`. Those lines come from the same resolver the planner uses, so what they show is what the planner will see. They print even for a one-issue selection, and even when the plan refuses because a ticket is under-specified. Add `--on-underspecified=drop` only if you also want to see the plan for the rest of the selection.
