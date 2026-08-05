// Durable delivery-obligation ledger (adapted from Hermes's delivery_ledger).
//
// A final engine response that was generated but not yet confirmed-delivered
// is the one artifact the bridge can lose without a trace: the turn already
// burned its tokens, the text exists only in a JS local, and a crash between
// "engine finished" and "platform ACK" drops it silently. This store records
// a small durable row per outbound final response with checkpoints around the
// send (pending → attempting → delivered/failed), and on the next boot
// `sweepRecoverable()` claims rows whose owning process is dead so the
// service can redeliver them.
//
// Crash semantics are explicit about ambiguity:
// - pending    — the send never started: redeliver plainly, no dup risk.
// - attempting — crashed mid-send: the platform MAY already have the message.
//                Redelivered WITH a visible recovered-reply marker, so the
//                contract is honest at-least-once, never a silent duplicate.
// - failed     — definitively rejected once; the restart is a natural retry
//                boundary. Also carries the marker.
// - delivered  — nothing to do; retention prunes.
//
// Poison rows cannot spin: attempts are capped, stale rows expire, and both
// transition to "abandoned". Everything here is best-effort by design: a
// ledger failure must never block or delay an actual send — every public
// method swallows its own errors.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileMutex } from "./file-mutex.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-permissions.js";

const OBLIGATIONS_FILENAME = "delivery-obligations.json";

export const DELIVERY_MAX_ATTEMPTS = 3;
export const DELIVERY_STALE_AFTER_MS = 24 * 60 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_ROWS = 200;
// A reply bigger than this skips the ledger (it is Doc-overflow territory and
// would bloat the state file); the normal delivery path still handles it.
const MAX_CONTENT_BYTES = 200_000;

export type DeliveryObligationState = "pending" | "attempting" | "delivered" | "failed" | "abandoned";

export interface DeliveryObligationRecord {
  id: string;
  channel: "lark" | "telegram";
  chatId: string;
  conversationKey?: string;
  replyTo?: string;
  replyInThread?: boolean;
  content: string;
  state: DeliveryObligationState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  ownerPid: number;
  lastError?: string;
}

export interface RecoverableDelivery extends DeliveryObligationRecord {
  /** True when the platform may already have this message (crashed mid-send
   *  or a definitive rejection) — redeliver with a visible marker. */
  needsMarker: boolean;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM";
  }
}

export function resolveDeliveryObligationsPath(stateDir: string): string {
  return path.join(stateDir, OBLIGATIONS_FILENAME);
}

export function computeObligationId(conversationKey: string, messageRef: string, content: string): string {
  return createHash("sha256")
    .update(`${conversationKey}|${messageRef}|${content}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

async function loadRows(filePath: string): Promise<DeliveryObligationRecord[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const rows = (parsed as { obligations?: unknown })?.obligations;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.filter((row): row is DeliveryObligationRecord => {
      const candidate = row as DeliveryObligationRecord | null;
      return Boolean(
        candidate
        && typeof candidate.id === "string"
        && typeof candidate.chatId === "string"
        && typeof candidate.content === "string"
        && typeof candidate.state === "string"
        && typeof candidate.createdAt === "number",
      );
    });
  } catch {
    return [];
  }
}

async function saveRows(filePath: string, rows: DeliveryObligationRecord[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ obligations: rows }), { encoding: "utf8", mode: STATE_FILE_MODE });
  await rename(tmpPath, filePath);
}

function prune(rows: DeliveryObligationRecord[], now: number): DeliveryObligationRecord[] {
  const cutoff = now - RETENTION_MS;
  let kept = rows.filter((row) => !((row.state === "delivered" || row.state === "abandoned") && row.updatedAt < cutoff));
  if (kept.length > MAX_ROWS) {
    // Drop settled rows first, then oldest.
    const rank = (row: DeliveryObligationRecord): number =>
      row.state === "delivered" ? 0 : row.state === "abandoned" ? 1 : 2;
    kept = [...kept]
      .sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)
      .slice(0, MAX_ROWS);
  }
  return kept;
}

async function mutate(
  stateDir: string,
  fn: (rows: DeliveryObligationRecord[], now: number) => DeliveryObligationRecord[],
): Promise<void> {
  const filePath = resolveDeliveryObligationsPath(stateDir);
  await withFileMutex(`${filePath}.mutex`, async () => {
    const now = Date.now();
    const rows = await loadRows(filePath);
    await saveRows(filePath, prune(fn(rows, now), now));
  });
}

/**
 * Record a final response as owed to the platform (state="pending").
 * Returns the obligation id, or null when the ledger declined (oversize
 * content) or failed — the caller must treat null as "no ledger this turn".
 */
export async function recordDeliveryObligation(
  stateDir: string,
  input: {
    channel: "lark" | "telegram";
    chatId: string;
    conversationKey?: string;
    replyTo?: string;
    replyInThread?: boolean;
    content: string;
  },
): Promise<string | null> {
  try {
    if (!input.content.trim() || Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BYTES) {
      return null;
    }
    const id = computeObligationId(input.conversationKey ?? input.chatId, input.replyTo ?? "", input.content);
    await mutate(stateDir, (rows, now) => {
      const record: DeliveryObligationRecord = {
        id,
        channel: input.channel,
        chatId: input.chatId,
        ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.replyInThread !== undefined ? { replyInThread: input.replyInThread } : {}),
        content: input.content,
        state: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        ownerPid: process.pid,
      };
      return [...rows.filter((row) => row.id !== id), record];
    });
    return id;
  } catch {
    return null;
  }
}

async function updateState(
  stateDir: string,
  id: string,
  state: DeliveryObligationState,
  error?: string,
): Promise<void> {
  try {
    await mutate(stateDir, (rows, now) => rows.map((row) => (row.id === id
      ? {
        ...row,
        state,
        updatedAt: now,
        ...(error ? { lastError: error.slice(0, 500) } : {}),
      }
      : row)));
  } catch {
    // best-effort: ledger bookkeeping must never surface into the send path
  }
}

export async function markDeliveryAttempting(stateDir: string, id: string): Promise<void> {
  await updateState(stateDir, id, "attempting");
}

export async function markDeliveryDelivered(stateDir: string, id: string): Promise<void> {
  await updateState(stateDir, id, "delivered");
}

export async function markDeliveryFailed(stateDir: string, id: string, error?: string): Promise<void> {
  await updateState(stateDir, id, "failed", error);
}

/**
 * Claim undelivered rows owned by dead processes and return them for
 * redelivery. Claiming re-stamps the owner to THIS process and increments
 * attempts. Rows over the attempts cap or older than the stale cutoff
 * transition to "abandoned" instead of being returned (a poison reply must
 * not spin forever, and a day-old reply must not suddenly reappear).
 */
export async function sweepRecoverableDeliveries(
  stateDir: string,
  options: { now?: number; channel?: "lark" | "telegram" } = {},
): Promise<RecoverableDelivery[]> {
  const claimed: RecoverableDelivery[] = [];
  try {
    await mutate(stateDir, (rows, defaultNow) => {
      const now = options.now ?? defaultNow;
      return rows.map((row) => {
        if (row.state !== "pending" && row.state !== "attempting" && row.state !== "failed") {
          return row;
        }
        if (options.channel && row.channel !== options.channel) {
          return row;
        }
        if (isProcessAlive(row.ownerPid) && row.ownerPid !== process.pid) {
          return row; // a live service still owns this row
        }
        if (row.ownerPid === process.pid && row.updatedAt >= now - 1_000) {
          return row; // freshly written by this very process; not a recovery case
        }
        if (row.attempts >= DELIVERY_MAX_ATTEMPTS || now - row.createdAt > DELIVERY_STALE_AFTER_MS) {
          return { ...row, state: "abandoned" as const, updatedAt: now };
        }
        const next: DeliveryObligationRecord = {
          ...row,
          attempts: row.attempts + 1,
          updatedAt: now,
          ownerPid: process.pid,
        };
        claimed.push({ ...next, needsMarker: row.state !== "pending" });
        return next;
      });
    });
  } catch {
    return [];
  }
  return claimed;
}

/** Read-only dump for tests and ad-hoc inspection. */
export async function readDeliveryObligations(stateDir: string): Promise<DeliveryObligationRecord[]> {
  return loadRows(resolveDeliveryObligationsPath(stateDir));
}

/** Config gate (default ON). `CCTB_DELIVERY_LEDGER=off|0|false` disables. */
export function deliveryLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CCTB_DELIVERY_LEDGER ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(value);
}
