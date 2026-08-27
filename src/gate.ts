import type { ResolvedConfig } from "./config.ts";
import { tail, writeGateLog } from "./log.ts";
import { appendActivity } from "./activity.ts";
import { event } from "./event-log.ts";

/**
 * The verification the ORCHESTRATOR owns.
 *
 * An agent's COMPLETE signal is a claim, not evidence — it can be emitted over
 * a red suite. Only a zero exit here is green, which is the whole point of
 * driving iterations from the host instead of trusting self-assessment.
 *
 * Note the sandbox API returns a non-zero exit code rather than throwing, so
 * every gate must check `exitCode` explicitly or a red suite reads as a pass.
 */
export async function runGates(
  cfg: ResolvedConfig,
  sbx: any,
  opts: { all?: boolean; taskId?: string } = {},
): Promise<{ green: boolean; report: string }> {
  const { taskId } = opts;
  let selected = cfg.gates;
  if (!opts.all) {
    const changed = await sbx.exec(`git diff --name-only ${cfg.baseBranch}...HEAD`);
    const files = changed.stdout ?? "";
    selected = cfg.gates.filter((g) => !g.when || g.when.test(files));
  }
  const gateFields = { ...(taskId ? { taskId } : {}), cmds: selected.map((g) => g.label ?? g.cmd), skipped: cfg.gates.length - selected.length };
  cfg.log.log("gate", gateFields);
  // Mirror the gate into the per-task activity stream so the live-tail pane tails one merged
  // record (ADR 0015). The wave-merge gate has no single task and skips this.
  if (taskId) appendActivity(cfg.stateDir, taskId, event("gate", gateFields));

  for (const g of selected) {
    const t0 = Date.now();
    const res = await sbx.exec(g.cmd);
    const outFile = writeGateLog(cfg.stateDir, g.cmd, res);
    const resultFields = { ...(taskId ? { taskId } : {}), cmd: g.cmd, exitCode: res.exitCode, seconds: Math.round((Date.now() - t0) / 1000), outFile };
    cfg.log.log("gate-result", resultFields);
    if (taskId) appendActivity(cfg.stateDir, taskId, event("gate-result", resultFields));
    if (res.exitCode !== 0) {
      return { green: false, report: `$ ${g.cmd}\n${tail(res.stdout ?? "", 200)}\n${tail(res.stderr ?? "", 100)}` };
    }
  }
  return { green: true, report: "" };
}
