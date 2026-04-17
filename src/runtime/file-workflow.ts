import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import AdmZip from "adm-zip";

import type { NormalizedTelegramAttachment } from "../telegram/update-normalizer.js";
import {
  FileWorkflowStore,
  type FileWorkflowKind,
  type FileWorkflowRecord,
} from "../state/file-workflow-store.js";

export interface DownloadedAttachment {
  attachment: NormalizedTelegramAttachment;
  localPath: string;
}

export interface FileWorkflowDirectResult {
  kind: "direct";
  text: string;
  files: string[];
  workflowRecordId?: string;
  failureHint?: string;
  suppressReplyContext?: boolean;
}

export interface FileWorkflowReplyResult {
  kind: "reply";
  text: string;
  workflowRecordId?: string;
  failureHint?: string;
}

export type FileWorkflowResult = FileWorkflowDirectResult | FileWorkflowReplyResult;

export class FileWorkflowPreparationError extends Error {
  readonly workflowRecordId: string;

  constructor(workflowRecordId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FileWorkflowPreparationError";
    this.workflowRecordId = workflowRecordId;
    this.cause = cause;
  }
}

const TEXT_DOCUMENT_EXTENSIONS = new Set([".txt", ".md"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const MAX_DOCUMENT_TEXT_CHARS = 12_000;
const MAX_TREE_LINES = 40;
const ARCHIVE_CONTINUE_HINT = 'Reply "继续分析" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.';
const TARGETED_ARCHIVE_RETRY_HINT = 'Retry this specific archive from its original summary: press Continue Analysis again there or reply "继续分析" to that summary.';
const MAX_ARCHIVE_SUMMARY_DELIVERY_CHARS = 3900;
const MAX_TOTAL_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_ACTIVE_WORKFLOWS_PER_CHAT = 3;

function isActiveWorkflowStatus(status: FileWorkflowRecord["status"]): boolean {
  return status === "preparing" || status === "processing" || status === "awaiting_continue";
}

function resolveWorkspaceUploadsDir(stateDir: string): string {
  return path.join(stateDir, "workspace", ".telegram-files");
}

function extensionForAttachment(downloaded: DownloadedAttachment): string {
  if (downloaded.attachment.kind === "photo") {
    return ".jpg";
  }

  return path.extname(downloaded.localPath).toLowerCase();
}

function classifyAttachment(downloaded: DownloadedAttachment): FileWorkflowKind {
  const extension = extensionForAttachment(downloaded);
  if (downloaded.attachment.kind === "photo" || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return "archive";
  }

  return "document";
}

async function stageAttachmentFiles(stateDir: string, uploadId: string, files: DownloadedAttachment[]): Promise<string[]> {
  const stagedRoot = path.join(resolveWorkspaceUploadsDir(stateDir), uploadId, "input");
  await mkdir(stagedRoot, { recursive: true });

  const staged: string[] = [];
  for (const file of files) {
    const destination = path.join(stagedRoot, path.basename(file.localPath));
    await copyFile(file.localPath, destination);
    staged.push(destination);
  }

  return staged;
}

async function extractPdfText(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath);
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = result.text?.trim();
    return text ? text.slice(0, MAX_DOCUMENT_TEXT_CHARS) : null;
  } catch {
    return null;
  }
}

async function summarizeDocument(filePath: string): Promise<{ summaryText: string; derivedFiles: string[] }> {
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_DOCUMENT_EXTENSIONS.has(extension)) {
    const text = (await readFile(filePath, "utf8")).slice(0, MAX_DOCUMENT_TEXT_CHARS);
    return {
      summaryText: text,
      derivedFiles: [],
    };
  }

  if (extension === ".pdf") {
    const extracted = await extractPdfText(filePath);
    return {
      summaryText: extracted ?? "[PDF text extraction unavailable for this file]",
      derivedFiles: [],
    };
  }

  return {
    summaryText: `[Unsupported document preview for ${path.basename(filePath)}]`,
    derivedFiles: [],
  };
}

function isContinueAnalysisCommand(text: string): {
  matches: boolean;
  extraInstructions: string;
  targetUploadId?: string;
  malformedTarget?: boolean;
  isSlashCommand?: boolean;
} {
  const trimmed = text.trim();
  const slashCommandPattern = /^\/continue(?:@\w+)?(?:\s+(.*))?$/i;
  const slashMatch = trimmed.match(slashCommandPattern);
  if (slashMatch) {
    const remainder = slashMatch[1]?.trim() ?? "";
    const targetedMatch = remainder.match(/^--upload\s+(\S+)(?:\s+(.*))?$/i);
    if (targetedMatch) {
      return {
        matches: true,
        targetUploadId: targetedMatch[1],
        extraInstructions: targetedMatch[2]?.trim() ?? "",
        isSlashCommand: true,
      };
    }

    if (/^--upload(?:\s|$)/i.test(remainder)) {
      return {
        matches: true,
        extraInstructions: "",
        malformedTarget: true,
        isSlashCommand: true,
      };
    }

    return {
      matches: true,
      extraInstructions: remainder,
      isSlashCommand: true,
    };
  }

  const pattern = /^(继续分析|分析这个|继续|分析压缩包)(?:[\s:：-]+(.*))?$/i;
  const match = trimmed.match(pattern);
  if (!match) {
    return { matches: false, extraInstructions: "" };
  }

  return {
    matches: true,
    extraInstructions: (match[2] ?? "").trim(),
  };
}

async function extractArchiveToDirectory(archivePath: string, targetDir: string): Promise<void> {
  const zip = new AdmZip(archivePath);
  const targetRoot = path.resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });

  const entries = zip.getEntries();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) {
      totalBytes += entry.header.size;
      if (totalBytes > MAX_TOTAL_ARCHIVE_BYTES) {
        throw new Error(`Archive exceeds maximum extraction size of ${MAX_TOTAL_ARCHIVE_BYTES / (1024 * 1024)}MB`);
      }
    }
  }

  for (const entry of entries) {
    const normalizedEntryPath = path.normalize(entry.entryName).replace(/^([/\\])+/, "");
    if (!normalizedEntryPath || normalizedEntryPath === ".") {
      continue;
    }

    const destinationPath = path.resolve(targetRoot, normalizedEntryPath);
    const relativeDestination = path.relative(targetRoot, destinationPath);
    if (relativeDestination === "" || relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) {
      throw new Error(`Archive entry escapes target directory: ${entry.entryName}`);
    }

    if (entry.isDirectory) {
      await mkdir(destinationPath, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, entry.getData());
  }
}

async function collectTreeLines(rootDir: string, maxLines = MAX_TREE_LINES): Promise<string[]> {
  const lines: string[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    if (lines.length >= maxLines) {
      return;
    }

    const entries = (await readdir(currentDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (lines.length >= maxLines) {
        return;
      }

      const nextPath = path.join(currentDir, entry.name);
      const marker = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${marker}`);
      if (entry.isDirectory()) {
        await walk(nextPath, `${prefix}  `);
      }
    }
  }

  await walk(rootDir, "");
  return lines;
}

async function summarizeArchive(archivePath: string, extractedRoot: string): Promise<{ summary: string; topExtensions: Array<[string, number]> }> {
  await extractArchiveToDirectory(archivePath, extractedRoot);

  let fileCount = 0;
  const extensionCounts = new Map<string, number>();
  const keyFiles = new Set<string>();

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
        continue;
      }

      fileCount += 1;
      const extension = path.extname(entry.name).toLowerCase() || "[no extension]";
      extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
      if (/^(package\.json|README\.md|tsconfig\.json|requirements\.txt)$/i.test(entry.name)) {
        keyFiles.add(entry.name);
      }
    }
  }

  await walk(extractedRoot);
  const treeLines = await collectTreeLines(extractedRoot);
  const topExtensions = [...extensionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5);

  const summaryLines = [
    `Archive summary: ${path.basename(archivePath)}`,
    `Files: ${fileCount}`,
    keyFiles.size > 0 ? `Key files: ${[...keyFiles].join(", ")}` : "Key files: none detected",
    topExtensions.length > 0
      ? `Top extensions: ${topExtensions.map(([extension, count]) => `${extension} (${count})`).join(", ")}`
      : "Top extensions: none",
    "",
    "Tree:",
    ...treeLines,
    "",
    ARCHIVE_CONTINUE_HINT,
  ];

  return {
    summary: summaryLines.join("\n"),
    topExtensions,
  };
}

export function boundArchiveSummaryForTelegram(
  summary: string,
  limit = MAX_ARCHIVE_SUMMARY_DELIVERY_CHARS,
): string {
  if (summary.length <= limit) {
    return summary;
  }

  const truncationNotice = "[Archive summary truncated for Telegram delivery.]";
  const suffix = `\n\n${truncationNotice}\n${ARCHIVE_CONTINUE_HINT}`;
  const prefixLimit = limit - suffix.length;

  if (prefixLimit <= 0) {
    return suffix.slice(suffix.length - limit);
  }

  return `${summary.slice(0, prefixLimit).trimEnd()}${suffix}`;
}

function createArchiveFailureSummary(archivePath: string, _extractedRoot: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `Archive summary failed: ${path.basename(archivePath)}`,
    `Failure: ${detail}`,
  ].join("\n");
}

export async function prepareAttachmentWorkflow(input: {
  stateDir: string;
  chatId: number;
  userId: number;
  text: string;
  downloadedAttachments: DownloadedAttachment[];
}): Promise<FileWorkflowResult | null> {
  if (input.downloadedAttachments.length === 0) {
    return null;
  }

  const kinds = input.downloadedAttachments.map(classifyAttachment);
  const uniqueKinds = [...new Set(kinds)];
  const uploadId = randomUUID();
  const store = new FileWorkflowStore(input.stateDir);

  const existingState = await store.load();
  const activeForChat = existingState.records.filter(
    (r) => r.chatId === input.chatId && isActiveWorkflowStatus(r.status),
  );
  if (activeForChat.length >= MAX_ACTIVE_WORKFLOWS_PER_CHAT) {
    return {
      kind: "reply",
      text: "Too many active file tasks for this chat. Wait for current tasks to finish or use /reset.",
    };
  }

  const stagedFiles = await stageAttachmentFiles(input.stateDir, uploadId, input.downloadedAttachments);
  const now = new Date().toISOString();

  if (uniqueKinds.length === 1 && uniqueKinds[0] === "archive" && stagedFiles.length === 1) {
    const extractedRoot = path.join(resolveWorkspaceUploadsDir(input.stateDir), uploadId, "extracted");
    const record: FileWorkflowRecord = {
      uploadId,
      chatId: input.chatId,
      userId: input.userId,
      kind: "archive",
      status: "preparing",
      sourceFiles: stagedFiles,
      derivedFiles: [],
      summary: `Preparing archive summary for ${path.basename(stagedFiles[0]!)}`,
      extractedPath: extractedRoot,
      createdAt: now,
      updatedAt: now,
    };
    await store.append(record);

    try {
      const { summary } = await summarizeArchive(stagedFiles[0]!, extractedRoot);
      await store.update(uploadId, (current) => {
        current.status = "awaiting_continue";
        current.summary = summary;
      });
      return {
        kind: "reply",
        text: summary,
        workflowRecordId: uploadId,
      };
    } catch (error) {
      try {
        await store.update(uploadId, (current) => {
          current.status = "failed";
          current.summary = createArchiveFailureSummary(stagedFiles[0]!, extractedRoot, error);
        });
      } catch {
        throw new FileWorkflowPreparationError(uploadId, error);
      }

      throw new FileWorkflowPreparationError(uploadId, error);
    }
  }

  const documentSections: string[] = [];
  const imageSections: string[] = [];

  for (let index = 0; index < input.downloadedAttachments.length; index++) {
    const downloaded = input.downloadedAttachments[index]!;
    const stagedPath = stagedFiles[index]!;
    const kind = classifyAttachment(downloaded);

    if (kind === "document") {
      const summary = await summarizeDocument(stagedPath);
      documentSections.push(
        `[Document Extract]\nFile: ${path.basename(stagedPath)}\nPath: ${stagedPath}\n${summary.summaryText}`,
      );
    } else if (kind === "image") {
      imageSections.push(`- ${stagedPath}`);
    }
  }

  const promptSections: string[] = [input.text.trim() || "Please analyze the uploaded files."];
  if (documentSections.length > 0) {
    promptSections.push(...documentSections);
  }
  if (imageSections.length > 0) {
    promptSections.push(
      `[Image Uploads]\n${imageSections.join("\n")}\nAnalyze these uploaded images directly if your engine supports local image inspection.`,
    );
  }

  const record: FileWorkflowRecord = {
    uploadId,
    chatId: input.chatId,
    userId: input.userId,
    kind: uniqueKinds.length === 1 ? uniqueKinds[0]! : "document",
    status: "processing",
    sourceFiles: stagedFiles,
    derivedFiles: [],
    summary: promptSections.join("\n\n"),
    createdAt: now,
    updatedAt: now,
  };
  await store.append(record);

  return {
    kind: "direct",
    text: promptSections.join("\n\n"),
    files: stagedFiles,
    workflowRecordId: uploadId,
  };
}

export async function prepareArchiveContinueWorkflow(input: {
  stateDir: string;
  chatId: number;
  text: string;
  replyContext?: {
    messageId: number;
    text: string;
  };
}): Promise<FileWorkflowResult | null> {
  const { matches, extraInstructions, targetUploadId, malformedTarget, isSlashCommand } = isContinueAnalysisCommand(input.text);
  if (!matches) {
    return null;
  }

  if (malformedTarget) {
    return {
      kind: "reply",
      text: 'Malformed continue command. Use /continue, the Continue Analysis button, or reply "继续分析" to the archive summary.',
    };
  }

  const store = new FileWorkflowStore(input.stateDir);
  const hasReplyTarget = targetUploadId === undefined && input.replyContext?.messageId !== undefined;
  const explicitTarget = targetUploadId !== undefined || hasReplyTarget;
  const archiveRecord = await store.beginArchiveContinuation({
    chatId: input.chatId,
    uploadId: targetUploadId,
    summaryMessageId: targetUploadId ? undefined : input.replyContext?.messageId,
  });
  if (!archiveRecord) {
    if (explicitTarget) {
      const targetedRecord = await store.getArchiveContinuationTarget({
        chatId: input.chatId,
        uploadId: targetUploadId,
        summaryMessageId: targetUploadId ? undefined : input.replyContext?.messageId,
      });

      if (targetedRecord?.status === "processing") {
        return {
          kind: "reply",
          text: "That archive is already being processed in this chat.",
        };
      }

      if (targetedRecord?.status === "completed") {
        return {
          kind: "reply",
          text: "That archive has already completed continued analysis in this chat.",
        };
      }
    }

    // A bare Chinese phrase ("继续" / "继续分析") with no pending archive
    // is almost certainly normal conversation, not a bridge command —
    // passthrough so Claude / Codex can respond. Slash commands are kept
    // intercepted: /continue is an explicit request for bridge behavior
    // and deserves a clear "nothing waiting" reply rather than being
    // forwarded to the engine as a literal prompt.
    if (!explicitTarget && !isSlashCommand) {
      return null;
    }

    return {
      kind: "reply",
      text: explicitTarget
        ? "That archive is no longer waiting for continued analysis in this chat."
        : "There is no archive waiting for continued analysis in this chat.",
    };
  }

  const prompt = [
    extraInstructions || "Continue analyzing the uploaded archive.",
    "",
    `[Archive Analysis Context]\nExtracted files live under: ${archiveRecord.extractedPath}\n\n${archiveRecord.summary}`,
  ].join("\n");

  return {
    kind: "direct",
    text: prompt,
    files: [],
    workflowRecordId: archiveRecord.uploadId,
    failureHint: explicitTarget ? TARGETED_ARCHIVE_RETRY_HINT : undefined,
    suppressReplyContext: input.replyContext?.messageId !== undefined,
  };
}
