import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Domain } from "@larksuiteoapi/node-sdk";

import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { createLarkServiceRuntime, resolveLarkServiceLockDir, runLarkService } from "../src/lark/service.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("runLarkService", () => {
  it("starts a Lark channel without requiring Telegram credentials", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const createChannel = vi.fn(() => channel);

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_a",
        appSecret: "secret",
        transport: "websocket",
        source: "cc-telegram-bridge",
        safety: {
          chatQueue: {
            enabled: false,
          },
        },
      }));
      expect(channel.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("cardAction", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("comment", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(channel.connect).toHaveBeenCalledTimes(1);
      expect(channel.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the Lark instance label even when launched from a Telegram bot environment", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-instance-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const createBridge = vi.fn(async () => ({
      stateDir,
      bridge: {
        handleAuthorizedMessage: vi.fn(),
      },
    }));

    try {
      await runLarkService({
        HOME: os.homedir(),
        CODEX_TELEGRAM_INSTANCE: "bot6",
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge,
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(createBridge).toHaveBeenCalledWith(expect.objectContaining({
        CODEX_TELEGRAM_STATE_DIR: stateDir,
        CODEX_TELEGRAM_INSTANCE: "lark",
      }), expect.any(Object));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("maps short Lark domain names to SDK domain constants", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-domain-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const createChannel = vi.fn(() => channel);

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        LARK_DOMAIN: "feishu",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({
        domain: Domain.Feishu,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate Lark service processes for the same state dir", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-lock-"));
    const lock = await acquireInstanceLock(resolveLarkServiceLockDir(stateDir));
    const createChannel = vi.fn();

    try {
      await expect(runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel,
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        logger: silentLogger(),
      })).rejects.toThrow("Lark service lock already held by pid");

      expect(createChannel).not.toHaveBeenCalled();
    } finally {
      await lock.release();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("releases the Lark service lock when channel startup fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-connect-fail-"));
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        throw new Error("websocket failed");
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await expect(runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        logger: silentLogger(),
      })).rejects.toThrow("websocket failed");

      await expect(readFile(path.join(resolveLarkServiceLockDir(stateDir), "instance.lock.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(channel.disconnect).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps service-level message errors inside the originating Lark thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-thread-error-"));
    const abortController = new AbortController();
    const handlers = new Map<string, (payload: any) => Promise<void> | void>();
    const logger = silentLogger();
    const channel = {
      on: vi.fn((name: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
      connect: vi.fn(async () => {
        await handlers.get("message")?.({
          messageId: "om_thread_error",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: true,
          createTime: Date.now(),
        });
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            checkAccess: vi.fn(async () => {
              throw new Error("boom");
            }),
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { text: expect.stringContaining("错误：") },
        { replyTo: "om_thread_error", replyInThread: true },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_group:omt_topic",
        outcome: "error",
        metadata: expect.objectContaining({
          phase: "service-message",
          larkMessageId: "om_thread_error",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports service-level card action errors inside the originating Lark thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-card-error-"));
    const abortController = new AbortController();
    const handlers = new Map<string, (payload: any) => Promise<void> | void>();
    const channel = {
      on: vi.fn((name: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
      connect: vi.fn(async () => {
        await handlers.get("cardAction")?.({
          messageId: "om_card_error",
          chatId: "oc_group",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_group:omt_topic",
              bridgeChatType: "group",
              replyInThread: true,
            },
          },
        });
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            checkAccess: vi.fn(async () => {
              throw new Error("boom");
            }),
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { text: expect.stringContaining("错误：") },
        { replyTo: "om_card_error", replyInThread: true },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_group:omt_topic",
        outcome: "error",
        metadata: expect.objectContaining({
          phase: "service-card-action",
          larkMessageId: "om_card_error",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records service-level comment errors in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-comment-error-"));
    const abortController = new AbortController();
    const handlers = new Map<string, (payload: any) => Promise<void> | void>();
    const commentClient = {
      createReply: vi.fn(async () => undefined),
      getCommentContext: vi.fn(async () => ({
        quote: "",
        replies: [],
      })),
    };
    const channel = {
      on: vi.fn((name: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
      connect: vi.fn(async () => {
        await handlers.get("comment")?.({
          fileToken: "doc_token",
          fileType: "docx",
          commentId: "comment_error",
          operator: { openId: "ou_user" },
          mentionedBot: true,
          timestamp: Date.now(),
        });
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            checkUserAuthorization: vi.fn(async () => {
              throw new Error("boom");
            }),
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        runtime: createLarkServiceRuntime({ commentClient }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_error",
        text: expect.stringContaining("错误："),
      });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark-comment:doc_token",
        outcome: "error",
        metadata: expect.objectContaining({
          phase: "service-comment",
          larkSurface: "comment",
          fileToken: "doc_token",
          commentId: "comment_error",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark channel errors in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-channel-error-"));
    const abortController = new AbortController();
    const handlers = new Map<string, (payload: any) => Promise<void> | void>();
    const logger = silentLogger();
    const channel = {
      on: vi.fn((name: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
      connect: vi.fn(async () => {
        await handlers.get("error")?.(new Error("websocket dropped with Authorization: Bearer leaked-token and app_secret=secret-personal"));
        abortController.abort();
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_a",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: stateDir,
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger,
      });

      const serializedLogs = JSON.stringify(logger.error.mock.calls.map((call) => call.map(String)));
      expect(serializedLogs).not.toContain("leaked-token");
      expect(serializedLogs).not.toContain("secret-personal");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      const serializedTimeline = JSON.stringify(timeline);
      expect(serializedTimeline).not.toContain("leaked-token");
      expect(serializedTimeline).not.toContain("secret-personal");
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.error",
        channel: "lark",
        conversationKey: "lark:service",
        outcome: "error",
        detail: "websocket dropped with Authorization: Bearer [redacted] and app_secret=[redacted]",
        metadata: expect.objectContaining({
          phase: "channel",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function silentLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}
