import type { GateSpec, ResolvedConfig } from "./config.ts";
import type { Sandbox } from "./sandbox.ts";
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
/**
 * Which gates run against a change. A gate with no `when` always runs; a
 * `when`-scoped gate runs iff a changed file matches its pattern. `all` forces
 * every gate regardless of the diff. Pure — the selection decision lifted out
 * of `runGates` so it has a direct test surface (issue #240).
 */
export function selectGates(
  gates: GateSpec[],
  changedFiles: string,
  opts: { all?: boolean } = {},
): GateSpec[] {
  if (opts.all) return gates;
  return gates.filter((g) => !g.when || g.when.test(changedFiles));
}

export async function runGates(
  cfg: ResolvedConfig,
  sbx: Sandbox,
  opts: { all?: boolean; taskId?: string } = {},
): Promise<{ green: boolean; report: string }> {
  const { taskId } = opts;
  let files = "";
  if (!opts.all) {
    const changed = await sbx.exec(`git diff --name-only ${cfg.baseBranch}...HEAD`);
    files = changed.stdout ?? "";
  }
  const selected = selectGates(cfg.gates, files, { all: opts.all });
  const gateFields = { ...(taskId ? { taskId } : {}), cmds: selected.map((g) => g.label ?? g.cmd), skipped: cfg.gates.length - selected.length };
  cfg.log.log("gate", gateFields);
  // Mirror the gate into the per-task activity stream so the live-tail pane tails one merged
  // record (ADR 0015). The wave-merge gate has no single task and skips this.
  if (taskId) appendActivity(cfg.stateDir, taskId, event("gate", gateFields));

  for (const g of selected) {
    // Announce the check as it starts (before it runs), so the live tail's newest row names the
    // command in flight rather than sitting on the gate-start summary for the check's whole duration
    // (#332). Live-only, per-task: the wave-merge gate has no `taskId` and skips it, as above.
    if (taskId) appendActivity(cfg.stateDir, taskId, event("gate-check", { taskId, cmd: g.cmd }));
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
