import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import { handleBoardTelegramCommand, type BoardCommandContext } from "../telegram/board-commands.js";
import {
  handleCrewTelegramWorkflow,
  type CrewWorkflowContext,
} from "../telegram/crew-workflow.js";
import {
  handleDelegationTelegramCommand,
  type DelegationCommandBridge,
  type DelegationCommandContext,
} from "../telegram/delegation-commands.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import {
  handleMiniBusTelegramCommand,
  type MiniBusCommandBridge,
  type MiniBusCommandContext,
} from "../telegram/mini-bus-commands.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import type { Locale } from "../telegram/message-renderer.js";
import {
  stableLarkNumericId,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { deliverLarkResponse, sendLarkMarkdown } from "./delivery.js";
import { renderLarkBackgroundTaskHeader, resolveLarkLocale } from "./locale.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkServiceRuntime } from "./runtime.js";
import { appendLarkTimelineEvent } from "./timeline.js";
import type { LarkBridgeLike, LarkChannelLike } from "./types.js";

type LarkBusCommandInput = {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  requestApproval: (input: {
    channel: LarkChannelLike;
    runtime: LarkServiceRuntime;
    chatId: string;
    conversationKey?: string;
    bridgeChatType?: "private" | "group";
    replyTo?: string;
    replyInThread?: boolean;
    locale?: Locale;
    request: EngineApprovalRequest;
    abortSignal?: AbortSignal;
  }) => Promise<EngineApprovalDecision>;
};

export async function handleLarkBoardCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const abortController = new AbortController();
  const boardContext: BoardCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    bridge: input.bridge,
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "board",
      workspaceOverride: cfg.resume?.workspacePath,
    }),
  };

  return await handleBoardTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    normalized: toBoardTelegramMessage(normalized, commandText),
    context: boardContext,
  });
}

function toBoardTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleLarkMiniBusCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const abortController = new AbortController();
  const context: MiniBusCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: "lark",
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: input.runtime.miniRuntime?.runQueuedBridgeTurn
      ?? (async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job)),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "mini",
      workspaceOverride: cfg.resume?.workspacePath,
    }),
  };
  const bridge: MiniBusCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage(bridgeInput),
  };

  return await handleMiniBusTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized: toMiniBusTelegramMessage(normalized, commandText),
    context,
    bridge,
  });
}

function toMiniBusTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  const groupChatId = normalized.bridgeChatType === "group"
    ? stableLarkNumericId(`lark-group:${normalized.chatId}`)
    : normalized.bridgeChatId;
  const messageThreadId = normalized.threadId
    ? stableLarkNumericId(`lark-thread:${normalized.threadId}`)
    : undefined;

  return {
    chatId: groupChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleLarkDelegationCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const context: DelegationCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: "lark",
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "delegation",
      workspaceOverride: cfg.resume?.workspacePath,
    }),
  };
  const bridge: DelegationCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => {
      const delegatedInput: Parameters<LarkBridgeLike["handleAuthorizedMessage"]>[0] = {
        ...bridgeInput,
        workspaceOverride: bridgeInput.workspaceOverride,
      };
      if (bridgeInput.chatType !== "bus") {
        delegatedInput.conversationKey = normalized.conversationKey;
      }
      return await input.bridge.handleAuthorizedMessage(delegatedInput);
    },
  };

  return await handleDelegationTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized: toDelegationTelegramMessage(normalized, commandText),
    context,
    bridge,
    loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
    delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
  });
}

export async function handleLarkCrewWorkflow(
  input: LarkBusCommandInput & {
    abortSignal?: AbortSignal;
  },
  normalized: LarkNormalizedBridgeMessage,
  prompt: string,
): Promise<boolean> {
  if (normalized.attachments.length > 0) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const context: CrewWorkflowContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: "lark",
    abortSignal: input.abortSignal,
    bridge: {
      handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage(bridgeInput),
    },
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? input.abortSignal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "crew",
      workspaceOverride: cfg.resume?.workspacePath,
    }),
  };

  return await handleCrewTelegramWorkflow({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized: toDelegationTelegramMessage(normalized, prompt),
    context,
    loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
    delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
  });
}

function larkCommandReplyOptions(normalized: LarkNormalizedBridgeMessage): { replyTo: string; replyInThread: boolean } {
  return {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  };
}

function createLarkBusEngineEventHandler(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  options: {
    locale: "en" | "zh";
    source: string;
    workspaceOverride?: string;
  },
): (event: EngineStreamEvent) => Promise<void> {
  return async (event) => {
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "engine.event",
      detail: event.type,
      metadata: {
        source: options.source,
        toolName: "toolName" in event ? event.toolName : undefined,
        textChars: "text" in event ? event.text.length : undefined,
        status: "status" in event ? event.status : undefined,
      },
    });

    if (event.type !== "task_notification") {
      return;
    }

    const notificationText = [
      renderLarkBackgroundTaskHeader(options.locale),
      event.text.trim(),
    ].filter(Boolean).join("\n");

    try {
      await deliverLarkResponse({
        channel: input.channel,
        runtime: input.runtime,
        chatId: normalized.chatId,
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
        text: notificationText,
        stateDir: input.stateDir,
        workspaceOverride: options.workspaceOverride,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        bridgeChatId: normalized.bridgeChatId,
        bridgeUserId: normalized.bridgeUserId,
        larkThreadId: normalized.threadId,
        larkMessageId: normalized.messageId,
      });
    } catch (error) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "engine.event.delivery_failed",
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        metadata: {
          source: options.source,
          eventType: event.type,
        },
      });
    }
  };
}

function toDelegationTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}
