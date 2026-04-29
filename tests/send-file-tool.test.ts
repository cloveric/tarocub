import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeTelegramTool } from "../src/tools/telegram-tool-executor.js";

async function withDeliveryContext<T>(
  fn: (ctx: {
    root: string;
    inboxDir: string;
    workspaceDir: string;
    api: {
      sendMessage: ReturnType<typeof vi.fn>;
      sendDocument: ReturnType<typeof vi.fn>;
      sendPhoto: ReturnType<typeof vi.fn>;
    };
  }) => Promise<T>,
): Promise<T> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "cctb-send-tool-"));
  const root = await realpath(rawRoot);
  const inboxDir = path.join(root, "instance", "inbox");
  const workspaceDir = path.join(root, "instance", "workspace");
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
  };
  try {
    await mkdir(workspaceDir, { recursive: true });
    return await fn({ root, inboxDir, workspaceDir, api });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("send file tools", () => {
  it("delivers a file through send.file", async () => {
    await withDeliveryContext(async ({ inboxDir, workspaceDir, api }) => {
      const filePath = path.join(workspaceDir, "report.txt");
      await writeFile(filePath, "hello", "utf8");

      const result = await executeTelegramTool({
        name: "send.file",
        payload: { path: filePath },
        context: {
          cronRuntime: null,
          stateDir: path.dirname(inboxDir),
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("File delivered");
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", expect.any(Uint8Array));
    });
  });

  it("returns a structured failure when a file cannot be delivered", async () => {
    await withDeliveryContext(async ({ inboxDir, workspaceDir, api }) => {
      const missingPath = path.join(workspaceDir, "missing.txt");

      const result = await executeTelegramTool({
        name: "send.file",
        payload: { path: missingPath },
        context: {
          cronRuntime: null,
          stateDir: path.dirname(inboxDir),
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not-found");
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("not delivered"));
    });
  });

  it("delivers mixed message, image, and file payloads through send.batch", async () => {
    await withDeliveryContext(async ({ inboxDir, workspaceDir, api }) => {
      const imagePath = path.join(workspaceDir, "chart.png");
      const filePath = path.join(workspaceDir, "report.pdf");
      await writeFile(imagePath, "image", "utf8");
      await writeFile(filePath, "pdf", "utf8");

      const result = await executeTelegramTool({
        name: "send.batch",
        payload: {
          message: "done",
          images: [imagePath],
          files: [filePath],
        },
        context: {
          cronRuntime: null,
          stateDir: path.dirname(inboxDir),
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "side-channel",
            allowAnyAbsolutePath: true,
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(result.metadata).toMatchObject({ requested: 2, accepted: 2, filesSent: 2 });
      expect(api.sendMessage).toHaveBeenCalledWith(123, "done", { parseMode: "Markdown" });
      expect(api.sendPhoto).toHaveBeenCalledWith(123, "chart.png", expect.any(Uint8Array), "chart.png");
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.pdf", expect.any(Uint8Array));
    });
  });

  it("does not treat legacy delivery tags inside send.batch message text as files to send", async () => {
    await withDeliveryContext(async ({ inboxDir, workspaceDir, api }) => {
      const reportPath = path.join(workspaceDir, "report.txt");
      const secretPath = path.join(workspaceDir, "secret.txt");
      await writeFile(reportPath, "report", "utf8");
      await writeFile(secretPath, "secret", "utf8");

      const result = await executeTelegramTool({
        name: "send.batch",
        payload: {
          message: `note [send-file:${secretPath}]`,
          files: [reportPath],
        },
        context: {
          cronRuntime: null,
          stateDir: path.dirname(inboxDir),
          chatId: 123,
          userId: 456,
          locale: "en",
          delivery: {
            api,
            inboxDir,
            source: "post-turn",
            allowAnyAbsolutePath: true,
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(api.sendDocument).toHaveBeenCalledTimes(1);
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", expect.any(Uint8Array));
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("note"),
        { parseMode: "Markdown" },
      );
    });
  });
});
