import { describe, expect, it } from "vitest";

import { larkChatIsTopicForm, normalizeLarkMessage } from "../src/lark/message-normalizer.js";

describe("larkChatIsTopicForm", () => {
  it("treats a native topic group and a thread-form conversation group as topic form", () => {
    // verified against real im.v1.chat.get payloads
    expect(larkChatIsTopicForm({ chat_mode: "topic" })).toBe(true); // CCTB smoke 0527
    expect(larkChatIsTopicForm({ chat_mode: "group", group_message_type: "thread" })).toBe(true); // Eric / test
  });

  it("treats a conversation-form group and a plain group as shared (not topic form)", () => {
    expect(larkChatIsTopicForm({ chat_mode: "group", group_message_type: "chat" })).toBe(false); // 群聊测试
    expect(larkChatIsTopicForm({ chat_mode: "group" })).toBe(false);
    expect(larkChatIsTopicForm({})).toBe(false);
  });
});

describe("normalizeLarkMessage", () => {
  it("builds a bridge-ready p2p message with a stable conversation key", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
      senderName: "Clover",
      content: "hello",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    });

    expect(normalized).toMatchObject({
      messageId: "om_123",
      chatId: "oc_chat",
      senderId: "ou_user",
      bridgeChatType: "private",
      conversationKey: "lark:oc_chat",
      text: expect.stringContaining("<lark_context>"),
      attachments: [],
    });
    expect(normalized?.text).toContain("chat_id: oc_chat");
    expect(normalized?.text).toContain("sender_name: Clover");
    expect(normalized?.text).toContain("hello");
  });

  it("gives two topics in a topic-form group separate sessions by thread id", () => {
    // chatMode is resolved upstream to "topic" for a topic-form chat (a native
    // topic group, or a conversation group switched to the topic message form).
    const base = {
      chatId: "oc_group",
      chatType: "group" as const,
      chatMode: "topic" as const,
      senderId: "ou_user",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 123,
    };
    const topicA = normalizeLarkMessage({ ...base, messageId: "om_a", threadId: "omt_a", content: "股票" });
    const topicB = normalizeLarkMessage({ ...base, messageId: "om_b", threadId: "omt_b", content: "登录" });

    expect(topicA?.conversationKey).toBe("lark:oc_group:omt_a");
    expect(topicB?.conversationKey).toBe("lark:oc_group:omt_b");
    expect(topicA?.conversationKey).not.toBe(topicB?.conversationKey);
  });

  it("keeps topic chats isolated by thread id", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_topic",
      chatType: "group",
      chatMode: "topic",
      threadId: "omt_thread",
      rootId: "om_root",
      replyToMessageId: "om_parent",
      senderId: "ou_user",
      content: "topic work",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 123,
    });

    expect(normalized?.conversationKey).toBe("lark:oc_topic:omt_thread");
    expect(normalized?.text).toContain("thread_id: omt_thread");
    expect(normalized?.text).toContain("root_id: om_root");
    expect(normalized?.text).toContain("reply_to_message_id: om_parent");
  });

  it("keeps a conversation-form group's topic replies in the one shared group session", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_group",
      chatType: "group",
      chatMode: "group", // resolved as conversation form (group_message_type=chat)
      threadId: "omt_group_thread",
      senderId: "ou_user",
      content: "ordinary group reply",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 123,
    });

    // Conversation form: a topic reply shares the group session (thread dropped
    // from the key), but the thread id is still surfaced in the message text.
    expect(normalized?.conversationKey).toBe("lark:oc_group");
    expect(normalized?.bridgeChatType).toBe("group");
    expect(normalized?.threadId).toBe("omt_group_thread");
    expect(normalized?.text).toContain("thread_id: omt_group_thread");
  });

  it("isolates p2p message threads while keeping access on the parent private chat", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_chat",
      chatType: "p2p",
      threadId: "omt_private_thread",
      rootId: "om_root",
      replyToMessageId: "om_parent",
      senderId: "ou_user",
      content: "continue in private thread",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    });

    expect(normalized?.conversationKey).toBe("lark:oc_chat:omt_private_thread");
    expect(normalized?.accessConversationKey).toBe("lark:oc_chat");
    expect(normalized?.bridgeChatId).not.toBe(normalized?.bridgeAccessChatId);
    expect(normalized?.bridgeChatType).toBe("private");
    expect(normalized?.threadId).toBe("omt_private_thread");
    expect(normalized?.text).toContain("thread_id: omt_private_thread");
  });

  it("drops unmentioned group messages when mention is required", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_user",
      content: "ambient chatter",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    }, { requireMentionInGroup: true });

    expect(normalized).toBeNull();
  });

  it("does not mistake absolute paths or unknown slash text for mention-bypassing commands", () => {
    const base = {
      messageId: "om_path",
      chatId: "oc_group",
      chatType: "group" as const,
      senderId: "ou_user",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    };

    for (const content of [
      "/Volumes/gdrive/project 请熟悉资料",
      "/Users/example/project/README.md 看一下",
      "/tmp/report.pdf",
      "/not-a-tarocub-command test",
    ]) {
      expect(normalizeLarkMessage({ ...base, content }, { requireMentionInGroup: true })).toBeNull();
    }
  });

  it("lets implemented slash commands and aliases bypass a group mention requirement", () => {
    const base = {
      messageId: "om_command",
      chatId: "oc_group",
      chatType: "group" as const,
      senderId: "ou_user",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    };

    for (const content of [
      "/status",
      "/status@ccfaa1",
      "/group all",
      "/approve-session req_1",
      "/approval req_1 once",
      "/start",
      "/kanban add 修复审计问题",
      "/queue 下一条",
    ]) {
      expect(normalizeLarkMessage({ ...base, content }, { requireMentionInGroup: true })).not.toBeNull();
    }
  });

  it("converts supported Feishu resources into local attachment descriptors", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
      content: "see files",
      rawContentType: "text",
      resources: [
        { type: "image", fileKey: "img_1" },
        { type: "file", fileKey: "file_1", fileName: "report.pdf", file_size: "27500000" },
        { type: "sticker", fileKey: "sticker_1" },
      ],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    });

    expect(normalized?.attachments).toEqual([
      { kind: "image", fileKey: "img_1" },
      { kind: "file", fileKey: "file_1", fileName: "report.pdf", fileSize: 27_500_000 },
    ]);
  });

  it("preserves merged forwarded Lark messages for one-click forwarding workflows", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_forward",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
      content: "<forwarded_messages><message sender=\"Leader\">请今天处理这个需求</message></forwarded_messages>",
      rawContentType: "merge_forward",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    });

    expect(normalized?.text).toContain("forwarded_lark_messages");
    expect(normalized?.text).toContain("Leader");
    expect(normalized?.text).toContain("请今天处理这个需求");
  });
});
