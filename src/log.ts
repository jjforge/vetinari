import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gatewayConfigDir } from "./registry.ts";
import type { OrchestratorEvent } from "./event-log.ts";
import type { ResolvedConfig } from "./config.ts";

/** The narrowed kinds the dashboard reads back (`event-log.ts`); their emit sites are typed. */
type NarrowedKind = OrchestratorEvent["event"];
/** A narrowed kind's payload: its member's fields minus the `ts`/`event` the logger stamps itself. */
type Fields<K extends NarrowedKind> = Omit<Extract<OrchestratorEvent, { event: K }>, "ts" | "event">;

/**
 * A logger value — the sole way to emit an event, constructed with an explicit target. It carries
 * a narrowed-kind typed overload (a narrowed kind must be emitted with its `event-log.ts` field
 * shape; every other kind stays one-line cheap through the untyped catch-all), so a caller
 * threading a `Logger` through gets a compile-time guarantee its emit sites match the reader. Where
 * a row goes — a file plus a console echo, or an in-memory array — is the adapter's choice, not the
 * interface's.
 */
export interface Logger {
  log<K extends NarrowedKind>(event: K, data: Fields<K>): void;
  log<E extends string>(event: E extends NarrowedKind ? never : E, data?: Record<string, unknown>): void;
}

/** The stamped row the adapters persist: `ts` first, the caller's data, then the
 * authoritative `event` last so a stray `data.event` can't override the kind. */
const stampRow = (event: string, data: Record<string, unknown>) => ({ ts: new Date().toISOString(), ...data, event });

/** An adapter that appends stamped JSONL to `path` and echoes to the console — the shared backend
 * of `loggerForRun` and `hostLogger`. */
function fileLogger(path: string): Logger {
  const write = (event: string, data: Record<string, unknown> = {}): void => {
    const line = JSON.stringify(stampRow(event, data));
    console.log(`[vetinari] ${event}`, data);
    try {
      appendFileSync(path, line + "\n");
    } catch {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line + "\n");
    }
  };
  return { log: write } as Logger;
}

/** A run's logger: the on-disk event log at `cfg.logFile`, with the console echo. */
export const loggerForRun = (cfg: Pick<ResolvedConfig, "logFile">): Logger => fileLogger(cfg.logFile);

/**
 * The host's own log target — a *persistent* host log under the gateway config dir,
 * `<gatewayConfigDir()>/logs/host.jsonl`, mirroring a project's `logs/orchestrator.jsonl`. The
 * host modes (`gateway`, `status`) span every project and have no per-run `cfg.logFile`, and the
 * `status` daemon parks forever — so its diagnostics need a single rolling log that survives
 * restarts, not the ephemeral per-pid temp path this used to fall back to (#157). No per-run
 * archiving: the host daemon has no "runs", it just appends across restarts.
 */
export const hostLogTarget = (): string => join(gatewayConfigDir(), "logs", "host.jsonl");

/** The host's logger: file-backed at `hostLogTarget()`, with the console echo. */
export const hostLogger = (): Logger => fileLogger(hostLogTarget());

/** A `Logger` whose captured rows are readable as typed events — see `memoryLogger`. */
export interface MemoryLogger extends Logger {
  /** Every row emitted so far, in order, typed as the dashboard reads them back. */
  readonly events: OrchestratorEvent[];
}

/**
 * A silent, in-memory logger: it captures each stamped row into `.events` and writes nothing to
 * disk and echoes nothing to the console (the console echo is a file-adapter property this adapter
 * simply lacks). For tests and callers that want to assert on emitted events without a real log.
 */
export function memoryLogger(): MemoryLogger {
  const events: OrchestratorEvent[] = [];
  const write = (event: string, data: Record<string, unknown> = {}): void => {
    events.push(stampRow(event, data) as OrchestratorEvent);
  };
  return { log: write, events } as MemoryLogger;
}

/** Persist a gate's full output; the event log carries only the path. */
export function writeGateLog(stateDir: string, cmd: string, res: { stdout?: string; stderr?: string; exitCode: number }) {
  const outFile = `${stateDir}/logs/gate-${Date.now()}.log`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `$ ${cmd}\n--- stdout ---\n${res.stdout ?? ""}\n--- stderr ---\n${res.stderr ?? ""}\n--- exit: ${res.exitCode} ---\n`);
  return outFile;
}

export const tail = (s: string, lines: number) => s.split("\n").slice(-lines).join("\n");
