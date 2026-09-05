import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { readDeliveryObligations } from "../src/state/delivery-obligation-store.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
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

  it("keeps the obligation failed and records a partial turn when an artifact cannot be confirmed", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-ledger-artifact-fail-"));
    const workspace = path.join(stateDir, "workspace");
    const imagePath = path.join(workspace, "report.png");
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, "image bytes");
    const channel = {
      send: vi.fn(async (_to: string, payload: unknown) => {
        const record = payload as {
          card?: { body?: { elements?: Array<{ tag?: string }> } };
          image?: unknown;
          file?: unknown;
        };
        if ((record.card?.body?.elements ?? []).some((element) => element.tag === "img")) {
          throw new Error("image card rejected");
        }
        if (record.image !== undefined || record.file !== undefined) {
          throw new Error("artifact fallback rejected");
        }
        return { messageId: "sent_1" };
      }),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
      rawClient: {
        im: { v1: { image: { create: vi.fn(async () => ({ image_key: "img_key" })) } } },
      },
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: `report ready\n\n[send-image:${imagePath}]`,
      })),
    };
    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_artifact_fail",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send report",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const rows = await readDeliveryObligations(stateDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("failed");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "partial",
      }));
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("keeps an artifact obligation recoverable when post-engine bookkeeping fails before upload", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-ledger-pre-upload-fail-"));
    const workspace = path.join(stateDir, "workspace");
    const imagePath = path.join(workspace, "report.png");
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, "image bytes");
    // Usage is recorded before artifact delivery. A directory at the ledger path
    // forces that bookkeeping step to fail without making the whole stateDir read-only.
    await mkdir(path.join(stateDir, "usage.json"));
    const createImage = vi.fn(async () => ({ image_key: "img_key" }));
    const channel = {
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
      rawClient: {
        im: { v1: { image: { create: createImage } } },
      },
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({
        text: `report ready\n\n[send-image:${imagePath}]`,
      })),
    };
    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_pre_upload_fail",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send report",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(createImage).not.toHaveBeenCalled();
      const rows = await readDeliveryObligations(stateDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("failed");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "partial",
      }));
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
