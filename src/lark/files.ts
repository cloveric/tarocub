import { mkdir, rm, writeFile } from "node:fs/promises";
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
  for (const [index, attachment] of input.attachments.entries()) {
    const body = await downloadLarkAttachmentBody(input.channel, input.messageId, attachment);
    const fileName = attachment.fileName ?? `${attachment.kind}-${index + 1}${defaultExtension(attachment.kind)}`;
    const filePath = path.join(dir, safeFileName(fileName));
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

export async function cleanupLarkMessageArtifacts(stateDir: string, messageId: string): Promise<void> {
  await rm(path.join(stateDir, "workspace", ".lark-files", safeSegment(messageId)), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
}

export function boundLarkArchiveSummary(text: string): string {
  return boundArchiveSummaryForTelegram(text);
}

// Keep the rendered card body well under Feishu's per-element markdown limit
// (ErrCode 11310). CJK counts ~3 bytes, so cap the displayed tree generously.
const ARCHIVE_CARD_TREE_MAX_LINES = 24;
const ARCHIVE_CARD_BODY_MAX = 2000;

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

  const treeLines = data.treeLines.slice(0, ARCHIVE_CARD_TREE_MAX_LINES);
  const treeTruncated = data.treeLines.length > treeLines.length;
  const extensions = data.topExtensions.length > 0
    ? data.topExtensions.map(([extension, count]) => `${extension} (${count})`).join(", ")
    : (en ? "none" : "无");
  const keyFiles = data.keyFiles.length > 0
    ? data.keyFiles.join(", ")
    : (en ? "none detected" : "未检测到");

  const lines = [
    en ? `**📦 Archive Summary** · ${data.archiveName}` : `**📦 压缩包摘要** · ${data.archiveName}`,
    en ? `Files: ${data.fileCount}` : `文件数：${data.fileCount}`,
    en ? `Key files: ${keyFiles}` : `关键文件：${keyFiles}`,
    en ? `Top extensions: ${extensions}` : `主要类型：${extensions}`,
    "",
    en ? "Tree:" : "目录：",
    ...treeLines,
    ...(treeTruncated ? [en ? `… (+${data.treeLines.length - treeLines.length} more)` : `… (还有 ${data.treeLines.length - treeLines.length} 项)`] : []),
  ];
  // Bound by chars first (keeps the visible card compact), then by bytes so the
  // element obeys the same Feishu per-element limit as every other Lark card
  // (CJK is ~3 bytes/char, so a char-only cap could still overflow on bytes).
  let content = lines.join("\n");
  if (content.length > ARCHIVE_CARD_BODY_MAX) {
    content = `${content.slice(0, ARCHIVE_CARD_BODY_MAX)}\n…`;
  }
  content = truncateBytes(content, ELEMENT_CONTENT_MAX_BYTES);

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
