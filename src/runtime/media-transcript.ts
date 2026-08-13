export const BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER = "Bridge media transcription completed";

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
      `(${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER})`);
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
