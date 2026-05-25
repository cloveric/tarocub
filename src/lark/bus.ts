import type { EngineApprovalDecision, EngineApprovalRequest } from "../codex/adapter.js";
import { handleBoardTelegramCommand, type BoardCommandContext } from "../telegram/board-commands.js";
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
import {
  stableLarkNumericId,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import type { LarkServiceRuntime } from "./runtime.js";
import type { LarkBridgeLike, LarkChannelLike } from "./service.js";

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
  const abortController = new AbortController();
  const boardContext: BoardCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await input.channel.send(normalized.chatId, { markdown: text }, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
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
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
  };

  return await handleBoardTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
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
  const abortController = new AbortController();
  const context: MiniBusCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await input.channel.send(normalized.chatId, { markdown: text }, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
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
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
  };
  const bridge: MiniBusCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage(bridgeInput),
  };

  return await handleMiniBusTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
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
  const context: DelegationCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await input.channel.send(normalized.chatId, { markdown: text }, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: "lark",
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
    locale: "zh",
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
