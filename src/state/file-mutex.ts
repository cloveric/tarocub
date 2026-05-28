import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface LockOwnerRecord {
  pid: number;
  acquiredAt: string;
}

const inProcessQueues = new Map<string, Promise<void>>();
const DEFAULT_STALE_LOCK_MS = 30_000;

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
        await rm(lockPath, { recursive: true, force: true });
        return true;
      }
      return false;
    }

    let owner: LockOwnerRecord | null = null;
    try {
      const parsed = JSON.parse(ownerRaw) as Partial<LockOwnerRecord>;
      if (typeof parsed.pid === "number" && typeof parsed.acquiredAt === "string") {
        owner = { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
      }
    } catch {
      owner = null;
    }

    if (!owner) {
      if (ageMs > staleLockMs) {
        await rm(lockPath, { recursive: true, force: true });
        return true;
      }
      return false;
    }

    const ownerDead = !isProcessAlive(owner.pid);
    const ownerAgeMs = Date.now() - new Date(owner.acquiredAt).getTime();
    if (ownerDead || ownerAgeMs > staleLockMs) {
      await rm(lockPath, { recursive: true, force: true });
      return true;
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
): Promise<void> {
  const ownerPath = `${lockPath}/owner.json`;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }), { encoding: "utf8", mode: 0o600 });
      return;
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

async function releaseFileMutex(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
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
  const run = waitForPrevious().then(async () => {
    await acquireFileMutex(lockPath, staleLockMs, notifyWait);
    try {
      return await task();
    } finally {
      await releaseFileMutex(lockPath);
    }
  }, async () => {
    await acquireFileMutex(lockPath, staleLockMs, notifyWait);
    try {
      return await task();
    } finally {
      await releaseFileMutex(lockPath);
    }
  });

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
