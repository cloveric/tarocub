import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        expect.objectContaining({
          source: "post-turn",
          onDeliveryAccepted: expect.any(Function),
          onDeliveryRejected: expect.any(Function),
        }),
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes side-channel helper directories under the resume workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const resumeWorkspace = path.join(root, "resumed-project");
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const pruneStaleCctbSendDirs = vi.fn().mockResolvedValue(undefined);
    const createSideChannelSendHelper = vi.fn().mockResolvedValue(path.join(resumeWorkspace, ".cctb-send", "helper"));
    const close = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "final response",
      }),
    };

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex", resume: { workspacePath: resumeWorkspace } },
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
        pruneStaleCctbSendDirs,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => [],
          close,
        }),
        createSideChannelSendHelper,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile: vi.fn(),
      });

      expect(pruneStaleCctbSendDirs).toHaveBeenCalledWith(root, expect.any(String), resumeWorkspace);
      const helperRoot = createSideChannelSendHelper.mock.calls[0]?.[0] as string;
      expect(helperRoot).toContain(path.join(resumeWorkspace, ".cctb-send"));
      expect(createSideChannelSendHelper).toHaveBeenCalledWith(helperRoot, undefined, expect.any(Object));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers stream send-file events before final turn delivery and strips duplicate final tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "chart.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async (input) => {
        input.onEngineEvent?.({
          type: "tool_use",
          toolName: "Write",
          toolInput: { file_path: generatedPath },
        });
        input.onEngineEvent?.({
          type: "assistant_text",
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        });
        input.onEngineEvent?.({
          type: "assistant_text",
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        });
        return {
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        };
      }),
    };
    const deliverTelegramResponse = vi.fn().mockImplementation(async (
      _api,
      _chatId,
      text: string,
      _inboxDir,
      _workspaceOverride,
      _requestOutputDir,
      _locale,
      options,
    ) => {
      if (text.includes("[send-file:")) {
        options?.onFileAccepted?.(generatedPath);
        return 1;
      }
      return 0;
    });

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("make chart"),
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
          instanceName: "default",
          updateId: 99,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(deliverTelegramResponse).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        123,
        `Generated chart.\n[send-file:${generatedPath}]`,
        expect.any(String),
        undefined,
        undefined,
        "en",
        expect.objectContaining({
          source: "stream-event",
          onFileAccepted: expect.any(Function),
        }),
      );
      expect(deliverTelegramResponse).toHaveBeenCalledTimes(2);
      expect(deliverTelegramResponse).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        123,
        "",
        expect.any(String),
        undefined,
        undefined,
        "en",
      );

      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "engine.event",
          detail: "tool_use",
          metadata: expect.objectContaining({
            toolName: "Write",
          }),
        }),
        expect.objectContaining({
          type: "engine.event",
          detail: "assistant_text",
          metadata: expect.objectContaining({
            hasSendFileTag: true,
          }),
        }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries stream-rejected send-file tags during final turn delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "chart.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async (input) => {
        input.onEngineEvent?.({
          type: "assistant_text",
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        });
        return {
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        };
      }),
    };
    const deliverTelegramResponse = vi.fn().mockImplementation(async (
      _api,
      _chatId,
      text: string,
      _inboxDir,
      _workspaceOverride,
      _requestOutputDir,
      _locale,
      options,
    ) => {
      if (text.includes("[send-file:") && options?.source === "stream-event") {
        options?.onDeliveryRejected?.({
          path: generatedPath,
          reason: "not-found",
          source: "stream-event",
        });
        return 0;
      }
      if (text.includes("[send-file:")) {
        options?.onFileAccepted?.(generatedPath);
        options?.onDeliveryAccepted?.({
          path: generatedPath,
          realPath: generatedPath,
          fileName: "chart.png",
          source: options?.source ?? "post-turn",
        });
        return 1;
      }
      return 0;
    });

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("explain delivery"),
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
          instanceName: "default",
          updateId: 99,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(deliverTelegramResponse).toHaveBeenCalledTimes(2);
      expect(deliverTelegramResponse).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        123,
        `Generated chart.\n[send-file:${generatedPath}]`,
        expect.any(String),
        undefined,
        undefined,
        "en",
        expect.objectContaining({
          source: "stream-event",
          notifyRejected: false,
          onDeliveryRejected: expect.any(Function),
        }),
      );
      expect(deliverTelegramResponse).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        123,
        `[send-file:${generatedPath}]`,
        expect.any(String),
        undefined,
        undefined,
        "en",
        expect.objectContaining({
          source: "post-turn",
          onDeliveryAccepted: expect.any(Function),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair status-like deferred replies without a delivery contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "final.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({
          text: "跑到 7/9，P8 在生成中。还差 P8 + P9，应该 2 分钟左右。等 batch 通知。",
        })
        .mockResolvedValueOnce({
          text: `Done\n[send-file:${generatedPath}]`,
        }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("好了吗"),
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
          instanceName: "bot2",
          updateId: 103,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "跑到 7/9，P8 在生成中。还差 P8 + P9，应该 2 分钟左右。等 batch 通知。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).not.toContainEqual(expect.objectContaining({
        type: "turn.retried",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair current-turn background batch text without a hard delivery signal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "final.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({
          text: "P1 已生成（水彩绘本风确认好看）。\nP2-P9 batch 跑起来了，4 分钟后我主动来 check。",
        })
        .mockResolvedValueOnce({
          text: `Done\n[send-file:${generatedPath}]`,
        }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("生成整套图"),
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
          instanceName: "bot2",
          updateId: 104,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "P1 已生成（水彩绘本风确认好看）。\nP2-P9 batch 跑起来了，4 分钟后我主动来 check。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair scheduled wakeup batch replies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockImplementationOnce(async (input) => {
          input.onEngineEvent?.({
            type: "tool_use",
            toolName: "ScheduleWakeup",
          });
          return {
            text: "P1 + batch 都跑起来了。我设了 4.5 分钟主动 check，不被动等回执。",
          };
        }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("回 1/2（风格）+ 1/2/3（确认）"),
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
          instanceName: "bot2",
          updateId: 105,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "P1 + batch 都跑起来了。我设了 4.5 分钟主动 check，不被动等回执。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores legacy delivery contract state when handling continuation-like chat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const now = new Date();
    await writeFile(path.join(root, "delivery-contracts.json"), JSON.stringify({
      records: [
        {
          chatId: 123,
          userId: 456,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ],
    }));
    const responseText = "P1 + batch 都跑起来了。我设了 4.5 分钟主动 check，不被动等回执。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("回 1/2（风格）+ 1/2/3（确认）"),
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
          instanceName: "bot2",
          updateId: 109,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a delivery contract when budget blocks a deliverable request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
    };
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn(),
      sendPhoto: vi.fn(),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };

    try {
      await writeFile(path.join(root, "usage.json"), JSON.stringify({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 1,
        requestCount: 1,
        lastUpdatedAt: new Date().toISOString(),
      }));

      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude", budgetUsd: 0.5 },
        normalized: createNormalizedMessage("帮我生成 2 张小红书图片"),
        context: {
          api,
          bridge: bridge as never,
          inboxDir: path.join(root, "inbox"),
          instanceName: "bot2",
          updateId: 110,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      await expect(readFile(path.join(root, "delivery-contracts.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist delivery contracts for current-turn deliverable requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "poster.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: `Done\n[send-file:${generatedPath}]`,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockImplementation(async (
      _api,
      _chatId,
      _text,
      _inboxDir,
      _workspaceOverride,
      _requestOutputDir,
      _locale,
      options,
    ) => {
      options?.onDeliveryAccepted?.({
        path: generatedPath,
        realPath: generatedPath,
        fileName: "poster.png",
        bytes: 3,
        source: "post-turn",
      });
      return 1;
    });

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("帮我生成一张海报图"),
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
          instanceName: "bot2",
          updateId: 111,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      await expect(readFile(path.join(root, "delivery-contracts.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair attachment-driven generated image replies without explicit delivery evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const inputPath = path.join(root, "workspace", ".telegram-files", "input.png");
    const generatedPath = path.join(root, "workspace", "xhs-images", "deck", "01-cover.png");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, "input", "utf8");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementationOnce(async () => {
        await mkdir(path.dirname(generatedPath), { recursive: true });
        await writeFile(generatedPath, "png", "utf8");
        return {
          text: "9 张图片已经生成好了。",
        };
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("回 1/2（风格）+ 1/2/3（确认）"),
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
          instanceName: "bot2",
          updateId: 106,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [{
          attachment: { kind: "photo" },
          localPath: inputPath,
        } as DownloadedAttachment],
        prepareAttachmentWorkflow: vi.fn().mockResolvedValue({
          kind: "direct",
          text: "回 1/2（风格）+ 1/2/3（确认）",
          files: [inputPath],
        }),
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "9 张图片已经生成好了。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair unsanctioned scheduled wakeups in ordinary turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockImplementationOnce(async (input) => {
          input.onEngineEvent?.({
            type: "tool_use",
            toolName: "ScheduleWakeup",
          });
          return {
            text: "我设了 5 分钟后回来检查。",
          };
        }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("检查一下服务状态"),
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
          instanceName: "bot2",
          updateId: 107,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "我设了 5 分钟后回来检查。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows scheduled wakeups when the user explicitly asks for a reminder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "已安排，10 分钟后提醒你检查日志。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async (input) => {
        input.onEngineEvent?.({
          type: "tool_use",
          toolName: "ScheduleWakeup",
        });
        return { text: responseText };
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("10 分钟后提醒我检查日志"),
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
          instanceName: "bot2",
          updateId: 108,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair zero-evidence current-turn completion text without a hard delivery signal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "poster.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn()
        .mockResolvedValueOnce({
          text: "图片已生成，保存为 poster.png。",
        })
        .mockResolvedValueOnce({
          text: `Done\n[send-file:${generatedPath}]`,
        }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("帮我生成一张海报图"),
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
          instanceName: "bot2",
          updateId: 105,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "图片已生成，保存为 poster.png。",
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair current-turn completion text solely because recent workspace files exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const workspaceDir = path.join(root, "workspace");
    const generatedPath = path.join(workspaceDir, "poster.png");
    const responseText = "图片已生成，保存为 poster.png。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(generatedPath, "png");

      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude", resume: { workspacePath: workspaceDir } },
        normalized: createNormalizedMessage("帮我做一张海报"),
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
          instanceName: "bot2",
          updateId: 118,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        workspaceDir,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair image analysis replies that are not deliverable requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "图片内容分析完成：画面里是一只猫，没有需要交付的文件。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("分析这张图片"),
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
          instanceName: "bot2",
          updateId: 106,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair text-only image description generation replies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "图片描述已生成：一只橘猫坐在窗边看雨。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("帮我生成图片描述"),
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
          instanceName: "bot2",
          updateId: 108,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair text-only report generation replies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "Report generated: the launch metrics improved week over week.";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("generate a report"),
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
          instanceName: "default",
          updateId: 109,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "en",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair deliverable completion replies when telegram-out files are present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }
        await writeFile(path.join(requestOutputDir, "report.txt"), "report", "utf8");
        return { text: "Report generated: report.txt" };
      }),
    };
    const sendTelegramOutFile = vi.fn();

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate a report file"),
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
          instanceName: "default",
          updateId: 107,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile,
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(sendTelegramOutFile).toHaveBeenCalledWith(123, "report.txt", expect.any(Uint8Array));
      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "file.accepted",
        channel: "telegram",
        outcome: "accepted",
        metadata: expect.objectContaining({
          fileName: "report.txt",
          via: "telegram-out",
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-delivers telegram-out image batches beyond the legacy small-file limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }
        for (let index = 1; index <= 9; index += 1) {
          await writeFile(path.join(requestOutputDir, `${String(index).padStart(2, "0")}.png`), Buffer.alloc(600_000));
        }
        return { text: "9 images generated." };
      }),
    };
    const sendTelegramOutFile = vi.fn();

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate 9 images"),
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
          instanceName: "default",
          updateId: 108,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile,
      });

      expect(sendTelegramOutFile).toHaveBeenCalledTimes(9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not auto-deliver hidden telegram-out files as user attachments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }
        await writeFile(path.join(requestOutputDir, ".scratch.json"), JSON.stringify({ internal: true }));
        await writeFile(path.join(requestOutputDir, "01.png"), Buffer.alloc(64));
        return { text: "Done." };
      }),
    };
    const sendTelegramOutFile = vi.fn();

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("make the first option"),
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
          instanceName: "default",
          updateId: 113,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile,
      });

      expect(sendTelegramOutFile).toHaveBeenCalledTimes(1);
      expect(sendTelegramOutFile).toHaveBeenCalledWith(123, "01.png", expect.any(Uint8Array));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair deliverable completion replies when the response contains an inline file block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "Report generated:\n```file:report.txt\nhello\n```";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("generate a report file"),
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
          instanceName: "default",
          updateId: 111,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        undefined,
        "en",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair deliverable completion replies when the side-channel has accepted receipts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const deliveredPath = path.join(root, "workspace", "chart.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "Image generated: chart.png",
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate an image file"),
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
          instanceName: "default",
          updateId: 110,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => [],
          getDeliveryReceipts: () => ({
            accepted: [
              {
                path: deliveredPath,
                realPath: deliveredPath,
                fileName: "chart.png",
                bytes: 3,
                source: "side-channel",
              },
            ],
            rejected: [],
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createSideChannelSendHelper: vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper")),
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "Image generated: chart.png",
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a delivery ledger mismatch when sent side-channel paths lack receipts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const deliveredPath = path.join(root, "workspace", "chart.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "Image generated: chart.png",
      }),
    };

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate an image file"),
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
          instanceName: "default",
          updateId: 112,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => [deliveredPath],
          getDeliveryReceipts: () => ({
            accepted: [],
            rejected: [],
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createSideChannelSendHelper: vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper")),
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile: vi.fn(),
      });

      const timeline = parseTimelineEvents(await readFile(path.join(root, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "delivery.ledger_mismatch",
        channel: "telegram",
        outcome: "error",
        metadata: expect.objectContaining({
          missingAcceptedReceipts: [deliveredPath],
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair explicit multi-file requests when fewer files were delivered than requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const deliveredPath = path.join(root, "workspace", "chart-1.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: "Generated 2 images: chart-1.png and chart-2.png",
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(2);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate 2 images"),
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
          instanceName: "default",
          updateId: 111,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => [],
          getDeliveryReceipts: () => ({
            accepted: [
              {
                path: deliveredPath,
                realPath: deliveredPath,
                fileName: "chart-1.png",
                bytes: 3,
                source: "side-channel",
              },
            ],
            rejected: [],
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createSideChannelSendHelper: vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper")),
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        "Generated 2 images: chart-1.png and chart-2.png",
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair short done replies when explicit multi-file delivery is incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const chartOnePath = path.join(root, "workspace", "chart-1.png");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: `Done\n[send-file:${chartOnePath}]`,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(2);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate 2 images"),
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
          instanceName: "default",
          updateId: 112,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        `Done\n[send-file:${chartOnePath}]`,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
        expect.objectContaining({
          source: "post-turn",
          onDeliveryAccepted: expect.any(Function),
          onDeliveryRejected: expect.any(Function),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair explicit multi-file requests when the reply reports partial delivery failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const chartOnePath = path.join(root, "workspace", "chart-1.png");
    const responseText = `Only one image was delivered; the second failed.\n[send-file:${chartOnePath}]`;
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(1);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("generate 2 images"),
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
          instanceName: "default",
          updateId: 113,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "en",
        expect.objectContaining({
          source: "post-turn",
          onDeliveryAccepted: expect.any(Function),
          onDeliveryRejected: expect.any(Function),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair explanatory text that quotes deferred-delivery phrases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const explanatoryText = [
      "现在逻辑链是：",
      "1. 如果 engine 最终回复里出现类似“等通知 / 等 batch 通知 / wait for notification”，bridge 不会把这条回复发给 Telegram。",
      "2. 这不是直接承诺稍后通知，而是在解释拦截机制。",
      "所以现在不是只改 prompt 了。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: explanatoryText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("解释逻辑"),
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
          instanceName: "bot6",
          updateId: 104,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        explanatoryText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair delivery-guard audit replies when the user did not request deliverables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const auditText = [
      "这次问题是 deliverable guard 的误判：",
      "如果回复里写到交付物正在后台处理中，稍后会发送，旧逻辑可能把纯讨论当成未完成交付。",
      "这里没有真实文件任务，只是在审计代码路径。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: auditText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("审一下 deliverable guard 的 bug"),
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
          instanceName: "bot6",
          updateId: 106,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        auditText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair non-deliverable review replies that mention deferred delivery without explanatory keywords", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const reviewText = [
      "发现一个问题：",
      "交付物正在后台处理中，稍后会发送。",
      "这句话如果出现在纯代码 review 里，不应该触发交付修复。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: reviewText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("看看代码还有什么问题"),
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
          instanceName: "bot6",
          updateId: 107,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        reviewText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair short deferred-like replies without a delivery contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const responseText = "这个 batch 已启动，稍后检查。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("这个机制该怎么做"),
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
          instanceName: "bot6",
          updateId: 110,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat delivery-architecture discussions as deliverable requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const requestText = [
      "还不完美的地方：",
      "下一步不要再加 manifest/schema 复杂度，应该继续把主链路压到：生成文件 → 显式 send → receipt 确认。",
      "怎么解决",
    ].join("\n");
    const responseText = [
      "解决方向：把 repair 从主逻辑降级成保险丝。",
      "用户要文件/图片时，agent 必须：生成文件 → 调 CCTB_SEND_COMMAND / telegram send → 等命令退出 → 结束 turn。",
      "正则只拦两类明显坏回复：",
      "- “batch 跑起来了 / 等通知 / 稍后检查”但没发文件",
      "- 非用户明确要求时用了 ScheduleWakeup",
      "普通聊天完全不进交付系统。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage(requestText),
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
          instanceName: "bot6",
          updateId: 112,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair manifest/schema explanation turns that quote the send path even when recent files exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const workspaceDir = path.join(root, "workspace");
    const recentPath = path.join(workspaceDir, "recent.png");
    const requestText = [
      "”下一步不要再加 manifest/schema 复杂度，应该继续把主链路压到：生成文件 → 显式 send → receipt 确认“这个什么意思？",
      "manifest/schema 复杂度是什么？我们不是已经不用manifest这种无聊又没用的东西了吗",
    ].join("\n");
    const responseText = [
      "你理解对了：manifest 已经不该作为主方案了。",
      "不要再设计一堆字段让 bridge 去猜：",
      "- 这次应该产出几张图",
      "- 每张图是什么类型",
      "更干净的主链路应该是：",
      "生成文件 → 显式调用 send → send 成功返回 receipt → 这就算交付完成",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(recentPath, "png");

      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex", resume: { workspacePath: workspaceDir } },
        normalized: createNormalizedMessage(requestText),
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
          instanceName: "bot6",
          updateId: 113,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        workspaceDir,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply an active delivery contract to unrelated discussion turns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const now = new Date();
    await writeFile(path.join(root, "delivery-contracts.json"), JSON.stringify({
      records: [
        {
          chatId: 123,
          userId: 456,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ],
    }));
    const responseText = "这个 batch 已启动，稍后检查。";
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: responseText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("这个机制该怎么做"),
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
          instanceName: "bot6",
          updateId: 111,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        responseText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat continue-code-review requests as delivery status checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const reviewText = [
      "继续看这段代码的话，风险点在这里：",
      "交付物正在后台处理中，稍后会发送。",
      "这句话只是测试 guard，不代表当前 turn 有文件要交付。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: reviewText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("继续看代码还有什么问题"),
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
          instanceName: "bot6",
          updateId: 108,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        reviewText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat missing-file complaints as fresh deliverable requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const diagnosticText = [
      "不是白改，是又暴露了第二个漏判。",
      "最后只回了：“P1 + batch 都跑起来了。我设了 4.5 分钟主动 check，不被动等回执。”",
      "日志显示那轮没有 file.accepted，也没有触发 repair。",
      "已补测试并修复 ScheduleWakeup + batch 跑起来的漏判。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: diagnosticText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("还是没发我文件，白改"),
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
          instanceName: "bot6",
          updateId: 109,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        diagnosticText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair screenshot analysis that describes deferred-delivery failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const explanatoryText = [
      "截图里有两个问题叠在一起：",
      "",
      "1. **05:52 / 06:05 的“等通知 / 等 batch 通知”是错误行为。**",
      "这是模型把后台 batch 放出去后提前结束 turn。",
      "",
      "正确修复方向应该是机制层：",
      "- 拦截“等通知 / 等 batch 通知”这种未交付回复，强制继续等待并交付。",
      "- 不能只靠 prompt，因为 prompt 只能降低概率，不能保证运行时安全。",
    ].join("\n");
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({
        text: explanatoryText,
      }),
    };
    const deliverTelegramResponse = vi.fn().mockResolvedValue(0);

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "zh",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("分析截图"),
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
          instanceName: "bot6",
          updateId: 105,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(deliverTelegramResponse).toHaveBeenCalledWith(
        expect.anything(),
        123,
        explanatoryText,
        expect.any(String),
        undefined,
        expect.stringContaining(path.join("workspace", ".telegram-out")),
        "zh",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for stream deliveries to settle when the engine turn fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const generatedPath = path.join(root, "workspace", "chart.png");
    let resolveDelivery: () => void = () => {};
    const deliverySettled = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async (input) => {
        input.onEngineEvent?.({
          type: "assistant_text",
          text: `Generated chart.\n[send-file:${generatedPath}]`,
        });
        throw new Error("engine failed");
      }),
    };
    type DeliverTelegramResponse = Parameters<typeof executeWorkflowAwareTelegramTurn>[0]["deliverTelegramResponse"];
    const deliverTelegramResponse = vi.fn(async (
      ...args: Parameters<DeliverTelegramResponse>
    ) => {
      const text = args[2];
      const options = args[7];
      if (text.includes("[send-file:")) {
        options?.onFileAccepted?.(generatedPath);
      }
      await deliverySettled;
      return 1;
    }) as DeliverTelegramResponse;

    try {
      const turn = executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "claude" },
        normalized: createNormalizedMessage("make chart"),
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
          instanceName: "default",
          updateId: 100,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        deliverTelegramResponse,
        sendTelegramOutFile: vi.fn(),
      });
      let settled = false;
      turn.catch(() => {
        settled = true;
      });

      await vi.waitFor(() => {
        expect(deliverTelegramResponse).toHaveBeenCalled();
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);

      resolveDelivery();
      await expect(turn).rejects.toThrow("engine failed");
    } finally {
      resolveDelivery();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records side-channel delivered files before rethrowing an engine failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const deliveredPath = path.join(root, "workspace", "moon-ultraclear-4x.png");
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("stream disconnected before completion")),
    };

    try {
      await expect(executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("enhance image"),
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
          instanceName: "default",
          updateId: 101,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => [deliveredPath],
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createSideChannelSendHelper: vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper")),
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile: vi.fn(),
      })).rejects.toThrow("stream disconnected before completion");

      expect(state).toMatchObject({
        deliveredFilesBeforeError: [deliveredPath],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resend telegram-out files already delivered by the side-channel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-message-turn-"));
    const state = {
      archiveSummaryDelivered: false,
      workflowRecordId: undefined as string | undefined,
      failureHint: undefined as string | undefined,
    };
    const deliveredPaths: string[] = [];
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }
        const filePath = path.join(requestOutputDir, "report.txt");
        await writeFile(filePath, "report", "utf8");
        deliveredPaths.push(filePath);
        return { text: "Done" };
      }),
    };
    const sendTelegramOutFile = vi.fn();

    try {
      await executeWorkflowAwareTelegramTurn({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { engine: "codex" },
        normalized: createNormalizedMessage("make report"),
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
          instanceName: "default",
          updateId: 102,
        },
        workflowStore: {
          update: vi.fn(),
        } as never,
        downloadedAttachments: [],
        state,
        startSideChannelSendServer: vi.fn().mockResolvedValue({
          url: "http://127.0.0.1:12345/send/token",
          token: "token",
          getSentFilePaths: () => deliveredPaths,
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createSideChannelSendHelper: vi.fn().mockResolvedValue(path.join(root, "workspace", ".cctb-send", "helper")),
        deliverTelegramResponse: vi.fn().mockResolvedValue(0),
        sendTelegramOutFile,
      });

      expect(sendTelegramOutFile).not.toHaveBeenCalled();
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
