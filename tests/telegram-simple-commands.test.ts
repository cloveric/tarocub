import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleSimpleLocalTelegramCommand } from "../src/telegram/simple-commands.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

describe("handleSimpleLocalTelegramCommand", () => {
  it("handles /help and writes command audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/help"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringMatching(/\/reset|\/status/));
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "help",
          chunkCount: expect.any(Number),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles /effort updates through the config mutator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, string>) => void) => {
      const cfg: Record<string, string> = {};
      mutate(cfg);
      expect(cfg.effort).toBe("high");
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/effort high"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Effort set to high.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns false for non-simple commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/not-a-simple-command"),
        context: {
          api: { sendMessage: vi.fn() } as never,
          instanceName: "default",
          updateId: 79,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles /status via the injected status snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const resolveStatus = vi.fn().mockResolvedValue({
      engine: "claude",
      sessionBound: true,
      threadId: null,
      blockingTasks: 2,
      waitingTasks: 1,
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        updateInstanceConfig: vi.fn(),
        resolveStatus,
      });

      expect(handled).toBe(true);
      expect(resolveStatus).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Engine: claude",
          "Session bound: yes",
          "Blocking file tasks: 2",
          "Waiting file tasks: 1",
        ].join("\n"),
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "status",
          responseChars: expect.any(Number),
          chunkCount: 1,
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes the current Codex thread id in /status when available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const resolveStatus = vi.fn().mockResolvedValue({
      engine: "codex",
      sessionBound: true,
      threadId: "thread-123",
      blockingTasks: 0,
      waitingTasks: 0,
    });

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        updateInstanceConfig: vi.fn(),
        resolveStatus,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Engine: codex",
          "Session bound: yes",
          "Current thread: thread-123",
          "Blocking file tasks: 0",
          "Waiting file tasks: 0",
        ].join("\n"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles /status defensively when no status resolver is wired", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-simple-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleSimpleLocalTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/status"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Status handler is not wired for this command path.");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "status",
          rejected: "status-handler-not-wired",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
