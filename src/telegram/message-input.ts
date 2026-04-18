import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { DownloadedAttachment } from "../runtime/file-workflow.js";
import type { TelegramApi } from "./api.js";
import type { Locale } from "./message-renderer.js";
import type { NormalizedTelegramAttachment, NormalizedTelegramMessage } from "./update-normalizer.js";

export type TelegramMessageInputPreparationResult =
  | {
    kind: "ready";
    text: string;
    downloadedAttachments: DownloadedAttachment[];
  }
  | {
    kind: "reply";
    text: string;
  };

function inferExtension(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const explicitExtension = attachment.fileName ? path.extname(attachment.fileName) : "";
  if (explicitExtension) {
    return explicitExtension;
  }

  const filePathExtension = path.extname(telegramFilePath);
  if (filePathExtension) {
    return filePathExtension;
  }

  if (attachment.kind === "photo") {
    return ".jpg";
  }

  if (attachment.kind === "voice") {
    return ".ogg";
  }

  return "";
}

function buildInboxFileName(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const extension = inferExtension(attachment, telegramFilePath);
  const explicitBaseName = attachment.fileName ? path.basename(attachment.fileName, path.extname(attachment.fileName)) : "";
  const safeBaseName = explicitBaseName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (safeBaseName) {
    return `${attachment.fileId}-${safeBaseName}${extension}`;
  }

  return `${attachment.fileId}${extension}`;
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

// Voice transcription configuration. Override via env vars:
//   ASR_HTTP_URL — warm ASR HTTP server (fast path)
//   ASR_CLI_PYTHON + ASR_CLI_SCRIPT — CLI fallback (cold start)
// An empty ASR_HTTP_URL disables the HTTP path; missing CLI paths disable
// the CLI path. If both are unavailable, voice messages fail cleanly
// with an "ASR not configured" error instead of spawning against
// nonexistent files.
const ASR_HTTP_URL = process.env.ASR_HTTP_URL ?? "http://127.0.0.1:8412/transcribe";
const ASR_CLI_PYTHON = process.env.ASR_CLI_PYTHON
  ?? (process.env.HOME ? path.join(process.env.HOME, "projects/qwen3-asr/venv/bin/python3") : undefined);
const ASR_CLI_SCRIPT = process.env.ASR_CLI_SCRIPT
  ?? (process.env.HOME ? path.join(process.env.HOME, "projects/qwen3-asr/transcribe.py") : undefined);

async function defaultTranscribeVoice(audioPath: string): Promise<string> {
  if (ASR_HTTP_URL) {
    try {
      const response = await fetch(ASR_HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: audioPath }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const text = await response.text();
        if (text.trim()) return text.trim();
      }
    } catch {
      // HTTP server unreachable — fall back to CLI if configured
    }
  }

  if (!ASR_CLI_PYTHON || !ASR_CLI_SCRIPT) {
    throw new Error(
      "ASR not configured: set ASR_HTTP_URL or ASR_CLI_PYTHON + ASR_CLI_SCRIPT env vars, or install the qwen3-asr defaults at ~/projects/qwen3-asr/.",
    );
  }

  return new Promise<string>((resolve, reject) => {
    execFile(ASR_CLI_PYTHON, [ASR_CLI_SCRIPT, audioPath], { timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function defaultDownloadAttachments(
  api: Pick<TelegramApi, "getFile" | "downloadFile">,
  inboxDir: string,
  attachments: NormalizedTelegramAttachment[],
): Promise<DownloadedAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  await ensureInboxDirExists(inboxDir);
  const downloadedFiles: DownloadedAttachment[] = [];

  for (const attachment of attachments) {
    const telegramFile = await api.getFile(attachment.fileId);
    const localPath = path.join(inboxDir, buildInboxFileName(attachment, telegramFile.file_path));
    await api.downloadFile(telegramFile.file_path, localPath);
    downloadedFiles.push({
      attachment,
      localPath,
    });
  }

  return downloadedFiles;
}

export async function prepareTelegramMessageInput(input: {
  locale: Locale;
  inboxDir: string;
  normalized: NormalizedTelegramMessage;
  api: Pick<TelegramApi, "getFile" | "downloadFile">;
  downloadAttachments?: typeof defaultDownloadAttachments;
  transcribeVoice?: typeof defaultTranscribeVoice;
}): Promise<TelegramMessageInputPreparationResult> {
  const {
    locale,
    inboxDir,
    normalized,
    api,
    downloadAttachments = defaultDownloadAttachments,
    transcribeVoice = defaultTranscribeVoice,
  } = input;

  const allDownloaded = await downloadAttachments(api, inboxDir, normalized.attachments);
  const voiceDownloads = allDownloaded.filter((downloaded) => downloaded.attachment.kind === "voice");
  const downloadedAttachments = allDownloaded.filter((downloaded) => downloaded.attachment.kind !== "voice");

  let text = normalized.text;
  if (voiceDownloads.length > 0) {
    for (const voice of voiceDownloads) {
      try {
        const transcript = await transcribeVoice(voice.localPath);
        if (transcript) {
          text = text ? `${text}\n${transcript}` : transcript;
        }
      } catch {
        return {
          kind: "reply",
          text: locale === "zh" ? "语音转写失败，请发送文字消息。" : "Voice transcription failed. Please send a text message.",
        };
      }
    }
  }

  return {
    kind: "ready",
    text,
    downloadedAttachments,
  };
}
