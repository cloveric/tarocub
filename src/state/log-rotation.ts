import { stat, rename, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export interface RotateOptions {
  maxBytes: number;
  keepCount: number;
}

export const DEFAULT_ROTATE_OPTIONS: RotateOptions = {
  maxBytes: 10 * 1024 * 1024, // 10 MB
  keepCount: 5,
};

/**
 * Rotate a single log file if it exceeds maxBytes.
 * Renames current → .1, .1 → .2, etc. Deletes beyond keepCount.
 * No-op if the file doesn't exist or is under the threshold.
 */
export async function rotateIfNeeded(filePath: string, options: RotateOptions = DEFAULT_ROTATE_OPTIONS): Promise<boolean> {
  let currentSize: number;
  try {
    const stats = await stat(filePath);
    currentSize = stats.size;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (currentSize < options.maxBytes) {
    return false;
  }

  // Shift .N-1 → .N, .N-2 → .N-1, ...
  for (let i = options.keepCount - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    try {
      await rename(src, dst);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Current → .1
  try {
    await rename(filePath, `${filePath}.1`);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Delete any rotations beyond keepCount
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const entries = await readdir(dir);
    for (const entry of entries) {
      const match = entry.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.(\\d+)$`));
      if (!match) continue;
      const n = parseInt(match[1], 10);
      if (n > options.keepCount) {
        await unlink(path.join(dir, entry));
      }
    }
  } catch {
    // Best effort cleanup
  }

  return true;
}

/**
 * Rotate all standard instance log files.
 */
export async function rotateInstanceLogs(stateDir: string, options: RotateOptions = DEFAULT_ROTATE_OPTIONS): Promise<string[]> {
  const files = [
    path.join(stateDir, "audit.log.jsonl"),
    path.join(stateDir, "timeline.log.jsonl"),
    path.join(stateDir, "service.stdout.log"),
    path.join(stateDir, "service.stderr.log"),
  ];
  const rotated: string[] = [];
  for (const file of files) {
    if (await rotateIfNeeded(file, options)) {
      rotated.push(file);
    }
  }
  return rotated;
}
