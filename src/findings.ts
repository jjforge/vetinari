import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hash } from "./issue-id.ts";

/**
 * Incidental findings: defects an agent notices while working a task but does
 * not fix, because fixing them is out of scope. That knowledge lives only in the
 * container's session and vanishes when the container is torn down — so the
 * orchestrator harvests it in a final turn and files it somewhere durable.
 */

export interface Finding {
  summary: string;
  location?: string;
  repro?: string;
  /** The agent's own rating, `P0`–`P3`; absent when it gave none (or an unrecognised one). */
  severity?: Severity;
}

export type Severity = "P0" | "P1" | "P2" | "P3";

export interface FindingContext {
  taskId: string;
  project: string;
  /**
   * The non-green exit this finding was harvested from (the park detail — e.g.
   * `budget:6`, `idle`). A finding from a stalled agent is weaker evidence than one
   * from a green run: the agent never proved its understanding by passing the gate,
   * so triage should weigh it accordingly. Absent for a green run, whose filed form
   * is unchanged.
   */
  source?: string;
}

/** Files one finding and returns the created record's URL, if any. */
export type FindingReporter = (finding: Finding, ctx: FindingContext) => string | void | Promise<string | void>;

export interface FindingResult {
  finding: Finding;
  url?: string;
  error?: string;
}

/**
 * The harvest turn. Run on the agent's own session right before teardown, so it
 * answers with the full context of the work it just did. Ends on the COMPLETE
 * signal the loop already listens for.
 */
export const HARVEST_PROMPT = `Before we stop — this container is about to be destroyed, so this is your only chance to record what you saw.

Did you notice any defect UNRELATED to this task while working — something broken you did NOT fix because it was out of scope? Do NOT include the work you just did, and do not invent anything; only what you actually observed.

For each such defect, emit one block:
<finding>
  <summary>one line</summary>
  <location>file path or area</location>
  <repro>how to see it</repro>
  <severity>P0 data loss | P1 blocks work | P2 major | P3 minor</severity>
</finding>

If you noticed nothing, emit exactly:
<finding>none</finding>

Then emit <promise>COMPLETE</promise>.`;

const field = (block: string, tag: string): string | undefined => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  const value = m?.[1].trim();
  return value ? value : undefined;
};

/** Pull every `<finding>` block out of an agent's stdout. `none` yields zero. */
export function parseFindings(stdout: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of stdout.matchAll(/<finding>([\s\S]*?)<\/finding>/gi)) {
    const inner = m[1].trim();
    if (!inner || inner.toLowerCase() === "none") continue;
    // A well-formed block has a <summary>; a loosely-formatted one still counts,
    // with its whole text as the summary, rather than being silently dropped.
    const summary =
      field(inner, "summary") ??
      inner
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!summary) continue;
    const finding: Finding = { summary, location: field(inner, "location"), repro: field(inner, "repro") };
    const severity = field(inner, "severity")
      ?.match(/\bP[0-3]\b/i)?.[0]
      .toUpperCase() as Severity | undefined;
    if (severity) finding.severity = severity;
    findings.push(finding);
  }
  return findings;
}

/**
 * A finding harvested from a non-green session, marked so the filed issue reads as
 * weaker evidence. The mark rides on the summary — the one field every reporter
 * renders (as the issue title), so the caution is visible to a triager whatever the
 * reporter is, without every reporter having to know about `source`. A green finding
 * (no source) is returned untouched.
 */
const markForSource = (finding: Finding, source: string | undefined): Finding =>
  source ? { ...finding, summary: `[unverified: ${source}] ${finding.summary}` } : finding;

/**
 * File each finding through `reporter`, isolating a failure to its own finding
 * so one bad report never loses the others. Returns per-finding outcomes for the
 * caller to log — carrying the ORIGINAL finding, since the `source` mark is a filing
 * concern, not part of what was observed.
 */
export async function reportFindings(reporter: FindingReporter, findings: Finding[], ctx: FindingContext): Promise<FindingResult[]> {
  const results: FindingResult[] = [];
  for (const finding of findings) {
    try {
      const url = await reporter(markForSource(finding, ctx.source), ctx);
      results.push({ finding, url: typeof url === "string" ? url : undefined });
    } catch (e: any) {
      results.push({ finding, error: String(e?.message ?? e) });
    }
  }
  return results;
}

/**
 * The identity two findings share when they describe the same thing: the summary
 * lowercased, punctuation collapsed, and the non-green `[unverified: …]` mark dropped —
 * so the title a filed issue carries matches the summary the next agent writes.
 */
export const findingKey = (title: string): string =>
  title
    .replace(/^\[unverified:[^\]]*\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const SIMILARITY_STOP_WORDS = new Set("a an the in of to for on is are fails failed with and or".split(" "));

/** Two findings at or above this `findingSimilarity` score are the same finding. */
export const FINDING_MATCH_THRESHOLD = 0.5;

/**
 * How alike two finding titles are, 0–1: the Jaccard score of their `findingKey` words,
 * stop words dropped — so separate agents' own wordings of one defect still match.
 */
export function findingSimilarity(a: string, b: string): number {
  const words = (title: string) =>
    new Set(
      findingKey(title)
        .split(" ")
        .filter((w) => w && !SIMILARITY_STOP_WORDS.has(w)),
    );
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const either = wa.size + wb.size - shared;
  return either ? shared / either : Number(findingKey(a) === findingKey(b));
}

/** The best-scoring candidate whose title matches `title` (score ≥ `FINDING_MATCH_THRESHOLD`), if any. */
export function bestFindingMatch<T>(title: string, candidates: Iterable<T>, titleOf: (c: T) => string): T | undefined {
  let best: T | undefined;
  let bestScore = FINDING_MATCH_THRESHOLD;
  for (const c of candidates) {
    const score = findingSimilarity(title, titleOf(c));
    if (score >= bestScore && (best === undefined || score > bestScore)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Where a harvested finding went: filed as a new issue, commented on an existing one, or digested. */
export interface TriagedFinding extends FindingResult {
  action: "filed" | "seen-again" | "digest";
  /** The open-issue search failed with this; the finding was triaged as unmatched. */
  searchError?: string;
}

export interface FindingPolicy {
  reporter: FindingReporter;
  /** An open tracker issue whose title matches this finding's, if one exists (`githubFindOpenIssue`). */
  findOpenIssue?: (title: string) => string | undefined | Promise<string | undefined>;
  /** The comment hook: "seen again" on a duplicate, and the run's one digest. */
  postComment?: (issueRef: string, body: string) => void | Promise<void>;
  /** This campaign's filings so far, `findingKey(summary)` → issue ref — read under the lock, matched by `findingSimilarity`. */
  filedSoFar: () => Map<string, string>;
  /** Record one outcome; called under the lock, so the next run's `filedSoFar` sees a filing. */
  record: (r: TriagedFinding) => void;
  maxPerRun: number;
  severityFloor: Severity;
  /** The cross-process lock serializing dedupe-then-file across a campaign's parallel runs. */
  lockFile: string;
}

const rank = (s: Severity | undefined) => (s ? Number(s[1]) : 2);

/**
 * File a run's findings without flooding the tracker: a finding this campaign already
 * filed, or one matching an open issue — by `findingSimilarity`, so a rewording still
 * matches — gets a "seen again" comment instead of a new issue; of the rest, only those at or above `severityFloor` are filed — most severe
 * first, at most `maxPerRun` — and everything else goes into ONE digest comment on the
 * run's own issue. An unrated finding counts as P2, so a loosely-formatted block is
 * neither dropped nor demoted. Parallel runs serialize on `lockFile` across the whole
 * check-then-file, because the tracker's search cannot see an issue filed seconds ago.
 * A failure is isolated to its own finding, as `reportFindings` does; a failed open-issue
 * search counts as no match, so the finding is still filed or digested.
 */
export async function triageFindings(findings: Finding[], ctx: FindingContext, p: FindingPolicy): Promise<TriagedFinding[]> {
  const out: TriagedFinding[] = [];
  const digest: Finding[] = [];
  await withFileLock(p.lockFile, async () => {
    const filed = p.filedSoFar();
    let fresh = 0;
    const ordered = [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
    for (const finding of ordered) {
      const key = findingKey(finding.summary);
      let r: TriagedFinding;
      // A failed search is no match: the finding is triaged as fresh rather than lost.
      let seen = bestFindingMatch(finding.summary, filed, ([k]) => k)?.[1];
      let searchError: string | undefined;
      if (!seen) {
        try {
          seen = await p.findOpenIssue?.(finding.summary);
        } catch (e: any) {
          searchError = String(e?.message ?? e);
        }
      }
      try {
        if (seen) {
          await p.postComment?.(
            seen,
            `Seen again while working on ${hash(ctx.taskId)}${ctx.source ? ` (unverified: ${ctx.source})` : ""}.`,
          );
          r = { finding, url: seen, action: "seen-again" };
        } else if (rank(finding.severity) > rank(p.severityFloor) || fresh >= p.maxPerRun) {
          digest.push(finding);
          r = { finding, action: "digest" };
        } else {
          const url = await p.reporter(markForSource(finding, ctx.source), ctx);
          fresh++;
          r = { finding, url: typeof url === "string" ? url : undefined, action: "filed" };
          if (r.url) filed.set(key, r.url);
        }
      } catch (e: any) {
        r = { finding, error: String(e?.message ?? e), action: "filed" };
      }
      if (searchError) r.searchError = searchError;
      p.record(r);
      out.push(r);
    }
  });
  if (digest.length && p.postComment) {
    const lines = digest.map((f) => `- ${f.severity ? `**${f.severity}** ` : ""}${f.summary}${f.location ? ` — \`${f.location}\`` : ""}`);
    await p.postComment(
      ctx.taskId,
      [`Findings noticed during this run, not filed (below the severity floor or over the per-run cap):`, "", ...lines].join("\n"),
    );
  }
  return out;
}

/** Is `pid` a live process? EPERM means it exists but we may not signal it. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

/**
 * Hold an exclusively-created lock file (`wx`) across an async `fn` — the async
 * twin of host-slots' lock. A lock whose recorded holder pid is dead is reclaimed.
 */
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // Released between our open and read — retry.
      }
      if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
        try {
          unlinkSync(path);
        } catch {
          // Someone else reclaimed it first.
        }
        continue;
      }
      if (attempt > 6000) throw new Error(`findings: could not acquire lock ${path} (holder pid ${holder})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort.
    }
  }
}
