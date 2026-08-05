import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import { readDeliveryObligations } from "../src/state/delivery-obligation-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("Lark ordinary turn × delivery ledger", () => {
  it("records the final answer as an obligation and settles it delivered", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-ledger-int-"));
    const channel = {
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "the final engine answer" })),
    };
    try {
      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_turn",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello there",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });
      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalled();
      const rows = await readDeliveryObligations(stateDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("delivered");
      expect(rows[0]!.content).toBe("the final engine answer");
      expect(rows[0]!.chatId).toBe("oc_chat");
      expect(rows[0]!.replyTo).toBe("om_turn");
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
