import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state/state-permissions.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../telegram/instance-config.js";
import { listCctbInstances, resolveCctbRoot, type IsProcessAlive } from "./instance-discovery.js";

export const FILE_UNIT_CATEGORIES = [
  "browser",
  "project",
  "deliverable",
  "download",
  "environment",
  "cache",
  "temporary",
  "source",
  "unknown",
] as const;

export type FileUnitCategory = (typeof FILE_UNIT_CATEGORIES)[number];
export type FileSafetyState = "protected" | "important" | "active" | "rebuildable" | "temporary" | "review";
export type FileOrigin = "bridge-input" | "runtime" | "workspace" | "unknown";

export interface FileInventoryLabel {
  category?: FileUnitCategory;
  important?: boolean;
  note?: string;
  updatedAt: string;
}

export interface FileInventoryExtension {
  extension: string;
  files: number;
  allocatedBytes: number;
}

export interface FileInventoryLargestFile {
  name: string;
  relativePath: string;
  allocatedBytes: number;
}

export interface FileInventoryUnit {
  id: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  rootKind: "workspace" | "inbox" | "asr";
  instances: string[];
  kind: "file" | "directory" | "symlink" | "collection";
  category: FileUnitCategory;
  categorySource: "system" | "user";
  safety: FileSafetyState;
  origin: FileOrigin;
  allocatedBytes: number;
  logicalBytes: number;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  lastModifiedAt: string;
  topExtensions: FileInventoryExtension[];
  largestFiles: FileInventoryLargestFile[];
  reasons: string[];
  important: boolean;
  note?: string;
  partial: boolean;
  errorCount: number;
}

export interface FileInventoryBucket {
  key: string;
  units: number;
  allocatedBytes: number;
}

export interface FileInventoryResult {
  generatedAt: string;
  totalAllocatedBytes: number;
  totalLogicalBytes: number;
  unitCount: number;
  byCategory: FileInventoryBucket[];
  bySafety: FileInventoryBucket[];
  units: FileInventoryUnit[];
  warnings: string[];
}

interface FileInventoryLabelsFile {
  version: 1;
  units: Record<string, FileInventoryLabel>;
}

interface ScanMetrics {
  allocatedBytes: number;
  logicalBytes: number;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  latestMtimeMs: number;
  extensionStats: Map<string, { files: number; allocatedBytes: number }>;
  largestFiles: FileInventoryLargestFile[];
  markerDepths: Map<string, number>;
  errorCount: number;
}

interface ScanTarget {
  absolutePath: string;
  idKey?: string;
  displayName?: string;
  memberPaths?: string[];
  collectionCategory?: FileUnitCategory;
  relativePath: string;
  rootKind: FileInventoryUnit["rootKind"];
  instances: string[];
}

const LABELS_FILENAME = "file-inventory-labels.json";
const RECENTLY_ACTIVE_MS = 15 * 60_000;
const MAX_LARGEST_FILES = 5;
const MAX_TOP_EXTENSIONS = 6;

const BROWSER_NAMES = /(?:^|[-_.])(chrome|chromium|browser|playwright|camoufox|user[-_.]?data|profile)(?:$|[-_.])/i;
const ENVIRONMENT_NAMES = /^(?:\.?(?:venv|env)|[^/]*[-_.]venv|node_modules)$/i;
const CACHE_NAMES = /^(?:\.cache|cache|caches|models?|huggingface|transformers)$/i;
const TEMPORARY_NAMES = /^(?:\.lark-files|\.lark-out|\.telegram-files|tmp|temp|temporary|asr-jobs)$/i;
const DELIVERABLE_NAMES = /^(?:outputs?|exports?|deliverables?|results?|final)$/i;
const DOWNLOAD_NAMES = /^(?:downloads?|inbox)$/i;
const SOURCE_NAMES = /^(?:inputs?|sources?|assets?|materials?|素材|资料)$/i;

const DOCUMENT_EXTENSIONS = new Set([
  ".csv", ".doc", ".docx", ".html", ".md", ".ods", ".odp", ".pdf", ".ppt", ".pptx", ".rtf",
  ".txt", ".xls", ".xlsx",
]);
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MEDIA_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".wav", ".webm"]);
const ARCHIVE_EXTENSIONS = new Set([".7z", ".bz2", ".gz", ".rar", ".tar", ".tgz", ".xz", ".zip"]);
const CODE_DATA_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".java", ".js", ".json", ".jsx", ".mjs",
  ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml",
]);

const LOOSE_FILE_GROUPS = {
  document: { name: "根目录散落文档", relativeName: "文档", category: "deliverable" as const },
  image: { name: "根目录散落图片", relativeName: "图片", category: "deliverable" as const },
  media: { name: "根目录散落音视频", relativeName: "音视频", category: "deliverable" as const },
  archive: { name: "根目录散落压缩包", relativeName: "压缩包", category: "unknown" as const },
  "code-data": { name: "根目录散落代码与数据", relativeName: "代码与数据", category: "unknown" as const },
  other: { name: "根目录其他散落文件", relativeName: "其他", category: "unknown" as const },
};

type LooseFileGroup = keyof typeof LOOSE_FILE_GROUPS;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function allocatedBytes(stats: Stats): number {
  return typeof stats.blocks === "number" && stats.blocks >= 0
    ? stats.blocks * 512
    : Math.ceil(stats.size / 512) * 512;
}

function fileInventoryId(absolutePath: string): string {
  return createHash("sha256").update(path.resolve(absolutePath).normalize("NFC")).digest("hex").slice(0, 24);
}

function emptyMetrics(): ScanMetrics {
  return {
    allocatedBytes: 0,
    logicalBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    latestMtimeMs: 0,
    extensionStats: new Map(),
    largestFiles: [],
    markerDepths: new Map(),
    errorCount: 0,
  };
}

function setMarkerDepth(metrics: ScanMetrics, marker: string, depth: number): void {
  const previous = metrics.markerDepths.get(marker);
  if (previous === undefined || depth < previous) metrics.markerDepths.set(marker, depth);
}

function hasMarker(metrics: ScanMetrics, marker: string, maxDepth = Number.POSITIVE_INFINITY): boolean {
  const depth = metrics.markerDepths.get(marker);
  return depth !== undefined && depth <= maxDepth;
}

function recordMarker(metrics: ScanMetrics, rootPath: string, filePath: string, isDirectory: boolean): void {
  const relative = path.relative(rootPath, filePath);
  const depth = relative ? relative.split(path.sep).filter(Boolean).length : 0;
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  if (lower === "pyvenv.cfg") setMarkerDepth(metrics, "python-environment", depth);
  if (lower === "package.json" || lower === "pyproject.toml" || lower === "cargo.toml" || lower === "go.mod") {
    setMarkerDepth(metrics, "project-manifest", depth);
  }
  if (lower === ".git" && isDirectory) setMarkerDepth(metrics, "git-repository", depth);
  if (lower === "local state" || lower === "cookies" || lower === "login data" || lower === "history") {
    setMarkerDepth(metrics, "browser-state", depth);
  }
  if (lower === ".env" || lower.endsWith(".pem") || lower.endsWith(".key") || lower === "id_rsa" || lower === "id_ed25519") {
    setMarkerDepth(metrics, "credential-like", depth);
  }
}

function recordLargestFile(
  metrics: ScanMetrics,
  rootPath: string,
  filePath: string,
  bytes: number,
): void {
  metrics.largestFiles.push({
    name: path.basename(filePath),
    relativePath: path.relative(rootPath, filePath) || path.basename(filePath),
    allocatedBytes: bytes,
  });
  metrics.largestFiles.sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.relativePath.localeCompare(b.relativePath));
  if (metrics.largestFiles.length > MAX_LARGEST_FILES) {
    metrics.largestFiles.length = MAX_LARGEST_FILES;
  }
}

function recordStats(metrics: ScanMetrics, rootPath: string, filePath: string, stats: Stats): void {
  const bytes = allocatedBytes(stats);
  metrics.allocatedBytes += bytes;
  metrics.latestMtimeMs = Math.max(metrics.latestMtimeMs, stats.mtimeMs);
  recordMarker(metrics, rootPath, filePath, stats.isDirectory());

  if (stats.isSymbolicLink()) {
    metrics.symlinkCount += 1;
    metrics.logicalBytes += stats.size;
    return;
  }
  if (stats.isDirectory()) {
    metrics.directoryCount += 1;
    return;
  }

  metrics.fileCount += 1;
  metrics.logicalBytes += stats.size;
  const extension = path.extname(filePath).toLowerCase() || "(none)";
  const current = metrics.extensionStats.get(extension) ?? { files: 0, allocatedBytes: 0 };
  current.files += 1;
  current.allocatedBytes += bytes;
  metrics.extensionStats.set(extension, current);
  recordLargestFile(metrics, rootPath, filePath, bytes);
}

async function scanPath(rootPath: string): Promise<{ kind: FileInventoryUnit["kind"]; metrics: ScanMetrics } | null> {
  const metrics = emptyMetrics();
  let rootStats: Stats;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  recordStats(metrics, rootPath, rootPath, rootStats);
  if (rootStats.isSymbolicLink()) return { kind: "symlink", metrics };
  if (!rootStats.isDirectory()) return { kind: "file", metrics };

  const stack = [rootPath];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      metrics.errorCount += 1;
      continue;
    }
    try {
      for await (const entry of handle) {
        const entryPath = path.join(directory, entry.name);
        try {
          const stats = await lstat(entryPath);
          recordStats(metrics, rootPath, entryPath, stats);
          if (stats.isDirectory() && !stats.isSymbolicLink()) stack.push(entryPath);
        } catch {
          metrics.errorCount += 1;
        }
      }
    } catch {
      metrics.errorCount += 1;
    }
  }
  return { kind: "directory", metrics };
}

async function scanTarget(target: ScanTarget): Promise<{ kind: FileInventoryUnit["kind"]; metrics: ScanMetrics } | null> {
  if (!target.memberPaths) return await scanPath(target.absolutePath);
  const metrics = emptyMetrics();
  for (const memberPath of target.memberPaths) {
    try {
      const stats = await lstat(memberPath);
      recordStats(metrics, target.absolutePath, memberPath, stats);
    } catch (error) {
      if (!isMissing(error)) metrics.errorCount += 1;
    }
  }
  return metrics.fileCount + metrics.symlinkCount > 0 ? { kind: "collection", metrics } : null;
}

function looseFileGroup(name: string): LooseFileGroup {
  const extension = path.extname(name).toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MEDIA_EXTENSIONS.has(extension)) return "media";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (CODE_DATA_EXTENSIONS.has(extension)) return "code-data";
  return "other";
}

function defaultCategory(target: ScanTarget, kind: FileInventoryUnit["kind"], metrics: ScanMetrics): {
  category: FileUnitCategory;
  origin: FileOrigin;
  reasons: string[];
} {
  const base = path.basename(target.absolutePath);
  const lower = base.toLowerCase();
  const reasons: string[] = [];

  if (target.rootKind === "inbox") {
    return { category: "download", origin: "bridge-input", reasons: ["Bot 入站附件目录"] };
  }
  if (target.rootKind === "asr") {
    return { category: "temporary", origin: "runtime", reasons: ["语音转写工作目录"] };
  }
  if (target.collectionCategory) {
    return {
      category: target.collectionCategory,
      origin: "unknown",
      reasons: ["按类型汇总 Workspace 根目录散落文件，具体用途仍需人工确认"],
    };
  }
  if (TEMPORARY_NAMES.test(lower)) {
    return { category: "temporary", origin: "runtime", reasons: ["TaroCub 或工具管理的临时目录"] };
  }
  if (DOWNLOAD_NAMES.test(lower)) {
    return { category: "download", origin: "workspace", reasons: ["目录名称表明它用于下载或接收文件"] };
  }
  if (DELIVERABLE_NAMES.test(lower)) {
    return { category: "deliverable", origin: "workspace", reasons: ["目录名称表明它用于成果输出"] };
  }
  if (SOURCE_NAMES.test(lower)) {
    return { category: "source", origin: "workspace", reasons: ["目录名称表明它用于素材或输入"] };
  }
  if (BROWSER_NAMES.test(lower)) {
    return { category: "browser", origin: "runtime", reasons: ["目录名称表明它是浏览器 Profile"] };
  }
  if (ENVIRONMENT_NAMES.test(lower) || hasMarker(metrics, "python-environment", 1)) {
    return { category: "environment", origin: "runtime", reasons: ["顶层名称或浅层标记表明它是运行环境"] };
  }
  if (CACHE_NAMES.test(lower)) {
    return { category: "cache", origin: "runtime", reasons: ["目录名称表明它是缓存或模型存储"] };
  }
  if (hasMarker(metrics, "git-repository", 1) || hasMarker(metrics, "project-manifest", 1)) {
    return { category: "project", origin: "workspace", reasons: ["检测到项目仓库或构建清单"] };
  }
  if (hasMarker(metrics, "browser-state", 2)) {
    return { category: "browser", origin: "runtime", reasons: ["浅层目录中检测到浏览器登录态标志"] };
  }
  if (kind === "directory" && !base.startsWith(".")) {
    return { category: "project", origin: "workspace", reasons: ["Workspace 顶层工作目录"] };
  }
  if (kind === "file") {
    const extension = path.extname(base).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension) || MEDIA_EXTENSIONS.has(extension)) {
      return { category: "deliverable", origin: "unknown", reasons: ["Workspace 顶层文档或媒体文件，来源待确认"] };
    }
  }
  return { category: "unknown", origin: "unknown", reasons: ["未找到可靠的自动分类依据"] };
}

function safetyFor(
  category: FileUnitCategory,
  metrics: ScanMetrics,
  important: boolean,
  now: number,
): { safety: FileSafetyState; reasons: string[] } {
  const shallowCredential = hasMarker(metrics, "credential-like", 1);
  if (category === "browser" || shallowCredential) {
    return {
      safety: "protected",
      reasons: [shallowCredential ? "顶层包含凭据形态文件" : "浏览器登录态不得自动处理"],
    };
  }
  if (important) return { safety: "important", reasons: ["已由用户标记为重要"] };
  if (metrics.latestMtimeMs > 0 && now - metrics.latestMtimeMs <= RECENTLY_ACTIVE_MS) {
    return { safety: "active", reasons: ["最近 15 分钟内仍有修改"] };
  }
  if (category === "environment" || category === "cache") {
    return { safety: "rebuildable", reasons: ["通常可重新安装或生成，处理前仍需人工确认"] };
  }
  if (category === "temporary") {
    return { safety: "temporary", reasons: ["由 Bridge 或工具管理的临时内容"] };
  }
  return { safety: "review", reasons: ["系统无法判断用途，需要人工确认"] };
}

function topExtensions(metrics: ScanMetrics): FileInventoryExtension[] {
  return [...metrics.extensionStats.entries()]
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((a, b) => b.allocatedBytes - a.allocatedBytes || b.files - a.files || a.extension.localeCompare(b.extension))
    .slice(0, MAX_TOP_EXTENSIONS);
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function readLabels(env: { HOME?: string; USERPROFILE?: string }): Promise<Record<string, FileInventoryLabel>> {
  const root = resolveCctbRoot(env);
  if (!root) return {};
  try {
    const parsed = JSON.parse(await readFile(path.join(root, LABELS_FILENAME), "utf8")) as Partial<FileInventoryLabelsFile>;
    if (parsed.version !== 1 || !parsed.units || typeof parsed.units !== "object") return {};
    const labels: Record<string, FileInventoryLabel> = {};
    for (const [unitId, raw] of Object.entries(parsed.units)) {
      if (!/^[a-f0-9]{24}$/.test(unitId) || !raw || typeof raw !== "object") continue;
      const candidate = raw as Partial<FileInventoryLabel>;
      const category = validCategory(candidate.category) ? candidate.category : undefined;
      const important = candidate.important === true;
      const note = typeof candidate.note === "string" ? candidate.note.trim().slice(0, 500) : "";
      if (!category && !important && !note) continue;
      labels[unitId] = {
        ...(category ? { category } : {}),
        ...(important ? { important: true } : {}),
        ...(note ? { note } : {}),
        updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
      };
    }
    return labels;
  } catch {
    return {};
  }
}

async function enumerateTargets(
  env: { HOME?: string; USERPROFILE?: string },
  isProcessAlive?: IsProcessAlive,
): Promise<{ targets: ScanTarget[]; warnings: string[] }> {
  const instances = await listCctbInstances(env, isProcessAlive);
  const warnings: string[] = [];
  const workspaceGroups = new Map<string, { root: string; instances: string[] }>();
  const stateTargets: ScanTarget[] = [];

  for (const instance of instances) {
    const config = await loadInstanceConfig(instance.stateDir);
    const configuredWorkspace = resolveInstanceWorkspacePath(config) ?? path.join(instance.stateDir, "workspace");
    const workspace = await canonicalPath(configuredWorkspace);
    const home = env.HOME ?? env.USERPROFILE;
    const canonicalHome = home ? await canonicalPath(home) : undefined;
    if (workspace === path.parse(workspace).root || workspace === canonicalHome) {
      warnings.push(`${instance.name}: workspace 范围过大，已跳过扫描 ${workspace}`);
    } else {
      const current = workspaceGroups.get(workspace);
      if (current) {
        current.instances.push(instance.name);
      } else {
        workspaceGroups.set(workspace, { root: workspace, instances: [instance.name] });
      }
    }

    for (const [rootKind, statePath] of [
      ["inbox", path.join(instance.stateDir, "inbox")],
      ["asr", path.join(instance.stateDir, "asr-jobs")],
    ] as const) {
      try {
        const stats = await lstat(statePath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
        stateTargets.push({
          absolutePath: statePath,
          relativePath: path.relative(instance.stateDir, statePath),
          rootKind,
          instances: [instance.name],
        });
      } catch (error) {
        if (!isMissing(error)) warnings.push(`${instance.name}: 无法读取 ${statePath}`);
      }
    }
  }

  const workspaceTargets: ScanTarget[] = [];
  for (const group of workspaceGroups.values()) {
    const looseFiles = new Map<LooseFileGroup, string[]>();
    let handle;
    try {
      handle = await opendir(group.root);
    } catch (error) {
      warnings.push(`${group.instances.join(", ")}: 无法扫描 workspace ${group.root}${isMissing(error) ? "（不存在）" : ""}`);
      continue;
    }
    try {
      for await (const entry of handle) {
        if (entry.isFile()) {
          const groupName = looseFileGroup(entry.name);
          const members = looseFiles.get(groupName) ?? [];
          members.push(path.join(group.root, entry.name));
          looseFiles.set(groupName, members);
          continue;
        }
        workspaceTargets.push({
          absolutePath: path.join(group.root, entry.name),
          relativePath: entry.name,
          rootKind: "workspace",
          instances: [...group.instances].sort(),
        });
      }
    } catch {
      warnings.push(`${group.instances.join(", ")}: workspace 列举不完整 ${group.root}`);
    }
    for (const [groupName, memberPaths] of looseFiles) {
      const definition = LOOSE_FILE_GROUPS[groupName];
      workspaceTargets.push({
        absolutePath: group.root,
        idKey: `${group.root}\0loose-files:${groupName}`,
        displayName: definition.name,
        memberPaths: memberPaths.sort((a, b) => a.localeCompare(b)),
        collectionCategory: definition.category,
        relativePath: `根目录散落文件/${definition.relativeName}`,
        rootKind: "workspace",
        instances: [...group.instances].sort(),
      });
    }
  }

  return {
    targets: [...workspaceTargets, ...stateTargets]
      .sort((a, b) => a.absolutePath.localeCompare(b.absolutePath)),
    warnings,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeBuckets(units: FileInventoryUnit[], key: "category" | "safety"): FileInventoryBucket[] {
  const buckets = new Map<string, FileInventoryBucket>();
  for (const unit of units) {
    const name = unit[key];
    const bucket = buckets.get(name) ?? { key: name, units: 0, allocatedBytes: 0 };
    bucket.units += 1;
    bucket.allocatedBytes += unit.allocatedBytes;
    buckets.set(name, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.key.localeCompare(b.key));
}

export async function collectFileInventory(
  env: { HOME?: string; USERPROFILE?: string },
  options: { isProcessAlive?: IsProcessAlive; now?: number } = {},
): Promise<FileInventoryResult> {
  const now = options.now ?? Date.now();
  const [{ targets, warnings }, labels] = await Promise.all([
    enumerateTargets(env, options.isProcessAlive),
    readLabels(env),
  ]);

  const scanned = await mapWithConcurrency(targets, 4, async (target): Promise<FileInventoryUnit | null> => {
    let result;
    try {
      result = await scanTarget(target);
    } catch {
      warnings.push(`${target.instances.join(", ")}: 无法扫描 ${target.absolutePath}`);
      return null;
    }
    if (!result) return null;

    const id = fileInventoryId(target.idKey ?? target.absolutePath);
    const label = labels[id];
    const automatic = defaultCategory(target, result.kind, result.metrics);
    const category = label?.category ?? automatic.category;
    const important = label?.important === true;
    const safety = safetyFor(category, result.metrics, important, now);
    return {
      id,
      name: target.displayName ?? path.basename(target.absolutePath),
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      rootKind: target.rootKind,
      instances: target.instances,
      kind: result.kind,
      category,
      categorySource: label?.category ? "user" : "system",
      safety: safety.safety,
      origin: automatic.origin,
      allocatedBytes: result.metrics.allocatedBytes,
      logicalBytes: result.metrics.logicalBytes,
      fileCount: result.metrics.fileCount,
      directoryCount: result.metrics.directoryCount,
      symlinkCount: result.metrics.symlinkCount,
      lastModifiedAt: new Date(result.metrics.latestMtimeMs || now).toISOString(),
      topExtensions: topExtensions(result.metrics),
      largestFiles: result.metrics.largestFiles,
      reasons: [...automatic.reasons, ...safety.reasons],
      important,
      ...(label?.note ? { note: label.note } : {}),
      partial: result.metrics.errorCount > 0,
      errorCount: result.metrics.errorCount,
    };
  });

  const units = scanned
    .filter((unit): unit is FileInventoryUnit => unit !== null)
    .sort((a, b) => b.allocatedBytes - a.allocatedBytes || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date(now).toISOString(),
    totalAllocatedBytes: units.reduce((sum, unit) => sum + unit.allocatedBytes, 0),
    totalLogicalBytes: units.reduce((sum, unit) => sum + unit.logicalBytes, 0),
    unitCount: units.length,
    byCategory: summarizeBuckets(units, "category"),
    bySafety: summarizeBuckets(units, "safety"),
    units,
    warnings,
  };
}

function validCategory(value: unknown): value is FileUnitCategory {
  return typeof value === "string" && (FILE_UNIT_CATEGORIES as readonly string[]).includes(value);
}

export async function updateFileInventoryLabel(
  env: { HOME?: string; USERPROFILE?: string },
  input: { unitId: string; category?: unknown; important?: unknown; note?: unknown },
): Promise<FileInventoryLabel | null> {
  if (!/^[a-f0-9]{24}$/.test(input.unitId)) throw new Error("invalid file unit id");
  if (input.category !== undefined && input.category !== null && !validCategory(input.category)) {
    throw new Error("invalid file category");
  }
  if (input.important !== undefined && typeof input.important !== "boolean") {
    throw new Error("important must be boolean");
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    throw new Error("note must be a string");
  }

  const root = resolveCctbRoot(env);
  if (!root) throw new Error("home directory is unavailable");
  const filePath = path.join(root, LABELS_FILENAME);
  await mkdir(root, { recursive: true, mode: STATE_DIR_MODE });
  return await withFileMutex(filePath, async () => {
    const units = await readLabels(env);
    const previous = units[input.unitId] ?? { updatedAt: new Date(0).toISOString() };
    const next: FileInventoryLabel = {
      ...(previous.category ? { category: previous.category } : {}),
      ...(previous.important ? { important: true } : {}),
      ...(previous.note ? { note: previous.note } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (input.category !== undefined) {
      if (input.category === null) delete next.category;
      else next.category = input.category as FileUnitCategory;
    }
    if (input.important !== undefined) {
      if (input.important) next.important = true;
      else delete next.important;
    }
    if (input.note !== undefined) {
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
      if (note) next.note = note;
      else delete next.note;
    }

    const hasContent = Boolean(next.category || next.important || next.note);
    if (hasContent) units[input.unitId] = next;
    else delete units[input.unitId];
    const payload: FileInventoryLabelsFile = { version: 1, units };
    const temporaryPath = `${filePath}.tmp.${process.pid}`;
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: STATE_FILE_MODE });
    await rename(temporaryPath, filePath);
    return hasContent ? next : null;
  });
}

export async function revealFileInventoryUnit(
  env: { HOME?: string; USERPROFILE?: string },
  unitId: string,
  options: {
    isProcessAlive?: IsProcessAlive;
    reveal?: (absolutePath: string) => void;
  } = {},
): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/.test(unitId)) return false;
  const inventory = await collectFileInventory(env, { isProcessAlive: options.isProcessAlive });
  const unit = inventory.units.find((candidate) => candidate.id === unitId);
  if (!unit) return false;
  if (options.reveal) {
    options.reveal(unit.absolutePath);
    return true;
  }
  if (process.platform !== "darwin") return false;
  const child = spawn("open", ["-R", unit.absolutePath], { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}
