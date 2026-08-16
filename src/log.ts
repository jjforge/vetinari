import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let logFile = ".sandcastle/logs/orchestrator.jsonl";

export function setLogFile(path: string) {
  logFile = path;
  mkdirSync(dirname(logFile), { recursive: true });
}

/** Append-only event log. Shared across parallel runs; one line per event. */
export function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  console.log(`[sctdd] ${event}`, data);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line + "\n");
  }
}

/** Persist a gate's full output; the event log carries only the path. */
export function writeGateLog(stateDir: string, cmd: string, res: { stdout?: string; stderr?: string; exitCode: number }) {
  const outFile = `${stateDir}/logs/gate-${Date.now()}.log`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `$ ${cmd}\n--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}\n--- exit: ${res.exitCode} ---\n`);
  return outFile;
}

export const tail = (s: string, lines: number) => s.split("\n").slice(-lines).join("\n");
