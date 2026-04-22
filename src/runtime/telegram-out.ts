import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface TelegramOutRequest {
  requestId: string;
  dirPath: string;
}

export interface TelegramOutFileInfo {
  path: string;
  name: string;
  size: number;
}

export interface TelegramOutLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface TelegramOutLimitResult {
  accepted: TelegramOutFileInfo[];
  skipped: TelegramOutFileInfo[];
}

const TELEGRAM_OUT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function resolveTelegramOutDir(stateDir: string, requestId: string): string {
  return path.join(stateDir, "workspace", ".telegram-out", requestId);
}

async function pruneStaleTelegramOutDirs(rootDir: string, preserveRequestId: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  const staleBefore = Date.now() - TELEGRAM_OUT_RETENTION_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name === preserveRequestId) {
      return;
    }

    const entryPath = path.join(rootDir, entry.name);
    let metadata;
    try {
      metadata = await stat(entryPath);
    } catch {
      return;
    }

    if (metadata.mtimeMs >= staleBefore) {
      return;
    }

    await rm(entryPath, { recursive: true, force: true }).catch(() => {});
  }));
}

export async function createTelegramOutDir(stateDir: string, requestId: string): Promise<TelegramOutRequest> {
  const dirPath = resolveTelegramOutDir(stateDir, requestId);
  await mkdir(path.dirname(dirPath), { recursive: true });
  await pruneStaleTelegramOutDirs(path.dirname(dirPath), requestId);
  await mkdir(dirPath, { recursive: true });
  return { requestId, dirPath };
}

export async function listTelegramOutFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function describeTelegramOutFiles(dirPath: string): Promise<TelegramOutFileInfo[]> {
  const files = await listTelegramOutFiles(dirPath);
  const result: TelegramOutFileInfo[] = [];

  for (const filePath of files) {
    const metadata = await stat(filePath);
    result.push({
      path: filePath,
      name: path.basename(filePath),
      size: metadata.size,
    });
  }

  return result;
}

export function applyTelegramOutLimits(
  files: TelegramOutFileInfo[],
  limits: TelegramOutLimits,
): TelegramOutLimitResult {
  const accepted: TelegramOutFileInfo[] = [];
  const skipped: TelegramOutFileInfo[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (accepted.length >= limits.maxFiles) {
      skipped.push(file);
      continue;
    }

    if (file.size > limits.maxFileBytes) {
      skipped.push(file);
      continue;
    }

    if (totalBytes + file.size > limits.maxTotalBytes) {
      skipped.push(file);
      continue;
    }

    accepted.push(file);
    totalBytes += file.size;
  }

  return { accepted, skipped };
}
