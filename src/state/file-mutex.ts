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

async function acquireFileMutex(lockPath: string, staleLockMs: number): Promise<void> {
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
      const recovered = await tryRecoverStaleLock(lockPath, staleLockMs);
      if (!recovered) {
        await sleep(10);
      }
    }
  }
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
  const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
  const run = previous.then(async () => {
    await acquireFileMutex(lockPath, staleLockMs);
    try {
      return await task();
    } finally {
      await releaseFileMutex(lockPath);
    }
  }, async () => {
    await acquireFileMutex(lockPath, staleLockMs);
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
