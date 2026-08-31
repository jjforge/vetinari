import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownerRepoFromRemote, repoForProject, type ResolvedConfig } from "./config.ts";
// Re-exported so `status.ts`'s `export *` and `dashboard-route-page.ts` keep
// reaching them here; the definitions moved to config.ts once the registry and CLI
// came to depend on this project-identity edge (an odd fit under dashboard-model).
export { ownerRepoFromRemote, repoForProject };
import { hostLogger, type Logger } from "./log.ts";
import { type ProjectPointer } from "./registry.ts";
import { listParked, parkedDirOf, type ParkedRecord, type ParkReason } from "./state.ts";
import { projectHasLiveLease } from "./host-slots.ts";
import { applyPrune } from "./prune.ts";
import { applyGraft } from "./plan.ts";
import { festiveWaveName } from "./festive-names.ts";
import { readEventLog, type GreenEvent, type OrchestratorEvent } from "./event-log.ts";
import { activityLogPath } from "./activity.ts";
import { humanizeLogLine, localTime, type HumanizedRow } from "./log-view.ts";

/**
 * The base branch a redrive would land on, read live from the project checkout's current
 * branch (design §7, §11) — the impure git edge the Redrive confirm dialog names. The dumb
 * router (ADR 0002) holds no project config to read `baseBranch` from, so it reads the tree:
 * a stopped campaign — the only time Redrive enables — sits on its base (the loop merges onto
 * and refuses off base, §5), so HEAD is the base at rest. A non-repo root or a detached/failed
 * read yields `undefined` (the git call is silenced and never throws), and the dialog then
 * says "the base branch" rather than a broken value.
 */
export function baseBranchForProject(projectRoot: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The issue lifecycle — the single stored axis of the state machine (ADR 0019).
 * An issue is `unstarted` until assigned, then `running`, and ends `completed`,
 * `failed`, or (resumably) `parked`. This is the whole status enum: the old
 * render-time overlays (the conflict hold, `interrupted`) collapse into `parked` plus a
 * reason, and `pruned`/`grafted` move to the orthogonal `Membership` axis.
 */
export type IssueStatus = "completed" | "parked" | "failed" | "running" | "unstarted";

/**
 * Why a `parked` issue is held (design §2.3) — metadata set *by the transition*, not a
 * status word: `question` (a `parked{question}` awaiting an answer), `conflict` (an
 * integrator merge conflict), `red-base` (a combined-gate wave-park — the *wave's* reason,
 * never a member's), `stalled` (a `parked{stalled}` on turn budget / idle / no-commit, the
 * run loop's own resource stop), or `crash` (reconciliation: the run's process is gone with
 * no terminal stop marker, so an in-flight issue never verdicted — design §7). The reason
 * selects the recovery affordance; the surface word is one. The single enum lives in
 * `state.ts` and is re-exported here so the render sites can import it beside the model.
 */
export type { ParkReason };

/**
 * An issue's membership in the campaign (ADR 0019) — the axis orthogonal to its
 * lifecycle: a plain `member`, a `grafted` addition still waiting to start, or a
 * `pruned` issue dropped from the plan. Render composes `(lifecycle, membership)`:
 * the dot reads the lifecycle, a badge reads the membership, with no precedence ladder.
 */
export type Membership = "member" | "grafted" | "pruned";

/** An issue's lifecycle snapshot — its FSM state and, when `parked`, the reason. */
export interface IssueLifecycle {
  state: IssueStatus;
  reason?: ParkReason;
}

/**
 * The status a chip renders — now exactly the lifecycle (ADR 0019). The render-time
 * overlays are gone: the conflict hold and `interrupted` fold into `parked`+reason, and
 * `pruned`/`grafted` live on `StatusIssue.membership`. Kept as a distinct name only
 * so the render sites read `DisplayStatus` where they mean "the lifecycle to paint".
 */
export type DisplayStatus = IssueStatus;

export interface StatusIssue {
  issueNumber: string;
  /** the issue's lifecycle state — the dot/word the chip paints (ADR 0019). */
  status: DisplayStatus;
  /** why it is `parked`, when it is — selects the recovery affordance, not a word. */
  reason?: ParkReason;
  /** the orthogonal membership axis — the badge the chip carries. Absent reads as a
   * plain `member` (the common case), so only a `grafted`/`pruned` chip sets it. */
  membership?: Membership;
  /** true when this `running` chip is a green awaiting merge (design §2.2): it went green but
   * has not banked on the base, so its agent slot is already freed — the live tail must not
   * follow it as an in-flight runner. Absent for a genuinely slot-holding `running` chip. */
  pendingGreen?: boolean;
  name?: string;
  detail?: string;
}

/**
 * A wave's status — a **fold of its issues' lifecycles** (ADR 0019), no longer a
 * render-time derivation off campaign structure. `failed` (any member failed) outranks
 * `parked` (any member held — a question or a conflict — or the wave-level `red-base`
 * hold on a red merged base, whose members stay `completed`; design §2.3), then `running`
 * (any in flight), then `completed` (all resolved), else `unstarted`. The old
 * wave-park/`interrupted` words are gone: a held wave is `parked`, its members carry
 * their own `ParkReason` and the wave carries `red-base` when that is the hold.
 */
export type WaveStatus = "completed" | "running" | "unstarted" | "parked" | "failed";

/**
 * A campaign's status — a pure fold of its waves (ADR 0019). Mirrors the wave fold's
 * precedence (`failed` > `parked` > `running`), with `completed` when every wave has
 * closed and `unstarted` when none has begun. The card fold (`cardState`) maps this to
 * the landing's `RunState`, collapsing `completed`/`unstarted` to `idle`.
 */
export type CampaignState = "failed" | "parked" | "running" | "completed" | "unstarted";

export interface StatusWave {
  index: number;
  status: WaveStatus;
  /** why the wave is `parked`, when the hold is a wave-level one: `red-base`, the
   * combined-gate park on a red merged base (design §2.3). It is the *wave's* reason,
   * not any member's — the members keep their own lifecycle. Absent otherwise; a wave
   * parked only because a member is held carries no wave reason (the member has it). */
  reason?: ParkReason;
  issues: StatusIssue[];
}

export interface ParkedIssue {
  issueNumber: string;
  reason: string;
  parkedAt: string;
  branch: string;
  description: string;
  options: string[];
}

export interface CampaignStatus {
  project: string;
  /** the run's optional `--name`, shown as the header label; absent when unnamed. */
  name?: string;
  /** the festive-name offset for this campaign (#193), derived at render from its
   * `campaign-start` timestamp ({@link festiveOffsetFor}); wave `i` renders as
   * `festiveWaveName(festiveOffset, i)` when festive wave names are on. Absent for a run
   * with no `campaign-start`, which then renders nameless under festive. */
  festiveOffset?: number;
  waves: StatusWave[];
  parked: ParkedIssue[];
  /** the issue ids of the wave currently in flight — the reducer's `currentWave` (design §11):
   * what the live tail follows so it lists the slot-holders of the one wave the loop is draining,
   * never a member still reading `running` in a wave that has advanced or one not yet in flight (a
   * racy/partial log leaves such ghosts). An empty array means no wave is in flight; the field is
   * absent only on a hand-built status, where {@link inFlightRunning} falls back to every runner. */
  inFlight?: string[];
}

const statusForOutcome = (outcome: string | undefined): IssueStatus => {
  if (outcome === "green") return "completed";
  if (outcome === "parked") return "parked";
  if (outcome?.startsWith("error")) return "failed";
  return "unstarted";
};

const PARK_REASONS: ReadonlySet<string> = new Set(["question", "stalled", "conflict", "red-base", "crash"]);

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
 * Coerce a `parked` event/record's `reason` to the one enum (design §2.3). Writers emit the
 * enum directly and archived logs are translated by the alias table before they reach the
 * reducer, so this is a validator: a recognised reason passes through, anything else defaults
 * to `question` (an answerable hold rather than a silent drop).
 */
export const parkReasonFromEvent = (reason: string | undefined): ParkReason =>
  reason && PARK_REASONS.has(reason) ? (reason as ParkReason) : "question";

/**
 * The wave fold (ADR 0019): a wave's status is a pure fold of its issues' lifecycles,
 * skipping `pruned` members (they left the plan, so they never force a wave to read
 * running/unstarted). `failed` outranks `parked` outranks `running`; a wave whose every
 * live member has `completed` is itself `completed`; an empty or all-unstarted wave is
 * `unstarted`.
 * This is what makes a wave with a red member read `failed`, never `running` (#262).
 * `opts.redBase` is the one wave-level hold: a combined-gate park on a red merged base
 * (design §2.3) whose members all merged clean (each `completed`), so nothing in the fold
 * would otherwise read `parked` — it lands at the `parked` rank, still below `failed` (#288).
 */
export function waveState(issues: readonly { status: DisplayStatus; membership?: Membership }[], opts: { redBase?: boolean } = {}): WaveStatus {
  const live = issues.filter((i) => i.membership !== "pruned");
  if (!live.length) return "unstarted";
  if (live.some((i) => i.status === "failed")) return "failed";
  if (opts.redBase || live.some((i) => i.status === "parked")) return "parked";
  if (live.some((i) => i.status === "running")) return "running";
  if (live.every((i) => i.status === "completed")) return "completed";
  return "unstarted";
}

/**
 * The campaign fold (ADR 0019): a pure fold of the wave states below it, same
 * precedence as the wave fold. Any `failed` wave → `failed`; any `parked` wave →
 * `parked`; any `running` wave → `running`; all `completed` → `completed`; else
 * `unstarted`. The card fold (`cardState`) collapses `completed`/`unstarted` to `idle`.
 */
export function campaignState(waves: readonly WaveStatus[]): CampaignState {
  if (!waves.length) return "unstarted";
  if (waves.some((w) => w === "failed")) return "failed";
  if (waves.some((w) => w === "parked")) return "parked";
  if (waves.some((w) => w === "running")) return "running";
  if (waves.every((w) => w === "completed")) return "completed";
  return "unstarted";
}

/**
 * The events appended to a jsonl event log past a character offset, and the
 * offset to resume from next time. Pure — the tail-reading half of the live
 * watcher (ADR 0008), split out so it can be unit-tested without a file or a
 * running server: given the log's full text and where we last stopped, it returns
 * only the newly-appended *complete* lines (parsed, bad lines skipped like
 * `readEventLog`) and the new offset — the length of text consumed up to and
 * including the last newline. A partial trailing line (an append caught
 * mid-write) is left unconsumed so it is read whole next time, and a `content`
 * shorter than `offset` means the log was truncated or rotated, so it is re-read
 * from the start.
 */
export function appendedEvents(content: string, offset: number): { events: OrchestratorEvent[]; offset: number } {
  const from = offset >= 0 && offset <= content.length ? offset : 0;
  const tail = content.slice(from);
  const lastNewline = tail.lastIndexOf("\n");
  if (lastNewline === -1) return { events: [], offset: from };
  const complete = tail.slice(0, lastNewline + 1);
  const events = complete
    .split("\n")
    .filter(Boolean)
    .flatMap((line): OrchestratorEvent[] => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { event?: unknown }).event !== "string") return [];
      return [parsed as OrchestratorEvent];
    });
  return { events, offset: from + complete.length };
}

/**
 * The event kinds the live-update stream (ADR 0008) treats as machine-noise: rows
 * that land in `orchestrator.jsonl` but never change any rendered dashboard view, so
 * an SSE frame pushed for them refreshes the client for nothing. This is a **denylist,
 * fail-open by design** — the per-repo page renders more than the cross-project feed
 * (its issue-detail sheet folds turn/gate/worktree rows), so an allowlist keyed on
 * `describeEvent` would drop events the detail view needs. Only kinds known to be pure
 * side-channel noise (the outbound message queue, a failed Telegram send) are listed;
 * anything unrecognized is kept.
 */
export const SSE_NOISE_EVENTS: ReadonlySet<string> = new Set(["telegram-send-failed", "outbound-enqueued"]);

/**
 * The view-relevant subset of a batch of appended events — everything except the
 * `SSE_NOISE_EVENTS` denylist above. The live watcher (ADR 0008) filters through this
 * before emitting, so a burst of pure machine-noise appends yields no SSE frame and no
 * wasted client refresh; a frame is emitted only when at least one surviving event
 * remains. Pure and order-preserving so it is unit-testable without a running server.
 */
export function viewRelevantEvents(events: OrchestratorEvent[]): OrchestratorEvent[] {
  return events.filter((e) => !SSE_NOISE_EVENTS.has(e.event));
}

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

const normalizeIssue = (id: string) => id.replace(/^#/, "");

const hash = (id: unknown) => `#${normalizeIssue(String(id))}`;

/** The issue number a merge/green event is about: its explicit `taskId`, or —
 * for a merge that names its issue only through the branch (`agent/<id>`, the
 * campaign wave-merge / per-issue green path) — the id embedded in that branch.
 * Keeps the feed from rendering `#undefined` when only the branch carries it. */
const mergedIssue = (e: GreenEvent): string | undefined => {
  if (e?.taskId != null && String(e.taskId) !== "") return normalizeIssue(String(e.taskId));
  const tail = e?.branch != null ? String(e.branch).split("/").pop() : "";
  return tail ? normalizeIssue(tail) : undefined;
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
  const named = (id: unknown) => titles?.get(normalizeIssue(String(id))) ?? hash(id);
  // The one-line festive form of a wave — `Wave N · name · #num, #num, …` — through the
  // shared `waveLabel` (surface `line`), so the narration can't drift from the card/chip.
  const festiveLine = (index: number, members: string[]) =>
    waveLabel(index, undefined, 0, {
      name: festiveWaveName(festive!.offset, index),
      surface: "line",
      numbers: members.map((id) => normalizeIssue(String(id))),
    });
  switch (e.event) {
    case "campaign-start":
      return e.name ? `Campaign “${e.name}” started` : "Campaign started";
    case "wave-start": {
      const tasks = e.tasks ?? [];
      const label = festive
        ? festiveLine(e.index ?? 0, tasks.map(String))
        : waveMembersLabel(e.index ?? 0, tasks.map((id) => named(id)));
      return `${label} started`;
    }
    case "wave-done": {
      // A wave-done fires only when every member merged (design §2.1), so the event carries
      // just its `merged` list — the wave's whole membership. Each member is named by title
      // (an unresolved id falls back to its `#id`), listing them all.
      const members = [...(e.merged ?? [])];
      const label = festive
        ? festiveLine(e.index ?? 0, members.map(String))
        : waveMembersLabel(e.index ?? 0, members.map((id) => named(id)));
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
const festiveFor = (events: OrchestratorEvent[], festive: boolean): { offset: number } | undefined => {
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
export function formatFeedEvent(project: string, e: OrchestratorEvent, opts: { festive?: { offset: number }; titles?: Map<string, string> } = {}): string {
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
    for (const [id, title] of Object.entries(map))
      if (typeof title === "string" && title.trim()) titles.set(normalizeIssue(id), title.trim());
  return titles;
};

// Issue titles rarely change during a campaign, so we cache them for the process
// lifetime; a rename won't surface until the status server restarts.
const issueNameCache = new Map<string, string | undefined>();

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
  const id = normalizeIssue(issueNumber);
  const rec = records.find((r) => normalizeIssue(r.taskId) === id);
  if (!rec) return undefined;
  const { description, options } = extractParkedDetails(rec.question);
  return { question: description, options };
}

export function extractParkedDetails(question: string): { description: string; options: string[] } {
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
    const cleaned = line.replace(/^[-*]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (cleaned) optionLines.push(cleaned);
  }
  return { description, options: optionLines };
}

/**
 * The reconstructed plan of the campaign an event log describes: its waves, the
 * per-issue outcome and hover detail, which waves have closed, and which wave is
 * current (-1 when none is in flight). It is the fold both the dashboard and the
 * `campaign` loop reduce so they agree on "the plan" by construction (ADR 0005).
 */
export interface ReducedCampaign {
  waves: string[][];
  /** the original wave membership as the run was launched (or a queue run's single
   * frame), before any prune pruned it — the layout the dashboard renders so a
   * pruned issue still shows as a chip in the wave it left. `waves` is the pruned,
   * loop-facing plan; `layout` is display-facing and never loses a member. */
  layout: string[][];
  /** the issues a prune actually dropped from the plan (parked/unstarted members),
   * in log order — rendered `pruned` (ADR 0007). A superset key over `outcomes`,
   * which stays `IssueStatus`; pruned is a render overlay, not a stored status. */
  pruned: Set<string>;
  /** the issues a graft added to the running campaign that are still unstarted —
   * rendered `grafted` (ADR 0014), the additive mirror of `pruned`. A render overlay
   * derived from graft events, **transient**: an id drops out of this set the moment it
   * reaches a started outcome (`running`/`completed`/…), so it reads `grafted` only
   * while waiting in a later wave. Both live and archived runs see it. */
  grafted: Set<string>;
  /** the issues a merge conflict held out of integration (ADR 0013), folded from the
   * `parked{conflict}` events in log order and cleared once the issue re-merges. It drives
   * the lifecycle: a held issue passed its own gate (`outcomes` holds `completed`) but
   * `issueLifecycle` reads it as `parked` with reason `conflict` until it re-merges (ADR 0019). */
  conflictParked: Set<string>;
  /** the optional human name the campaign was launched with (`--name`), read off
   * the latest `campaign-start` event; undefined for an unnamed run. */
  name?: string;
  /** the festive-name offset for this campaign (#193), derived from the latest
   * `campaign-start` timestamp ({@link festiveOffsetFor}); undefined for a run with no
   * `campaign-start`. Wave `i` draws `festiveWaveName(festiveOffset, i)` when festive
   * wave names are on. */
  festiveOffset?: number;
  outcomes: Map<string, IssueStatus>;
  /** issues that went green but are not yet merged onto the base — `running` with a pending
   * green (design §2.2). Cleared when the id merges (`merged`, or a `wave-done`'s merged list).
   * The chip reads `running`; this set drives the distinct "pending merge" chip detail. */
  pendingGreen: Set<string>;
  details: Map<string, string>;
  /** issue id → title, captured onto the run's start event at launch by the
   * orchestrator (which has `fetchTask`) so the dumb-router dashboard renders
   * names with no live lookup (ADR 0002). Empty when a run recorded no titles. */
  titles: Map<string, string>;
  /** issue id → ISO timestamp it most recently reached "completed" (a batch merge,
   * a bare green, or a queue-done green). The source the landing's merged-today
   * counter reads: an issue whose stamp falls on the current day merged today. */
  mergedAt: Map<string, string>;
  closedWaves: Set<number>;
  currentWave: number;
  /** the wave a red merged base wave-parked (ADR 0013), indexing the pruned `waves`
   * like `currentWave`/`closedWaves`; -1 when none is parked. Set from the
   * `wave-parked` event, which lands on the in-flight wave with no `campaign-batch-done`
   * to close it, so this holds `currentWave` at the point the wave-park was logged. */
  parkedWave: number;
  /** issue id → the structured `ParkReason` its `parked` event carried (ADR 0019),
   * folded so the lifecycle can surface *why* an issue is held. Absent for an issue
   * parked only by a surviving on-disk record (the reason is read from the record). */
  parkReasons: Map<string, ParkReason>;
  /** the members of the wave a combined-gate `wave-parked` landed on (ADR 0019) — a red
   * merged base. It is the *wave's* reason, not the members': each member keeps its own
   * lifecycle (a merged member stays `completed`, a question stays `parked{question}`), and
   * this set is what makes the wave fold to `parked{red-base}` (design §2.3, #288). */
  redBase: Set<string>;
  /** events the fold refused to apply because they contradicted a terminal `completed` (merged)
   * state (design §2.2): a stale second process logging a `parked`/`failed`/`spawn` for an issue
   * already merged. Recorded here — the reducer's log of what it ignored — never folded, so a
   * late stale event can never flip a merged card back to parked/failed/running. */
  anomalies: string[];
}

/**
 * Reduce a project's event log to its current campaign's plan — pure, no I/O.
 * Only the latest `campaign-start` and everything after it is folded (a fresh
 * campaign supersedes an earlier one in the same log); the plan (the waves) comes
 * from `campaign-start`, so a log with no `campaign-start` frames no waves. This is
 * the load-bearing seam of ADR 0005: `buildStatus` renders it and the `campaign`
 * loop re-reads it each wave.
 * `opts.alive` is the injected liveness probe (design §7): `false` means the run's
 * process is gone (its host slot is not held, §8), so an in-flight `running` issue with
 * no terminal stop marker reconciles to parked{crash}; omitted/`true` never crash-folds.
 */
export function reduceCampaign(events: OrchestratorEvent[], opts: { alive?: boolean } = {}): ReducedCampaign {
  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  let waves: string[][] = [];
  let layout: string[][] = [];
  const pruned = new Set<string>();
  const grafted = new Set<string>();
  const conflictParked = new Set<string>();
  let name: string | undefined;
  let festiveOffset: number | undefined;
  const outcomes = new Map<string, IssueStatus>();
  const pendingGreen = new Set<string>();
  const details = new Map<string, string>();
  const titles = new Map<string, string>();
  const mergedAt = new Map<string, string>();
  const closedWaves = new Set<number>();
  const parkReasons = new Map<string, ParkReason>();
  const anomalies: string[] = [];
  let redBase = new Set<string>();
  let currentWave = -1;
  let parkedWave = -1;

  for (const e of relevant) {
    // Any start event may carry an id→title map (`campaign` writes it on
    // `campaign-start`, a standalone `queue` on `queue-start`); fold them all so
    // the plan carries a name for every issue a title was resolved for.
    if ("titles" in e && e.titles && typeof e.titles === "object") {
      for (const [id, title] of Object.entries(e.titles)) {
        if (typeof title === "string" && title.trim()) titles.set(normalizeIssue(id), title.trim());
      }
    }
    if (e.event === "campaign-start" && Array.isArray(e.waves)) {
      waves = e.waves.map((wave: unknown[]) => wave.map(String).map(normalizeIssue));
      layout = waves.map((wave) => [...wave]);
      name = typeof e.name === "string" && e.name.trim() ? e.name : undefined;
      festiveOffset = festiveOffsetFor(typeof e.ts === "string" ? e.ts : undefined);
      currentWave = -1;
    } else if (e.event === "wave-start" && Number.isInteger(e.index)) {
      currentWave = e.index;
    } else if (e.event === "spawn" && e.taskId) {
      // A task took an agent slot (design §2.1) — running until a terminal event lands. A spawn
      // promotes an `unstarted` member OR a `parked` one (a re-admit, §5 step 3: the answer was
      // delivered and the child re-spawned) back to `running`; without the parked case a
      // re-admitted chip reads parked until its next verdict. A `completed` (merged) member is
      // terminal (§2.2): a spawn for it is a stale second process, ignored as an anomaly.
      const taskId = normalizeIssue(String(e.taskId));
      const prev = outcomes.get(taskId) ?? "unstarted";
      if (prev === "completed") {
        anomalies.push(`spawn for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      if (prev === "unstarted" || prev === "parked") {
        outcomes.set(taskId, "running");
        parkReasons.delete(taskId);
      }
      details.set(taskId, `Running in an agent slot (${e.running ?? "?"} active, ${e.left ?? "?"} waiting)`);
    } else if (e.event === "turn" && e.taskId) {
      details.set(normalizeIssue(String(e.taskId)), `Agent turn ${e.turn ?? "?"} finished; waiting for verification/redrive`);
    } else if (e.event === "green" && e.taskId) {
      // A green banks nothing on the base yet (design §2.2): the issue is `running` with a
      // pending green, not `completed` — the word for banked work is reserved for `merged`.
      // No `mergedAt` stamp, so it never counts toward "merged today" until it merges.
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "running");
      pendingGreen.add(taskId);
      details.set(taskId, e.branch ? `Green on ${e.branch} — pending merge onto the base` : "Green — pending merge onto the base");
    } else if (e.event === "merged" && e.taskId) {
      // The integrator landed this green on the base (design §2.1). Completion, and the
      // resolution of any earlier conflict hold or red-base hold on the same id.
      const taskId = normalizeIssue(String(e.taskId));
      outcomes.set(taskId, "completed");
      pendingGreen.delete(taskId);
      redBase.delete(taskId);
      conflictParked.delete(taskId);
      details.set(taskId, "Merged into base");
      if (e.ts && !mergedAt.has(taskId)) mergedAt.set(taskId, String(e.ts));
    } else if (e.event === "parked" && e.taskId) {
      const taskId = normalizeIssue(String(e.taskId));
      // `completed` (merged) is terminal (design §2.2): a `parked` for an already-merged issue is
      // a stale second process, ignored as an anomaly — it must never flip a merged card to parked.
      if (outcomes.get(taskId) === "completed") {
        anomalies.push(`parked for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      const reason = parkReasonFromEvent(typeof e.reason === "string" ? e.reason : undefined);
      if (reason === "conflict") {
        // A merge conflict pulled this green from integration (design §2.3). Overlay it
        // like `pruned` — the issue's own outcome stays `completed` (it passed its gate),
        // so the set is what makes the chip read `parked{conflict}` until it re-merges.
        conflictParked.add(taskId);
        details.set(taskId, "Parked on a merge conflict — resolve the conflict");
      } else {
        outcomes.set(taskId, "parked");
        parkReasons.set(taskId, reason);
        details.set(taskId, `Parked: ${e.detail ?? reason}`);
      }
    } else if (e.event === "failed" && e.taskId) {
      // A member the agent could not make green (design §2.1, §5 step 5): a terminal failure
      // that holds its wave — the wave lands no `wave-done`, so it stays out of `closedWaves`
      // and folds to `failed` (failure outranks parked, ADR 0019).
      const taskId = normalizeIssue(String(e.taskId));
      // `completed` (merged) is terminal (design §2.2): a `failed` for an already-merged issue is
      // a stale second process, ignored as an anomaly rather than flipping a merged card to failed.
      if (outcomes.get(taskId) === "completed") {
        anomalies.push(`failed for already-merged ${taskId} ignored (completed is terminal)`);
        continue;
      }
      outcomes.set(taskId, "failed");
      if (!details.has(taskId)) details.set(taskId, "Failed — the agent could not make it green");
    } else if (e.event === "campaign-parked") {
      // The campaign paused at a wave boundary (design §2.1): a red merged base, an unresolved
      // issue park (question/stalled), or a merge conflict. No `wave-done` follows to close the
      // wave, so it stays `currentWave`; record that as the parked wave. The wave's reason is
      // written on the event (§2.1 rule 2 — read it, never infer): only `red-base` is a wave-level
      // hold whose members all merged clean, so only then do we stamp `redBase` (what folds the
      // wave to parked(red-base), #288). A question/stalled/conflict park is a member's hold, so the
      // members keep their own lifecycle and the wave carries no wave-level reason. A reason-absent
      // event is a legacy/aliased wave-park (historically red-base), kept back-compatible.
      parkedWave = Number.isInteger(e.index) ? (e.index as number) : currentWave;
      redBase = e.reason === undefined || e.reason === "red-base" ? new Set(waves[parkedWave] ?? []) : new Set();
    } else if (e.event === "wave-done" && Number.isInteger(e.index)) {
      for (const taskId of e.merged ?? []) {
        const issueNumber = normalizeIssue(String(taskId));
        outcomes.set(issueNumber, "completed");
        pendingGreen.delete(issueNumber);
        // A clean re-merge resolves an earlier conflict hold or a red-base hold, so the chip
        // reads completed — and its stale "resolve the conflict" detail becomes the merge line.
        redBase.delete(issueNumber);
        if (conflictParked.delete(issueNumber)) details.set(issueNumber, "Merged into base");
        if (!details.has(issueNumber)) details.set(issueNumber, "Merged into base");
        if (e.ts && !mergedAt.has(issueNumber)) mergedAt.set(issueNumber, String(e.ts));
      }
      // A wave-done closes the wave only when it holds no conflict-parked member (design §7): a
      // conflict-parked green is unresolved work, so its wave stays out of `closedWaves` and a
      // redrive re-enters it (`resumeIndex` reads the first wave absent from `closedWaves`).
      if (!(waves[e.index] ?? []).some((m) => conflictParked.has(normalizeIssue(m)))) {
        closedWaves.add(e.index);
        currentWave = -1;
      }
    } else if (e.event === "prune" && Array.isArray(e.removed)) {
      // Prune the running campaign at the point the prune was issued: banked and
      // in-flight members stay, only parked/unstarted ones leave (ADR 0005).
      // Folding it in log order means `outcomes` already reflects the state the
      // prune saw, so the same rule replays deterministically. The dropped members
      // are remembered (not just removed) so the display can render them `pruned`
      // in the wave they left, while `waves` stays the pruned loop-facing plan.
      const applied = applyPrune({ waves, outcomes }, e.removed.map(String));
      for (const id of applied.dropped) {
        pruned.add(id);
        details.set(id, "Pruned out of the campaign");
      }
      waves = applied.remaining;
    } else if (e.event === "graft" && Array.isArray(e.ids)) {
      // Extend the running campaign at the point the graft was issued: the in-flight
      // and banked waves are pinned, the added issues stable-insert into later waves
      // (ADR 0014). Folding in log order means `outcomes`/`currentWave` reflect the
      // state the graft saw, so the same placement replays deterministically. Mirror
      // the pruned `waves` change into the display `layout` so a grafted issue shows
      // as a chip in the wave it joined, and mark it `grafted` while it stays unstarted.
      const applied = applyGraft({ waves, outcomes, currentWave }, { ids: e.ids.map(String), blockedBy: e.blockedBy ?? {}, basenames: e.basenames ?? {} });
      const placeOf = new Map<string, number>();
      applied.remaining.forEach((wave, i) => wave.forEach((id) => placeOf.set(id, i)));
      const survivors: number[] = [];
      layout.forEach((wave, i) => {
        if (wave.some((id) => !pruned.has(id))) survivors.push(i);
      });
      const layoutOf = new Map<number, number>();
      survivors.forEach((layoutIndex, prunedIndex) => layoutOf.set(prunedIndex, layoutIndex));
      for (const id of applied.grafted) {
        grafted.add(id);
        details.set(id, "Grafted into the campaign");
        const pruned = placeOf.get(id)!;
        let target = layoutOf.get(pruned);
        if (target === undefined) {
          target = layout.push([]) - 1;
          layoutOf.set(pruned, target);
        }
        layout[target].push(id);
      }
      waves = applied.remaining;
    }
  }
  // `grafted` is transient (ADR 0014): an id reads `grafted` only while unstarted, and
  // becomes `running` on pickup — so drop any grafted id that has since reached an outcome.
  for (const id of [...grafted]) if (outcomes.has(id)) grafted.delete(id);

  // Crash reconciliation (design §2.3, §7): liveness comes from the host-slot lease — a
  // run holds a slot while alive (§8). When the injected probe says the run is dead
  // (`alive === false`) and its log carries NO `campaign-*` stop marker, every issue still
  // `running` (its last event non-terminal) died with no verdict, so it reconciles to
  // parked{crash} — never left reading running forever (§15). A crash is the ABSENCE of a
  // stop marker, so any of the three (`campaign-done`/`campaign-parked`/`campaign-failed`)
  // means a clean stop and no crash-fold. Crash is never stored: the probe is an injected
  // input, so the reducer stays pure. A live or unknown run (`alive !== false`) leaves
  // `running` untouched.
  const stopMarkers: ReadonlySet<string> = new Set(["campaign-done", "campaign-parked", "campaign-failed"]);
  if (opts.alive === false && !relevant.some((e) => stopMarkers.has(e.event))) {
    for (const [id, status] of outcomes) {
      // A pending green reads `running` (design §2.2) but reached a green verdict — it is
      // banked-but-unmerged work a redrive lands, not a verdict-less in-flight crash — so it is
      // never crash-folded. Only a genuinely in-flight `running` member (no verdict) reconciles.
      if (status !== "running" || pendingGreen.has(id)) continue;
      outcomes.set(id, "parked");
      parkReasons.set(id, "crash");
      details.set(id, "Crashed — the run died with no verdict; redrive");
    }
  }

  return { waves, layout, pruned, grafted, conflictParked, name, festiveOffset, outcomes, pendingGreen, details, titles, mergedAt, closedWaves, currentWave, parkedWave, parkReasons, redBase, anomalies };
}

/**
 * The issue lifecycle FSM read off a reduced campaign (ADR 0019): the single stored
 * axis, `{state, reason?}`. The transitions the event fold recorded resolve here —
 * a conflict-parked merge conflict overrides the issue's own green outcome to `parked`
 * with reason `conflict`; a `parked` outcome carries its folded `ParkReason` (defaulting
 * to `question`) — including a dead run's in-flight `running` issue, which the reducer
 * has already reconciled to `parked{crash}` off its injected liveness probe (design §7,
 * §15). A `red-base` wave-park is the *wave's* reason, never a member's (design §2.3): it
 * does not appear here, so a member holds its own reason (a merged member stays
 * `completed`, a question stays `parked{question}` with its reply box). Membership is the
 * orthogonal axis (`issueMembership`) and never appears here.
 */
export function issueLifecycle(r: ReducedCampaign, id: string): IssueLifecycle {
  const base = r.outcomes.get(id) ?? "unstarted";
  if (base === "failed") return { state: "failed" };
  if (r.conflictParked.has(id)) return { state: "parked", reason: "conflict" };
  if (base === "parked") return { state: "parked", reason: r.parkReasons.get(id) ?? "question" };
  return { state: base };
}

/**
 * An issue's membership axis (ADR 0019): `pruned` (dropped from the plan), `grafted`
 * (an addition still waiting to start — the reducer already scopes the set to
 * still-unstarted ids), else a plain `member`. Orthogonal to the lifecycle, so the
 * two compose at render with no precedence ladder.
 */
export function issueMembership(r: ReducedCampaign, id: string): Membership {
  if (r.pruned.has(id)) return "pruned";
  if (r.grafted.has(id)) return "grafted";
  return "member";
}

/** One entry in an issue's turn log (ADR 0009): the turn's number as logged
 * (0-indexed; the display adds one), the agent's own one-sentence account of that
 * turn verbatim, and the ISO timestamp it was logged. */
export interface IssueTurn {
  turn: number;
  summary: string;
  ts: string;
}

/**
 * The issue-detail sheet's reconstructed data (story: issue detail sheet): the
 * issue's status and title, its run's campaign name (the header's "repo · campaign"),
 * how many turns the agent took and how long it worked, and the turn log itself —
 * one agent-authored sentence per turn, newest first (ADR 0009). The turn log is
 * the sheet's reason to exist.
 */
export interface IssueDetail {
  issueNumber: string;
  /** the issue's lifecycle state — the dot/word the sheet paints (ADR 0019). */
  status: DisplayStatus;
  /** why it is `parked`, when it is (ADR 0019) — selects the sheet's recovery affordance. */
  reason?: ParkReason;
  /** the orthogonal membership axis — the badge the sheet carries (ADR 0019); absent
   * reads as a plain `member`. */
  membership?: Membership;
  title?: string;
  campaignName?: string;
  turns: number;
  /** the working span in ms: the last event that names this issue minus the first,
   * from the event timestamps. Zero when a single event names it, since a span
   * needs two points; the plan-only `campaign-start` never counts as the start. */
  elapsedMs: number;
  turnLog: IssueTurn[];
  /** the agent's preserved worktree path, from the `worktree-preserved` event the
   * loop logs when it parks a slot — the real per-task identity (ADR/#55 dropped
   * the anonymous-pool agent id, so this is a path, never a fabricated `agent-N`).
   * Undefined when no such event names the issue (e.g. an in-flight or merged run). */
  worktree?: string;
}

/** Does this event name the given issue by an id it carries — its `taskId`, or a
 * membership in one of the id-bearing arrays/maps (`taskIds`, `merged`, `removed`,
 * `queue-done` outcomes)? The plan-only `campaign-start` `batches` are excluded so
 * the working span starts when work does, not at campaign launch. */
const eventNamesIssue = (e: OrchestratorEvent, id: string): boolean => {
  if ("taskId" in e && e.taskId != null && normalizeIssue(String(e.taskId)) === id) return true;
  const inArray = (a: unknown) => Array.isArray(a) && a.map(String).map(normalizeIssue).includes(id);
  if (("taskIds" in e && inArray(e.taskIds)) || ("merged" in e && inArray(e.merged)) || ("removed" in e && inArray(e.removed))) return true;
  if ("outcomes" in e && e.outcomes && typeof e.outcomes === "object" && Object.keys(e.outcomes).map(normalizeIssue).includes(id)) return true;
  return false;
};

/**
 * Reconstruct one issue's detail sheet from an event log — pure, no I/O. Status
 * and title come from the same `reduceCampaign` fold the campaign view renders, so
 * the sheet can never disagree with the chip that opened it; the turn log, count
 * and elapsed span are folded from the events themselves. Only the latest campaign
 * (from its `campaign-start`) is considered, mirroring `reduceCampaign`, so an
 * issue re-run in a fresh campaign shows that run's turns — a queue-only log with
 * no campaign frame is folded whole.
 */
export function reconstructIssueDetail(events: OrchestratorEvent[], issueNumber: string): IssueDetail {
  const id = normalizeIssue(issueNumber);
  const reduced = reduceCampaign(events);
  const { titles, name } = reduced;
  const life = issueLifecycle(reduced, id);
  const membership = issueMembership(reduced, id);

  const latestCampaignIndex = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = latestCampaignIndex >= 0 ? events.slice(latestCampaignIndex) : events;

  const turnLog: IssueTurn[] = [];
  const stamps: number[] = [];
  let worktree: string | undefined;
  for (const e of relevant) {
    if (!eventNamesIssue(e, id)) continue;
    if (typeof e.ts === "string") stamps.push(Date.parse(e.ts));
    if (e.event === "turn") turnLog.push({ turn: Number(e.turn ?? 0), summary: String(e.summary ?? "").trim(), ts: String(e.ts ?? "") });
    // The last preserved worktree wins — a re-park logs a fresh path over a stale one.
    if (e.event === "worktree-preserved" && typeof e.path === "string" && e.path) worktree = e.path;
  }
  const elapsedMs = stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0;

  return { issueNumber: id, status: life.state, ...(life.reason ? { reason: life.reason } : {}), membership, title: titles.get(id), campaignName: name, turns: turnLog.length, elapsedMs, turnLog: turnLog.reverse(), ...(worktree ? { worktree } : {}) };
}

/**
 * Is a campaign currently running over this event log? True iff the latest
 * `campaign-start` has no `campaign-done` after it — the condition the no-plan
 * `prune <issue>` needs before it can prune (ADR 0005). A queue-only run with no
 * campaign frame is not a campaign and returns false.
 */
export function campaignRunning(events: OrchestratorEvent[]): boolean {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  if (start < 0) return false;
  return !events.slice(start).some((e) => e.event === "campaign-done");
}

/**
 * Has a campaign ever been launched over this log? True iff any `campaign-start`
 * with wave batches is present — the "is there a campaign to adjust at all?" guard
 * prune and graft check before `campaignSettled`, so an empty (or campaign-less)
 * log refuses with "nothing to adjust" rather than proceeding into an empty plan.
 * Unlike `campaignRunning` it ignores `campaign-done`: a settled campaign has still
 * been launched, and its "already settled" refusal is `campaignSettled`'s to give.
 */
export function campaignStarted(events: OrchestratorEvent[]): boolean {
  return events.some((e) => e.event === "campaign-start" && Array.isArray(e.waves));
}

/**
 * Is the latest campaign *settled* — every member merged, nothing left to adjust?
 * The single definition prune and graft share (ADR 0019): a campaign is settled
 * exactly when its fold is `completed` — every wave closed, every live member
 * `completed`. `reduceCampaign` is the source; no new state is stored. This is the
 * fold, not the `campaign-done` marker: a run that ended incomplete (parked, failed,
 * or crashed with no `campaign-done`) is *unsettled* and stays adjustable, and a run
 * whose every member merged is settled even if its process died before it logged
 * `campaign-done` (design §5, §15). A log with no campaign folds to no waves, which is
 * not `completed`, so an empty or campaign-less log is never settled — callers that
 * must refuse "nothing to adjust" guard the missing campaign separately.
 */
export function campaignSettled(events: OrchestratorEvent[]): boolean {
  const reduced = reduceCampaign(events);
  if (!reduced.waves.length) return false;
  const waveStates = reduced.waves.map((wave) =>
    waveState(
      wave.map((id) => ({ status: issueLifecycle(reduced, id).state })),
      { redBase: wave.some((id) => reduced.redBase.has(id)) },
    ),
  );
  return campaignState(waveStates) === "completed";
}

/** An archived run's terminal disposition for the archived-runs list: `complete`
 * when its latest campaign reached the terminal `campaign-done`/`queue-done` (a
 * full, clean finish), else `stalled` — the run stopped with no terminal event
 * (killed mid-wave, a crash), the coarse run-level word for the archived list. A
 * stalled run still expands to the waves that did run; its in-flight issues, dead with
 * no verdict, fold to `parked{crash}` when read back (`buildStatus({ dead: true })`,
 * design §7). */
export type ArchivedRunState = "complete" | "stalled";

/**
 * A run's terminal disposition, scoped to the latest `campaign-start` like the
 * rest of the reducer (#69) so a superseded earlier run never decides it — a run
 * is `complete` once it lands its `campaign-done` marker.
 */
export function archivedRunState(events: OrchestratorEvent[]): ArchivedRunState {
  const start = events.findLastIndex((e) => e.event === "campaign-start" && Array.isArray(e.waves));
  const relevant = start >= 0 ? events.slice(start) : events;
  return relevant.some((e) => e.event === "campaign-done") ? "complete" : "stalled";
}

/**
 * The ISO timestamp a run token encodes, or undefined when it doesn't parse.
 * `archiveRun` writes the token as `new Date().toISOString().replace(/[:.]/g, "-")`,
 * so `2026-08-23T22-22-36-267Z` reverses to `2026-08-23T22:22:36.267Z` — only the
 * time's `:`/`.` were flattened to `-`, the date keeps its own. An older token
 * written without the milliseconds or the trailing `Z` still parses (ms → `.000`).
 */
export function parseRunTimestamp(run: string): string | undefined {
  const m = run.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z?$/);
  if (!m) return undefined;
  const [, date, h, mi, s, ms] = m;
  const iso = `${date}T${h}:${mi}:${s}.${ms ?? "000"}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** The archive-token form of an ISO timestamp — the inverse of {@link parseRunTimestamp}:
 * flatten only the time's `:`/`.` to `-`, exactly as `archiveRun` writes a run's token
 * (`new Date().toISOString().replace(/[:.]/g, "-")`). The date keeps its own `-`. Used to
 * mint a `lastRun` token for a finished campaign still living in the live log — never
 * archived, so with no token of its own (design §11). */
const runTokenFor = (iso: string): string => iso.replace(/[:.]/g, "-");

/** The latest event timestamp in a log — the finish stamp of the run it records. Undefined
 * when no event carries a `ts`. */
const lastEventStamp = (events: OrchestratorEvent[]): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) if (typeof events[i].ts === "string") return events[i].ts as string;
  return undefined;
};

/** An archived run addressable in the dashboard: its timestamp token (`run`), the
 * resolved log path, and a one-line summary of what it did. The token is the only
 * thing a request supplies; `file` is resolved from the listing, never joined from
 * request input, so there is no path to traverse. */
export interface ArchivedRun {
  run: string;
  file: string;
  summary: string;
  /** the run's `--name`, when it was launched with one — the list's primary label
   * (it falls back to the `run` timestamp token when absent). */
  name?: string;
  /** whether the run finished clean (`complete`) or was cut short (`stalled`);
   * a stalled row still expands to the partial waves recorded before it stopped. */
  state: ArchivedRunState;
  /** the run's start time as an ISO timestamp, parsed from its `run` token; undefined
   * for a token that doesn't parse (so the row falls back to the token verbatim). */
  startedAt?: string;
  /** how many issues the run's plan spanned (its full pre-prune membership, so a
   * pruned-out issue still counts — it renders as a chip in the expanded view). */
  issues: number;
}

/** The directory a project's finished-run logs are archived into (mirrors
 * `archiveRun`'s own `logs/archive` layout). */
const archiveDirOf = (baseLocation: string) => join(baseLocation, "logs", "archive");

/**
 * List a project's archived runs newest-first, each with the one-line summary
 * `summarizeRun` folds from its log. The timestamp token is read off the
 * `orchestrator-<timestamp>.jsonl` filename `archiveRun` wrote, so it sorts
 * lexicographically into newest-first (ISO stamps are zero-padded). A malformed
 * archive — one no run can be reconstructed from — is skipped with a log line,
 * never fatal: one bad file must not take the whole list down.
 */
export function listArchivedRuns(baseLocation: string, logger: Logger = hostLogger()): ArchivedRun[] {
  const dir = archiveDirOf(baseLocation);
  if (!existsSync(dir)) return [];
  const runs: ArchivedRun[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(/^orchestrator-(.+)\.jsonl$/);
    if (!match) continue;
    const file = join(dir, name);
    const events = readEventLog({ logFile: file });
    const { waves, layout, name: runName } = reduceCampaign(events);
    if (!waves.length) {
      logger.log("status-archive-skipped", { file });
      continue;
    }
    runs.push({
      run: match[1],
      file,
      summary: summarizeRun(events),
      name: runName,
      state: archivedRunState(events),
      startedAt: parseRunTimestamp(match[1]),
      issues: layout.flat().length,
    });
  }
  return runs.sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0));
}

/**
 * Fold one run's event log into a one-line summary for the archived-runs list:
 * its mode (a `campaign` frame vs a bare `queue` run), how many issues it spanned,
 * and whether it finished clean or failed. Failure is derived from an issue reaching
 * `failure` (the agent could not make it green, ADR 0019) — the same `reduceCampaign`
 * plan the dashboard renders, so the summary can never disagree with the run's
 * reconstructed wave/issue view (ADR 0005).
 */
export function summarizeRun(events: OrchestratorEvent[]): string {
  // Everything derives from the run `reduceCampaign` reconstructs (the latest
  // `campaign-start` onward), so a multi-run archive summarizes its terminal run —
  // a failure in a superseded earlier run in the same log no longer reads a
  // completed run as failed (#69).
  const { waves, outcomes } = reduceCampaign(events);
  const mode = events.some((e) => e.event === "campaign-start") ? "campaign" : "queue";
  const count = waves.flat().length;
  const failed = [...outcomes.values()].includes("failed");
  return `${mode} · ${count} issue${count === 1 ? "" : "s"} · ${failed ? "failed" : "complete"}`;
}

/**
 * Reconstruct a project's live campaign status off its event log (ADR 0005/0019).
 * Each chip composes the two orthogonal axes — its `issueLifecycle` (the dot/word) and
 * `issueMembership` (the badge) — and each wave's status is the pure `waveState` fold of
 * its members, so a wave with a red member reads `failed` and a held wave reads `parked`
 * by construction (no render-time precedence). Liveness feeds crash detection (design §7):
 * `dead` marks a run whose process is gone (an archived read) and `alive` carries the live
 * host-slot probe (`projectHasLiveLease`); either way an `alive === false` run with no
 * terminal event reconciles its still-`running` issues to `parked{crash}` inside the
 * reducer. Omitting both leaves the live default — `running` stays `running`.
 */
export function buildStatus(cfg: ResolvedConfig, opts: { dead?: boolean; alive?: boolean } = {}): CampaignStatus {
  const events = readEventLog(cfg);
  // An archived read is dead by definition; a live read passes the slot-lease probe. The
  // reducer folds an in-flight `running` issue of a dead run to `parked{crash}` (§7, §15).
  const alive = opts.dead ? false : opts.alive;
  const reduced = reduceCampaign(events, { alive });
  const { waves, layout, name, festiveOffset, outcomes, details, titles, closedWaves } = reduced;

  const activeIssueNumbers = new Set(waves.flat());
  const closedIssueNumbers = new Set([...closedWaves].flatMap((index) => waves[index] ?? []));
  const parkedRecords = listParked(cfg).filter((parked) => {
    const issueNumber = normalizeIssue(parked.taskId);
    return (!activeIssueNumbers.size || activeIssueNumbers.has(issueNumber)) && !closedIssueNumbers.has(issueNumber);
  });
  for (const parked of parkedRecords) {
    const taskId = normalizeIssue(parked.taskId);
    // `completed` (merged) is terminal (design §2.2): a record that outlived a since-merged issue
    // (durable records are only cleared on re-admit/redrive or `prune --purge`, §2.5) must not flip
    // the merged card back to parked. Leave the outcome; the surviving record is a stale straggler.
    if (outcomes.get(taskId) === "completed") continue;
    outcomes.set(taskId, "parked");
    reduced.parkReasons.set(taskId, parkReasonFromEvent(parked.reason));
    details.set(taskId, `Parked: ${parked.reason}`);
  }

  // Display waves render off `layout` (the pre-prune membership) so a pruned issue still
  // shows as a chip in the wave it left (ADR 0007). Each chip carries both axes; the wave's
  // own status is the pure fold of its members (`waveState`), pruned members excluded. A
  // crashed run's in-flight issues already read `parked{crash}` off the reducer above.
  const displayWaves = layout.map((wave, index) => {
    const issues = wave.map((issueNumber): StatusIssue => {
      const life = issueLifecycle(reduced, issueNumber);
      return {
        issueNumber,
        status: life.state,
        ...(life.reason ? { reason: life.reason } : {}),
        membership: issueMembership(reduced, issueNumber),
        ...(reduced.pendingGreen.has(issueNumber) ? { pendingGreen: true } : {}),
        name: titles.get(issueNumber),
        detail: details.get(issueNumber),
      };
    });
    // A red-base wave-park is the wave's own reason (design §2.3): its members keep their
    // lifecycle (a merged member stays completed), so the hold shows only on the wave.
    const redBase = wave.some((issueNumber) => reduced.redBase.has(issueNumber));
    return { index, status: waveState(issues, { redBase }), ...(redBase ? { reason: "red-base" as ParkReason } : {}), issues };
  });

  return {
    project: cfg.project,
    name,
    festiveOffset,
    waves: displayWaves,
    parked: parkedRecords.map(toParkedIssue),
    // The wave in flight is the reducer's `currentWave` (design §11); its members are what the
    // live tail follows. Always an array (empty when none is in flight) so the tail scopes rather
    // than falling back to every runner across the plan.
    inFlight: reduced.currentWave >= 0 ? [...(reduced.waves[reduced.currentWave] ?? [])] : [],
  };
}

/**
 * One line in the live tail (#124): the running issue it came from (the gutter
 * number), that issue's status (the gutter colour), its ISO `ts`, its 0-based index
 * within its own `activity-<issue>.jsonl` (`n` — a stable id the client dedups its
 * appends by, immune to the snapshot window sliding), and the exact JSONL text (the
 * client tokenises it with `highlightJsonLine` and substring-filters it whole).
 */
export interface TailLine {
  issue: string;
  status: IssueStatus;
  ts: string;
  n: number;
  raw: string;
  /** the line's humanized parts (#203) — `time · actor · what happened` + a state dot, so
   * the log-view component renders humanized-by-default without re-parsing the raw client-side. */
  humanized: HumanizedRow;
}

/** One running agent the live tail merges: its issue number and status (always
 * `running` — the pane only tails agents in flight). */
export interface TailAgent {
  issue: string;
  status: IssueStatus;
}

/** A project's live-tail snapshot: the running agents (for the issue dropdown) and
 * their merged, newest-last activity lines (capped at `TAIL_SNAPSHOT_CAP`). */
export interface LiveTail {
  agents: TailAgent[];
  lines: TailLine[];
}

/**
 * The server-side merge window a tail snapshot carries — the newest lines across every
 * running agent (#124). The client accumulates its own following buffer (capped smaller)
 * from these snapshots; a generous server window keeps a *paused* client's growing
 * backlog fed even across many appends.
 */
export const TAIL_SNAPSHOT_CAP = 500;

/**
 * The running (slot-holding) members of the wave in flight (design §11) — what the live tail
 * follows. The tail answers "what is it doing right now", so it lists the runners of the one wave
 * the loop is draining (`status.inFlight`), never a member still reading `running` in a wave that
 * has advanced or one not yet in flight (a racy/partial log leaves such ghosts). A hand-built
 * status with no `inFlight` field falls back to every running issue across the plan.
 */
export function inFlightRunning(status: CampaignStatus): StatusIssue[] {
  // A pending green reads `running` (design §2.2) but its slot is already freed, so it is not an
  // in-flight runner the tail should follow — exclude it, leaving only slot-holding runners.
  const running = status.waves.flatMap((wave) => wave.issues).filter((issue) => issue.status === "running" && !issue.pendingGreen);
  if (status.inFlight === undefined) return running;
  const ids = new Set(status.inFlight);
  return running.filter((issue) => ids.has(issue.issueNumber));
}

/**
 * The live-tail snapshot for a project (#124): every running agent of the wave in flight
 * ({@link inFlightRunning}), its raw `activity-<issue>.jsonl` merged into one issue-keyed,
 * newest-last stream. Each agent's activity file (the live-only scratch the loop writes per
 * tool-use, ADR 0015) is read whole, every line tagged with its issue, status, ISO `ts`, and
 * 0-based file index, then all lines merged by `ts` and capped to the newest window. A running
 * agent whose file does not exist yet (just spawned) still appears in `agents` so the dropdown
 * lists it; it simply contributes no lines. Pure over the filesystem — no clock — so it is
 * unit-testable.
 */
export function buildLiveTail(cfg: ResolvedConfig): LiveTail {
  const status = buildStatus(cfg);
  const agents: TailAgent[] = inFlightRunning(status).map((issue) => ({ issue: issue.issueNumber, status: "running" }));
  const lines: TailLine[] = [];
  for (const agent of agents) {
    const file = activityLogPath(cfg.stateDir, agent.issue);
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content
      .split("\n")
      .filter(Boolean)
      .forEach((text, n) => {
        let ts = "";
        try {
          const parsed = JSON.parse(text) as { ts?: unknown };
          if (typeof parsed?.ts === "string") ts = parsed.ts;
        } catch {
          // An unparseable line still renders in the raw tail; an empty `ts` sorts it first.
        }
        lines.push({ issue: agent.issue, status: "running", ts, n, raw: text, humanized: humanizeLogLine(text) });
      });
  }
  // Stable sort merges the per-agent streams newest-last by `ts`; ties keep file order.
  lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { agents, lines: lines.length > TAIL_SNAPSHOT_CAP ? lines.slice(lines.length - TAIL_SNAPSHOT_CAP) : lines };
}

export async function buildStatusWithIssueNames(cfg: ResolvedConfig): Promise<CampaignStatus> {
  const status = buildStatus(cfg);
  const issues = status.waves.flatMap((wave) => wave.issues);
  await Promise.all(
    issues.map(async (issue) => {
      const cacheKey = `${cfg.project}:${issue.issueNumber}`;
      if (!issueNameCache.has(cacheKey)) {
        try {
          issueNameCache.set(cacheKey, issueNameFromTask(String(await cfg.fetchTask(issue.issueNumber))));
        } catch {
          issueNameCache.set(cacheKey, undefined);
        }
      }
      issue.name = issueNameCache.get(cacheKey);
    }),
  );
  return status;
}

/**
 * The slice of a `ResolvedConfig` that `buildStatus` actually reads, synthesized
 * from a registry pointer's base location. The gateway is a dumb router (ADR
 * 0002): it never imports a project's TS config, it reads the same state files
 * (`logs/`, `parked/`) the run wrote under the base location — the paths a full
 * config's `loadConfig` would have derived from `stateDir`.
 */
/** The orchestrator event log inside a project's base location — the file the
 * gateway reads to reconstruct a project's campaign without its TS config. */
export const logFileOf = (baseLocation: string) => join(baseLocation, "logs", "orchestrator.jsonl");

/**
 * The `ResolvedConfig` slice `buildStatus` needs to render one archived run: its
 * log is the archive file, and its `parkedDir` points at the archive directory —
 * which holds only `orchestrator-*.jsonl`, never parked `*.json` — so `listParked`
 * reads empty and the archived render carries no parked cards (read-only).
 */
export const archiveStatusConfig = (project: string, archiveFile: string): ResolvedConfig =>
  ({
    project,
    stateDir: dirname(archiveFile),
    parkedDir: dirname(archiveFile),
    logFile: archiveFile,
  }) as ResolvedConfig;

/** The `ResolvedConfig` slice a registry pointer resolves to — the paths a full config's
 * `loadConfig` would derive from its base location (ADR 0002). Exported so the live-update
 * route can build a project's `buildLiveTail`/`buildStatus` off its pointer without its TS
 * config, exactly as `buildAllStatus` does internally. */
export const statusConfigFromPointer = (pointer: ProjectPointer): ResolvedConfig =>
  ({
    project: pointer.project,
    stateDir: pointer.baseLocation,
    parkedDir: parkedDirOf(pointer.baseLocation),
    logFile: logFileOf(pointer.baseLocation),
  }) as ResolvedConfig;

/**
 * Build the campaign status for every registered project, reading each project's
 * state live from its base location. A project whose base location is missing
 * (moved or deleted since it registered) is skipped with a log line, never
 * throwing — one stale registration must not take the whole dashboard down (ADR
 * 0002). Uses the pure `buildStatus`, so issue names are not resolved here (that
 * needs the project's own `fetchTask`); the aggregated view is names-free. `configDir`
 * (the gateway config dir) enables live crash detection (design §7): each project's
 * host-slot lease is probed for liveness so a run that died with no verdict folds to
 * `parked{crash}`. Omitted (a pure caller with no lease to reach), the live default holds.
 */
export function buildAllStatus(pointers: ProjectPointer[], logger: Logger = hostLogger(), configDir?: string): CampaignStatus[] {
  const statuses: CampaignStatus[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const alive = configDir !== undefined ? projectHasLiveLease(configDir, pointer.project) : undefined;
    statuses.push(buildStatus(statusConfigFromPointer(pointer), { alive }));
  }
  return statuses;
}

/** One row of the cross-project event feed: which project it came from, when it
 * happened (the event's ISO `ts`), the raw event kind, the repo-prefixed
 * plain-words sentence `formatFeedEvent` folds it to, and `raw` — the underlying
 * event serialized back to NDJSON, the bytes the feed's Raw toggle highlights and
 * Download JSON emits (#203), so the humanized default has a faithful raw source. */
export interface FeedEntry {
  project: string;
  ts: string;
  kind: string;
  text: string;
  raw: string;
  /** the row's shared log-view parts (#216): the repo leads the message as the actor, the
   * narration is one plain span, and the dot reads the event's state — so the feed renders in
   * the same `.lv-row` component as the live tail, host log and archive. */
  humanized: HumanizedRow;
}

/** The feed's rolling window: an event feeds only when its `ts` is within this
 * span of render time. 48h — deliberately a fixed rolling window, *not* the
 * merged-today counters' operator-local calendar day (#97): the two surfaces
 * answer different questions ("what has the fleet done lately" vs. "what merged
 * on today's date"), so they carry different time bounds by design. */
const FEED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Margin added to the window when deciding which archived runs to read. An
 * archive's runId (its filename timestamp) is when the run *started*; a run that
 * began just before the window can still hold events inside it. A run's events
 * cluster near its runId, so reading archives whose start falls within the window
 * plus this small margin catches them without opening ancient archives — the
 * per-event `ts` filter then makes the precise 48h cut. */
const FEED_ARCHIVE_MARGIN_MS = 6 * 60 * 60 * 1000;

/**
 * The cross-project event feed: every registered project's narratable events over
 * a rolling 48h window (by event `ts`), repo-prefixed and sorted newest-first.
 * Reads each project's live run **and** its recently-archived runs — an idle
 * project's last run archived and reset its live log (`archiveRun`), so a live-only
 * read would show "No activity" even when it merged issues hours ago (#101). Only
 * archives whose runId falls within the window (plus a small margin) are opened;
 * events are then filtered to the window by `ts`. Reads live off the registry,
 * exactly as `buildLanding`/`buildAllStatus` do — a project whose base location is
 * gone, or a single malformed archive, is skipped with a log line rather than
 * throwing (ADR 0002). Machine-noise events `describeEvent` can't narrate carry no
 * row (`formatFeedEvent` returns ""), so the feed reads as an operator log, not a
 * raw event dump.
 */
export function buildFeed(pointers: ProjectPointer[], now: Date = new Date(), logger: Logger = hostLogger(), festive = false): FeedEntry[] {
  const cutoffMs = now.getTime() - FEED_WINDOW_MS;
  const archiveFloorMs = cutoffMs - FEED_ARCHIVE_MARGIN_MS;
  const entries: FeedEntry[] = [];
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    // The runs whose events might fall in the window: the live log, plus each
    // archived run whose start is recent enough to still carry in-window events.
    const runs: OrchestratorEvent[][] = [readEventLog(statusConfigFromPointer(pointer))];
    for (const run of listArchivedRuns(pointer.baseLocation, logger)) {
      const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
      if (Number.isNaN(startedMs) || startedMs < archiveFloorMs) continue;
      try {
        runs.push(readEventLog({ logFile: run.file }));
      } catch (error) {
        logger.log("status-feed-archive-skipped", { file: run.file, error: String(error) });
      }
    }
    for (const events of runs) {
      // Each run carries its own reserved offset on its `campaign-start`, so resolve it
      // once per run and narrate that run's wave events festively off it (#193).
      const festiveArg = festiveFor(events, festive);
      const titles = titlesFromLog(events);
      for (const e of events) {
        const tsMs = Date.parse(String(e.ts ?? ""));
        if (Number.isNaN(tsMs) || tsMs < cutoffMs) continue;
        const sentence = describeEvent(e, { festive: festiveArg, titles });
        if (!sentence) continue;
        const raw = JSON.stringify(e);
        // The feed is cross-repo, so the repo leads the message as the actor; the narration is
        // one plain span and the dot borrows the event's state from the shared log-view registry.
        const dot = humanizeLogLine(raw).dot;
        const humanized: HumanizedRow = { time: localTime(typeof e.ts === "string" ? e.ts : ""), actor: pointer.project, verb: "", spans: [{ text: sentence, kind: "plain" }], dot };
        entries.push({ project: pointer.project, ts: String(e.ts), kind: String(e.event ?? ""), text: formatFeedEvent(pointer.project, e, { festive: festiveArg, titles }), raw, humanized });
      }
    }
  }
  return entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

const toParkedIssue = (rec: ParkedRecord): ParkedIssue => {
  const details = extractParkedDetails(rec.question);
  return {
    issueNumber: normalizeIssue(rec.taskId),
    reason: rec.reason,
    parkedAt: rec.parkedAt,
    branch: rec.branch,
    ...details,
  };
};

/**
 * Which project the aggregated view shows: the one named in the request, or the
 * first registered project when none is named (or the name is stale). Never
 * undefined given at least one project — the page always shows something useful
 * on a bare open. Callers guard the empty-registry case before calling.
 */
export function selectStatus(statuses: CampaignStatus[], requested?: string): CampaignStatus {
  return statuses.find((s) => s.project === requested) ?? statuses[0];
}

/** A project's run-state rolled up to one word for the landing card (ADR 0019): the
 * card fold of its campaign. `failed` (a broken issue) outranks `parked` (a held
 * one), then `running`; a completed or absent campaign folds to `idle` — the card
 * never reads a bare "completed", and never `idle` while anything is parked or failed. */
export type RunState = "running" | "parked" | "failed" | "idle";

/** One project's row on the all-repos landing: its run state, the campaign it is
 * (or last) running, how far through the waves it is, how much has merged, a
 * running/parked/queued tally, and the last event in plain words. An idle project
 * (no live run) reads `idle` and carries its last campaign's name and summary. */
export interface ProjectCard {
  project: string;
  /** the project's `owner/name`, derived from its checkout's git remote — the label
   * the card heading shows in place of the bare `project` key; omitted (so the
   * display falls back to `project`) for a project with no parseable GitHub remote. */
  repo?: string;
  runState: RunState;
  campaignName?: string;
  wave: { current: number; total: number } | null;
  percentMerged: number;
  tally: { running: number; parked: number; queued: number };
  lastEvent: string;
  /** for an idle project, the facts of its newest archived run (design §11): the run
   * token the card links to (`/?project=…&run=<token>`, which the project page expands
   * as `archivedRun` at the top of the newest-first list), the run's `complete`/`stalled`
   * outcome, its campaign name (the run's `--name`, falling back to the token), and the
   * finish time parsed off the token (the archive stamp `archiveRun` writes at end-of-run).
   * Absent for a live run (running/parked) — there is no finished run to point the card at. */
  lastRun?: { run: string; outcome: ArchivedRunState; name: string; finishedAt?: string };
}

/** The four numbers across the top of the landing, summed across every live
 * project: agents working (running issues), issues awaiting a human (parked),
 * issues still queued (unstarted), and issues merged on the current day. */
export interface LandingCounters {
  working: number;
  parked: number;
  queued: number;
  mergedToday: number;
}

/** One parked question in the cross-repo queue the landing's parked counter
 * expands into: which issue, which repo, the full question, and when it was
 * parked (the client derives the waited duration from `parkedAt`). */
export interface ParkedQuestion {
  issueNumber: string;
  project: string;
  question: string;
  parkedAt: string;
}

/** The all-repos landing model: the four counters, one card per registered
 * project, and the cross-repo parked queue (oldest first). The client shell
 * renders this; it is reconstructed live off the registry each request, exactly
 * as `buildAllStatus` is (ADR 0006). */
export interface LandingView {
  counters: LandingCounters;
  projects: ProjectCard[];
  parked: ParkedQuestion[];
}

/**
 * The card fold (ADR 0019): a project's `RunState` is the pure fold of its campaign
 * (which is itself the fold of its waves), with `completed`/`unstarted`/no-campaign
 * collapsed to `idle`. `failed` outranks `parked` — a broken issue is a louder signal
 * than a held one (the deliberate reversal of the old `parked > failed` order). A
 * surviving parked record (a park that outlived its live plan) still forces `parked`,
 * so the card is never `idle` while a question waits (#232, #258). No precedence ladder:
 * the fold is the single derivation, so a card can never disagree with its waves.
 */
export const cardState = (status: CampaignStatus): RunState => {
  const campaign = campaignState(status.waves.map((wave) => wave.status));
  if (campaign === "failed") return "failed";
  if (campaign === "parked" || status.parked.length) return "parked";
  if (campaign === "running") return "running";
  return "idle";
};

/** Same *local* calendar day — the basis for "merged today". The gateway runs in
 * the operator's timezone, so a merge is "today" when its local Y/M/D matches
 * `now`'s local Y/M/D, not its UTC day (#97): near midnight the two diverge, and
 * the operator means their own day. `new Date(iso)` parses the merge stamp and its
 * getters read it in the process timezone, the same one `now` is read in. */
const sameLocalDay = (iso: string, day: Date) => {
  const merged = new Date(iso);
  return (
    merged.getFullYear() === day.getFullYear() &&
    merged.getMonth() === day.getMonth() &&
    merged.getDate() === day.getDate()
  );
};

/**
 * How many of a project's issues merged (completed) on `now`'s day, counted across
 * *every* one of its runs — the live run plus every archived run
 * (`listArchivedRuns`), not just the latest (#97). Each run is reduced
 * independently and an issue that completed today in it is added to a per-project
 * set, so an issue appearing in more than one run (a re-run) is counted once. Read-
 * only over the logs (ADR 0002); a run whose reduce throws is skipped with a log
 * line so one bad archive can never zero the count. "Today" is the operator's
 * local day (see `sameLocalDay`), so a merge just past midnight UTC still counts
 * for the local day the operator is actually in (#97).
 */
const mergedTodayForProject = (baseLocation: string, liveEvents: OrchestratorEvent[], now: Date, logger: Logger): number => {
  const merged = new Set<string>();
  const runs = [liveEvents, ...listArchivedRuns(baseLocation, logger).map((r) => readEventLog({ logFile: r.file }))];
  for (const runEvents of runs) {
    try {
      const { mergedAt, outcomes } = reduceCampaign(runEvents);
      for (const [issueNumber, ts] of mergedAt) {
        if (outcomes.get(issueNumber) === "completed" && sameLocalDay(ts, now)) merged.add(issueNumber);
      }
    } catch (error) {
      logger.log("status-merged-today-skipped", { baseLocation, error: String(error) });
    }
  }
  return merged.size;
};

const buildProjectCard = (pointer: ProjectPointer, status: CampaignStatus, events: OrchestratorEvent[], parked: ParkedRecord[], logger: Logger, festive = false): ProjectCard => {
  // The card heading shows owner/name, read live off the checkout's git remote;
  // undefined for a project with none (the demo), so the display falls back to the key.
  const repo = repoForProject(pointer.projectRoot);
  // A park that outlived its run's log (the log archived — a killed process, an
  // out-of-band archive — while the record survives on disk) is invisible to the
  // live-plan-filtered `status.parked` an idle branch has, so the idle branches read
  // `listParked` directly: any surviving record makes the card `parked` with a real
  // tally, never a clean idle/complete while a question still waits (ADR 0017, #232).
  if (!status.waves.length) {
    const [latest] = listArchivedRuns(pointer.baseLocation, logger);
    // An idle card's numbers come from the last archived run, not the emptied live
    // log: reconstruct it and read its real merged % so a completed run no longer
    // reads 0% (#70). `waves` is already the pruned plan (pruned issues dropped), so
    // the ratio matches the live card's pruned-aware count.
    const archived = latest ? reduceCampaign(readEventLog({ logFile: latest.file })) : undefined;
    const archivedIssues = archived ? archived.waves.flat() : [];
    const merged = archived ? archivedIssues.filter((n) => archived.outcomes.get(n) === "completed").length : 0;
    return {
      project: status.project,
      repo,
      runState: parked.length ? "parked" : "idle",
      campaignName: latest?.name ?? latest?.run,
      wave: null,
      percentMerged: archivedIssues.length ? Math.round((merged / archivedIssues.length) * 100) : 0,
      tally: { running: 0, parked: parked.length, queued: 0 },
      lastEvent: latest ? `Last run: ${latest.summary}` : "No runs yet",
      // The card opens onto its newest archived run: its outcome, name and finish time,
      // plus the token the card links to so the project page expands it at the top of the
      // archived list (design §11). Absent when the project has never archived a run.
      ...(latest ? { lastRun: { run: latest.run, outcome: latest.state, name: latest.name ?? latest.run, finishedAt: latest.startedAt } } : {}),
    };
  }
  // A finished campaign still lingering in the live log folds to idle at render time
  // (#208): the read-only dashboard never archives (ADR 0002), so a campaign whose
  // every wave closed — but whose log the CLI never emptied — otherwise reads live
  // forever. The card fold already collapses a `completed` campaign to `idle`; this
  // branch swaps the live wave counts for the finished run's name + "Last run: …"
  // summary. A surviving parked record still wins (parked over idle, #232); the fold's
  // `failed`/`parked`/`running` never reach here, so no attention state ever fades. The
  // live log is left byte-for-byte untouched — this is display-only.
  if (campaignState(status.waves.map((wave) => wave.status)) === "completed") {
    const { waves, outcomes } = reduceCampaign(events);
    const finishedIssues = waves.flat();
    const merged = finishedIssues.filter((n) => outcomes.get(n) === "completed").length;
    // The finished run's facts, read off the live log it still sits in (design §11): its
    // clean/stalled disposition, when it finished (its last stamp), and — since it was never
    // archived so has no archive token — a token derived from that finish stamp (the inverse
    // of `parseRunTimestamp`). The card links `/?project=…&run=<token>`; the run renders as the
    // live campaign at the top of the project page, so the link opens onto it either way.
    const finishedAt = lastEventStamp(events);
    const lastRun = finishedAt
      ? { run: runTokenFor(finishedAt), outcome: archivedRunState(events), name: status.name ?? runTokenFor(finishedAt), finishedAt }
      : undefined;
    return {
      project: status.project,
      repo,
      runState: parked.length ? "parked" : "idle",
      campaignName: status.name,
      wave: null,
      percentMerged: finishedIssues.length ? Math.round((merged / finishedIssues.length) * 100) : 0,
      tally: { running: 0, parked: parked.length, queued: 0 },
      lastEvent: `Last run: ${summarizeRun(events)}`,
      ...(lastRun ? { lastRun } : {}),
    };
  }
  // The card reflects the live plan, not the display's pruned ghosts: drop pruned
  // chips (and any wave left wholly pruned) so wave counts and progress match what
  // is actually still running (ADR 0007/0019's pruned is a membership overlay only).
  const liveWaves = status.waves
    .map((wave) => ({ ...wave, issues: wave.issues.filter((i) => i.membership !== "pruned") }))
    .filter((wave) => wave.issues.length);
  const issues = liveWaves.flatMap((wave) => wave.issues);
  const total = liveWaves.length;
  const closed = liveWaves.filter((wave) => wave.status === "completed").length;
  const runningWave = liveWaves.findIndex((wave) => wave.status === "running");
  const completed = issues.filter((i) => i.status === "completed").length;
  return {
    project: status.project,
    repo,
    runState: cardState(status),
    campaignName: status.name,
    // "N of M": the wave in flight if one is, otherwise how many have closed.
    wave: { current: runningWave >= 0 ? runningWave + 1 : closed, total },
    percentMerged: issues.length ? Math.round((completed / issues.length) * 100) : 0,
    // Count each issue by its lifecycle directly — the two-axis split means a chip's
    // status is already a clean lifecycle (a grafted issue reads `unstarted` → queued,
    // #200), with pruned members dropped above (a pruned chip counts in no bucket).
    tally: {
      running: issues.filter((i) => i.status === "running").length,
      parked: issues.filter((i) => i.status === "parked").length,
      queued: issues.filter((i) => i.status === "unstarted").length,
    },
    lastEvent: lastEventText(events, festive),
  };
};

/**
 * Reconstruct the all-repos landing model live off the registry: one card per
 * project and the four summed counters. A project whose base location is gone is
 * skipped with a log line, never throwing — one stale registration must not take
 * the landing down (ADR 0002), the same tolerance `buildAllStatus` has.
 * merged-today counts each project's issues whose reconstructed merge stamp
 * (`reduceCampaign`'s `mergedAt`) falls on `now`'s local day. `configDir` (the gateway
 * config dir) enables live crash detection (design §7): a project whose run died with no
 * verdict folds to `parked{crash}`, so its card never reads idle or running. Omitted, the
 * live default holds — the same optional probe `buildAllStatus` takes.
 */
export function buildLanding(pointers: ProjectPointer[], now: Date = new Date(), logger: Logger = hostLogger(), festive = false, configDir?: string): LandingView {
  const projects: ProjectCard[] = [];
  const parked: ParkedQuestion[] = [];
  let mergedToday = 0;
  for (const pointer of pointers) {
    if (!existsSync(pointer.baseLocation)) {
      logger.log("status-project-skipped", { project: pointer.project, baseLocation: pointer.baseLocation });
      continue;
    }
    const cfg = statusConfigFromPointer(pointer);
    const events = readEventLog(cfg);
    const alive = configDir !== undefined ? projectHasLiveLease(configDir, pointer.project) : undefined;
    const status = buildStatus(cfg, { alive });
    const parkedRecords = listParked(cfg);
    // merged-today counts every issue merged today across all of the project's runs
    // — the live run plus every archived run, deduped per issue — so a project that
    // ran several campaigns today counts them all, not just its latest run (#97).
    // A completed run's merges live in its archive, not the cleared live log (#70).
    mergedToday += mergedTodayForProject(pointer.baseLocation, events, now, logger);
    const card = buildProjectCard(pointer, status, events, parkedRecords, logger, festive);
    // Cross-repo parked queue: a live/paused run lists its plan-filtered parks
    // (`status.parked`); an idle-path card (archived or folded to complete) counts
    // every surviving record on disk instead, so a park that outlived its emptied or
    // closed log queues and matches the card's tally rather than the counter reading a
    // park the queue then can't show (#232). Tagged with the repo for the cross-repo list.
    const queueParked = card.runState === "parked" && !status.parked.length ? parkedRecords.map(toParkedIssue) : status.parked;
    for (const p of queueParked) {
      parked.push({ issueNumber: p.issueNumber, project: status.project, question: p.description, parkedAt: p.parkedAt });
    }
    projects.push(card);
  }
  // Oldest first — the question that has waited longest surfaces at the top.
  parked.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
  const sum = (pick: (card: ProjectCard) => number) => projects.reduce((total, card) => total + pick(card), 0);
  return {
    counters: {
      working: sum((c) => c.tally.running),
      // The parked counter *is* the length of the cross-repo parked queue it expands into
      // (#259): both derive from the one `parked` array, so the number and the list can never
      // disagree by construction — a conflict/red-base hold shows as an amber chip with its
      // own recovery affordance, not as a phantom row the counter would over-count (ADR 0019).
      parked: parked.length,
      queued: sum((c) => c.tally.queued),
      mergedToday,
    },
    projects,
    parked,
  };
}
