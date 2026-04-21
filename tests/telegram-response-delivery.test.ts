import { mkdtemp, mkdir, realpath, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deliverTelegramResponse, sendFileOrPhoto } from "../src/telegram/response-delivery.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("sendFileOrPhoto", () => {
  it("uses sendPhoto for large image payloads", async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
    };

    await sendFileOrPhoto(api as never, 123, "diagram.png", new Uint8Array(2 * 1024 * 1024 + 1));

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
});

describe("deliverTelegramResponse", () => {
  it("sends cleaned text plus workspace files referenced via send-file tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-response-"));
    const realRoot = await realpath(root);
    const inboxDir = path.join(realRoot, "instance", "inbox");
    const workspaceDir = path.join(realRoot, "instance", "workspace");
    const filePath = path.join(workspaceDir, "report.txt");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(filePath, "hello from file", "utf8");

      const filesSent = await deliverTelegramResponse(
        api as never,
        123,
        `Done.\n\n[send-file:${filePath}]`,
        inboxDir,
        undefined,
        undefined,
        "en",
      );

      expect(filesSent).toBe(1);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Done.", { parseMode: "Markdown" });
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", expect.any(Uint8Array));
      const timeline = parseTimelineEvents(await readFile(path.join(path.dirname(inboxDir), "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        channel: "telegram",
        chatId: 123,
        metadata: expect.objectContaining({
          fileName: "report.txt",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces rejected out-of-workspace files to the chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-response-"));
    const realRoot = await realpath(root);
    const inboxDir = path.join(realRoot, "instance", "inbox");
    const outsideFile = path.join(realRoot, "outside.txt");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await writeFile(outsideFile, "secret", "utf8");

      const filesSent = await deliverTelegramResponse(
        api as never,
        123,
        `[send-file:${outsideFile}]`,
        inboxDir,
        undefined,
        undefined,
        "en",
      );

      expect(filesSent).toBe(0);
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("not delivered"),
      );
      const timeline = parseTimelineEvents(await readFile(path.join(path.dirname(inboxDir), "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.rejected",
        channel: "telegram",
        chatId: 123,
        metadata: expect.objectContaining({
          path: outsideFile,
          reason: "outside-workspace",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects workspace files outside the current codex request output directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-response-"));
    const realRoot = await realpath(root);
    const inboxDir = path.join(realRoot, "instance", "inbox");
    const workspaceDir = path.join(realRoot, "instance", "workspace");
    const currentOutputDir = path.join(workspaceDir, ".telegram-out", "req-current");
    const oldOutputDir = path.join(workspaceDir, ".telegram-out", "req-old");
    const staleFile = path.join(oldOutputDir, "stale.docx");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(currentOutputDir, { recursive: true });
      await mkdir(oldOutputDir, { recursive: true });
      await writeFile(staleFile, "old result", "utf8");

      const filesSent = await deliverTelegramResponse(
        api as never,
        123,
        `[send-file:${staleFile}]`,
        inboxDir,
        undefined,
        currentOutputDir,
        "en",
      );

      expect(filesSent).toBe(0);
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("not delivered"),
      );
      const timeline = parseTimelineEvents(await readFile(path.join(path.dirname(inboxDir), "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.rejected",
        channel: "telegram",
        chatId: 123,
        metadata: expect.objectContaining({
          path: staleFile,
          reason: "outside-request-output",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts Markdown-linked files whose absolute path contains parentheses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-response-"));
    const realRoot = await realpath(root);
    const inboxDir = path.join(realRoot, "instance", "inbox");
    const workspaceDir = path.join(realRoot, "instance", "workspace");
    const nestedDir = path.join(workspaceDir, "cache (2)");
    const filePath = path.join(nestedDir, "sheet.xlsx");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(nestedDir, { recursive: true });
      await writeFile(filePath, "xlsx-bytes", "utf8");

      const filesSent = await deliverTelegramResponse(
        api as never,
        123,
        `[download me](${filePath})`,
        inboxDir,
        undefined,
        undefined,
        "en",
      );

      expect(filesSent).toBe(1);
      expect(api.sendDocument).toHaveBeenCalledWith(123, "sheet.xlsx", expect.any(Uint8Array));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores Markdown-linked absolute file paths that include line suffixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-response-"));
    const realRoot = await realpath(root);
    const inboxDir = path.join(realRoot, "instance", "inbox");
    const workspaceDir = path.join(realRoot, "instance", "workspace");
    const filePath = path.join(workspaceDir, ".tmp_review_li_tao.md");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(filePath, "review body", "utf8");

      const filesSent = await deliverTelegramResponse(
        api as never,
        123,
        `See [review](<${filePath}:34>) for details.`,
        inboxDir,
        undefined,
        undefined,
        "en",
      );

      expect(filesSent).toBe(0);
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).not.toHaveBeenCalledWith(
        123,
        expect.stringContaining("not delivered"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rethrows non-Markdown Telegram delivery errors instead of silently falling back", async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue(new Error("Telegram API request failed for sendMessage: 403 Forbidden")),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };

    await expect(
      deliverTelegramResponse(api as never, 123, "hello", "/tmp/inbox", undefined, undefined, "en"),
    ).rejects.toThrow("403 Forbidden");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain text when Telegram rejects Markdown entity parsing", async () => {
    const api = {
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("Telegram API request failed for sendMessage: Bad Request: can't parse entities: Can't find end of Italic entity"))
        .mockResolvedValueOnce({ message_id: 2 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 3 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 4 }),
    };

    await expect(
      deliverTelegramResponse(api as never, 123, "preferred_layout", "/tmp/inbox", undefined, undefined, "en"),
    ).resolves.toBe(0);
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "preferred_layout", { parseMode: "Markdown" });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "preferred_layout");
  });
});
