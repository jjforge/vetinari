import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLockSync } from "./file-lock.ts";
import type { MessageCategory, ResolvedConfig } from "./config.ts";
import { hostLogger, type Logger } from "./log.ts";
import { Refusal } from "./refusal.ts";

/**
 * The one park-reason enum (design §2.3), the reason on the parked record, the
 * `parked` event, the reducer, the gateway and the dashboard. `detail` carries the
 * specifics — which `stalled` (budget / idle / no-commit), the conflict output, the
 * gate tail — so the reason itself stays a small closed set:
 * - `question` — the run loop hit `BLOCKED`; an answer resumes it.
 * - `stalled`  — turn budget, idle timeout, or an empty `COMPLETE`; an answer guides it.
 * - `conflict` — the integrator hit a merge conflict; a human resolves and redrives.
 * - `red-base` — the merged base gated red; fix-forward or prune, then redrive.
 * - `crash`    — reconciliation found a dead run with no stop marker since the latest `wave-start`; redrive.
 * - `stopped`  — a person stopped the run (SIGINT/SIGTERM) before it reached a verdict; its work is
 *   kept. It cannot be answered — `vetinari run <id>` continues a standalone run, a redrive a campaign.
 * - `outdated-agent` — the agent CLI is too old for the model; update the agent CLI (`vetinari
 *   build` for the default Docker image), then redrive. Like `stopped`, it cannot be answered.
 */
export type ParkReason = "question" | "stalled" | "conflict" | "red-base" | "crash" | "stopped" | "outdated-agent";

/**
 * The park reasons that ask nothing (#444): a record that is never announced per issue, cannot be
 * answered, holds no grace wait, and is consumed when the run next starts — a redrive (or
 * `vetinari run <id>`) re-runs it. `stopped` (a person stopped it) and `outdated-agent` (update
 * the agent CLI first).
 */
export const UNASKED_PARK_REASONS: ReadonlySet<ParkReason> = new Set(["stopped", "outdated-agent"]);

export interface ParkedRecord {
  taskId: string;
  parkedAt: string;
  reason: ParkReason;
  /** the specifics behind `reason` — which `stalled` (budget/idle/no-commit), etc.
   * (design §2.3). Absent when the reason needs no qualifier. */
  detail?: string;
  sessionId?: string;
  branch: string;
  question: string;
  tgMessageId?: number;
  /** the human's answer, written by `answerParked` when an answer is *delivered* (design §5
   * step 3, §7). Its presence marks the record answered — the signal that re-admits the member
   * with the answer as its prompt. Kept until the re-admitted run consumes and clears it. */
  answer?: string;
  /** ISO timestamp the answer was delivered, stamped alongside `answer`. */
  answeredAt?: string;
}

/**
 * Whether a task id could leave the parked directory once joined into a record path — empty, `.`
 * or `..`, or carrying a path separator or NUL. Ids need not be issue numbers (`fetchTask` is
 * pluggable, so `A1` is fine); only path escape is refused.
 */
export const isPathEscapingTaskId = (taskId: string) => taskId === "" || taskId === "." || taskId === ".." || /[/\\\0]/.test(taskId);

/** The one place a parked-record path is built — it throws on an id that could escape `parkedDir`. */
function parkedRecordPath(parkedDir: string, taskId: string): string {
  if (isPathEscapingTaskId(taskId)) throw new Error(`unsafe task id ${JSON.stringify(taskId)} — it could escape the parked directory`);
  return join(parkedDir, `${taskId}.json`);
}

const file = (cfg: Pick<ResolvedConfig, "parkedDir">, taskId: string) => parkedRecordPath(cfg.parkedDir, taskId);

/**
 * Run `fn` holding the parked directory's one lock (`<parkedDir>/.lock`), so the gateway's stamp,
 * an `answer` child's delivery and the campaign's writes and clears never interleave. Every parked
 * write takes it; readers stay lock-free, since every write is an atomic rename. The lock's own
 * files (`.lock`, `.lock.reclaim`, `*.tmp`) do not end in `.json`, so `listParkedIn` skips them.
 */
const withParkedLock = <T>(parkedDir: string, fn: () => T): T =>
  withFileLockSync(join(parkedDir, ".lock"), fn, { retryMs: 5, maxAttempts: 400, label: "parked" });

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
  writeParkedRecord(cfg, rec);
  cfg.log.log("parked", { taskId: rec.taskId, reason: rec.reason, ...(rec.detail ? { detail: rec.detail } : {}) });
}

/**
 * Write (or overwrite) the on-disk parked record only — no `parked` event, no console
 * notice. `park` is the parking *transition* (it also logs the event); this is
 * the record-write half, for a parker that logs its own event separately: the integrator
 * writing a `conflict` record beside the `parked{conflict}` it already logs (design §2.5,
 * "written by whatever parks"). `parkedAt` is stamped here.
 */
export function writeParkedRecord(cfg: Pick<ResolvedConfig, "parkedDir">, rec: Omit<ParkedRecord, "parkedAt" | "tgMessageId">): void {
  const path = file(cfg, rec.taskId);
  mkdirSync(cfg.parkedDir, { recursive: true });
  withParkedLock(cfg.parkedDir, () => writeFileAtomic(path, JSON.stringify({ parkedAt: new Date().toISOString(), ...rec }, null, 2)));
}

/** A project's parked directory under a base location (its `.vetinari.local/`). */
export const parkedDirOf = (baseLocation: string) => join(baseLocation, "parked");

/**
 * Every parked record under an explicit parked directory — the gateway reads a project's live.
 * A record that will not parse (a zero-byte or torn write) is skipped and logged
 * `parked-record-unreadable`, naming the file, rather than throwing out of the whole listing —
 * the guarantee `listProjects` gives registry pointers: one torn record must not take down a
 * project's dashboard or the gateway.
 */
export function listParkedIn(parkedDir: string, logger: Logger = hostLogger()): ParkedRecord[] {
  if (!existsSync(parkedDir)) return [];
  const recs: ParkedRecord[] = [];
  for (const f of readdirSync(parkedDir).filter((f) => f.endsWith(".json"))) {
    const file = join(parkedDir, f);
    try {
      recs.push(JSON.parse(readFileSync(file, "utf8")) as ParkedRecord);
    } catch (e) {
      logger.log("parked-record-unreadable", { file, error: String(e) });
    }
  }
  return recs;
}

/**
 * Stamp a parked record with the message id the gateway announced it as. This is
 * what marks the record announced and, on a later restart, feeds the reply
 * index's rebuild — parked records stay the source of truth (ADR 0002). A record
 * that has since vanished (answered and cleared) is left alone — checked under the parked lock, so
 * a clear racing the stamp can never be written back.
 */
export function setParkedMessageId(parkedDir: string, taskId: string, tgMessageId: number): void {
  const path = parkedRecordPath(parkedDir, taskId);
  if (!existsSync(parkedDir)) return;
  withParkedLock(parkedDir, () => {
    if (!existsSync(path)) return;
    const rec = JSON.parse(readFileSync(path, "utf8")) as ParkedRecord;
    writeFileAtomic(path, JSON.stringify({ ...rec, tgMessageId }, null, 2));
  });
}

/**
 * The one reader of a single parked record by task id — `readParked`, `isAnswered` and
 * `answerParked` all read through it. A record that exists but will not parse to an object can
 * only be a write torn by a power loss or kernel crash (every write is temp-then-rename), so it
 * throws a `Refusal` naming the file and the recovery rather than a raw `SyntaxError`. A missing
 * file is not torn: its `ENOENT` propagates untouched, for each caller to handle as it always has.
 * Nothing is renamed or deleted — the operator decides.
 */
function readParkedRecordFile(parkedDir: string, taskId: string): ParkedRecord {
  const path = parkedRecordPath(parkedDir, taskId);
  const text = readFileSync(path, "utf8");
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    rec = undefined;
  }
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    throw new Refusal(
      `parked record ${path} is unreadable — probably a write torn by a crash or power loss. ` +
        `Delete it, then run \`vetinari redrive\` (a campaign) or \`vetinari run ${taskId}\` (a standalone run) to re-run the task.`,
    );
  }
  return rec as ParkedRecord;
}

/**
 * The parked record for a task. Resuming a session needs its `sessionId`, so by
 * default a record missing one throws — a resumable park→answer cannot proceed
 * without it. The non-resumable answer path carries no session (it relays via an
 * issue comment and re-enters fresh, #212), so it passes `requireSession: false`
 * to read the record's branch/question without demanding a session id.
 */
export function readParked(cfg: ResolvedConfig, taskId: string, opts: { requireSession?: boolean } = {}): ParkedRecord {
  const { requireSession = true } = opts;
  const rec = readParkedRecordFile(cfg.parkedDir, taskId);
  if (requireSession && !rec.sessionId) throw new Error(`parked record for ${taskId} has no sessionId — cannot resume`);
  return rec;
}

export const hasParked = (cfg: ResolvedConfig, taskId: string) => existsSync(file(cfg, taskId));

/**
 * Deliver a human's answer to a parked record (design §5 step 3, §7): write the `answer` text
 * and an `answeredAt` marker into it, keeping everything else — notably `tgMessageId` (so the
 * gateway does not re-announce) and `sessionId` (so a resumable re-admit can resume). An answer
 * is *delivered*, not run: whoever re-admits the member (a live campaign, or a redrive) consumes
 * this record and runs it with the answer as its prompt. Idempotent against a re-delivered answer.
 * The record is re-read under the parked lock, so a stamp a moment earlier survives; returns
 * whether it delivered — false when the record (or the whole parked directory) is gone.
 */
export function answerParked(cfg: ResolvedConfig, taskId: string, answer: string): boolean {
  const path = file(cfg, taskId);
  if (!existsSync(cfg.parkedDir)) return false;
  return withParkedLock(cfg.parkedDir, () => {
    if (!existsSync(path)) return false;
    const rec = readParkedRecordFile(cfg.parkedDir, taskId);
    writeFileAtomic(path, JSON.stringify({ ...rec, answer, answeredAt: new Date().toISOString() }, null, 2));
    return true;
  });
}

/**
 * Whether a parked record for `taskId` is present AND carries a delivered answer — the re-admit
 * signal (design §5 step 3). False for an un-answered park (it holds the wave, awaiting a human)
 * and for a record that is not on disk.
 */
export function isAnswered(cfg: ResolvedConfig, taskId: string): boolean {
  if (!hasParked(cfg, taskId)) return false;
  return readParkedRecordFile(cfg.parkedDir, taskId).answer != null;
}

/**
 * Remove the parked records for `taskIds` under an explicit parked directory, holding the parked
 * lock once for all of them. A parked directory that does not exist is a no-op that creates
 * nothing — no directory and no lock — since there is no record to race on.
 */
export function clearParkedIn(parkedDir: string, taskIds: string[]): void {
  const paths = taskIds.map((taskId) => parkedRecordPath(parkedDir, taskId));
  if (!existsSync(parkedDir)) return;
  withParkedLock(parkedDir, () => {
    for (const path of paths) rmSync(path, { force: true });
  });
}

export const clearParked = (cfg: ResolvedConfig, taskId: string) => clearParkedIn(cfg.parkedDir, [taskId]);

export const clearParkedForTasks = (cfg: ResolvedConfig, taskIds: string[]) => clearParkedIn(cfg.parkedDir, taskIds);

export function listParked(cfg: ResolvedConfig, logger: Logger = hostLogger()): ParkedRecord[] {
  mkdirSync(cfg.parkedDir, { recursive: true });
  return listParkedIn(cfg.parkedDir, logger);
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
  /** This process's enqueue counter — breaks `enqueuedAt` ties; absent on records written before it existed (read as 0). */
  seq?: number;
  /** ISO timestamp the gateway routed it, absent until then — the idempotence marker. */
  sentAt?: string;
  /** The destination name the notify map resolved it to, stamped alongside `sentAt`. */
  destination?: string;
  /** A Telegram message id to send this as a reply to — a question's announcement. The gateway
   *  routes it to the project's question connection, skipping the notify map. */
  replyTo?: number;
}

/** A project's outbox under a base location (its `.vetinari.local/`). */
export const outboxDirOf = (baseLocation: string) => join(baseLocation, "outbox");

/** Per-process enqueue counter, so records written within the same millisecond still list in enqueue order. */
let outboundSeq = 0;

/**
 * Drop a category-tagged outbound record into the project's outbox instead of
 * sending it (ADR 0002: the gateway is the sole sender). One file per record,
 * keyed by a fresh id so records written within the same tick never collide,
 * and stamped with a `seq` so they still list in enqueue order.
 * Silent by design — the gateway drains and routes it per the notify map.
 */
export function enqueueOutbound(
  cfg: Pick<ResolvedConfig, "stateDir" | "log">,
  msg: Omit<OutboundRecord, "id" | "enqueuedAt" | "seq" | "sentAt" | "destination">,
): void {
  const dir = outboxDirOf(cfg.stateDir);
  mkdirSync(dir, { recursive: true });
  const rec: OutboundRecord = { id: randomUUID(), enqueuedAt: new Date().toISOString(), seq: ++outboundSeq, ...msg };
  writeFileAtomic(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  cfg.log.log("outbound-enqueued", { id: rec.id, category: rec.category, event: rec.event });
}

/**
 * Every outbound record under an explicit outbox directory, oldest first (`enqueuedAt`, then `seq`) — the gateway drains a project's live.
 * A record that will not parse is skipped and logged `outbox-record-unreadable`, naming the file, as
 * `listParkedIn` does: one torn record must not take down the gateway tick for every project.
 */
export function listOutboxIn(outboxDir: string, logger: Logger = hostLogger()): OutboundRecord[] {
  if (!existsSync(outboxDir)) return [];
  const recs: OutboundRecord[] = [];
  for (const f of readdirSync(outboxDir).filter((f) => f.endsWith(".json"))) {
    const file = join(outboxDir, f);
    try {
      recs.push(JSON.parse(readFileSync(file, "utf8")) as OutboundRecord);
    } catch (e) {
      logger.log("outbox-record-unreadable", { file, error: String(e) });
    }
  }
  return recs.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || (a.seq ?? 0) - (b.seq ?? 0));
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
  writeFileAtomic(path, JSON.stringify({ ...rec, sentAt: new Date().toISOString(), destination }, null, 2));
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
