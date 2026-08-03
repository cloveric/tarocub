import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LarkKnownChatStore } from "../src/lark/known-chats.js";
import type { LarkNormalizedBridgeMessage } from "../src/lark/message-normalizer.js";

function groupMessage(chatId: string): LarkNormalizedBridgeMessage {
  return {
    messageId: `om_${chatId}`,
    chatId,
    chatMode: "group",
    chatName: "Recovered Group",
    senderId: "ou_sender",
    senderName: "Sender",
    bridgeChatId: 7,
    bridgeAccessChatId: 7,
    bridgeUserId: 9,
    bridgeChatType: "group",
    conversationKey: `lark:${chatId}`,
    accessConversationKey: `lark:${chatId}`,
    text: "hello",
    mentions: [],
    attachments: [],
  };
}

describe("LarkKnownChatStore", () => {
  it("keeps a private-chat thread as a distinct routable conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-known-private-thread-"));
    const normalized: LarkNormalizedBridgeMessage = {
      messageId: "om_private_thread",
      chatId: "oc_private",
      chatMode: "p2p",
      threadId: "omt_private_topic",
      senderId: "ou_sender",
      senderName: "Clover",
      bridgeChatId: 8,
      bridgeAccessChatId: 7,
      bridgeUserId: 9,
      bridgeChatType: "private",
      conversationKey: "lark:oc_private:omt_private_topic",
      accessConversationKey: "lark:oc_private",
      text: "hello",
      mentions: [],
      attachments: [],
    };

    try {
      const store = new LarkKnownChatStore(stateDir);
      await store.record(normalized, new Date("2026-08-03T00:00:00.000Z"));

      await expect(store.get(normalized.conversationKey)).resolves.toEqual(expect.objectContaining({
        chatType: "private",
        chatMode: "p2p",
        threadId: "omt_private_topic",
        label: "Clover / omt_private_topic",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sanitizes stale parent-group known chat labels that were recorded from reply threads", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-known-chats-"));
    await writeFile(path.join(stateDir, "known-chats.json"), JSON.stringify({
      chats: [
        {
          chatId: "oc_group",
          conversationKey: "lark:oc_group",
          bridgeChatId: 1,
          bridgeAccessChatId: 1,
          chatType: "group",
          chatMode: "group",
          threadId: "omt_reply",
          label: "oc_group / omt_reply",
          lastSeenAt: "2026-05-29T06:35:15.491Z",
        },
        {
          chatId: "oc_group",
          conversationKey: "lark:oc_group:omt_topic",
          bridgeChatId: 2,
          bridgeAccessChatId: 1,
          chatType: "group",
          chatMode: "topic",
          threadId: "omt_topic",
          label: "oc_group / omt_topic",
          lastSeenAt: "2026-05-29T07:57:19.470Z",
        },
      ],
    }) + "\n");

    try {
      const chats = await new LarkKnownChatStore(stateDir).list();

      expect(chats).toContainEqual(expect.objectContaining({
        conversationKey: "lark:oc_group",
        label: "oc_group",
      }));
      expect(chats.find((chat) => chat.conversationKey === "lark:oc_group")).not.toHaveProperty("threadId");
      expect(chats).toContainEqual(expect.objectContaining({
        conversationKey: "lark:oc_group:omt_topic",
        label: "oc_group / omt_topic",
        threadId: "omt_topic",
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt known-chats.json by quarantining it instead of throwing forever", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-known-chats-corrupt-"));
    const filePath = path.join(stateDir, "known-chats.json");
    await writeFile(filePath, "{ this is not valid json", "utf8");

    try {
      const store = new LarkKnownChatStore(stateDir);

      // list() must not throw on a corrupt file — it returns an empty set.
      await expect(store.list()).resolves.toEqual([]);

      // The corrupt file is quarantined to a .corrupt.<uuid>.bak sibling.
      const quarantined = (await readdir(stateDir)).filter((name) =>
        name.startsWith("known-chats.json.corrupt.") && name.endsWith(".bak"));
      expect(quarantined).toHaveLength(1);

      // Self-heal must restore function: a subsequent record() writes a fresh,
      // valid file (the bug was that a corrupt file silently disabled recording forever).
      await store.record(groupMessage("oc_recovered"));
      await expect(store.get("lark:oc_recovered")).resolves.toEqual(expect.objectContaining({
        conversationKey: "lark:oc_recovered",
        label: "Recovered Group",
      }));
      const healed = JSON.parse(await readFile(filePath, "utf8")) as { chats: unknown[] };
      expect(Array.isArray(healed.chats)).toBe(true);
      expect(healed.chats).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
