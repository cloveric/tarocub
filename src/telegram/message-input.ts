import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  detectCloudAsrOverride,
  readCloudAsrConfig,
  transcribeViaTingwuCloud,
  type TranscribeMediaOptions,
  isCloudAsrCancelledError,
} from "../runtime/asr-cloud.js";
import { hasTranscribableMediaExtension } from "../runtime/media-extensions.js";
import { formatBridgeMediaTranscript } from "../runtime/media-transcript.js";
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
const TELEGRAM_INBOX_SWEEP_INTERVAL_MS = 60 * 60_000;
const telegramInboxLastSweep = new Map<string, number>();

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

export async function pruneTelegramInbox(
  inboxDir: string,
  retentionDays = parseNonNegativeNumber(process.env.TELEGRAM_INBOUND_FILE_RETENTION_DAYS, 3),
  now = Date.now(),
): Promise<number> {
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  try {
    const entries = await readdir(inboxDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(inboxDir, entry.name);
      try {
        const info = await stat(candidate);
        if (info.mtimeMs <= cutoff) {
          await rm(candidate, { force: true });
          removed += 1;
        }
      } catch {
        // A concurrent turn may already have removed it; pruning is best effort.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Telegram inbox cleanup failed: ${summarizeError(error)}`);
    }
  }
  return removed;
}

async function maybePruneTelegramInbox(inboxDir: string): Promise<void> {
  const key = path.resolve(inboxDir);
  const now = Date.now();
  if (now - (telegramInboxLastSweep.get(key) ?? 0) < TELEGRAM_INBOX_SWEEP_INTERVAL_MS) return;
  telegramInboxLastSweep.set(key, now);
  await pruneTelegramInbox(inboxDir, undefined, now);
}

// Voice transcription configuration. Override via env vars:
//   ASR_HTTP_URL — warm ASR HTTP server (fast path)
//   ASR_CLI_PYTHON + ASR_CLI_SCRIPT — CLI fallback (cold start)
//   ASR_HTTP_TIMEOUT_MS — per-file/chunk ASR HTTP timeout
//   ASR_CHUNK_AFTER_SECONDS + ASR_CHUNK_SECONDS — split long audio before ASR
//   ASR_MAX_AUDIO_SECONDS — hard per-request limit of the local ASR service
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
const ASR_MAX_AUDIO_SECONDS = parsePositiveNumber(process.env.ASR_MAX_AUDIO_SECONDS, 300);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const asrWatchdog = createAsrWatchdogFromEnv();

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal },
  callback: ExecFileCallback,
) => void;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
  options: { timeout?: number; signal?: AbortSignal } = {},
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
  abortSignal?: AbortSignal,
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
    ], {
      timeout: 10_000,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
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
  abortSignal?: AbortSignal;
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
    ], {
      timeout: 300_000,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });

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
  maxAudioSeconds?: number;
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
  const configuredMaxAudioSeconds = options.maxAudioSeconds ?? ASR_MAX_AUDIO_SECONDS;
  const maxAudioSeconds = Number.isFinite(configuredMaxAudioSeconds) && configuredMaxAudioSeconds > 0
    ? configuredMaxAudioSeconds
    : ASR_MAX_AUDIO_SECONDS;
  // Leave timestamp/container headroom below the ASR service's hard cap. A
  // nominally exact 300s segment can probe slightly above 300s and be rejected.
  const safeChunkSeconds = Math.max(1, Math.floor(maxAudioSeconds * 0.9));
  const chunkAfterSeconds = Math.min(options.chunkAfterSeconds ?? ASR_CHUNK_AFTER_SECONDS, maxAudioSeconds);
  const chunkSeconds = Math.min(options.chunkSeconds ?? ASR_CHUNK_SECONDS, safeChunkSeconds);
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

  async function transcribeSingleFile(audioPath: string, abortSignal?: AbortSignal): Promise<string> {
    abortSignal?.throwIfAborted();
    if (httpUrl) {
      try {
        const timeoutSignal = AbortSignal.timeout(httpTimeoutMs);
        const response = await fetchImpl(httpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: audioPath }),
          signal: abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal,
        });
        abortSignal?.throwIfAborted();
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
        // An operator cancellation must not be recorded as an ASR outage or
        // fall through to the cold CLI path after /stop.
        if (abortSignal?.aborted) {
          throw error;
        }
        await recordHttpFailure(error);
        // HTTP server unreachable — fall back to CLI if configured
      }
    }

    if (!cliPython || !cliScript) {
      throw new Error(
        "ASR not configured: set ASR_HTTP_URL or ASR_CLI_PYTHON + ASR_CLI_SCRIPT env vars, or install the qwen3-asr defaults at ~/projects/qwen3-asr/.",
      );
    }

    abortSignal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      execFileImpl(cliPython, [cliScript, audioPath], {
        timeout: 300_000,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }, (error, stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
          reject(new Error(stderrText.trim() || error.message));
          return;
        }
        resolve((Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout).trim());
      });
    });
  }

  async function transcribeLocally(
    audioPath: string,
    duration: number | null,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    const shouldExtractOrChunk = isLikelyVideoFile(audioPath) || (duration !== null && duration > chunkAfterSeconds);
    if (shouldExtractOrChunk) {
      const { chunks, cleanup } = await splitAudioIntoChunks(audioPath, {
        chunkSeconds,
        execFileImpl,
        ffmpegPath,
        ...(abortSignal ? { abortSignal } : {}),
      });
      try {
        const transcripts: string[] = [];
        let successfulChunks = 0;
        for (const [index, chunk] of chunks.entries()) {
          abortSignal?.throwIfAborted();
          try {
            const transcript = await transcribeSingleFile(chunk, abortSignal);
            if (transcript.trim()) {
              successfulChunks += 1;
              transcripts.push(transcript.trim());
            }
          } catch (error) {
            if (abortSignal?.aborted) {
              throw error;
            }
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

    return transcribeSingleFile(audioPath, abortSignal);
  }

  return async function defaultTranscribeVoice(audioPath: string, callOptions?: TranscribeMediaOptions): Promise<string> {
    const abortSignal = callOptions?.abortSignal;
    abortSignal?.throwIfAborted();
    const duration = await probeAudioDurationSeconds(audioPath, execFileImpl, ffprobePath, abortSignal);

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
        if (isCloudAsrCancelledError(error) || abortSignal?.aborted) {
          throw error;
        }
        // ANY other cloud failure falls back to a local transcription attempt.
        // The error messages from asr-cloud.ts carry no stderr content and no
        // env values, so this warn cannot leak signed URLs or credentials.
        console.warn(`ASR cloud transcription failed; falling back to local ASR: ${summarizeError(error)}`);
      }
    }

    return transcribeLocally(audioPath, duration, abortSignal);
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
  await maybePruneTelegramInbox(inboxDir);
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

function isTranscribableAttachment(downloaded: DownloadedAttachment): boolean {
  const { attachment, localPath } = downloaded;
  if (attachment.kind === "voice" || attachment.kind === "audio" || attachment.kind === "video") {
    return true;
  }
  // Parity with the Lark side: a recording forwarded from another app arrives
  // as a `document`, not as `voice`/`audio`, and used to skip ASR entirely —
  // so a long recording never reached the ≥15min cloud route. Decide by
  // container. Photos and real documents are unaffected.
  if (attachment.kind !== "document") {
    return false;
  }
  return hasTranscribableMediaExtension(attachment.fileName ?? "")
    || hasTranscribableMediaExtension(localPath);
}

function appendPromotedMediaFallback(
  text: string,
  downloaded: DownloadedAttachment,
): string {
  const fileName = (downloaded.attachment.fileName ?? path.basename(downloaded.localPath))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
  const marker = `[Bridge media transcription unavailable for ${fileName}; inspect or transcribe the attached file if needed.]`;
  return text.trim() ? `${text.trim()}\n${marker}` : marker;
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
   * The turn's abort signal. Threaded through duration probing, local Qwen ASR,
   * media chunking, and Tingwu so /stop releases the chat queue and does not
   * start a fallback after cancellation.
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
  const transcribableDownloads = allDownloaded.filter(isTranscribableAttachment);
  // A PROMOTED media document (a recording sent as a file) is transcribed, but
  // it is still a file the user handed over — keep it in the engine's
  // attachment list so the file itself remains actionable. Genuine
  // voice/audio/video MESSAGES keep their transcript-only behavior.
  const downloadedAttachments = allDownloaded.filter((downloaded) => (
    !isTranscribableAttachment(downloaded) || downloaded.attachment.kind === "document"
  ));
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
          const fileName = media.attachment.fileName ?? path.basename(media.localPath);
          const transcriptBlock = formatBridgeMediaTranscript(fileName, transcript);
          text = text ? `${text}\n${transcriptBlock}` : transcriptBlock;
        } else if (media.attachment.kind === "document") {
          text = appendPromotedMediaFallback(text, media);
        } else {
          // Only a genuine voice/audio/video message can leave the turn with
          // nothing; a promoted document still carries its file.
          lastEmptyAttachment = media.attachment;
        }
      } catch (error) {
        // An operator stop is not a transcription failure: replying "语音转写失败"
        // right after /stop is misleading. Propagate so the turn's own abort path
        // reports the interruption (same rule as the Lark handler).
        if (isCloudAsrCancelledError(error) || abortSignal?.aborted) {
          throw error;
        }
        // A PROMOTED document (a recording sent as a file) still has the file
        // itself to work with — before promotion existed it simply reached the
        // engine. Do not replace the whole turn with "转写失败"; fall through so
        // the engine gets the attachment. A genuine voice/audio/video MESSAGE
        // has nothing else, so it keeps the failure reply.
        if (media.attachment.kind === "document") {
          text = appendPromotedMediaFallback(text, media);
          continue;
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
      } catch (error) {
        if (isCloudAsrCancelledError(error) || abortSignal?.aborted) {
          throw error;
        }
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
