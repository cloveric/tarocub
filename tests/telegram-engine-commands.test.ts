import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleLocalEngineTelegramCommand } from "../src/telegram/engine-commands.js";
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

describe("handleLocalEngineTelegramCommand", () => {
  it("rejects /context on the wrong engine", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/context"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore: {
          removeByChatId: vi.fn(),
        },
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "/context is only supported with the Claude engine. Codex manages context server-side and does not expose this.",
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "context",
          rejected: "wrong-engine",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to session reset when /compact execution fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/compact"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("unsupported")),
        },
        sessionStore,
      });

      expect(handled).toBe(true);
      expect(sessionStore.removeByChatId).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "Compacting session context...");
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Engine does not support compact. Session reset instead (same effect).");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "compact",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rethrows auth failures during /compact so outer retry can handle them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
    };
    const authError = new Error("unauthorized");

    try {
      await expect(handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/compact"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn().mockRejectedValue(authError),
        },
        sessionStore,
      })).rejects.toBe(authError);

      expect(sessionStore.removeByChatId).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Compacting session context...");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs /ultrareview on Claude and relays the result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "review output" }),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude", resume: { workspacePath: "/tmp/work" } },
        normalized: createNormalizedMessage("/ultrareview"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
          abortSignal: undefined,
        },
        bridge,
        sessionStore: {
          removeByChatId: vi.fn(),
        },
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 123,
        text: "/ultrareview",
        workspaceOverride: "/tmp/work",
      }));
      expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "Running code review...");
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "review output");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns false for non-engine commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/help"),
        context: {
          api: { sendMessage: vi.fn() } as never,
          instanceName: "default",
          updateId: 80,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore: {
          removeByChatId: vi.fn(),
        },
      });

      expect(handled).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
