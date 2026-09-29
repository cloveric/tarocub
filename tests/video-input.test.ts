import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  formatPreparedVideoInput,
  prepareVideoInput,
  type VideoInputExecFile,
} from "../src/runtime/video-input.js";

function callbackSuccess(
  callback: Parameters<VideoInputExecFile>[3],
  stdout = "",
): void {
  callback(null, stdout, "");
}

describe("video input preparation", () => {
  it("extracts at most ten one-second frames from a short video", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-video-input-"));
    const videoPath = path.join(root, "clip.mp4");
    await writeFile(videoPath, "video");
    const execFileImpl = vi.fn<VideoInputExecFile>((file, args, _options, callback) => {
      if (file === "ffprobe") {
        callbackSuccess(callback, "7.2\n");
        return;
      }
      const pattern = args.at(-1)!;
      void (async () => {
        await mkdir(path.dirname(pattern), { recursive: true });
        for (let index = 1; index <= 7; index += 1) {
          await writeFile(pattern.replace("%02d", String(index).padStart(2, "0")), `frame-${index}`);
        }
        callbackSuccess(callback);
      })();
    });

    try {
      const prepared = await prepareVideoInput(videoPath, { execFileImpl });

      expect(prepared).toEqual({
        durationSeconds: 7.2,
        framePaths: Array.from({ length: 7 }, (_, index) => (
          path.join(`${videoPath}.frames`, `frame-${String(index + 1).padStart(2, "0")}.jpg`)
        )),
        mode: "frames",
      });
      expect(execFileImpl).toHaveBeenCalledTimes(2);
      expect(execFileImpl.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
        "-vf",
        "fps=1,scale='min(1280,iw)':-2",
        "-frames:v",
        "10",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hands videos over directly when they exceed ten seconds", async () => {
    const execFileImpl = vi.fn<VideoInputExecFile>((file, _args, _options, callback) => {
      expect(file).toBe("ffprobe");
      callbackSuccess(callback, "10.01\n");
    });

    const prepared = await prepareVideoInput("/tmp/long.mp4", { execFileImpl });

    expect(prepared).toEqual({ durationSeconds: 10.01, framePaths: [], mode: "direct" });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it("includes an exact ten-second video in automatic framing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-video-input-"));
    const videoPath = path.join(root, "ten-seconds.mp4");
    await writeFile(videoPath, "video");
    const execFileImpl = vi.fn<VideoInputExecFile>((file, args, _options, callback) => {
      if (file === "ffprobe") {
        callbackSuccess(callback, "10\n");
        return;
      }
      const pattern = args.at(-1)!;
      void (async () => {
        await mkdir(path.dirname(pattern), { recursive: true });
        await writeFile(pattern.replace("%02d", "01"), "frame");
        callbackSuccess(callback);
      })();
    });

    try {
      const prepared = await prepareVideoInput(videoPath, { execFileImpl });
      expect(prepared.mode).toBe("frames");
      expect(prepared.durationSeconds).toBe(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the original path when duration probing fails", async () => {
    const execFileImpl = vi.fn<VideoInputExecFile>((_file, _args, _options, callback) => {
      callback(new Error("ffprobe unavailable"), "", "ffprobe unavailable");
    });

    await expect(prepareVideoInput("/tmp/unknown.mp4", { execFileImpl })).resolves.toEqual({
      durationSeconds: null,
      framePaths: [],
      mode: "direct",
    });
  });

  it("falls back to the original path when frame extraction fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-video-input-"));
    const videoPath = path.join(root, "clip.mp4");
    await writeFile(videoPath, "video");
    const execFileImpl = vi.fn<VideoInputExecFile>((file, _args, _options, callback) => {
      if (file === "ffprobe") {
        callbackSuccess(callback, "4\n");
        return;
      }
      callback(new Error("ffmpeg failed"), "", "ffmpeg failed");
    });

    try {
      await expect(prepareVideoInput(videoPath, { execFileImpl })).resolves.toEqual({
        durationSeconds: 4,
        framePaths: [],
        mode: "direct",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes frame and direct modes without exposing implementation errors", () => {
    expect(formatPreparedVideoInput("clip.mp4", {
      durationSeconds: 7,
      framePaths: ["frame-01.jpg", "frame-02.jpg"],
      mode: "frames",
    })).toContain("Extracted 2 chronological frame(s)");
    expect(formatPreparedVideoInput("long.mp4", {
      durationSeconds: 30,
      framePaths: [],
      mode: "direct",
    })).toContain("exceeds 10 seconds");
  });
});
