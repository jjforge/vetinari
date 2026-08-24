import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { buildStatus, type CampaignStatus, type DisplayStatus, type IssueStatus } from "./status.ts";

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

  const counts = new Map<DisplayStatus, number>();
  for (const issue of issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);

  const parts: string[] = [];
  const running = status.waves.find((wave) => wave.status === "running");
  if (running) parts.push(`wave ${running.index + 1}/${status.waves.length}`);

  const segs = COUNT_EMOJI.filter(([status]) => counts.get(status)).map(([status, emoji]) => `${emoji}${counts.get(status)}`);
  if (segs.length) parts.push(segs.join(" "));

  return parts.length ? `🏰 ${parts.join(" · ")}` : "🏰 idle";
}

/** Read Claude Code's status JSON from stdin — best effort, `{}` on anything odd. */
async function readStdinJson(): Promise<any> {
  if (process.stdin.isTTY) return {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
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
export async function runStatusLine(cfgPath?: string): Promise<void> {
  const input = await readStdinJson();
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

  const out = [line1, line2].filter(Boolean).join("\n");
  if (out) process.stdout.write(out + "\n");
}
