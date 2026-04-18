import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unlinkSync, readFileSync } from "node:fs";

import { InstanceLockRecordSchema } from "./instance-lock-schema.js";

const INSTANCE_LOCK_FILENAME = "instance.lock.json";

export interface InstanceLockRecord {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface InstanceLockHandle {
  filePath: string;
  pid: number;
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
  await writeFile(filePath, record, { encoding: "utf8", flag: "wx" });
}

export function resolveInstanceLockPath(stateDir: string): string {
  return path.join(stateDir, INSTANCE_LOCK_FILENAME);
}

export async function acquireInstanceLock(stateDir: string, pid: number = process.pid): Promise<InstanceLockHandle> {
  await mkdir(stateDir, { recursive: true });

  const filePath = resolveInstanceLockPath(stateDir);
  const token = randomUUID();
  const serializedRecord = formatLockRecord(pid, token);

  for (;;) {
    try {
      await writeExclusiveLock(filePath, serializedRecord);
      break;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }

    let existing: InstanceLockRecord | null;
    existing = await readLockRecord(filePath);

    if (existing === null) {
      continue;
    }

    if (isProcessAlive(existing.pid)) {
      throw new Error(`Instance lock already held by pid ${existing.pid}`);
    }

    await removeStaleLock(filePath);
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
    } catch {
      return;
    }
  };

  return {
    filePath,
    pid,
    release,
    releaseSync,
  };
}
