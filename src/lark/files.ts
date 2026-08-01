import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
  type ArchiveSummaryData,
  type DownloadedAttachment,
  type FileWorkflowResult,
} from "../runtime/file-workflow.js";
import { ELEMENT_CONTENT_MAX_BYTES, truncateBytes } from "./card-renderer.js";
import type { Locale } from "../telegram/message-renderer.js";
import type { NormalizedTelegramAttachment } from "../telegram/update-normalizer.js";
import type { LarkChannelLike, LarkMessageResourceType, LarkRawClientLike } from "./types.js";
import type {
  LarkNormalizedAttachment,
  LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";

export type DownloadedLarkAttachment = {
  attachment: LarkNormalizedAttachment;
  localPath: string;
};

/**
 * Largest inbound attachment this bridge will pull out of Feishu.
 *
 * Feishu's `im.v1.messageResource.get` refuses very large resources with a bare
 * HTTP 400, and the whole body is buffered in memory here before it is written
 * to disk — so a 100 MB+ send used to surface as the generic "准备飞书消息时失败"
 * after a pointless download attempt. 100 MB is the documented bridge-side cap:
 * anything above it is refused up front with an actionable message.
 */
export const LARK_INBOUND_ATTACHMENT_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * An inbound Feishu attachment the bridge refuses to download because it is
 * over {@link LARK_INBOUND_ATTACHMENT_LIMIT_BYTES}. Carries the numbers so the
 * Lark error renderer can say WHICH file and HOW big instead of a generic
 * prepare failure. The `larkAttachmentTooLarge` brand lets `src/lark/errors.ts`
 * recognize it without importing this module.
 */
export class LarkAttachmentTooLargeError extends Error {
  readonly larkAttachmentTooLarge = true;

  constructor(
    readonly attachmentKind: LarkNormalizedAttachment["kind"],
    readonly attachmentBytes: number,
    readonly limitBytes: number,
    readonly attachmentName?: string,
  ) {
    super(
      `Lark attachment is too large to download: ${attachmentKind}${attachmentName ? ` ${attachmentName}` : ""} ` +
      `is ${formatLarkFileSize(attachmentBytes)}, over the ${formatLarkFileSize(limitBytes)} inbound limit`,
    );
    this.name = "LarkAttachmentTooLargeError";
  }
}

export function isLarkAttachmentTooLargeError(error: unknown): error is LarkAttachmentTooLargeError {
  return error instanceof Error && (error as { larkAttachmentTooLarge?: unknown }).larkAttachmentTooLarge === true;
}

export function formatLarkFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * The size Feishu advertised for this attachment, when it is known.
 *
 * Feishu's file/media message content carries `file_size`, but the normalizer
 * currently keeps only file_key/file_name — so this reads the field
 * structurally: the moment `fileSize` is plumbed onto the normalized
 * attachment, the pre-check below starts refusing oversize sends BEFORE the
 * download instead of after it.
 */
function advertisedAttachmentBytes(attachment: LarkNormalizedAttachment): number | undefined {
  const value = (attachment as { fileSize?: unknown }).fileSize;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/**
 * Refuse an oversize inbound attachment. Called twice: once with the size
 * Feishu advertised (no download at all) and once with the materialized body
 * length (the backstop when no size was advertised).
 */
export function assertLarkAttachmentDownloadable(
  attachment: LarkNormalizedAttachment,
  bytes: number | undefined,
  limitBytes: number = LARK_INBOUND_ATTACHMENT_LIMIT_BYTES,
): void {
  if (typeof bytes === "number" && bytes > limitBytes) {
    throw new LarkAttachmentTooLargeError(attachment.kind, bytes, limitBytes, attachment.fileName);
  }
}

export async function prepareLarkFileWorkflow(input: {
  stateDir: string;
  normalized: LarkNormalizedBridgeMessage;
  commandText: string;
  downloadedAttachments: DownloadedLarkAttachment[];
}): Promise<FileWorkflowResult | null> {
  if (input.downloadedAttachments.length === 1 && isDownloadedLarkArchive(input.downloadedAttachments[0]!)) {
    return await prepareAttachmentWorkflow({
      stateDir: input.stateDir,
      chatId: input.normalized.bridgeChatId,
      userId: input.normalized.bridgeUserId,
      text: input.normalized.text,
      downloadedAttachments: input.downloadedAttachments.map(toWorkflowAttachment),
    });
  }

  if (input.downloadedAttachments.length === 0) {
    return await prepareArchiveContinueWorkflow({
      stateDir: input.stateDir,
      chatId: input.normalized.bridgeChatId,
      text: input.commandText,
    });
  }

  return null;
}

function isDownloadedLarkArchive(downloaded: DownloadedLarkAttachment): boolean {
  return downloaded.attachment.kind === "file" && path.extname(downloaded.localPath).toLowerCase() === ".zip";
}

function toWorkflowAttachment(downloaded: DownloadedLarkAttachment): DownloadedAttachment {
  const kind: NormalizedTelegramAttachment["kind"] =
    downloaded.attachment.kind === "image"
      ? "photo"
      : downloaded.attachment.kind === "audio"
        ? "audio"
        : downloaded.attachment.kind === "video" ? "video" : "document";
  return {
    localPath: downloaded.localPath,
    attachment: {
      fileId: downloaded.attachment.fileKey,
      kind,
      fileName: downloaded.attachment.fileName ?? path.basename(downloaded.localPath),
    },
  };
}

export async function downloadLarkAttachments(input: {
  channel: LarkChannelLike;
  stateDir: string;
  messageId: string;
  attachments: LarkNormalizedAttachment[];
}): Promise<DownloadedLarkAttachment[]> {
  if (input.attachments.length === 0) {
    return [];
  }
  const dir = path.join(input.stateDir, "workspace", ".lark-files", safeSegment(input.messageId), "input");
  await mkdir(dir, { recursive: true });
  const files: DownloadedLarkAttachment[] = [];
  const usedNames = new Set<string>();
  for (const [index, attachment] of input.attachments.entries()) {
    // Pre-check on the advertised size: never spend a download (and a full
    // in-memory buffer) on a file Feishu will refuse anyway.
    assertLarkAttachmentDownloadable(attachment, advertisedAttachmentBytes(attachment));
    const body = await downloadLarkAttachmentBody(input.channel, attachment.sourceMessageId ?? input.messageId, attachment);
    // Backstop for the (current) case where no size was advertised: the body is
    // already in memory, so refuse before it is persisted and handed downstream.
    assertLarkAttachmentDownloadable(attachment, body.length);
    const fileName = attachment.fileName ?? `${attachment.kind}-${index + 1}${defaultExtension(attachment.kind)}`;
    // A merged attachment burst downloads several messages' files into ONE
    // directory — same-named files (e.g. two cameras' IMG_001.jpg) would
    // silently overwrite each other. Suffix duplicates instead.
    let safeName = safeFileName(fileName);
    if (usedNames.has(safeName)) {
      const ext = path.extname(safeName);
      const stem = safeName.slice(0, safeName.length - ext.length);
      let counter = 2;
      while (usedNames.has(`${stem}-${counter}${ext}`)) {
        counter += 1;
      }
      safeName = `${stem}-${counter}${ext}`;
    }
    usedNames.add(safeName);
    const filePath = path.join(dir, safeName);
    await writeFile(filePath, body);
    files.push({ attachment, localPath: filePath });
  }
  return files;
}

async function downloadLarkAttachmentBody(
  channel: LarkChannelLike,
  messageId: string,
  attachment: LarkNormalizedAttachment,
): Promise<Buffer> {
  try {
    return await requestLarkAttachmentBody(channel, messageId, attachment);
  } catch (error) {
    // The SDK surfaces a refused resource as a bare HTTP 400, which used to
    // fall through classifyFailure into the generic "准备飞书消息时失败".
    // Name the failure so it classifies as file-workflow and the user is told
    // to try a different/smaller file.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Lark attachment download failed for ${attachment.kind}` +
      `${attachment.fileName ? ` ${attachment.fileName}` : ""}: ${detail}`,
    );
  }
}

async function requestLarkAttachmentBody(
  channel: LarkChannelLike,
  messageId: string,
  attachment: LarkNormalizedAttachment,
): Promise<Buffer> {
  const rawClient = (channel as { rawClient?: LarkRawClientLike }).rawClient;
  const getMessageResource = rawClient?.im?.v1?.messageResource?.get;
  if (getMessageResource) {
    const resourceType: LarkMessageResourceType = attachment.kind === "image" ? "image" : "file";
    const response = await getMessageResource({
      path: {
        message_id: messageId,
        file_key: attachment.fileKey,
      },
      params: {
        type: resourceType,
      },
    });
    return await readableToBuffer(response.getReadableStream());
  }

  const downloadType = attachment.kind === "image" ? "image" : "file";
  return await channel.downloadResource(attachment.fileKey, downloadType);
}

async function readableToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Inbound attachments used to be deleted the moment their turn finished, which
 * broke the operator's actual usage: send a file, let the bot handle it, then
 * refer back to it a turn later ("用刚才那个文件…") — the recorded path was
 * already gone. Downloads now live for a retention window instead, so
 * cross-turn references keep working, and expired ones are swept here.
 * `retentionDays` 0 restores the old delete-immediately behaviour.
 */
export const DEFAULT_LARK_INBOUND_RETENTION_DAYS = 3;

export function larkInboundRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat((env.LARK_INBOUND_FILE_RETENTION_DAYS ?? "").trim());
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LARK_INBOUND_RETENTION_DAYS;
}

export async function cleanupLarkMessageArtifacts(
  stateDir: string,
  messageId: string,
  retentionDays: number = larkInboundRetentionDays(),
): Promise<void> {
  const root = path.join(stateDir, "workspace", ".lark-files");
  if (retentionDays <= 0) {
    await rm(path.join(root, safeSegment(messageId)), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    return;
  }
  await pruneLarkInboundFileDirs(root, retentionDays);
}

/**
 * Best-effort sweep of expired `.lark-files/<messageId>/` dirs, run at each
 * turn end (same self-maintaining pattern as pruneCloudAsrJobDirs). Never
 * throws: an undeletable dir must not fail the turn that triggered the sweep.
 */
export async function pruneLarkInboundFileDirs(rootDir: string, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  let pruned = 0;
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(rootDir, entry.name);
      try {
        const stats = await stat(fullPath);
        if (stats.mtimeMs >= cutoff) {
          continue;
        }
        await rm(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
        pruned += 1;
      } catch {
        // One undeletable dir must never block the rest.
      }
    }
  } catch {
    // No downloads yet, or an unreadable root — nothing to sweep.
  }
  return pruned;
}

export function boundLarkArchiveSummary(text: string): string {
  return boundArchiveSummaryForTelegram(text);
}

// Keep the rendered card body well under Feishu's per-element markdown limit
// (ErrCode 11310). CJK counts ~3 bytes, so cap the displayed tree generously.
const ARCHIVE_CARD_TREE_MAX_LINES = 24;
const ARCHIVE_CARD_BODY_MAX = 2000;

/**
 * The localized summary body shared by the card and the plain-text fallback, so
 * the two never drift. `boldHeader` wraps the title label in ** for the card's
 * markdown element; the plain-text fallback passes false. Bounded by chars (to
 * stay compact) then bytes (same Feishu per-element limit as every Lark card).
 */
function archiveSummaryBody(data: ArchiveSummaryData, en: boolean, boldHeader: boolean): string {
  const treeLines = data.treeLines.slice(0, ARCHIVE_CARD_TREE_MAX_LINES);
  const treeTruncated = data.treeLines.length > treeLines.length;
  const extensions = data.topExtensions.length > 0
    ? data.topExtensions.map(([extension, count]) => `${extension} (${count})`).join(", ")
    : (en ? "none" : "无");
  const keyFiles = data.keyFiles.length > 0
    ? data.keyFiles.join(", ")
    : (en ? "none detected" : "未检测到");

  const label = en ? "📦 Archive Summary" : "📦 压缩包摘要";
  const lines = [
    `${boldHeader ? `**${label}**` : label} · ${data.archiveName}`,
    en ? `Files: ${data.fileCount}` : `文件数：${data.fileCount}`,
    en ? `Key files: ${keyFiles}` : `关键文件：${keyFiles}`,
    en ? `Top extensions: ${extensions}` : `主要类型：${extensions}`,
    "",
    en ? "Tree:" : "目录：",
    ...treeLines,
    ...(treeTruncated ? [en ? `… (+${data.treeLines.length - treeLines.length} more)` : `… (还有 ${data.treeLines.length - treeLines.length} 项)`] : []),
  ];
  let content = lines.join("\n");
  if (content.length > ARCHIVE_CARD_BODY_MAX) {
    content = `${content.slice(0, ARCHIVE_CARD_BODY_MAX)}\n…`;
  }
  return truncateBytes(content, ELEMENT_CONTENT_MAX_BYTES);
}

/**
 * Plain-text localized archive summary — the fallback when the card itself can't
 * be delivered. Keeps the operator on the same short, localized summary instead
 * of dropping back to the English Telegram blob.
 */
export function renderLarkArchiveSummaryText(data: ArchiveSummaryData, locale: Locale = "zh"): string {
  return archiveSummaryBody(data, locale === "en", false);
}

/**
 * One self-contained, localized card for an archive-summary reply: the summary
 * (file count, key files, top extensions, file tree) PLUS the Continue Analysis
 * button inline. Replaces the old "plain English markdown message + separate
 * continue card" pair on the Lark side. The shared Telegram path is untouched —
 * it still forwards the plain-text summary.
 */
export function renderLarkArchiveSummaryCard(input: {
  data: ArchiveSummaryData;
  uploadId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyInThread?: boolean;
  locale?: Locale;
}): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const { data } = input;
  const en = locale === "en";
  const content = archiveSummaryBody(data, en, true);

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: en ? "Archive summary" : "压缩包摘要" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content },
        {
          tag: "markdown",
          content: en
            ? "Continue deeper analysis below, or reply `/continue`."
            : "需要继续深入分析，点下方按钮或回复 `/continue`。",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: en ? "Continue Analysis" : "继续分析" },
          type: "primary",
          behaviors: [{
            type: "callback",
            value: {
              cctb_lark: "continue_archive",
              uploadId: input.uploadId,
              conversationKey: input.conversationKey,
              bridgeChatType: input.bridgeChatType,
              ...(input.replyInThread ? { replyInThread: true } : {}),
            },
          }],
        },
      ],
    },
  };
}

export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  // Neutralize "." / ".." (and all-dot names): the char class above keeps dots,
  // so without this a segment of ".." would escape the intended directory when
  // path.join'd. This is the filesystem-egress sandbox primitive — keep it tight.
  if (/^\.+$/.test(cleaned)) {
    return "message";
  }
  return cleaned || "message";
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[/\\:]/g, "_");
  // basename(".." ) === "..", and dots survive the replace above — reject all-dot
  // names so an attachment file_name of ".."/"." can't traverse out of input/.
  if (!base || /^\.+$/.test(base)) {
    return "attachment";
  }
  return base;
}

function defaultExtension(kind: LarkNormalizedAttachment["kind"]): string {
  switch (kind) {
    case "image":
      return ".png";
    case "audio":
      return ".ogg";
    case "video":
      return ".mp4";
    case "file":
      return ".bin";
  }
}
