import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { createDefaultTranscribeVoice, prepareTelegramMessageInput } from "../src/telegram/message-input.js";
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
      await removeTempRoot(root);
    }
  });

  it("downloads audio attachments and appends their transcripts to the turn text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("please use this", [
      { fileId: "audio-1", fileName: "brief.m4a", kind: "audio" },
    ]);
    const transcribeVoice = vi.fn().mockResolvedValue("audio transcript");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "audio/brief.m4a" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice,
      });

      expect(result).toEqual({
        kind: "ready",
        text: "please use this\naudio transcript",
        downloadedAttachments: [],
      });
      expect(transcribeVoice).toHaveBeenCalledTimes(1);
      expect(transcribeVoice).toHaveBeenCalledWith(expect.stringMatching(/brief\.m4a$/));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("transcribes quoted audio into the reply context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized: NormalizedTelegramMessage = {
      ...createNormalizedMessage("draft from this", []),
      replyContext: {
        messageId: 99,
        text: "",
        audioAttachment: {
          fileId: "quoted-audio-1",
          fileName: "request.m4a",
          kind: "audio",
        },
      },
    };
    const transcribeVoice = vi.fn().mockResolvedValue("quoted audio transcript");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "audio/request.m4a" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice,
      });

      expect(result.kind).toBe("ready");
      expect(normalized.replyContext?.text).toBe("[Quoted audio transcript]\nquoted audio transcript");
      expect(transcribeVoice).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });
});

describe("createDefaultTranscribeVoice", () => {
  it("records ASR HTTP failures with the watchdog before falling back", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl,
      watchdog,
    });

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("ASR not configured");

    expect(watchdog.recordFailure).toHaveBeenCalledTimes(1);
    expect(watchdog.recordSuccess).not.toHaveBeenCalled();
  });

  it("treats an empty ASR HTTP response as a watchdog failure", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl,
      watchdog,
    });

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("ASR not configured");

    expect(watchdog.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "ASR HTTP server returned an empty transcript",
    }));
    expect(watchdog.recordSuccess).not.toHaveBeenCalled();
  });
});
