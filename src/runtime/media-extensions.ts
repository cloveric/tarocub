// Which attachments are transcribable, decided by CONTENT rather than by the
// messaging platform's message type.
//
// Feishu marks a held-to-record voice note as `audio` and a shot clip as
// `video`, but a recording forwarded from another app (WeChat, a recorder, a
// meeting export) arrives as an ordinary `file`. Routing only on the platform
// type meant those never entered the ASR path at all: the bridge treated a
// 24-minute .m4a as a document, so the long-audio cloud route (Aliyun Tingwu,
// ≥15 min) never got a chance and the engine ended up transcribing it locally,
// slowly, by hand. Extension matching closes that gap without changing how
// genuine audio/video messages already behave.

import path from "node:path";

/** Container extensions ffmpeg/ffprobe can read as audio for transcription. */
export const TRANSCRIBABLE_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".amr",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
]);

/** Video containers whose audio track is transcribed the same way. */
export const TRANSCRIBABLE_VIDEO_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
]);

function extensionOf(fileNameOrPath: string): string {
  return path.extname(fileNameOrPath.trim()).toLowerCase();
}

export function hasTranscribableAudioExtension(fileNameOrPath: string): boolean {
  return TRANSCRIBABLE_AUDIO_EXTENSIONS.has(extensionOf(fileNameOrPath));
}

export function hasTranscribableVideoExtension(fileNameOrPath: string): boolean {
  return TRANSCRIBABLE_VIDEO_EXTENSIONS.has(extensionOf(fileNameOrPath));
}

/**
 * True when this name/path is a media container worth sending through ASR.
 * Used to promote `file` attachments that are really recordings; platform
 * `audio`/`video` kinds are already transcribed regardless of name.
 */
export function hasTranscribableMediaExtension(fileNameOrPath: string): boolean {
  return hasTranscribableAudioExtension(fileNameOrPath)
    || hasTranscribableVideoExtension(fileNameOrPath);
}
