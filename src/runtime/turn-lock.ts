import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";

const TURN_LOCK_STALE_MS = 12 * 60 * 60 * 1000;

export function resolveBridgeTurnLockPath(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return path.join(os.tmpdir(), "tarocub-turn-locks", digest);
}

export async function withBridgeTurnLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  return await withFileMutex(resolveBridgeTurnLockPath(sessionId), task, {
    staleLockMs: TURN_LOCK_STALE_MS,
  });
}
