import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Finding, FindingContext } from "./findings.ts";
import type { Exclusion } from "./plan.ts";
import { repoForProject } from "./config.ts";
import { Refusal } from "./refusal.ts";

const execFileAsync = promisify(execFile);

// Promise-based so the `Promise.all` fan-outs in graft, campaign planning, prune and
// the dashboard previews actually overlap their `gh` calls instead of running one id
// after another (#368). A non-zero exit rejects, as the former `execFileSync` threw.
const gh = async (args: string[]): Promise<string> => (await execFileAsync("gh", args, { encoding: "utf8" })).stdout;

/** The default repo deriver every shipped resolver falls back to when no explicit
 * `owner/repo` is wired: the same live read of the project's `origin` remote that
 * `prune`/`graft` use (#338). */
const deriveRepoFromProject = (): string | undefined => repoForProject(process.cwd());

/**
 * Builds the per-resolver repo accessor the six GitHub factories share (#338). An
 * explicit `repo` always wins and short-circuits before any derivation — the deriver
 * is never even consulted. With no `repo`, the derivation is deferred to the first
 * call (never at config-module load) and memoized for the life of the resolver, so a
 * factory constructed without a repo derives at most once. If the derivation yields
 * `undefined` the accessor throws a `Refusal` (exit 4) naming the factory, so the
 * caller refuses before reaching `gh` rather than hitting the wrong — or no — repo.
 */
const repoAccessor = (factory: string, repo: string | undefined, deriveRepo: () => string | undefined): (() => string) => {
  if (repo !== undefined) return () => repo;
  let derived = false;
  let cached: string | undefined;
  return () => {
    if (!derived) {
      cached = deriveRepo();
      derived = true;
    }
    if (cached === undefined)
      throw new Refusal(
        `${factory}: couldn't derive owner/repo from this project's git remote — pass it explicitly, e.g. ${factory}("owner/repo")`,
      );
    return cached;
  };
};

/**
 * A ready `blockedBy` resolver over GitHub's native issue dependencies: for an
 * issue, the OPEN issues that BLOCK it (its `blocked_by` relationships). Drop it
 * into a config as `blockedBy: githubBlockedBy()` — the repo is derived from the
 * project's `origin`; pass `githubBlockedBy("owner/repo")` only when the tracker is
 * not the project's `origin` (#338).
 *
 * Closed blockers are filtered here at the edge: an already-merged prerequisite
 * does not gate, so `prune` and `campaign-plan` only ever see the blockers still
 * in flight. A `pending-verify` blocker is filtered too, even though GitHub still
 * reports it OPEN: its work is merged on the base and only the human close is
 * outstanding (`docs/issue-conventions.md`), so it is done and does not gate
 * (design §4 step 2). Without this, a dependent whose blocker is merged-but-unclosed
 * and outside the selection is dropped as unreachable — and every follow-up campaign
 * stalls waiting on the previous one's issues being closed by hand. So the blocker's
 * labels are requested alongside its state, and a `pending-verify` one is treated as
 * satisfied — but **named**, not silently dropped: each drop is both logged one line
 * and pushed to the optional `onExcluded` sink the planner passes, so it surfaces in the
 * plan's provenance text (an `Excluded:` section) rather than only on stderr — the same
 * data channel `githubIssuesByLabel` uses. The sink is optional so `prune`/`graft`, which
 * call this seam without one, are unaffected.
 *
 * Cross-repo blockers are dropped too (silently): a campaign is a set of ids in one
 * repo, so a blocker in another repo could not be one of them anyway. `run`/`log` are
 * injected only so the JSON handling can be tested without invoking `gh` or writing to
 * the real console.
 */
export const githubBlockedBy = (
  repo?: string,
  run: (args: string[]) => Promise<string> = gh,
  log: (line: string) => void = console.error,
  deriveRepo = deriveRepoFromProject,
) => {
  const repoOf = repoAccessor("githubBlockedBy", repo, deriveRepo);
  return async (id: string, onExcluded?: (e: Exclusion) => void): Promise<string[]> => {
    const repo = repoOf();
    const num = id.replace(/^#/, "").trim();
    const out = await run(["api", `repos/${repo}/issues/${num}/dependencies/blocked_by`]);
    const rows: Array<{
      number?: number;
      state?: string;
      labels?: Array<{ name?: string }> | null;
      repository?: { full_name?: string };
    }> = JSON.parse(out || "[]");
    const blockers: string[] = [];
    for (const r of rows) {
      if (r.number == null) continue;
      if (r.repository?.full_name && r.repository.full_name !== repo) continue;
      if (r.state === "closed") continue;
      if (r.labels?.some((l) => l?.name === "pending-verify")) {
        log(`[vetinari] #${num} — blocker #${r.number} pending-verify, treated as satisfied`);
        onExcluded?.({
          id: String(r.number),
          reason: `pending-verify blocker of #${num}, treated as satisfied`,
        });
        continue;
      }
      blockers.push(String(r.number));
    }
    return blockers;
  };
};

/**
 * A ready `fetchTask` resolver over `gh issue view`: the fields the orchestrator
 * reads off a task — `title`/`body`/`comments`/`labels` for the agent's prompt and
 * ticket prose, plus `state`/`closedAt` so `issueStateFromTask` can tell an OPEN
 * issue from a CLOSED one (the signal `graft` validates a candidate against, ADR
 * 0014). Drop it into a config as `fetchTask: githubFetchTask()` — the repo is
 * derived from the project's `origin`; pass `githubFetchTask("owner/repo")` only
 * when the tracker is not the project's `origin` (#338).
 *
 * `state`/`closedAt` are the point of centralizing this: a field list that omits
 * them parses as always-open, silently disabling graft's closed-id rejection. Fixing
 * the set here means a project config cannot re-drop it by hand-rolling the `--json`
 * list (#175). `run` is injected only so the argument building can be tested without
 * invoking `gh`.
 */
export const githubFetchTask = (repo?: string, run: (args: string[]) => Promise<string> = gh, deriveRepo = deriveRepoFromProject) => {
  const repoOf = repoAccessor("githubFetchTask", repo, deriveRepo);
  return async (id: string): Promise<string> => {
    const r = repoOf();
    const num = id.replace(/^#/, "").trim();
    return await run(["issue", "view", num, "--repo", r, "--json", "title,body,comments,labels,state,closedAt"]);
  };
};

/** How many issues a label lookup fetches. `gh issue list` lists only 30 by default,
 * which silently dropped a large label's oldest issues from a campaign (#434). */
const LABEL_FETCH_LIMIT = 1000;

/**
 * A ready `listByLabel` resolver over `gh issue list`: the numbers (as strings) of
 * the OPEN issues carrying `label` in `repo` **that are work**. Drop it into a config
 * as `listByLabel: githubIssuesByLabel()` so `campaign <label>` can select its issue
 * set from the tracker instead of a hand-typed id list — the repo is derived from the
 * project's `origin`; pass `githubIssuesByLabel("owner/repo")` only when the tracker is
 * not the project's `origin` (#338).
 *
 * Only open issues are listed (`--state open`) — a campaign works the live set — up to
 * `LABEL_FETCH_LIMIT`; a label that fills the limit logs one line saying some may be
 * missing, so a shortfall is never silent. An
 * issue whose native tracker type is `Epic` is a container that owns no work
 * (`docs/issue-conventions.md`) and is never scheduled, so it is dropped here at the
 * edge (matched case-insensitively; a row with no type is kept — an untyped issue is
 * work), design §4 step 1. A `pending-verify` issue is dropped too: it is merged on the
 * base awaiting a human's local verification and close (`docs/issue-conventions.md`),
 * so the work is already done — scheduling it cuts a fresh branch from a base that
 * already contains it and the agent parks `stalled/no-commit`. Each exclusion is both
 * logged one line and pushed to the optional `onExcluded` sink `expandSelection` passes,
 * so it surfaces in the plan's provenance text (an `Excluded:` section) rather than only
 * on stderr — the operator sees why the count is smaller than the label's even when the
 * plan is piped or captured.
 *
 * This is the label-expansion axis only: an explicit id list never reaches this seam
 * (`expandSelection` passes numeric tokens straight through), so an operator who names
 * a `pending-verify` id keeps it. `issueType`/`labels` are the only extra fields
 * requested; the planner pulls each issue's dep/fileset/title data lazily through the
 * other seams. `run`/`log` are injected only so the behaviour can be tested without
 * invoking `gh` or writing to the real console.
 */
export const githubIssuesByLabel = (
  repo?: string,
  run: (args: string[]) => Promise<string> = gh,
  log: (line: string) => void = console.error,
  deriveRepo = deriveRepoFromProject,
) => {
  const repoOf = repoAccessor("githubIssuesByLabel", repo, deriveRepo);
  return async (label: string, onExcluded?: (e: Exclusion) => void): Promise<string[]> => {
    const out = await run([
      "issue",
      "list",
      "--repo",
      repoOf(),
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      String(LABEL_FETCH_LIMIT),
      "--json",
      "number,issueType,labels",
    ]);
    const rows: Array<{
      number?: number;
      issueType?: { name?: string } | null;
      labels?: Array<{ name?: string }> | null;
    }> = JSON.parse(out || "[]");
    if (rows.length >= LABEL_FETCH_LIMIT)
      log(`[vetinari] label "${label}" returned ${rows.length} issues — the fetch limit; some may be missing`);
    const ids: string[] = [];
    for (const r of rows) {
      if (r.number == null) continue;
      if (r.issueType?.name?.toLowerCase() === "epic") {
        log(`[vetinari] #${r.number} — epic, not work (carries "${label}", not scheduled)`);
        onExcluded?.({ id: String(r.number), reason: "epic, not work" });
        continue;
      }
      if (r.labels?.some((l) => l?.name === "pending-verify")) {
        log(`[vetinari] #${r.number} — pending-verify, already merged (carries "${label}", not scheduled)`);
        onExcluded?.({ id: String(r.number), reason: "pending-verify, already merged" });
        continue;
      }
      ids.push(String(r.number));
    }
    return ids;
  };
};

/**
 * A ready `onIssueMerged` handler that advances an issue to the first hop of the
 * merge→`pending-verify`→close lifecycle (`docs/issue-conventions.md`): it adds
 * `pending-verify` and drops `ready-for-agent`. Drop it into a config as
 * `onIssueMerged: githubMarkPendingVerify()` — the repo is derived from the project's
 * `origin`; pass `githubMarkPendingVerify("owner/repo")` only when the tracker is not
 * the project's `origin` (#338).
 *
 * The orchestrator calls this per issue merged into the base with a green
 * merged-base gate — "merged on branch, awaiting a local end-to-end validation",
 * which is exactly `pending-verify`; closing stays a separate, human/verify step.
 * Idempotent: re-adding `pending-verify`, or removing `ready-for-agent` from an
 * issue that never carried it (a manual `campaign` batch), is harmless. `run` is
 * injected only so the argument building can be tested without invoking `gh`.
 */
export const githubMarkPendingVerify = (
  repo?: string,
  run: (args: string[]) => Promise<string> = gh,
  deriveRepo = deriveRepoFromProject,
) => {
  const repoOf = repoAccessor("githubMarkPendingVerify", repo, deriveRepo);
  return async (id: string): Promise<void> => {
    const r = repoOf();
    const num = id.replace(/^#/, "").trim();
    await run(["issue", "edit", num, "--repo", r, "--add-label", "pending-verify", "--remove-label", "ready-for-agent"]);
  };
};

/**
 * A ready `postComment` handler that posts a comment on an issue via `gh issue
 * comment`: the tracker-write seam the non-resumable park→answer path uses to
 * relay a human's answer (ADR 0004 / #212). The repo stays inside the closure —
 * the caller passes only the issue ref (a number, with or without a leading `#`)
 * and the comment body. Drop it into a config as `postComment: githubIssueComment()` —
 * the repo is derived from the project's `origin`; pass `githubIssueComment("owner/repo")`
 * only when the tracker is not the project's `origin` (#338).
 * `run` is injected only so the argument building can be tested without invoking `gh`.
 */
export const githubIssueComment = (repo?: string, run: (args: string[]) => Promise<string> = gh, deriveRepo = deriveRepoFromProject) => {
  const repoOf = repoAccessor("githubIssueComment", repo, deriveRepo);
  return async (issueRef: string, body: string): Promise<void> => {
    const r = repoOf();
    const num = String(issueRef).replace(/^#/, "").trim();
    await run(["issue", "comment", num, "--repo", r, "--body", body]);
  };
};

/**
 * A ready `reportFinding` handler that files each incidental finding as a GitHub
 * issue in `repo`, tagged with `labels` and cross-referenced to the task it was
 * found on. Returns the new issue URL that `gh issue create` prints. Drop it into a
 * config as `githubFindingReporter(undefined, { labels })` — the repo is derived from
 * the project's `origin`; pass `githubFindingReporter("owner/repo", { labels })` only
 * when the tracker is not the project's `origin` (#338). `run` is injected only so the
 * argument building can be tested without invoking `gh`.
 */
export const githubFindingReporter = (
  repo?: string,
  opts: { labels?: string[] } = {},
  run: (args: string[]) => Promise<string> = gh,
  deriveRepo = deriveRepoFromProject,
) => {
  const repoOf = repoAccessor("githubFindingReporter", repo, deriveRepo);
  return async (finding: Finding, ctx: FindingContext): Promise<string> => {
    const r = repoOf();
    const body = [
      finding.repro ? `**Repro:** ${finding.repro}` : "",
      finding.location ? `**Location:** ${finding.location}` : "",
      `Discovered by a Vetinari agent while working on #${ctx.taskId}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = ["issue", "create", "--repo", r, "--title", finding.summary, "--body", body];
    for (const label of opts.labels ?? []) args.push("--label", label);
    return (await run(args)).trim();
  };
};
