import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeWorkflowAwareTelegramTurn } from "../src/telegram/message-turn.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";
import type { DownloadedAttachment } from "../src/runtime/file-workflow.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

describe("executeWorkflowAwareTelegramTurn", () => {
  it("runs the ordinary bridge path and records a success audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "final response",
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("hello"),
        context: {
          api: {
            sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
            getFile: vi.fn(),
            downloadFile: vi.fn(),
          } as never,
          bridge: bridge as never,
          inboxDir: path.join(root, "inbox"),
          instanceName: "default",
          updateId: 77,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 123,
        text: "hello",
        files: [],
      }));
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "final response",
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
      );
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          responseChars: 14,
          chunkCount: 1,
        }),
      }));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "turn.started",
          channel: "telegram",
          chatId: 123,
        }),
        expect.objectContaining({
          type: "turn.completed",
          channel: "telegram",
          outcome: "success",
          metadata: expect.objectContaining({
            responseChars: 14,
          }),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers workflow reply summaries and stores summary message id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const downloadedAttachments: DownloadedAttachment[] = [
      {
        attachment: { fileId: "doc-1", kind: "document", fileName: "notes.txt" },
        localPath: "/tmp/notes.txt",
      },
    ];
    const update = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("analyze"),
        context: {
          api: {
            sendMessage,
            getFile: vi.fn(),
            downloadFile: vi.fn(),
          } as never,
          bridge: {
            handleAuthorizedMessage: vi.fn(),
          } as never,
          inboxDir: path.join(root, "inbox"),
          instanceName: "default",
          updateId: 78,
        },
        workflowStore: {
          update,
        } as never,
        downloadedAttachments,
        state,
        prepareAttachmentWorkflow: vi.fn().mockResolvedValue({
          kind: "reply",
          text: "archive summary",
          workflowRecordId: "wf-1",
        }),
        deliverTelegramResponse: vi.fn(),
        sendTelegramOutFile: vi.fn(),
        buildContinueAnalysisKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
      });

      expect(state.workflowRecordId).toBe("wf-1");
      expect(state.archiveSummaryDelivered).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(
        123,
        "archive summary",
        { inline_keyboard: [] },
      );
      expect(update).toHaveBeenCalledWith("wf-1", expect.any(Function));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "workflow.prepared",
        channel: "telegram",
        detail: "attachment workflow prepared",
        metadata: expect.objectContaining({
          workflowRecordId: "wf-1",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
