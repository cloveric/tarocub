import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { TelegramApi } from "./api.js";
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

type RejectReason =
  | "outside-workspace"
  | "not-a-file"
  | "too-large"
  | "not-found"
  | "permission-denied"
  | "read-error";

function renderRejectReason(reason: RejectReason, detail: string | undefined, locale: Locale): string {
  if (locale === "zh") {
    switch (reason) {
      case "outside-workspace": return "超出工作目录";
      case "not-a-file": return "不是普通文件";
      case "too-large": return `文件过大（${detail} > 50MB）`;
      case "not-found": return "文件不存在";
      case "permission-denied": return "无读取权限";
      case "read-error": return "读取失败";
    }
  }
  switch (reason) {
    case "outside-workspace": return "outside workspace";
    case "not-a-file": return "not a regular file";
    case "too-large": return `too large (${detail} > 50MB)`;
    case "not-found": return "file not found";
    case "permission-denied": return "permission denied";
    case "read-error": return "read error";
  }
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function extractMarkdownAbsoluteLinks(text: string): Array<{ start: number; end: number; path: string }> {
  const links: Array<{ start: number; end: number; path: string }> = [];
  const opener = /!?\[[^\]]*\]\(/g;

  for (const match of text.matchAll(opener)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const pathStart = start + match[0].length;
    if (pathStart >= text.length) continue;

    let pathEnd = pathStart;
    let pathValue = "";
    if (text[pathStart] === "<") {
      const closing = text.indexOf(">", pathStart + 1);
      if (closing === -1 || text[closing + 1] !== ")") {
        continue;
      }
      pathEnd = closing + 1;
      pathValue = text.slice(pathStart + 1, closing);
    } else {
      let depth = 1;
      for (let index = pathStart; index < text.length; index++) {
        const char = text[index]!;
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (depth === 0) {
          pathEnd = index;
          pathValue = text.slice(pathStart, index);
          break;
        }
      }
      if (depth !== 0) {
        continue;
      }
    }

    const trimmed = pathValue.trim();
    if (!isAbsoluteFilePath(trimmed)) {
      continue;
    }
    links.push({ start, end: pathEnd + 1, path: trimmed });
  }

  return links;
}

export async function deliverTelegramResponse(
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">,
  chatId: number,
  text: string,
  inboxDir: string,
  workspaceOverride?: string,
  locale: Locale = "en",
): Promise<number> {
  let filesSent = 0;
  const fileMatch = text.match(/```file:([^\n]+)\n([\s\S]*?)```/);
  if (fileMatch) {
    const [, fileName, fileBody] = fileMatch;
    await sendFileOrPhoto(api, chatId, fileName.trim(), fileBody);
    return 1;
  }

  const filePaths: string[] = [];
  let cleanedText = text;
  const sendFilePattern = /\[send-file:([^\]]+)\]/g;
  let sendFileMatch: RegExpExecArray | null;
  while ((sendFileMatch = sendFilePattern.exec(text)) !== null) {
    const p = sendFileMatch[1]!.trim();
    if (isAbsoluteFilePath(p) && !filePaths.includes(p)) {
      filePaths.push(p);
    }
  }
  const markdownLinks = extractMarkdownAbsoluteLinks(text);
  for (const link of markdownLinks) {
    if (!filePaths.includes(link.path)) {
      filePaths.push(link.path);
    }
  }

  if (filePaths.length > 0) {
    cleanedText = cleanedText.replace(sendFilePattern, "");
    for (const link of [...markdownLinks].sort((left, right) => right.start - left.start)) {
      cleanedText = `${cleanedText.slice(0, link.start)}${cleanedText.slice(link.end)}`;
    }
    cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
  }

  if (cleanedText) {
    const chunks = chunkTelegramMessage(cleanedText);
    for (const chunk of chunks) {
      await sendMessageWithMarkdown(api as TelegramApi, chatId, chunk);
    }
  }

  const imageFiles: Array<{ filename: string; contents: Uint8Array }> = [];
  const otherFiles: Array<{ filename: string; contents: Uint8Array | string }> = [];
  const rejected: Array<{ path: string; reason: RejectReason; detail?: string }> = [];

  const deliveryStateDir = path.dirname(inboxDir);
  const workspacePrefix = path.join(deliveryStateDir, "workspace") + path.sep;
  const overridePrefix = workspaceOverride ? workspaceOverride + path.sep : null;

  for (const filePath of filePaths) {
    try {
      const real = await realpath(filePath);
      if (!real.startsWith(workspacePrefix) && !(overridePrefix && real.startsWith(overridePrefix))) {
        rejected.push({ path: filePath, reason: "outside-workspace" });
        continue;
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
      if (isImageFile(fileName)) {
        imageFiles.push({ filename: fileName, contents });
      } else {
        otherFiles.push({ filename: fileName, contents });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const reason: RejectReason =
        code === "ENOENT" ? "not-found" : code === "EACCES" ? "permission-denied" : "read-error";
      rejected.push({ path: filePath, reason });
    }
  }

  const allFiles = [...imageFiles, ...otherFiles];
  for (const file of allFiles) {
    await sendFileOrPhoto(api, chatId, file.filename, file.contents);
    await appendTimelineEventBestEffort(deliveryStateDir, {
      type: "file.accepted",
      channel: "telegram",
      chatId,
      outcome: "accepted",
      metadata: {
        fileName: file.filename,
        bytes: typeof file.contents === "string" ? Buffer.byteLength(file.contents) : file.contents.length,
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

  filesSent += allFiles.length;
  return filesSent;
}
