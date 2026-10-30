/**
 * The CLI's own terminal view (design §11, user-guide "Where you see things — Terminal"):
 * the human-readable lines a `campaign`/`run`/`redrive` prints — the plan, per-wave
 * progress, per-issue outcome, the one-line stop reason, and the exact recovery command.
 * The event log is JSONL for the file (and `--json`); it is never the default screen output,
 * so `modes.ts` and `cli-dispatch.ts` print through here instead of echoing events.
 *
 * The formatters are pure `format*` functions over the wave/outcome data the campaign loop
 * already holds, so the wording is unit-testable without running a campaign. They speak the
 * one vocabulary (CONTEXT.md): waves (never batches), parked/failed/merged, and the recovery
 * verbs `redrive`/`answer`/`prune` — never the retired `campaign --resume`.
 */
import type { OrchestratorEvent } from "./event-log.ts";
import type { SlowGates } from "./slow-gates.ts";

/** How the terminal renders one issue: `#<id>`, plus the resolved title when the run has one. */
export function issueLabel(id: string, titles: Record<string, string>): string {
  const title = titles[id];
  return title ? `#${id} ${title}` : `#${id}`;
}

/** A comma-joined run of issue labels — the shared body of the plan/wave lines. */
const issueList = (ids: string[], titles: Record<string, string>): string => ids.map((id) => issueLabel(id, titles)).join(", ");

/** `N wave` / `N waves`, and the "M wave(s) not started" tail a stop reports. */
const waves = (n: number): string => `${n} ${n === 1 ? "wave" : "waves"}`;

/** The optional ` “<name>”` segment a header carries when the campaign was named. */
const named = (name?: string): string => (name ? ` “${name}”` : "");

/** The plan: the waves with their ids and titles, headed by the campaign name when set. */
export function formatPlan(batches: string[][], titles: Record<string, string>, name?: string): string {
  const header = `plan${named(name)} · ${waves(batches.length)}`;
  const rows = batches.map((wave, i) => `  wave ${i + 1} — ${issueList(wave, titles)}`);
  return [header, ...rows].join("\n");
}

/** A wave started: its position and the issues it drains. */
export function formatWaveStart(index: number, total: number, tasks: string[], titles: Record<string, string>): string {
  return `▶ wave ${index + 1}/${total} — ${issueList(tasks, titles)}`;
}

/** Map a queue outcome to the terminal word: an `error(n)` is a `failed`, else itself. */
const outcomeWord = (outcome: string | undefined): string => (outcome?.startsWith("error") ? "failed" : (outcome ?? "?"));

/** A wave closed: what merged. A wave-done fires only when every member merged (design §2.1),
 * so there is no held or conflict-parked member to annotate — the `merged` list is the wave. */
export function formatWaveDone(index: number, total: number, d: { merged: string[] }): string {
  return `✔ wave ${index + 1}/${total} merged ${d.merged.map((id) => `#${id}`).join(", ") || "nothing"}`;
}

/**
 * Where one wave's time went, in seconds (#615): its whole `wave-start` → `wave-done` time, and the
 * phases inside it. A phase is `undefined` when its boundary events are not all in the wave's log —
 * a member re-admitted or banked by a redrive, a wave that merged nothing new so gated no base — and
 * is never guessed. Information only: nothing a campaign decides reads it.
 */
export interface WaveTimeSplit {
  total: number;
  /** the slowest member's `spawn` → `green`, less its own branch-gate time. */
  agent?: number;
  /** that same member's branch-gate time — the sum of its `gate-result` seconds. */
  branchGates?: number;
  /** the wave's last `green` → its `base-gate`. */
  integration?: number;
  /** the `base-gate` → the `wave-done`: the changelog collect and the label advance. */
  postMerge?: number;
}

const tsSeconds = (e: OrchestratorEvent): number => Date.parse(e.ts) / 1000;

/**
 * Split one wave's time from its events — the log from its `wave-start` through its `wave-done`.
 * The agent and branch-gate phases need every member to have run exactly once in the wave (one
 * `spawn`, one `green`), else which member was slowest is unknown; integration needs every member's
 * `green` too, so the last one is the wave's.
 */
export function waveTimeSplit(events: OrchestratorEvent[]): WaveTimeSplit {
  const start = events.find((e) => e.event === "wave-start") ?? events[0];
  const done = events.findLast((e) => e.event === "wave-done") ?? events.at(-1);
  const split: WaveTimeSplit = { total: start && done ? tsSeconds(done) - tsSeconds(start) : 0 };
  const tasks = start?.event === "wave-start" ? start.tasks : [];
  const only = (event: string, taskId: string) => events.filter((e) => e.event === event && "taskId" in e && e.taskId === taskId);
  const runs = tasks.map((taskId) => ({ taskId, spawns: only("spawn", taskId), greens: only("green", taskId) }));
  const greens = runs.map((r) => r.greens.at(-1));
  if (tasks.length && runs.every((r) => r.spawns.length === 1 && r.greens.length === 1)) {
    const slowest = runs
      .map((r) => ({
        span: tsSeconds(r.greens[0]) - tsSeconds(r.spawns[0]),
        gates: events.reduce((sum, e) => sum + (e.event === "gate-result" && e.taskId === r.taskId ? e.seconds : 0), 0),
      }))
      .reduce((a, b) => (b.span > a.span ? b : a));
    split.agent = slowest.span - slowest.gates;
    split.branchGates = slowest.gates;
  }
  const baseGate = events.findLast((e) => e.event === "base-gate");
  if (baseGate && tasks.length && greens.every((g) => g !== undefined)) {
    // A base gate logged before the last green gated an earlier pass, not this one.
    const integration = tsSeconds(baseGate) - Math.max(...greens.map((g) => tsSeconds(g!)));
    if (integration >= 0) split.integration = integration;
  }
  if (baseGate && done?.event === "wave-done") split.postMerge = tsSeconds(done) - tsSeconds(baseGate);
  return split;
}

/** The rows that open a merged-base gate's measuring window: a taskId-less `gate-result` counts only
 * after the latest of these and before the `base-gate` that closes it. */
const BASE_GATE_WINDOW_OPENERS = new Set(["merged", "base-gate", "wave-start", "campaign-start"]);

/**
 * Each merged-base gate's duration in seconds, in log order (#615): one per `base-gate`, the sum of
 * the taskId-less `gate-result` seconds logged after the wave's last `merged` (or, for a re-gate that
 * merged nothing, its `wave-start`) and before the `base-gate`. A member's branch gate carries a
 * `taskId`, and a taskId-less result no `base-gate` closes (a `vetinari baseline` run) is never counted.
 */
export function mergedBaseGateSeconds(events: OrchestratorEvent[]): number[] {
  const out: number[] = [];
  let pending = 0;
  for (const e of events) {
    if (e.event === "base-gate") out.push(pending);
    if (BASE_GATE_WINDOW_OPENERS.has(e.event)) pending = 0;
    else if (e.event === "gate-result" && e.taskId === undefined) pending += e.seconds;
  }
  return out;
}

/** The current campaign's merged-base gates — how many, and their total seconds — read from its
 * latest `campaign-start` on. */
export function campaignBaseGates(events: OrchestratorEvent[]): { count: number; seconds: number } {
  const start = events.findLastIndex((e) => e.event === "campaign-start");
  const durations = mergedBaseGateSeconds(events.slice(Math.max(start, 0)));
  return { count: durations.length, seconds: durations.reduce((a, b) => a + b, 0) };
}

/** A duration in seconds as `1h2m5s` / `8m24s` / `1s`, rounded to the second. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${m}m${s % 60}s`;
  return m ? `${m}m${s % 60}s` : `${s}s`;
}

/** A wave's time split as the terminal prints it, `—` for a phase that could not be derived. The
 * `wave i/n:` prefix is the caller's, so the dashboard can reuse the phase text. */
export function formatWaveTimeSplit(split: WaveTimeSplit): string {
  const phase = (label: string, seconds?: number) => `${label} ${seconds === undefined ? "—" : formatDuration(seconds)}`;
  return (
    `${formatDuration(split.total)} — ` +
    [
      phase("agent", split.agent),
      phase("branch gates", split.branchGates),
      phase("integration + base gate", split.integration),
      phase("post-merge", split.postMerge),
    ].join(" · ")
  );
}

/** The line a campaign's end prints: its merged-base gates' total time and how many there were. */
export function formatCampaignBaseGates(total: { count: number; seconds: number }): string {
  const gates = `${total.count} merged-base ${total.count === 1 ? "gate" : "gates"}`;
  return `⏱ base gates: ${formatDuration(total.seconds)} over ${gates} this campaign`;
}

/** A rough total — whole minutes (`16m`, `1h5m`) once it reaches a minute, else seconds. */
const approxDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
};

/**
 * The line `campaign --dry-run` prints after the plan (#615): the base-gate time it will spend — its
 * wave count times the median past merged-base gate — and how that was estimated. With no past
 * merged-base gate (`past` undefined) it says so rather than printing a number.
 */
export function formatBaseGateEstimate(waveCount: number, past: { median: number; runs: number } | undefined): string {
  if (!past) return "base gates: no estimate — no merged-base gate in this project's history yet";
  const sample = `median of ${past.runs} past base ${past.runs === 1 ? "gate" : "gates"}`;
  return `base gates: ~${waveCount} × ${formatDuration(past.median)} (${sample}) ≈ ${approxDuration(waveCount * past.median)}`;
}

/**
 * The slow-gate lines a wave settle prints (CONTEXT.md → Slow gate), one per flag, empty when no gate
 * is slow. A history flag names both medians and the runs behind each; a budget overrun names the
 * budget and how many of the wave's runs went over it. Information only — printed beside the wave's
 * own settle line, never in place of it.
 */
export function formatSlowGates(slow: SlowGates): string[] {
  return [
    ...slow.history.map(
      (h) =>
        `🐢 slow gate \`${h.cmd}\` — median ${Math.round(h.currentMedian)}s over ${h.currentRuns} runs this campaign, ` +
        `up from ${Math.round(h.earlierMedian)}s over ${h.earlierRuns} earlier runs`,
    ),
    ...slow.budget.map(
      (b) =>
        `🐢 slow gate \`${b.cmd}\` — ${b.over} of ${b.runs} ${b.runs === 1 ? "run" : "runs"} this wave went over its ${b.budgetSeconds}s budget`,
    ),
  ];
}

/** The per-issue outcome, one indented line each, `error(n)` mapped to the `failed` vocabulary. */
export function formatOutcomes(taskIds: string[], outcomes: Record<string, string>): string {
  return taskIds.map((id) => `  #${id} ${outcomeWord(outcomes[id])}`).join("\n");
}

/** The whole campaign finished cleanly: the wave count and the base it landed on. */
export function formatComplete(batches: number, baseBranch: string, name?: string): string {
  return `🏆 campaign${named(name)} complete · ${waves(batches)} onto ${baseBranch}`;
}

/** A redrive re-entering an unfinished campaign at `index`. */
export function formatResume(index: number, total: number): string {
  return `↩ redrive · continuing from wave ${index + 1}/${total}`;
}

/** A redrive with nothing left to run — every wave already merged. */
export function formatResumeNothing(total: number): string {
  return `↩ redrive · nothing to run — all ${total} waves already merged`;
}

/** The kept-greens + waves-left tail every stop reason shares. */
const keptTail = (merged: string[], index: number, total: number): string => {
  const kept = `merged ${merged.map((id) => `#${id}`).join(", ") || "nothing"} kept`;
  const left = total - index - 1;
  return left > 0 ? `${kept}, ${waves(left)} not started` : kept;
};

/**
 * A campaign stop — the one situation the loop pauses or stops on — plus the wave it happened
 * in and the greens already merged. Each maps to a one-line reason and the exact recovery
 * command (`redrive`, `answer <id>`, `prune <id>`) the user-guide promises. `stopped` is an operator
 * stop (`vetinari stop`, Ctrl-C), resumed by a plain `redrive`; `member-stopped` is a wave held by a
 * member whose run was signalled outside an operator stop — redrive-only, never answerable.
 * `outdated-agent` is a wave held by members whose agent CLI is too old for the model (#444):
 * rebuild the image, then redrive.
 */
export type Stop =
  | { kind: "failed"; index: number; total: number; failed: string[]; merged: string[] }
  | { kind: "issue-parked"; index: number; total: number; parked: string[]; merged: string[] }
  | { kind: "member-stopped"; index: number; total: number; parked: string[]; merged: string[] }
  | { kind: "outdated-agent"; index: number; total: number; parked: string[]; merged: string[] }
  | { kind: "red-base"; index: number; total: number; merged: string[] }
  | { kind: "conflict"; index: number; total: number; conflicted: string[]; merged: string[] }
  | { kind: "stranded-conflict"; index: number; total: number; stranded: string[]; merged: string[] }
  | { kind: "stopped"; index: number; total: number; merged: string[] };

/** The one-line stop reason and, on the next line, the exact command that resumes it. */
export function formatStop(stop: Stop): string {
  const pos = `wave ${stop.index + 1}/${stop.total}`;
  switch (stop.kind) {
    case "failed": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `✖ campaign failed at ${pos} — ${stop.failed.map((id) => `#${id}`).join(", ")} failed; ${tail}\n` +
        `recover: fix it forward or \`vetinari prune ${stop.failed[0]}\`, then \`vetinari redrive\``
      );
    }
    case "issue-parked": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      const id = stop.parked[0];
      return (
        `🅿 campaign parked at ${pos} — ${stop.parked.map((p) => `#${p}`).join(", ")} awaiting a human; ${tail}\n` +
        `recover: \`vetinari answer ${id} "…"\` (or resolve) or \`vetinari prune ${id}\`, then \`vetinari redrive\``
      );
    }
    case "member-stopped": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — ${stop.parked.map((p) => `#${p}`).join(", ")} stopped mid-run (stopped); ${tail}\n` +
        `recover: \`vetinari redrive\` (or \`vetinari prune ${stop.parked[0]}\`)`
      );
    }
    case "outdated-agent": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — ${stop.parked.map((p) => `#${p}`).join(", ")}: the image's agent CLI is too old for the model (outdated-agent); ${tail}\n` +
        "recover: `vetinari build`, then `vetinari redrive`"
      );
    }
    case "red-base": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — merged base is red (red-base); ${tail}\n` +
        "recover: fix forward on the base, then `vetinari redrive` — or `vetinari prune <id>`"
      );
    }
    case "conflict": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      const id = stop.conflicted[0];
      return (
        `🅿 campaign parked at ${pos} — merge conflict on ${stop.conflicted.map((c) => `#${c}`).join(", ")} (conflict); ${tail}\n` +
        `recover: resolve the conflict on the branch then \`vetinari redrive\` (or \`vetinari prune ${id}\`)`
      );
    }
    case "stranded-conflict": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — conflict stranded ${stop.stranded.map((id) => `#${id}`).join(", ")} in a later wave; ${tail}\n` +
        "recover: resolve the conflict then `vetinari redrive`, or `vetinari redrive --auto-prune`"
      );
    }
    case "stopped": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return `🅿 campaign parked at ${pos} — stopped; ${tail}\nrecover: \`vetinari redrive\``;
    }
  }
}

/**
 * The terminal sink for the human lines above. `line` prints through `out` (defaulting to
 * `console.log`) — except under `--json`, where the screen is the raw event stream alone
 * (`log.ts` echoes JSONL there) and every human line is suppressed so tooling reads clean JSON.
 */
export interface Reporter {
  readonly json: boolean;
  line(text: string): void;
}

export function makeReporter(opts: { json: boolean; out?: (s: string) => void }): Reporter {
  const out = opts.out ?? ((s: string) => console.log(s));
  return {
    json: opts.json,
    line: (text: string) => {
      if (!opts.json) out(text);
    },
  };
}
