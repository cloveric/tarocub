import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { Domain } from "@larksuiteoapi/node-sdk";

import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { DEFAULT_INSTANCE_AGENT_INSTRUCTIONS } from "../src/commands/access.js";
import { createLarkServiceRuntime, resolveLarkServiceLockDir, runLarkService } from "../src/lark/service.js";
import { stableLarkNumericId } from "../src/lark/message-normalizer.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import { SERVICE_LIFECYCLE_LOG_FILE } from "../src/runtime/service-lifecycle-log.js";

describe("runLarkService", () => {
  it("removes generated Telegram transport instructions from Lark agent.md before starting", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-agent-cleanup-"));
    const abortController = new AbortController();
    const logger = silentLogger();
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

    try {
      await writeFile(path.join(stateDir, "agent.md"), DEFAULT_INSTANCE_AGENT_INSTRUCTIONS, "utf8");

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

      await expect(readFile(path.join(stateDir, "agent.md"), "utf8")).resolves.toBe("");
      expect(JSON.stringify(logger.log.mock.calls)).toContain("Removed generated Telegram Transport instructions");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

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
        source: "tarocub",
        policy: {
          dmMode: "open",
          requireMention: false,
          respondToMentionAll: false,
        },
        safety: {
          chatQueue: {
            enabled: false,
          },
        },
      }));
      expect(channel.on).toHaveBeenCalledWith("message", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("reject", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("cardAction", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("comment", expect.any(Function));
      expect(channel.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(channel.connect).toHaveBeenCalledTimes(1);
      expect(channel.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("routes private Lark messages to the sibling instance that owns the chat", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-owner-route-"));
    const currentStateDir = path.join(rootDir, "ccfcc1");
    const ownerStateDir = path.join(rootDir, "ccfgg2");
    const abortController = new AbortController();
    const handlers = new Map<string, (payload: any) => Promise<void> | void>();
    const ownerBridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "owner handled" })),
    };
    const currentBridge = {
      checkAccess: vi.fn(async () => ({
        kind: "reply" as const,
        text: "locked by current",
        reason: "single_chat_locked" as const,
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "current handled" })),
    };
    const channel = {
      on: vi.fn((name: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(name, handler);
        return () => undefined;
      }),
      connect: vi.fn(async () => {
        await handlers.get("message")?.({
          messageId: "om_owner_route",
          chatId: "oc_owner",
          chatType: "p2p",
          senderId: "ou_owner",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
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
      await mkdir(currentStateDir, { recursive: true, mode: 0o700 });
      await mkdir(ownerStateDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(currentStateDir, "lark.env"), [
        "LARK_APP_ID=cli_shared",
        "LARK_APP_SECRET=secret",
        `CCTB_LARK_STATE_DIR=${currentStateDir}`,
        "CCTB_LARK_INSTANCE=ccfcc1",
        "TAROCUB_INSTANCE=ccfcc1",
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(ownerStateDir, "lark.env"), [
        "LARK_APP_ID=cli_shared",
        "LARK_APP_SECRET=secret",
        `CCTB_LARK_STATE_DIR=${ownerStateDir}`,
        "CCTB_LARK_INSTANCE=ccfgg2",
        "TAROCUB_INSTANCE=ccfgg2",
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(ownerStateDir, "access.json"), JSON.stringify({
        schemaVersion: 1,
        multiChat: false,
        policy: "pairing",
        pairedUsers: [{
          telegramUserId: stableLarkNumericId("user:ou_owner"),
          telegramChatId: stableLarkNumericId("lark:oc_owner"),
          pairedAt: "2026-05-29T00:00:00.000Z",
        }],
        allowlist: [stableLarkNumericId("lark:oc_owner")],
        pendingPairs: [],
      }) + "\n", { encoding: "utf8", mode: 0o600 });

      await runLarkService({
        HOME: os.homedir(),
        LARK_APP_ID: "cli_shared",
        LARK_APP_SECRET: "secret",
        CCTB_LARK_STATE_DIR: currentStateDir,
        CCTB_LARK_INSTANCE: "ccfcc1",
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async (_env, config) => ({
          stateDir: config.stateDir,
          bridge: config.stateDir === ownerStateDir ? ownerBridge : currentBridge,
        }),
        signal: abortController.signal,
        logger: silentLogger(),
      });

      expect(currentBridge.checkAccess).not.toHaveBeenCalled();
      expect(currentBridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(ownerBridge.checkAccess).toHaveBeenCalledOnce();
      expect(ownerBridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_owner"),
        userId: stableLarkNumericId("user:ou_owner"),
        text: expect.stringContaining("hello"),
      }));
      expect(channel.send).toHaveBeenCalledWith("oc_owner", { markdown: "owner handled" }, { replyTo: "om_owner_route" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("records the abort reason when a Lark service is signaled to stop", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-abort-reason-"));
    const abortController = new AbortController();
    const channel = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(async () => {
        abortController.abort("SIGTERM");
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
        CCTB_LARK_INSTANCE: "ccfgg2",
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
        logger: silentLogger(),
      });

      const lifecycle = (await readFile(path.join(stateDir, SERVICE_LIFECYCLE_LOG_FILE), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lifecycle).toContainEqual(expect.objectContaining({
        type: "service.stopped",
        instanceName: "ccfgg2",
        metadata: expect.objectContaining({
          abortReason: "SIGTERM",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("marks previously accepted Lark messages without a terminal event as interrupted on startup", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-recover-"));
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

    try {
      await writeFile(path.join(stateDir, "timeline.log.jsonl"), `${JSON.stringify({
        timestamp: "2026-05-28T09:59:04.231Z",
        type: "input.received",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "accepted",
        metadata: {
          larkChatId: "oc_chat",
          larkMessageId: "om_command",
          bridgeChatType: "private",
          messageId: "om_command",
          attachments: 0,
        },
      })}\n${JSON.stringify({
        timestamp: "2026-05-28T09:59:13.920Z",
        type: "command.handled",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "success",
        metadata: {
          command: "resume",
        },
      })}\n${JSON.stringify({
        timestamp: "2026-05-28T10:23:27.282Z",
        type: "input.received",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "accepted",
        metadata: {
          larkChatId: "oc_chat",
          larkMessageId: "om_orphan",
          bridgeChatType: "private",
          attachments: 0,
        },
      })}\n`, "utf8");

      await runLarkService({
        HOME: os.homedir(),
        CCTB_LARK_INSTANCE: "ccfgg2",
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
        logger: silentLogger(),
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        outcome: "interrupted",
        detail: "service restarted before accepted Lark turn reached a terminal state",
        metadata: expect.objectContaining({
          larkMessageId: "om_orphan",
          phase: "startup-recovery",
          acceptedAt: "2026-05-28T10:23:27.282Z",
        }),
      }));
      expect(timeline).not.toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "interrupted",
        metadata: expect.objectContaining({
          larkMessageId: "om_command",
        }),
      }));

      const lifecycle = (await readFile(path.join(stateDir, SERVICE_LIFECYCLE_LOG_FILE), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lifecycle).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "service.startup_maintenance",
          instanceName: "ccfgg2",
          outcome: "success",
          metadata: expect.objectContaining({
            recoveredTurns: 1,
          }),
        }),
        expect.objectContaining({
          type: "service.started",
          instanceName: "ccfgg2",
          outcome: "success",
        }),
        expect.objectContaining({
          type: "service.stopped",
          instanceName: "ccfgg2",
          outcome: "success",
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the named Lark instance label for bridge runtime config", async () => {
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
        TAROCUB_INSTANCE: "lark-alpha",
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
        TAROCUB_INSTANCE: "lark-alpha",
        CODEX_TELEGRAM_INSTANCE: "lark-alpha",
      }), expect.any(Object));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores ambient Telegram instance labels when no Lark instance is set", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-ambient-instance-"));
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
        TAROCUB_INSTANCE: "lark",
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

  it("does not log raw Lark message metadata on the hot path unless debug logging is enabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-no-raw-log-"));
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
          messageId: "om_group_noise",
          chatId: "oc_group",
          chatType: "group",
          senderId: "ou_user",
          content: "ordinary group message",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        });
        await handlers.get("reject")?.({
          chatId: "oc_group",
          messageId: "om_rejected",
          reason: "not-mentioned",
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
            handleAuthorizedMessage: vi.fn(),
          },
        }),
        signal: abortController.signal,
        logger,
      });

      const logs = JSON.stringify(logger.log.mock.calls);
      expect(logs).not.toContain("Lark raw message event");
      expect(logs).not.toContain("Lark SDK rejected message");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("logs raw Lark message metadata when CCTB_LARK_DEBUG is enabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-runtime-debug-raw-log-"));
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
          messageId: "om_debug",
          chatId: "oc_group",
          chatType: "group",
          senderId: "ou_user",
          content: "debug me",
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
        CCTB_LARK_DEBUG: "1",
      }, {
        createChannel: vi.fn(() => channel),
        createBridge: async () => ({
          stateDir,
          bridge: {
            handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
          },
        }),
        signal: abortController.signal,
        logger,
      });

      const logs = JSON.stringify(logger.log.mock.calls);
      expect(logs).toContain("Lark raw message event");
      expect(logs).toContain("om_debug");
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
