import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageCategory, ResolvedConfig } from "./config.ts";
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

/**
 * One outbound message a run wrote instead of sending to Telegram: its category
 * (and event where relevant), the text, and a `sentAt` marker the gateway stamps
 * once it has routed it. The run is never the sender — it drops a record; the
 * gateway drains the outbox and routes each per the project's notify map (E4).
 */
export interface OutboundRecord {
  id: string;
  category: MessageCategory;
  event?: string;
  text: string;
  enqueuedAt: string;
  /** ISO timestamp the gateway routed it, absent until then — the idempotence marker. */
  sentAt?: string;
  /** The destination name the notify map resolved it to, stamped alongside `sentAt`. */
  destination?: string;
}

/** A project's outbox under a base location (its `.sandcastle.local/`). */
export const outboxDirOf = (baseLocation: string) => join(baseLocation, "outbox");

/**
 * Drop a category-tagged outbound record into the project's outbox instead of
 * sending it (ADR 0002: the gateway is the sole sender). One file per record,
 * keyed by a fresh id so records written within the same tick never collide.
 * Silent by design — the gateway drains and routes it per the notify map.
 */
export function enqueueOutbound(cfg: Pick<ResolvedConfig, "stateDir">, msg: Omit<OutboundRecord, "id" | "enqueuedAt" | "sentAt" | "destination">): void {
  const dir = outboxDirOf(cfg.stateDir);
  mkdirSync(dir, { recursive: true });
  const rec: OutboundRecord = { id: randomUUID(), enqueuedAt: new Date().toISOString(), ...msg };
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  log("outbound-enqueued", { id: rec.id, category: rec.category, event: rec.event });
}

/** Every outbound record under an explicit outbox directory, oldest first — the gateway drains a project's live. */
export function listOutboxIn(outboxDir: string): OutboundRecord[] {
  if (!existsSync(outboxDir)) return [];
  return readdirSync(outboxDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(outboxDir, f), "utf8")) as OutboundRecord)
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
}

/** A run's own outbox (for tests and archival), resolved from its state dir. */
export const listOutbox = (cfg: Pick<ResolvedConfig, "stateDir">) => listOutboxIn(outboxDirOf(cfg.stateDir));

/**
 * Stamp an outbound record sent once the gateway has routed it: the `sentAt`
 * marker persists so a gateway restart neither re-sends it nor drops an
 * unrouted one (idempotent drain). A record that has since vanished (archived)
 * is left alone, mirroring `setParkedMessageId`.
 */
export function markOutboundSent(outboxDir: string, id: string, destination?: string): void {
  const path = join(outboxDir, `${id}.json`);
  if (!existsSync(path)) return;
  const rec = JSON.parse(readFileSync(path, "utf8")) as OutboundRecord;
  writeFileSync(path, JSON.stringify({ ...rec, sentAt: new Date().toISOString(), destination }, null, 2));
}

/**
 * Remove only the already-routed records from a run's outbox (archival tidy-up),
 * returning how many were cleared. Unsent records are deliberately kept — a
 * message emitted while the gateway was down must still be sent when it returns.
 */
export function clearSentOutbound(cfg: Pick<ResolvedConfig, "stateDir">): number {
  const dir = outboxDirOf(cfg.stateDir);
  const sent = listOutboxIn(dir).filter((r) => r.sentAt != null);
  for (const rec of sent) rmSync(join(dir, `${rec.id}.json`), { force: true });
  return sent.length;
}
