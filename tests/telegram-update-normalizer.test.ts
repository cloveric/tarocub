import { describe, expect, it } from "vitest";

import { normalizeUpdate } from "../src/telegram/update-normalizer.js";

describe("normalizeUpdate message_thread_id handling", () => {
  it("ignores message_thread_id on an ordinary reply in a non-forum supergroup", () => {
    // Telegram sets message_thread_id to the reply-root id on plain replies in
    // non-forum supergroups. Treating it as a topic thread 400s on send and
    // fragments the conversation key, so it must be dropped.
    const normalized = normalizeUpdate({
      message: {
        message_id: 10,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 456 },
        message_thread_id: 42,
        // is_topic_message intentionally absent
        text: "hello",
        reply_to_message: { message_id: 42, text: "root" },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.messageThreadId).toBeUndefined();
    // Conversation key must not be fragmented per reply chain.
    expect(normalized!.conversationKey).not.toContain("topic");
    expect(normalized!.conversationKey).not.toContain("42");
  });

  it("ignores message_thread_id when is_topic_message is explicitly false", () => {
    const normalized = normalizeUpdate({
      message: {
        message_id: 11,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 456 },
        message_thread_id: 42,
        is_topic_message: false,
        text: "hello",
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.messageThreadId).toBeUndefined();
  });

  it("honors message_thread_id for a real forum topic message", () => {
    const normalized = normalizeUpdate({
      message: {
        message_id: 12,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 456 },
        message_thread_id: 88,
        is_topic_message: true,
        text: "in topic",
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.messageThreadId).toBe(88);
    expect(normalized!.conversationKey).toContain("88");
  });

  it("ignores callback message_thread_id without is_topic_message", () => {
    const normalized = normalizeUpdate({
      callback_query: {
        id: "cb-1",
        data: "continue-archive:11111111-2222-3333-4444-555555555555",
        from: { id: 456 },
        message: {
          message_id: 20,
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: 42,
        },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.messageThreadId).toBeUndefined();
  });

  it("honors callback message_thread_id for a real forum topic message", () => {
    const normalized = normalizeUpdate({
      callback_query: {
        id: "cb-2",
        data: "continue-archive:11111111-2222-3333-4444-555555555555",
        from: { id: 456 },
        message: {
          message_id: 21,
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: 88,
          is_topic_message: true,
        },
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.messageThreadId).toBe(88);
  });
});
