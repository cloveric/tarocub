import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { AccessStore } from "../src/state/access-store.js";
import { FileTurnPool } from "../src/runtime/turn-pool.js";

function groupMode(allowedChatIds: number[]) {
  return {
    loadGroupMode: vi.fn().mockResolvedValue({
      enabled: true,
      allowedChatIds,
      listenAllChatIds: [],
    }),
  };
}

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
      locale: "zh",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(accessStore.load).toHaveBeenCalledTimes(1);
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", expect.objectContaining({
      text: "hello",
      files: [],
      locale: "zh",
      instructions: undefined,
      requestOutputDir: undefined,
    }));
    expect(result.text).toBe("done");
    expect(sessionManager.bindSession).not.toHaveBeenCalled();
  });

  it("serializes concurrent turns for the same engine session across bridge instances", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84, 85],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "shared-engine-session" }),
      bindSession: vi.fn(),
    };
    const startedTurns: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstCanFinish = new Promise<void>((finish) => {
      releaseFirstTurn = finish;
    });
    const adapterA: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async () => {
        startedTurns.push("first");
        await firstCanFinish;
        return { text: "first done" };
      }),
      createSession: vi.fn(),
    };
    const adapterB: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async () => {
        startedTurns.push("second");
        return { text: "second done" };
      }),
      createSession: vi.fn(),
    };
    const firstBridge = new Bridge(accessStore, sessionManager, adapterA);
    const secondBridge = new Bridge(accessStore, sessionManager, adapterB);

    const first = firstBridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "first",
      replyContext: undefined,
      files: [],
    });
    await vi.waitFor(() => {
      expect(startedTurns).toEqual(["first"]);
    });

    const second = secondBridge.handleAuthorizedMessage({
      chatId: 85,
      userId: 43,
      chatType: "private",
      text: "second",
      replyContext: undefined,
      files: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      expect(startedTurns).toEqual(["first"]);
    } finally {
      releaseFirstTurn();
      await Promise.allSettled([first, second]);
    }
    expect(startedTurns).toEqual(["first", "second"]);
  });

  it("keeps session resolution inside the logical conversation lock", async () => {
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
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: `logical-session-${Date.now()}` }),
      bindSession: vi.fn(),
    };
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const adapterA: CodexAdapter = {
      sendUserMessage: vi.fn(async () => {
        await firstCanFinish;
        return { text: "first" };
      }),
      createSession: vi.fn(),
    };
    const adapterB: CodexAdapter = {
      sendUserMessage: vi.fn(async () => ({ text: "second" })),
      createSession: vi.fn(),
    };
    const conversationKey = `lark:oc_cron_race_${Date.now()}`;
    const firstBridge = new Bridge(accessStore, sessionManager, adapterA);
    const secondBridge = new Bridge(accessStore, sessionManager, adapterB);
    const waitEvents: unknown[] = [];

    const first = firstBridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      conversationKey,
      text: "chat turn",
      files: [],
    });
    await vi.waitFor(() => expect(adapterA.sendUserMessage).toHaveBeenCalledTimes(1));
    const second = secondBridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      conversationKey,
      text: "cron turn",
      files: [],
      turnLockWaitNotifyAfterMs: 0,
      onTurnLockWait: async (event) => {
        waitEvents.push(event);
      },
    });

    await vi.waitFor(() => {
      expect(waitEvents).toContainEqual(expect.objectContaining({
        sessionId: `conversation-scope:${conversationKey}`,
      }));
    });
    try {
      // Before the fix, cron resolved the same conversation's session while the
      // first turn was still running, creating a stale-id TOCTOU window.
      expect(sessionManager.getOrCreateSession).toHaveBeenCalledTimes(1);
      expect(adapterB.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledTimes(2);
    expect(adapterB.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("notifies a waiting turn when another entry is using the same engine session", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84, 85],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: `shared-engine-session-${Date.now()}` }),
      bindSession: vi.fn(),
    };
    const startedTurns: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstCanFinish = new Promise<void>((finish) => {
      releaseFirstTurn = finish;
    });
    const adapterA: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async () => {
        startedTurns.push("first");
        await firstCanFinish;
        return { text: "first done" };
      }),
      createSession: vi.fn(),
    };
    const adapterB: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async () => {
        startedTurns.push("second");
        return { text: "second done" };
      }),
      createSession: vi.fn(),
    };
    const firstBridge = new Bridge(accessStore, sessionManager, adapterA);
    const secondBridge = new Bridge(accessStore, sessionManager, adapterB);
    const waitEvents: unknown[] = [];

    const first = firstBridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "first",
      replyContext: undefined,
      files: [],
    });
    await vi.waitFor(() => {
      expect(startedTurns).toEqual(["first"]);
    });

    const second = secondBridge.handleAuthorizedMessage({
      chatId: 85,
      userId: 43,
      chatType: "private",
      text: "second",
      replyContext: undefined,
      files: [],
      turnLockWaitNotifyAfterMs: 0,
      onTurnLockWait: async (event) => {
        waitEvents.push(event);
      },
    });
    await vi.waitFor(() => {
      expect(waitEvents).toContainEqual(expect.objectContaining({
        sessionId: expect.stringContaining("shared-engine-session-"),
        waitedMs: expect.any(Number),
      }));
    });

    releaseFirstTurn();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ text: "first done" }),
      expect.objectContaining({ text: "second done" }),
    ]);
  });

  it("limits concurrent turns across different engine sessions with a shared turn pool", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-"));
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84, 85],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockImplementation(async (scope: number) => ({ sessionId: `session-${scope}` })),
      bindSession: vi.fn(),
    };
    const startedTurns: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstCanFinish = new Promise<void>((finish) => {
      releaseFirstTurn = finish;
    });
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async (sessionId: string) => {
        startedTurns.push(sessionId);
        if (sessionId === "session-84") {
          await firstCanFinish;
          return { text: "first done" };
        }
        return { text: "second done" };
      }),
      createSession: vi.fn(),
    };
    const turnPool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(tempDir, "turn-pool.json"),
      pollIntervalMs: 5,
    });
    const bridge = new Bridge(accessStore, sessionManager, adapter, { turnPool });
    const waitEvents: unknown[] = [];

    try {
      const first = bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        chatType: "private",
        text: "first",
        replyContext: undefined,
        files: [],
      });
      await vi.waitFor(() => {
        expect(startedTurns).toEqual(["session-84"]);
      });

      const second = bridge.handleAuthorizedMessage({
        chatId: 85,
        userId: 43,
        chatType: "private",
        text: "second",
        replyContext: undefined,
        files: [],
        turnPoolWaitNotifyAfterMs: 0,
        onTurnPoolWait: async (event) => {
          waitEvents.push(event);
        },
      });

      await vi.waitFor(() => {
        expect(waitEvents).toContainEqual(expect.objectContaining({
          reason: "turn_pool",
          activeCount: 1,
          maxActive: 1,
          waitedMs: expect.any(Number),
        }));
      });
      expect(startedTurns).toEqual(["session-84"]);

      releaseFirstTurn();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ text: "first done" }),
        expect.objectContaining({ text: "second done" }),
      ]);
      expect(startedTurns).toEqual(["session-84", "session-85"]);
    } finally {
      releaseFirstTurn?.();
      await removeTempRoot(tempDir);
    }
  });

  it("records telemetry metrics and errors for authorized turns", async () => {
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
      sendUserMessage: vi.fn()
        .mockResolvedValueOnce({
          text: "done",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 2,
            costUsd: 0.03,
          },
        })
        .mockRejectedValueOnce(new Error("engine failed")),
      createSession: vi.fn(),
    };
    const telemetry = {
      recordMetric: vi.fn(async () => undefined),
      recordError: vi.fn(async () => undefined),
    };
    const bridge = new Bridge(accessStore, sessionManager, adapter, {
      telemetry,
      telemetryTags: {
        channel: "telegram",
        instanceName: "alpha",
      },
    });

    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(telemetry.recordMetric).toHaveBeenCalledWith("run_e2e_ms", expect.any(Number), expect.objectContaining({
      channel: "telegram",
      instanceName: "alpha",
      outcome: "success",
    }));
    expect(telemetry.recordMetric).toHaveBeenCalledWith("tokens_in", 10, expect.any(Object));
    expect(telemetry.recordMetric).toHaveBeenCalledWith("tokens_out", 5, expect.any(Object));
    expect(telemetry.recordMetric).toHaveBeenCalledWith("tokens_cached", 2, expect.any(Object));
    expect(telemetry.recordMetric).toHaveBeenCalledWith("cost_usd", 0.03, expect.any(Object));

    await expect(bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "fail",
      replyContext: undefined,
      files: [],
    })).rejects.toThrow("engine failed");
    expect(telemetry.recordError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      channel: "telegram",
      instanceName: "alpha",
      phase: "turn",
    }));
  });

  it("binds engine session events without starting an extra turn", async () => {
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
      bindSession: vi.fn().mockResolvedValue(undefined),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async (_sessionId, input) => {
        await input.onEngineEvent?.({
          type: "session",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        });
        return {
          text: "done",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        };
      }),
      createSession: vi.fn(),
    };
    const onEngineEvent = vi.fn();

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
      onEngineEvent,
    });

    expect(result).toEqual({
      text: "done",
      sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
    });
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sessionManager.bindSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.bindSession).toHaveBeenCalledWith(84, "fdfc8ab1-7936-4599-98b0-d8ba2593c250");
    expect(onEngineEvent).toHaveBeenCalledWith({
      type: "session",
      sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
    });
  });

  it("deduplicates concurrent engine session binding events", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const bindResolvers: Array<() => void> = [];
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
        bindResolvers.push(resolve);
      })),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async (_sessionId, input) => {
        const first = input.onEngineEvent?.({
          type: "session",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        });
        const second = input.onEngineEvent?.({
          type: "session",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        });
        await vi.waitFor(() => {
          expect(bindResolvers).toHaveLength(1);
        });
        bindResolvers[0]!();
        await Promise.all([first, second]);
        return {
          text: "done",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        };
      }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(sessionManager.bindSession).toHaveBeenCalledTimes(1);
  });

  it("retries final response binding when an engine session event bind fails", async () => {
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
      bindSession: vi.fn()
        .mockRejectedValueOnce(new Error("store unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockImplementation(async (_sessionId, input) => {
        await input.onEngineEvent?.({
          type: "session",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        }).catch(() => undefined);
        return {
          text: "done",
          sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        };
      }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(sessionManager.bindSession).toHaveBeenCalledTimes(2);
    expect(sessionManager.bindSession).toHaveBeenNthCalledWith(2, 84, "fdfc8ab1-7936-4599-98b0-d8ba2593c250");
  });

  it("uses the Telegram topic conversation key when present", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        multiChat: false,
        policy: "pairing",
        pairedUsers: [{ telegramUserId: 42, telegramChatId: 84, pairedAt: "2026-05-04T00:00:00.000Z" }],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "topic-session" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done", sessionId: "topic-session-2" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter, groupMode([-100123]));
    await bridge.handleAuthorizedMessage({
      chatId: -100123,
      userId: 42,
      chatType: "supergroup",
      messageThreadId: 7,
      conversationKey: "chat:-100123:topic:7",
      text: "hello topic",
      replyContext: undefined,
      files: [],
    });

    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith({
      chatId: -100123,
      messageThreadId: 7,
      conversationKey: "chat:-100123:topic:7",
    });
    expect(sessionManager.bindSession).toHaveBeenCalledWith({
      chatId: -100123,
      messageThreadId: 7,
      conversationKey: "chat:-100123:topic:7",
    }, "topic-session-2");
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

  it("disables the runtime timeout when the input flag is set (the /timeout off config toggle), no keyword needed", async () => {
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
      text: "把整套测试跑完",        // no "不设超时" keyword — the flag carries it
      replyContext: undefined,
      files: [],
      disableRuntimeTimeout: true,
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

  it("does not inject file delivery instructions when instance agent.md owns transport rules", async () => {
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
      text: "generate images",
      replyContext: undefined,
      files: [],
    });

    const instructions = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.instructions;
    expect(instructions).toBeUndefined();
  });

  it("passes the active side-channel env without repeating file delivery instructions", async () => {
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
      text: "generate a PNG",
      replyContext: undefined,
      files: [],
      sideChannelCommand: "/tmp/workspace/.cctb-send/helper",
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
        CCTB_SEND_TOKEN: "token",
        CCTB_SEND_COMMAND: "/tmp/workspace/.cctb-send/helper",
      },
    });

    const payload = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(payload.instructions).toBeUndefined();
    expect(payload.extraEnv).toEqual({
      CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
      CCTB_SEND_TOKEN: "token",
      CCTB_SEND_COMMAND: "/tmp/workspace/.cctb-send/helper",
    });
  });

  it("does not advertise side-channel helper paths for adapters without turn-scoped env support", async () => {
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
      supportsTurnScopedEnv: false,
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "generate a PNG",
      replyContext: undefined,
      files: [],
      sideChannelCommand: "/tmp/workspace/.cctb-send/helper",
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
        CCTB_SEND_TOKEN: "token",
        CCTB_SEND_COMMAND: "/tmp/workspace/.cctb-send/helper",
      },
    });

    const payload = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(payload.instructions).toBeUndefined();
    expect(payload.extraEnv).toBeUndefined();
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
    ).resolves.toEqual({ text: "此聊天未被授权使用该实例。" });

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

  it("marks single-chat lock access decisions with an explicit reason", async () => {
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
    await expect(bridge.checkAccess({
      chatId: 99,
      userId: 99,
      chatType: "private",
    })).resolves.toMatchObject({
      kind: "reply",
      reason: "single_chat_locked",
    });
  });

  it("allows the same paired user from another private Lark conversation without multi-chat", async () => {
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
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "lark-p2p-alt" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 99,
        userId: 42,
        chatType: "private",
        text: "hello from another p2p surface",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "done" });

    expect(accessStore.issuePairingCode).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(99);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("lark-p2p-alt", expect.objectContaining({
      text: "hello from another p2p surface",
    }));
  });

  it("does not let an unredeemed pairing code lock out a different private chat", async () => {
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
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
        ],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({ code: "XYZ789" }),
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
      text: "Pair this private chat with code XYZ789",
    });

    expect(accessStore.issuePairingCode).toHaveBeenCalledWith({
      telegramUserId: 99,
      telegramChatId: 99,
      now: expect.any(Date),
    });
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

      expect(result.text).toMatch(/^Pair this private chat with code [A-Z2-9]{8}$/);
      expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
      expect(adapter.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(dir);
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

  it("rejects unauthorized non-private chats with a product-facing message", async () => {
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
        chatId: -10084,
        userId: 999,
        chatType: "group",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "This chat is not authorized for this instance." });
  });

  it("requires both an allowed group chat and an authorized user for group messages", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [42],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "topic-session" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter, groupMode([-10084]));
    await expect(bridge.handleAuthorizedMessage({
      chatId: -10084,
      userId: 42,
      chatType: "supergroup",
      text: "hello",
      replyContext: undefined,
      files: [],
    })).resolves.toEqual({ text: "done" });

    await expect(bridge.handleAuthorizedMessage({
      chatId: -10084,
      userId: 999,
      chatType: "supergroup",
      text: "hello",
      replyContext: undefined,
      files: [],
    })).resolves.toEqual({ text: "This chat is not authorized for this instance." });

    await expect(bridge.handleAuthorizedMessage({
      chatId: -10099,
      userId: 42,
      chatType: "supergroup",
      text: "hello",
      replyContext: undefined,
      files: [],
    })).resolves.toEqual({ text: "This chat is not authorized for this instance." });
  });

  it("accepts legacy conversation-scoped group allow ids for the matching conversation", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [42],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "topic-session" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter, groupMode([777]));

    await expect(bridge.checkAccess({
      chatId: 84,
      conversationChatId: 777,
      userId: 42,
      chatType: "group",
      conversationKey: "lark:oc_group:omt_topic",
    })).resolves.toEqual({ kind: "allow" });

    await expect(bridge.checkAccess({
      chatId: 84,
      conversationChatId: 778,
      userId: 42,
      chatType: "group",
      conversationKey: "lark:oc_group:omt_other",
    })).resolves.toEqual({
      kind: "reply",
      text: "This chat is not authorized for this instance.",
    });
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
    ).resolves.toEqual({ text: "此聊天未被授权使用该实例。" });

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
      instructions: undefined,
      requestOutputDir: undefined,
    }));
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

  it("passes codex telegram-out metadata without adding per-turn instructions", async () => {
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
        instructions: undefined,
      }),
    );
    const call = (adapter.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(call?.instructions).toBeUndefined();
  });

  it("does not inject bridge capabilities for codex adapters", async () => {
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
        instructions: undefined,
      }),
    );
  });

  it("uses codex telegram-out metadata without an extra prompt contract", async () => {
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
    expect(call?.requestOutputDir).toBe("C:\\tmp\\workspace\\.telegram-out\\req-123");
    expect(call?.instructions).toBeUndefined();
  });
});
