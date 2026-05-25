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

  it("keeps topic chats isolated by thread id", () => {
    const normalized = normalizeLarkMessage({
      messageId: "om_123",
      chatId: "oc_topic",
      chatType: "group",
      threadId: "omt_thread",
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
