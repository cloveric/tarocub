import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { prepareTelegramMessageInput } from "../src/telegram/message-input.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(
  text: string,
  attachments: NormalizedTelegramMessage["attachments"],
): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments,
  };
}

describe("prepareTelegramMessageInput", () => {
  it("downloads attachments and appends voice transcripts to the turn text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("hello", [
      { fileId: "doc-1", fileName: "notes.txt", kind: "document" },
      { fileId: "voice-1", kind: "voice" },
    ]);
    const getFile = vi.fn(async (fileId: string) => ({
      file_path: fileId === "doc-1" ? "documents/notes.txt" : "voice/message.ogg",
    }));
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    const transcribeVoice = vi.fn().mockResolvedValue("spoken transcript");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile,
          downloadFile,
        } as never,
        transcribeVoice,
      });

      expect(result).toEqual({
        kind: "ready",
        text: "hello\nspoken transcript",
        downloadedAttachments: [
          expect.objectContaining({
            attachment: expect.objectContaining({ fileId: "doc-1", kind: "document" }),
          }),
        ],
      });
      expect(transcribeVoice).toHaveBeenCalledTimes(1);
      expect(downloadFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a localized reply when voice transcription fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("", [
      { fileId: "voice-1", kind: "voice" },
    ]);

    try {
      const result = await prepareTelegramMessageInput({
        locale: "zh",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "voice/message.ogg" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice: vi.fn().mockRejectedValue(new Error("boom")),
      });

      expect(result).toEqual({
        kind: "reply",
        text: "语音转写失败，请发送文字消息。",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
