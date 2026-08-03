import { mkdtemp, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import {
  createDefaultTranscribeVoice,
  prepareTelegramMessageInput,
  pruneTelegramInbox,
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
} from "../src/telegram/message-input.js";
import { CloudAsrCancelledError } from "../src/runtime/asr-cloud.js";
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

  it("surfaces a transcription-failure reply when a voice-only message transcribes to empty", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    // Voice-only message (no accompanying text) whose transcript comes back
    // empty must NOT yield an empty prompt fed to the engine.
    const normalized = createNormalizedMessage("", [{ fileId: "voice-1", kind: "voice" }]);
    const getFile = vi.fn(async () => ({ file_path: "voice/message.ogg" }));
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    const transcribeVoice = vi.fn().mockResolvedValue("   ");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: { getFile, downloadFile } as never,
        transcribeVoice,
      });

      expect(result).toEqual({
        kind: "reply",
        text: "Voice transcription failed. Please send a text message.",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps accompanying text when a voice transcript is empty instead of replying", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("please summarize", [{ fileId: "voice-1", kind: "voice" }]);
    const getFile = vi.fn(async () => ({ file_path: "voice/message.ogg" }));
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    const transcribeVoice = vi.fn().mockResolvedValue("");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: { getFile, downloadFile } as never,
        transcribeVoice,
      });

      expect(result).toEqual({
        kind: "ready",
        text: "please summarize",
        downloadedAttachments: [],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps a non-voice attachment when an accompanying voice transcript is empty (no text)", async () => {
    // Self-review regression: a silent voice note sent WITH an image and no text
    // must not short-circuit to a transcription-failure reply and eat the image —
    // the turn still has real content (the file), so it runs.
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("", [
      { fileId: "voice-1", kind: "voice" },
      { fileId: "img-1", kind: "photo" },
    ]);
    const getFile = vi.fn(async () => ({ file_path: "files/x" }));
    const downloadFile = vi.fn().mockResolvedValue(undefined);
    const transcribeVoice = vi.fn().mockResolvedValue("   ");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: { getFile, downloadFile } as never,
        transcribeVoice,
      });

      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        // The image survived; only the voice (transcribable) is filtered out.
        expect(result.downloadedAttachments).toEqual([
          expect.objectContaining({ attachment: expect.objectContaining({ fileId: "img-1" }) }),
        ]);
      }
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
      expect(transcribeVoice).toHaveBeenCalledWith(
        expect.stringMatching(/brief\.m4a$/),
        expect.objectContaining({ messageText: "please use this", stateDir: root }),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("downloads video attachments and appends their transcripts to the turn text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("make subtitles", [
      { fileId: "video-1", fileName: "lesson.mp4", kind: "video" },
    ]);
    const transcribeVoice = vi.fn().mockResolvedValue("video transcript");

    try {
      const result = await prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "videos/lesson.mp4" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice,
      });

      expect(result).toEqual({
        kind: "ready",
        text: "make subtitles\nvideo transcript",
        downloadedAttachments: [],
      });
      expect(transcribeVoice).toHaveBeenCalledTimes(1);
      expect(transcribeVoice).toHaveBeenCalledWith(
        expect.stringMatching(/lesson\.mp4$/),
        expect.objectContaining({ messageText: "make subtitles", stateDir: root }),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects oversized Telegram attachments before calling getFile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const getFile = vi.fn();
    const downloadFile = vi.fn();
    const normalized = createNormalizedMessage("make subtitles", [
      {
        fileId: "video-1",
        fileName: "lesson.mp4",
        fileSize: TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES + 1,
        kind: "video",
      },
    ]);

    try {
      await expect(
        prepareTelegramMessageInput({
          locale: "en",
          inboxDir: path.join(root, "inbox"),
          normalized,
          api: {
            getFile,
            downloadFile,
          } as never,
          transcribeVoice: vi.fn(),
        }),
      ).rejects.toThrow("Telegram attachment is too large to download via Bot API");
      expect(getFile).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
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

  it("propagates cancellation while transcribing a direct audio attachment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const cancelled = new CloudAsrCancelledError("cancelled");
    const normalized = createNormalizedMessage("", [
      { fileId: "audio-1", fileName: "request.m4a", kind: "audio" },
    ]);

    try {
      await expect(prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "audio/request.m4a" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice: vi.fn().mockRejectedValue(cancelled),
      })).rejects.toBe(cancelled);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("propagates cancellation while transcribing quoted audio", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const cancelled = new CloudAsrCancelledError("cancelled");
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

    try {
      await expect(prepareTelegramMessageInput({
        locale: "en",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "audio/request.m4a" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice: vi.fn().mockRejectedValue(cancelled),
      })).rejects.toBe(cancelled);
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

  it("returns a localized reply when video transcription fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const normalized = createNormalizedMessage("", [
      { fileId: "video-1", fileName: "lesson.mp4", kind: "video" },
    ]);

    try {
      const result = await prepareTelegramMessageInput({
        locale: "zh",
        inboxDir: path.join(root, "inbox"),
        normalized,
        api: {
          getFile: vi.fn().mockResolvedValue({ file_path: "videos/lesson.mp4" }),
          downloadFile: vi.fn().mockResolvedValue(undefined),
        } as never,
        transcribeVoice: vi.fn().mockRejectedValue(new Error("boom")),
      });

      expect(result).toEqual({
        kind: "reply",
        text: "视频转写失败，请发送文字消息或音频文件。",
      });
    } finally {
      await removeTempRoot(root);
    }
  });
});

describe("pruneTelegramInbox", () => {
  it("removes expired inbound files while preserving recent attachments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-inbox-prune-"));
    const inboxDir = path.join(root, "inbox");
    const now = Date.parse("2026-08-03T09:00:00.000Z");

    try {
      await mkdir(inboxDir, { recursive: true });
      const stalePath = path.join(inboxDir, "stale.bin");
      const recentPath = path.join(inboxDir, "recent.bin");
      await writeFile(stalePath, "stale", "utf8");
      await writeFile(recentPath, "recent", "utf8");
      await utimes(stalePath, new Date(now - 4 * 24 * 60 * 60_000), new Date(now - 4 * 24 * 60 * 60_000));
      await utimes(recentPath, new Date(now - 24 * 60 * 60_000), new Date(now - 24 * 60 * 60_000));

      await expect(pruneTelegramInbox(inboxDir, 3, now)).resolves.toBe(1);
      await expect(readdir(inboxDir)).resolves.toEqual(["recent.bin"]);
    } finally {
      await removeTempRoot(root);
    }
  });
});

describe("createDefaultTranscribeVoice", () => {
  it("splits long audio before transcription to keep ASR memory bounded", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      const chunkName = path.basename(body.path ?? "", path.extname(body.path ?? ""));
      return {
        ok: true,
        text: async () => `${chunkName} transcript`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1069.261333\n", "");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void Promise.all([
          writeFile(pattern.replace("%03d", "000"), "chunk-000"),
          writeFile(pattern.replace("%03d", "001"), "chunk-001"),
        ]).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 300,
      chunkSeconds: 120,
    } as never);

    await expect(transcribeVoice("/tmp/long-meeting.m4a")).resolves.toBe("chunk-000 transcript\nchunk-001 transcript");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as { path?: string };
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body ?? "{}")) as { path?: string };
    expect(firstBody.path).toMatch(/chunk-000\.wav$/);
    expect(secondBody.path).toMatch(/chunk-001\.wav$/);
  });

  it("keeps partial long-audio transcripts when a chunk fails", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      const chunkName = path.basename(body.path ?? "", path.extname(body.path ?? ""));
      if (chunkName === "chunk-001") {
        return {
          ok: false,
          status: 500,
          text: async () => "",
        };
      }
      return {
        ok: true,
        text: async () => `${chunkName} transcript`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1069.261333\n", "");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void Promise.all([
          writeFile(pattern.replace("%03d", "000"), "chunk-000"),
          writeFile(pattern.replace("%03d", "001"), "chunk-001"),
          writeFile(pattern.replace("%03d", "002"), "chunk-002"),
        ]).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 300,
      chunkSeconds: 120,
    } as never);

    const transcript = await transcribeVoice("/tmp/long-meeting.m4a");

    // Successful chunks are kept; the per-chunk failure marker is NOT blended
    // into the transcript (it is an infra error, not user speech).
    expect(transcript).toContain("chunk-000 transcript");
    expect(transcript).toContain("chunk-002 transcript");
    expect(transcript).not.toContain("transcription failed");
    expect(transcript).not.toContain("chunk 2/3");
  });

  it("extracts short video audio to wav before transcription", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return {
        ok: true,
        text: async () => `transcribed ${path.basename(body.path ?? "")}`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "37.5\n", "");
        return;
      }

      if (file === "ffmpeg") {
        expect(args).toContain("-vn");
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 120,
      chunkSeconds: 60,
    } as never);

    await expect(transcribeVoice("/tmp/short-clip.mp4")).resolves.toBe("transcribed chunk-000.wav");

    expect(execFileImpl).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "/tmp/short-clip.mp4", "-vn"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("still extracts video audio when ffprobe cannot read the duration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const videoPath = path.join(root, "short-clip.mp4");
    await writeFile(videoPath, "video");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return {
        ok: true,
        text: async () => `transcribed ${path.basename(body.path ?? "")}`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(new Error("ffprobe failed"), "", "ffprobe failed");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 120,
      chunkSeconds: 60,
    } as never);

    try {
      await expect(transcribeVoice(videoPath)).resolves.toBe("transcribed chunk-000.wav");
      expect(execFileImpl).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining(["-i", videoPath, "-vn"]),
        expect.any(Object),
        expect.any(Function),
      );
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("warns and falls back to single-file transcription when ffprobe fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-input-"));
    const audioPath = path.join(root, "meeting.m4a");
    await writeFile(audioPath, "audio");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "single transcript",
    });
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(new Error("ffprobe missing"), "", "ffprobe missing");
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
    } as never);

    try {
      await expect(transcribeVoice(audioPath)).resolves.toBe("single transcript");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ffprobe failed"));
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("caps configured ASR chunks below the local service's 300-second limit", async () => {
    let segmentTimeArg = "";
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "chunk transcript",
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1200\n", "");
        return;
      }

      if (file === "ffmpeg") {
        segmentTimeArg = String(args[args.indexOf("-segment_time") + 1]);
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkSeconds: 99_999,
    } as never);

    await expect(transcribeVoice("/tmp/meeting.m4a")).resolves.toBe("chunk transcript");

    expect(segmentTimeArg).toBe("270");
  });

  it("cancels local Qwen HTTP transcription without watchdog noise or CLI fallback", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectCancelled = () => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error("local ASR cancelled"));
        };
        markRequestStarted?.();
        if (signal?.aborted) {
          rejectCancelled();
          return;
        }
        signal?.addEventListener("abort", rejectCancelled, { once: true });
      })
    );
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      options: { signal?: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        expect(options.signal).toBeDefined();
        callback(null, "30\n", "");
        return;
      }
      callback(new Error(`unexpected CLI fallback: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
    } as never);
    const controller = new AbortController();
    const pending = transcribeVoice("/tmp/voice.ogg", { abortSignal: controller.signal });

    await requestStarted;
    controller.abort(new Error("stopped by user"));

    await expect(pending).rejects.toThrow("stopped by user");
    expect(watchdog.recordFailure).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalledWith(
      "/tmp/qwen-python",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes the turn cancellation signal into local Qwen CLI fallback", async () => {
    let markCliStarted: (() => void) | undefined;
    const cliStarted = new Promise<void>((resolve) => {
      markCliStarted = resolve;
    });
    let observedCliSignal: AbortSignal | undefined;
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      options: { signal?: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "30\n", "");
        return;
      }
      if (file === "/tmp/qwen-python") {
        observedCliSignal = options.signal;
        markCliStarted?.();
        options.signal?.addEventListener("abort", () => {
          callback(new Error("qwen CLI aborted"), "", "");
        }, { once: true });
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      execFileImpl,
      ffprobePath: "ffprobe",
    } as never);
    const controller = new AbortController();
    const pending = transcribeVoice("/tmp/voice.ogg", { abortSignal: controller.signal });

    await cliStarted;
    controller.abort(new Error("stopped by user"));

    await expect(pending).rejects.toThrow("qwen CLI aborted");
    expect(observedCliSignal).toBe(controller.signal);
  });

  it("uses a configurable ASR HTTP timeout", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted by test timeout")), { once: true });
        setTimeout(() => reject(new Error(`not aborted: ${String(signal?.aborted)}`)), 20);
      })
    );
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      httpTimeoutMs: 1,
    } as never);

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("ASR not configured");

    expect(watchdog.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "aborted by test timeout",
    }));
  });

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
