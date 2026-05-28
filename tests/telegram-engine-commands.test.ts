import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

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
  it("shows engine choices on bare /engine", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/engine"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 76,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore: {
          removeByChatId: vi.fn(),
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        [
          "Current engine: claude",
          "Choose an engine with /engine <name>:",
          "/engine claude",
          "/engine codex",
          "/engine antigravity",
          "Restart this instance after switching to apply the change.",
        ].join("\n"),
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "engine",
          value: "query",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("switches engine locally and clears incompatible model overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const order: string[] = [];
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn().mockImplementation(async () => {
        order.push("clear");
        return 2;
      }),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      order.push("config");
      const cfg: Record<string, unknown> = { engine: "claude", model: "opus" };
      mutate(cfg);
      expect(cfg.engine).toBe("codex");
      expect(cfg.model).toBeUndefined();
    });

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude", model: "opus" },
        normalized: createNormalizedMessage("/engine codex"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 76,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(sessionStore.clearAll).toHaveBeenCalledOnce();
      expect(order).toEqual(["clear", "config"]);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Engine set to codex. Cleared the previous model override and reset this instance's session bindings. Restart this instance to apply.",
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "engine",
          value: "codex",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("switches to Antigravity locally and clears incompatible model overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn().mockResolvedValue(1),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = { engine: "codex", model: "gpt-5.4", codexServiceTier: "fast" };
      mutate(cfg);
      expect(cfg.engine).toBe("antigravity");
      expect(cfg.approvalMode).toBe("bypass");
      expect(cfg.model).toBeUndefined();
      expect(cfg.codexServiceTier).toBeUndefined();
    });

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", model: "gpt-5.4" },
        normalized: createNormalizedMessage("/engine antigravity"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 76,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(sessionStore.clearAll).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Engine set to antigravity. Cleared the previous model override and reset this instance's session bindings. Restart this instance to apply.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps the old engine when session bindings cannot be reset first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn().mockRejectedValue(new Error("session store unavailable")),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude", model: "opus" },
        normalized: createNormalizedMessage("/engine codex"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(sessionStore.clearAll).toHaveBeenCalledOnce();
      expect(updateInstanceConfig).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Could not switch to codex because this instance's session bindings could not be reset first. Engine remains claude.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("returns usage for /engine commands with extra trailing words", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/engine codex please"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        },
        sessionStore: {
          removeByChatId: vi.fn(),
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Usage: /engine [claude|codex|antigravity]");
    } finally {
      await removeTempRoot(root);
    }
  });

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
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "/context is only supported with the Claude engine. The current engine does not expose local context.",
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
      await removeTempRoot(root);
    }
  });

  it("rejects /compact on the wrong engine instead of sending it as a model prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/compact"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge,
        sessionStore: {
          removeByChatId: vi.fn(),
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "/compact is only supported with the Claude engine. The current engine does not run local context compaction; use /reset to clear this conversation.",
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "compact",
          rejected: "wrong-engine",
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("falls back to session reset when /compact execution fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn(),
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
        updateInstanceConfig: vi.fn(),
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
      await removeTempRoot(root);
    }
  });

  it("resets the current topic session when /compact fails in a forum topic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const normalized = createNormalizedMessage("/compact");
    normalized.chatId = -100123;
    normalized.chatType = "supergroup";
    normalized.messageThreadId = 88;
    normalized.conversationKey = "chat:-100123:topic:88";
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      removeByConversationKey: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn(),
    };

    try {
      const handled = await handleLocalEngineTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized,
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("unsupported")),
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.removeByConversationKey).toHaveBeenCalledWith("chat:-100123:topic:88");
      expect(sessionStore.removeByChatId).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });


  it("rethrows auth failures during /compact so outer retry can handle them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-engine-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      removeByChatId: vi.fn().mockResolvedValue(true),
      clearAll: vi.fn(),
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
        updateInstanceConfig: vi.fn(),
      })).rejects.toBe(authError);

      expect(sessionStore.removeByChatId).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Compacting session context...");
    } finally {
      await removeTempRoot(root);
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
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
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
      await removeTempRoot(root);
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
          clearAll: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(false);
    } finally {
      await removeTempRoot(root);
    }
  });
});
