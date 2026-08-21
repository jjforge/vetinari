import { execFileSync } from "node:child_process";

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
  (repo: string, run: (args: string[]) => string = (args) => execFileSync("gh", args, { encoding: "utf8" })) =>
  (id: string): string[] => {
    const num = id.replace(/^#/, "").trim();
    const out = run(["api", `repos/${repo}/issues/${num}/dependencies/blocked_by`]);
    const rows: Array<{ number?: number; repository?: { full_name?: string } }> = JSON.parse(out || "[]");
    return rows
      .filter((r) => r.number != null && (!r.repository?.full_name || r.repository.full_name === repo))
      .map((r) => String(r.number));
  };
