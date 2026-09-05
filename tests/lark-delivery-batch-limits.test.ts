import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deliverLarkResponse } from "../src/lark/delivery.js";
import { createLarkServiceRuntime } from "../src/lark/service.js";
import type { LarkChannelLike } from "../src/lark/types.js";

function channelWithImageUpload(upload = vi.fn(async () => ({ image_key: "img_key" }))) {
  return {
    send: vi.fn(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(),
    downloadResource: vi.fn(async () => Buffer.alloc(0)),
    rawClient: { im: { v1: { image: { create: upload } } } },
  } as unknown as LarkChannelLike;
}

function batchToolCall(paths: string[]): string {
  return [
    "```tool-call",
    JSON.stringify({ name: "send.batch", payload: { images: paths } }),
    "```",
  ].join("\n");
}

describe("Lark image batch resource bounds", () => {
  it("rejects a mixed send.batch over 120 MiB before sending any artifact", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-mixed-"));
    const workspace = path.join(stateDir, "workspace");
    const paths = Array.from({ length: 5 }, (_, index) => path.join(workspace, `part-${index + 1}.bin`));
    const channel = channelWithImageUpload();
    try {
      await mkdir(workspace, { recursive: true });
      for (const filePath of paths) {
        await writeFile(filePath, "");
        await truncate(filePath, 25 * 1024 * 1024);
      }

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: [
          "```tool-call",
          JSON.stringify({
            name: "send.batch",
            payload: { images: [paths[0]], files: paths.slice(1) },
          }),
          "```",
        ].join("\n"),
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect((channel.send as ReturnType<typeof vi.fn>).mock.calls.some((call) => {
        const payload = call[1] as { file?: unknown; image?: unknown; card?: unknown };
        return Boolean(payload.file || payload.image || payload.card);
      })).toBe(false);
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("120MB");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects more than 20 legacy image tags before uploading", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-legacy-count-"));
    const workspace = path.join(stateDir, "workspace");
    const paths = Array.from({ length: 21 }, (_, index) => path.join(workspace, `p${index + 1}.png`));
    const upload = vi.fn(async () => ({ image_key: "img_key" }));
    const channel = channelWithImageUpload(upload);
    try {
      await mkdir(workspace, { recursive: true });
      for (const filePath of paths) {
        await writeFile(filePath, "image");
      }

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: paths.map((filePath) => `[send-image:${filePath}]`).join("\n"),
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect(upload).not.toHaveBeenCalled();
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("20");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy mixed batch over 120 MiB before sending any artifact", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-legacy-mixed-"));
    const workspace = path.join(stateDir, "workspace");
    const paths = Array.from({ length: 5 }, (_, index) => path.join(workspace, `part-${index + 1}.bin`));
    const channel = channelWithImageUpload();
    try {
      await mkdir(workspace, { recursive: true });
      for (const filePath of paths) {
        await writeFile(filePath, "");
        await truncate(filePath, 25 * 1024 * 1024);
      }

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: [
          `[send-image:${paths[0]}]`,
          ...paths.slice(1).map((filePath) => `[send-file:${filePath}]`),
        ].join("\n"),
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect((channel.send as ReturnType<typeof vi.fn>).mock.calls.some((call) => {
        const payload = call[1] as { file?: unknown; image?: unknown; card?: unknown };
        return Boolean(payload.file || payload.image || payload.card);
      })).toBe(false);
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("120MB");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a batch whose images exceed 120 MiB in aggregate before uploading", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-bytes-"));
    const workspace = path.join(stateDir, "workspace");
    const paths = Array.from({ length: 5 }, (_, index) => path.join(workspace, `p${index + 1}.png`));
    const upload = vi.fn(async () => ({ image_key: "img_key" }));
    const channel = channelWithImageUpload(upload);
    try {
      await mkdir(workspace, { recursive: true });
      for (const filePath of paths) {
        await writeFile(filePath, "");
        await truncate(filePath, 25 * 1024 * 1024);
      }

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: batchToolCall(paths),
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect(upload).not.toHaveBeenCalled();
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("120MB");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reads each image only when it is uploaded instead of buffering the whole batch", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-stream-"));
    const workspace = path.join(stateDir, "workspace");
    const first = path.join(workspace, "p1.png");
    const second = path.join(workspace, "p2.png");
    const upload = vi.fn(async () => {
      if (upload.mock.calls.length === 1) {
        await rm(second);
      }
      return { image_key: "img_key" };
    });
    const channel = channelWithImageUpload(upload);
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(first, "first image");
      await writeFile(second, "second image");

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: batchToolCall([first, second]),
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("img_key");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a vanished image when a rejected single-image card needs fallback bytes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-card-fallback-read-"));
    const workspace = path.join(stateDir, "workspace");
    const imagePath = path.join(workspace, "cover.png");
    const upload = vi.fn(async () => {
      await rm(imagePath);
      return { image_key: "img_key" };
    });
    const channel = channelWithImageUpload(upload);
    (channel.send as ReturnType<typeof vi.fn>).mockImplementation(async (_chatId: string, payload: unknown) => {
      if ((payload as { card?: unknown } | undefined)?.card) {
        throw new Error("card payload too large");
      }
      return { messageId: "sent_1" };
    });
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(imagePath, "image");

      const result = await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: `[send-image:${imagePath}]`,
        stateDir,
      });

      expect(result.ok).toBe(false);
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("文件不存在");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
