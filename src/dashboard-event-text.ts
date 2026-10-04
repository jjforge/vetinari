/**
 * The dashboard's event text: the plain-words narration of event-log entries, wave labels,
 * the festive-name helpers, and the tracker-task and parked-question parsers. A leaf — it
 * never imports `dashboard-model.ts` or `status.ts` (both re-export it), so no cycle forms.
 */
import { festiveWaveName } from "./festive-names.ts";
import type { GreenEvent, OrchestratorEvent } from "./event-log.ts";
import type { ParkedRecord } from "./state.ts";
import { hash, normalize } from "./issue-id.ts";

/**
 * The festive-name offset for a campaign, derived from its `campaign-start` (design §2.1:
 * "no presentation state — cosmetic naming offsets — is ever written to the log"). The name
 * is *chosen at campaign-start* by hashing the one thing recorded there once — the start
 * timestamp — into the roster, so it is stable across every re-render and disjoint between
 * campaigns started at different times, with no host cursor and nothing cosmetic on disk.
 */
export const festiveOffsetFor = (campaignStartTs: string | undefined): number => {
  let h = 0;
  for (const ch of campaignStartTs ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

/**
 * Whether "Festive Wave Names" is on for a request (#193). Wave labels are
 * server-rendered, but the gear toggle is client-side, so it sets a `festiveWaveNames`
 * cookie the server reads here: `=1` on, `=0` off, the cookie always winning. With no
 * such cookie the `fallback` decides — the project's `festiveWaveNames` config default,
 * or plain false at the host dashboard, which loads no per-project config (ADR 0002).
 * Pure and header-parsing-only so it is unit-testable without a request.
 */
export function festiveFromCookie(cookieHeader: string | undefined, fallback = false): boolean {
  const match = cookieHeader?.match(/(?:^|;\s*)festiveWaveNames=([^;]*)/);
  if (!match) return fallback;
  return match[1] === "1";
}

/** The issue number a merge/green event is about: its explicit `taskId`, or —
 * for a merge that names its issue only through the branch (`agent/<id>`, the
 * campaign wave-merge / per-issue green path) — the id embedded in that branch.
 * Keeps the feed from rendering `#undefined` when only the branch carries it. */
const mergedIssue = (e: GreenEvent): string | undefined => {
  if (e?.taskId != null && String(e.taskId) !== "") return normalize(String(e.taskId));
  const tail = e?.branch != null ? String(e.branch).split("/").pop() : "";
  return tail ? normalize(tail) : undefined;
};

/**
 * The "Festive Wave Names" input to `waveLabel` (#193): the resolved Discworld name
 * plus which surface is rendering, since the festive form differs by surface. A
 * `card` (or closed-wave chip) shows `index · name` — its member rows already carry
 * the issue titles. A `line` (the one-line narration, which has no member rows) shows
 * `index · name · #num, #num, …`, listing the wave's member issue numbers inline.
 */
export type FestiveWaveLabel = { name: string; surface: "card" } | { name: string; surface: "line"; numbers: string[] };

/**
 * A wave's human label — `Wave N`, plus ` — <lead title> +M` once the lead issue's
 * title has resolved (bare index otherwise). The single derivation the status-page
 * wave cards (`renderWaveLabel`, dashboard-render.ts), the closed-wave chip
 * (`renderClosedWaveChip`) and the event narration (`describeEvent`) call, so the paths
 * can't drift. Takes the already-extracted `(index, leadTitle, extra)` because its
 * callers feed it from different inputs — a resolved `StatusWave` vs. a raw event + its
 * `titles` map — and the caller escapes the title first where the sink is HTML. `index`
 * is zero-based; `extra` is the count beyond the lead. When `festive` is supplied
 * (the gear toggle is on), it replaces the plain wording with the surface-specific
 * festive form and `leadTitle`/`extra` are ignored.
 */
export function waveLabel(index: number, leadTitle: string | undefined, extra: number, festive?: FestiveWaveLabel): string {
  const base = `Wave ${index + 1}`;
  if (festive) {
    const head = `${base} · ${festive.name}`;
    if (festive.surface === "card" || !festive.numbers.length) return head;
    return `${head} · ${festive.numbers.map((n) => hash(n)).join(", ")}`;
  }
  if (!leadTitle) return base;
  return `${base} — ${leadTitle}${extra > 0 ? ` +${extra}` : ""}`;
}

/**
 * The one-line narration's wave label — `Wave N — t1, t2, …`, naming *every* member
 * issue (issue #179), where the card's `waveLabel` collapses the rest to `+M`. The
 * feed's line length is the accepted tradeoff for a complete description of a
 * file-disjoint, multi-issue wave. Callers pass the already-resolved title list (an
 * unresolved id shows as its `#id`); an empty list — a wave with no member ids — degrades
 * to the bare `Wave N`, preserving the old empty-wave wording. `index` is zero-based.
 */
export function waveMembersLabel(index: number, titles: string[]): string {
  const base = `Wave ${index + 1}`;
  return titles.length ? `${base} — ${titles.join(", ")}` : base;
}

/** The `Campaign “X” — ` prefix a named campaign/wave event leads with, so an unnamed run
 * (or an old log row) degrades to the nameless wording rather than rendering `Campaign “” —`. */

/**
 * Narrate one event log entry as the single plain-words line the landing card
 * shows for "the last event". A `turn` renders its agent-authored summary verbatim
 * (ADR 0009) — the whole reason that field exists — falling back to a mechanical
 * line only when a pre-summary run has none. Events with no operator-facing
 * narration return "" so `lastEventText` can skip past machine noise.
 */
export function describeEvent(e: OrchestratorEvent, opts: { festive?: { offset: number }; titles?: Map<string, string> } = {}): string {
  const { festive, titles } = opts;
  // Titles are recorded once on `campaign-start` (design §2.1), so a single-event reader
  // that wants a member's name looks it up in the resolved map the caller threads in.
  const named = (id: unknown) => titles?.get(normalize(String(id))) ?? hash(id);
  // The one-line festive form of a wave — `Wave N · name · #num, #num, …` — through the
  // shared `waveLabel` (surface `line`), so the narration can't drift from the card/chip.
  const festiveLine = (index: number, members: string[]) =>
    waveLabel(index, undefined, 0, {
      name: festiveWaveName(festive!.offset, index),
      surface: "line",
      numbers: members.map((id) => normalize(String(id))),
    });
  switch (e.event) {
    case "campaign-start":
      return e.name ? `Campaign “${e.name}” started` : "Campaign started";
    case "wave-start": {
      const tasks = e.tasks ?? [];
      const label = festive
        ? festiveLine(e.index ?? 0, tasks.map(String))
        : waveMembersLabel(
            e.index ?? 0,
            tasks.map((id) => named(id)),
          );
      return `${label} started`;
    }
    case "wave-done": {
      // A wave-done fires only when every member merged (design §2.1), so the event carries
      // just its `merged` list — the wave's whole membership. Each member is named by title
      // (an unresolved id falls back to its `#id`), listing them all.
      const members = [...(e.merged ?? [])];
      const label = festive
        ? festiveLine(e.index ?? 0, members.map(String))
        : waveMembersLabel(
            e.index ?? 0,
            members.map((id) => named(id)),
          );
      const hashes = (e.merged ?? []).length ? (e.merged as unknown[]).map(hash).join(", ") : "nothing";
      return `${label} merged ${hashes}`;
    }
    case "campaign-done": {
      const n = e.waves ?? 0;
      return `${e.name ? `Campaign “${e.name}”` : "Campaign"} complete (${n} wave${n === 1 ? "" : "s"})`;
    }
    case "green": {
      const id = mergedIssue(e);
      return id ? `#${id} merged` : "merged";
    }
    case "parked":
      return e.reason === "conflict"
        ? `${hash(e.taskId)} parked — merge conflict, resolve it`
        : `${hash(e.taskId)} parked${e.reason ? `: ${e.reason}` : ""}`;
    case "failed":
      return `${hash(e.taskId)} failed — could not be made green`;
    case "campaign-parked":
      return `Campaign parked${e.detail ? ` — ${e.detail}` : " — merged base gated red"}`;
    case "campaign-failed":
      return `Campaign failed${e.detail ? ` — ${e.detail}` : ""}`;
    case "prune":
      return `Pruned ${(e.removed ?? []).map(hash).join(", ")}`;
    case "graft":
      return `Grafted ${(e.ids ?? []).map(hash).join(", ")}`;
    case "telegram-unconfigured":
      return "⚠ Telegram not configured — parked questions won't be announced";
    case "turn":
      return e.summary?.trim() ? String(e.summary).trim() : `${hash(e.taskId)} — turn ${e.turn ?? "?"}`;
    default:
      return "";
  }
}

/** The festive descriptor `describeEvent` needs for a run's events (design §2.1): the offset
 * derived from the run's latest `campaign-start` timestamp ({@link festiveOffsetFor}). Undefined
 * when festive is off, or the log carries no `campaign-start` — narration then stays plain even
 * under the toggle. Nothing cosmetic is read from the log; the offset is a function of the start
 * time recorded there once. */
export const festiveFor = (events: OrchestratorEvent[], festive: boolean): { offset: number } | undefined => {
  if (!festive) return undefined;
  const start = events.findLast((e) => e.event === "campaign-start");
  return start ? { offset: festiveOffsetFor(typeof start.ts === "string" ? start.ts : undefined) } : undefined;
};

/**
 * One event as a single repo-prefixed sentence for the cross-project feed:
 * `describeEvent`'s plain-words line with the project name in front. Pure — an
 * event `describeEvent` can't narrate (machine noise) returns "" so `buildFeed`
 * can skip past it, exactly as `lastEventText` does. `festive` (its run's reserved
 * offset, resolved by the caller) names the wave after a character (#193).
 */
export function formatFeedEvent(
  project: string,
  e: OrchestratorEvent,
  opts: { festive?: { offset: number }; titles?: Map<string, string> } = {},
): string {
  const sentence = describeEvent(e, opts);
  return sentence ? `${project} — ${sentence}` : "";
}

/**
 * The most recent operator-facing event in a log, in plain words — the landing
 * card's "last event" line. Scans newest-first and returns the first entry
 * `describeEvent` can narrate, so machine noise (gate/sandbox/queue-spawn) that
 * lands after a meaningful event never becomes the headline. Empty logs read
 * "No activity yet". When `festive` is on, a wave event is narrated festively off
 * the run's reserved offset (#193).
 */
export function lastEventText(events: OrchestratorEvent[], festive = false): string {
  const festiveArg = festiveFor(events, festive);
  const titles = titlesFromLog(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const text = describeEvent(events[i], { festive: festiveArg, titles });
    if (text) return text;
  }
  return "No activity yet";
}

/** The id→title map a run recorded once on its latest `campaign-start` (design §2.1),
 * so a single-event narrator (`describeEvent`) can name a wave's members without the
 * events carrying titles. Empty when no campaign-start recorded any. */
export const titlesFromLog = (events: OrchestratorEvent[]): Map<string, string> => {
  const titles = new Map<string, string>();
  const start = events.findLast((e) => e.event === "campaign-start");
  const map = start && "titles" in start ? start.titles : undefined;
  if (map && typeof map === "object")
    for (const [id, title] of Object.entries(map)) if (typeof title === "string" && title.trim()) titles.set(normalize(id), title.trim());
  return titles;
};

/**
 * Whether a tracker's task text names an OPEN or CLOSED issue — the signal
 * `graft` validates a candidate id against before adding it (ADR 0014). Parses the
 * same JSON `fetchTask` returns (beside `issueNameFromTask`): a GitHub `state`
 * (`OPEN`/`CLOSED`, case-insensitive), a boolean `closed`, or a truthy
 * `closedAt`/`closed_at` reads `closed`; anything else — a task with no state
 * signal, or plain non-JSON prose — reads `open`, so a tracker that does not
 * surface state never spuriously rejects a graft. An unknown/missing issue is the
 * CLI's concern (a throwing `fetchTask`), not this parse.
 */
export const issueStateFromTask = (task: string): "open" | "closed" => {
  try {
    const parsed = JSON.parse(task) as { state?: unknown; closed?: unknown; closedAt?: unknown; closed_at?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.state === "string" && parsed.state.toLowerCase() === "closed") return "closed";
      if (parsed.closed === true || parsed.closedAt || parsed.closed_at) return "closed";
    }
  } catch {
    // not JSON — no state signal, treat as open
  }
  return "open";
};

export const issueNameFromTask = (task: string): string | undefined => {
  try {
    const parsed = JSON.parse(task);
    return typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The parked-reply payload the issue-detail sheet needs for a parked issue: the
 * question with any trailing Options section split off, and those options parsed
 * as fill-the-field choices (story: parked-question reply). Reads the matching
 * parked record (by normalized issue number); returns undefined when none names
 * the issue — a log-only parked state — so the sheet falls back to just the
 * free-text field.
 */
export function parkedReplyFor(records: ParkedRecord[], issueNumber: string): { question: string; options: string[] } | undefined {
  const id = normalize(issueNumber);
  const rec = records.find((r) => normalize(r.taskId) === id);
  if (!rec) return undefined;
  const { description, options } = extractParkedDetails(rec.question);
  return { question: description, options };
}

/** Pull one tag's trimmed inner text out of a loosely-structured agent block, mirroring
 *  the `field` convention the harvest turn uses over `<finding>` stdout (findings.ts). */
const parkedField = (block: string, tag: string): string | undefined => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  const value = m?.[1].trim();
  return value ? value : undefined;
};

export function extractParkedDetails(question: string): { description: string; options: string[] } {
  // The XML shape agents emit (prompts/tdd.md): the run loop strips the outer <question>
  // wrapper and stores the inner <summary>/<detail>/<options><option> verbatim. Recognise
  // it alongside the Markdown form — summary as the headline, detail as the body, each
  // <option> a fill-the-field choice — so no raw tags reach the reader.
  const summary = parkedField(question, "summary");
  const detail = parkedField(question, "detail");
  const xmlOptions = [...question.matchAll(/<option>([\s\S]*?)<\/option>/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (summary || detail || xmlOptions.length) {
    return { description: [summary, detail].filter(Boolean).join("\n\n"), options: xmlOptions };
  }

  const match = question.match(/(?:^|\n)\s*options?\s*:\s*\n([\s\S]*)/i);
  if (!match) return { description: question.trim(), options: [] };

  const description = question.slice(0, match.index).trim();
  const optionLines: string[] = [];
  for (const raw of match[1].split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (optionLines.length) break;
      continue;
    }
    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (cleaned) optionLines.push(cleaned);
  }
  return { description, options: optionLines };
}
