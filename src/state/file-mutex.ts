import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface LockOwnerRecord {
  pid: number;
  acquiredAt: string;
  /** Unique per acquisition, used so release only removes the lock it still holds. */
  token?: string;
  /** Hostname of the acquirer; a pid liveness probe is only meaningful on the same host. */
  host?: string;
}

const inProcessQueues = new Map<string, Promise<void>>();
const DEFAULT_STALE_LOCK_MS = 30_000;
// A lock whose owner pid is verifiably ALIVE is only age-stolen at a much larger
// bound than staleLockMs: a live-but-slow owner (host sleep, long GC pause) must
// not have its lock ripped away at 30s, but a live-yet-wedged process still can't
// hold the mutex forever.
const LIVE_OWNER_STALE_MULTIPLIER = 20;

interface FileMutexOptions {
  staleLockMs?: number;
  waitNotifyAfterMs?: number;
  onWait?: (event: FileMutexWaitEvent) => void | Promise<void>;
}

export interface FileMutexWaitEvent {
  lockPath: string;
  waitedMs: number;
  reason: "in_process_queue" | "file_lock";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race-safe stale-lock removal. Multiple waiters can judge the SAME lock stale from
 * the same old owner.json; if each simply rm'd the lock dir, the slower one would
 * destroy the faster one's freshly re-acquired LIVE lock and both would enter the
 * critical section. Rename is atomic: only the rename winner proceeds to delete the
 * trash dir; every loser fails (the path is gone) and goes back to waiting. After the
 * rename, the dir's owner.json is compared against the record that was judged stale
 * (tokens are unique per acquisition) so a fresh lock re-created at the same path in
 * the judge→rename window is restored instead of destroyed.
 */
async function removeStaleLock(lockPath: string, judgedOwnerRaw: string | null): Promise<boolean> {
  const trashPath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, trashPath);
  } catch {
    // ENOENT: another waiter won the rename. Windows can also report EPERM/EACCES/
    // EBUSY for a concurrently-touched dir. Either way: not recovered, keep waiting.
    return false;
  }
  let renamedOwnerRaw: string | null = null;
  try {
    renamedOwnerRaw = await readFile(`${trashPath}/owner.json`, "utf8");
  } catch {
    renamedOwnerRaw = null;
  }
  if (renamedOwnerRaw !== judgedOwnerRaw) {
    // We renamed a LIVE lock that replaced the stale one — put it back. If a third
    // waiter mkdir'd the path in the meantime the restore fails; discard the trash
    // then (release() tolerates the loss via its token check).
    try {
      await rename(trashPath, lockPath);
    } catch {
      await rm(trashPath, { recursive: true, force: true }).catch(() => {});
    }
    return false;
  }
  await rm(trashPath, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function tryRecoverStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  const ownerPath = `${lockPath}/owner.json`;
  try {
    const [ownerRaw, lockStats] = await Promise.all([
      readFile(ownerPath, "utf8").catch((error: unknown) => {
        if (isMissingError(error)) {
          return null;
        }
        throw error;
      }),
      stat(lockPath),
    ]);

    const ageMs = Date.now() - lockStats.mtimeMs;
    if (ownerRaw === null) {
      if (ageMs > staleLockMs) {
        return removeStaleLock(lockPath, ownerRaw);
      }
      return false;
    }

    let owner: LockOwnerRecord | null = null;
    try {
      const parsed = JSON.parse(ownerRaw) as Partial<LockOwnerRecord>;
      if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "string") {
        owner = {
          pid: parsed.pid,
          acquiredAt: parsed.acquiredAt,
          ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
        };
      }
    } catch {
      owner = null;
    }

    if (!owner) {
      if (ageMs > staleLockMs) {
        return removeStaleLock(lockPath, ownerRaw);
      }
      return false;
    }

    // A pid probe is only meaningful for a same-host owner. Old records carry no
    // host; assume same host (locks live in the local state dir).
    const pidVerifiable = owner.host === undefined || owner.host === os.hostname();
    let ownerAlive: boolean | null = null;
    if (pidVerifiable) {
      try {
        ownerAlive = isProcessAlive(owner.pid);
      } catch {
        ownerAlive = null;
      }
    }
    if (ownerAlive === false) {
      return removeStaleLock(lockPath, ownerRaw);
    }
    const ownerAgeMs = Date.now() - new Date(owner.acquiredAt).getTime();
    // Verifiably-alive owner: age-steal only at the much larger bound. Dead or
    // unverifiable owner: the plain staleLockMs age bound applies.
    const ageStealMs = ownerAlive === true ? staleLockMs * LIVE_OWNER_STALE_MULTIPLIER : staleLockMs;
    if (ownerAgeMs > ageStealMs) {
      return removeStaleLock(lockPath, ownerRaw);
    }
    return false;
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }
}

async function acquireFileMutex(
  lockPath: string,
  staleLockMs: number,
  notifyWait?: (reason: FileMutexWaitEvent["reason"]) => void,
): Promise<string> {
  const ownerPath = `${lockPath}/owner.json`;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      const token = randomUUID();
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token,
        host: os.hostname(),
      }), { encoding: "utf8", mode: 0o600 });
      return token;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      notifyWait?.("file_lock");
      const recovered = await tryRecoverStaleLock(lockPath, staleLockMs);
      if (!recovered) {
        await sleep(10);
      }
    }
  }
}

function scheduleFileMutexWaitNotification(
  input: {
    lockPath: string;
    waitStartedAt: number;
    waitNotifyAfterMs: number;
    notify: (reason: FileMutexWaitEvent["reason"]) => void;
    reason: FileMutexWaitEvent["reason"];
  },
): NodeJS.Timeout | undefined {
  if (input.waitNotifyAfterMs <= 0) {
    input.notify(input.reason);
    return undefined;
  }

  const timer = setTimeout(() => {
    input.notify(input.reason);
  }, input.waitNotifyAfterMs);
  timer.unref?.();
  return timer;
}

async function releaseFileMutex(lockPath: string, token: string): Promise<void> {
  const ownerPath = `${lockPath}/owner.json`;
  let ownsLock = false;
  try {
    const raw = await readFile(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwnerRecord>;
    ownsLock = typeof parsed.token === "string" && parsed.token === token;
  } catch {
    // Missing owner.json (ENOENT) or corrupt JSON: do NOT delete. A missing record
    // can mean another owner already recovered the stale lock and re-created the dir
    // but has not written its owner.json yet — removing it would destroy *their* lock
    // and crash their acquire (writeFile ENOENT). Only delete a lock we can PROVE is
    // ours (readable, matching token); a genuinely-leaked lock is reclaimed later via
    // staleLockMs.
    ownsLock = false;
  }
  if (ownsLock) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function withFileMutex<T>(
  targetPath: string,
  task: () => Promise<T>,
  options: FileMutexOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const waitNotifyAfterMs = options.waitNotifyAfterMs ?? 0;
  const waitStartedAt = Date.now();
  let waitNotified = false;
  const notifyWait = (reason: FileMutexWaitEvent["reason"]): void => {
    if (waitNotified || !options.onWait) {
      return;
    }
    const waitedMs = Math.max(0, Date.now() - waitStartedAt);
    if (waitedMs < waitNotifyAfterMs) {
      return;
    }
    waitNotified = true;
    void Promise.resolve(options.onWait({ lockPath, waitedMs, reason })).catch((error: unknown) => {
      console.error("Failed to notify file mutex wait:", error instanceof Error ? error.message : error);
    });
  };
  const previous = inProcessQueues.get(lockPath);
  const waitForPrevious = async (): Promise<void> => {
    if (!previous) {
      return;
    }
    const timer = scheduleFileMutexWaitNotification({
      lockPath,
      waitStartedAt,
      waitNotifyAfterMs,
      notify: notifyWait,
      reason: "in_process_queue",
    });
    try {
      await previous.catch(() => undefined);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  const acquireRunRelease = async (): Promise<T> => {
    const token = await acquireFileMutex(lockPath, staleLockMs, notifyWait);
    try {
      return await task();
    } finally {
      await releaseFileMutex(lockPath, token);
    }
  };
  const run = waitForPrevious().then(acquireRunRelease, acquireRunRelease);

  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  inProcessQueues.set(lockPath, queued);
  try {
    return await run;
  } finally {
    if (inProcessQueues.get(lockPath) === queued) {
      inProcessQueues.delete(lockPath);
    }
  }
}
