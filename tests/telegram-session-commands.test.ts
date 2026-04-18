import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleLocalSessionTelegramCommand,
  resetPendingResumeScans,
} from "../src/telegram/session-commands.js";
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

afterEach(() => {
  resetPendingResumeScans();
});

describe("handleLocalSessionTelegramCommand", () => {
  it("handles /reset and records command audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn().mockResolvedValue({ warning: undefined, repairable: false }),
      removeByChatId: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn(),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/reset"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.removeByChatId).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Session reset for this chat.");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "reset",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects /resume on the wrong engine", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        sessionStore: {
          inspect: vi.fn(),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "/resume is only supported with the Claude engine. Codex sessions are server-side and cannot be resumed locally.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles /detach with no resumed session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        sessionStore: {
          inspect: vi.fn(),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "No resumed session active.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
