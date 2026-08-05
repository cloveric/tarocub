import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unlinkSync, readFileSync } from "node:fs";

import { InstanceLockRecordSchema } from "./instance-lock-schema.js";
import { withFileMutex } from "./file-mutex.js";
import { ensureStateDirPermissions, STATE_DIR_MODE, STATE_FILE_MODE } from "./state-permissions.js";

const INSTANCE_LOCK_FILENAME = "instance.lock.json";

export interface InstanceLockRecord {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface InstanceLockHandle {
  filePath: string;
  pid: number;
  /**
   * True when acquiring required removing a stale lock left by a dead (or
   * corrupt) previous owner — i.e. the previous run ended WITHOUT a clean
   * release. A clean shutdown deletes the lock, so this is the boot-time
   * "previous run crashed" signal the restart-loop breaker keys on.
   */
  recoveredStale: boolean;
  release: () => Promise<void>;
  releaseSync: () => void;
}

function isLockRecord(value: unknown): value is InstanceLockRecord {
  return InstanceLockRecordSchema.safeParse(value).success;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isRepairableLockError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.message === "invalid instance lock");
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

async function readLockRecord(filePath: string): Promise<InstanceLockRecord | null> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (!isLockRecord(parsed)) {
      throw new Error("invalid instance lock");
    }

    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function formatLockRecord(pid: number, token: string): string {
  return JSON.stringify(
    {
      pid,
      token,
      acquiredAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

async function removeStaleLock(filePath: string): Promise<void> {
  try {
    await rm(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function writeExclusiveLock(filePath: string, record: string): Promise<void> {
  await writeFile(filePath, record, { encoding: "utf8", flag: "wx", mode: STATE_FILE_MODE });
}

export function resolveInstanceLockPath(stateDir: string): string {
  return path.join(stateDir, INSTANCE_LOCK_FILENAME);
}

export async function acquireInstanceLock(stateDir: string, pid: number = process.pid): Promise<InstanceLockHandle> {
  await mkdir(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  // Service boot hook: repair any state dir/files an older build created 0755/0644
  // before this process starts writing bot tokens and sessions into them.
  await ensureStateDirPermissions(stateDir);

  const filePath = resolveInstanceLockPath(stateDir);
  const token = randomUUID();
  const serializedRecord = formatLockRecord(pid, token);
  let recoveredStale = false;

  try {
    await writeExclusiveLock(filePath, serializedRecord);
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
    // Serialize the read-check-remove-create recovery sequence. Without this,
    // two starters can both judge the same old record stale; the slower one may
    // then unlink the faster one's newly-created live lock and both proceed.
    await withFileMutex(`${filePath}.acquire`, async () => {
      try {
        await writeExclusiveLock(filePath, serializedRecord);
        return;
      } catch (retryError) {
        if (!isFileExistsError(retryError)) {
          throw retryError;
        }
      }

      let existing: InstanceLockRecord | null;
      try {
        existing = await readLockRecord(filePath);
      } catch (readError) {
        if (!isRepairableLockError(readError)) {
          throw readError;
        }
        await removeStaleLock(filePath);
        await writeExclusiveLock(filePath, serializedRecord);
        recoveredStale = true;
        return;
      }

      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(`Instance lock already held by pid ${existing.pid}`);
      }
      await removeStaleLock(filePath);
      await writeExclusiveLock(filePath, serializedRecord);
      recoveredStale = true;
    });
  }

  const release = async (): Promise<void> => {
    const current = await readLockRecord(filePath);
    if (current && current.pid === pid && current.token === token) {
      await rm(filePath, { force: true });
    }
  };

  const releaseSync = (): void => {
    try {
      const current = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (isLockRecord(current) && current.pid === pid && current.token === token) {
        unlinkSync(filePath);
      }
    } catch (error) {
      console.error(
        `Failed to release instance lock synchronously at ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
      return;
    }
  };

  return {
    filePath,
    pid,
    recoveredStale,
    release,
    releaseSync,
  };
}
