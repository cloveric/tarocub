import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { TelegramApi } from "./api.js";
import type { DeliveryAcceptedReceipt, DeliveryRejectedReceipt, DeliverySource } from "./delivery-ledger.js";
import {
  isAbsoluteFilePath,
  isLikelyCopiedPlaceholderFilePath,
  isStaticPlaceholderFilePath,
} from "./file-paths.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";

function isMarkdownParseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = error.message.toLowerCase();
  return (
    text.includes("can't parse entities") ||
    text.includes("cannot parse entities") ||
    text.includes("parse entities") ||
    text.includes("parse_mode")
  );
}

async function sendMessageWithMarkdown(api: TelegramApi, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parseMode: "Markdown" });
  } catch (error) {
    if (!isMarkdownParseError(error)) {
      throw error;
    }
    await api.sendMessage(chatId, text);
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

const IMAGE_SIZE_THRESHOLD = 2 * 1024 * 1024; // 2MB

export async function sendFileOrPhoto(
  api: Pick<TelegramApi, "sendPhoto" | "sendDocument">,
  chatId: number,
  filename: string,
  contents: Uint8Array | string,
): Promise<void> {
  const payload = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  if (isImageFile(filename) && payload.length > IMAGE_SIZE_THRESHOLD) {
    try {
      await api.sendPhoto(chatId, filename, payload, filename);
      return;
    } catch {
      // Fall back to sendDocument if sendPhoto fails
    }
  }
  await api.sendDocument(chatId, filename, contents);
}

export type DeliveryRejectReason =
  | "outside-workspace"
  | "outside-request-output"
  | "not-a-file"
  | "too-large"
  | "placeholder-path"
  | "not-found"
  | "permission-denied"
  | "read-error";

function renderRejectReason(reason: DeliveryRejectReason, detail: string | undefined, locale: Locale): string {
  if (locale === "zh") {
    switch (reason) {
      case "outside-workspace": return "超出工作目录";
      case "outside-request-output": return "不在当前请求输出目录中";
      case "not-a-file": return "不是普通文件";
      case "too-large": return `文件过大（${detail} > 50MB）`;
      case "placeholder-path": return "示例占位路径，不是真实文件";
      case "not-found": return "文件不存在";
      case "permission-denied": return "无读取权限";
      case "read-error": return "读取失败";
    }
  }
  switch (reason) {
    case "outside-workspace": return "outside workspace";
    case "outside-request-output": return "outside current request output";
    case "not-a-file": return "not a regular file";
    case "too-large": return `too large (${detail} > 50MB)`;
    case "placeholder-path": return "placeholder path, not a real file";
    case "not-found": return "file not found";
    case "permission-denied": return "permission denied";
    case "read-error": return "read error";
  }
}

export async function deliverTelegramResponse(
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">,
  chatId: number,
  text: string,
  inboxDir: string,
  workspaceOverride?: string,
  requestOutputDir?: string,
  locale: Locale = "en",
  options: {
    onFileAccepted?: (sourcePath: string) => void;
    onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
    onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
    source?: DeliverySource;
    allowAnyAbsolutePath?: boolean;
    notifyRejected?: boolean;
  } = {},
): Promise<number> {
  let filesSent = 0;
  const fileMatch = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/);
  const isWholeResponseFileBlock = fileMatch && text.replace(fileMatch[0], "").trim().length === 0;
  if (fileMatch && isWholeResponseFileBlock && Buffer.byteLength(fileMatch[2] ?? "", "utf8") > 0) {
    const [, fileName, fileBody] = fileMatch;
    await sendFileOrPhoto(api, chatId, fileName.trim(), fileBody);
    return 1;
  }

  const filePaths: string[] = [];
  const rejected: Array<{ path: string; reason: DeliveryRejectReason; detail?: string }> = [];
  let cleanedText = text;
  const sendFilePattern = /\[send-file:([^\]]+)\]/g;
  let sendFileMatch: RegExpExecArray | null;
  let sawSendFileTag = false;
  while ((sendFileMatch = sendFilePattern.exec(text)) !== null) {
    sawSendFileTag = true;
    const p = sendFileMatch[1]!.trim();
    if (!options.allowAnyAbsolutePath && isStaticPlaceholderFilePath(p)) {
      continue;
    } else if (isAbsoluteFilePath(p) && !filePaths.includes(p)) {
      filePaths.push(p);
    }
  }
  if (filePaths.length > 0 || sawSendFileTag) {
    cleanedText = cleanedText.replace(sendFilePattern, "");
    cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
  }

  if (cleanedText) {
    const chunks = chunkTelegramMessage(cleanedText);
    for (const chunk of chunks) {
      await sendMessageWithMarkdown(api as TelegramApi, chatId, chunk);
    }
  }

  const acceptedFiles: Array<{ sourcePath: string; realPath: string; filename: string; contents: Uint8Array | string }> = [];

  const deliveryStateDir = path.dirname(inboxDir);
  const workspacePrefix = path.join(deliveryStateDir, "workspace") + path.sep;
  const telegramOutPrefix = path.join(deliveryStateDir, "workspace", ".telegram-out") + path.sep;
  const overridePrefix = workspaceOverride ? workspaceOverride + path.sep : null;
  const requestOutputPrefix = requestOutputDir
    ? `${await realpath(requestOutputDir).catch(() => requestOutputDir)}${path.sep}`
    : null;

  for (const filePath of filePaths) {
    try {
      const real = await realpath(filePath);
      if (!options.allowAnyAbsolutePath) {
        if (requestOutputPrefix && real.startsWith(telegramOutPrefix) && !real.startsWith(requestOutputPrefix)) {
          rejected.push({ path: filePath, reason: "outside-request-output" });
          continue;
        }
        if (!real.startsWith(workspacePrefix) && !(overridePrefix && real.startsWith(overridePrefix))) {
          rejected.push({ path: filePath, reason: "outside-workspace" });
          continue;
        }
      }
      const stats = await lstat(real);
      if (!stats.isFile()) {
        rejected.push({ path: filePath, reason: "not-a-file" });
        continue;
      }
      if (stats.size > 50_000_000) {
        rejected.push({ path: filePath, reason: "too-large", detail: `${Math.round(stats.size / 1_000_000)}MB` });
        continue;
      }
      const contents = await readFile(real);
      const fileName = path.basename(filePath);
      acceptedFiles.push({ sourcePath: filePath, realPath: real, filename: fileName, contents });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        code === "ENOENT" &&
        !options.allowAnyAbsolutePath &&
        isLikelyCopiedPlaceholderFilePath(filePath)
      ) {
        continue;
      }
      const reason: DeliveryRejectReason =
        code === "ENOENT" ? "not-found" : code === "EACCES" ? "permission-denied" : "read-error";
      rejected.push({ path: filePath, reason });
    }
  }

  for (const file of acceptedFiles) {
    await sendFileOrPhoto(api, chatId, file.filename, file.contents);
    options.onFileAccepted?.(file.sourcePath);
    options.onDeliveryAccepted?.({
      path: file.sourcePath,
      realPath: file.realPath,
      fileName: file.filename,
      bytes: typeof file.contents === "string" ? Buffer.byteLength(file.contents) : file.contents.length,
      source: options.source ?? "post-turn",
    });
    await appendTimelineEventBestEffort(deliveryStateDir, {
      type: "file.accepted",
      channel: "telegram",
      chatId,
      outcome: "accepted",
      metadata: {
        fileName: file.filename,
        bytes: typeof file.contents === "string" ? Buffer.byteLength(file.contents) : file.contents.length,
        via: options.source ?? "post-turn",
      },
    }, "file delivery timeline event");
  }

  if (rejected.length > 0) {
    for (const item of rejected) {
      await appendTimelineEventBestEffort(deliveryStateDir, {
        type: "file.rejected",
        channel: "telegram",
        chatId,
        outcome: "rejected",
        detail: renderRejectReason(item.reason, item.detail, locale),
        metadata: {
          path: item.path,
          reason: item.reason,
          detail: item.detail,
        },
      }, "file delivery timeline event");
    }
    for (const item of rejected) {
      options.onDeliveryRejected?.({
        path: item.path,
        reason: item.reason,
        detail: item.detail,
        source: options.source ?? "post-turn",
      });
    }
    if (options.notifyRejected === false) {
      filesSent += acceptedFiles.length;
      return filesSent;
    }
    const MAX_SHOWN = 5;
    const shown = rejected.slice(0, MAX_SHOWN);
    const extra = rejected.length - shown.length;
    const header = locale === "zh"
      ? `⚠ 有 ${rejected.length} 个文件未能送达：`
      : `⚠ ${rejected.length} file${rejected.length === 1 ? "" : "s"} not delivered:`;
    const moreLine = locale === "zh" ? `…还有 ${extra} 个` : `… and ${extra} more`;
    const footer = locale === "zh"
      ? "文件必须位于本 bot 的工作目录内（或通过 /resume 指定的项目目录）。"
      : "Files must live under the bot's workspace (or a /resume'd project dir).";
    const lines = [header, ...shown.map(({ path: p, reason, detail }) => `• ${p} — ${renderRejectReason(reason, detail, locale)}`)];
    if (extra > 0) lines.push(moreLine);
    lines.push(footer);
    await api.sendMessage(chatId, lines.join("\n"));
  }

  filesSent += acceptedFiles.length;
  return filesSent;
}
