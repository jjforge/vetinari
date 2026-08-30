import { execFileSync, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { buildStatus, type CampaignStatus, type IssueStatus } from "./status.ts";
import { reasonWord } from "./dashboard-visual-state.ts";
import { composeStatusLine } from "./statusline-install.ts";

const COUNT_EMOJI: Array<[IssueStatus, string]> = [
  ["completed", "✅"],
  ["running", "🔄"],
  ["parked", "⏸"],
  ["failure", "❌"],
  ["unstarted", "⚪"],
];

/**
 * Drop a trailing context-window parenthetical from a model name — Claude Code
 * reports the 1M-window model as "Opus 4.8 (1M context)", which is noise in a
 * compact bar. Only context parentheticals go; anything else is left intact.
 */
export function trimModelName(name: string | undefined): string | undefined {
  return name?.replace(/\s*\([^)]*context[^)]*\)\s*$/i, "").trim();
}

/**
 * Line 1 — a compact version of Claude Code's own default status line: model
 * (already trimmed), directory, git branch, context-used percent. Each part is
 * dropped when absent, so the line degrades gracefully. Pure.
 */
export function formatContextLine(parts: { model?: string; dir?: string; branch?: string; contextPct?: number }): string {
  const segs: string[] = [];
  if (parts.model) segs.push(parts.model);
  if (parts.dir) segs.push(parts.dir);
  if (parts.branch) segs.push(parts.branch);
  if (typeof parts.contextPct === "number") segs.push(`${Math.round(parts.contextPct)}%`);
  return segs.join(" · ");
}

/**
 * Line 2 — the Vetinari run: the wave in flight and a count per status across
 * the whole campaign. The 🏰 marks it; the project name is omitted because line
 * 1 already shows the directory, which is always this one. Zero counts are
 * dropped so the line stays short. Pure and newline-free by contract.
 */
export function formatStatusLine(status: CampaignStatus): string {
  const issues = status.waves.flatMap((wave) => wave.issues);
  if (!issues.length) return "🏰 idle";

  // Count each chip by its lifecycle directly (ADR 0019): the two-axis split means the
  // status is already a clean bucket (a grafted chip reads `unstarted` → ⚪, a conflict/
  // stalled hold reads `parked` → ⏸); only a `pruned` member, which left the plan, counts
  // nowhere.
  const counts = new Map<IssueStatus, number>();
  for (const issue of issues) {
    if (issue.membership === "pruned") continue;
    counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  }

  const parts: string[] = [];
  const running = status.waves.find((wave) => wave.status === "running");
  if (running) parts.push(`wave ${running.index + 1}/${status.waves.length}`);

  const segs = COUNT_EMOJI.filter(([status]) => counts.get(status)).map(([status, emoji]) => `${emoji}${counts.get(status)}`);
  if (segs.length) parts.push(segs.join(" "));

  // Name why work is parked, in the settled reason vocabulary (design §2.3): each held
  // member's own reason plus any wave-level `red-base` hold, deduped and mapped through the
  // single `reasonWord` so the bar spells a reason exactly as the dashboard does.
  const reasons = new Set<string>();
  for (const wave of status.waves) {
    if (wave.reason) reasons.add(reasonWord(wave.reason));
    for (const issue of wave.issues) {
      if (issue.membership === "pruned") continue;
      if (issue.status === "parked" && issue.reason) reasons.add(reasonWord(issue.reason));
    }
  }
  if (reasons.size) parts.push([...reasons].join(", "));

  return parts.length ? `🏰 ${parts.join(" · ")}` : "🏰 idle";
}

/** Read Claude Code's raw JSON blob from stdin once — `""` on a TTY or read error. */
async function readStdinRaw(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

/** Parse the raw stdin blob into Claude Code's status object — `{}` on anything odd. */
function parseStdinJson(raw: string): any {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * Run a wrapped base status-line command, feeding it the same stdin blob Claude
 * Code gave us, and return its stdout. Best effort: a spawn failure yields `""` so
 * `composeStatusLine` falls back to vetinari's own line 1. The command runs through
 * a shell because that is exactly how Claude Code runs a `statusLine.command`.
 */
function runBaseCommand(command: string, stdin: string): string {
  try {
    const r = spawnSync("sh", ["-c", command], { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return r.stdout ?? "";
  } catch {
    return "";
  }
}

/** Current branch of `dir`, or undefined (detached HEAD, not a repo, git error). */
function gitBranch(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `statusline` command: two lines for the Claude Code status bar — line 1
 * mirrors Claude Code's default (model, dir, branch, context%) with the model
 * name trimmed; line 2 is the Vetinari run, shown only where a config lives.
 * Claude Code blanks the status line on a non-zero exit, so this never throws:
 * every field is optional and any failure just narrows what prints. Line 2 uses
 * the synchronous log-derived status — no network — so it stays fast on every
 * refresh.
 */
export async function runStatusLine(cfgPath?: string, opts: { baseCommand?: string } = {}): Promise<void> {
  const raw = await readStdinRaw();
  const input = parseStdinJson(raw);
  const dir: unknown = input?.workspace?.current_dir ?? input?.cwd;
  if (typeof dir === "string" && dir && dir !== process.cwd()) {
    try {
      process.chdir(dir);
    } catch {
      // stay in the current directory if the reported one is unreachable
    }
  }

  const line1 = formatContextLine({
    model: trimModelName(input?.model?.display_name),
    dir: typeof dir === "string" ? basename(dir) : undefined,
    branch: gitBranch(typeof dir === "string" ? dir : "."),
    contextPct: typeof input?.context_window?.used_percentage === "number" ? input.context_window.used_percentage : undefined,
  });

  let line2 = "";
  try {
    const cfg = await loadConfig(cfgPath);
    line2 = formatStatusLine(buildStatus(cfg));
  } catch {
    // No Vetinari config here: line 1 alone still describes the session.
  }

  // A wrapped base status line (a user's own, preserved on install) becomes line
  // 1; ours stands in only when it produced nothing. The 🏰 campaign line goes
  // under whichever won.
  const baseOutput = opts.baseCommand ? runBaseCommand(opts.baseCommand, raw) : undefined;
  const out = composeStatusLine(baseOutput, line1, line2);
  if (out) process.stdout.write(out + "\n");
}
