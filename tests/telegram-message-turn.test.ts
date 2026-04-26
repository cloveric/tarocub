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
        sideChannelCommand: expect.any(String),
        extraEnv: expect.objectContaining({
          CCTB_SEND_URL: expect.stringContaining("http://127.0.0.1:"),
          CCTB_SEND_TOKEN: expect.any(String),
          CCTB_SEND_COMMAND: expect.any(String),
        }),
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

  it("passes the active side-channel helper to the engine without placing it in telegram-out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const close = vi.fn().mockResolvedValue(undefined);
    const startSideChannelSendServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:12345/send/token",
      token: "token",
      getSentFilePaths: () => ["/tmp/generated.png"],
      close,
    });
    const createSideChannelSendHelper = vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper"));
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "Done\n[send-file:/tmp/generated.png]\n[send-file:/tmp/fallback.png]",
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("make an image"),
        context: {
          api: {
            sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
            sendDocument: vi.fn(),
            sendPhoto: vi.fn(),
            getFile: vi.fn(),
            downloadFile: vi.fn(),
          },
          bridge: bridge as never,
          inboxDir: path.join(root, "inbox"),
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer,
        createSideChannelSendHelper,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(startSideChannelSendServer).toHaveBeenCalledWith(expect.objectContaining({
        requestOutputDir: expect.stringContaining(path.join("workspace", ".telegram-out")),
      }));
      const helperRoot = createSideChannelSendHelper.mock.calls[0]?.[0] as string;
      expect(helperRoot).toContain(path.join("workspace", ".cctb-send"));
      expect(helperRoot).not.toContain(".telegram-out");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        sideChannelCommand: path.join(root, "workspace", ".cctb-send", "helper"),
        extraEnv: {
          CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
          CCTB_SEND_TOKEN: "token",
          CCTB_SEND_COMMAND: path.join(root, "workspace", ".cctb-send", "helper"),
        },
      }));
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "Done\n[send-file:/tmp/fallback.png]",
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts the side-channel with an embedded helper when the bridge cannot pass turn-scoped env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const close = vi.fn().mockResolvedValue(undefined);
    const startSideChannelSendServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:12345/send/token",
      token: "token",
      getSentFilePaths: () => [],
      close,
    });
    const createSideChannelSendHelper = vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper"));
    const bridge = {
      supportsTurnScopedEnv: false,
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "final response",
      }),
    };

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
            sendDocument: vi.fn(),
            sendPhoto: vi.fn(),
            getFile: vi.fn(),
            downloadFile: vi.fn(),
          },
          bridge: bridge as never,
          inboxDir: path.join(root, "inbox"),
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer,
        createSideChannelSendHelper,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile: vi.fn(),
      });

      expect(startSideChannelSendServer).toHaveBeenCalled();
      expect(createSideChannelSendHelper).toHaveBeenCalledWith(
        expect.stringContaining(".cctb-send"),
        undefined,
        {
          CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
          CCTB_SEND_TOKEN: "token",
        },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        sideChannelCommand: path.join(root, "workspace", ".cctb-send", "helper"),
        extraEnv: undefined,
      }));
      expect(close).toHaveBeenCalledTimes(1);
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
