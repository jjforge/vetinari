# The ticket contract — what vetinari reads from and writes to a ticket

This is the one page a project that runs vetinari can point its triage tooling at — a `/triage` skill, `/check-brief`, a hand-written brief template. It covers only what vetinari reads off a ticket and what it writes back. How vetinari's _own_ tracker is organised (issue types, priority and area labels) is [`issue-conventions.md`](issue-conventions.md), and is not part of this contract.

It describes the **shipped defaults**: the `defaultFileSet` resolver and the `github*` tracker seams (`githubTracker()` wires all of them). A project that wires its own `fileSet`, `fetchTask`, `blockedBy`, `listByLabel`, `onIssueMerged` or `reportFinding` changes the rule for that seam.

## Where the file-set is read

The planner keeps co-wave tickets file-disjoint (the default; a project can opt out with `fileOverlap: "allow"`, which lays out waves by dependencies alone and leaves a collision to merge — it still reads every ticket's files, to report the overlaps), so it needs to know which files each ticket touches. It reads that from the ticket's text (`ticketProse`):

- **Title + body first.** When the title or body carries a marker line from which at least one cite parses, the comments are ignored entirely. Any such line counts, even one a later line supersedes. "Carries a marker" means a cite _parses_, not that it exists in the tree: a body marker naming an absent file still shadows every comment, and the ticket resolves not confident.
- **Otherwise, the comments' marker lines.** The marker lines across all comments are joined into one: the union of their cites. This is how a brief posted as a comment is read. A title + body whose marker lines cite nothing (only `Touches: none`, say) does not shadow the comments, so the comments' marker lines are read.
- **Comment prose is never scanned.** Only anchored marker lines are read from a comment; a filename mentioned elsewhere in a comment is ignored.
- **Within title + body, the last marker line of each kind wins.** A later, corrected line supersedes an earlier one. This holds even when the last line cites nothing: a closing cite-less line (`Touches: none`) after a cited one leaves the ticket with no files and not confident.
- **A cite-less marker line still counts as a marker line.** In title + body it suppresses the whole-body fallback below. So a ticket whose only marker line cites nothing, and whose comments carry no marker line, resolves no files and is not confident: its prose is never scanned, even for a filename that exists in the tree.
- **No marker line of either kind anywhere** — none in title + body, not even a cite-less one, and none in any comment → a whole-body scan of title + body is the fallback. Every path-shaped token counts and every one must exist in the tree, so an incidental filename in the prose forbids confidence. It is far likelier to resolve not confident; add a marker line.
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

- Every backticked token is a cite, so an extensionless `` `Makefile` `` or a dotfile `` `.gitignore` `` counts. A backticked non-file word (`` `campaign` ``) is a cite too, so on a `Touches:`/`Files:` line it forbids confidence. On a `Creates:` line the same word becomes a bare key (`*/campaign`) and the ticket stays confident, because `Creates:` cites are never checked against the tree.
- An unbackticked token counts only as a slash path (`src/report.ts`). An unbackticked `Makefile` or `report.ts` is not a cite.
- Backslash-escaped backticks (`` \`src/report.ts\` ``) are read as plain backticks.
- A trailing `:line` or `:line:col` is stripped, so `` `src/report.ts:42` `` cites `src/report.ts`.
- A trailing `.` on an unbackticked token is stripped, so `docs/x.md.` cites `docs/x.md`.
- Off a marker line (the whole-body fallback), a backticked token counts only if it contains a `/` or has an alphabetic extension (`report.ts`). This keeps ordinary words in backticks from becoming cites.

**`Touches:` and `Files:`** are one kind, so a later `Files:` line supersedes an earlier `Touches:`. Their cites are checked against the tree: the files git tracks or would track in the working directory the campaign runs in — tracked files plus untracked files that aren't ignored — so a gitignored file (build output, `.env`) is never a cite target. A submodule is not indexed — neither its gitlink path nor its files — and nor is anything under `.vetinari.local/`, vetinari's own cache, whether or not the project gitignores it. Resolving against a plain directory that isn't a git repository falls back to walking it, minus `.git`, `node_modules` and `.vetinari.local`.

- A cite resolves by longest-suffix match on path segments. A bare `report.ts` and a full `src/report.ts` find the same file.
- A cite whose basename the tree lacks forbids confidence; the planner reads it as a stale or mistyped note.
- Absence is judged by basename, so a cite with the wrong directory still resolves to the file of that name. A rooted cite is the exception: it is judged by its exact path.
- A bare name the tree holds several times, with nothing in the cite to narrow it, stays confident. Its key is the **bare key** `*/<name>`, meaning "this name in any directory", and it collides with **every** file of that name, so cite enough of the path to make it unique.
- A cite that resolves to one path keys to that exact path, a repo-root file included: `NOTES.md`, when the tree holds no other `NOTES.md`, does not collide with a `docs/NOTES.md`.
- A **rooted cite** starts with `./`. It names the path after `./` from the repository root and matches only a file at exactly that path: no suffix matching, no basename fallback. Its key is that path, so `./README.md` keys to the root `README.md` and `./docs/README.md` to `docs/README.md`. This is how to pin a root file whose name also exists deeper: a bare `README.md` stays ambiguous (the bare key `*/README.md`) whenever another `README.md` exists. A rooted cite with no file at exactly its path (`./READNE.md`, or `./wrong/report.ts` when only `src/report.ts` exists) forbids confidence. A rooted path in the whole-body fallback resolves the same way.

**`Creates:`** cites name files the ticket will add, so they are never checked against the tree. The cite's directory is resolved instead, by longest-suffix match against the tree's directories:

- A rooted cite (`./a/new.ts`): the key is the path after `./`, exactly, whether or not its directory exists, with no suffix matching. `./new.md` keys to the root file `new.md`, and `./a/new.ts` to `a/new.ts` even when the tree holds only `src/a`.
- One directory matches: the key is that directory plus the file name. `a/index.ts` with `src/a` in the tree keys to `src/a/index.ts`, so it collides with a `Touches:` of that file but not with an `index.ts` created elsewhere.
- No directory matches (a new directory): the key is the cited path as written. So cite a new directory by its full path from the repo root: `newdir/a.ts` and `src/newdir/a.ts` key differently and do not collide, so two tickets that mean the same new file land in one wave.
- Several directories match, or the cite is a bare name: the key is the bare key `*/<name>`, which collides with **every** file of that name.

**Don't cite the changelog fragment.** Each ticket's `changelog.d/<issue>.md` is unique to that ticket, so it can never collide. Citing the placeholder gives every ticket the same `<issue>.md` basename, so they all collide and the planner runs one ticket per wave.

**Waived files still go on `Touches:`.** A project may list files in `waivedFiles` — a large, sectioned doc most tickets update — and the planner then leaves a key exactly equal to an entry out of its collision checks, so tickets sharing only that file can share a wave; the plan names each waived file and how many tickets cited it. Matching is exact on the resolved key, so `README.md` waives only the repo-root file, and an ambiguous `README.md` cite, kept as the bare key `*/README.md`, is waived only by an entry spelled `*/README.md`. An entry that is a directory is refused. Under `packageScopedFileSet` a key is the package directory, not the file, so waiving a single `.go` file has no effect there.

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

This plans the selection and runs nothing. A ticket the planner pushed into a later wave because of a file collision reads `spilled — shares <file> with #<ticket>, …`, naming each shared file and the tickets it collided with there. Below the waves, `lower bound: N waves — …` says how few waves any plan of these file-sets could take, and whether a dependency chain or one shared file sets that; `Most-shared files:` lists each file cited by at least a quarter of the scheduled tickets, with its count. When the bound is a file and sits near the wave count, the fix is in the tickets' file-sets — split or waive the file — not the planner. After the plan, it prints one line per selected ticket: the files it resolved to, or `NOT confident`. Those lines come from the same resolver the planner uses, so what they show is what the planner will see. They print even for a one-issue selection, and even when the plan refuses because a ticket is under-specified. Add `--on-underspecified=drop` only if you also want to see the plan for the rest of the selection.
