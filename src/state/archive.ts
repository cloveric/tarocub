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

async function walkDirectory(root: string, current: string = root): Promise<string[]> {
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
      const nested = await walkDirectory(root, full);
      results.push(...nested);
    } else if (stats.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export async function createArchive(sourceDir: string, outputPath: string): Promise<{ fileCount: number; uncompressedBytes: number; archiveBytes: number }> {
  const rootName = path.basename(sourceDir);
  const files = await walkDirectory(sourceDir);

  const fileBuffers: Buffer[] = [];
  const manifestFiles: ArchiveHeader["files"] = [];
  let uncompressed = 0;

  for (const filePath of files) {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || stats.size > MAX_FILE_SIZE) {
      continue; // skip files that are too large to safely backup
    }
    const content = await readFile(filePath);
    const relPath = path.relative(sourceDir, filePath).replace(/\\/g, "/");
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
  };
}

export async function extractArchive(archivePath: string, destinationRoot: string): Promise<{ fileCount: number; rootName: string }> {
  const compressed = await readFile(archivePath);
  const buffer = gunzipSync(compressed);

  const magic = buffer.subarray(0, 4).toString("utf8");
  if (magic !== "CCTB") {
    throw new Error(`Not a cc-telegram-bridge archive (bad magic: ${magic})`);
  }

  const headerLength = buffer.readUInt32BE(4);
  const headerStart = 8;
  const headerEnd = headerStart + headerLength;
  const headerJson = buffer.subarray(headerStart, headerEnd).toString("utf8");
  const header = JSON.parse(headerJson) as ArchiveHeader;

  if (header.version > ARCHIVE_VERSION) {
    throw new Error(`Archive version ${header.version} is newer than supported version ${ARCHIVE_VERSION}. Upgrade the bridge.`);
  }

  const bodyStart = headerEnd;
  const targetRoot = path.join(destinationRoot, header.rootName);
  // Instance state directories contain bot tokens, access policy, session
  // transcripts, and audit logs — all per-user-private. Create root dir
  // owner-only (0o700) on restore; fall through if chmod fails (e.g. on
  // a filesystem without POSIX perms).
  await mkdir(targetRoot, { recursive: true });
  try { await chmod(targetRoot, 0o700); } catch { /* non-POSIX fs */ }

  const createdDirs = new Set<string>([path.resolve(targetRoot)]);

  for (const file of header.files) {
    // Path traversal safety: reject absolute paths or "..", and resolve only inside targetRoot.
    if (path.isAbsolute(file.path) || file.path.split(/[/\\]/).some((segment) => segment === "..")) {
      throw new Error(`Archive contains unsafe path: ${file.path}`);
    }
    const fullPath = path.join(targetRoot, file.path);
    const resolved = path.resolve(fullPath);
    const relativeToRoot = path.relative(path.resolve(targetRoot), resolved);
    if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Archive path escapes target: ${file.path}`);
    }
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
