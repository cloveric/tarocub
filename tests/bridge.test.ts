import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { AccessStore } from "../src/state/access-store.js";

describe("Bridge", () => {
  it("routes an authorized message through the current session", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(accessStore.load).toHaveBeenCalledTimes(1);
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", expect.objectContaining({
      text: "hello",
      files: [],
      instructions: expect.stringContaining("Telegram chat bridge"),
      requestOutputDir: undefined,
    }));
    expect((adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.instructions).toContain(
      "```file:example.py",
    );
    expect((adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.instructions).toContain(
      "deliver it as a Telegram document attachment",
    );
    expect(result.text).toBe("done");
    expect(sessionManager.bindSession).not.toHaveBeenCalled();
  });

  it("disables runtime timeout only when the user explicitly asks for a long task", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "请执行任务：把这批图都跑完，不设超时。",
      replyContext: undefined,
      files: [],
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", expect.objectContaining({
      disableRuntimeTimeout: true,
    }));
  });

  it("keeps runtime timeout enabled for ordinary execution requests", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "请执行任务：卸载 browser harness。",
      replyContext: undefined,
      files: [],
    });

    expect((adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.disableRuntimeTimeout).toBeUndefined();
  });

  it("rejects a message when the chat is not on the allowlist", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).rejects.toThrow("This chat is not authorized for this instance.");
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("logs access-store read failures before denying access", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockRejectedValue(new Error("access unavailable")),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const bridge = new Bridge(accessStore, sessionManager, adapter);

      await expect(
        bridge.handleAuthorizedMessage({
          chatId: 84,
          userId: 42,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          files: [],
        }),
      ).rejects.toThrow("This chat is not authorized for this instance.");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to load access state; denying access:",
        "access unavailable",
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("blocks an unknown chat in pairing mode and returns a pairing code", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({
        code: "ABC123",
      }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({
      text: "Pair this private chat with code ABC123",
    });
    expect(accessStore.issuePairingCode).toHaveBeenCalledWith({
      telegramUserId: 42,
      telegramChatId: 84,
      now: expect.any(Date),
    });
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("localizes access replies when locale is zh", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({ code: "ABC123" }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };
    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "group",
        locale: "zh",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "此 bot 只接受私聊。" });

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "private",
        locale: "zh",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "使用配对码 ABC123 配对此私聊" });
  });

  it("blocks a different private chat by default when the instance is already bound elsewhere", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [
          {
            telegramUserId: 42,
            telegramChatId: 84,
            pairedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 99,
        userId: 99,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({
      text: "This instance is locked to another chat. Enable multi-chat before pairing or allowing a different chat.",
    });

    expect(accessStore.issuePairingCode).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("blocks a different private chat when another chat already has a pending pairing code", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [
          {
            code: "ABC123",
            telegramUserId: 42,
            telegramChatId: 84,
            expiresAt: "2026-04-08T00:05:00.000Z",
          },
        ],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 99,
        userId: 99,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({
      text: "This instance is locked to another chat. Enable multi-chat before pairing or allowing a different chat.",
    });

    expect(accessStore.issuePairingCode).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("allows a second private chat to pair when multi-chat is explicitly enabled", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: true,
        policy: "pairing",
        pairedUsers: [
          {
            telegramUserId: 42,
            telegramChatId: 84,
            pairedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({ code: "ABC123" }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 99,
        userId: 99,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({
      text: "Pair this private chat with code ABC123",
    });

    expect(accessStore.issuePairingCode).toHaveBeenCalledOnce();
  });

  it("allows a paired chat in pairing mode", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [
          {
            telegramUserId: 42,
            telegramChatId: 84,
            pairedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({ text: "done" });
    expect(accessStore.issuePairingCode).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("validates an external Codex thread through the adapter when supported", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn(),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
      validateExternalSession: vi.fn().mockResolvedValue(undefined),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.validateCodexThread("thread-123");

    expect(adapter.validateExternalSession).toHaveBeenCalledWith("thread-123");
  });

  it("fails closed when the adapter cannot validate an external Codex thread", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn(),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(bridge.validateCodexThread("thread-123")).rejects.toThrow(
      "codex thread validation unsupported",
    );
  });

  it("requires a revoked chat to pair again under pairing policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const accessStore = new AccessStore(path.join(dir, "access.json"));
      const issued = await accessStore.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });
      await accessStore.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));
      await accessStore.revokeChat(84);

      const sessionManager: SessionManagerLike = {
        getOrCreateSession: vi.fn(),
        bindSession: vi.fn(),
      };
      const adapter: CodexAdapter = {
        sendUserMessage: vi.fn(),
        createSession: vi.fn(),
      };

      const bridge = new Bridge(accessStore, sessionManager, adapter);
      const result = await bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        chatType: "private",
        text: "hello again",
        replyContext: undefined,
        files: [],
      });

      expect(result.text).toMatch(/^Pair this private chat with code [A-Z2-9]{6}$/);
      expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
      expect(adapter.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists a newly established codex thread id after the first message", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [{ telegramChatId: 84, telegramUserId: 84 }],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn().mockResolvedValue(undefined),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done", sessionId: "thread-123" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 84,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({ text: "done", sessionId: "thread-123" });
    expect(sessionManager.bindSession).toHaveBeenCalledWith(84, "thread-123");
  });

  it("rejects non-private chats with a product-facing message", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "group",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "This bot only accepts private chats." });
  });

  it("localizes private-chat-required and pairing replies when locale is zh", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({ code: "ABC123" }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "group",
        text: "hello",
        replyContext: undefined,
        files: [],
        locale: "zh",
      }),
    ).resolves.toEqual({ text: "此 bot 只接受私聊。" });

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
        locale: "zh",
      }),
    ).resolves.toEqual({ text: "使用配对码 ABC123 配对此私聊" });
  });

  it("includes quoted reply context in the prompt", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "answer this",
      replyContext: {
        messageId: 99,
        text: "quoted text",
      },
      files: [],
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", expect.objectContaining({
      text: "answer this\n\n[Quoted message #99]\nquoted text",
      files: [],
      instructions: expect.stringContaining("Telegram chat bridge"),
      requestOutputDir: undefined,
    }));
    expect((adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.instructions).toContain(
      "deliver it as a Telegram document attachment",
    );
  });

  it("does not append quoted archive-summary text when continue has no reply context", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "/continue --upload archive-1\n\n[Archive Analysis Context]\nContinue from extracted workspace.",
      replyContext: undefined,
      files: [],
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith(
      "telegram-84",
      expect.objectContaining({
        text: "/continue --upload archive-1\n\n[Archive Analysis Context]\nContinue from extracted workspace.",
      }),
    );
    expect(adapter.sendUserMessage).not.toHaveBeenCalledWith(
      "telegram-84",
      expect.objectContaining({
        text: expect.stringContaining("[Quoted message #"),
      }),
    );
  });

  it("passes codex telegram-out instructions separately from user text", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      bridgeInstructionMode: "telegram-out-only",
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "generate a file",
      replyContext: undefined,
      files: [],
      requestOutputDir: "C:\\tmp\\workspace\\.telegram-out\\req-123",
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith(
      "telegram-84",
      expect.objectContaining({
        text: "generate a file",
        requestOutputDir: "C:\\tmp\\workspace\\.telegram-out\\req-123",
        instructions: expect.stringContaining("[Codex Telegram-Out Contract]"),
      }),
    );
    const call = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call?.instructions).toContain("Files written there will be returned to the user after the task completes.");
    expect(call?.instructions).toContain("[send-file:");
  });

  it("injects bridge capabilities for codex adapters too", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      bridgeInstructionMode: "telegram-out-only",
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "文件在哪里",
      replyContext: undefined,
      files: [],
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith(
      "telegram-84",
      expect.objectContaining({
        text: "文件在哪里",
        instructions: expect.stringContaining("[send-file:"),
      }),
    );
  });

  it("uses only the codex telegram-out contract for codex file delivery", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      bridgeInstructionMode: "telegram-out-only",
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "生成一个文件并发给我",
      replyContext: undefined,
      files: [],
      requestOutputDir: "C:\\tmp\\workspace\\.telegram-out\\req-123",
    });

    const call = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call?.text).toBe("生成一个文件并发给我");
    expect(call?.instructions).toContain("[Codex Telegram-Out Contract]");
    expect(call?.instructions).toContain("[send-file:");
  });
});
