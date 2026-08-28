/**
 * The shared log-view component's humanizer (#203). One log surface — the live tail
 * today, the feed / host-log / archived-run log as its siblings adopt it — renders every
 * JSONL line two ways: humanized-by-default (`time · actor · what happened`, a
 * state-coloured dot) and, behind a per-view Raw toggle, the highlighted NDJSON. This
 * module owns the humanized half.
 *
 * `humanizeLogLine` is the registry: a `switch` on the row's `event` kind. It runs
 * server-side — `buildLiveTail` humanizes each line as it builds the tail snapshot and ships
 * the parts down with the raw text, so the client renders pre-humanized rows and keeps the
 * raw NDJSON for the toggle and the download. Running server-side lets the run-level kinds
 * narrate straight through the feed's `describeEvent` (`dashboard-model.ts`), so the two
 * surfaces say the same words with no duplicated vocabulary. A kind the registry does not
 * know renders a one-line raw dump, never a blank row.
 */
import { describeEvent } from "./dashboard-model.ts";
import type { OrchestratorEvent } from "./event-log.ts";

/**
 * The dot state a humanized row carries — the event's own state, from the ADR-0007 /
 * comms vocabulary collapsed to the five colours the log view paints: `running` (blue,
 * in-flight work), `merged` (green, a success), `failure` (red), `parked` (amber, a held
 * attention state), and `neutral` (dim, everything else). `logDotState` maps each back to
 * a `stateColor` token for the CSS.
 */
export type LogDotState = "running" | "merged" | "failure" | "parked" | "neutral";

/**
 * Each painted dot state → the ADR-0007 status token `stateColor` keys off (dashboard-assets.ts),
 * so the log-view dot CSS is generated from the one palette, never a per-instance hex (§1). Kept
 * here beside the states it maps so the humanizer and its colours move together; the chrome that
 * owns `stateColor` folds this into the CSS.
 */
export const LOG_DOT_STATE_COLOR: Record<LogDotState, string> = {
  running: "running",
  merged: "completed",
  failure: "failure",
  parked: "parked",
  neutral: "unstarted",
};

/**
 * One styled fragment of a humanized message (#216, mockup 1c). The `.lv-msg` cell renders
 * a row's `spans` in order: `plain` is ordinary prose, `code` is a mono token (ids, paths,
 * shas — the ADR vocabulary's stable handles), and `strong` is the single brightest key
 * term. Splitting the message into spans is what lets the component paint the three-tier
 * brightness hierarchy the flat string couldn't.
 */
export type SpanKind = "plain" | "code" | "strong";
export interface MessageSpan {
  text: string;
  kind: SpanKind;
}

/** One humanized log row: the shipped-verbatim structured shape `humanizeLogLine` returns
 * (#216). `time` is the `HH:MM:SS` slice of the row's ISO `ts` (UTC, matching the raw pane's
 * verbatim stamps), `actor` the `#issue` (or `host`, or "") that *leads* the message (option
 * 1a — no fixed actor column), `verb` the dim leading verb (`ran`, `edited`, `turn 3`,
 * `gate passed`, `committed`… — "" when the message narrates as one plain span), `spans` the
 * structured remainder, and `dot` the state colour. */
export interface HumanizedRow {
  time: string;
  actor: string;
  verb: string;
  spans: MessageSpan[];
  dot: LogDotState;
}

/** Flatten a structured row back to a single readable string — `verb` then each span's text,
 * space-joined only where the verb leads prose. The client's filter/title/accessibility
 * fallback (and the tests) read this when they need flat text; the rendered row uses the
 * structured `verb`/`spans` directly. */
export function plainText(row: HumanizedRow): string {
  const body = row.spans.map((s) => s.text).join("");
  if (!row.verb) return body;
  // A leading-punctuation body (": blocked", " (12s)", "— exit 1") already carries its own
  // separator, so only insert a space before ordinary prose.
  return row.verb + (body && !/^[\s:·—(]/.test(body) ? " " : "") + body;
}

/** The tool families whose activity reads as `edited <path>` rather than the generic `ran`
 * (mockup 1c gives file-mutating tools their own verb). Everything else — searches, shells,
 * fetches — leads with `ran`. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);

/**
 * Humanize one raw JSONL log line into its structured parts (`time`, actor-leads-message,
 * dim `verb`, `code`/`strong` message `spans`, state dot). The registry, keyed on the parsed
 * row's `event` — the run-level kinds narrate through `describeEvent` as one plain span so
 * the wording can't drift from the feed. An unparseable line, a row with no string `event`,
 * or an unknown kind falls back to a one-line raw dump — the trimmed source text as a plain
 * span, a neutral dot — never a blank row.
 */
export function humanizeLogLine(raw: string): HumanizedRow {
  let e: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") e = parsed as Record<string, unknown>;
  } catch {
    e = null;
  }
  const time = e && typeof e.ts === "string" ? (/T(\d{2}:\d{2}:\d{2})/.exec(e.ts)?.[1] ?? "") : "";
  const hash = (id: unknown) => "#" + String(id).replace(/^#/, "");
  const actorOf = (id: unknown) => (id === undefined || id === null || id === "" ? "" : hash(id));
  const plain = (text: string): MessageSpan => ({ text, kind: "plain" });
  const code = (text: string): MessageSpan => ({ text, kind: "code" });
  const strong = (text: string): MessageSpan => ({ text, kind: "strong" });
  // A run-level kind narrated by `describeEvent`: one plain span, no actor, no verb.
  const narrated = (dot: LogDotState): HumanizedRow => ({ time, actor: "", verb: "", spans: [plain(describeEvent(e as unknown as OrchestratorEvent))], dot });
  const fallback = (): HumanizedRow => ({ time, actor: e ? actorOf(e.taskId) : "", verb: "", spans: [plain(raw.trim())], dot: "neutral" });
  if (!e || typeof e.event !== "string") return fallback();
  switch (e.event) {
    case "tool": {
      const name = String(e.name);
      const size = typeof e.size === "number" ? [plain(" (" + e.size + " bytes)")] : [];
      if (e.path) return { time, actor: actorOf(e.taskId), verb: EDIT_TOOLS.has(name) ? "edited" : "ran", spans: [code(String(e.path)), ...size], dot: "running" };
      return { time, actor: actorOf(e.taskId), verb: "ran", spans: [strong(name)], dot: "running" };
    }
    case "sandbox-exec":
      return { time, actor: actorOf(e.taskId), verb: "ran", spans: [code(String(e.cmd))], dot: "running" };
    case "commit": {
      const files = Array.isArray(e.files) ? e.files.length : 0;
      const sha = typeof e.sha === "string" ? e.sha.slice(0, 7) : "";
      return { time, actor: actorOf(e.taskId), verb: "committed", spans: [code(sha), plain(" · " + files + " file" + (files === 1 ? "" : "s"))], dot: "running" };
    }
    case "gate": {
      const n = Array.isArray(e.cmds) ? e.cmds.length : 0;
      return { time, actor: actorOf(e.taskId), verb: "gate", spans: [plain("— "), strong(n + " check" + (n === 1 ? "" : "s"))], dot: "running" };
    }
    case "gate-result": {
      const ok = e.exitCode === 0;
      const tail = ok ? " (" + e.seconds + "s)" : " — exit " + e.exitCode + " (" + e.seconds + "s)";
      return { time, actor: actorOf(e.taskId), verb: ok ? "gate passed" : "gate failed", spans: [code(String(e.cmd)), plain(tail)], dot: ok ? "merged" : "failure" };
    }
    case "turn": {
      const summary = typeof e.summary === "string" ? e.summary.trim() : "";
      return { time, actor: actorOf(e.taskId), verb: "turn " + (e.turn ?? "?"), spans: summary ? [strong(summary)] : [], dot: "running" };
    }
    case "green":
      return { time, actor: actorOf(e.taskId), verb: "merged", spans: [], dot: "merged" };
    case "parked":
      return { time, actor: actorOf(e.taskId), verb: "parked", spans: e.reason ? [plain(": "), strong(String(e.reason))] : [], dot: "parked" };
    case "quarantined":
      return { time, actor: actorOf(e.taskId), verb: "quarantined", spans: [plain("— resolve the conflict")], dot: "parked" };
    // Run-level campaign/wave kinds — no per-issue actor; the message is single-sourced from
    // `describeEvent` so the log view and the feed narrate them identically, and the dot reads
    // the comms colour (a success green, a halt red, a wave-parked amber, a start blue).
    case "campaign-batch-done":
    case "campaign-done":
    case "queue-done":
      return narrated("merged");
    case "campaign-halt":
      return narrated("failure");
    case "wave-parked":
      return narrated("parked");
    case "campaign-start":
    case "campaign-batch":
    case "queue-start":
      return narrated("running");
    case "prune":
    case "graft":
    case "telegram-unconfigured":
      return narrated("neutral");
    default:
      return fallback();
  }
}

/**
 * Humanize one raw `host.jsonl` line into its `time · actor · what happened` parts — the
 * host-log pane's registry, the sibling of `humanizeLogLine` for the host surface (#203).
 * The host kinds (gateway routing, Telegram announcements, registry diagnostics) never route
 * through `describeEvent`, so this function is fully self-contained and ships verbatim into
 * the host-log client via `.toString()` — humanizing the fetched window and each live `host`
 * frame in the browser, where the raw NDJSON of that surface's SSE arm arrives unchanged.
 *
 * Keyed on the row's `event`: the routine gateway/registry/Telegram shapes each render a
 * purpose-built line; the `project` field is the actor (a host-global event reads `host`).
 * A failure — the `isNotableHostEvent` rule inlined: a `fail`/`error` kind, a non-null
 * `error`, or `ok:false` — always paints the failure (red) dot, so even a host kind with no
 * purpose-built line dumps its raw source in red rather than a silent neutral. An unknown,
 * non-notable kind (or an unparseable line) falls back to a one-line raw dump, never blank.
 */
export function humanizeHostLine(raw: string): HumanizedRow {
  let e: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") e = parsed as Record<string, unknown>;
  } catch {
    e = null;
  }
  const time = e && typeof e.ts === "string" ? (/T(\d{2}:\d{2}:\d{2})/.exec(e.ts)?.[1] ?? "") : "";
  const hash = (id: unknown) => "#" + String(id).replace(/^#/, "");
  const project = e && typeof e.project === "string" ? e.project : "";
  const plain = (text: string): MessageSpan => ({ text, kind: "plain" });
  const code = (text: string): MessageSpan => ({ text, kind: "code" });
  // The shared notable rule (isNotableHostEvent), inlined so this function stays shippable:
  // a fail/error kind, a non-null `error`, or `ok:false` is a failure the operator sees red.
  const failed = !!e && ((typeof e.event === "string" && /fail|error/i.test(e.event)) || (e.error !== undefined && e.error !== null) || e.ok === false);
  const fallback = (): HumanizedRow => ({ time, actor: project, verb: "", spans: [plain(raw.trim())], dot: failed ? "failure" : "neutral" });
  if (!e || typeof e.event !== "string") return fallback();
  switch (e.event) {
    // Routine gateway/registry lifecycle — a neutral dot, the project (or host) as actor.
    case "gateway-start": {
      const bots = typeof e.bots === "number" ? e.bots : 0;
      return { time, actor: "host", verb: "gateway up", spans: bots ? [plain(" · " + bots + " bot" + (bots === 1 ? "" : "s"))] : [], dot: "neutral" };
    }
    case "gateway-routed":
      return { time, actor: project, verb: "routed", spans: [code(String(e.category)), plain(" → "), code(String(e.destination))], dot: "neutral" };
    case "gateway-announced":
      return { time, actor: project, verb: "announced", spans: [code(hash(e.task))], dot: "neutral" };
    // Held-attention (amber) diagnostics — not a hard failure, but the operator should see them.
    case "telegram-unconfigured":
      return { time, actor: project, verb: "", spans: [plain("⚠ Telegram not configured")], dot: "parked" };
    case "registry-stale":
      return { time, actor: project, verb: "", spans: [plain("stale registration")], dot: "parked" };
    // The named failure kinds — a red line naming what broke.
    case "telegram-send-failed":
      return { time, actor: "host", verb: "Telegram send failed", spans: [plain(" ("), code(String(e.status)), plain(")")], dot: "failure" };
    case "registry-register-failed":
      return { time, actor: project, verb: "registration failed", spans: [plain(": "), code(String(e.error))], dot: "failure" };
    case "registry-routing-unreadable":
      return { time, actor: project, verb: "routing unreadable", spans: [plain(": "), code(String(e.error))], dot: "failure" };
    default:
      return fallback();
  }
}
