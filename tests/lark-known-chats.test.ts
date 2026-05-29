import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LarkKnownChatStore } from "../src/lark/known-chats.js";

describe("LarkKnownChatStore", () => {
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
});
