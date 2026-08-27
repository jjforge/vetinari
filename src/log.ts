import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { OrchestratorEvent } from "./event-log.ts";

/**
 * The log target before an entrypoint sets a real one — an isolated per-process
 * temp file, NEVER a real project path. A relative `.vetinari.local/…` default was
 * a footgun: any `log()` before `setLogFile` — every test that emits an event
 * (e.g. `park()`) without redirecting first — appended to the real
 * `.vetinari.local/logs/orchestrator.jsonl` of whatever cwd it ran in, polluting a
 * developer's live dashboard with fixture events (#154). Production entrypoints
 * (cli.mts) still call `setLogFile(cfg.logFile)` explicitly to point at the real log.
 */
export const defaultLogFile = (): string =>
  join(tmpdir(), `vetinari-unset-${process.pid}`, "orchestrator.jsonl");

let logFile = defaultLogFile();

export function setLogFile(path: string) {
  logFile = path;
  mkdirSync(dirname(logFile), { recursive: true });
}

/** The current log target — for tests and introspection. */
export const logFilePath = (): string => logFile;

/** The narrowed kinds the dashboard reads back (`event-log.ts`); their emit sites are typed. */
type NarrowedKind = OrchestratorEvent["event"];
/** A narrowed kind's payload: its member's fields minus the `ts`/`event` `log()` stamps itself. */
type Fields<K extends NarrowedKind> = Omit<Extract<OrchestratorEvent, { event: K }>, "ts" | "event">;

/**
 * Append-only event log. Shared across parallel runs; one line per event.
 *
 * A narrowed kind (the ones `dashboard-model.ts` reconstructs) must be emitted with the exact
 * field shape `event-log.ts` declares — the single source of truth, imported here type-only so
 * an emit site can't drift from what the reader expects. Every other (peripheral) event stays
 * one-line cheap through the untyped catch-all; its `event` string is negated out of the typed
 * overload so a narrowed kind with a wrong payload fails to compile instead of falling through.
 */
export function log<K extends NarrowedKind>(event: K, data: Fields<K>): void;
export function log<E extends string>(event: E extends NarrowedKind ? never : E, data?: Record<string, unknown>): void;
export function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...data, event });
  console.log(`[vetinari] ${event}`, data);
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
