import { withFileLockAsync } from "./file-lock.ts";
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
export const FINDING_MATCH_THRESHOLD = 0.35;

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
  /** The run's digest comment threw: told the error and the findings it carried, so the throw stays isolated. */
  digestFailed: (error: string, digested: Finding[]) => void;
  maxPerRun: number;
  severityFloor: Severity;
  /** The cross-process lock serializing dedupe-then-file across a campaign's parallel runs. */
  lockFile: string;
}

/** Parallel runs serialize triage on the findings lock: 20ms waits, up to 6000 of them. */
const FINDINGS_LOCK = { retryMs: 20, maxAttempts: 6000, label: "findings" };

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
 * search counts as no match, so the finding is still filed or digested; a failed digest
 * comment goes to `digestFailed` rather than rejecting.
 */
export async function triageFindings(findings: Finding[], ctx: FindingContext, p: FindingPolicy): Promise<TriagedFinding[]> {
  const out: TriagedFinding[] = [];
  const digest: Finding[] = [];
  await withFileLockAsync(
    p.lockFile,
    async () => {
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
              `Seen again while working on ${hash(ctx.taskId)}${ctx.source ? ` (unverified: ${ctx.source})` : ""}: ${finding.summary}${finding.location ? ` — \`${finding.location}\`` : ""}`,
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
    },
    FINDINGS_LOCK,
  );
  if (digest.length && p.postComment) {
    const lines = digest.map((f) => `- ${f.severity ? `**${f.severity}** ` : ""}${f.summary}${f.location ? ` — \`${f.location}\`` : ""}`);
    try {
      await p.postComment(
        ctx.taskId,
        [`Findings noticed during this run, not filed (below the severity floor or over the per-run cap):`, "", ...lines].join("\n"),
      );
    } catch (e: any) {
      p.digestFailed(String(e?.message ?? e), digest);
    }
  }
  return out;
}

/** A known secret value shorter than this is not redacted — too likely to be an ordinary word. */
const MIN_SECRET_LENGTH = 8;

/**
 * The token shapes a finding is scrubbed of, in order — `anthropic-key` before the broader
 * `openai-key`, so an Anthropic key counts as one. Every token pattern opens on a word boundary —
 * unanchored, `sk-…` would bite into a kebab-case path like `src/task-management-and-scheduling.ts` —
 * and a private key is redacted as its whole `BEGIN … END` block.
 */
export const SECRET_TOKEN_SHAPES: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}/ },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Redact secrets from every text field of a finding before it is triaged or filed — a filed
 * finding is a public issue no human reviews first. Each known secret's exact value becomes
 * `[redacted <NAME>]` (longest first, so a value containing another is redacted whole; values
 * under `MIN_SECRET_LENGTH` skipped); then each `SECRET_TOKEN_SHAPES` match becomes
 * `[redacted: <kind>]`. Returns the scrubbed finding and how many redactions each env key or
 * kind made — never the matched text.
 */
export function scrubFinding(
  finding: Finding,
  knownSecrets: { name: string; value: string }[],
): { finding: Finding; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {};
  const replace = (text: string, match: string | RegExp, key: string, marker: string): string => {
    const parts = text.split(match);
    if (parts.length > 1) redactions[key] = (redactions[key] ?? 0) + parts.length - 1;
    return parts.join(marker);
  };
  const secrets = knownSecrets.filter((s) => s.value.length >= MIN_SECRET_LENGTH).sort((a, b) => b.value.length - a.value.length);
  const scrub = (text: string): string => {
    for (const { name, value } of secrets) text = replace(text, value, name, `[redacted ${name}]`);
    for (const { kind, pattern } of SECRET_TOKEN_SHAPES) text = replace(text, pattern, kind, `[redacted: ${kind}]`);
    return text;
  };
  const scrubbed = Object.fromEntries(Object.entries(finding).map(([k, v]) => [k, typeof v === "string" ? scrub(v) : v])) as Finding;
  return { finding: scrubbed, redactions };
}
