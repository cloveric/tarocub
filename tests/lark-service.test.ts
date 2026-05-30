import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  buildLarkCronExecutor,
  createLarkChatWithCli,
  createLarkDocumentWithCli,
  createLarkServiceRuntime,
  handleLarkCardAction,
  handleLarkComment,
  handleLarkMessage,
  sendLarkCronFailureNotification,
  type LarkBridgeLike,
  type LarkStreamControllerLike,
  requestLarkApproval,
} from "../src/lark/service.js";
import { deliverLarkResponse } from "../src/lark/delivery.js";
import { LarkGroupModeStore } from "../src/lark/group-mode-store.js";
import { stableLarkNumericId } from "../src/lark/message-normalizer.js";
import { CronStore } from "../src/state/cron-store.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { SessionStore } from "../src/state/session-store.js";
import { AccessStore } from "../src/state/access-store.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import { UsageStore } from "../src/state/usage-store.js";
import { loadInstanceConfig } from "../src/telegram/instance-config.js";

function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf8"));
  }
  return zip.toBuffer();
}

describe("lark service", () => {
  it("does not add reactions to ignored Lark group messages", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reaction-ignored-"));
    const channel = fakeChannel({
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
      getChatMode: vi.fn(async () => "group"),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        reactionSettings: {
          processingEmoji: "OnIt",
          doneEmoji: "DONE",
          failureEmoji: "Warning",
        },
        message: {
          messageId: "om_ignored",
          chatId: "oc_group",
          chatType: "group",
          senderId: "ou_user",
          content: "ordinary group chatter",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(handled).toBe(false);
      expect(channel.getChatMode).not.toHaveBeenCalled();
      expect(channel.addReaction).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not run the engine for an unpaired Lark private chat", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-access-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码 ABC123 配对此私聊" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: expect.stringContaining("node dist/src/index.js lark access pair ABC123") },
        { replyTo: "om_1", replyInThread: false },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replies with single-chat lock messages for Lark private chats", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-single-chat-sibling-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({
        kind: "reply" as const,
        text: "此实例已锁定到另一个聊天。",
        reason: "single_chat_locked" as const,
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_sibling_lock",
          chatType: "p2p",
          content: "hello from the target bot chat",
        }),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "此实例已锁定到另一个聊天。" },
        { replyTo: "om_sibling_lock", replyInThread: false },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates a topic reply in a topic-form group into its own thread session", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-thread-session-"));
    const channel = fakeChannel({
      getChatTopicForm: vi.fn(async () => true), // topic message form (thread / topic group)
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_group_thread",
          chatType: "group",
          threadId: "omt_group_reply",
          mentionedBot: true,
          content: "继续",
        }),
      });

      expect(channel.getChatTopicForm).toHaveBeenCalledWith("oc_chat");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "group",
        conversationKey: "lark:oc_chat:omt_group_reply",
      }));
      const known = JSON.parse(await readFile(path.join(stateDir, "known-chats.json"), "utf8")) as {
        chats: Array<{ conversationKey: string; label: string; threadId?: string }>;
      };
      expect(known.chats).toContainEqual(expect.objectContaining({
        conversationKey: "lark:oc_chat:omt_group_reply",
        threadId: "omt_group_reply",
      }));
      expectLarkFinalAnswer(channel, "done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a conversation-form group's topic reply in the shared group session", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-convo-thread-session-"));
    const channel = fakeChannel({
      getChatTopicForm: vi.fn(async () => false), // conversation message form (group_message_type=chat)
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_convo_thread",
          chatType: "group",
          threadId: "omt_convo_reply",
          mentionedBot: true,
          content: "继续",
        }),
      });

      expect(channel.getChatTopicForm).toHaveBeenCalledWith("oc_chat");
      // Conversation form: the topic reply shares the one group session.
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "group",
        conversationKey: "lark:oc_chat",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes an existing thread session in a topic-form group", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-existing-thread-session-"));
    const threadConversationKey = "lark:oc_chat:omt_existing_thread";
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: stableLarkNumericId(threadConversationKey),
      conversationKey: threadConversationKey,
      codexSessionId: "claude-existing-thread",
      status: "idle",
      updatedAt: new Date("2026-05-29T06:20:00.000Z").toISOString(),
    });
    const channel = fakeChannel({
      getChatTopicForm: vi.fn(async () => true),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_existing_thread",
          chatType: "group",
          threadId: "omt_existing_thread",
          mentionedBot: true,
          content: "继续",
        }),
      });

      // The topic is isolated by thread key, so its existing session is resumed.
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "group",
        conversationKey: threadConversationKey,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("re-resolves a group's form after the cache TTL so toggling 群消息形式 applies without restart", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-form-ttl-"));
    const runtime = createLarkServiceRuntime();
    let topicForm = false; // starts as conversation form (shares)
    const channel = fakeChannel({ getChatTopicForm: vi.fn(async () => topicForm) });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const send = (messageId: string) => handleLarkMessage({
      channel, bridge, runtime, stateDir,
      message: fakeLarkMessage({ messageId, chatType: "group", threadId: "omt_x", mentionedBot: true, content: "x" }),
    });

    try {
      await send("om_1"); // conversation form → shares the group session
      expect(bridge.handleAuthorizedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationKey: "lark:oc_chat" }),
      );

      // Toggle to topic form, but still within the TTL → cached form is reused.
      topicForm = true;
      nowSpy.mockReturnValue(1_000_000 + 10_000);
      await send("om_2");
      expect(bridge.handleAuthorizedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationKey: "lark:oc_chat" }),
      );

      // Past the TTL → re-resolves the form → now isolates the topic.
      nowSpy.mockReturnValue(1_000_000 + 31_000);
      await send("om_3");
      expect(bridge.handleAuthorizedMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationKey: "lark:oc_chat:omt_x" }),
      );
      expect(channel.getChatTopicForm).toHaveBeenCalledTimes(2); // fetched at t0 and after TTL, not the cached middle call
    } finally {
      nowSpy.mockRestore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("guides unauthorized Lark groups to invite or allow the group without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-denied-help-"));
    const channel = fakeChannel({
      getChatMode: vi.fn(async () => "group"),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_group_denied_help",
          chatType: "group",
          mentionedBot: true,
          content: "帮我看一下",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        {
          text: expect.stringContaining("/invite group"),
        },
        { replyTo: "om_group_denied_help", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("/group allow");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces shared turn pool waits in Lark timeline and chat", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-turn-pool-wait-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: Parameters<LarkBridgeLike["handleAuthorizedMessage"]>[0]) => {
        await input.onTurnPoolWait?.({
          waitedMs: 12_000,
          activeCount: 2,
          maxActive: 2,
          reason: "turn_pool",
        });
        return { text: "done" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_pool_wait",
          content: "do work",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        expect.objectContaining({
          markdown: expect.stringContaining("AI worker"),
        }),
        { replyTo: "om_pool_wait" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.lock.waiting",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        detail: "waiting for shared AI worker capacity",
        metadata: expect.objectContaining({
          waitedMs: 12_000,
          activeCount: 2,
          maxActive: 2,
          reason: "turn_pool",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the resumed workspace to ordinary Lark messages", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-workspace-"));
    const workspacePath = path.join(stateDir, "external-workspace");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
    };

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
        resume: {
          sessionId: "claude-session-1",
          dirName: "-Users-cloveric-projects-cc-telegram-bridge",
          workspacePath,
        },
      }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_resume",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "continue",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        workspaceOverride: workspacePath,
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not add reactions before Lark access allows a message", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reaction-denied-"));
    const channel = fakeChannel({
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码 ABC123 配对此私聊" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        reactionSettings: {
          processingEmoji: "OnIt",
          doneEmoji: "DONE",
          failureEmoji: "Warning",
        },
        message: {
          messageId: "om_denied_reaction",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.addReaction).not.toHaveBeenCalled();
      expect(channel.removeReaction).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("routes Lark messages through the bridge and sends the final result directly", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-service-"));
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => Buffer.from("hello file")),
    });
    let bridgeReadAttachment = false;
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        chatType: string;
        conversationKey?: string;
        files: string[];
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        bridgeReadAttachment = (await readFile(input.files[0]!, "utf8")) === "hello file";
        await input.onEngineEvent?.({ type: "assistant_text", text: "Done from bridge" });
        await input.onEngineEvent?.({ type: "result", text: "Done from bridge" });
        return {
          text: "Done from bridge",
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            cachedTokens: 3,
            costUsd: 0.0012,
          },
        };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("hello"),
      }));
      const bridgeInput = bridge.handleAuthorizedMessage.mock.calls[0]![0];
      expect(bridgeInput.files).toHaveLength(1);
      expect(bridgeReadAttachment).toBe(true);
      expectLarkFinalAnswer(channel, "Done from bridge");
      await expect(new UsageStore(stateDir).load()).resolves.toMatchObject({
        requestCount: 1,
        totalInputTokens: 11,
        totalOutputTokens: 7,
        totalCachedTokens: 3,
        totalCostUsd: 0.0012,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("notifies Lark users and records a timeline event when a turn waits on the shared engine lock", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-lock-wait-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onTurnLockWait?: (event: {
          sessionId: string;
          waitedMs: number;
          reason: "in_process_queue" | "file_lock";
          lockPath: string;
        }) => void | Promise<void>;
      }) => {
        await input.onTurnLockWait?.({
          sessionId: "codex-thread-1",
          waitedMs: 10_250,
          reason: "file_lock",
          lockPath: "/tmp/tarocub-turn-locks/test.lock",
        });
        return { text: "Done from bridge" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("排队") },
        { replyTo: "om_1" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.lock.waiting",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        metadata: expect.objectContaining({
          sessionId: "codex-thread-1",
          waitedMs: 10_250,
          reason: "file_lock",
          larkChatId: "oc_chat",
          larkMessageId: "om_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("expands merged forwarded Lark messages before running the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-merge-forward-"));
    const channel = fakeChannel({
      fetchMessage: vi.fn(async () => ({
        messageId: "om_forward",
        messageType: "merge_forward",
        content: "Merged and Forwarded Message",
        children: [
          {
            messageId: "om_child_1",
            messageType: "text",
            senderName: "Leader",
            content: JSON.stringify({ text: "请今天处理这个需求" }),
          },
          {
            messageId: "om_child_2",
            messageType: "post",
            senderName: "PM",
            content: JSON.stringify({
              title: "补充背景",
              content: [[{ tag: "text", text: "优先看飞书合并转发" }]],
            }),
          },
        ],
      })),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "merged handled" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_forward",
          content: "Merged and Forwarded Message",
          rawContentType: "merge_forward",
        }),
      });

      expect(channel.fetchMessage).toHaveBeenCalledWith("om_forward");
      const bridgeText = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(bridgeText).toContain("<forwarded_lark_messages>");
      expect(bridgeText).toContain("Leader");
      expect(bridgeText).toContain("请今天处理这个需求");
      expect(bridgeText).toContain("PM");
      expect(bridgeText).toContain("补充背景");
      expect(bridgeText).not.toMatch(/<forwarded_lark_messages>\s*Merged and Forwarded Message\s*<\/forwarded_lark_messages>/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("expands merged forwarded Lark messages from the raw Lark message API response", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-merge-forward-api-"));
    const getMessage = vi.fn(async () => ({
      data: {
        items: [
          {
            message_id: "om_forward",
            msg_type: "merge_forward",
            body: { content: "Merged and Forwarded Message" },
          },
          {
            message_id: "om_child_1",
            upper_message_id: "om_forward",
            msg_type: "text",
            sender: { id: "ou_leader" },
            body: { content: JSON.stringify({ text: "实际转发内容" }) },
          },
        ],
      },
    }));
    const channel = fakeChannel({
      rawClient: {
        im: {
          v1: {
            message: {
              get: getMessage,
            },
          },
        },
      },
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (_input: { text: string }) => ({ text: "merged handled" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_forward",
          content: "Merged and Forwarded Message",
          rawContentType: "merge_forward",
        }),
      });

      expect(getMessage).toHaveBeenCalledWith({
        params: { user_id_type: "open_id" },
        path: { message_id: "om_forward" },
      });
      const bridgeText = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(bridgeText).toContain("ou_leader");
      expect(bridgeText).toContain("实际转发内容");
      expect(bridgeText).not.toMatch(/<forwarded_lark_messages>\s*Merged and Forwarded Message\s*<\/forwarded_lark_messages>/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into ordinary engine turns and access checks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-turn-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "Done from bridge" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_locale_turn", content: "hello" }),
      });

      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        text: expect.stringContaining("hello"),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders default Lark chat access denials in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-access-denial-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_access_denial_en", content: "hello" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Current chat is not authorized." },
        { replyTo: "om_access_denial_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark background task notifications from engine stream events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-task-notification-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "后台命令已经完成。",
        });
        return { text: "任务已启动。" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_task", content: "跑一个后台任务" }),
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "后台任务完成\n后台命令已经完成。" },
        { replyTo: "om_task" },
      );
      expectLarkFinalAnswer(channel, "任务已启动。");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        detail: "task_notification",
        metadata: expect.objectContaining({
          textChars: "后台命令已经完成。".length,
          larkChatId: "oc_chat",
          larkMessageId: "om_task",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark background task notifications in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-task-notification-en-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "Background command finished.",
        });
        return { text: "Task started." };
      }),
    };

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_task_en", content: "run a background task" }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("后台任务完成");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Background task completed\nBackground command finished." },
        { replyTo: "om_task_en" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("splits long Lark final replies before sending them to Feishu", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-long-reply-"));
    const channel = fakeChannel();
    const longReply = [
      "第一段：" + "甲".repeat(2500),
      "第二段：" + "乙".repeat(2500),
      "第三段：" + "丙".repeat(2500),
    ].join("\n\n");
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: longReply })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_long", content: "写一份长报告" }),
      });

      // The run card is the canonical reply: a long answer is rendered into the
      // card's text block (one element, well under Feishu's per-element limit)
      // rather than chunked across multiple markdown messages. The card must
      // carry every segment of the long reply.
      const cardJson = JSON.stringify([
        ...(channel.send.mock.calls as unknown[][]),
        ...((channel.updateCard?.mock?.calls as unknown[][] | undefined) ?? []),
      ]);
      expect(cardJson).toContain("甲".repeat(2500));
      expect(cardJson).toContain("乙".repeat(2500));
      expect(cardJson).toContain("丙".repeat(2500));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fetches replied Lark message text and passes it as bridge reply context", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reply-context-"));
    const channel = fakeChannel({
      fetchMessage: vi.fn(async () => ({
        messageId: "om_parent",
        messageType: "text",
        content: JSON.stringify({ text: "上一条结论：采用方案 B" }),
      })),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_reply",
          content: "就按这个继续",
          replyToMessageId: "om_parent",
        }),
      });

      expect(channel.fetchMessage).toHaveBeenCalledWith("om_parent");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        replyContext: {
          messageId: "om_parent",
          text: "上一条结论：采用方案 B",
        },
      }));
      expectLarkFinalAnswer(channel, "done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues Lark turns when replied message lookup fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reply-context-fallback-"));
    const channel = fakeChannel({
      fetchMessage: vi.fn(async () => {
        throw new Error("message get failed");
      }),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_reply",
          content: "继续",
          replyToMessageId: "om_parent",
        }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.not.objectContaining({
        replyContext: expect.anything(),
      }));
      expectLarkFinalAnswer(channel, "done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("transcribes Lark audio and video inputs before running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-asr-"));
    const transcribeMedia = vi.fn(async (filePath: string) => `transcript:${path.basename(filePath)}`);
    const channel = fakeChannel({
      downloadResource: vi.fn(async (key: string) => Buffer.from(`media:${key}`)),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; files: string[] }) => ({ text: "done" })),
    };
    const runtime = createLarkServiceRuntime({ transcribeMedia });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_media",
          content: "整理这两段素材",
          resources: [
            { type: "audio", fileKey: "audio_key", fileName: "voice.m4a" },
            { type: "video", fileKey: "video_key", fileName: "clip.mp4" },
          ],
        }),
      });

      expect(transcribeMedia).toHaveBeenCalledTimes(2);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        files: [],
        text: expect.stringContaining("整理这两段素材"),
      }));
      const bridgeInput = bridge.handleAuthorizedMessage.mock.calls[0]![0];
      expect(bridgeInput.text).toContain("transcript:voice.m4a");
      expect(bridgeInput.text).toContain("transcript:clip.mp4");
      expectLarkFinalAnswer(channel, "done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("downloads user-sent Lark audio as a file resource before transcription", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audio-resource-"));
    const messageResourceGet = vi.fn(async () => ({
      getReadableStream: () => Readable.from([Buffer.from("voice body")]),
    }));
    const transcribeMedia = vi.fn(async (filePath: string) => `transcript:${path.basename(filePath)}`);
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => {
        throw new Error("wrong Lark resource download API");
      }),
      rawClient: {
        im: {
          v1: {
            messageResource: {
              get: messageResourceGet,
            },
          },
        },
      },
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };
    const runtime = createLarkServiceRuntime({ transcribeMedia });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_voice",
          content: "",
          resources: [
            { type: "audio", fileKey: "file_v3_voice" },
          ],
        }),
      });

      expect(messageResourceGet).toHaveBeenCalledWith({
        path: {
          message_id: "om_voice",
          file_key: "file_v3_voice",
        },
        params: {
          type: "file",
        },
      });
      expect(transcribeMedia).toHaveBeenCalledWith(expect.stringMatching(/audio-1\.ogg$/));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        files: [],
        text: expect.stringContaining("transcript:audio-1.ogg"),
      }));
      expect(channel.downloadResource).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark media transcription failures in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-asr-en-fail-"));
    const transcribeMedia = vi.fn(async () => {
      throw new Error("asr down");
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async (key: string) => Buffer.from(`media:${key}`)),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const runtime = createLarkServiceRuntime({ transcribeMedia });

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_media_fail_en",
          content: "summarize this",
          resources: [
            { type: "audio", fileKey: "audio_key", fileName: "voice.m4a" },
          ],
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Audio/video transcription failed. Please send text or a shorter audio/video file." },
        { replyTo: "om_media_fail_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("summarizes Lark zip archives and waits for continue instead of running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-summary-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Archive summary: repo.zip") },
        { replyTo: "om_zip", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("README.md") },
        { replyTo: "om_zip", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("continue_archive");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Continue Analysis");

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ kind: string; status: string; chatId: number; summary: string }>;
      };
      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]).toMatchObject({
        kind: "archive",
        status: "awaiting_continue",
        chatId: stableLarkNumericId("lark:oc_chat"),
      });
      expect(workflowState.records[0]?.summary).toContain("src/");
      expect(workflowState.records[0]?.summary).toContain("index.ts");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark archive continuation cards in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-summary-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip_en",
          content: "Analyze this archive",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      const calls = JSON.stringify(channel.send.mock.calls);
      expect(calls).toContain("Archive summary generated");
      expect(calls).toContain("Continue Analysis");
      expect(calls).not.toContain("压缩包摘要已生成");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues Lark zip archive analysis from the summary card button", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-card-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; files: string[]; locale?: string }) => ({ text: "analysis from card done" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });
      bridge.handleAuthorizedMessage.mockClear();

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string }>;
      };
      const uploadId = workflowState.records[0]!.uploadId;
      await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          messageId: "om_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "continue_archive",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              uploadId,
            },
          },
        },
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const bridgeInput = bridge.handleAuthorizedMessage.mock.calls[0]![0];
      expect(bridgeInput.locale).toBe("en");
      expect(bridgeInput.text).toContain("[Archive Analysis Context]");
      expect(bridgeInput.text).toContain("Extracted files live under:");
      expectLarkFinalAnswer(channel, "analysis from card done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders missing Lark archive continuation replies in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-missing-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkCardAction({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        event: {
          messageId: "om_card_missing",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "continue_archive",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              uploadId: "missing-upload",
            },
          },
        },
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "That archive is no longer waiting for continued analysis in this chat." },
        { replyTo: "om_card_missing" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark archive continuation background task notifications from engine events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-card-task-notification-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "压缩包后台分析完成。",
        });
        return { text: "archive analysis done" };
      }),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });
      bridge.handleAuthorizedMessage.mockClear();

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string }>;
      };
      const uploadId = workflowState.records[0]!.uploadId;
      await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_archive",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "continue_archive",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              uploadId,
            },
          },
        },
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "后台任务完成\n压缩包后台分析完成。" },
        { replyTo: "card_archive" },
      );
      expectLarkFinalAnswer(channel, "archive analysis done");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        detail: "task_notification",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "continue_archive",
          uploadId,
          textChars: "压缩包后台分析完成。".length,
          larkChatId: "oc_chat",
          larkMessageId: "card_archive",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues Lark zip archive analysis from the waiting workflow", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-continue-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "analysis done" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_continue",
          content: "继续分析 看看结构",
          resources: [],
        }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const bridgeInput = (bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        chatType: string;
        conversationKey: string;
        files: string[];
        text: string;
      };
      expect(bridgeInput).toEqual(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        files: [],
        text: expect.stringContaining("[Archive Analysis Context]"),
      }));
      expect(bridgeInput.text).toContain("看看结构");
      expect(bridgeInput.text).toContain("Extracted files live under:");
      expect(channel.stream).not.toHaveBeenCalled();
      expectLarkFinalAnswer(channel, "analysis done");

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("completed");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues Lark zip archive analysis from the literal /continue slash command", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-slash-continue-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "slash analysis done" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_slash_continue",
          content: "/continue 看看结构",
          resources: [],
        }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const bridgeInput = (bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        conversationKey: string;
        files: string[];
        text: string;
      };
      expect(bridgeInput).toEqual(expect.objectContaining({
        conversationKey: "lark:oc_chat",
        files: [],
        text: expect.stringContaining("[Archive Analysis Context]"),
      }));
      expect(bridgeInput.text).toContain("看看结构");
      expectLarkFinalAnswer(channel, "slash analysis done");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark help command without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-help-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_help",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/help",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/context") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/ask <实例> <提示>") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/continue") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/approve [session]") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/group") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("**会话**") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/code-review") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("`im:message.group_msg`") },
        { replyTo: "om_help", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark help command in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-help-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_help_en", content: "/help" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("**Session**") },
        { replyTo: "om_help_en", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/ask <instance> <prompt>") },
        { replyTo: "om_help_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers Lark /group status without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group status",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("Lark 群聊模式") },
        { replyTo: "om_group", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("需要 @bot") },
        { replyTo: "om_group", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("invites and removes the current Lark group with friendly access commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invite-group-"));
    const channel = fakeChannel({
      getChatMode: vi.fn(async () => "group"),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invite_group",
          chatType: "group",
          content: "/invite group",
          mentionedBot: false,
        }),
      });

      let cfg = await loadInstanceConfig(stateDir);
      expect(cfg.groupMode.allowedChatIds).toContain(stableLarkNumericId("lark:oc_chat"));
      expect(channel.send).toHaveBeenLastCalledWith(
        "oc_chat",
        expect.objectContaining({ markdown: expect.stringContaining("已允许当前飞书群") }),
        { replyTo: "om_invite_group" },
      );

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_remove_group",
          chatType: "group",
          content: "/remove group",
          mentionedBot: false,
        }),
      });

      cfg = await loadInstanceConfig(stateDir);
      expect(cfg.groupMode.allowedChatIds).not.toContain(stableLarkNumericId("lark:oc_chat"));
      expect(channel.send).toHaveBeenLastCalledWith(
        "oc_chat",
        expect.objectContaining({ markdown: expect.stringContaining("已移除当前飞书群") }),
        { replyTo: "om_remove_group" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("invites and removes mentioned Lark users for group access without changing fail-open defaults", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invite-user-"));
    const channel = fakeChannel({
      getChatMode: vi.fn(async () => "group"),
    });
    const targetUserId = stableLarkNumericId("user:ou_target");
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invite_user",
          chatType: "group",
          content: "/invite user @Target",
          mentionedBot: false,
          mentions: [{ id: { openId: "ou_target" }, name: "Target" }],
        }),
      });

      await expect(new AccessStore(path.join(stateDir, "access.json")).load()).resolves.toEqual(expect.objectContaining({
        allowlist: expect.arrayContaining([targetUserId]),
      }));
      expect(channel.send).toHaveBeenLastCalledWith(
        "oc_chat",
        expect.objectContaining({ markdown: expect.stringContaining("已邀请用户 Target") }),
        { replyTo: "om_invite_user" },
      );

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_remove_user",
          chatType: "group",
          content: "/remove user @Target",
          mentionedBot: false,
          mentions: [{ id: { openId: "ou_target" }, name: "Target" }],
        }),
      });

      await expect(new AccessStore(path.join(stateDir, "access.json")).load()).resolves.toEqual(expect.objectContaining({
        allowlist: expect.not.arrayContaining([targetUserId]),
      }));
      expect(channel.send).toHaveBeenLastCalledWith(
        "oc_chat",
        expect.objectContaining({ markdown: expect.stringContaining("已移除用户 Target") }),
        { replyTo: "om_remove_user" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lets an authorized Lark user allow the current group before the group itself is allowed", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-allow-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "当前聊天未获授权。" })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const groupChatId = stableLarkNumericId("lark:oc_group");

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_allow",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group allow",
        }),
      });

      const cfg = await loadInstanceConfig(stateDir);
      expect(cfg.groupMode.enabled).toBe(true);
      expect(cfg.groupMode.allowedChatIds).toContain(groupChatId);
      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "group",
      }));
      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("已允许当前飞书群") },
        { replyTo: "om_group_allow", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stores Lark /group allow from a thread against the base group", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-thread-group-allow-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "当前聊天未获授权。" })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const groupChatId = stableLarkNumericId("lark:oc_group");
    const threadChatId = stableLarkNumericId("lark:oc_group:omt_topic");

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_allow_thread",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: true,
          content: "/group allow",
        }),
      });

      const cfg = await loadInstanceConfig(stateDir);
      expect(cfg.groupMode.enabled).toBe(true);
      expect(cfg.groupMode.allowedChatIds).toContain(groupChatId);
      expect(cfg.groupMode.allowedChatIds).not.toContain(threadChatId);
      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        conversationKey: "lark:oc_group:omt_topic",
      }));
      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lets an allowed Lark group authorize messages inside its threads without another /group allow", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-thread-access-"));
    const channel = fakeChannel();
    const groupChatId = stableLarkNumericId("lark:oc_group");
    const threadChatId = stableLarkNumericId("lark:oc_group:omt_topic");
    const bridge = {
      checkAccess: vi.fn(async (input: { chatId: number }) => input.chatId === groupChatId
        ? { kind: "allow" as const }
        : { kind: "reply" as const, text: `unexpected chat ${input.chatId}` }),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "thread answer" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_allow",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group allow",
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_thread_request",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: true,
          content: "thread question",
        }),
      });

      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "group",
        conversationKey: "lark:oc_group:omt_topic",
      }));
      expect(bridge.checkAccess).not.toHaveBeenCalledWith(expect.objectContaining({
        chatId: threadChatId,
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        conversationKey: "lark:oc_group:omt_topic",
        text: expect.stringContaining("thread question"),
      }));
      expectLarkFinalAnswer(channel, "thread answer");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates a new Lark group from /newgroup without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-new-chat-"));
    const channel = fakeChannel();
    const createChat = vi.fn(async () => ({
      chatId: "oc_new_chat",
      name: "产品需求讨论",
      shareLink: "https://example.feishu.cn/chat/oc_new_chat",
    }));
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_new_chat",
          content: "/newgroup 产品需求讨论",
        }),
      });

      expect(createChat).toHaveBeenCalledWith({
        name: "产品需求讨论",
        mode: "group",
        operatorOpenId: "ou_user",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_new_chat",
        { markdown: expect.stringContaining("这个群已经接入 TaroCub") },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建飞书群：产品需求讨论") },
        { replyTo: "om_new_chat", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("oc_new_chat");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("https://example.feishu.cn/chat/oc_new_chat");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates a new Lark topic chat from /newgroup topic", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-new-topic-"));
    const channel = fakeChannel();
    const createChat = vi.fn(async () => ({
      chatId: "oc_topic_chat",
      name: "研发话题群",
    }));
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_new_topic",
          content: "/newgroup topic 研发话题群",
        }),
      });

      expect(createChat).toHaveBeenCalledWith({
        name: "研发话题群",
        mode: "topic",
        operatorOpenId: "ou_user",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建飞书话题群：研发话题群") },
        { replyTo: "om_new_topic", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates a new Lark topic chat from the /newtopic shortcut", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-newtopic-"));
    const channel = fakeChannel();
    const createChat = vi.fn(async () => ({
      chatId: "oc_topic_chat",
      name: "快捷话题群",
    }));
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_newtopic",
          content: "/newtopic 快捷话题群",
        }),
      });

      expect(createChat).toHaveBeenCalledWith({
        name: "快捷话题群",
        mode: "topic",
        operatorOpenId: "ou_user",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建飞书话题群：快捷话题群") },
        { replyTo: "om_newtopic", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not intercept legacy /new chat prompts as Lark group creation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-new-legacy-"));
    const channel = fakeChannel();
    const createChat = vi.fn(async () => ({
      chatId: "oc_should_not_create",
      name: "不该创建",
    }));
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "engine saw legacy new command" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_legacy_new",
          content: "/new chat 产品需求讨论",
        }),
      });

      expect(createChat).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledOnce();
      expectLarkFinalAnswer(channel, "engine saw legacy new command");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not report /newgroup creation as failed when the welcome message cannot be sent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-new-chat-welcome-fail-"));
    const channel = fakeChannel({
      send: vi.fn(async (to: string) => {
        if (to === "oc_new_chat") {
          throw new Error("welcome send failed");
        }
        return { messageId: "sent_1" };
      }),
    });
    const createChat = vi.fn(async () => ({
      chatId: "oc_new_chat",
      name: "已经创建的群",
    }));
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_new_chat",
          content: "/newgroup 已经创建的群",
        }),
      });

      expect(createChat).toHaveBeenCalledOnce();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建飞书群：已经创建的群") },
        { replyTo: "om_new_chat", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("欢迎消息发送失败");
      expect(JSON.stringify(channel.send.mock.calls)).not.toContain("创建飞书群失败");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders all required chat creation scopes when /newgroup creation fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-new-chat-fail-"));
    const channel = fakeChannel();
    const createChat = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({ createChat }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_new_chat_fail",
          content: "/newgroup 缺权限测试",
        }),
      });

      expect(createChat).toHaveBeenCalledOnce();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("创建飞书群失败");
      expect(rendered).toContain("im:chat / im:chat:create");
      expect(rendered).toContain("用户身份建群，还需要 im:chat:create_by_user");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into group command access checks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_allow_en",
          chatId: "oc_group_en",
          chatType: "group",
          mentionedBot: true,
          content: "/group allow",
        }),
      });

      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        conversationKey: "lark:oc_group_en",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders default Lark group command authorization denials in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-denial-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "reply" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_denial_en",
          chatId: "oc_group_en",
          chatType: "group",
          mentionedBot: true,
          content: "/group allow",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group_en",
        { text: "Current user is not authorized." },
        { replyTo: "om_group_denial_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark group command replies in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-output-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_all_en",
          chatId: "oc_group_en",
          chatType: "group",
          mentionedBot: true,
          content: "/group all",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("Current group switched to ordinary group messages.");
      expect(rendered).toContain("Platform requirement");
      expect(rendered).not.toContain("当前飞书群");
      expect(rendered).not.toContain("飞书群聊模式");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts Lark slash commands with a bot username suffix", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-command-suffix-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "当前聊天未获授权。" })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const groupChatId = stableLarkNumericId("lark:oc_group");

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_suffix",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "/group@cloveric17bot allow",
        }),
      });

      const cfg = await loadInstanceConfig(stateDir);
      expect(cfg.groupMode.allowedChatIds).toContain(groupChatId);
      expect(bridge.checkUserAuthorization).toHaveBeenCalled();
      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("已允许当前飞书群") },
        { replyTo: "om_group_suffix", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lets Lark /group all accept ordinary group messages until /group at restores mention-only mode", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-mode-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "group answer" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_all",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group all",
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_plain",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "普通群消息也应该响应",
        }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("普通群消息也应该响应"),
      }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_at",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group at",
        }),
      });
      bridge.handleAuthorizedMessage.mockClear();

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_ignored",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "恢复后这条不应该响应",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("监听所有普通消息") },
        { replyTo: "om_group_all", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("im:message.group_msg") },
        { replyTo: "om_group_all", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("只响应 @bot") },
        { replyTo: "om_group_at", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("honors numeric Lark listen-all state when the raw group-mode store is missing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-mode-legacy-"));
    const channel = fakeChannel();
    const threadChatId = stableLarkNumericId("lark:oc_group:omt_topic");
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "legacy group answer" })),
    };

    try {
      await writeFile(
        path.join(stateDir, "config.json"),
        JSON.stringify({
          groupMode: {
            enabled: true,
            allowedChatIds: [threadChatId],
            listenAllChatIds: [threadChatId],
          },
        }),
        "utf8",
      );

      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_legacy_plain",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: false,
          content: "历史 numeric listen-all 状态也应该响应",
        }),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("历史 numeric listen-all 状态也应该响应"),
      }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_legacy_status",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: false,
          content: "/status",
        }),
      });

      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊触发：接受普通群消息");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊模式来源：/group all override");

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_legacy_at",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: true,
          content: "/group at",
        }),
      });
      expect((await loadInstanceConfig(stateDir)).groupMode.listenAllChatIds).not.toContain(threadChatId);
      bridge.handleAuthorizedMessage.mockClear();

      const handledAfterAt = await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_legacy_after_at",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: false,
          content: "切回 @ 后这条不应该响应",
        }),
      });

      expect(handledAfterAt).toBe(false);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("makes Lark /group off stop ordinary group messages even after /group all", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-off-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "group answer" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_all",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group all",
        }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_off",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group off",
        }),
      });
      expect(await new LarkGroupModeStore(stateDir).countListenAll()).toBe(0);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("群聊模式：关闭") },
        { replyTo: "om_group_off", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("当前触发：需要 @bot") },
        { replyTo: "om_group_off", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("正在监听普通消息的 Lark 群数：0") },
        { replyTo: "om_group_off", replyInThread: false },
      );
      bridge.handleAuthorizedMessage.mockClear();
      bridge.checkAccess.mockClear();

      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_ordinary_after_off",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "关掉以后普通消息不该进队列",
        }),
      });

      expect(handled).toBe(false);
      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("still accepts explicit Lark slash commands without a mention after /group off", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-group-on-command-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_off",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group off",
        }),
      });

      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_on",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "/group on",
        }),
      });

      const cfg = await loadInstanceConfig(stateDir);
      expect(handled).toBe(true);
      expect(cfg.groupMode.enabled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: expect.stringContaining("Lark 群聊模式已开启") },
        { replyTo: "om_group_on", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark account command with a read-only app card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-account-"));
    const runtime = createLarkServiceRuntime();
    runtime.appInfo = { appId: "cli_zzzz1111aaaa", domain: "feishu" };
    const channel = fakeChannel();
    const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })) };
    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        instanceName: "ccfcc2",
        message: fakeLarkMessage({ messageId: "om_account", content: "/account" }),
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("cli_zzzz****aaaa");
      expect(rendered).not.toContain("cli_zzzz1111aaaa");
      expect(rendered).toContain("lark wizard");
      expect(rendered).not.toContain("app_secret");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark status command without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      model: "gpt-5.4",
      effort: "xhigh",
      codexServiceTier: "fast",
      approvalMode: "full-auto",
      budgetUsd: 12.5,
      locale: "zh",
      verbosity: 2,
      timezone: "Asia/Shanghai",
    }) + "\n");
    await new FileWorkflowStore(stateDir).append({
      uploadId: "archive-waiting",
      chatId: stableLarkNumericId("lark:oc_chat"),
      userId: stableLarkNumericId("user:ou_user"),
      kind: "archive",
      status: "awaiting_continue",
      sourceFiles: [],
      derivedFiles: [],
      summary: "waiting archive",
      createdAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
    });
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-status-123",
      status: "idle",
      updatedAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_status",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/status",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_status", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("lark:oc_chat");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("会话绑定：是");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("审批模式：YOLO/full-auto");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("飞书会话状态");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("打开配置");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("恢复会话");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("预算：$12.50");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("语言：zh");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("详细度：2");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("时区：Asia/Shanghai");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("当前运行：是");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("等待工作流：1");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("阻塞工作流：0");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records known Lark chat labels and shows them in status", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-known-status-"));
    const channel = fakeChannel({ getChatMode: vi.fn(async () => "group") });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_known_status",
          chatId: "oc_known_group",
          chatType: "group",
          chatName: "研发群",
          senderName: "Alice",
          content: "/status",
        }),
      });

      const known = JSON.parse(await readFile(path.join(stateDir, "known-chats.json"), "utf8")) as {
        chats: Array<{ chatId: string; label: string }>;
      };
      expect(known.chats).toContainEqual(expect.objectContaining({
        chatId: "oc_known_group",
        label: "研发群",
      }));
      expect(JSON.stringify(channel.send.mock.calls)).toContain("当前聊天：研发群");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark status command in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-en-"));
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-codex-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en", engine: "codex" }) + "\n");
    await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-test-default"\nmodel_reasoning_effort = "xhigh"\n');
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-status-en",
      status: "idle",
      updatedAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const runtime = createLarkServiceRuntime() as ReturnType<typeof createLarkServiceRuntime> & {
      detectLarkCli?: () => Promise<{ available: boolean; version?: string }>;
    };
    runtime.detectLarkCli = async () => ({
      available: true,
      version: "lark-cli version 1.0.40",
    });

    try {
      process.env.CODEX_HOME = codexHome;
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_status_en", content: "/status" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_status_en", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Engine: codex");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Lark conversation status");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Open config");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Resume session");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Model: default (Codex config: gpt-test-default)");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Effort: default (Codex config: xhigh)");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Session bound: yes");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Current thread: thread-status-en");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Lark CLI: available (lark-cli version 1.0.40)");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Active run: no");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await rm(stateDir, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("does not report the Lark status command itself as an active run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-idle-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_status_idle", content: "/status" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_status_idle", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("当前运行：否");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps the Lark status command usable when config.json is malformed", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-malformed-config-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await writeFile(path.join(stateDir, "config.json"), "{not json", "utf8");

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_status_bad_config", content: "/status" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_status_bad_config", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("**Lark 会话状态**");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("引擎：codex");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("审批模式：YOLO unsafe/bypass");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("shows Lark group trigger mode in /status", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-group-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_all_for_status",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/group all",
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_status",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: false,
          content: "/status",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { card: expect.any(Object) },
        { replyTo: "om_group_status", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊触发：接受普通群消息");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊模式来源：/group all override");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not report stale listen-all state while Lark group mode is disabled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-disabled-group-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await writeFile(
        path.join(stateDir, "config.json"),
        JSON.stringify({
          groupMode: {
            enabled: false,
            allowedChatIds: [stableLarkNumericId("lark:oc_group")],
            listenAllChatIds: [stableLarkNumericId("lark:oc_group")],
          },
        }),
        "utf8",
      );
      await new LarkGroupModeStore(stateDir).setListenAll("oc_group", true);

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_group_disabled_status",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/status",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { card: expect.any(Object) },
        { replyTo: "om_group_disabled_status", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊触发：需要 @bot / mention");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("群聊模式来源：群聊模式已关闭");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("aborts the active run from a Lark stop text command", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_stop",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/stop",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(abortController.signal.aborted).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "已停止。" },
        { replyTo: "om_stop", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("Lark /stop aborts the active task but does NOT cancel the queue", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-queue-"));
    const runtime = createLarkServiceRuntime();
    const clearPendingSpy = vi.spyOn(runtime.chatQueue, "clearPending");
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "x" })) };

    try {
      await handleLarkMessage({
        channel, bridge, runtime, stateDir,
        message: {
          messageId: "om_stop", chatId: "oc_chat", chatType: "p2p", senderId: "ou_user",
          content: "/stop", rawContentType: "text", resources: [], mentions: [],
          mentionAll: false, mentionedBot: false, createTime: Date.now(),
        },
      });

      expect(abortController.signal.aborted).toBe(true);     // running task stopped
      expect(clearPendingSpy).not.toHaveBeenCalled();         // queued tasks left intact
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark stop text replies in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-en-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop_en", content: "/stop" }),
      });

      expect(abortController.signal.aborted).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Stopped." },
        { replyTo: "om_stop_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark stop text commands before aborting active runs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-text-denied-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_stop_denied",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_intruder",
          content: "/stop",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
      }));
      expect(abortController.signal.aborted).toBe(false);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "未授权" },
        { replyTo: "om_stop_denied", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark usage command from the shared usage store", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-usage-"));
    await new UsageStore(stateDir).record({
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      costUsd: 0.0123,
    }, new Date("2026-05-25T00:00:00.000Z"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage", content: "/usage" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("请求数：1") },
        { replyTo: "om_usage", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark usage command in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-usage-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    await new UsageStore(stateDir).record({
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      costUsd: 0.0123,
    }, new Date("2026-05-25T00:00:00.000Z"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage_en", content: "/usage" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Requests: 1") },
        { replyTo: "om_usage_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sets Lark model and effort commands in the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_model", content: "/model opus" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_effort", content: "/effort max" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.model).toBe("opus");
      expect(config.effort).toBe("max");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(channel.send.mock.calls)).toContain("模型已设为 opus");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Effort 已设为 max");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers Lark fast status in Chinese when Lark locale is Chinese", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fast-status-zh-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      codexServiceTier: "fast",
      locale: "zh",
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fast_status_zh", content: "/fast status" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Codex Fast Mode：开启" },
        { replyTo: "om_fast_status_zh", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers Lark local config commands in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      locale: "en",
      effort: "high",
      approvalMode: "full-auto",
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_model_en", content: "/model" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_effort_en", content: "/effort" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fast_en", content: "/fast status" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_engine_en", content: "/engine" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_yolo_en", content: "/yolo status" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("Current model: default");
      expect(rendered).toContain("Current effort: high");
      expect(rendered).toContain("Codex Fast Mode: off");
      expect(rendered).toContain("Current engine: codex");
      expect(rendered).toContain("Current YOLO: full-auto");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders a Lark config card without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-card-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      locale: "zh",
      codexServiceTier: "fast",
      approvalMode: "full-auto",
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_config", chatName: "配置私聊", senderName: "Alice", content: "/config" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_config", replyInThread: false },
      );
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("飞书配置面板");
      expect(rendered).toContain("聊天: 配置私聊");
      expect(rendered).toContain('"tag":"form"');
      expect(rendered).toContain('"tag":"select_static"');
      expect(rendered).toContain('"form_action_type":"submit"');
      expect(rendered).toContain('"cctb_lark":"config"');
      expect(rendered).toContain('"action":"engine"');
      expect(rendered).toContain('"action":"yolo"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders legacy numeric Lark group state in topic config cards", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-card-legacy-group-"));
    const threadChatId = stableLarkNumericId("lark:oc_group:omt_topic");
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      locale: "zh",
      groupMode: {
        enabled: true,
        allowedChatIds: [threadChatId],
        listenAllChatIds: [threadChatId],
      },
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_config_legacy_group",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: true,
          content: "/config",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("已允许; 监听普通消息");
      expect(rendered).toContain("✓ 全量监听");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps Lark Antigravity model commands local instead of forwarding them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-agy-model-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_model", content: "/model gemini-3.5-flash" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.model).toBeUndefined();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Antigravity 模型") },
        { replyTo: "om_model", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("toggles Lark Codex fast mode through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fast-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fast", content: "/fast on" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.codexServiceTier).toBe("fast");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Fast Mode 已开启") },
        { replyTo: "om_fast", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("switches the Lark engine through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-engine-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-5.4" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_engine", content: "/engine antigravity" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.engine).toBe("antigravity");
      expect(config.model).toBeUndefined();
      expect(config.approvalMode).toBe("bypass");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("引擎已设为 antigravity") },
        { replyTo: "om_engine", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("toggles Lark YOLO mode through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-yolo-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_yolo", content: "/yolo on" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.approvalMode).toBe("full-auto");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("YOLO mode ON") },
        { replyTo: "om_yolo", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resets the current Lark conversation session without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reset-"));
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      resume: { sessionId: "old", dirName: "old", workspacePath: "/tmp/old" },
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_reset", content: "/reset" }),
      });

      expect(await sessionStore.findByConversationKey("lark:oc_chat")).toBeNull();
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.resume).toBeUndefined();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("当前聊天的会话已重置") },
        { replyTo: "om_reset", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("detaches the current Lark Codex thread without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-detach-"));
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_detach", content: "/detach" }),
      });

      expect(await sessionStore.findByConversationKey("lark:oc_chat")).toBeNull();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已断开当前 Codex thread") },
        { replyTo: "om_detach", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("binds an explicit Codex thread from Lark resume without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-thread-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume", content: "/resume thread thread-abc" }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("thread-abc");
      expect(record?.telegramChatId).toBe(stableLarkNumericId("lark:oc_chat"));
      expect(bridge.validateCodexThread).toHaveBeenCalledWith("thread-abc");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已绑定 Codex thread：thread-abc") },
        { replyTo: "om_resume", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers Lark resume guidance in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume_en", content: "/resume" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("For Codex, use /resume thread <thread-id>.") },
        { replyTo: "om_resume_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("binds an explicit Antigravity conversation from Lark resume without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-agy-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_resume",
          content: "/resume conversation fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("fdfc8ab1-7936-4599-98b0-d8ba2593c250");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已绑定 Antigravity conversation") },
        { replyTo: "om_resume", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes a scanned Claude session from Lark without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-claude-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const scanRecentSessions = vi.fn(async () => [
      {
        sessionId: "claude-session-1",
        dirName: "-Users-cloveric-projects-demo",
        workspacePath: "/Users/cloveric/projects/demo",
        modifiedAt: new Date("2026-05-25T06:00:00.000Z"),
        displayName: "demo",
      },
    ]);

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          sessionRuntime: { scanRecentSessions },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume_scan", content: "/resume" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          sessionRuntime: { scanRecentSessions },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume_pick", content: "/resume 1" }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("claude-session-1");
      expect(record?.telegramChatId).toBe(stableLarkNumericId("lark:oc_chat"));
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, any>;
      expect(config.resume).toMatchObject({
        sessionId: "claude-session-1",
        dirName: "-Users-cloveric-projects-demo",
        workspacePath: "/Users/cloveric/projects/demo",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { card: expect.any(Object) },
        { replyTo: "om_resume_scan", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("恢复历史会话");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("恢复此会话");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("claude-session-1");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已恢复 session：demo") },
        { replyTo: "om_resume_pick", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds Lark cron jobs with raw Lark routing metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-add-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron",
          content: "/cron add 0 9 * * * morning summary",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        larkChatId: "oc_chat",
        larkMessageId: "om_cron",
        conversationKey: "lark:oc_chat",
        prompt: "morning summary",
      });
      expect(scheduler.refresh).toHaveBeenCalledOnce();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已添加任务") },
        { replyTo: "om_cron", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders missing Lark cron runtime guidance in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-runtime-en-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_cron_runtime_en", content: "/cron list" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Lark cron runtime is not started. Restart the Lark service and try again." },
        { replyTo: "om_cron_runtime_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into cron commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_en",
          content: "/cron add 0 9 * * * morning summary",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        locale: "en",
        prompt: "morning summary",
      });
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Added task") },
        { replyTo: "om_cron_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds Lark cron jobs from cron.add tool tags with raw Lark routing metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-tool-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'ok\n[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check inbox"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        instanceName: "lark-alpha",
        message: fakeLarkMessage({
          messageId: "om_cron_tool",
          content: "10分钟后提醒我查邮件",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        larkChatId: "oc_chat",
        larkMessageId: "om_cron_tool",
        conversationKey: "lark:oc_chat",
        prompt: "check inbox",
        deliveryMode: "notify",
      });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        instanceName: "lark-alpha",
        detail: "cron.add tool accepted",
      }));
      expect(scheduler.refresh).toHaveBeenCalledOnce();
      expectLarkFinalAnswer(channel, "ok");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已添加定时任务") },
        { replyTo: "om_cron_tool" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into cron.add tool tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-tool-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'ok\n[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check inbox"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_tool_en",
          content: "remind me to check inbox",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        locale: "en",
        prompt: "check inbox",
      });
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Scheduled task added") },
        { replyTo: "om_cron_tool_en" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not preserve misleading Lark text when cron.add tool tags are rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-tool-rejected-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '已设置\n[tool:{"name":"cron.add","payload":{"in":"bad","prompt":"check inbox"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_tool_rejected",
          content: "提醒我查邮件",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("提醒延迟格式无效");
      expect(rendered).not.toContain("已设置");
      expect(await store.list()).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("executes Lark cron management tool tags in the current Lark conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-tool-manage-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          '先看看任务\n[tool:{"name":"cron.list","payload":{}}]',
          `[tool:{"name":"cron.toggle","payload":{"id":"${jobId}"}}]`,
          `[tool:{"name":"cron.remove","payload":{"id":"${jobId}"}}]`,
        ].join("\n"),
      })),
    };
    let jobId = "";

    try {
      const job = await store.add({
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        larkMessageId: "om_existing",
        cronExpr: "*/10 * * * *",
        prompt: "看生益科技",
      });
      jobId = job.id;

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_tool_manage",
          content: "停掉每 10 分钟看生益科技的任务",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("看生益科技");
      expect(rendered).toContain(`任务 ${job.id} 已停用`);
      expect(rendered).toContain(`已删除任务  ID  ${job.id}`);
      expect(await store.get(job.id)).toBeNull();
      expect(scheduler.refresh).toHaveBeenCalledTimes(2);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("removes Lark cron jobs by query from tool tags when there is a unique current-chat match", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-tool-query-remove-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"cron.remove","payload":{"query":"生益科技"}}]',
      })),
    };

    try {
      const job = await store.add({
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "*/10 * * * *",
        prompt: "每 10 分钟看生益科技",
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_tool_query_remove",
          content: "停掉看生益科技的任务",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain(`已删除任务  ID  ${job.id}`);
      expect(await store.get(job.id)).toBeNull();
      expect(scheduler.refresh).toHaveBeenCalledOnce();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds Lark cron jobs from cron-add fallback tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-fallback-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '已设置\n[cron-add:{"in":"10m","prompt":"检查邮箱"}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron_fallback",
          content: "10分钟后提醒我查邮件",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        larkChatId: "oc_chat",
        larkMessageId: "om_cron_fallback",
        prompt: "检查邮箱",
      });
      expectLarkFinalAnswer(channel, "已设置");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已添加定时任务") },
        { replyTo: "om_cron_fallback" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs Lark cron notifications back to the raw Lark chat", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-run-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "提醒我：明天早定课",
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "notify",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "⏰ 提醒\n早定课" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs Lark cron notifications back into the originating Lark thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-thread-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat:omt_thread"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "group",
        conversationKey: "lark:oc_chat:omt_thread",
        larkChatId: "oc_chat",
        larkThreadId: "omt_thread",
        larkMessageId: "om_cron_thread",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "提醒我：明天早定课",
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "notify",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "⏰ 提醒\n早定课" },
        { replyTo: "om_cron_thread", replyInThread: true },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes stored Lark cron locale into agent-mode scheduled tasks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-agent-locale-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "agent result" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "daily summary",
        enabled: true,
        runOnce: false,
        sessionMode: "new_per_run",
        deliveryMode: "agent",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
        locale: "en",
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        conversationKey: "lark:oc_chat",
        text: "daily summary",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "agent result" },
        {},
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders empty Lark cron agent replies in the stored Lark locale", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-empty-en-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "emptycron",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "daily summary",
        enabled: true,
        runOnce: false,
        sessionMode: "new_per_run",
        deliveryMode: "agent",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
        locale: "en",
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "(empty reply)" },
        {},
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark cron file deliveries with the originating chat and user ids", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-file-timeline-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { requestOutputDir?: string }) => {
        const outputDir = input.requestOutputDir!;
        const reportPath = path.join(outputDir, "cron-report.txt");
        await mkdir(outputDir, { recursive: true });
        await writeFile(reportPath, "cron report");
        return { text: `Report ready [send-file:${reportPath}]` };
      }),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
      deliverResponse: deliverLarkResponse,
    });

    try {
      await executor({
        id: "cronfile1",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat:omt_thread"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "group",
        conversationKey: "lark:oc_chat:omt_thread",
        larkChatId: "oc_chat",
        larkThreadId: "omt_thread",
        larkMessageId: "om_cron_thread",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "生成报告",
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "agent",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat:omt_thread"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat:omt_thread",
        metadata: expect.objectContaining({
          fileName: "cron-report.txt",
          larkChatId: "oc_chat",
          larkMessageId: "om_cron_thread",
          bridgeChatType: "group",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("bounds long Lark cron notification prompts before sending", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-long-notify-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: `提醒我：${"很长".repeat(3000)}`,
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "notify",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      expect(channel.send).toHaveBeenCalledTimes(1);
      const payload = (channel.send.mock.calls[0] as unknown as Array<unknown>)[1] as { text: string };
      expect(payload.text.length).toBeLessThanOrEqual(3500);
      expect(payload.text).toContain("已截断");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports Lark cron failures back into the originating Lark thread", async () => {
    const channel = fakeChannel();

    await sendLarkCronFailureNotification(channel, {
      id: "1234abcd",
      channel: "lark",
      chatId: stableLarkNumericId("lark:oc_chat:omt_thread"),
      userId: stableLarkNumericId("user:ou_user"),
      chatType: "group",
      conversationKey: "lark:oc_chat:omt_thread",
      larkChatId: "oc_chat",
      larkThreadId: "omt_thread",
      larkMessageId: "om_cron_thread",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      prompt: "检查日报",
      enabled: true,
      runOnce: true,
      sessionMode: "new_per_run",
      deliveryMode: "agent",
      mute: false,
      silent: false,
      timeoutMins: 30,
      maxFailures: 3,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
      failureCount: 0,
      runHistory: [],
    }, "boom");

    expect(channel.send).toHaveBeenCalledWith(
      "oc_chat",
      { text: expect.stringContaining("定时任务执行失败") },
      { replyTo: "om_cron_thread", replyInThread: true },
    );
    expect(channel.send).toHaveBeenCalledWith(
      "oc_chat",
      { text: expect.stringContaining("boom") },
      { replyTo: "om_cron_thread", replyInThread: true },
    );
  });

  it("bounds long Lark cron failure notifications before sending", async () => {
    const channel = fakeChannel();

    await sendLarkCronFailureNotification(channel, {
      id: "1234abcd",
      channel: "lark",
      chatId: stableLarkNumericId("lark:oc_chat"),
      userId: stableLarkNumericId("user:ou_user"),
      chatType: "private",
      conversationKey: "lark:oc_chat",
      larkChatId: "oc_chat",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      prompt: "检查日报",
      enabled: true,
      runOnce: true,
      sessionMode: "new_per_run",
      deliveryMode: "agent",
      mute: false,
      silent: false,
      timeoutMins: 30,
      maxFailures: 3,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
      failureCount: 0,
      runHistory: [],
    }, `stack\n${"x".repeat(9000)}`);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = (channel.send.mock.calls[0] as unknown as Array<unknown>)[1] as { text: string };
    expect(payload.text.length).toBeLessThanOrEqual(3500);
    expect(payload.text).toContain("已截断");
  });

  it("does not report muted Lark cron failures", async () => {
    const channel = fakeChannel();

    await sendLarkCronFailureNotification(channel, {
      id: "1234abcd",
      channel: "lark",
      chatId: stableLarkNumericId("lark:oc_chat"),
      userId: stableLarkNumericId("user:ou_user"),
      chatType: "private",
      conversationKey: "lark:oc_chat",
      larkChatId: "oc_chat",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      prompt: "检查日报",
      enabled: true,
      runOnce: true,
      sessionMode: "new_per_run",
      deliveryMode: "agent",
      mute: true,
      silent: false,
      timeoutMins: 30,
      maxFailures: 3,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
      failureCount: 0,
      runHistory: [],
    }, "boom");

    expect(channel.send).not.toHaveBeenCalled();
  });

  it("sets an unbounded structured Codex goal from Lark by default", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goal-budget-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      setThreadGoal: vi.fn(async () => ({
        goal: {
          threadId: "lark:oc_chat",
          objective: "ship the release",
          status: "active" as const,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1779690000,
          updatedAt: 1779690000,
        },
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal ship the release" }),
      });

      expect(bridge.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        objective: "ship the release",
        tokenBudget: null,
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("预算：不限制") },
        { replyTo: "om_goal", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders structured Lark goal replies in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goal-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }) + "\n");
    const goal = {
      threadId: "thread-lark",
      objective: "ship the Lark channel",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      setThreadGoal: vi.fn(async () => ({ goal })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal_en", content: "/goal ship the Lark channel" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(bridge.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
        objective: "ship the Lark channel",
        tokenBudget: null,
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Goal set.") },
        { replyTo: "om_goal_en", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Budget: unbounded") },
        { replyTo: "om_goal_en", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Goal usage: not recorded yet") },
        { replyTo: "om_goal_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sets a structured Codex goal from Lark without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goal-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      setThreadGoal: vi.fn(async () => ({
        goal: {
          threadId: "lark:oc_chat",
          objective: "ship the release",
          status: "active" as const,
          tokenBudget: 50_000,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1779690000,
          updatedAt: 1779690000,
        },
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal -b 50k ship the release" }),
      });

      expect(bridge.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        objective: "ship the release",
        tokenBudget: 50_000,
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Goal 已设置") },
        { replyTo: "om_goal", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes unbounded Claude goals through by default from Lark", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-claude-goal-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const seenTexts: string[] = [];
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        seenTexts.push(input.text);
        return { text: "goal passed through" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal 写发布说明" }),
      });

      expect(seenTexts).toEqual(["/goal 写发布说明"]);
      expect(channel.stream).not.toHaveBeenCalled();
      expectLarkFinalAnswer(channel, "goal passed through");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes explicitly unbounded Claude goals through as native slash commands from Lark", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-claude-goal-unbounded-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const seenTexts: string[] = [];
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        seenTexts.push(input.text);
        return { text: "goal passed through" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal --unbounded 写发布说明" }),
      });

      expect(seenTexts).toEqual(["/goal 写发布说明"]);
      expect(channel.stream).not.toHaveBeenCalled();
      expectLarkFinalAnswer(channel, "goal passed through");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards Claude context commands from Lark without starting a regular stream turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-context-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => ({ text: `native ${input.text} result` })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_context", content: "/context" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "/context",
        files: [],
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "native /context result" },
        { replyTo: "om_context", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers Lark context wrong-engine guidance in English when Lark locale is explicitly English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-context-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_context_en", content: "/context" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/context is only supported with the Claude engine.") },
        { replyTo: "om_context_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects Lark compact commands on non-Claude engines instead of prompting the model", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-compact-wrong-engine-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_compact_wrong_engine", content: "/compact" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/compact 仅支持 Claude 引擎") },
        { replyTo: "om_compact_wrong_engine", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards Claude compact commands from Lark and relays the compacted result", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-compact-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => ({ text: `native ${input.text} result` })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_compact", content: "/compact" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "/compact",
        files: [],
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenNthCalledWith(
        1,
        "oc_chat",
        { markdown: "正在压缩会话上下文..." },
        { replyTo: "om_compact", replyInThread: false },
      );
      expect(channel.send).toHaveBeenNthCalledWith(
        2,
        "oc_chat",
        { markdown: "上下文已压缩。\n\nnative /compact result" },
        { replyTo: "om_compact", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards Claude ultrareview commands from Lark and relays the review result", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-ultrareview-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "claude",
      resume: { sessionId: "claude-session", dirName: "work", workspacePath: "/tmp/work" },
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "review output" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ultrareview", content: "/ultrareview" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "/ultrareview",
        files: [],
        workspaceOverride: "/tmp/work",
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenNthCalledWith(
        1,
        "oc_chat",
        { markdown: "正在进行代码审查..." },
        { replyTo: "om_ultrareview", replyInThread: false },
      );
      expect(channel.send).toHaveBeenNthCalledWith(
        2,
        "oc_chat",
        { markdown: "review output" },
        { replyTo: "om_ultrareview", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lets /stop abort an in-flight Lark context command", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-context-stop-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    let releaseContext!: () => void;
    const contextReleased = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    let resolveContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      resolveContextStarted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string; abortSignal?: AbortSignal }) => {
        capturedSignal = input.abortSignal;
        resolveContextStarted();
        await contextReleased;
        return { text: "native context result" };
      }),
    };

    const contextRun = handleLarkMessage({
      channel,
      bridge,
      runtime,
      stateDir,
      message: fakeLarkMessage({ messageId: "om_context_long", content: "/context" }),
    });

    try {
      await contextStarted;
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop_context", content: "/stop" }),
      });

      expect(capturedSignal?.aborted).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "已停止。" },
        { replyTo: "om_stop_context", replyInThread: false },
      );
    } finally {
      releaseContext();
      await contextRun;
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark board add and list without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-board-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_add", content: "/board add Ship Lark parity" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_list", content: "/board list" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建 B1") },
        { replyTo: "om_board_add", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Ship Lark parity") },
        { replyTo: "om_board_list", replyInThread: false },
      );

      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events.filter((event) => event.metadata?.command === "board").map((event) => event.channel)).toEqual(["lark", "lark"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into board commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-board-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_list_en", content: "/board list" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("No board tasks yet") },
        { replyTo: "om_board_list_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark fan delegation through the shared Agent Bus command path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fan-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "self answer" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "peer answer" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: ["peer1"],
              chain: [],
              verifier: null,
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fan", content: "/fan compare this" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "compare this",
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "peer1",
        prompt: "compare this",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("正在并行查询 2 个 bot") },
        { replyTo: "om_fan", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[peer1]\npeer answer") },
        { replyTo: "om_fan", replyInThread: false },
      );

      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        channel: "lark",
        metadata: expect.objectContaining({ command: "fan", fanTargets: ["peer1"] }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark /btw as an isolated side question without touching the current conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-btw-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "side answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw", content: "/btw quick side question" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "bus",
        text: "quick side question",
        files: [],
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.not.objectContaining({
        conversationKey: "lark:oc_chat",
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "side answer" },
        { replyTo: "om_btw", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark /btw background task notifications from engine events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-btw-task-notification-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "Side question background work done.",
        });
        return { text: "side answer" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw_notify", content: "/btw quick side question" }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "后台任务完成\nSide question background work done." },
        { replyTo: "om_btw_notify" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        detail: "task_notification",
        metadata: expect.objectContaining({ source: "delegation" }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("splits long Lark /btw answers before sending them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-btw-long-"));
    const channel = fakeChannel();
    const longAnswer = "旁问无换行长答案：" + "甲".repeat(7600);
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: longAnswer })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw_long", content: "/btw 写一个长解释" }),
      });

      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const markdownSends = sendCalls
        .map((call) => call[1])
        .filter((payload): payload is { markdown: string } => Boolean((payload as { markdown?: unknown }).markdown));
      expect(markdownSends.length).toBeGreaterThan(1);
      expect(markdownSends.map((payload) => payload.markdown).join("")).toBe(longAnswer);
      for (const payload of markdownSends) {
        expect(payload.markdown.length).toBeLessThanOrEqual(3500);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs configured Lark research-report crew for ordinary messages before the default engine turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-crew-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: "1. What changed?\n2. What should we do next?",
      })),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research A" })
      .mockResolvedValueOnce({ text: "Research B" })
      .mockResolvedValueOnce({ text: "Analysis" })
      .mockResolvedValueOnce({ text: "Draft report" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: [],
              verifier: null,
              crew: {
                enabled: true,
                workflow: "research-report" as const,
                coordinator: "lark",
                roles: {
                  researcher: "researcher",
                  analyst: "analyst",
                  writer: "writer",
                  reviewer: "reviewer",
                },
                maxResearchQuestions: 2,
                maxRevisionRounds: 1,
              },
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_crew", content: "Analyze the market shift" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "bus",
        text: expect.stringContaining("coordinator agent"),
      }));
      expect(delegateToInstance).toHaveBeenCalledTimes(5);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "正在运行 research-report crew..." },
        { replyTo: "om_crew", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Draft report" },
        { replyTo: "om_crew", replyInThread: false },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      const crewEvents = timeline.filter((event) => String(event.type).startsWith("crew."));
      expect(crewEvents.length).toBeGreaterThan(0);
      expect([...new Set(crewEvents.map((event) => event.channel))]).toEqual(["lark"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark ask delegation through the shared Agent Bus command path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-ask-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "peer answer" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ask", content: "/ask reviewer inspect this" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: "inspect this",
        depth: 0,
        stateDir,
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "正在转发给 reviewer..." },
        { replyTo: "om_ask", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "[来自 reviewer]\n\npeer answer" },
        { replyTo: "om_ask", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark chain delegation through configured Agent Bus peers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-chain-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ success: true, text: "draft" })
      .mockResolvedValueOnce({ success: true, text: "final" });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: ["reviewer", "writer"],
              verifier: null,
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_chain", content: "/chain improve this" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: "improve this",
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(2, expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "writer",
        prompt: expect.stringContaining("draft"),
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[链路阶段 2: writer]") },
        { replyTo: "om_chain", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark verify delegation through the shared verifier path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-verify-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "draft answer" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "looks good" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: [],
              verifier: "reviewer",
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_verify", content: "/verify check this" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: "check this",
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: expect.stringContaining("draft answer"),
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[reviewer 的验证]") },
        { replyTo: "om_verify", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("registers a Lark thread as a Mini Bus peer", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-here-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_here",
          chatType: "group",
          threadId: "omt_planner",
          mentionedBot: true,
          content: "/mini here planner",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已注册 Mini Bus peer planner") },
        { replyTo: "om_mini_here", replyInThread: true },
      );

      const groupChatId = stableLarkNumericId("lark-group:oc_chat");
      const threadId = stableLarkNumericId("lark-thread:omt_planner");
      await expect(new MiniBusStore(stateDir).listPeers(groupChatId)).resolves.toEqual([
        expect.objectContaining({
          name: "planner",
          chatId: groupChatId,
          messageThreadId: threadId,
          conversationKey: "lark:oc_chat:omt_planner",
        }),
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("asks a registered Lark Mini Bus peer through its thread conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-ask-"));
    const channel = fakeChannel();
    const groupChatId = stableLarkNumericId("lark-group:oc_chat");
    const writerThreadId = stableLarkNumericId("lark-thread:omt_writer");
    await new MiniBusStore(stateDir).upsertPeer({
      name: "writer",
      chatId: groupChatId,
      messageThreadId: writerThreadId,
      conversationKey: "lark:oc_chat:omt_writer",
    });
    const queuedBridgeTurns: string[] = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "writer answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          miniRuntime: {
            runQueuedBridgeTurn: async (conversationKey, job) => {
              queuedBridgeTurns.push(conversationKey);
              return await job();
            },
          },
        }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_ask",
          chatType: "group",
          threadId: "omt_planner",
          mentionedBot: true,
          content: "/mini ask writer draft this",
        }),
      });

      expect(queuedBridgeTurns).toEqual(["lark:oc_chat:omt_writer"]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        chatType: "bus",
        messageThreadId: writerThreadId,
        conversationKey: "lark:oc_chat:omt_writer",
        text: "draft this",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[writer]\n\nwriter answer") },
        { replyTo: "om_mini_ask", replyInThread: true },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark Mini Bus background task notifications from engine events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-task-notification-"));
    const channel = fakeChannel();
    const groupChatId = stableLarkNumericId("lark-group:oc_chat");
    const writerThreadId = stableLarkNumericId("lark-thread:omt_writer");
    await new MiniBusStore(stateDir).upsertPeer({
      name: "writer",
      chatId: groupChatId,
      messageThreadId: writerThreadId,
      conversationKey: "lark:oc_chat:omt_writer",
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "Mini topic finished its background job.",
        });
        return { text: "writer answer" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          miniRuntime: {
            runQueuedBridgeTurn: async (_conversationKey, job) => await job(),
          },
        }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_notify",
          chatType: "group",
          threadId: "omt_planner",
          mentionedBot: true,
          content: "/mini ask writer draft this",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "后台任务完成\nMini topic finished its background job." },
        { replyTo: "om_mini_notify", replyInThread: true },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        detail: "task_notification",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("aborts the active run from a stop card action", async () => {
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "stop", conversationKey: "lark:oc_chat" },
        },
      },
    });

    expect(handled).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已停止。" }, { replyTo: "om_card" });
  });

  it("cancels just the queued task from its card without aborting the active run", async () => {
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    runtime.queueCards.set("om_queued", "card_q");
    const cancelSpy = vi.spyOn(runtime.chatQueue, "cancel").mockReturnValue(true);
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "stop", conversationKey: "lark:oc_chat", taskId: "om_queued" } },
      },
    });

    expect(handled).toBe(true);
    expect(cancelSpy).toHaveBeenCalledWith("lark:oc_chat", "om_queued");
    expect(abortController.signal.aborted).toBe(false); // the running task is left alone
    expect(runtime.cancelledQueueTaskIds.has("om_queued")).toBe(true); // skip stays silent later
    expect(runtime.queueCards.has("om_queued")).toBe(false); // card claimed
    expect(channel.updateCard).toHaveBeenCalledWith("card_q", expect.objectContaining({ schema: "2.0" }));
  });

  it("acks by text when the queued card cannot be updated in place (no silent cancel)", async () => {
    const runtime = createLarkServiceRuntime();
    runtime.queueCards.set("om_queued", "card_q");
    vi.spyOn(runtime.chatQueue, "cancel").mockReturnValue(true);
    // The in-place card update fails (Feishu can ignore/refuse patches): the
    // cancel must still give immediate feedback, not vanish silently.
    const channel = fakeChannel({ updateCard: vi.fn(async () => { throw new Error("patch refused"); }) });

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "stop", conversationKey: "lark:oc_chat", taskId: "om_queued" } },
      },
    });

    expect(handled).toBe(true);
    expect(runtime.cancelledQueueTaskIds.has("om_queued")).toBe(true); // claimed → later skip stays silent
    expect(channel.send).toHaveBeenCalledWith(
      "oc_chat",
      { text: expect.stringContaining("已取消") },
      expect.objectContaining({ replyTo: "om_card" }),
    );
  });

  it("falls back to aborting the active run when the carried task already started", async () => {
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    vi.spyOn(runtime.chatQueue, "cancel").mockReturnValue(false); // task is the running one
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "stop", conversationKey: "lark:oc_chat", taskId: "om_active" } },
      },
    });

    expect(handled).toBe(true);
    expect(abortController.signal.aborted).toBe(true); // fell back to aborting the active task
  });

  it("treats a repeat cancel tap as a no-op and never aborts the active run", async () => {
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    // First cancel already marked this task cancelled (silent-skip claim).
    runtime.cancelledQueueTaskIds.add("om_queued");
    const cancelSpy = vi.spyOn(runtime.chatQueue, "cancel");
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "stop", conversationKey: "lark:oc_chat", taskId: "om_queued" } },
      },
    });

    expect(handled).toBe(true);
    expect(cancelSpy).not.toHaveBeenCalled(); // short-circuited
    expect(abortController.signal.aborted).toBe(false); // did NOT fall through to abort active
  });

  it("renders Lark stop card action replies in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-card-en-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      const handled = await handleLarkCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card_en",
          operator: { openId: "ou_user" },
          action: {
            value: { cctb_lark: "stop", conversationKey: "lark:oc_chat" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "Stopped." }, { replyTo: "om_card_en" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores Lark document comments that do not mention the bot", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-skip-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent({ mentionedBot: false }),
      });

      expect(handled).toBe(false);
      expect(commentClient.getCommentContext).not.toHaveBeenCalled();
      expect(commentClient.createReply).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers mentioned Lark document comments by replying in the comment thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-run-"));
    const commentClient = fakeCommentClient({
      getCommentContext: vi.fn(async () => ({
        quote: "被选中的原文",
        replies: [{
          replyId: "reply_1",
          userId: "ou_user",
          text: "@bot 帮我总结这里",
          docsLinks: ["https://example.feishu.cn/docx/doc_token"],
        }],
      })),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: {
        conversationKey?: string;
        files: string[];
        text: string;
      }) => ({
        text: '这是评论回复。[send-file:/tmp/ignored.txt]\n[cron-add:{"in":"10m","prompt":"check"}]',
      })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark-comment:doc_token",
        locale: "zh",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark-comment:doc_token",
        files: [],
        text: expect.stringContaining("<lark_comment_context>"),
      }));
      const text = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(text).toContain("file_token: doc_token");
      expect(text).toContain("comment_id: comment_1");
      expect(text).toContain("被选中的原文");
      expect(text).toContain("@bot 帮我总结这里");
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: expect.stringContaining("这是评论回复。"),
      });
      expect(commentClient.createReply).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("云文档评论里不能执行聊天投递或定时任务工具"),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds and removes a typing reaction while answering mentioned Lark document comments", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-reaction-"));
    const commentClient = fakeCommentClient({
      getCommentContext: vi.fn(async () => ({
        quote: "被选中的原文",
        replies: [{
          replyId: "reply_1",
          userId: "ou_user",
          text: "@bot 看这里",
          docsLinks: [],
        }],
      })),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "评论回复" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.addReaction).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        replyId: "reply_1",
        reactionType: "Typing",
      });
      expect(commentClient.removeReaction).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        replyId: "reply_1",
        reactionType: "Typing",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to a top-level Lark document comment when thread replies are rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-top-level-"));
    const replyError = Object.assign(new Error("whole document comments do not accept thread replies"), {
      code: 1069302,
    });
    const commentClient = fakeCommentClient({
      createReply: vi.fn(async () => {
        throw replyError;
      }),
      createTopLevelComment: vi.fn(async () => undefined),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "整篇评论回复" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "整篇评论回复",
      });
      expect(commentClient.createTopLevelComment).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "整篇评论回复",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("executes Lark document creation tags from document comments instead of silently stripping them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-doc-tool-"));
    const commentClient = fakeCommentClient();
    const runtime = createLarkServiceRuntime({
      commentClient,
      createDocument: vi.fn(async () => ({
        title: "Spec",
        url: "https://example.feishu.cn/docx/doc_1",
        documentId: "doc_1",
        warning: "permission_grant=skipped no current user",
      })),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\\n\\n正文","docFormat":"markdown"}}]',
      })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime,
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(runtime.createDocument).toHaveBeenCalledWith(expect.objectContaining({
        title: "Spec",
        content: "# Spec\n\n正文",
        docFormat: "markdown",
      }));
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: expect.stringContaining("permission_grant=skipped no current user"),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into document comment turns and access checks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const commentClient = fakeCommentClient({
      getCommentContext: vi.fn(async () => ({
        quote: "",
        replies: [{
          replyId: "reply_1",
          userId: "ou_user",
          text: "@bot please summarize this",
          docsLinks: [],
        }],
      })),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: {
        conversationKey?: string;
        files: string[];
        locale?: string;
        text: string;
      }) => ({ text: "comment reply" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        conversationKey: "lark-comment:doc_token",
      }));
      const promptText = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(promptText).toContain("You are replying in a Feishu/Lark document comment thread.");
      expect(promptText).toContain("User comment:");
      expect(promptText).not.toContain("你正在飞书云文档评论线程里回复用户");
      expect(promptText).not.toContain("用户评论：");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("explains unsupported document comment side effects instead of returning an empty reply", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-empty-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "[send-file:/tmp/ignored.txt]" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: expect.stringContaining("Document comments cannot execute chat delivery or scheduled-task tools"),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders default Lark document comment operator denials in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-denial-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "reply" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent({ operator: { openId: "ou_intruder" } }),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(commentClient.createReply).toHaveBeenCalledWith(expect.objectContaining({
        text: "Current operator is not authorized.",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records mentioned Lark document comment turns in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-timeline-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "评论回复" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "turn.started",
          channel: "lark",
          chatId: stableLarkNumericId("lark-comment:doc_token"),
          userId: stableLarkNumericId("user:ou_user"),
          conversationKey: "lark-comment:doc_token",
          metadata: expect.objectContaining({
            larkSurface: "comment",
            fileToken: "doc_token",
            fileType: "docx",
            commentId: "comment_1",
          }),
        }),
        expect.objectContaining({
          type: "turn.completed",
          channel: "lark",
          chatId: stableLarkNumericId("lark-comment:doc_token"),
          userId: stableLarkNumericId("user:ou_user"),
          conversationKey: "lark-comment:doc_token",
          outcome: "success",
          metadata: expect.objectContaining({
            larkSurface: "comment",
            fileToken: "doc_token",
            fileType: "docx",
            commentId: "comment_1",
          }),
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark document comment background task notifications from engine events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-task-notification-"));
    const commentClient = fakeCommentClient({
      getCommentContext: vi.fn(async () => ({
        quote: "需要分析的段落",
        replies: [{
          replyId: "reply_1",
          userId: "ou_user",
          text: "@bot 跑一个后台分析",
          docsLinks: [],
        }],
      })),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "文档后台分析完成。",
        });
        return { text: "评论最终回复" };
      }),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "后台任务完成\n文档后台分析完成。",
      });
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "评论最终回复",
      });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        chatId: stableLarkNumericId("lark-comment:doc_token"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark-comment:doc_token",
        detail: "task_notification",
        metadata: expect.objectContaining({
          larkSurface: "comment",
          fileToken: "doc_token",
          fileType: "docx",
          commentId: "comment_1",
          textChars: "文档后台分析完成。".length,
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replies with an access denial for unauthorized Lark document comment operators", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-deny-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码配对此用户" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.getCommentContext).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "使用配对码配对此用户",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records unauthorized Lark document comment attempts in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-deny-timeline-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码配对此用户" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark-comment:doc_token"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark-comment:doc_token",
        outcome: "denied",
        detail: "access denied",
        metadata: expect.objectContaining({
          larkSurface: "comment",
          fileToken: "doc_token",
          fileType: "docx",
          commentId: "comment_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers generated files from bridge delivery tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-delivery-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const filePath = path.join(outputDir, "report.txt");
    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, "report body");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({ type: "result", text: `Here [send-file:${filePath}]` });
        return { text: `Here [send-file:${filePath}]` };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "make report",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: { source: Buffer.from("report body"), fileName: "report.txt" } },
        { replyTo: "om_1" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        metadata: expect.objectContaining({
          fileName: "report.txt",
          bytes: Buffer.byteLength("report body"),
          via: "post-turn",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to file delivery when Lark image delivery fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-image-fallback-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const imagePath = path.join(outputDir, "cover.png");
    await mkdir(outputDir, { recursive: true });
    await writeFile(imagePath, "image body");
    const channel = fakeChannel({
      send: vi.fn(async (_chatId: string, payload: unknown) => {
        if (payload && typeof payload === "object" && "image" in payload) {
          throw new Error("image upload failed");
        }
        return { messageId: "sent_1" };
      }),
    });

    try {
      await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: `Cover ready [send-image:${imagePath}]`,
        stateDir,
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { image: { source: Buffer.from("image body") } },
        undefined,
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: { source: Buffer.from("image body"), fileName: "cover.png" } },
        undefined,
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        metadata: expect.objectContaining({
          fileName: "cover.png",
          kind: "file",
          fallbackFrom: "image",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records rejected Lark file delivery tags in the timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-delivery-reject-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-outside-"));
    const outsidePath = path.join(outsideDir, "secret.txt");
    await writeFile(outsidePath, "do not send");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: `[tool:{"name":"send.file","payload":{"path":${JSON.stringify(outsidePath)}}}]`,
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_reject_file",
          content: "send outside file",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "文件未发送：路径不在允许目录内。" },
        { replyTo: "om_reject_file" },
      );
      expect(channel.send).not.toHaveBeenCalledWith(
        "oc_chat",
        { file: expect.anything() },
        expect.anything(),
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.rejected",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        outcome: "rejected",
        metadata: expect.objectContaining({
          path: outsidePath,
          reason: "outside-workspace",
          kind: "file",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not preserve misleading Lark delivery claims when a send tool is rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-send-tool-reject-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'Done, file sent.\n[tool:{"name":"send.file","payload":{"path":"/tmp/cctb-lark-missing-report.txt"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_missing_file",
          content: "send missing file",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Done, file sent.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "文件未发送：读取文件失败，详细原因已记录到日志。" },
        { replyTo: "om_missing_file" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not preserve misleading Lark send.batch messages when a batch file is rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-send-batch-reject-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"send.batch","payload":{"message":"All files sent.","files":["/tmp/cctb-lark-missing-batch.txt"]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_missing_batch",
          content: "send missing batch",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("All files sent.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "文件未发送：读取文件失败，详细原因已记录到日志。" },
        { replyTo: "om_missing_batch" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("executes fenced send.batch tool-call blocks in Lark replies", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fenced-batch-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const filePath = path.join(outputDir, "report.txt");
    const imagePath = path.join(outputDir, "plot.png");
    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, "report body");
    await writeFile(imagePath, "image body");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          "```tool-call",
          JSON.stringify({
            name: "send.batch",
            payload: {
              message: "Batch ready.",
              files: [filePath],
              images: [imagePath],
            },
          }),
          "```",
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_fenced_batch",
          content: "send batch",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { image: { source: Buffer.from("image body") } },
        { replyTo: "om_fenced_batch" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: { source: Buffer.from("report body"), fileName: "report.txt" } },
        { replyTo: "om_fenced_batch" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Batch ready." },
        { replyTo: "om_fenced_batch" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown Lark tool tags instead of silently dropping them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-unknown-tool-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'Done.\n[tool:{"name":"send.location","payload":{"lat":1,"lng":2}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_unknown_tool",
          content: "send location",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Done.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：不支持的飞书工具 send.location。" },
        { replyTo: "om_unknown_tool" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid Lark send.file payloads instead of treating them as unknown tools", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invalid-send-file-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'Done.\n[tool:{"name":"send.file","payload":{}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invalid_send_file",
          content: "send invalid file",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Done.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：飞书工具参数无效：send.file 需要 payload.path。" },
        { replyTo: "om_invalid_send_file" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders invalid Lark send.file payload errors in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invalid-send-file-en-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: 'Done.\n[tool:{"name":"send.file","payload":{}}]',
      })),
    };

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invalid_send_file_en",
          content: "send invalid file",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Done.");
      expect(rendered).not.toContain("错误：");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Invalid Lark tool payload: send.file requires payload.path." },
        { replyTo: "om_invalid_send_file_en" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid Lark send.batch array entries instead of silently ignoring them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invalid-send-batch-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"send.batch","payload":{"message":"Batch ready.","files":[123]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invalid_send_batch",
          content: "send invalid batch",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Batch ready.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：飞书工具参数无效：send.batch files 必须是字符串数组。" },
        { replyTo: "om_invalid_send_batch" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid Lark send.batch audio and video arrays", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-invalid-media-batch-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"send.batch","payload":{"message":"Media ready.","audios":["/tmp/a.mp3"],"videos":[42]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_invalid_media_batch",
          content: "send invalid media batch",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("Media ready.");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：飞书工具参数无效：send.batch videos 必须是字符串数组。" },
        { replyTo: "om_invalid_media_batch" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not preserve misleading claims when a Lark tool tag contains malformed JSON", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-malformed-tool-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '9 张图都已发出。\n[tool:{"name":"send.batch","payload":{"message":"Done" "images":["/tmp/a.png"]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_malformed_tool",
          content: "send malformed batch",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("都已发出");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：tool tag JSON 格式无效，未执行。批量文件或长文本请改用 fenced tool-call 代码块。" },
        { replyTo: "om_malformed_tool" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a sanitized error when attachment download fails before the engine starts", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-download-fail-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => {
        throw new Error(`/private/tmp/${path.basename(stateDir)}/download failed`);
      }),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await expect(handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "see file",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      })).resolves.toBe(true);

      expect(runtime.activeRuns.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：准备飞书消息时失败，请稍后重试。" },
        { replyTo: "om_1", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).not.toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports sanitized Lark preparation errors in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-download-fail-en-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => {
        throw new Error(`/private/tmp/${path.basename(stateDir)}/download failed`);
      }),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await expect(handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_1_en",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "see file",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      })).resolves.toBe(true);

      expect(runtime.activeRuns.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Error: failed to prepare the Lark message. Please retry later." },
        { replyTo: "om_1_en", replyInThread: false },
      );
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("错误：");
      expect(rendered).not.toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps engine error details out of user-visible Lark cards", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-engine-error-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        throw new Error(`/Users/tester/.cctb/${path.basename(stateDir)}/engine exploded`);
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      // The sanitized error is shown to the user (in the run card or, when the
      // card is unavailable, as a markdown message) and never leaks raw details.
      const rendered = JSON.stringify([
        ...(channel.send.mock.calls as unknown[][]),
        ...((channel.updateCard?.mock?.calls as unknown[][] | undefined) ?? []),
      ]);
      expect(rendered).toContain("引擎运行失败");
      expect(rendered).not.toContain("/Users/tester");
      expect(rendered).not.toContain("engine exploded");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("marks the Lark card as an idle timeout when the engine turn goes silent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-idle-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        throw new Error("Codex app-server turn became inactive after 15 minutes");
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_idle", content: "do a long task" }),
      });

      const rendered = JSON.stringify([
        ...(channel.send.mock.calls as unknown[][]),
        ...((channel.updateCard?.mock?.calls as unknown[][] | undefined) ?? []),
      ]);
      expect(rendered).toContain("15 分钟无响应");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers rich Lark post and custom interactive card tool tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-rich-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          "plain intro",
          '[tool:{"name":"lark.post","payload":{"post":{"zh_cn":{"title":"周报","content":[[{"tag":"text","text":"重点"}]]}}}}]',
          '[tool:{"name":"lark.card","payload":{"title":"请选择","body":"下一步怎么做？","actions":[{"label":"继续","value":"continue"},{"label":"停止","value":"stop"}]}}]',
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send rich",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.send).toHaveBeenCalledWith("oc_chat", {
        post: {
          zh_cn: {
            title: "周报",
            content: [[{ tag: "text", text: "重点" }]],
          },
        },
      }, { replyTo: "om_1" });
      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const cardCall = sendCalls.find((call) => JSON.stringify(call[1]).includes("下一步怎么做"));
      expect(cardCall?.[1]).toMatchObject({ card: expect.any(Object) });
      expect(JSON.stringify(cardCall?.[1])).toContain("cctb_lark");
      expect(JSON.stringify(cardCall?.[1])).toContain("choice");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders default lark.card labels in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-default-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"actions":[{"value":"continue"}]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_default_card_en",
          content: "send default card",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("Choose");
      expect(rendered).not.toContain("请选择");
      expect(rendered).not.toContain("选择");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders lark.choice as a bridge-managed interactive choice card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-tool-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.choice","payload":{"prompt":"下一步怎么做？","options":[{"label":"继续","value":"continue"},{"label":"改写","value":"rewrite"}]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_choice_tool",
          content: "ask choice",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("下一步怎么做？");
      expect(rendered).toContain("继续");
      expect(rendered).toContain("改写");
      expect(rendered).toContain('"cctb_lark":"choice"');
      expect(rendered).toContain('"conversationKey":"lark:oc_chat"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders request_user_input tool calls as bridge-managed Plan Mode choice cards", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-plan-choice-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          "```tool-call",
          JSON.stringify({
            name: "request_user_input",
            payload: {
              questions: [
                {
                  header: "方向",
                  id: "direction",
                  question: "下一步先做哪条？",
                  options: [
                    {
                      label: "结构性修复",
                      description: "重构卡片 UI 和 Plan Mode 入口，后续都能复用。",
                    },
                    {
                      label: "保守修复",
                      description: "只修当前 bug，最快上线。",
                    },
                  ],
                },
              ],
            },
          }),
          "```",
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_plan_choice",
          content: "plan mode",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("下一步先做哪条？");
      expect(rendered).toContain("A. 结构性修复");
      expect(rendered).toContain("重构卡片 UI");
      expect(rendered).toContain('"content":"选择"');
      expect(rendered).toContain('"cctb_lark":"choice"');
      expect(rendered).toContain('"value":"direction:结构性修复"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders long Lark choices as readable option sections instead of long button labels", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-rich-"));
    const channel = fakeChannel();
    const longLabel = "结构性修复：重构卡片 UI，把说明和按钮拆开，避免按钮文字被截断";
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: `[tool:{"name":"lark.choice","payload":{"title":"请选择执行方向","prompt":"这次更像飞书原生交互。","options":[{"label":"${longLabel}","value":"structured","description":"适合要做成产品级体验；耗时更长，但后续 Plan Mode 和配置卡都能复用。"},{"label":"保守修复","value":"minimal","description":"只修当前问题，最快上线。"}]}}]`,
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_choice_rich",
          content: "ask rich choice",
        }),
      });

      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const card = sendCalls.find((call) => JSON.stringify(call).includes("请选择执行方向"))?.[1];
      const rendered = JSON.stringify(card);
      expect(rendered).toContain("A. 结构性修复");
      expect(rendered).toContain("适合要做成产品级体验");
      expect(rendered).toContain('"content":"选择"');
      expect(rendered).not.toContain(`"content":"${longLabel}"`);
      expect(rendered).toContain('"value":"structured"');
      expect(rendered).toContain('"cctb_lark":"choice"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("decorates raw lark.card buttons so choices route back to the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-raw-card-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"card":{"schema":"2.0","body":{"elements":[{"tag":"button","text":{"tag":"plain_text","content":"批准"},"value":{"id":"approve"}}]}}}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send raw card",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const raw = JSON.stringify(channel.send.mock.calls);
      expect(raw).toContain('"behaviors"');
      expect(raw).toContain('"cctb_lark":"choice"');
      expect(raw).toContain('"conversationKey":"lark:oc_chat"');
      expect(raw).toContain('"id":"approve"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not turn raw Lark open_url buttons into bridge choices", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-open-url-card-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"card":{"schema":"2.0","body":{"elements":[{"tag":"button","text":{"tag":"plain_text","content":"打开文档"},"behaviors":[{"type":"open_url","default_url":"https://example.com/doc"}]}]}}}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_open_url_card",
          content: "send link card",
        }),
      });

      const raw = JSON.stringify(channel.send.mock.calls);
      expect(raw).toContain('"type":"open_url"');
      expect(raw).toContain("https://example.com/doc");
      expect(raw).not.toContain('"cctb_lark":"choice"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("removes deprecated top-level card button values after migrating Lark callback behaviors", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-value-migration-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"card":{"schema":"2.0","body":{"elements":[{"tag":"button","text":{"tag":"plain_text","content":"继续"},"value":{"cctb_lark":"choice","value":"legacy"},"behaviors":[{"type":"callback","value":{"cctb_lark":"choice","value":"modern"}}]}]}}}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_card_value_migration",
          content: "send legacy card",
        }),
      });

      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const cardCall = sendCalls.find((call) => JSON.stringify(call[1]).includes("modern"));
      const button = (((cardCall?.[1] as { card?: any })?.card?.body?.elements?.[0]) ?? {}) as Record<string, unknown>;
      expect(button).not.toHaveProperty("value");
      expect(JSON.stringify(button)).toContain('"behaviors"');
      expect(JSON.stringify(button)).toContain('"value":"modern"');
      expect(JSON.stringify(button)).not.toContain('"value":"legacy"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("decorates Lark card buttons with thread routing when delivered in a thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-thread-card-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"title":"请选择","actions":[{"label":"继续","value":"continue"}]}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_thread_card",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          mentionedBot: true,
          content: "send card",
        }),
      });

      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const cardCall = sendCalls.find((call) => JSON.stringify(call[1]).includes("请选择"));
      const cardJson = JSON.stringify(cardCall?.[1]);
      expect(cardJson).toContain('"conversationKey":"lark:oc_group:omt_topic"');
      expect(cardJson).toContain('"replyInThread":true');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers audio and video tool tags through Lark media payloads", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-media-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const audioPath = path.join(outputDir, "clip.mp3");
    const videoPath = path.join(outputDir, "clip.mp4");
    await mkdir(outputDir, { recursive: true });
    await writeFile(audioPath, "audio body");
    await writeFile(videoPath, "video body");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          `[tool:{"name":"send.audio","payload":{"path":"${audioPath}"}}]`,
          `[tool:{"name":"send.video","payload":{"path":"${videoPath}"}}]`,
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send media",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { audio: { source: Buffer.from("audio body"), fileName: "clip.mp3" } },
        { replyTo: "om_1" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { video: { source: Buffer.from("video body"), fileName: "clip.mp4" } },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers whole-response file fenced blocks as Lark files", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fenced-file-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: "```file:notes.txt\nhello from fenced file\n```",
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_file_block",
          content: "make a small file",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith("oc_chat", {
        file: {
          source: Buffer.from("hello from fenced file\n", "utf8"),
          fileName: "notes.txt",
        },
      }, { replyTo: "om_file_block" });
      expect(channel.send).not.toHaveBeenCalledWith("oc_chat", {
        markdown: expect.stringContaining("```file:notes.txt"),
      }, expect.anything());
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        metadata: expect.objectContaining({
          fileName: "notes.txt",
          bytes: Buffer.byteLength("hello from fenced file\n"),
          kind: "file",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("cleans up transient Lark attachment downloads after the turn finishes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-attachment-cleanup-"));
    const downloadedPath = path.join(stateDir, "workspace", ".lark-files", "om_cleanup", "input", "report.txt");
    let engineSawDownloadedFile = false;
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => Buffer.from("report body")),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: { files: string[] }) => {
        engineSawDownloadedFile = (await readFile(input.files[0]!, "utf8")) === "report body";
        return { text: "done" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cleanup",
          content: "read this",
          resources: [{ type: "file", fileKey: "file_1", fileName: "report.txt" }],
        }),
      });

      expect(engineSawDownloadedFile).toBe(true);
      await expect(readFile(downloadedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark turns in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-timeline-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "input.received",
          channel: "lark",
          conversationKey: "lark:oc_chat",
        }),
        expect.objectContaining({
          type: "turn.started",
          channel: "lark",
          conversationKey: "lark:oc_chat",
          metadata: expect.objectContaining({
            larkMessageId: "om_1",
            phase: "queued-job",
          }),
        }),
        expect.objectContaining({
          type: "turn.completed",
          channel: "lark",
          conversationKey: "lark:oc_chat",
          outcome: "success",
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records skipped queued Lark messages in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-message-skipped-"));
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, _job: () => Promise<T>, options?: {
        onSkipped?: () => T | Promise<T>;
      }): Promise<T> => {
        return options?.onSkipped ? await options.onSkipped() : undefined as T;
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_skipped", content: "hello" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "已跳过排队中的任务。" },
        { replyTo: "om_skipped", replyInThread: false },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: expect.objectContaining({
          phase: "queue",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("notifies Lark users when a message waits in the conversation queue", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-message-queue-wait-"));
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, job: () => Promise<T>, options?: {
        onWait?: (event: { chatId: string | number; waitedMs: number; reason: string }) => void | Promise<void>;
      }): Promise<T> => {
        await options?.onWait?.({
          chatId: "lark:oc_chat",
          waitedMs: 10_500,
          reason: "conversation_queue",
        });
        return await job();
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "Done after queue" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_waiting", content: "hello" }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        expect.objectContaining({ card: expect.any(Object) }),
        { replyTo: "om_waiting" },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("取消此排队任务");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.lock.waiting",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        detail: "waiting for Lark conversation queue",
        metadata: expect.objectContaining({
          waitedMs: 10_500,
          reason: "conversation_queue",
          larkChatId: "oc_chat",
          larkMessageId: "om_waiting",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not render a wait card for a task already cancelled from its card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-queue-wait-cancelled-"));
    const runtime = createLarkServiceRuntime();
    runtime.cancelledQueueTaskIds.add("om_waiting_cancelled"); // user already tapped "cancel queue"
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, job: () => Promise<T>, options?: {
        onWait?: (event: { chatId: string | number; waitedMs: number; reason: string }) => void | Promise<void>;
      }): Promise<T> => {
        await options?.onWait?.({ chatId: "lark:oc_chat", waitedMs: 10_500, reason: "conversation_queue" });
        return await job();
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })) };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_waiting_cancelled", content: "hello" }),
      });
      // The cancelled task's wait notification must be suppressed — otherwise it
      // would overwrite the "cancelled" card back to "queued" (flicker-then-revert).
      // (updateCard may still be used by the run card; only the queue-wait render
      // must be skipped, which the guard does before any card/timeline work.)
      expect(JSON.stringify(channel.send.mock.calls)).not.toContain("取消此排队任务");
      const timelineRaw = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8").catch(() => "");
      expect(timelineRaw).not.toContain("waiting for Lark conversation queue");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues an already queued Lark message after the active engine turn fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-queue-after-error-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    let rejectFirst!: (error: Error) => void;
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        if (bridge.handleAuthorizedMessage.mock.calls.length === 1) {
          await new Promise<never>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return { text: "second done" };
      }),
    };

    try {
      const first = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_active", content: "first" }),
      });
      await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
      const second = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_queued", content: "second" }),
      });

      rejectFirst(new Error("active turn failed"));

      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
      expectLarkFinalAnswer(channel, "second done");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "turn.completed",
          outcome: "error",
          metadata: expect.objectContaining({ larkMessageId: "om_active" }),
        }),
        expect.objectContaining({
          type: "turn.completed",
          outcome: "success",
          metadata: expect.objectContaining({ larkMessageId: "om_queued" }),
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("updates a native Lark run card while the engine is streaming events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-run-card-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge: LarkBridgeLike = {
      handleAuthorizedMessage: vi.fn(async (input) => {
        await Promise.resolve(input.onEngineEvent?.({ type: "thinking", text: "checking the repo" }));
        await Promise.resolve(input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolInput: { file_path: "README.md" }, toolUseId: "tu1" }));
        await Promise.resolve(input.onEngineEvent?.({ type: "tool_result", toolUseId: "tu1", output: "readme body" }));
        await Promise.resolve(input.onEngineEvent?.({ type: "assistant_text", text: "final answer" }));
        await Promise.resolve(input.onEngineEvent?.({ type: "result", text: "final answer" }));
        return { text: "final answer" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_run_card", content: "please work" }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        expect.objectContaining({ card: expect.any(Object) }),
        { replyTo: "om_run_card" },
      );
      expect(channel.updateCard).toHaveBeenCalledWith("sent_1", expect.any(Object));
      const updates = JSON.stringify(channel.updateCard.mock.calls);
      // Live updates are throttled (coalesced), so a fast synchronous burst lands
      // as the finalized card: answer prominent, process (thinking + tool names)
      // folded into the condensed panel; verbose tool output is dropped.
      expect(updates).toContain("final answer");
      expect(updates).toContain("checking the repo");
      expect(updates).toContain("Read");
      expect(updates).not.toContain("readme body");
      // Throttling coalesces the burst: far fewer patches than engine events.
      expect(channel.updateCard.mock.calls.length).toBeLessThanOrEqual(2);
      // Card is canonical: the final answer must NOT also be sent as a separate
      // markdown message when the run card is active.
      const markdownSends = channel.send.mock.calls.filter((call: unknown[]) => {
        const payload = call[1] as { markdown?: string } | undefined;
        return typeof payload?.markdown === "string" && payload.markdown.includes("final answer");
      });
      expect(markdownSends).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers the answer even when run-card updates always fail (no frozen card)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-run-card-fail-"));
    // Simulate Feishu rejecting every patch (e.g. an oversized card): the final
    // answer must NOT be swallowed — it should arrive as a text fallback.
    const channel = fakeChannel({
      updateCard: vi.fn(async () => { throw new Error("card too large"); }),
    });
    const runtime = createLarkServiceRuntime();
    const bridge: LarkBridgeLike = {
      handleAuthorizedMessage: vi.fn(async (input) => {
        await Promise.resolve(input.onEngineEvent?.({ type: "assistant_text", text: "the final answer" }));
        return { text: "the final answer" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fail_card", content: "do work" }),
      });

      // The card could never render, so the answer must arrive as a separate
      // message (text or markdown) instead of being swallowed or frozen in-card.
      const answerSends = channel.send.mock.calls.filter((call: unknown[]) => {
        const payload = call[1] as { text?: string; markdown?: string } | undefined;
        return (typeof payload?.text === "string" && payload.text.includes("the final answer"))
          || (typeof payload?.markdown === "string" && payload.markdown.includes("the final answer"));
      });
      expect(answerSends.length).toBeGreaterThan(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate a normal-length answer as text when the run card renders it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-ok-"));
    const channel = fakeChannel(); // updateCard succeeds
    const runtime = createLarkServiceRuntime();
    const bridge: LarkBridgeLike = {
      handleAuthorizedMessage: vi.fn(async (input) => {
        await Promise.resolve(input.onEngineEvent?.({ type: "assistant_text", text: "short answer XYZ" }));
        return { text: "short answer XYZ" };
      }),
    };

    try {
      await handleLarkMessage({
        channel, bridge, runtime, stateDir,
        message: fakeLarkMessage({ messageId: "om_ok_card", content: "do work" }),
      });

      // The answer lives in the card (via updateCard); it must NOT also be sent
      // as a separate text/markdown message (that was the duplicate bug).
      const answerSends = channel.send.mock.calls.filter((call: unknown[]) => {
        const p = call[1] as { text?: string; markdown?: string } | undefined;
        return (typeof p?.text === "string" && p.text.includes("short answer XYZ"))
          || (typeof p?.markdown === "string" && p.markdown.includes("short answer XYZ"));
      });
      expect(answerSends.length).toBe(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers the full answer as a message when it is too long for the run card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-long-"));
    const channel = fakeChannel(); // updateCard succeeds, but the answer exceeds the card element cap
    const runtime = createLarkServiceRuntime();
    const longAnswer = `LONGMARKER ${"好".repeat(6000)}`;
    const bridge: LarkBridgeLike = {
      handleAuthorizedMessage: vi.fn(async (input) => {
        await Promise.resolve(input.onEngineEvent?.({ type: "assistant_text", text: longAnswer }));
        return { text: longAnswer };
      }),
    };

    try {
      await handleLarkMessage({
        channel, bridge, runtime, stateDir,
        message: fakeLarkMessage({ messageId: "om_long_card", content: "do work" }),
      });

      // The card only holds a truncated preview, so the full answer must arrive
      // as a separate message (identified by its marker).
      const answerSends = channel.send.mock.calls.filter((call: unknown[]) => {
        const p = call[1] as { text?: string; markdown?: string } | undefined;
        return (typeof p?.text === "string" && p.text.includes("LONGMARKER"))
          || (typeof p?.markdown === "string" && p.markdown.includes("LONGMARKER"));
      });
      expect(answerSends.length).toBeGreaterThan(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark conversation queue waits as stop-capable cards", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-queue-card-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, job: () => Promise<T>, options?: {
        onWait?: (event: { chatId: string | number; waitedMs: number; reason: "conversation_queue" }) => void | Promise<void>;
      }): Promise<T> => {
        await options?.onWait?.({ chatId: "lark:oc_chat", waitedMs: 10_000, reason: "conversation_queue" });
        return await job();
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_wait_card", content: "second" }),
      });

      const sent = JSON.stringify(channel.send.mock.calls);
      expect(sent).toContain("正在排队");
      expect(sent).toContain("stop");
      expect(sent).toContain("conversationKey");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reuses the queued card as the run card instead of leaving it stale", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-queue-reuse-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, job: () => Promise<T>, options?: {
        onWait?: (event: { chatId: string | number; waitedMs: number; reason: "conversation_queue" }) => void | Promise<void>;
      }): Promise<T> => {
        await options?.onWait?.({ chatId: "lark:oc_chat", waitedMs: 10_000, reason: "conversation_queue" });
        return await job();
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const bridge: LarkBridgeLike = {
      handleAuthorizedMessage: vi.fn(async (input) => {
        await Promise.resolve(input.onEngineEvent?.({ type: "assistant_text", text: "answer text" }));
        return { text: "answer text" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_reuse", content: "go" }),
      });

      // The queued card (sent as "sent_1") is taken over by the run card via
      // updateCard — not orphaned, and no second card is sent.
      expect(channel.updateCard).toHaveBeenCalledWith("sent_1", expect.any(Object));
      expect(JSON.stringify(channel.updateCard.mock.calls)).toContain("answer text");
      const cardSends = channel.send.mock.calls.filter((call: unknown[]) => Boolean((call[1] as { card?: unknown } | undefined)?.card));
      expect(cardSends).toHaveLength(1); // only the queued card was *sent*
      expect(runtime.queueCards.size).toBe(0); // no stale queued-card id left behind
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("gives each queued task its own card (keyed by message id, not shared)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-queue-multi-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    // Stub the queue so each task fires its wait notification but stays "queued"
    // (job not run), letting us inspect how its card is keyed.
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, _job: () => Promise<T>, options?: {
        onWait?: (event: { chatId: string | number; waitedMs: number; reason: "conversation_queue" }) => void | Promise<void>;
      }): Promise<T> => {
        await options?.onWait?.({ chatId: "lark:oc_chat", waitedMs: 10_000, reason: "conversation_queue" });
        return true as unknown as T;
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const bridge: LarkBridgeLike = { handleAuthorizedMessage: vi.fn(async () => ({ text: "x" })) };

    try {
      await handleLarkMessage({ channel, bridge, runtime, stateDir, message: fakeLarkMessage({ messageId: "om_q1", content: "first" }) });
      await handleLarkMessage({ channel, bridge, runtime, stateDir, message: fakeLarkMessage({ messageId: "om_q2", content: "second" }) });

      // Two queued tasks → two distinct cards, keyed by their message ids — not
      // a single card keyed by conversationKey (which they would have shared).
      expect(runtime.queueCards.has("om_q1")).toBe(true);
      expect(runtime.queueCards.has("om_q2")).toBe(true);
      expect(runtime.queueCards.has("lark:oc_chat")).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preempts an active Lark turn only when the optional queue policy enables it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-preempt-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime({
      queuePolicy: { preempt: true, batchWindowMs: 0 },
    });
    const activeController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: activeController });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "new answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_preempt", content: "replace the active run" }),
      });

      expect(activeController.signal.aborted).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps the default Lark queue policy conservative", async () => {
    const runtime = createLarkServiceRuntime();
    expect(runtime.queuePolicy).toEqual({ preempt: false, batchWindowMs: 0 });
  });

  it("optionally batches dense Lark text messages before entering the conservative queue", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-batch-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime({
      queuePolicy: { preempt: false, batchWindowMs: 25 },
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "batched answer" })),
    };

    try {
      const first = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_batch_1", content: "first dense message" }),
      });
      const second = handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_batch_2", content: "second dense message" }),
      });

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const batchText = (bridge.handleAuthorizedMessage.mock.calls[0] as unknown as [{ text: string }])[0].text;
      expect(batchText).toContain("#1");
      expect(batchText).toContain("first dense message");
      expect(batchText).toContain("#2");
      expect(batchText).toContain("second dense message");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("manages Lark workspace profiles with /ws commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-ws-"));
    const workspacePath = path.join(stateDir, "workspaces", "demo");
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ws_save", content: `/ws save demo ${workspacePath}` }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ws_use", content: "/ws use demo" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ws_list", content: "/ws list" }),
      });

      const cfg = await loadInstanceConfig(stateDir);
      expect(cfg.workspacePath).toBe(workspacePath);
      expect(cfg.workspaceProfiles).toEqual([
        expect.objectContaining({ name: "demo", path: workspacePath }),
      ]);
      const replies = JSON.stringify(channel.send.mock.calls);
      expect(replies).toContain("demo");
      expect(replies).toContain(workspacePath);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders skipped queued Lark messages in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-message-skipped-en-"));
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, _job: () => Promise<T>, options?: {
        onSkipped?: () => T | Promise<T>;
      }): Promise<T> => {
        return options?.onSkipped ? await options.onSkipped() : undefined as T;
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_skipped_en", content: "hello" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Queued task skipped." },
        { replyTo: "om_skipped_en", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates Feishu docs from lark.doc.create tool tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-doc-"));
    const runtime = createLarkServiceRuntime({
      createDocument: vi.fn(async () => ({
        title: "Spec",
        url: "https://example.feishu.cn/docx/doc_1",
        documentId: "doc_1",
        warning: "permission_grant=skipped no current user",
      })),
    });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\\n\\n正文","docFormat":"markdown"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "write spec",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(runtime.createDocument).toHaveBeenCalledWith(expect.objectContaining({
        title: "Spec",
        content: "# Spec\n\n正文",
        docFormat: "markdown",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("permission_grant=skipped no current user") },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sanitizes Lark tool execution errors before replying to users", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-tool-error-"));
    const runtime = createLarkServiceRuntime({
      createDocument: vi.fn(async () => {
        throw new Error(`lark-cli failed in ${stateDir} with Authorization: Bearer leaked-token and app_secret=secret-personal`);
      }),
    });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec","docFormat":"markdown"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_doc_fail",
          content: "write spec",
        }),
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：飞书工具执行失败，详细原因已记录到日志。" },
        { replyTo: "om_doc_fail" },
      );
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain(stateDir);
      expect(rendered).not.toContain("leaked-token");
      expect(rendered).not.toContain("secret-personal");

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.error",
        channel: "lark",
        detail: expect.stringContaining("[redacted]"),
        metadata: expect.objectContaining({ tool: "lark.doc.create" }),
      }));
      expect(JSON.stringify(timeline)).not.toContain("leaked-token");
      expect(JSON.stringify(timeline)).not.toContain("secret-personal");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sanitizes Lark engine errors before writing timeline details", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-engine-error-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        throw new Error("engine failed with Authorization: Bearer leaked-token and app_secret=secret-personal");
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_engine_fail",
          content: "run this",
        }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("leaked-token");
      expect(rendered).not.toContain("secret-personal");

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        outcome: "error",
        detail: "engine failed with Authorization: Bearer [redacted] and app_secret=[redacted]",
      }));
      expect(JSON.stringify(timeline)).not.toContain("leaked-token");
      expect(JSON.stringify(timeline)).not.toContain("secret-personal");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the installed lark-cli docs +create flags for Feishu document creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-"));
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "args.json");
    const contentLogPath = path.join(tempDir, "content.txt");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const path = require('node:path');",
      "const { readFileSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "const contentIndex = process.argv.indexOf('--content');",
      "const contentArg = contentIndex === -1 ? '' : process.argv[contentIndex + 1];",
      "if (contentArg?.startsWith('@') && path.isAbsolute(contentArg.slice(1))) { throw new Error('absolute @file path rejected'); }",
      `if (contentArg?.startsWith('@')) writeFileSync(${JSON.stringify(contentLogPath)}, readFileSync(path.resolve(process.cwd(), contentArg.slice(1)), 'utf8'));`,
      "if (process.env.LARK_CHANNEL !== '1') { throw new Error('missing lark-channel env'); }",
      "console.log(JSON.stringify({ ok: true, data: { document: { title: 'Spec', url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' }, permission_grant: { status: 'skipped', message: 'no current user' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const created = await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];

      expect(created.url).toBe("https://example.feishu.cn/docx/doc_1");
      expect(created.warning).toContain("permission_grant=skipped");
      expect(created.warning).toContain("no current user");
      expect(args.slice(args.indexOf("--api-version"), args.indexOf("--api-version") + 2)).toEqual(["--api-version", "v2"]);
      expect(args.slice(args.indexOf("--as"), args.indexOf("--as") + 2)).toEqual(["--as", "bot"]);
      expect(args).toContain("--title");
      expect(args).toContain("Spec");
      expect(args).not.toContain("--markdown");
      expect(args).toContain("--content");
      expect(args.slice(args.indexOf("--doc-format"), args.indexOf("--doc-format") + 2)).toEqual(["--doc-format", "markdown"]);
      expect(args).not.toContain("--format");
      const contentArg = args[args.indexOf("--content") + 1]!;
      expect(contentArg).toBe("@content.md");
      await expect(readFile(contentLogPath, "utf8")).resolves.toBe("正文");
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses lark-cli im +chat-create for Lark /newgroup creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-chat-"));
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "args.json");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "if (process.env.LARK_CHANNEL !== '1') { throw new Error('missing lark-channel env'); }",
      "console.log(JSON.stringify({ ok: true, data: { chat: { chat_id: 'oc_new', name: '新项目', share_link: 'https://example.feishu.cn/chat/oc_new' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const created = await createLarkChatWithCli({
        name: "新项目",
        mode: "topic",
        operatorOpenId: "ou_user",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];

      expect(created).toEqual({
        chatId: "oc_new",
        name: "新项目",
        shareLink: "https://example.feishu.cn/chat/oc_new",
      });
      expect(args).toContain("im");
      expect(args).toContain("+chat-create");
      expect(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2)).toEqual(["--name", "新项目"]);
      expect(args.slice(args.indexOf("--chat-mode"), args.indexOf("--chat-mode") + 2)).toEqual(["--chat-mode", "topic"]);
      expect(args.slice(args.indexOf("--as"), args.indexOf("--as") + 2)).toEqual(["--as", "bot"]);
      expect(args.slice(args.indexOf("--users"), args.indexOf("--users") + 2)).toEqual(["--users", "ou_user"]);
      // The human operator becomes the group OWNER (so they can change the
      // message form 话题/对话); the bot stays a manager.
      expect(args.slice(args.indexOf("--owner"), args.indexOf("--owner") + 2)).toEqual(["--owner", "ou_user"]);
      expect(args).toContain("--set-bot-manager");
      expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 2)).toEqual(["--format", "json"]);
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("invites the requesting user when Lark /newgroup uses user identity", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-chat-user-"));
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "args.json");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    const originalAs = process.env.CCTB_LARK_CHAT_CREATE_AS;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "console.log(JSON.stringify({ ok: true, data: { chat: { chat_id: 'oc_user_new', name: '用户身份群' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CCTB_LARK_CHAT_CREATE_AS = "user";

    try {
      const created = await createLarkChatWithCli({
        name: "用户身份群",
        mode: "group",
        operatorOpenId: "ou_requester",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];

      expect(created.chatId).toBe("oc_user_new");
      expect(args.slice(args.indexOf("--as"), args.indexOf("--as") + 2)).toEqual(["--as", "user"]);
      expect(args.slice(args.indexOf("--users"), args.indexOf("--users") + 2)).toEqual(["--users", "ou_requester"]);
      expect(args).not.toContain("--set-bot-manager");
      // On the user-identity path the owner defaults to the authorizing user;
      // we must NOT pass --owner with the bot-namespace open_id.
      expect(args).not.toContain("--owner");
    } finally {
      process.env.PATH = originalPath;
      if (originalAs === undefined) {
        delete process.env.CCTB_LARK_CHAT_CREATE_AS;
      } else {
        process.env.CCTB_LARK_CHAT_CREATE_AS = originalAs;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows explicitly opting Lark document creation back into local user identity", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-as-user-"));
    const binDir = path.join(tempDir, "bin");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const logPath = path.join(tempDir, "args.json");
    const originalPath = process.env.PATH;
    const originalAs = process.env.CCTB_LARK_DOC_CREATE_AS;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "console.log(JSON.stringify({ ok: true, data: { document: { title: 'Spec', url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.CCTB_LARK_DOC_CREATE_AS = "user";

    try {
      await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];
      expect(args.slice(args.indexOf("--as"), args.indexOf("--as") + 2)).toEqual(["--as", "user"]);
    } finally {
      process.env.PATH = originalPath;
      if (originalAs === undefined) {
        delete process.env.CCTB_LARK_DOC_CREATE_AS;
      } else {
        process.env.CCTB_LARK_DOC_CREATE_AS = originalAs;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses lark-cli document JSON even when stdout has a banner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-banner-"));
    const binDir = path.join(tempDir, "bin");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "console.log('=== Lark CLI ===');",
      "console.log(JSON.stringify({ ok: true, data: { document: { title: 'Spec', url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const created = await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
      });

      expect(created.documentId).toBe("doc_1");
      expect(created.url).toBe("https://example.feishu.cn/docx/doc_1");
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes parentPosition through to the installed lark-cli", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-parent-position-"));
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "args.json");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "console.log(JSON.stringify({ ok: true, data: { document: { url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
        parentPosition: "after:doc_1",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];
      expect(args.slice(args.indexOf("--parent-position"), args.indexOf("--parent-position") + 2)).toEqual(["--parent-position", "after:doc_1"]);
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects Lark numeric id collisions before access state can be shared", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-id-collision-"));
    const bridgeChatId = stableLarkNumericId("lark:oc_chat");
    await writeFile(path.join(stateDir, "lark-chat-id-map.json"), JSON.stringify({
      [String(bridgeChatId)]: "chat:lark:other_chat",
    }));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await expect(handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      })).rejects.toThrow("Lark chat numeric ID collision");

      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("feeds interactive card choices back into the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; locale?: string; conversationKey?: string }) => ({ text: "choice handled" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "choice handled" },
        { replyTo: "card_1" },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("continue"),
        requestOutputDir: expect.stringContaining(".lark-out"),
        onApprovalRequest: expect.any(Function),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into interactive card choice turns", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; locale?: string; conversationKey?: string }) => ({ text: "choice handled" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "Continue",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("The user clicked a Lark card button: Continue"),
      }));
      const bridgeText = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(bridgeText).not.toContain("用户点击了飞书卡片按钮");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers Lark card choice background task notifications from engine events", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-task-notification-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "卡片后台任务完成。",
        });
        return { text: "choice handled" };
      }),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "后台任务完成\n卡片后台任务完成。" },
        { replyTo: "card_1" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "choice handled" },
        { replyTo: "card_1" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        detail: "task_notification",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "choice",
          textChars: "卡片后台任务完成。".length,
          larkChatId: "oc_chat",
          larkMessageId: "card_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark card choice turns in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-timeline-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "choice handled" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "turn.started",
          channel: "lark",
          chatId: stableLarkNumericId("lark:oc_chat"),
          userId: stableLarkNumericId("user:ou_user"),
          conversationKey: "lark:oc_chat",
          metadata: expect.objectContaining({
            source: "card_action",
            action: "choice",
            larkChatId: "oc_chat",
            larkMessageId: "card_1",
            bridgeChatType: "private",
          }),
        }),
        expect.objectContaining({
          type: "turn.completed",
          channel: "lark",
          chatId: stableLarkNumericId("lark:oc_chat"),
          userId: stableLarkNumericId("user:ou_user"),
          conversationKey: "lark:oc_chat",
          outcome: "success",
          metadata: expect.objectContaining({
            source: "card_action",
            action: "choice",
            responseChars: "choice handled".length,
          }),
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark card choice tool errors with chat, user, and message metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-tool-error-"));
    const runtime = createLarkServiceRuntime({
      createDocument: vi.fn(async () => {
        throw new Error("lark doc failed");
      }),
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec","docFormat":"markdown"}}]',
      })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：飞书工具执行失败，详细原因已记录到日志。" },
        { replyTo: "card_1" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "service.error",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        metadata: expect.objectContaining({
          phase: "tool",
          tool: "lark.doc.create",
          larkChatId: "oc_chat",
          larkMessageId: "card_1",
          bridgeChatType: "private",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps interactive card choice responses inside the originating thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-thread-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "choice handled" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_group",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_group:omt_topic",
              bridgeChatType: "group",
              replyInThread: true,
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { markdown: "choice handled" },
        { replyTo: "card_1", replyInThread: true },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark:oc_group:omt_topic",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports skipped Lark card choices when the conversation queue is cleared", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-skipped-"));
    const runtime = createLarkServiceRuntime();
    const enqueueSpy = vi.fn();
    runtime.chatQueue = {
      enqueue: async <T,>(conversationKey: string | number, job: () => Promise<T>, options?: {
        onSkipped?: () => T | Promise<T>;
      }): Promise<T> => {
        enqueueSpy(conversationKey, job, options);
        return options?.onSkipped ? await options.onSkipped() : undefined as T;
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "choice handled" })),
    };

    try {
      await expect(handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      })).resolves.toBe(true);

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledWith("lark:oc_chat", expect.any(Function), expect.objectContaining({
        onSkipped: expect.any(Function),
      }));
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已跳过排队中的任务。" }, { replyTo: "card_1" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "choice",
          larkChatId: "oc_chat",
          larkMessageId: "card_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records skipped Lark archive continuation card actions in the timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-skipped-"));
    const runtime = createLarkServiceRuntime();
    runtime.chatQueue = {
      enqueue: async <T,>(_conversationKey: string | number, _job: () => Promise<T>, options?: {
        onSkipped?: () => T | Promise<T>;
      }): Promise<T> => {
        return options?.onSkipped ? await options.onSkipped() : undefined as T;
      },
      clearPending: vi.fn(),
      isBusy: vi.fn(),
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await expect(handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_archive",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "continue_archive",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              uploadId: "upload_1",
            },
          },
        },
      })).resolves.toBe(true);

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已跳过排队中的任务。" }, { replyTo: "card_archive" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "continue_archive",
          larkChatId: "oc_chat",
          larkMessageId: "card_archive",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark card choices before running the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-denied-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "card_1" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "choice",
          larkChatId: "oc_chat",
          larkMessageId: "card_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replies with single-chat lock card-action access denials for Lark private chats", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-single-chat-sibling-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({
        kind: "reply" as const,
        text: "此实例已锁定到另一个聊天。",
        reason: "single_chat_locked" as const,
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_sibling_lock",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "此实例已锁定到另一个聊天。" },
        { replyTo: "card_sibling_lock" },
      );
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes the configured Lark locale into card action access checks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-access-locale-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "deny" as const, text: "not authorized" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_intruder", name: "Intruder" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en",
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("applies Lark config card actions after access checks and refreshes the card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-action-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      model: "gpt-5.4",
      locale: "zh",
    }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-05-26T00:00:00.000Z",
    });
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_config",
          operator: { openId: "ou_user", name: "User" },
          action: {
            value: {
              cctb_lark: "config",
              action: "engine",
              value: "antigravity",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const config = await loadInstanceConfig(stateDir);
      expect(config.engine).toBe("antigravity");
      expect(config.model).toBeUndefined();
      expect(await sessionStore.findByConversationKey("lark:oc_chat")).toBeNull();
      expect(channel.updateCard).toHaveBeenCalledWith("card_config", expect.any(Object));
      expect(JSON.stringify(channel.updateCard.mock.calls)).toContain("已更新");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        outcome: "success",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "config",
          configAction: "engine",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("applies Lark config form submissions after access checks", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-form-action-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      locale: "zh",
      codexServiceTier: "fast",
      approvalMode: "full-auto",
    }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_config_form",
          operator: { openId: "ou_user", name: "User" },
          action: {
            value: {
              cctb_lark: "config",
              action: "submit",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
            form_value: {
              engine: "claude",
              fast: "off",
              yolo: "off",
              locale: "en",
            },
          },
        },
      });

      const config = await loadInstanceConfig(stateDir);
      const rawConfig = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(handled).toBe(true);
      expect(config.engine).toBe("claude");
      expect(config.locale).toBe("en");
      expect(rawConfig.approvalMode).toBe("normal");
      expect(config.codexServiceTier).toBeUndefined();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.updateCard).toHaveBeenCalledWith("card_config_form", expect.any(Object));
      expect(JSON.stringify(channel.updateCard.mock.calls)).toContain("Saved");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps Lark group config unchanged when submitting the config form without a group change", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-form-group-keep-"));
    const groupChatId = stableLarkNumericId("lark:oc_group");
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      locale: "zh",
      groupMode: {
        enabled: true,
        allowedChatIds: [groupChatId],
        listenAllChatIds: [groupChatId],
      },
    }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        requireMentionInGroup: true,
        message: fakeLarkMessage({
          messageId: "om_config_group_keep",
          chatId: "oc_group",
          chatType: "group",
          mentionedBot: true,
          content: "/config",
        }),
      });

      let rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain('"name":"group","initial_option":"keep"');
      expect(rendered).toContain("保持当前群聊设置");

      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_group",
          messageId: "card_config_group_keep",
          operator: { openId: "ou_user", name: "User" },
          action: {
            value: {
              cctb_lark: "config",
              action: "submit",
              conversationKey: "lark:oc_group",
              bridgeChatType: "group",
              larkChatId: "oc_group",
            },
            form_value: {
              engine: "codex",
              fast: "off",
              yolo: "unsafe",
              locale: "zh",
              group: "keep",
            },
          },
        },
      });

      const config = await loadInstanceConfig(stateDir);
      expect(handled).toBe(true);
      expect(config.groupMode.allowedChatIds).toContain(groupChatId);
      expect(config.groupMode.listenAllChatIds).toContain(groupChatId);
      rendered = JSON.stringify(channel.updateCard.mock.calls);
      expect(rendered).not.toContain("无效的群聊设置");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes a Claude session from a Lark resume card button", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-card-action-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_resume",
          operator: { openId: "ou_user", name: "User" },
          action: {
            value: {
              cctb_lark: "resume",
              engine: "claude",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              sessionId: "claude-session-card",
              dirName: "-Users-cloveric-projects-demo",
              displayName: "demo",
              workspacePath: "/Users/cloveric/projects/demo",
            },
          },
        },
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      const config = await loadInstanceConfig(stateDir);
      expect(handled).toBe(true);
      expect(record?.codexSessionId).toBe("claude-session-card");
      expect(config.resume).toMatchObject({
        sessionId: "claude-session-card",
        workspacePath: "/Users/cloveric/projects/demo",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: expect.stringContaining("已恢复 session：demo") },
        { replyTo: "card_resume" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark config card actions without changing config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-action-denied-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_config_denied",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "config",
              action: "engine",
              value: "claude",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect((await loadInstanceConfig(stateDir)).engine).toBe("codex");
      expect(channel.updateCard).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "card_config_denied" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders default Lark card action operator denials in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-card-denial-en-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_denial_en",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(abortController.signal.aborted).toBe(false);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Current operator is not authorized." },
        { replyTo: "card_denial_en" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark stop actions", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-denied-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(abortController.signal.aborted).toBe(false);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "card_1" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "stop",
          larkChatId: "oc_chat",
          larkMessageId: "card_1",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves approval card actions", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "approval", requestId, decision: "allow_session" },
        },
      },
    });

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
  });

  it("renders AskUserQuestion as one native form (no per-tap toggling)", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            { question: "Which mode?", header: "Mode", multiSelect: false, options: [{ label: "Fast" }, { label: "Careful" }] },
            { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
          ],
        },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    const payload = JSON.stringify((channel.send.mock.calls[0] as unknown[])?.[1]);
    expect(payload).toContain('"tag":"form"');
    expect(payload).toContain('"select_static"');       // single-select question
    expect(payload).toContain('"multi_select_static"');  // multiSelect question
    expect(payload).toContain('"action":"form_submit"');
    // Each question has a free-text "Other" input; not Feishu-`required` because
    // the Other value is a valid alternative (enforced by the submit backstop).
    expect(payload).toContain('"tag":"input"');
    expect(payload).toContain("q0_other");
    expect(payload).toContain("q1_other");
    expect(payload).not.toContain("collapsible_panel");
    expect(payload).not.toContain('"action":"toggle"');

    // Resolve via submit so the dangling approval (no abortSignal) settles.
    await handleLarkCardAction({
      channel, runtime,
      event: { chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: { q0: "Fast", q1: ["A"] } } },
    });
    await pending.catch(() => undefined);
  });

  it("resolves every AskUserQuestion answer from a single form submit", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            { question: "Which mode should we use?", header: "Mode", multiSelect: false,
              options: [{ label: "Fast", description: "Finish quickly" }, { label: "Careful", description: "Check more" }] },
            { question: "Which features?", header: "Features", multiSelect: true,
              options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }] },
          ],
        },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel, runtime,
      event: {
        chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "ask_user_question", action: "form_submit", requestId },
          form_value: { q0: "Careful", q1: ["Alpha", "Gamma"] },
        },
      },
    });

    const resolved = await pending as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(resolved.behavior).toBe("allow");
    expect(resolved.updatedInput.answers).toEqual({
      "Which mode should we use?": "Careful",
      "Which features?": "Alpha, Gamma",
    });
    expect(runtime.pendingApprovals.size).toBe(0);
  });

  it("parses a multi-select form value delivered as a JSON string", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: { questions: [{ question: "Pick", header: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel, runtime,
      event: {
        chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: { q0: '["A","C"]' } },
      },
    });

    const resolved = await pending as { updatedInput: { answers: Record<string, string> } };
    expect(resolved.updatedInput.answers).toEqual({ "Pick": "A, C" });
  });

  it("posts a read-only summary and recalls the form on submit (Feishu ignores form-card patches)", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: { questions: [{ question: "Mode?", header: "Mode", multiSelect: false, options: [{ label: "Fast" }, { label: "Careful" }] }] },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel, runtime,
      event: { chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: { q0: "Fast" } } },
    });

    await pending;
    // The LAST send is a compact read-only summary (not an in-place patch, which
    // Feishu ignores on a submitted form), carrying the pick and no interactive
    // parts (the earlier send was the original form, which does have them).
    const summarySend = JSON.stringify(channel.send.mock.calls.at(-1));
    expect(summarySend).toContain("已提交");
    expect(summarySend).toContain("Fast");
    expect(summarySend).not.toContain("select_static");
    expect(summarySend).not.toContain("form_submit");
    // The now-useless interactive form is recalled.
    expect(channel.recallMessage).toHaveBeenCalledWith("om_card");
    expect(runtime.pendingApprovals.size).toBe(0);
  });

  it("re-prompts instead of resolving when a required single-select answer is missing", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: { questions: [{ question: "Mode?", header: "Mode", multiSelect: false, options: [{ label: "Fast" }, { label: "Careful" }] }] },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    // Submit with nothing selected → must NOT resolve; should re-prompt.
    await handleLarkCardAction({
      channel, runtime,
      event: { chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: {} } },
    });
    expect(runtime.pendingApprovals.size).toBe(1);
    expect(JSON.stringify(channel.send.mock.calls)).toContain("请先选择");

    // A real selection then resolves.
    await handleLarkCardAction({
      channel, runtime,
      event: { chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: { q0: "Careful" } } },
    });
    const resolved = await pending as { updatedInput: { answers: Record<string, string> } };
    expect(resolved.updatedInput.answers).toEqual({ "Mode?": "Careful" });
    expect(runtime.pendingApprovals.size).toBe(0);
  });

  it("recovers AskUserQuestion answers from the raw event when the SDK drops action.form_value", async () => {
    // The SDK's normalizeCardAction keeps only { value, tag, name, option } and
    // discards action.form_value, so a real form submit arrives with the picks
    // ONLY on the raw event body (channel created with includeRawEvent). Without
    // recovery this re-prompts "请先选择" forever and the run card never resolves.
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: { questions: [{ question: "Mode?", header: "Mode", multiSelect: false, options: [{ label: "Fast" }, { label: "Careful" }] }] },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    const callbackValue = { cctb_lark: "ask_user_question", action: "form_submit", requestId };
    await handleLarkCardAction({
      channel, runtime,
      event: {
        chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: callbackValue },
        raw: { action: { value: callbackValue, form_value: { q0: "Careful" } } },
      },
    });

    const resolved = await pending as { updatedInput: { answers: Record<string, string> } };
    expect(resolved.updatedInput.answers).toEqual({ "Mode?": "Careful" });
    expect(runtime.pendingApprovals.size).toBe(0);
    expect(JSON.stringify(channel.send.mock.calls)).not.toContain("请先选择");
  });

  it("accepts the free-text Other answer when no option is picked", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel, runtime, chatId: "oc_chat", replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "AskUserQuestion",
        toolInput: { questions: [{ question: "Mode?", header: "Mode", multiSelect: false, options: [{ label: "Fast" }, { label: "Careful" }] }] },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    // Nothing picked from the dropdown, but the "Other" field is filled.
    await handleLarkCardAction({
      channel, runtime,
      event: { chatId: "oc_chat", messageId: "om_card", operator: { openId: "ou_user" },
        action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId }, form_value: { q0: "", q0_other: "Whimsical" } } },
    });

    const resolved = await pending as { updatedInput: { answers: Record<string, string> } };
    expect(resolved.updatedInput.answers).toEqual({ "Mode?": "Whimsical" });
    expect(runtime.pendingApprovals.size).toBe(0);
    expect(JSON.stringify(channel.send.mock.calls)).not.toContain("请先选择");
  });

  it("answers unsupported Lark card actions instead of silently ignoring them", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: {
            cctb_lark: "ask_user_question_smoke",
            answer: "Continue",
          },
        },
      },
    });

    expect(handled).toBe(true);
    expect(channel.send).toHaveBeenCalledWith(
      "oc_chat",
      { text: expect.stringContaining("不再有效") },
      { replyTo: "om_card" },
    );
  });

  it("accepts stringified Lark card action values from callback payloads", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: JSON.stringify({
            cctb_lark: "ask_user_question_smoke",
            answer: "Continue",
            replyInThread: true,
          }),
        },
      },
    });

    expect(handled).toBe(true);
    expect(channel.send).toHaveBeenCalledWith(
      "oc_chat",
      { text: expect.stringContaining("不再有效") },
      { replyTo: "om_card", replyInThread: true },
    );
  });

  it("renders Lark approval timeout replies in English when Lark locale is English", async () => {
    vi.useFakeTimers();
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      replyTo: "om_request",
      locale: "en",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });

    try {
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual({ behavior: "deny" });
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Approval expired (denied)." },
        { replyTo: "om_request" },
      );
    } finally {
      runtime.pendingApprovals.clear();
      vi.useRealTimers();
    }
  });

  it("keeps Lark approval card action replies inside the originating thread", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_group",
      conversationKey: "lark:oc_group:omt_topic",
      bridgeChatType: "group",
      replyTo: "om_request",
      replyInThread: true,
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_group",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "approval", requestId, decision: "allow_session" },
        },
      },
    });

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
    expect(channel.send).toHaveBeenCalledWith(
      "oc_group",
      { text: "已允许本轮。" },
      { replyTo: "om_card", replyInThread: true },
    );
  });

  it("renders Lark approval card action replies in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-card-en-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_request",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card_en",
          operator: { openId: "ou_user" },
          action: {
            value: { cctb_lark: "approval", requestId, decision: "allow_session" },
          },
        },
      });

      await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).not.toContain("已允许");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "Allowed for this turn." },
        { replyTo: "om_card_en" },
      );
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records successful Lark approval card actions in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-success-timeline-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    runtime.pendingApprovals.set("req_1", {
      requestId: "req_1",
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      resolve,
      reject,
      timer,
    });

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card",
          operator: { openId: "ou_user" },
          action: {
            value: { cctb_lark: "approval", requestId: "req_1", decision: "allow_session" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(resolve).toHaveBeenCalledWith({ behavior: "allow", scope: "session" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "success",
        detail: "approval",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "approval",
          decision: "allow_session",
          requestId: "req_1",
          larkChatId: "oc_chat",
          larkMessageId: "om_card",
        }),
      }));
    } finally {
      clearTimeout(timer);
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records noop Lark approval card actions when the pending request is missing", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-noop-timeline-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();

    try {
      const handled = await handleLarkCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card",
          operator: { openId: "ou_user" },
          action: {
            value: { cctb_lark: "approval", requestId: "missing_req", decision: "allow_once" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "没有待处理的审批。" }, { replyTo: "om_card" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "noop",
        detail: "approval",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "approval",
          decision: "allow_once",
          requestId: "missing_req",
          reason: "no-pending",
          larkChatId: "oc_chat",
          larkMessageId: "om_card",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves Lark approval requests from text commands when cards are unavailable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-text-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_request",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_approve",
          content: "/approve session",
        }),
      });

      await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
      expect(runtime.pendingApprovals.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已允许本轮。" }, { replyTo: "om_approve" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "success",
        detail: "approval",
        metadata: expect.objectContaining({
          command: "approval",
          choice: "session",
        }),
      }));
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves Lark approval fallback commands by request id", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-id-text-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const pendingOnce = requestLarkApproval({
        channel,
        runtime,
        chatId: "oc_chat",
        conversationKey: "lark:oc_chat",
        bridgeChatType: "private",
        replyTo: "om_request_once",
        request: {
          engine: "claude",
          toolName: "Bash",
          toolInput: { command: "npm test" },
        } satisfies EngineApprovalRequest,
      });
      const onceRequestId = [...runtime.pendingApprovals.keys()][0]!;

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_approve_once",
          content: `/approve ${onceRequestId}`,
        }),
      });

      await expect(pendingOnce).resolves.toEqual({ behavior: "allow", scope: "once" });
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已允许一次。" }, { replyTo: "om_approve_once" });

      const pendingSession = requestLarkApproval({
        channel,
        runtime,
        chatId: "oc_chat",
        conversationKey: "lark:oc_chat",
        bridgeChatType: "private",
        replyTo: "om_request_session",
        request: {
          engine: "claude",
          toolName: "Bash",
          toolInput: { command: "npm run build" },
        } satisfies EngineApprovalRequest,
      });
      const sessionRequestId = [...runtime.pendingApprovals.keys()][0]!;

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_approve_session",
          content: `/approve-session ${sessionRequestId}`,
        }),
      });

      await expect(pendingSession).resolves.toEqual({ behavior: "allow", scope: "session" });
      expect(runtime.pendingApprovals.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已允许本轮。" }, { replyTo: "om_approve_session" });
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("denies Lark approval requests from /deny text commands when cards are unavailable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-deny-text-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_request",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "rm -rf /tmp/example" },
      } satisfies EngineApprovalRequest,
    });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_deny",
          content: "/deny",
        }),
      });

      await expect(pending).resolves.toEqual({ behavior: "deny" });
      expect(runtime.pendingApprovals.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已拒绝。" }, { replyTo: "om_deny" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
        outcome: "success",
        detail: "approval",
        metadata: expect.objectContaining({
          command: "approval",
          choice: "deny",
        }),
      }));
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("renders Lark approval text command replies in English when Lark locale is English", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-text-en-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_request",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });

    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en" }));

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_approve_en",
          content: "/approve session",
        }),
      });

      await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "Allowed for this turn." }, { replyTo: "om_approve_en" });
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps Lark approval text command replies inside the current thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-text-thread-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_group",
      conversationKey: "lark:oc_group:omt_topic",
      bridgeChatType: "group",
      replyTo: "om_request",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_thread_approve",
          chatId: "oc_group",
          chatType: "group",
          threadId: "omt_topic",
          content: "/approve",
        }),
      });

      await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { text: "已允许一次。" },
        { replyTo: "om_thread_approve", replyInThread: true },
      );
    } finally {
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark approval actions without resolving the approval", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-denied-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    runtime.pendingApprovals.set("req_1", {
      requestId: "req_1",
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      resolve,
      reject,
      timer,
    });

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card",
          operator: { openId: "ou_intruder" },
          action: {
            value: { cctb_lark: "approval", requestId: "req_1", decision: "allow_session" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(runtime.pendingApprovals.has("req_1")).toBe(true);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "om_card" });
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        conversationKey: "lark:oc_chat",
        outcome: "denied",
        detail: "access denied",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "approval",
          larkChatId: "oc_chat",
          larkMessageId: "om_card",
        }),
      }));
    } finally {
      clearTimeout(timer);
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized legacy Lark approval actions without a stored conversation key", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-legacy-denied-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    runtime.pendingApprovals.set("req_legacy", {
      requestId: "req_legacy",
      chatId: "oc_chat",
      resolve,
      reject,
      timer,
    });

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card",
          operator: { openId: "ou_intruder" },
          action: {
            value: { cctb_lark: "approval", requestId: "req_legacy", decision: "allow_session" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(runtime.pendingApprovals.has("req_legacy")).toBe(true);
      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
      }));
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "om_card" });
    } finally {
      clearTimeout(timer);
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps unauthorized Lark approval action denials inside the originating thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-denied-thread-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    runtime.pendingApprovals.set("req_1", {
      requestId: "req_1",
      chatId: "oc_group",
      conversationKey: "lark:oc_group:omt_topic",
      bridgeChatType: "group",
      replyInThread: true,
      resolve,
      reject,
      timer,
    });

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_group",
          messageId: "om_card",
          operator: { openId: "ou_intruder" },
          action: {
            value: { cctb_lark: "approval", requestId: "req_1", decision: "allow_session" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(runtime.pendingApprovals.has("req_1")).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_group",
        { text: "未授权" },
        { replyTo: "om_card", replyInThread: true },
      );
    } finally {
      clearTimeout(timer);
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function fakeCommentEvent(overrides: Partial<{
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  operator: { openId?: string; userId?: string; unionId?: string };
  mentionedBot: boolean;
  timestamp: number;
}> = {}) {
  const operator = overrides.operator ?? { openId: "ou_user" };
  return {
    fileToken: overrides.fileToken ?? "doc_token",
    fileType: overrides.fileType ?? "docx",
    commentId: overrides.commentId ?? "comment_1",
    operator: {
      openId: operator.openId ?? "ou_user",
      ...(operator.userId ? { userId: operator.userId } : {}),
      ...(operator.unionId ? { unionId: operator.unionId } : {}),
    },
    mentionedBot: overrides.mentionedBot ?? true,
    timestamp: overrides.timestamp ?? Date.now(),
    ...(overrides.replyId ? { replyId: overrides.replyId } : {}),
  };
}

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  chatMode: "p2p" | "group" | "topic";
  chatName: string;
  senderId: string;
  senderName: string;
  content: string;
  rawContentType: string;
  threadId: string;
  mentionedBot: boolean;
  resources: Array<{ type: string; fileKey: string; fileName?: string }>;
  replyToMessageId: string;
  mentions: unknown[];
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    ...(overrides.chatMode ? { chatMode: overrides.chatMode } : {}),
    ...(overrides.chatName ? { chatName: overrides.chatName } : {}),
    senderId: overrides.senderId ?? "ou_user",
    ...(overrides.senderName ? { senderName: overrides.senderName } : {}),
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    ...(overrides.replyToMessageId ? { replyToMessageId: overrides.replyToMessageId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: overrides.rawContentType ?? "text",
    resources: overrides.resources ?? [],
    mentions: overrides.mentions ?? [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

function fakeCommentClient(overrides: Partial<{
  getCommentContext: ReturnType<typeof vi.fn>;
  createReply: ReturnType<typeof vi.fn>;
  createTopLevelComment: ReturnType<typeof vi.fn>;
  addReaction: ReturnType<typeof vi.fn>;
  removeReaction: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getCommentContext: overrides.getCommentContext ?? vi.fn(async () => ({
      quote: "",
      replies: [],
    })),
    createReply: overrides.createReply ?? vi.fn(async () => undefined),
    createTopLevelComment: overrides.createTopLevelComment ?? vi.fn(async () => undefined),
    addReaction: overrides.addReaction ?? vi.fn(async () => undefined),
    removeReaction: overrides.removeReaction ?? vi.fn(async () => undefined),
  };
}

type FakeLarkChannel = ReturnType<typeof baseFakeChannel> & {
  fetchMessage?: ReturnType<typeof vi.fn>;
  addReaction?: ReturnType<typeof vi.fn>;
  removeReaction?: ReturnType<typeof vi.fn>;
  removeReactionByEmoji?: ReturnType<typeof vi.fn>;
  getChatMode?: ReturnType<typeof vi.fn>;
  getChatTopicForm?: ReturnType<typeof vi.fn>;
  rawClient?: unknown;
};

/**
 * The Lark run card is the canonical reply: the final answer is rendered into
 * the card (delivered via channel.send({card}) + channel.updateCard) rather
 * than a separate markdown message. When the card cannot be created the bridge
 * falls back to a markdown send. This helper asserts the answer was delivered
 * through whichever path applied.
 */
function expectLarkFinalAnswer(channel: FakeLarkChannel, text: string): void {
  const calls = (fn: ReturnType<typeof vi.fn> | undefined): unknown[][] =>
    (fn?.mock?.calls as unknown[][] | undefined) ?? [];
  const inCard = JSON.stringify(calls(channel.updateCard)).includes(text)
    || calls(channel.send).some((call) => JSON.stringify(call[1] ?? "").includes(text));
  const inMarkdown = calls(channel.send).some((call) => {
    const payload = call[1] as { markdown?: unknown } | undefined;
    return typeof payload?.markdown === "string" && payload.markdown.includes(text);
  });
  expect(inCard || inMarkdown).toBe(true);
}

function fakeChannel(overrides: Partial<FakeLarkChannel> = {}): FakeLarkChannel {
  return {
    ...baseFakeChannel(),
    ...overrides,
  };
}

function baseFakeChannel() {
  return {
    send: vi.fn(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: LarkStreamControllerLike) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async () => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
  };
}
