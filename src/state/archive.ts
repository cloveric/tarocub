import { readdir, readFile, stat, lstat, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

/**
 * Pure-Node archive format for instance backup.
 *
 * Format:
 *   Header (JSON):  { version: 1, createdAt, files: [{ path, size, contentOffset }] }
 *   Then a null byte separator, then raw concatenated file bodies.
 *   Whole thing is gzipped.
 *
 * This is a zero-dep alternative to tar so backup/restore works on any
 * platform without requiring the tar binary to be installed.
 */

const ARCHIVE_VERSION = 1;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per file cap to avoid runaway backups
const MAX_HEADER_SIZE = 16 * 1024 * 1024;

/**
 * Directories excluded from an instance backup by default.
 *
 * A live instance state dir is 3+ GB, almost all of it regenerable: the engine
 * workspace's `node_modules` / `.venv*` / `.git`, plus bridge scratch
 * (`.lark-out`, `.lark-files`, `asr-jobs`). `createArchive` reads every file
 * into RAM before gzipping, so without these excludes `telegram backup` on a
 * real instance is an OOM waiting to happen — and the resulting archive is
 * mostly noise. What matters (config, access, sessions, cron, board, usage) is
 * tiny and always included.
 *
 * Matched by directory NAME at any depth, so `workspace/node_modules` and
 * `workspace/pkg/sub/node_modules` are both covered.
 */
export const ARCHIVE_EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  "node_modules",
  ".git",
  ".lark-out",
  ".lark-files",
  "asr-jobs",
];

/** Directory-name prefixes excluded at any depth (`.venv`, `.venv3.12`, …). */
export const ARCHIVE_EXCLUDED_DIRECTORY_PREFIXES: readonly string[] = [".venv"];

/**
 * Log files (and their rotations) excluded by default: `service.log`,
 * `timeline.log.jsonl`, `audit.log.jsonl.3`, … Append-only operational history,
 * up to 60 MB per instance, and never needed to restore a working bot.
 */
export const ARCHIVE_EXCLUDED_FILE_PATTERN = /\.log(?:\.|$)/;

/** Human-readable summary of the default exclusions, for command output. */
export const ARCHIVE_EXCLUSION_SUMMARY =
  `${ARCHIVE_EXCLUDED_DIRECTORY_NAMES.join(", ")}, ${ARCHIVE_EXCLUDED_DIRECTORY_PREFIXES.map((prefix) => `${prefix}*`).join(", ")} (any depth) and *.log*`;

export interface ArchiveExclusionReport {
  /** Relative paths of directories that were skipped, in walk order. */
  excludedDirectories: string[];
  /** Files skipped because they exceed the per-file cap. */
  skippedOversizeFiles: Array<{ path: string; size: number }>;
  /** Number of log files skipped by ARCHIVE_EXCLUDED_FILE_PATTERN. */
  excludedLogFileCount: number;
}

export interface CreateArchiveResult extends ArchiveExclusionReport {
  fileCount: number;
  uncompressedBytes: number;
  archiveBytes: number;
}

function isExcludedDirectoryName(name: string): boolean {
  return ARCHIVE_EXCLUDED_DIRECTORY_NAMES.includes(name) ||
    ARCHIVE_EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function toRelativePosixPath(root: string, full: string): string {
  return path.relative(root, full).replace(/\\/g, "/");
}

interface ArchiveHeader {
  version: number;
  createdAt: string;
  rootName: string;
  files: Array<{
    path: string;
    size: number;
    contentOffset: number;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeArchiveRootName(value: string): boolean {
  return value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0") &&
    path.posix.basename(value) === value &&
    path.win32.basename(value) === value;
}

function parseArchiveHeader(buffer: Buffer): { header: ArchiveHeader; bodyStart: number } {
  if (buffer.length < 8) {
    throw new Error("Archive is truncated before its header");
  }
  const headerLength = buffer.readUInt32BE(4);
  if (headerLength === 0 || headerLength > MAX_HEADER_SIZE || headerLength > buffer.length - 8) {
    throw new Error("Archive has an invalid header length");
  }

  const bodyStart = 8 + headerLength;
  const parsed = JSON.parse(buffer.subarray(8, bodyStart).toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Archive header must be an object");
  }
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) {
    throw new Error("Archive has an invalid version");
  }
  if (parsed.version > ARCHIVE_VERSION) {
    throw new Error(`Archive version ${parsed.version} is newer than supported version ${ARCHIVE_VERSION}. Upgrade the bridge.`);
  }
  if (typeof parsed.rootName !== "string" || !isSafeArchiveRootName(parsed.rootName)) {
    throw new Error("Archive contains an unsafe archive root name");
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error("Archive header has an invalid file list");
  }

  const bodyLength = buffer.length - bodyStart;
  const files = parsed.files.map((entry, index): ArchiveHeader["files"][number] => {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`Archive file ${index} has an invalid path`);
    }
    if (
      typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      typeof entry.contentOffset !== "number" || !Number.isSafeInteger(entry.contentOffset) || entry.contentOffset < 0 ||
      entry.contentOffset > bodyLength || entry.size > bodyLength - entry.contentOffset
    ) {
      throw new Error(`Archive file ${index} has an invalid file range`);
    }
    return { path: entry.path, size: entry.size, contentOffset: entry.contentOffset };
  });

  return {
    header: {
      version: parsed.version,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      rootName: parsed.rootName,
      files,
    },
    bodyStart,
  };
}

async function walkDirectory(
  root: string,
  current: string = root,
  report?: ArchiveExclusionReport,
): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(current, entry);
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) {
      continue; // skip symlinks to prevent traversal outside state dir
    }
    if (stats.isDirectory()) {
      if (report && isExcludedDirectoryName(entry)) {
        // Heavy + regenerable: never descend (a node_modules walk alone can be
        // hundreds of thousands of lstat calls).
        report.excludedDirectories.push(toRelativePosixPath(root, full));
        continue;
      }
      const nested = await walkDirectory(root, full, report);
      for (const filePath of nested) {
        results.push(filePath);
      }
    } else if (stats.isFile()) {
      if (report && ARCHIVE_EXCLUDED_FILE_PATTERN.test(entry)) {
        report.excludedLogFileCount += 1;
        continue;
      }
      results.push(full);
    }
  }
  return results;
}

export async function createArchive(
  sourceDir: string,
  outputPath: string,
  options: { applyDefaultExclusions?: boolean } = {},
): Promise<CreateArchiveResult> {
  const applyDefaultExclusions = options.applyDefaultExclusions !== false;
  const rootName = path.basename(sourceDir);
  const report: ArchiveExclusionReport = {
    excludedDirectories: [],
    skippedOversizeFiles: [],
    excludedLogFileCount: 0,
  };
  const files = await walkDirectory(sourceDir, sourceDir, applyDefaultExclusions ? report : undefined);

  const fileBuffers: Buffer[] = [];
  const manifestFiles: ArchiveHeader["files"] = [];
  let uncompressed = 0;

  for (const filePath of files) {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.size > MAX_FILE_SIZE) {
      // Report it: silently dropping a file from a backup the operator believes
      // is complete is how a restore discovers the gap far too late.
      report.skippedOversizeFiles.push({
        path: toRelativePosixPath(sourceDir, filePath),
        size: stats.size,
      });
      continue;
    }
    const content = await readFile(filePath);
    const relPath = toRelativePosixPath(sourceDir, filePath);
    manifestFiles.push({
      path: relPath,
      size: content.length,
      contentOffset: uncompressed,
    });
    fileBuffers.push(content);
    uncompressed += content.length;
  }

  const header: ArchiveHeader = {
    version: ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    rootName,
    files: manifestFiles,
  };

  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerJson.length, 0);

  const uncompressedBuffer = Buffer.concat([
    Buffer.from("CCTB", "utf8"), // magic
    headerLength,
    headerJson,
    ...fileBuffers,
  ]);

  const compressed = gzipSync(uncompressedBuffer);
  await writeFile(outputPath, compressed);

  return {
    fileCount: manifestFiles.length,
    uncompressedBytes: uncompressed,
    archiveBytes: compressed.length,
    excludedDirectories: report.excludedDirectories,
    skippedOversizeFiles: report.skippedOversizeFiles,
    excludedLogFileCount: report.excludedLogFileCount,
  };
}

export async function extractArchive(archivePath: string, destinationRoot: string): Promise<{ fileCount: number; rootName: string }> {
  const compressed = await readFile(archivePath);
  const buffer = gunzipSync(compressed);

  const magic = buffer.subarray(0, 4).toString("utf8");
  if (magic !== "CCTB") {
    throw new Error(`Not a cc-telegram-bridge archive (bad magic: ${magic})`);
  }

  const { header, bodyStart } = parseArchiveHeader(buffer);
  const resolvedDestinationRoot = path.resolve(destinationRoot);
  const targetRoot = path.resolve(resolvedDestinationRoot, header.rootName);
  if (path.dirname(targetRoot) !== resolvedDestinationRoot) {
    throw new Error("Archive contains an unsafe archive root name");
  }
  // Instance state directories contain bot tokens, access policy, session
  // transcripts, and audit logs — all per-user-private. Create root dir
  // owner-only (0o700) on restore; fall through if chmod fails (e.g. on
  // a filesystem without POSIX perms).
  const plannedFiles = header.files.map((file) => {
    if (path.isAbsolute(file.path) || file.path.split(/[/\\]/).some((segment) => segment === "..")) {
      throw new Error(`Archive contains unsafe path: ${file.path}`);
    }
    const fullPath = path.join(targetRoot, file.path);
    const resolved = path.resolve(fullPath);
    const relativeToRoot = path.relative(targetRoot, resolved);
    if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Archive path escapes target: ${file.path}`);
    }
    return { file, fullPath };
  });

  await mkdir(targetRoot, { recursive: true });
  try { await chmod(targetRoot, 0o700); } catch { /* non-POSIX fs */ }

  const createdDirs = new Set<string>([path.resolve(targetRoot)]);

  for (const { file, fullPath } of plannedFiles) {
    const parentDir = path.dirname(fullPath);
    await mkdir(parentDir, { recursive: true });
    const resolvedParent = path.resolve(parentDir);
    if (!createdDirs.has(resolvedParent)) {
      try { await chmod(parentDir, 0o700); } catch { /* non-POSIX fs */ }
      createdDirs.add(resolvedParent);
    }
    const start = bodyStart + file.contentOffset;
    const end = start + file.size;
    await writeFile(fullPath, buffer.subarray(start, end));
    // Every file in a bot's state dir is effectively private. Harden all
    // of them, not just the obvious ones like .env, so sensitive state
    // never lands world-readable after restore.
    try { await chmod(fullPath, 0o600); } catch { /* non-POSIX fs */ }
  }

  return {
    fileCount: header.files.length,
    rootName: header.rootName,
  };
}
