import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "./config.ts";
import { log } from "./log.ts";
import { tgSend } from "./telegram.ts";

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
 */
export async function park(cfg: ResolvedConfig, rec: Omit<ParkedRecord, "parkedAt" | "tgMessageId">) {
  const tgMessageId = await tgSend(
    `⏸ ${cfg.project} agent PARKED (${rec.reason}) on ${rec.taskId}\n\n${rec.question}\n\nReply to this message to answer and resume.`,
  );
  mkdirSync(cfg.parkedDir, { recursive: true });
  writeFileSync(file(cfg, rec.taskId), JSON.stringify({ parkedAt: new Date().toISOString(), tgMessageId, ...rec }, null, 2));
  log("parked", { taskId: rec.taskId, reason: rec.reason, telegram: tgMessageId != null });
  console.log(`\n*** PARKED (${rec.reason}) — answer with:\n    sandcastle-tdd answer ${rec.taskId} "<answer>"\n`);
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
