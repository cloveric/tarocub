import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
  type DownloadedAttachment,
  type FileWorkflowResult,
} from "../runtime/file-workflow.js";
import type { Locale } from "../telegram/message-renderer.js";
import type { NormalizedTelegramAttachment } from "../telegram/update-normalizer.js";
import type { LarkChannelLike } from "./types.js";
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
    const downloadType = attachment.kind === "image" ? "image" : "file";
    const body = await input.channel.downloadResource(attachment.fileKey, downloadType);
    const fileName = attachment.fileName ?? `${attachment.kind}-${index + 1}${defaultExtension(attachment.kind)}`;
    const filePath = path.join(dir, safeFileName(fileName));
    await writeFile(filePath, body);
    files.push({ attachment, localPath: filePath });
  }
  return files;
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

export function renderLarkArchiveContinueCard(input: {
  uploadId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  replyInThread?: boolean;
  locale?: Locale;
}): object {
  const locale = input.locale ?? "zh";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: "Continue archive analysis",
      },
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: locale === "en"
            ? "Archive summary generated. To continue deeper analysis, click the button or reply with `/continue`."
            : "压缩包摘要已生成。需要继续深入分析时，点击按钮或直接回复 `/continue`。",
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: "Continue Analysis",
          },
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
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "message";
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[/\\:]/g, "_");
  return base || "attachment";
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
