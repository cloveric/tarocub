import { describe, expect, it, vi } from "vitest";

import { dispatchAuthorizedTelegramMessage } from "../src/telegram/authorized-dispatch.js";
import type { WorkflowAwareTurnState } from "../src/telegram/message-turn.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

function createTurnState(): WorkflowAwareTurnState {
  return {
    archiveSummaryDelivered: false,
    workflowRecordId: undefined,
    failureHint: undefined,
    telegramOutDirPath: undefined,
  };
}

describe("dispatchAuthorizedTelegramMessage", () => {
  it("short-circuits after the first handled command", async () => {
    const normalized = createNormalizedMessage("/reset");
    const handleLocalSessionTelegramCommand = vi.fn().mockResolvedValue(true);
    const handleLocalEngineTelegramCommand = vi.fn();
    const handleSimpleLocalTelegramCommand = vi.fn();
    const handleDelegationTelegramCommand = vi.fn();
    const prepareTelegramMessageInput = vi.fn();
    const executeWorkflowAwareTelegramTurn = vi.fn();

    await dispatchAuthorizedTelegramMessage({
      stateDir: "/tmp/state",
      startedAt: Date.now(),
      locale: "en",
      cfg: { engine: "codex" },
      normalized,
      context: {
        api: {
          sendMessage: vi.fn(),
          getFile: vi.fn(),
          downloadFile: vi.fn(),
        },
        bridge: {},
        inboxDir: "/tmp/inbox",
      } as never,
      workflowStore: {
        inspect: vi.fn(),
        update: vi.fn(),
      } as never,
      deps: {
        sessionStore: {
          inspect: vi.fn(),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
          findByChatIdSafe: vi.fn(),
        } as never,
        turnState: createTurnState(),
        updateInstanceConfig: vi.fn(),
        deliverTelegramResponse: vi.fn(),
        sendTelegramOutFile: vi.fn(),
        updateWorkflowBestEffort: vi.fn(),
      },
      handlers: {
        handleLocalSessionTelegramCommand,
        handleLocalEngineTelegramCommand,
        handleSimpleLocalTelegramCommand,
        handleDelegationTelegramCommand,
        prepareTelegramMessageInput,
        executeWorkflowAwareTelegramTurn,
      },
    });

    expect(handleLocalSessionTelegramCommand).toHaveBeenCalledTimes(1);
    expect(handleLocalEngineTelegramCommand).not.toHaveBeenCalled();
    expect(handleSimpleLocalTelegramCommand).not.toHaveBeenCalled();
    expect(handleDelegationTelegramCommand).not.toHaveBeenCalled();
    expect(prepareTelegramMessageInput).not.toHaveBeenCalled();
    expect(executeWorkflowAwareTelegramTurn).not.toHaveBeenCalled();
  });

  it("prepares input and runs the workflow-aware turn when no command handles the message", async () => {
    const normalized = createNormalizedMessage("hello");
    const downloadedAttachments = [{ attachment: { fileId: "doc-1", kind: "document" }, localPath: "/tmp/doc-1.txt" }];
    const executeWorkflowAwareTelegramTurn = vi.fn().mockResolvedValue(undefined);

    await dispatchAuthorizedTelegramMessage({
      stateDir: "/tmp/state",
      startedAt: 100,
      locale: "en",
      cfg: {
        engine: "claude",
        budgetUsd: 1.5,
        effort: "high",
        model: "claude-sonnet",
        resume: {
          sessionId: "session-1",
          dirName: "project-dir",
          workspacePath: "/tmp/workspace",
        },
      },
      normalized,
      context: {
        api: {
          sendMessage: vi.fn(),
          getFile: vi.fn(),
          downloadFile: vi.fn(),
        },
        bridge: {},
        inboxDir: "/tmp/inbox",
      } as never,
      workflowStore: {
        inspect: vi.fn(),
        update: vi.fn(),
      } as never,
      deps: {
        sessionStore: {
          inspect: vi.fn(),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
          findByChatIdSafe: vi.fn(),
        } as never,
        turnState: createTurnState(),
        updateInstanceConfig: vi.fn(),
        deliverTelegramResponse: vi.fn(),
        sendTelegramOutFile: vi.fn(),
        updateWorkflowBestEffort: vi.fn(),
      },
      handlers: {
        handleLocalSessionTelegramCommand: vi.fn().mockResolvedValue(false),
        handleLocalEngineTelegramCommand: vi.fn().mockResolvedValue(false),
        handleSimpleLocalTelegramCommand: vi.fn().mockResolvedValue(false),
        handleDelegationTelegramCommand: vi.fn().mockResolvedValue(false),
        prepareTelegramMessageInput: vi.fn().mockResolvedValue({
          kind: "ready",
          text: "hello\ntranscript",
          downloadedAttachments,
        }),
        executeWorkflowAwareTelegramTurn,
      },
    });

    expect(normalized.text).toBe("hello\ntranscript");
    expect(executeWorkflowAwareTelegramTurn).toHaveBeenCalledWith(expect.objectContaining({
      stateDir: "/tmp/state",
      normalized,
      downloadedAttachments,
      state: expect.objectContaining({ archiveSummaryDelivered: false }),
      cfg: expect.objectContaining({
        engine: "claude",
        budgetUsd: 1.5,
        resume: expect.objectContaining({ workspacePath: "/tmp/workspace" }),
      }),
    }));
  });

  it("sends input-preparation replies without entering the workflow-aware turn", async () => {
    const normalized = createNormalizedMessage("voice");
    const sendMessage = vi.fn();
    const executeWorkflowAwareTelegramTurn = vi.fn();

    await dispatchAuthorizedTelegramMessage({
      stateDir: "/tmp/state",
      startedAt: Date.now(),
      locale: "zh",
      cfg: { engine: "codex" },
      normalized,
      context: {
        api: {
          sendMessage,
          getFile: vi.fn(),
          downloadFile: vi.fn(),
        },
        bridge: {},
        inboxDir: "/tmp/inbox",
      } as never,
      workflowStore: {
        inspect: vi.fn(),
        update: vi.fn(),
      } as never,
      deps: {
        sessionStore: {
          inspect: vi.fn(),
          removeByChatId: vi.fn(),
          upsert: vi.fn(),
          findByChatIdSafe: vi.fn(),
        } as never,
        turnState: createTurnState(),
        updateInstanceConfig: vi.fn(),
        deliverTelegramResponse: vi.fn(),
        sendTelegramOutFile: vi.fn(),
        updateWorkflowBestEffort: vi.fn(),
      },
      handlers: {
        handleLocalSessionTelegramCommand: vi.fn().mockResolvedValue(false),
        handleLocalEngineTelegramCommand: vi.fn().mockResolvedValue(false),
        handleSimpleLocalTelegramCommand: vi.fn().mockResolvedValue(false),
        handleDelegationTelegramCommand: vi.fn().mockResolvedValue(false),
        prepareTelegramMessageInput: vi.fn().mockResolvedValue({
          kind: "reply",
          text: "语音转写失败，请发送文字消息。",
        }),
        executeWorkflowAwareTelegramTurn,
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(123, "语音转写失败，请发送文字消息。");
    expect(executeWorkflowAwareTelegramTurn).not.toHaveBeenCalled();
  });
});
