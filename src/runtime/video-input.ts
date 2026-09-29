import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const SHORT_VIDEO_AUTO_FRAME_SECONDS = 10;
export const SHORT_VIDEO_MAX_FRAMES = 10;

const VIDEO_PROBE_TIMEOUT_MS = 10_000;
const VIDEO_FRAME_TIMEOUT_MS = 30_000;

export type VideoInputExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => void;

export interface PreparedVideoInput {
  durationSeconds: number | null;
  framePaths: string[];
  mode: "frames" | "direct";
}

function execFileText(
  execFileImpl: VideoInputExecFile,
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
      if (error) {
        reject(new Error(stderrText.trim() || error.message));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

export async function probeVideoDurationSeconds(
  videoPath: string,
  options: {
    execFileImpl?: VideoInputExecFile;
    ffprobePath?: string;
    abortSignal?: AbortSignal;
  } = {},
): Promise<number | null> {
  const execFileImpl = options.execFileImpl ?? (execFile as VideoInputExecFile);
  try {
    const { stdout } = await execFileText(execFileImpl, options.ffprobePath ?? "ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ], {
      timeout: VIDEO_PROBE_TIMEOUT_MS,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    if (options.abortSignal?.aborted) {
      throw error;
    }
    return null;
  }
}

/**
 * Prepare a video for image-capable coding agents.
 *
 * Current Claude/Codex agent transports accept image paths, not native video
 * content blocks. Short clips therefore get one frame per second (bounded to
 * ten), while longer or unprobeable clips are handed over as their original
 * local path for the agent to inspect with its own tools.
 */
export async function prepareVideoInput(
  videoPath: string,
  options: {
    execFileImpl?: VideoInputExecFile;
    ffprobePath?: string;
    ffmpegPath?: string;
    abortSignal?: AbortSignal;
  } = {},
): Promise<PreparedVideoInput> {
  const execFileImpl = options.execFileImpl ?? (execFile as VideoInputExecFile);
  const durationSeconds = await probeVideoDurationSeconds(videoPath, {
    execFileImpl,
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });

  if (durationSeconds === null || durationSeconds > SHORT_VIDEO_AUTO_FRAME_SECONDS) {
    return { durationSeconds, framePaths: [], mode: "direct" };
  }

  const frameDir = `${videoPath}.frames`;
  const framePattern = path.join(frameDir, "frame-%02d.jpg");
  try {
    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });
    await execFileText(execFileImpl, options.ffmpegPath ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "fps=1,scale='min(1280,iw)':-2",
      "-frames:v",
      String(SHORT_VIDEO_MAX_FRAMES),
      "-q:v",
      "3",
      framePattern,
    ], {
      timeout: VIDEO_FRAME_TIMEOUT_MS,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    const framePaths = (await readdir(frameDir))
      .filter((entry) => /^frame-\d+\.jpg$/i.test(entry))
      .sort()
      .slice(0, SHORT_VIDEO_MAX_FRAMES)
      .map((entry) => path.join(frameDir, entry));
    if (framePaths.length > 0) {
      return { durationSeconds, framePaths, mode: "frames" };
    }
  } catch (error) {
    if (options.abortSignal?.aborted) {
      throw error;
    }
  }

  await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
  return { durationSeconds, framePaths: [], mode: "direct" };
}

export function formatPreparedVideoInput(
  fileName: string,
  prepared: PreparedVideoInput,
): string {
  const duration = prepared.durationSeconds === null
    ? "unknown"
    : `${prepared.durationSeconds.toFixed(1)} seconds`;
  const detail = prepared.mode === "frames"
    ? `Extracted ${prepared.framePaths.length} chronological frame(s), approximately one per second. The original video is also attached.`
    : `The clip was not auto-framed because its duration is unknown or exceeds ${SHORT_VIDEO_AUTO_FRAME_SECONDS} seconds. Inspect the attached original video with available tools if needed.`;
  return [
    "[Bridge video prepared]",
    `File: ${JSON.stringify(fileName)}`,
    `Duration: ${duration}`,
    detail,
    "[End bridge video preparation]",
  ].join("\n");
}
