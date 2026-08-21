import { execFileSync } from "node:child_process";
import type { Finding, FindingContext } from "./findings.ts";

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

/**
 * A ready `blockedBy` resolver over GitHub's native issue dependencies: for an
 * issue, the issues that BLOCK it (its `blocked_by` relationships). Drop it into
 * a config as `blockedBy: githubBlockedBy("owner/repo")`.
 *
 * Cross-repo blockers are dropped: a campaign is a set of ids in one repo, so a
 * blocker in another repo could not be one of them anyway. `run` is injected
 * only so the JSON handling can be tested without invoking `gh`.
 */
export const githubBlockedBy =
  (repo: string, run: (args: string[]) => string = gh) =>
  (id: string): string[] => {
    const num = id.replace(/^#/, "").trim();
    const out = run(["api", `repos/${repo}/issues/${num}/dependencies/blocked_by`]);
    const rows: Array<{ number?: number; repository?: { full_name?: string } }> = JSON.parse(out || "[]");
    return rows
      .filter((r) => r.number != null && (!r.repository?.full_name || r.repository.full_name === repo))
      .map((r) => String(r.number));
  };

/**
 * A ready `reportFinding` handler that files each incidental finding as a GitHub
 * issue in `repo`, tagged with `labels` and cross-referenced to the task it was
 * found on. Returns the new issue URL that `gh issue create` prints. `run` is
 * injected only so the argument building can be tested without invoking `gh`.
 */
export const githubFindingReporter =
  (repo: string, opts: { labels?: string[] } = {}, run: (args: string[]) => string = gh) =>
  (finding: Finding, ctx: FindingContext): string => {
    const body = [
      finding.repro ? `**Repro:** ${finding.repro}` : "",
      finding.location ? `**Location:** ${finding.location}` : "",
      `Discovered by a sandcastle agent while working on #${ctx.taskId}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = ["issue", "create", "--repo", repo, "--title", finding.summary, "--body", body];
    for (const label of opts.labels ?? []) args.push("--label", label);
    return run(args).trim();
  };
