export const BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER = "Bridge media transcription completed";

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
  const cleanTranscript = transcript.trim();
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
