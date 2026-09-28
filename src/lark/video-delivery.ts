import { execFile } from "node:child_process";

import { uploadLarkImageKey } from "./image-upload.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

const VIDEO_COVER_TIMEOUT_MS = 15_000;
const VIDEO_COVER_MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_COVER_SEEK_SECONDS = [1, 0] as const;

export type VideoCoverExecFile = (
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    encoding: null;
    windowsHide: boolean;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    encoding: null;
    windowsHide: boolean;
  },
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
      });
    });
  });
}

function isJpeg(body: Buffer): boolean {
  return body.length >= 4
    && body[0] === 0xff
    && body[1] === 0xd8
    && body[body.length - 2] === 0xff
    && body[body.length - 1] === 0xd9;
}

/** Extract a compact representative frame for Feishu's optional video cover. */
export async function extractVideoCoverJpeg(
  videoPath: string,
  execFileImpl: VideoCoverExecFile = defaultExecFile,
): Promise<Buffer | undefined> {
  for (const seekSeconds of VIDEO_COVER_SEEK_SECONDS) {
    try {
      const { stdout } = await execFileImpl("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(seekSeconds),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-q:v",
        "3",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ], {
        timeout: VIDEO_COVER_TIMEOUT_MS,
        maxBuffer: VIDEO_COVER_MAX_BYTES,
        encoding: null,
        windowsHide: true,
      });
      const body = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      if (isJpeg(body)) {
        return body;
      }
    } catch {
      // Cover generation is best-effort. Retry at frame zero, then send without
      // a cover rather than turning a cosmetic failure into a delivery failure.
    }
  }
  return undefined;
}

export async function sendLarkVideoWithCover(input: {
  channel: LarkChannelLike;
  chatId: string;
  videoPath: string;
  body: Buffer;
  fileName: string;
  options?: LarkSendOptions;
  execFileImpl?: VideoCoverExecFile;
}): Promise<void> {
  const cover = await extractVideoCoverJpeg(input.videoPath, input.execFileImpl);
  const coverImageKey = cover
    ? await uploadLarkImageKey(input.channel, cover).catch(() => undefined)
    : undefined;

  await input.channel.send(input.chatId, {
    video: {
      source: input.body,
      fileName: input.fileName,
      ...(coverImageKey ? { coverImageKey } : {}),
    },
  }, input.options);
}
