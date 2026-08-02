import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

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
  vi.useRealTimers();
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("requires an explicit Kimi session id instead of scanning Claude sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const scanRecentSessions = vi.fn();

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "kimi" },
        normalized: createNormalizedMessage("/resume"),
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
        scanRecentSessions,
      });

      expect(handled).toBe(true);
      expect(scanRecentSessions).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "For Kimi, use /resume session <session-id>. Kimi ACP does not currently expose a local session scan that the bridge can use.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("expires cached /resume scans after 10 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T10:00:00.000Z"));
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
    const scannedSessions = [
      {
        sessionId: "session-1",
        dirName: "project-a",
        workspacePath: "/tmp/project-a",
        modifiedAt: "2026-04-19T09:55:00.000Z",
        displayName: "project-a",
      },
    ];

    try {
      await expect(handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 84,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentSessions: vi.fn().mockResolvedValue(scannedSessions),
        formatSessionListMessage: vi.fn().mockReturnValue("1. project-a"),
      })).resolves.toBe(true);

      vi.setSystemTime(new Date("2026-04-19T10:11:00.000Z"));

      await expect(handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 85,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      })).resolves.toBe(true);

      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Invalid selection. Send /resume first to scan.",
      );
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("attaches a validated Kimi session with /resume session <session-id>", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: { codexSessionId: "kimi-old" },
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
        cfg: { engine: "kimi" },
        normalized: createNormalizedMessage("/resume session kimi-new"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 801,
        },
        sessionStore,
        updateInstanceConfig,
        validateCodexThread,
      });

      expect(handled).toBe(true);
      expect(validateCodexThread).toHaveBeenCalledWith("kimi-new");
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "kimi-new",
        status: "idle",
        updatedAt: expect.any(String),
        suspendedPrevious: {
          sessionId: "kimi-old",
          resume: null,
        },
      });
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Attached Kimi session: kimi-new\n\nSend a message to continue. Use /detach when done.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("fails closed when a Kimi session cannot be loaded", async () => {
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
        cfg: { engine: "kimi" },
        normalized: createNormalizedMessage("/resume session kimi-missing"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 802,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        validateCodexThread: vi.fn().mockRejectedValue(new Error("Kimi ACP could not load session")),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Could not load Kimi session: kimi-missing");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("attaches an Antigravity conversation with /resume conversation <conversation-id>", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: { codexSessionId: "old-conversation" },
        warning: undefined,
      }),
      removeByChatId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume conversation fdfc8ab1-7936-4599-98b0-d8ba2593c250"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        status: "idle",
        updatedAt: expect.any(String),
        suspendedPrevious: {
          sessionId: "old-conversation",
          resume: null,
        },
      });
      expect(updateInstanceConfig).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Attached Antigravity conversation: fdfc8ab1-7936-4599-98b0-d8ba2593c250\n\nSend a message to continue. Use /detach when done.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects malformed Antigravity conversation ids before persisting them", async () => {
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
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume conversation random-garbage"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Invalid Antigravity conversation id. Use /resume to scan recent conversations or /resume conversation <uuid>.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("lists recent Antigravity conversations with plain /resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const scanRecentAntigravitySessions = vi.fn().mockResolvedValue([
      {
        sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        dirName: "antigravity",
        workspacePath: null,
        modifiedAt: new Date(Date.now() - 60_000),
        displayName: "conversation fdfc8ab1",
      },
    ]);

    try {
      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore: {
          inspect: vi.fn(),
          findByChatIdSafe: vi.fn().mockResolvedValue({ record: null, warning: undefined }),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
        },
        updateInstanceConfig: vi.fn(),
        scanRecentAntigravitySessions,
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("Recent Antigravity conversations:"),
      );
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("Reply /resume <number> to attach that conversation."),
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("attaches an Antigravity conversation from a scanned /resume pick", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn().mockResolvedValue({
        record: { codexSessionId: "old-conversation" },
        warning: undefined,
      }),
      removeByChatId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    const updateInstanceConfig = vi.fn();

    try {
      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig,
        scanRecentAntigravitySessions: vi.fn().mockResolvedValue([
          {
            sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
            dirName: "antigravity",
            workspacePath: null,
            modifiedAt: new Date(),
            displayName: "conversation fdfc8ab1",
          },
        ]),
      });

      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).toHaveBeenCalledWith({
        telegramChatId: 123,
        codexSessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        status: "idle",
        updatedAt: expect.any(String),
        suspendedPrevious: {
          sessionId: "old-conversation",
          resume: null,
        },
      });
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Attached Antigravity conversation: fdfc8ab1-7936-4599-98b0-d8ba2593c250\n\nSend a message to continue. Use /detach when done.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not reuse Claude resume scan picks for Antigravity conversations", async () => {
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
      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentSessions: vi.fn().mockResolvedValue([
          {
            sessionId: "claude-session-1",
            dirName: "-tmp-project",
            workspacePath: "/tmp/project",
            modifiedAt: new Date(),
            displayName: "project",
          },
        ]),
      });

      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Invalid selection. Send /resume first to scan Antigravity conversations.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("clears stale Antigravity resume picks when a later scan finds nothing", async () => {
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
    const scanRecentAntigravitySessions = vi.fn()
      .mockResolvedValueOnce([
        {
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
          dirName: "antigravity",
          workspacePath: null,
          modifiedAt: new Date(),
          displayName: "conversation fdfc8ab1",
        },
      ])
      .mockResolvedValueOnce([]);

    try {
      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentAntigravitySessions,
      });

      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentAntigravitySessions,
      });

      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Invalid selection. Send /resume first to scan Antigravity conversations.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not allow picking Antigravity conversations hidden behind the list cap", async () => {
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
    const scanRecentAntigravitySessions = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        sessionId: `${String(index).padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`,
        dirName: "antigravity",
        workspacePath: null,
        modifiedAt: new Date(Date.now() - index * 60_000),
        displayName: `conversation ${String(index).padStart(8, "0")}`,
      })),
    );

    try {
      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentAntigravitySessions,
      });

      const hiddenHandled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "antigravity" },
        normalized: createNormalizedMessage("/resume 21"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(hiddenHandled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Invalid selection. Send /resume first to scan Antigravity conversations.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("clears stale Claude resume picks when a later scan finds nothing", async () => {
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
    const scanRecentSessions = vi.fn()
      .mockResolvedValueOnce([
        {
          sessionId: "claude-session-1",
          dirName: "-tmp-project",
          workspacePath: "/tmp/project",
          modifiedAt: new Date(),
          displayName: "project",
        },
      ])
      .mockResolvedValueOnce([]);

    try {
      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentSessions,
      });

      await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        scanRecentSessions,
      });

      const handled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.upsert).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Invalid selection. Send /resume first to scan.",
      );
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("detaches the current Kimi session when one is bound", async () => {
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
        cfg: { engine: "kimi" },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 811,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(sessionStore.removeByChatId).toHaveBeenCalledWith(123);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Detached from the current Kimi session. Next message will start a fresh session.",
      );
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("does not claim to restore a previous Codex conversation when none existed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    let record: {
      codexSessionId: string;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: null;
      };
    } | null = null;
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn(async () => ({ record, warning: undefined })),
      removeByChatId: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(async (next) => {
        record = {
          codexSessionId: next.codexSessionId,
          suspendedPrevious: next.suspendedPrevious,
        };
      }),
    };

    try {
      const resumeHandled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/resume thread thread-new"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 86,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
        validateCodexThread: vi.fn().mockResolvedValue(undefined),
      });

      expect(resumeHandled).toBe(true);

      const detachHandled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("/detach"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 87,
        },
        sessionStore,
        updateInstanceConfig: vi.fn(),
      });

      expect(detachHandled).toBe(true);
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Detached from the current Codex thread. Next message will start a fresh thread.",
      );
    } finally {
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("does not claim to restore a previous Claude conversation when none existed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-session-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    let record: {
      codexSessionId: string;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: null;
      };
    } | null = null;
    const sessionStore = {
      inspect: vi.fn(),
      findByChatIdSafe: vi.fn(async () => ({ record, warning: undefined })),
      removeByChatId: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(async (next) => {
        record = {
          codexSessionId: next.codexSessionId,
          suspendedPrevious: next.suspendedPrevious,
        };
      }),
    };
    const updateInstanceConfig = vi.fn();

    try {
      const resumeHandled = await handleLocalSessionTelegramCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("/resume 1"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 88,
        },
        sessionStore,
        updateInstanceConfig,
        scanRecentSessions: vi.fn().mockResolvedValue([
          {
            sessionId: "claude-resumed",
            dirName: "new-proj",
            workspacePath: "/tmp/new-proj",
            displayName: "new-proj",
            modifiedAt: new Date().toISOString(),
          },
        ]),
        formatSessionListMessage: vi.fn().mockReturnValue("1. new-proj"),
      });

      expect(resumeHandled).toBe(true);

      const detachHandled = await handleLocalSessionTelegramCommand({
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
          updateId: 89,
        },
        sessionStore,
        updateInstanceConfig,
      });

      expect(detachHandled).toBe(true);
      expect(api.sendMessage).toHaveBeenLastCalledWith(
        123,
        "Detached from resumed session. Back to default workspace.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });
});
