import { describe, expect, it, vi } from "vitest";

import {
  extractVideoCoverJpeg,
  sendLarkVideoWithCover,
  type VideoCoverExecFile,
} from "../src/lark/video-delivery.js";
import type { LarkChannelLike } from "../src/lark/types.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);

function fakeChannel() {
  const imageCreate = vi.fn(async () => ({ image_key: "img_cover" }));
  const send = vi.fn(async () => ({ messageId: "om_video" }));
  return {
    channel: {
      send,
      rawClient: { im: { v1: { image: { create: imageCreate } } } },
    } as unknown as LarkChannelLike,
    imageCreate,
    send,
  };
}

describe("Lark video cover delivery", () => {
  it("extracts a frame at one second and attaches its image_key to the video", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => ({
      stdout: JPEG,
      stderr: Buffer.alloc(0),
    }));
    const { channel, imageCreate, send } = fakeChannel();

    await sendLarkVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      options: { replyTo: "om_source" },
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-ss", "1"]));
    expect(imageCreate).toHaveBeenCalledWith({
      data: { image_type: "message", image: JPEG },
    });
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
        coverImageKey: "img_cover",
      },
    }, { replyTo: "om_source" });
  });

  it("falls back to frame zero when the one-second frame cannot be extracted", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>()
      .mockRejectedValueOnce(new Error("past end of short video"))
      .mockResolvedValueOnce({ stdout: JPEG, stderr: Buffer.alloc(0) });

    const cover = await extractVideoCoverJpeg("/tmp/short.mp4", execFileImpl);

    expect(cover).toEqual(JPEG);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(execFileImpl.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-ss", "0"]));
  });

  it("still sends the video when cover extraction fails", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => {
      throw new Error("ffmpeg unavailable");
    });
    const { channel, imageCreate, send } = fakeChannel();

    await sendLarkVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(imageCreate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
      },
    }, undefined);
  });

  it("still sends the video when Feishu rejects only the cover image", async () => {
    const execFileImpl = vi.fn<VideoCoverExecFile>(async () => ({
      stdout: JPEG,
      stderr: Buffer.alloc(0),
    }));
    const { channel, imageCreate, send } = fakeChannel();
    imageCreate.mockRejectedValueOnce(new Error("cover upload rejected"));

    await sendLarkVideoWithCover({
      channel,
      chatId: "oc_chat",
      videoPath: "/tmp/clip.mp4",
      body: Buffer.from("video"),
      fileName: "clip.mp4",
      execFileImpl,
    });

    expect(imageCreate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("oc_chat", {
      video: {
        source: Buffer.from("video"),
        fileName: "clip.mp4",
      },
    }, undefined);
  });
});
