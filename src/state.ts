import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";

export type ParkReason = "blocked" | "budget" | "idle-timeout";

export interface ParkedRecord {
  taskId: string;
  parkedAt: string;
  reason: ParkReason | string;
  sessionId?: string;
  branch: string;
  question: string;
  tgMessageId?: number;
}

const file = (cfg: ResolvedConfig, taskId: string) => `${cfg.parkedDir}/${taskId}.json`;

/**
 * Parking is a TERMINAL state for the slot, not a blocking wait: the record and
 * the agent's session survive on the host, the container goes away, and the
 * slot is freed. One blocked task must never hold up the others.
 *
 * Silent by design (ADR 0002): the run writes the record and sends nothing. The
 * gateway is the sole Telegram sender — it announces the question and fills in
 * the message id (see `setParkedMessageId`), so the record starts with none.
 */
export async function park(cfg: ResolvedConfig, rec: Omit<ParkedRecord, "parkedAt" | "tgMessageId">) {
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(file(cfg, rec.taskId), JSON.stringify({ parkedAt: new Date().toISOString(), ...rec }, null, 2));
  log("parked", { taskId: rec.taskId, reason: rec.reason });
  console.log(`\n*** PARKED (${rec.reason}) — the gateway will announce this question; or answer directly with:\n    sandcastle-tdd answer ${rec.taskId} "<answer>"\n`);
}

/** A project's parked directory under a base location (its `.sandcastle.local/`). */
export const parkedDirOf = (baseLocation: string) => join(baseLocation, "parked");

/** Every parked record under an explicit parked directory — the gateway reads a project's live. */
export function listParkedIn(parkedDir: string): ParkedRecord[] {
  if (!existsSync(parkedDir)) return [];
  return readdirSync(parkedDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(parkedDir, f), "utf8")) as ParkedRecord);
}

/**
 * Stamp a parked record with the message id the gateway announced it as. This is
 * what marks the record announced and, on a later restart, feeds the reply
 * index's rebuild — parked records stay the source of truth (ADR 0002). A record
 * that has since vanished (answered and cleared) is left alone.
 */
export function setParkedMessageId(parkedDir: string, taskId: string, tgMessageId: number): void {
  const path = join(parkedDir, `${taskId}.json`);
  if (!existsSync(path)) return;
  const rec = JSON.parse(readFileSync(path, "utf8")) as ParkedRecord;
  writeFileSync(path, JSON.stringify({ ...rec, tgMessageId }, null, 2));
}

export function readParked(cfg: ResolvedConfig, taskId: string): ParkedRecord {
  const rec = JSON.parse(readFileSync(file(cfg, taskId), "utf8"));
  if (!rec.sessionId) throw new Error(`parked record for ${taskId} has no sessionId — cannot resume`);
  return rec;
}

export const hasParked = (cfg: ResolvedConfig, taskId: string) => existsSync(file(cfg, taskId));

export const clearParked = (cfg: ResolvedConfig, taskId: string) => rmSync(file(cfg, taskId), { force: true });

export function clearParkedForTasks(cfg: ResolvedConfig, taskIds: string[]) {
  for (const taskId of taskIds) clearParked(cfg, taskId);
}

export function listParked(cfg: ResolvedConfig): ParkedRecord[] {
  mkdirSync(cfg.parkedDir, { recursive: true });
  return readdirSync(cfg.parkedDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`${cfg.parkedDir}/${f}`, "utf8")));
}
