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
}

export interface FindingContext {
  taskId: string;
  project: string;
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
    const summary = field(inner, "summary") ?? inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!summary) continue;
    findings.push({ summary, location: field(inner, "location"), repro: field(inner, "repro") });
  }
  return findings;
}

/**
 * File each finding through `reporter`, isolating a failure to its own finding
 * so one bad report never loses the others. Returns per-finding outcomes for the
 * caller to log.
 */
export async function reportFindings(reporter: FindingReporter, findings: Finding[], ctx: FindingContext): Promise<FindingResult[]> {
  const results: FindingResult[] = [];
  for (const finding of findings) {
    try {
      const url = await reporter(finding, ctx);
      results.push({ finding, url: typeof url === "string" ? url : undefined });
    } catch (e: any) {
      results.push({ finding, error: String(e?.message ?? e) });
    }
  }
  return results;
}
