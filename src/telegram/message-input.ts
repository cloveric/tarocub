import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  detectCloudAsrOverride,
  readCloudAsrConfig,
  transcribeViaTingwuCloud,
  type TranscribeMediaOptions,
  isCloudAsrCancelledError,
} from "../runtime/asr-cloud.js";
import type { DownloadedAttachment } from "../runtime/file-workflow.js";
import type { TelegramApi } from "./api.js";
import { createAsrWatchdogFromEnv, type AsrWatchdog } from "./asr-watchdog.js";
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

export const TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

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

  if (attachment.kind === "audio") {
    return ".m4a";
  }

  if (attachment.kind === "video") {
    return ".mp4";
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

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function describeAttachment(attachment: NormalizedTelegramAttachment): string {
  return [attachment.kind, attachment.fileName].filter(Boolean).join(" ");
}

function assertTelegramAttachmentDownloadable(attachment: NormalizedTelegramAttachment): void {
  if (
    typeof attachment.fileSize === "number" &&
    attachment.fileSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES
  ) {
    throw new Error(
      [
        `Telegram attachment is too large to download via Bot API: ${describeAttachment(attachment)}`,
        `is ${formatFileSize(attachment.fileSize)}`,
        `current cloud getFile limit is ${formatFileSize(TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES)}.`,
        "Send a smaller file, share a reachable link, or place the file in the bot workspace.",
      ].join(" "),
    );
  }
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

// Voice transcription configuration. Override via env vars:
//   ASR_HTTP_URL — warm ASR HTTP server (fast path)
//   ASR_CLI_PYTHON + ASR_CLI_SCRIPT — CLI fallback (cold start)
//   ASR_HTTP_TIMEOUT_MS — per-file/chunk ASR HTTP timeout
//   ASR_CHUNK_AFTER_SECONDS + ASR_CHUNK_SECONDS — split long audio before ASR
// An empty ASR_HTTP_URL disables the HTTP path; missing CLI paths disable
// the CLI path. If both are unavailable, voice messages fail cleanly
// with an "ASR not configured" error instead of spawning against
// nonexistent files.
const ASR_HTTP_URL = process.env.ASR_HTTP_URL ?? "http://127.0.0.1:8412/transcribe";
const ASR_CLI_PYTHON = process.env.ASR_CLI_PYTHON
  ?? (process.env.HOME ? path.join(process.env.HOME, "projects/qwen3-asr/venv/bin/python3") : undefined);
const ASR_CLI_SCRIPT = process.env.ASR_CLI_SCRIPT
  ?? (process.env.HOME ? path.join(process.env.HOME, "projects/qwen3-asr/transcribe.py") : undefined);
const ASR_HTTP_TIMEOUT_MS = parsePositiveNumber(process.env.ASR_HTTP_TIMEOUT_MS, 180_000);
const ASR_CHUNK_AFTER_SECONDS = parsePositiveNumber(process.env.ASR_CHUNK_AFTER_SECONDS, 120);
const ASR_CHUNK_SECONDS = parsePositiveNumber(process.env.ASR_CHUNK_SECONDS, 60);
const MAX_ASR_CHUNK_SECONDS = 600;
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const asrWatchdog = createAsrWatchdogFromEnv();

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout?: number },
  callback: ExecFileCallback,
) => void;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

function isLikelyVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function execFileText(
  execFileImpl: ExecFileImpl,
  file: string,
  args: readonly string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
      if (error) {
        reject(new Error(stderrText.trim() || error.message));
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout,
        stderr: stderrText,
      });
    });
  });
}

async function probeAudioDurationSeconds(
  audioPath: string,
  execFileImpl: ExecFileImpl,
  ffprobePath: string,
): Promise<number | null> {
  try {
    const { stdout } = await execFileText(execFileImpl, ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ], { timeout: 10_000 });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    try {
      await access(audioPath);
    } catch {
      return null;
    }
    console.warn(`ASR ffprobe failed for ${path.basename(audioPath)}; long audio cannot be pre-chunked: ${summarizeError(error)}`);
    return null;
  }
}

async function splitAudioIntoChunks(inputPath: string, options: {
  chunkSeconds: number;
  execFileImpl: ExecFileImpl;
  ffmpegPath: string;
}): Promise<{ chunks: string[]; cleanup: () => Promise<void> }> {
  const chunkDir = await mkdtemp(path.join(os.tmpdir(), "cctb-asr-chunks-"));
  const pattern = path.join(chunkDir, "chunk-%03d.wav");

  try {
    await execFileText(options.execFileImpl, options.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "segment",
      "-segment_time",
      String(options.chunkSeconds),
      "-reset_timestamps",
      "1",
      pattern,
    ], { timeout: 300_000 });

    const chunks = (await readdir(chunkDir))
      .filter((entry) => /^chunk-\d+\.wav$/.test(entry))
      .sort()
      .map((entry) => path.join(chunkDir, entry));

    if (chunks.length === 0) {
      throw new Error("ffmpeg did not produce ASR audio chunks");
    }

    return {
      chunks,
      cleanup: () => rm(chunkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    };
  } catch (error) {
    await rm(chunkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    throw error;
  }
}

export function createDefaultTranscribeVoice(options: {
  httpUrl?: string;
  cliPython?: string;
  cliScript?: string;
  fetchImpl?: typeof fetch;
  watchdog?: AsrWatchdog;
  execFileImpl?: ExecFileImpl;
  ffprobePath?: string;
  ffmpegPath?: string;
  httpTimeoutMs?: number;
  chunkAfterSeconds?: number;
  chunkSeconds?: number;
  /**
   * Env source for the long-audio cloud ASR config (TINGWU_ASR_DIR,
   * ASR_CLOUD_THRESHOLD_SECONDS, ASR_CLOUD_TASK_TIMEOUT_SECONDS). Read at
   * CALL time — not captured here — so the feature can be configured without
   * rebuilding the transcribe function.
   */
  env?: NodeJS.ProcessEnv;
  /** Fallback state dir for cloud ASR job dirs when the call carries none. */
  stateDir?: string;
} = {}): (audioPath: string, callOptions?: TranscribeMediaOptions) => Promise<string> {
  const httpUrl = options.httpUrl ?? ASR_HTTP_URL;
  const cliPython = options.cliPython ?? ASR_CLI_PYTHON;
  const cliScript = options.cliScript ?? ASR_CLI_SCRIPT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const watchdog = options.watchdog ?? asrWatchdog;
  const execFileImpl = options.execFileImpl ?? (execFile as ExecFileImpl);
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const httpTimeoutMs = options.httpTimeoutMs ?? ASR_HTTP_TIMEOUT_MS;
  const chunkAfterSeconds = options.chunkAfterSeconds ?? ASR_CHUNK_AFTER_SECONDS;
  const chunkSeconds = Math.min(options.chunkSeconds ?? ASR_CHUNK_SECONDS, MAX_ASR_CHUNK_SECONDS);
  const cloudEnv = options.env ?? process.env;
  const factoryStateDir = options.stateDir;

  async function recordHttpSuccess(): Promise<void> {
    try {
      watchdog.recordSuccess();
    } catch {
      // Watchdog diagnostics must never break transcription.
    }
  }

  async function recordHttpFailure(error: unknown): Promise<void> {
    try {
      await watchdog.recordFailure(error);
    } catch {
      // Watchdog diagnostics must never break CLI fallback.
    }
  }

  async function transcribeSingleFile(audioPath: string): Promise<string> {
    if (httpUrl) {
      try {
        const response = await fetchImpl(httpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: audioPath }),
          signal: AbortSignal.timeout(httpTimeoutMs),
        });
        if (response.ok) {
          const text = await response.text();
          if (text.trim()) {
            await recordHttpSuccess();
            return text.trim();
          }
          await recordHttpFailure(new Error("ASR HTTP server returned an empty transcript"));
        } else {
          await recordHttpFailure(new Error(`ASR HTTP server returned ${response.status}`));
        }
      } catch (error) {
        await recordHttpFailure(error);
        // HTTP server unreachable — fall back to CLI if configured
      }
    }

    if (!cliPython || !cliScript) {
      throw new Error(
        "ASR not configured: set ASR_HTTP_URL or ASR_CLI_PYTHON + ASR_CLI_SCRIPT env vars, or install the qwen3-asr defaults at ~/projects/qwen3-asr/.",
      );
    }

    return new Promise<string>((resolve, reject) => {
      execFileImpl(cliPython, [cliScript, audioPath], { timeout: 300_000 }, (error, stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
          reject(new Error(stderrText.trim() || error.message));
          return;
        }
        resolve((Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout).trim());
      });
    });
  }

  async function transcribeLocally(audioPath: string, duration: number | null): Promise<string> {
    const shouldExtractOrChunk = isLikelyVideoFile(audioPath) || (duration !== null && duration > chunkAfterSeconds);
    if (shouldExtractOrChunk) {
      const { chunks, cleanup } = await splitAudioIntoChunks(audioPath, {
        chunkSeconds,
        execFileImpl,
        ffmpegPath,
      });
      try {
        const transcripts: string[] = [];
        let successfulChunks = 0;
        for (const [index, chunk] of chunks.entries()) {
          try {
            const transcript = await transcribeSingleFile(chunk);
            if (transcript.trim()) {
              successfulChunks += 1;
              transcripts.push(transcript.trim());
            }
          } catch (error) {
            // Per-chunk failures are infrastructure errors, NOT user speech.
            // Do not blend a "[chunk N/M transcription failed: ...]" marker into
            // the transcript — the model would treat it as the user's words.
            // Log it out-of-band and keep the successfully transcribed chunks.
            console.warn(
              `ASR chunk ${index + 1}/${chunks.length} transcription failed: ${summarizeError(error)}`,
            );
          }
        }
        const mergedTranscript = transcripts.join("\n").trim();
        if (successfulChunks === 0) {
          throw new Error("ASR chunk transcription failed for all chunks");
        }
        if (!mergedTranscript) {
          throw new Error("ASR chunk transcription returned an empty transcript");
        }
        return mergedTranscript;
      } finally {
        await cleanup();
      }
    }

    return transcribeSingleFile(audioPath);
  }

  return async function defaultTranscribeVoice(audioPath: string, callOptions?: TranscribeMediaOptions): Promise<string> {
    const duration = await probeAudioDurationSeconds(audioPath, execFileImpl, ffprobePath);

    // Long-audio cloud routing (Aliyun Tingwu). Env is read per call so the
    // feature can be enabled/disabled without rebuilding the transcriber.
    // Unknown duration routes local exactly as today unless the user forced
    // the cloud path explicitly.
    const cloudConfig = readCloudAsrConfig(cloudEnv);
    const override = detectCloudAsrOverride(callOptions?.messageText);
    const shouldUseCloud = cloudConfig !== null &&
      override !== "local" &&
      (override === "cloud" || (duration !== null && duration >= cloudConfig.thresholdSeconds));
    if (shouldUseCloud && cloudConfig !== null) {
      const jobStateDir = callOptions?.stateDir ?? factoryStateDir;
      const jobRootDir = jobStateDir
        ? path.join(jobStateDir, "asr-jobs")
        : path.join(os.tmpdir(), "cctb-asr-jobs");
      try {
        // The caller's abort signal (when it has one) is threaded straight into
        // the child process: a cancelled turn must not leave a cloud job
        // holding the chat's queue slot until the wall-clock bound expires.
        return await transcribeViaTingwuCloud(audioPath, {
          config: cloudConfig,
          jobRootDir,
          ...(callOptions?.abortSignal ? { abortSignal: callOptions.abortSignal } : {}),
        });
      } catch (error) {
        // A CANCELLED job is not a failure: the operator pressed stop, so
        // restarting the same work locally would defeat the stop entirely.
        if (isCloudAsrCancelledError(error)) {
          throw error;
        }
        // ANY other cloud failure falls back to a local transcription attempt.
        // The error messages from asr-cloud.ts carry no stderr content and no
        // env values, so this warn cannot leak signed URLs or credentials.
        console.warn(`ASR cloud transcription failed; falling back to local ASR: ${summarizeError(error)}`);
      }
    }

    return transcribeLocally(audioPath, duration);
  };
}

const defaultTranscribeVoice = (audioPath: string, callOptions?: TranscribeMediaOptions): Promise<string> =>
  createDefaultTranscribeVoice()(audioPath, callOptions);

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
    assertTelegramAttachmentDownloadable(attachment);
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

function isTranscribableAttachment(attachment: NormalizedTelegramAttachment): boolean {
  return attachment.kind === "voice" || attachment.kind === "audio" || attachment.kind === "video";
}

function renderTranscriptionFailureMessage(
  locale: Locale,
  attachment: NormalizedTelegramAttachment,
  quoted = false,
): string {
  if (attachment.kind === "video") {
    if (locale === "zh") {
      return quoted ? "引用视频转写失败，请发送文字消息或音频文件。" : "视频转写失败，请发送文字消息或音频文件。";
    }
    return quoted
      ? "Quoted video transcription failed. Please send a text message or an audio file."
      : "Video transcription failed. Please send a text message or an audio file.";
  }

  if (attachment.kind === "audio") {
    return locale === "zh"
      ? "音频转写失败，请发送文字消息。"
      : "Audio transcription failed. Please send a text message.";
  }

  return locale === "zh" ? "语音转写失败，请发送文字消息。" : "Voice transcription failed. Please send a text message.";
}

function appendQuotedAudioTranscript(
  replyContext: NonNullable<NormalizedTelegramMessage["replyContext"]>,
  transcript: string,
): void {
  const block = `[Quoted audio transcript]\n${transcript}`;
  replyContext.text = replyContext.text.trim() ? `${replyContext.text.trim()}\n\n${block}` : block;
}

export async function prepareTelegramMessageInput(input: {
  locale: Locale;
  inboxDir: string;
  normalized: NormalizedTelegramMessage;
  api: Pick<TelegramApi, "getFile" | "downloadFile">;
  downloadAttachments?: typeof defaultDownloadAttachments;
  transcribeVoice?: typeof defaultTranscribeVoice;
  /**
   * The turn's abort signal. Threaded into cloud transcription so /stop can kill
   * a running Tingwu job instead of leaving it to its wall clock — Lark already
   * passes this; without it Telegram's stop could not interrupt a cloud job.
   */
  abortSignal?: AbortSignal;
}): Promise<TelegramMessageInputPreparationResult> {
  const {
    locale,
    inboxDir,
    normalized,
    api,
    downloadAttachments = defaultDownloadAttachments,
    transcribeVoice = defaultTranscribeVoice,
    abortSignal,
  } = input;

  const allDownloaded = await downloadAttachments(api, inboxDir, normalized.attachments);
  const transcribableDownloads = allDownloaded.filter((downloaded) => isTranscribableAttachment(downloaded.attachment));
  const downloadedAttachments = allDownloaded.filter((downloaded) => !isTranscribableAttachment(downloaded.attachment));
  const quotedAudioDownloads = normalized.replyContext?.audioAttachment
    ? await downloadAttachments(api, inboxDir, [normalized.replyContext.audioAttachment])
    : [];

  // Message text enables the 强制云端转写/强制本地转写 routing overrides; the
  // state dir (inboxDir's parent, same convention as audit events) hosts
  // cloud ASR job dirs under `<stateDir>/asr-jobs/`.
  const transcribeOptions: TranscribeMediaOptions = {
    messageText: normalized.text,
    stateDir: path.dirname(path.resolve(inboxDir)),
    ...(abortSignal ? { abortSignal } : {}),
  };

  let text = normalized.text;
  if (transcribableDownloads.length > 0) {
    // Track whether any transcribable attachment produced real speech. An empty
    // or whitespace-only transcript (without throwing) must not silently yield
    // an empty prompt fed to the engine.
    let producedAnyTranscript = false;
    let lastEmptyAttachment: NormalizedTelegramAttachment | undefined;
    for (const media of transcribableDownloads) {
      try {
        const transcript = (await transcribeVoice(media.localPath, transcribeOptions)).trim();
        if (transcript) {
          producedAnyTranscript = true;
          text = text ? `${text}\n${transcript}` : transcript;
        } else {
          lastEmptyAttachment = media.attachment;
        }
      } catch (error) {
        // An operator stop is not a transcription failure: replying "语音转写失败"
        // right after /stop is misleading. Propagate so the turn's own abort path
        // reports the interruption (same rule as the Lark handler).
        if (isCloudAsrCancelledError(error) || abortSignal?.aborted) {
          throw error;
        }
        return {
          kind: "reply",
          text: renderTranscriptionFailureMessage(locale, media.attachment),
        };
      }
    }
    // If the voice note was the SOLE content and it transcribed to nothing,
    // surface a transcription failure rather than sending an empty prompt. Only
    // short-circuit when there is genuinely nothing else to run on: other text,
    // a non-voice attachment (image/PDF/…), or a quoted message means the turn
    // still has real content, so fall through and let the engine have it.
    if (
      !producedAnyTranscript &&
      !text.trim() &&
      downloadedAttachments.length === 0 &&
      !normalized.replyContext &&
      lastEmptyAttachment
    ) {
      return {
        kind: "reply",
        text: renderTranscriptionFailureMessage(locale, lastEmptyAttachment),
      };
    }
  }
  if (quotedAudioDownloads.length > 0 && normalized.replyContext) {
    for (const quotedAudio of quotedAudioDownloads) {
      try {
        const transcript = await transcribeVoice(quotedAudio.localPath, transcribeOptions);
        if (transcript) {
          appendQuotedAudioTranscript(normalized.replyContext, transcript);
        }
      } catch {
        return {
          kind: "reply",
          text: renderTranscriptionFailureMessage(locale, quotedAudio.attachment, true),
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
