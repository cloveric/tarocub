import { describe, expect, it } from "vitest";

import { normalizeLarkMessage } from "../src/lark/message-normalizer.js";

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

  it("gives two topics in the same group separate sessions while the main timeline stays shared", () => {
    const base = {
      chatId: "oc_group",
      chatType: "group" as const,
      chatMode: "group" as const,
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
    const mainTimeline = normalizeLarkMessage({ ...base, messageId: "om_c", content: "no thread" });

    // Distinct topics never bleed into one shared context...
    expect(topicA?.conversationKey).toBe("lark:oc_group:omt_a");
    expect(topicB?.conversationKey).toBe("lark:oc_group:omt_b");
    expect(topicA?.conversationKey).not.toBe(topicB?.conversationKey);
    // ...but a non-topic group message still shares the one group session.
    expect(mainTimeline?.conversationKey).toBe("lark:oc_group");
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

  it("isolates a topic reply by thread even in a normal group (chat_mode=group)", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_group",
      chatType: "group",
      chatMode: "group",
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

    // A topic reply in a normal group is its own conversation — so distinct
    // topics in the same group never bleed into one shared context.
    expect(normalized?.conversationKey).toBe("lark:oc_group:omt_group_thread");
    expect(normalized?.bridgeChatType).toBe("group");
    expect(normalized?.threadId).toBe("omt_group_thread");
    expect(normalized?.text).toContain("thread_id: omt_group_thread");
  });

  it("keeps p2p message threads in the parent private session", () => {
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

    expect(normalized?.conversationKey).toBe("lark:oc_chat");
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
        { type: "file", fileKey: "file_1", fileName: "report.pdf" },
        { type: "sticker", fileKey: "sticker_1" },
      ],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 123,
    });

    expect(normalized?.attachments).toEqual([
      { kind: "image", fileKey: "img_1" },
      { kind: "file", fileKey: "file_1", fileName: "report.pdf" },
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
