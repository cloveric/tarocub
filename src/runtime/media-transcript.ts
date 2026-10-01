export const BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER = "Bridge media transcription completed";
export const BRIDGE_MEDIA_TRANSCRIPT_PARTIAL_MARKER = "Bridge media transcription partial";

export class PartialMediaTranscriptionError extends Error {
  readonly transcript: string;
  readonly failedChunkNumbers: number[];
  readonly totalChunks: number;

  constructor(transcript: string, failedChunkNumbers: number[], totalChunks: number) {
    super(`Media transcription is incomplete: ${failedChunkNumbers.length}/${totalChunks} chunk(s) failed`);
    this.name = "PartialMediaTranscriptionError";
    this.transcript = transcript;
    this.failedChunkNumbers = [...failedChunkNumbers];
    this.totalChunks = totalChunks;
  }
}

export function isPartialMediaTranscriptionError(error: unknown): error is PartialMediaTranscriptionError {
  return error instanceof PartialMediaTranscriptionError;
}

/**
 * A transcript is UNTRUSTED third-party speech — forwarded meeting recordings
 * are exactly the common case. Someone speaking this block's own delimiters
 * would appear to close the transcript and have the words after it read as
 * bridge-level instruction. Defang the delimiters inside the body; the text
 * stays readable.
 */
function neutralizeTranscriptMarkers(transcript: string): string {
  return transcript
    .replace(/\[End bridge media transcription\]/gi, "(End bridge media transcription)")
    .replace(new RegExp(`\\[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}\\]`, "gi"),
      `(${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER})`)
    .replace(new RegExp(`\\[${BRIDGE_MEDIA_TRANSCRIPT_PARTIAL_MARKER}\\]`, "gi"),
      `(${BRIDGE_MEDIA_TRANSCRIPT_PARTIAL_MARKER})`);
}

function sanitizeMediaFileName(fileName: string): string {
  return fileName
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240) || "media";
}

/**
 * Marks bridge-produced ASR as the completed result so an engine that also
 * receives the original file does not start a second transcription pass.
 */
export function formatBridgeMediaTranscript(fileName: string, transcript: string): string {
  const cleanTranscript = neutralizeTranscriptMarkers(transcript.trim());
  if (!cleanTranscript) return "";

  return [
    `[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]`,
    `File: ${JSON.stringify(sanitizeMediaFileName(fileName))}`,
    "Use the transcript below as the completed transcription. Do not inspect, probe, split, or transcribe the attached media again unless the user explicitly asks for a retry.",
    "Transcript:",
    cleanTranscript,
    "[End bridge media transcription]",
  ].join("\n");
}

/**
 * Preserves usable speech while making an ASR gap impossible to mistake for a
 * complete transcript. Gap metadata stays outside the untrusted speech body.
 */
export function formatBridgePartialMediaTranscript(
  fileName: string,
  transcript: string,
  failedChunkNumbers: number[],
  totalChunks: number,
): string {
  const cleanTranscript = neutralizeTranscriptMarkers(transcript.trim());
  if (!cleanTranscript) return "";

  const uniqueChunks = [...new Set(failedChunkNumbers)]
    .filter((chunk) => Number.isInteger(chunk) && chunk > 0 && chunk <= totalChunks)
    .sort((left, right) => left - right);
  const missing = uniqueChunks.map((chunk) => `${chunk}/${totalChunks}`).join(", ") || "unknown";
  return [
    `[${BRIDGE_MEDIA_TRANSCRIPT_PARTIAL_MARKER}]`,
    `File: ${JSON.stringify(sanitizeMediaFileName(fileName))}`,
    `Warning: transcription is incomplete; missing audio chunk(s): ${missing}. Do not treat these gaps as silence or infer omitted speech.`,
    "Transcript:",
    cleanTranscript,
    "[End bridge media transcription]",
  ].join("\n");
}
