import { execFileSync } from "node:child_process";
import type { Finding, FindingContext } from "./findings.ts";

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

/**
 * A ready `blockedBy` resolver over GitHub's native issue dependencies: for an
 * issue, the OPEN issues that BLOCK it (its `blocked_by` relationships). Drop it
 * into a config as `blockedBy: githubBlockedBy("owner/repo")`.
 *
 * Closed blockers are filtered here at the edge: an already-merged prerequisite
 * does not gate, so `prune` and `campaign-plan` only ever see the blockers still
 * in flight. Cross-repo blockers are dropped too: a campaign is a set of ids in
 * one repo, so a blocker in another repo could not be one of them anyway. `run`
 * is injected only so the JSON handling can be tested without invoking `gh`.
 */
export const githubBlockedBy =
  (repo: string, run: (args: string[]) => string = gh) =>
  (id: string): string[] => {
    const num = id.replace(/^#/, "").trim();
    const out = run([
      "api",
      `repos/${repo}/issues/${num}/dependencies/blocked_by`,
    ]);
    const rows: Array<{
      number?: number;
      state?: string;
      repository?: { full_name?: string };
    }> = JSON.parse(out || "[]");
    return rows
      .filter(
        (r) =>
          r.number != null &&
          r.state !== "closed" &&
          (!r.repository?.full_name || r.repository.full_name === repo),
      )
      .map((r) => String(r.number));
  };

/**
 * A ready `fetchTask` resolver over `gh issue view`: the fields the orchestrator
 * reads off a task — `title`/`body`/`comments`/`labels` for the agent's prompt and
 * ticket prose, plus `state`/`closedAt` so `issueStateFromTask` can tell an OPEN
 * issue from a CLOSED one (the signal `graft` validates a candidate against, ADR
 * 0014). Drop it into a config as `fetchTask: githubFetchTask("owner/repo")`.
 *
 * `state`/`closedAt` are the point of centralizing this: a field list that omits
 * them parses as always-open, silently disabling graft's closed-id rejection. Fixing
 * the set here means a project config cannot re-drop it by hand-rolling the `--json`
 * list (#175). `run` is injected only so the argument building can be tested without
 * invoking `gh`.
 */
export const githubFetchTask =
  (repo: string, run: (args: string[]) => string = gh) =>
  (id: string): string => {
    const num = id.replace(/^#/, "").trim();
    return run([
      "issue",
      "view",
      num,
      "--repo",
      repo,
      "--json",
      "title,body,comments,labels,state,closedAt",
    ]);
  };

/**
 * A ready `listByLabel` resolver over `gh issue list`: the numbers (as strings) of
 * the OPEN issues carrying `label` in `repo`. Drop it into a config as
 * `listByLabel: githubIssuesByLabel("owner/repo")` so `campaign <label>` can select
 * its issue set from the tracker instead of a hand-typed id list.
 *
 * Only open issues are listed (`--state open`) — a campaign works the live set — and
 * only the number is requested, since the planner pulls each issue's dep/fileset/title
 * data lazily through the other seams. `run` is injected only so the argument building
 * can be tested without invoking `gh`.
 */
export const githubIssuesByLabel =
  (repo: string, run: (args: string[]) => string = gh) =>
  (label: string): string[] => {
    const out = run([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    const rows: Array<{ number?: number }> = JSON.parse(out || "[]");
    return rows
      .filter((r) => r.number != null)
      .map((r) => String(r.number));
  };

/**
 * A ready `onIssueMerged` handler that advances an issue to the first hop of the
 * merge→`pending-verify`→close lifecycle (`docs/issue-conventions.md`): it adds
 * `pending-verify` and drops `ready-for-agent`. Drop it into a config as
 * `onIssueMerged: githubMarkPendingVerify("owner/repo")`.
 *
 * The orchestrator calls this per issue merged into the base with a green
 * merged-base gate — "merged on branch, awaiting a local end-to-end validation",
 * which is exactly `pending-verify`; closing stays a separate, human/verify step.
 * Idempotent: re-adding `pending-verify`, or removing `ready-for-agent` from an
 * issue that never carried it (a manual `campaign` batch), is harmless. `run` is
 * injected only so the argument building can be tested without invoking `gh`.
 */
export const githubMarkPendingVerify =
  (repo: string, run: (args: string[]) => string = gh) =>
  (id: string): void => {
    const num = id.replace(/^#/, "").trim();
    run([
      "issue",
      "edit",
      num,
      "--repo",
      repo,
      "--add-label",
      "pending-verify",
      "--remove-label",
      "ready-for-agent",
    ]);
  };

/**
 * A ready `reportFinding` handler that files each incidental finding as a GitHub
 * issue in `repo`, tagged with `labels` and cross-referenced to the task it was
 * found on. Returns the new issue URL that `gh issue create` prints. `run` is
 * injected only so the argument building can be tested without invoking `gh`.
 */
export const githubFindingReporter =
  (
    repo: string,
    opts: { labels?: string[] } = {},
    run: (args: string[]) => string = gh,
  ) =>
  (finding: Finding, ctx: FindingContext): string => {
    const body = [
      finding.repro ? `**Repro:** ${finding.repro}` : "",
      finding.location ? `**Location:** ${finding.location}` : "",
      `Discovered by a Vetinari agent while working on #${ctx.taskId}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      finding.summary,
      "--body",
      body,
    ];
    for (const label of opts.labels ?? []) args.push("--label", label);
    return run(args).trim();
  };
