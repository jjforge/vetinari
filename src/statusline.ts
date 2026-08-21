import { loadConfig } from "./config.ts";
import { buildStatus, type CampaignStatus, type IssueStatus } from "./status.ts";

const COUNT_EMOJI: Array<[IssueStatus, string]> = [
  ["completed", "✅"],
  ["running", "🔄"],
  ["parked", "⏸"],
  ["failure", "❌"],
  ["unstarted", "⚪"],
];

/**
 * A single, compact line for the Claude Code status bar: the project, the wave
 * in flight, and a count per status across the whole campaign. Zero counts are
 * dropped so the line stays short. Pure and newline-free by contract — the
 * status bar shows one line.
 */
export function formatStatusLine(status: CampaignStatus): string {
  const issues = status.waves.flatMap((wave) => wave.issues);
  if (!issues.length) return `🏰 ${status.project} · idle`;

  const counts = new Map<IssueStatus, number>();
  for (const issue of issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);

  const parts = [`🏰 ${status.project}`];
  const running = status.waves.find((wave) => wave.status === "running");
  if (running) parts.push(`wave ${running.index + 1}/${status.waves.length}`);

  const segs = COUNT_EMOJI.filter(([status]) => counts.get(status)).map(([status, emoji]) => `${emoji}${counts.get(status)}`);
  if (segs.length) parts.push(segs.join(" "));

  return parts.join(" · ");
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

/**
 * The `statusline` command: emit one compact sandcastle line for the Claude Code
 * status bar. Claude Code blanks the status line on a non-zero exit, so this
 * never throws — no config in this directory (or any other failure) just prints
 * nothing, leaving a clean line. Uses the synchronous log-derived status only:
 * no network, no issue-name fetch, so it stays fast enough to run on every
 * refresh.
 */
export async function runStatusLine(cfgPath?: string): Promise<void> {
  try {
    const input = await readStdinJson();
    const dir = input?.workspace?.current_dir ?? input?.cwd;
    if (typeof dir === "string" && dir && dir !== process.cwd()) {
      try {
        process.chdir(dir);
      } catch {
        // stay in the current directory if the reported one is unreachable
      }
    }
    const cfg = await loadConfig(cfgPath);
    process.stdout.write(formatStatusLine(buildStatus(cfg)) + "\n");
  } catch {
    // No sandcastle config here, or a transient read error: show nothing.
  }
}
