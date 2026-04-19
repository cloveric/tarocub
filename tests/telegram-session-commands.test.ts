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
      findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
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
          findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "For Codex, use /resume thread <thread-id>. Plain /resume scan is Claude-only.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches a Codex thread with /resume thread <thread-id>", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: { codexSessionId: "thread-old" },
        warning: undefined,
      }),
      removeByChatId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn();
    const validateCodexThread = vi.fn().mockResolvedValue(undefined);

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/resume thread thread-abc"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig,
        validateCodexThread,
      });

      expect(handled).toBe(true);
      expect(validateCodexThread).toHaveBeenCalledWith("thread-abc");
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "thread-abc",
        status: "idle",
        updatedAt: expect.any(String),
        suspendedPrevious: {
          sessionId: "thread-old",
          resume: null,
        },
      });
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Attached Codex thread: thread-abc\n\nSend a message to continue. Use /detach when done.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects /resume thread when the Codex thread cannot be validated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
      removeByChatId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/resume thread thread-missing"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        validateCodexThread: vi.fn().mockRejectedValue(new Error("codex app-server could not resume thread thread-missing")),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Codex thread not found: thread-missing\n\nCheck the thread ID and try again.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the current Codex runtime cannot validate external threads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
      removeByChatId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/resume thread thread-abc"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 83,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        validateCodexThread: vi.fn().mockRejectedValue(new Error("codex thread validation unsupported")),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "This Codex runtime cannot validate external thread IDs for /resume thread.",
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
          findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
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

  it("detaches the current Codex thread when one is bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
      removeByChatId: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.removeByChatId).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Detached from the current Codex thread. Next message will start a fresh thread.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous Codex thread on /detach after /resume thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: {
          codexSessionId: "thread-new",
          suspendedPrevious: {
            sessionId: "thread-old",
            resume: null,
          },
        },
        warning: undefined,
      }),
      removeByChatId: vi.fn().mockResolvedValue(true),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 84,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "thread-old",
        status: "idle",
        updatedAt: expect.any(String),
      });
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Detached from the current Codex thread and restored the previous conversation.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous Claude conversation and workspace on /detach", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: {
          codexSessionId: "claude-resumed",
          suspendedPrevious: {
            sessionId: "claude-old",
            resume: {
              sessionId: "claude-old",
              dirName: "old-proj",
              workspacePath: "/tmp/old-proj",
            },
          },
        },
        warning: undefined,
      }),
      removeByChatId: vi.fn().mockResolvedValue(true),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      const cfg: Record<string, unknown> = {};
      mutate(cfg);
      expect(cfg.resume).toEqual({
        sessionId: "claude-old",
        dirName: "old-proj",
        workspacePath: "/tmp/old-proj",
      });
    });

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {
          engine: "claude",
          resume: {
            sessionId: "claude-resumed",
            dirName: "new-proj",
            workspacePath: "/tmp/new-proj",
          },
        },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 85,
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "claude-old",
        status: "idle",
        updatedAt: expect.any(String),
      });
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Detached from resumed session and restored the previous conversation.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
