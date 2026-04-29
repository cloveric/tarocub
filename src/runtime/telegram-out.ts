import { lstat, mkdir, realpath, readdir, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";

export interface TelegramOutRequest {
  requestId: string;
  dirPath: string;
}

export interface TelegramOutAliasWarning {
  aliasPath: string;
  targetDirPath: string;
  error: unknown;
}

export interface TelegramOutDirOptions {
  onAliasWarning?: (warning: TelegramOutAliasWarning) => void | Promise<void>;
  linkCurrentAlias?: (aliasPath: string, targetDirPath: string) => Promise<void>;
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

const TELEGRAM_OUT_RETENTION_MS = 24 * 60 * 60_000;

export function resolveTelegramOutDir(stateDir: string, requestId: string): string {
  return path.join(stateDir, "workspace", ".telegram-out", requestId);
}

export function resolveCctbSendDir(stateDir: string, requestId: string): string {
  return path.join(stateDir, "workspace", ".cctb-send", requestId);
}

export function resolveTelegramOutCurrentAlias(workspacePath: string): string {
  return path.join(workspacePath, ".telegram-out", "current");
}

async function pointCurrentAlias(aliasPath: string, targetDirPath: string): Promise<void> {
  await mkdir(path.dirname(aliasPath), { recursive: true });
  await rm(aliasPath, { recursive: true, force: true });
  await symlink(targetDirPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
}

async function pointCurrentAliasBestEffort(
  aliasPath: string,
  targetDirPath: string,
  options: TelegramOutDirOptions | undefined,
): Promise<void> {
  const linkCurrentAlias = options?.linkCurrentAlias ?? pointCurrentAlias;
  try {
    await linkCurrentAlias(aliasPath, targetDirPath);
  } catch (error) {
    try {
      await options?.onAliasWarning?.({ aliasPath, targetDirPath, error });
    } catch {
      // Alias creation is a convenience path; requestOutputDir remains authoritative.
    }
  }
}

async function pruneStaleRequestDirs(rootDir: string, preserveRequestId?: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
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

async function pruneStaleTelegramOutDirs(rootDir: string, preserveRequestId: string): Promise<void> {
  await pruneStaleRequestDirs(rootDir, preserveRequestId);
}

export async function pruneStaleCctbSendDirs(stateDir: string, preserveRequestId: string, workspacePath?: string): Promise<void> {
  await pruneStaleRequestDirs(path.dirname(resolveCctbSendDir(stateDir, preserveRequestId)), preserveRequestId);
  if (workspacePath) {
    await pruneStaleRequestDirs(path.join(workspacePath, ".cctb-send"), preserveRequestId);
  }
}

export async function pruneStaleTelegramRuntimeDirs(stateDir: string, workspacePath?: string): Promise<void> {
  await pruneStaleRequestDirs(path.join(stateDir, "workspace", ".telegram-out"));
  await pruneStaleRequestDirs(path.join(stateDir, "workspace", ".cctb-send"));
  if (workspacePath) {
    await pruneStaleRequestDirs(path.join(workspacePath, ".cctb-send"));
  }
}

export async function createTelegramOutDir(
  stateDir: string,
  requestId: string,
  workspacePath?: string,
  options?: TelegramOutDirOptions,
): Promise<TelegramOutRequest> {
  const dirPath = resolveTelegramOutDir(stateDir, requestId);
  await mkdir(path.dirname(dirPath), { recursive: true });
  await pruneStaleTelegramOutDirs(path.dirname(dirPath), requestId);
  await mkdir(dirPath, { recursive: true });
  await pointCurrentAliasBestEffort(resolveTelegramOutCurrentAlias(path.join(stateDir, "workspace")), dirPath, options);
  if (workspacePath) {
    await pointCurrentAliasBestEffort(resolveTelegramOutCurrentAlias(workspacePath), dirPath, options);
  }
  return { requestId, dirPath };
}

export async function listTelegramOutFiles(dirPath: string): Promise<string[]> {
  let rootMetadata;
  let rootRealPath;
  try {
    rootMetadata = await lstat(dirPath);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return [];
    }
    rootRealPath = await realpath(dirPath);
  } catch {
    return [];
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile()) {
      continue;
    }

    const filePath = path.join(dirPath, entry.name);
    let metadata;
    let fileRealPath;
    try {
      metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        continue;
      }
      fileRealPath = await realpath(filePath);
    } catch {
      continue;
    }

    const relative = path.relative(rootRealPath, fileRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    files.push(filePath);
  }

  return files.sort((left, right) => left.localeCompare(right));
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
