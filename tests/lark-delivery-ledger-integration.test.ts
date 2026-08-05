import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
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

  it("ledgers a background-task notification delivery alongside the final answer", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-ledger-notif-"));
    const channel = {
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({
          type: "task_notification",
          text: "background job finished: report ready",
          status: "completed",
          taskId: "task-1",
        });
        return { text: "final answer" };
      }),
    };
    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_turn2",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "run something",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });
      const rows = await readDeliveryObligations(stateDir);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.state === "delivered")).toBe(true);
      const notification = rows.find((row) => row.content.includes("background job finished"));
      expect(notification).toBeDefined();
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
