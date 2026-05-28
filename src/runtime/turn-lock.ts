import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { withFileMutex, type FileMutexWaitEvent } from "../state/file-mutex.js";

const TURN_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
const TURN_LOCK_WAIT_NOTIFY_AFTER_MS = 10_000;

export function resolveBridgeTurnLockPath(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return path.join(os.tmpdir(), "tarocub-turn-locks", digest);
}

export async function withBridgeTurnLock<T>(
  sessionId: string,
  task: () => Promise<T>,
  options: {
    waitNotifyAfterMs?: number;
    onWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
  } = {},
): Promise<T> {
  return await withFileMutex(resolveBridgeTurnLockPath(sessionId), task, {
    staleLockMs: TURN_LOCK_STALE_MS,
    waitNotifyAfterMs: options.waitNotifyAfterMs ?? TURN_LOCK_WAIT_NOTIFY_AFTER_MS,
    onWait: options.onWait
      ? async (event) => await options.onWait?.(toBridgeTurnLockWaitEvent(sessionId, event))
      : undefined,
  });
}

export interface BridgeTurnLockWaitEvent {
  sessionId: string;
  waitedMs: number;
  reason: FileMutexWaitEvent["reason"];
  lockPath: string;
}

function toBridgeTurnLockWaitEvent(sessionId: string, event: FileMutexWaitEvent): BridgeTurnLockWaitEvent {
  return {
    sessionId,
    waitedMs: event.waitedMs,
    reason: event.reason,
    lockPath: event.lockPath,
  };
}
