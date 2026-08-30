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

/** How the terminal renders one issue: `#<id>`, plus the resolved title when the run has one. */
export function issueLabel(id: string, titles: Record<string, string>): string {
  const title = titles[id];
  return title ? `#${id} ${title}` : `#${id}`;
}

/** A comma-joined run of issue labels — the shared body of the plan/wave lines. */
const issueList = (ids: string[], titles: Record<string, string>): string =>
  ids.map((id) => issueLabel(id, titles)).join(", ");

/** `N wave` / `N waves`, and the "M wave(s) not started" tail a stop reports. */
const waves = (n: number): string => `${n} ${n === 1 ? "wave" : "waves"}`;

/** The optional ` “<name>”` segment a header carries when the campaign was named. */
const named = (name?: string): string => (name ? ` “${name}”` : "");

/** The plan: the waves with their ids and titles, headed by the campaign name when set. */
export function formatPlan(
  batches: string[][],
  titles: Record<string, string>,
  name?: string,
): string {
  const header = `plan${named(name)} · ${waves(batches.length)}`;
  const rows = batches.map(
    (wave, i) => `  wave ${i + 1} — ${issueList(wave, titles)}`,
  );
  return [header, ...rows].join("\n");
}

/** A wave started: its position and the issues it drains. */
export function formatWaveStart(
  index: number,
  total: number,
  tasks: string[],
  titles: Record<string, string>,
): string {
  return `▶ wave ${index + 1}/${total} — ${issueList(tasks, titles)}`;
}

/** Map a queue outcome to the terminal word: an `error(n)` is a `failed`, else itself. */
const outcomeWord = (outcome: string | undefined): string =>
  outcome?.startsWith("error") ? "failed" : (outcome ?? "?");

/** A wave closed: what merged, plus any held or conflict-quarantined issues. */
export function formatWaveDone(
  index: number,
  total: number,
  d: {
    merged: string[];
    held: string[];
    quarantined: string[];
    outcomes: Record<string, string>;
  },
): string {
  let line = `✔ wave ${index + 1}/${total} merged ${d.merged.map((id) => `#${id}`).join(", ") || "nothing"}`;
  if (d.held.length)
    line += ` · held ${d.held.map((id) => `#${id} (${outcomeWord(d.outcomes[id])})`).join(", ")}`;
  if (d.quarantined.length)
    line += ` · parked on conflict (kept) ${d.quarantined.map((id) => `#${id}`).join(", ")}`;
  return line;
}

/** The per-issue outcome, one indented line each, `error(n)` mapped to the `failed` vocabulary. */
export function formatOutcomes(
  taskIds: string[],
  outcomes: Record<string, string>,
): string {
  return taskIds.map((id) => `  #${id} ${outcomeWord(outcomes[id])}`).join("\n");
}

/** The whole campaign finished cleanly: the wave count and the base it landed on. */
export function formatComplete(
  batches: number,
  baseBranch: string,
  name?: string,
): string {
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
 * command (`redrive`, `answer <id>`, `prune <id>`) the user-guide promises.
 */
export type Stop =
  | { kind: "failed"; index: number; total: number; failed: string[]; merged: string[] }
  | { kind: "issue-parked"; index: number; total: number; parked: string[]; merged: string[] }
  | { kind: "red-base"; index: number; total: number; merged: string[] }
  | { kind: "quarantine-stranded"; index: number; total: number; stranded: string[]; merged: string[] };

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
    case "red-base": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — merged base is red (red-base); ${tail}\n` +
        "recover: fix forward on the base, then `vetinari redrive` — or `vetinari prune <id>`"
      );
    }
    case "quarantine-stranded": {
      const tail = keptTail(stop.merged, stop.index, stop.total);
      return (
        `🅿 campaign parked at ${pos} — conflict stranded ${stop.stranded.map((id) => `#${id}`).join(", ")} in a later wave; ${tail}\n` +
        "recover: resolve the conflict then `vetinari redrive`, or `vetinari redrive --auto-prune`"
      );
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
