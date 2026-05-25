import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createLarkChannel,
  type CardActionEvent,
  type CommentEvent,
  type LarkChannelOptions,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import type { BridgeAccessDecision } from "../runtime/bridge.js";
import { createBridgeDependencies } from "../service.js";
import {
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
  type DownloadedAttachment,
  type FileWorkflowResult,
} from "../runtime/file-workflow.js";
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "../telegram/approval-timeouts.js";
import {
  extractDeliveryTagMatches,
  stripDeliveryTags,
} from "../telegram/delivery-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
  stripTelegramToolTags,
} from "../telegram/tool-tags.js";
import { applyEngineSelection, loadInstanceConfig, updateInstanceConfig, type EffortLevel, type InstanceConfig, type InstanceEngine, type ResumeState } from "../telegram/instance-config.js";
import { renderUsageMessage } from "../telegram/message-renderer.js";
import { handleLocalSessionTelegramCommand } from "../telegram/session-commands.js";
import { handleLocalEngineTelegramCommand } from "../telegram/engine-commands.js";
import { handleBoardTelegramCommand, type BoardCommandContext } from "../telegram/board-commands.js";
import {
  handleDelegationTelegramCommand,
  type DelegationCommandBridge,
  type DelegationCommandContext,
} from "../telegram/delegation-commands.js";
import {
  handleMiniBusTelegramCommand,
  type MiniBusCommandBridge,
  type MiniBusCommandContext,
} from "../telegram/mini-bus-commands.js";
import type { NormalizedTelegramAttachment, NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { CronStore } from "../state/cron-store.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { UsageStore } from "../state/usage-store.js";
import { handleCronCommand, isCronCommand } from "../telegram/cron-commands.js";
import { renderLarkApprovalCard } from "./card-renderer.js";
import {
  createLarkCommentClient,
  type LarkCommentContext,
  type LarkCommentFileType,
} from "./comment-client.js";
import { resolveLarkRuntimeConfig, type LarkRuntimeConfig, type LarkRuntimeEnv } from "./config.js";
import { buildLarkCronExecutor } from "./cron.js";
import { parseLarkDocumentCreateInput } from "./document-client.js";
import {
  normalizeLarkMessage,
  stableLarkNumericId,
  type LarkIncomingMessage,
  type LarkNormalizedBridgeMessage,
  type LarkNormalizedAttachment,
} from "./message-normalizer.js";
import { assertStableLarkIdMappings, verifyLarkNumericIds } from "./id-map.js";
import {
  createLarkServiceRuntime,
  type LarkServiceRuntime,
  type PendingLarkApproval,
} from "./runtime.js";
import { acquireLarkServiceLock } from "./service-lock.js";

export { createLarkDocumentWithCli } from "./document-client.js";
export type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
export { buildLarkCronExecutor } from "./cron.js";
export { resolveLarkRuntimeConfig } from "./config.js";
export type { LarkRuntimeConfig, LarkRuntimeEnv } from "./config.js";
export { createLarkServiceRuntime } from "./runtime.js";
export { resolveLarkServiceLockDir, resolveLarkServiceLockPath } from "./service-lock.js";

export interface LarkSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface LarkStreamControllerLike {
  messageId: string;
  current: object;
  update(card: object | ((current: object) => object)): Promise<void>;
}

export interface LarkChannelLike {
  send(to: string, input: unknown, opts?: LarkSendOptions): Promise<{ messageId: string }>;
  stream(to: string, input: {
    card: {
      initial: object;
      producer: (controller: LarkStreamControllerLike) => Promise<void>;
    };
  }, opts?: LarkSendOptions): Promise<{ messageId: string }>;
  updateCard?(messageId: string, card: object): Promise<void>;
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
}

type LarkSendPathKind = "file" | "image" | "audio" | "video";

type DownloadedLarkAttachment = {
  attachment: LarkNormalizedAttachment;
  localPath: string;
};

const VALID_LARK_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const LARK_ENGINE_CHOICES: InstanceEngine[] = ["claude", "codex", "antigravity"];

export interface LarkRuntimeChannelLike extends LarkChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: "cardAction", handler: (event: CardActionEvent) => void | Promise<void>): () => void;
  on(name: "comment", handler: (event: CommentEvent) => void | Promise<void>): () => void;
  on(name: "error", handler: (error: Error) => void): () => void;
}

export interface LarkBridgeLike {
  checkAccess?(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  checkUserAuthorization?(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    locale?: "en" | "zh";
    text: string;
    conversationKey?: string;
    files: string[];
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    instructions?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } }>;
  validateCodexThread?(threadId: string): Promise<void>;
  getThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  setThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  clearThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ cleared: boolean }>;
}

export interface LarkServiceLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export async function runLarkService(
  env: LarkRuntimeEnv = process.env,
  options: {
    createChannel?: (options: LarkChannelOptions) => LarkRuntimeChannelLike;
    createBridge?: (env: LarkRuntimeEnv, config: LarkRuntimeConfig) => Promise<{ stateDir: string; bridge: LarkBridgeLike }>;
    runtime?: LarkServiceRuntime;
    signal?: AbortSignal;
    logger?: LarkServiceLogger;
  } = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const config = resolveLarkRuntimeConfig(env);
  const bridgeEnv = {
    ...env,
    CODEX_TELEGRAM_STATE_DIR: config.stateDir,
    CODEX_TELEGRAM_INSTANCE: "lark",
  };
  const { stateDir, bridge } = options.createBridge
    ? await options.createBridge(bridgeEnv, config)
    : await createDefaultLarkBridge(bridgeEnv);
  const runtime = options.runtime ?? createLarkServiceRuntime();
  runtime.commentClient ??= createLarkCommentClient(config);
  const serviceLock = await acquireLarkServiceLock(stateDir);
  let channel: LarkRuntimeChannelLike | undefined;
  let connected = false;
  let cronScheduler: CronScheduler | undefined;
  try {
    const channelOptions: LarkChannelOptions = {
      appId: config.appId,
      appSecret: config.appSecret,
      transport: "websocket",
      source: "cc-telegram-bridge",
      safety: {
        chatQueue: {
          enabled: false,
        },
      },
      ...(config.domain !== undefined ? { domain: config.domain } : {}),
    };
    channel = options.createChannel
      ? options.createChannel(channelOptions)
      : createLarkChannel(channelOptions) as LarkRuntimeChannelLike;

    channel.on("message", async (message) => {
      try {
        await handleLarkMessage({
          channel: channel!,
          bridge,
          runtime,
          stateDir,
          message,
          requireMentionInGroup: config.requireMentionInGroup,
        });
      } catch (error) {
        logger.error("Lark message handling failed:", error);
        await channel!.send(message.chatId, {
          text: renderLarkUserFacingError(error, "engine"),
        }, { replyTo: message.messageId }).catch(() => undefined);
      }
    });
    channel.on("cardAction", async (event) => {
      try {
        await handleLarkCardAction({ channel: channel!, bridge, runtime, stateDir, event });
      } catch (error) {
        logger.error("Lark card action handling failed:", error);
      }
    });
    channel.on("comment", async (event) => {
      try {
        await handleLarkComment({ bridge, runtime, stateDir, event });
      } catch (error) {
        logger.error("Lark comment handling failed:", error);
        if (event.mentionedBot && runtime.commentClient) {
          await runtime.commentClient.createReply({
            fileToken: event.fileToken,
            fileType: normalizeLarkCommentFileType(event.fileType),
            commentId: event.commentId,
            text: renderLarkUserFacingError(error, "engine"),
          }).catch(() => undefined);
        }
      }
    });
    channel.on("error", (error) => {
      logger.error("Lark channel error:", error);
    });

    await channel.connect();
    connected = true;
    if (!runtime.cronRuntime) {
      const cronStore = new CronStore(stateDir);
      cronScheduler = new CronScheduler({
        store: cronStore,
        executor: buildLarkCronExecutor({
          channel,
          bridge,
          runtime,
          stateDir,
          agentInstructions: larkAgentInstructions,
          deliverResponse: deliverLarkResponse,
        }),
        stateDir,
        instanceName: bridgeEnv.CODEX_TELEGRAM_INSTANCE,
        onJobFailure: async (job, detail) => {
          if (job.channel !== "lark" || !job.larkChatId || job.mute) {
            return;
          }
          await channel!.send(job.larkChatId, {
            text: job.locale === "zh"
              ? `⚠️ 定时任务执行失败\nID  ${job.id}\n📝 ${job.prompt}\n错误：${detail}`
              : `⚠️ Scheduled task failed\nID  ${job.id}\n📝 ${job.prompt}\nError: ${detail}`,
          });
        },
      });
      await cronScheduler.start();
      runtime.cronRuntime = { store: cronStore, scheduler: cronScheduler };
    }
    logger.log(`Lark channel connected; stateDir=${stateDir}; lock=${serviceLock.filePath}`);
    await waitForAbort(options.signal);
  } finally {
    try {
      if (cronScheduler) {
        await cronScheduler.stop();
      }
      if (connected && channel) {
        await channel.disconnect();
      }
    } finally {
      await serviceLock.release();
    }
  }
}

export async function handleLarkComment(input: {
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  event: CommentEvent;
  workspaceOverride?: string;
}): Promise<boolean> {
  if (!input.event.mentionedBot) {
    return false;
  }
  if (!input.runtime.commentClient) {
    throw new Error("Lark comment client is not configured");
  }

  const fileType = normalizeLarkCommentFileType(input.event.fileType);
  const operatorRawId = larkOperatorRawId(input.event.operator);
  const conversationKey = `lark-comment:${input.event.fileToken}`;
  const bridgeChatId = stableLarkNumericId(conversationKey);
  const bridgeUserId = stableLarkNumericId(`user:${operatorRawId}`);
  await assertStableLarkIdMappings(input.stateDir, [
    ["chat", bridgeChatId, conversationKey],
    ["user", bridgeUserId, operatorRawId],
  ]);

  const accessDecision = input.bridge.checkUserAuthorization
    ? await input.bridge.checkUserAuthorization({
      chatId: bridgeChatId,
      userId: bridgeUserId,
      chatType: "group",
      conversationKey,
      locale: "zh",
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await input.runtime.commentClient.createReply({
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
      text: accessDecision.text ?? "当前操作者未获授权。",
    });
    return true;
  }

  return await input.runtime.chatQueue.enqueue(conversationKey, async () => {
    const context = await input.runtime.commentClient!.getCommentContext({
      fileToken: input.event.fileToken,
      fileType,
      commentId: input.event.commentId,
    });
    const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.event.commentId));
    await mkdir(requestOutputDir, { recursive: true });
    try {
      const result = await input.bridge.handleAuthorizedMessage({
        chatId: bridgeChatId,
        userId: bridgeUserId,
        chatType: "group",
        conversationKey,
        text: buildLarkCommentPrompt(input.event, fileType, context),
        files: [],
        requestOutputDir,
        workspaceOverride: input.workspaceOverride,
        instructions: larkAgentInstructions(),
      });
      const cleaned = stripTelegramToolTags(stripDeliveryTags(result.text)).trim() || "（空回复）";
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: cleaned,
      });
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        channel: "lark",
        chatId: bridgeChatId,
        userId: bridgeUserId,
        conversationKey,
        outcome: "success",
        metadata: {
          larkSurface: "comment",
          fileToken: input.event.fileToken,
          fileType,
          commentId: input.event.commentId,
        },
      }, "Lark comment timeline event");
      return true;
    } catch (error) {
      await input.runtime.commentClient!.createReply({
        fileToken: input.event.fileToken,
        fileType,
        commentId: input.event.commentId,
        text: renderLarkUserFacingError(error, "engine"),
      });
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        channel: "lark",
        chatId: bridgeChatId,
        userId: bridgeUserId,
        conversationKey,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          larkSurface: "comment",
          fileToken: input.event.fileToken,
          fileType,
          commentId: input.event.commentId,
        },
      }, "Lark comment timeline event");
      return true;
    }
  });
}

export async function handleLarkMessage(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  message: LarkIncomingMessage;
  requireMentionInGroup?: boolean;
  workspaceOverride?: string;
}): Promise<boolean> {
  const normalized = normalizeLarkMessage(input.message, {
    requireMentionInGroup: input.requireMentionInGroup,
  });
  if (!normalized) {
    return false;
  }
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "input.received",
    outcome: "accepted",
    metadata: {
      messageId: normalized.messageId,
      attachments: normalized.attachments.length,
    },
  });
  await verifyLarkNumericIds(input.stateDir, normalized);

  const commandText = extractLarkMessageBody(normalized.text);
  if (isStopCommand(commandText)) {
    const active = input.runtime.activeRuns.get(normalized.conversationKey);
    active?.abortController.abort();
    const skippedQueued = input.runtime.chatQueue.clearPending(normalized.conversationKey);
    await input.channel.send(normalized.chatId, { text: active || skippedQueued ? "已停止。" : "当前没有正在运行的任务。" }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: active || skippedQueued ? "success" : "noop",
      detail: "/stop",
    });
    return true;
  }

  return await input.runtime.chatQueue.enqueue(normalized.conversationKey, async () => {
    return await runNormalizedLarkMessage(input, normalized);
  }, {
    onSkipped: async () => {
      await input.channel.send(normalized.chatId, { text: "已跳过排队中的任务。" }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
}

async function runNormalizedLarkMessage(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
    workspaceOverride?: string;
  },
  normalized: LarkNormalizedBridgeMessage,
): Promise<boolean> {
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale: "zh",
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await input.channel.send(normalized.chatId, { text: formatLarkAccessReply(accessDecision.text ?? "当前聊天未获授权。") }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "reply",
      detail: "access denied",
    });
    return true;
  }

  const commandText = extractLarkMessageBody(normalized.text);
  if (await handleLarkSimpleCommand(input, normalized, commandText)) {
    return true;
  }

  const abortController = new AbortController();

  let downloadedAttachments: DownloadedLarkAttachment[];
  let files: string[];
  let requestText = normalized.text;
  let workflowRecordId: string | undefined;
  let requestOutputDir: string;
  try {
    downloadedAttachments = await downloadLarkAttachments({
      channel: input.channel,
      stateDir: input.stateDir,
      messageId: normalized.messageId,
      attachments: normalized.attachments,
    });
    files = downloadedAttachments.map((attachment) => attachment.localPath);
    const workflowResult = await prepareLarkFileWorkflow({
      stateDir: input.stateDir,
      normalized,
      commandText,
      downloadedAttachments,
    });
    if (workflowResult?.workflowRecordId) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "workflow.prepared",
        detail: downloadedAttachments.length > 0 ? "attachment workflow prepared" : "workflow prepared",
        metadata: {
          workflowRecordId: workflowResult.workflowRecordId,
          kind: workflowResult.kind,
        },
      });
    }
    if (workflowResult?.kind === "reply") {
      const deliveryText = workflowResult.workflowRecordId
        ? boundArchiveSummaryForTelegram(workflowResult.text)
        : workflowResult.text;
      await input.channel.send(normalized.chatId, { markdown: deliveryText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "success",
        metadata: {
          responseChars: deliveryText.length,
          attachments: normalized.attachments.length,
          workflowRecordId: workflowResult.workflowRecordId,
        },
      });
      return true;
    }
    if (workflowResult?.kind === "direct") {
      requestText = workflowResult.text;
      files = [...workflowResult.files];
      workflowRecordId = workflowResult.workflowRecordId;
    }
    requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(normalized.messageId));
    await mkdir(requestOutputDir, { recursive: true });
  } catch (error) {
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        phase: "prepare",
      },
    });
    await input.channel.send(normalized.chatId, {
      text: renderLarkUserFacingError(error, "prepare"),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    return true;
  }

  input.runtime.activeRuns.set(normalized.conversationKey, { abortController });
  try {
    const result = await input.bridge.handleAuthorizedMessage({
      chatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      text: requestText,
      conversationKey: normalized.conversationKey,
      files,
      requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      abortSignal: abortController.signal,
      onApprovalRequest: async (request) => await requestLarkApproval({
        channel: input.channel,
        runtime: input.runtime,
        chatId: normalized.chatId,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        replyTo: normalized.messageId,
        request,
        abortSignal: request.abortSignal ?? abortController.signal,
      }),
      instructions: larkAgentInstructions(),
    });
    await deliverLarkResponse({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      text: result.text,
      stateDir: input.stateDir,
      requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
    });
    if (workflowRecordId) {
      await new FileWorkflowStore(input.stateDir).update(workflowRecordId, (record) => {
        record.status = "completed";
      });
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "workflow.completed",
        detail: "workflow marked completed",
        metadata: {
          workflowRecordId,
        },
      });
    }
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "success",
      metadata: {
        responseChars: result.text.length,
        attachments: normalized.attachments.length,
      },
    });
    return true;
  } catch (error) {
    await input.channel.send(normalized.chatId, {
      text: renderLarkUserFacingError(error, "engine"),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
    return true;
  } finally {
    input.runtime.activeRuns.delete(normalized.conversationKey);
  }
}

async function appendLarkTimelineEvent(
  stateDir: string,
  normalized: LarkNormalizedBridgeMessage,
  input: {
    type: Parameters<typeof appendTimelineEventBestEffort>[1]["type"];
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(stateDir, {
    type: input.type,
    channel: "lark",
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    conversationKey: normalized.conversationKey,
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      larkChatId: normalized.chatId,
      larkMessageId: normalized.messageId,
      bridgeChatType: normalized.bridgeChatType,
      ...input.metadata,
    },
  }, "Lark timeline event");
}

export async function requestLarkApproval(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  replyTo?: string;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}): Promise<EngineApprovalDecision> {
  if (input.abortSignal?.aborted) {
    return { behavior: "deny" };
  }

  const requestId = randomUUID();
  return await new Promise<EngineApprovalDecision>((resolve, reject) => {
    const cleanup = () => cleanupPendingApproval(input.runtime, requestId);
    const timer = setTimeout(() => {
      const pending = input.runtime.pendingApprovals.get(requestId);
      if (!pending) {
        return;
      }
      cleanup();
      pending.resolve({ behavior: "deny" });
      void input.channel.send(input.chatId, { text: "审批已过期，已拒绝。" }, { replyTo: input.replyTo }).catch(() => undefined);
    }, TELEGRAM_APPROVAL_TIMEOUT_MS);

    const pending: PendingLarkApproval = {
      requestId,
      chatId: input.chatId,
      ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
      ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      resolve,
      reject,
      timer,
      abortSignal: input.abortSignal,
    };

    if (input.abortSignal) {
      pending.abortHandler = () => {
        cleanup();
        resolve({ behavior: "deny" });
      };
      input.abortSignal.addEventListener("abort", pending.abortHandler, { once: true });
    }

    input.runtime.pendingApprovals.set(requestId, pending);
    input.channel.send(input.chatId, {
      card: renderLarkApprovalCard({
        requestId,
        toolName: input.request.toolName,
        toolInput: input.request.toolInput,
      }),
    }, { replyTo: input.replyTo }).catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function handleLarkCardAction(input: {
  channel: LarkChannelLike;
  bridge?: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir?: string;
  event: {
    messageId: string;
    chatId: string;
    operator?: {
      openId?: string;
      userId?: string;
      name?: string;
    };
    action: {
      value: unknown;
    };
  };
}): Promise<boolean> {
  const value = actionValue(input.event.action.value);
  if (!value) {
    return false;
  }

  if (value.cctb_lark === "stop" && typeof value.conversationKey === "string") {
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
    })) {
      return true;
    }
    const active = input.runtime.activeRuns.get(value.conversationKey);
    active?.abortController.abort();
    const skippedQueued = input.runtime.chatQueue.clearPending(value.conversationKey);
    await input.channel.send(input.event.chatId, { text: active || skippedQueued ? "已停止。" : "当前没有正在运行的任务。" }, {
      replyTo: input.event.messageId,
    });
    return true;
  }

  if (
    value.cctb_lark === "approval" &&
    typeof value.requestId === "string" &&
    isApprovalDecision(value.decision)
  ) {
    const pending = input.runtime.pendingApprovals.get(value.requestId);
    if (!pending) {
      await input.channel.send(input.event.chatId, { text: "没有待处理的审批。" }, {
        replyTo: input.event.messageId,
      });
      return true;
    }
    if (
      pending.conversationKey &&
      !await ensureLarkCardActionAccess({
        ...input,
        conversationKey: pending.conversationKey,
        bridgeChatType: pending.bridgeChatType ?? "private",
      })
    ) {
      return true;
    }
    cleanupPendingApproval(input.runtime, value.requestId);
    pending.resolve(renderApprovalDecision(value.decision));
    await input.channel.send(input.event.chatId, { text: renderApprovalResolution(value.decision) }, {
      replyTo: input.event.messageId,
    });
    return true;
  }

  if (value.cctb_lark === "choice" && typeof value.conversationKey === "string") {
    if (!input.bridge || !input.stateDir) {
      return false;
    }
    const bridgeChatType = bridgeChatTypeFromValue(value.bridgeChatType);
    if (!await ensureLarkCardActionAccess({
      ...input,
      conversationKey: value.conversationKey,
      bridgeChatType,
    })) {
      return true;
    }
    const label = typeof value.label === "string" ? value.label : "choice";
    const choiceValue = typeof value.value === "string" ? value.value : JSON.stringify(value.value ?? label);
    const text = [
      "<lark_card_action>",
      `message_id: ${input.event.messageId}`,
      `operator_id: ${input.event.operator?.openId ?? input.event.operator?.userId ?? "unknown"}`,
      input.event.operator?.name ? `operator_name: ${input.event.operator.name}` : undefined,
      `choice_label: ${label}`,
      `choice_value: ${choiceValue}`,
      "</lark_card_action>",
      "",
      `用户点击了飞书卡片按钮：${label}`,
      `value: ${choiceValue}`,
    ].filter((line): line is string => line !== undefined).join("\n");
    await input.runtime.chatQueue.enqueue(value.conversationKey, async () => {
      await runLarkCardChoice({
        channel: input.channel,
        bridge: input.bridge!,
        runtime: input.runtime,
        stateDir: input.stateDir!,
        chatId: input.event.chatId,
        replyTo: input.event.messageId,
        conversationKey: value.conversationKey as string,
        bridgeChatType,
        userId: stableLarkNumericId(`user:${input.event.operator?.openId ?? input.event.operator?.userId ?? "unknown"}`),
        text,
      });
      return true;
    });
    return true;
  }

  return false;
}

function isDownloadedLarkArchive(downloaded: DownloadedLarkAttachment): boolean {
  return downloaded.attachment.kind === "file" && path.extname(downloaded.localPath).toLowerCase() === ".zip";
}

function toWorkflowAttachment(downloaded: DownloadedLarkAttachment): DownloadedAttachment {
  const kind: NormalizedTelegramAttachment["kind"] =
    downloaded.attachment.kind === "image"
      ? "photo"
      : downloaded.attachment.kind === "audio"
        ? "audio"
        : downloaded.attachment.kind === "video" ? "video" : "document";
  return {
    localPath: downloaded.localPath,
    attachment: {
      fileId: downloaded.attachment.fileKey,
      kind,
      fileName: downloaded.attachment.fileName ?? path.basename(downloaded.localPath),
    },
  };
}

async function prepareLarkFileWorkflow(input: {
  stateDir: string;
  normalized: LarkNormalizedBridgeMessage;
  commandText: string;
  downloadedAttachments: DownloadedLarkAttachment[];
}): Promise<FileWorkflowResult | null> {
  if (input.downloadedAttachments.length === 1 && isDownloadedLarkArchive(input.downloadedAttachments[0]!)) {
    return await prepareAttachmentWorkflow({
      stateDir: input.stateDir,
      chatId: input.normalized.bridgeChatId,
      userId: input.normalized.bridgeUserId,
      text: input.normalized.text,
      downloadedAttachments: input.downloadedAttachments.map(toWorkflowAttachment),
    });
  }

  if (input.downloadedAttachments.length === 0) {
    return await prepareArchiveContinueWorkflow({
      stateDir: input.stateDir,
      chatId: input.normalized.bridgeChatId,
      text: input.commandText,
    });
  }

  return null;
}

async function downloadLarkAttachments(input: {
  channel: LarkChannelLike;
  stateDir: string;
  messageId: string;
  attachments: LarkNormalizedAttachment[];
}): Promise<DownloadedLarkAttachment[]> {
  if (input.attachments.length === 0) {
    return [];
  }
  const dir = path.join(input.stateDir, "workspace", ".lark-files", safeSegment(input.messageId), "input");
  await mkdir(dir, { recursive: true });
  const files: DownloadedLarkAttachment[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const downloadType = attachment.kind === "image" ? "image" : "file";
    const body = await input.channel.downloadResource(attachment.fileKey, downloadType);
    const fileName = attachment.fileName ?? `${attachment.kind}-${index + 1}${defaultExtension(attachment.kind)}`;
    const filePath = path.join(dir, safeFileName(fileName));
    await writeFile(filePath, body);
    files.push({ attachment, localPath: filePath });
  }
  return files;
}

async function runLarkCardChoice(input: {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  chatId: string;
  replyTo: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  userId: number;
  text: string;
}): Promise<void> {
  const abortController = new AbortController();
  const requestOutputDir = path.join(input.stateDir, "workspace", ".lark-out", safeSegment(input.replyTo));
  await mkdir(requestOutputDir, { recursive: true });
  input.runtime.activeRuns.set(input.conversationKey, { abortController });
  try {
    const result = await input.bridge.handleAuthorizedMessage({
      chatId: stableLarkNumericId(input.conversationKey),
      userId: input.userId,
      chatType: input.bridgeChatType,
      conversationKey: input.conversationKey,
      text: input.text,
      files: [],
      requestOutputDir,
      abortSignal: abortController.signal,
      onApprovalRequest: async (request) => await requestLarkApproval({
        channel: input.channel,
        runtime: input.runtime,
        chatId: input.chatId,
        conversationKey: input.conversationKey,
        bridgeChatType: input.bridgeChatType,
        replyTo: input.replyTo,
        request,
        abortSignal: request.abortSignal ?? abortController.signal,
      }),
      instructions: larkAgentInstructions(),
    });
    await deliverLarkResponse({
      channel: input.channel,
      runtime: input.runtime,
      chatId: input.chatId,
      replyTo: input.replyTo,
      text: result.text,
      stateDir: input.stateDir,
      requestOutputDir,
      conversationKey: input.conversationKey,
      bridgeChatType: input.bridgeChatType,
    });
  } catch (error) {
    await input.channel.send(input.chatId, {
      text: renderLarkUserFacingError(error, "engine"),
    }, { replyTo: input.replyTo });
  } finally {
    input.runtime.activeRuns.delete(input.conversationKey);
  }
}

async function deliverLarkResponse(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  text: string;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  sendText?: boolean;
}): Promise<void> {
  const toolMatches = extractTelegramToolTagMatches(input.text);
  const cleanedText = stripTelegramToolTags(stripDeliveryTags(input.text));
  const replyOptions = larkReplyOptions(input.replyTo, input.replyInThread);
  if (input.sendText !== false && cleanedText) {
    await input.channel.send(input.chatId, { markdown: cleanedText }, replyOptions);
  }

  for (const match of toolMatches) {
    try {
      const parsed = parseTelegramToolTagPayload(match.payload);
      await executeLarkToolTag({
        ...input,
        name: parsed.name,
        payload: parsed.payload,
      });
    } catch (error) {
      await input.channel.send(input.chatId, {
        text: renderLarkUserFacingError(error, "tool"),
      }, replyOptions);
    }
  }

  const matches = extractDeliveryTagMatches(input.text);
  if (matches.length === 0) {
    return;
  }

  const workspaceRoot = await realpath(path.join(input.stateDir, "workspace"))
    .catch(() => path.join(input.stateDir, "workspace"));
  const outputRoot = input.requestOutputDir
    ? await realpath(input.requestOutputDir).catch(() => input.requestOutputDir)
    : undefined;
  const overrideRoot = input.workspaceOverride
    ? await realpath(input.workspaceOverride).catch(() => input.workspaceOverride)
    : undefined;
  const workspacePrefix = workspaceRoot + path.sep;
  const outputPrefix = outputRoot ? `${outputRoot}${path.sep}` : undefined;
  const overridePrefix = overrideRoot ? `${overrideRoot}${path.sep}` : undefined;

  for (const match of matches) {
    const filePath = match.path;
    try {
      const real = await realpath(filePath);
      if (
        !real.startsWith(workspacePrefix) &&
        !(outputPrefix && real.startsWith(outputPrefix)) &&
        !(overridePrefix && real.startsWith(overridePrefix))
      ) {
        await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, replyOptions);
        continue;
      }
      const body = await readFile(real);
      if (match.preferPhoto) {
        await input.channel.send(input.chatId, { image: { source: body } }, replyOptions);
      } else {
        await input.channel.send(input.chatId, {
          file: {
            source: body,
            fileName: path.basename(real),
          },
        }, replyOptions);
      }
    } catch {
      await input.channel.send(input.chatId, {
        text: "文件未发送：读取文件失败，详细原因已记录到日志。",
      }, replyOptions);
    }
  }
}

function larkReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): LarkSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }

  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
}

async function executeLarkToolTag(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  name: string;
  payload: unknown;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
}): Promise<void> {
  const payload = payloadObject(input.payload);
  if (
    (input.name === "send.file" || input.name === "send.image" || input.name === "send.audio" || input.name === "send.video") &&
    typeof payload?.path === "string"
  ) {
    await sendLarkPath({
      ...input,
      filePath: payload.path,
      kind: input.name.slice("send.".length) as LarkSendPathKind,
    });
    return;
  }

  if (input.name === "send.batch") {
    const message = typeof payload?.message === "string" ? payload.message : "";
    if (message.trim()) {
      await input.channel.send(input.chatId, { markdown: message.trim() }, larkReplyOptions(input.replyTo, input.replyInThread));
    }
    for (const image of stringArray(payload?.images)) {
      await sendLarkPath({ ...input, filePath: image, kind: "image" });
    }
    for (const file of stringArray(payload?.files)) {
      await sendLarkPath({ ...input, filePath: file, kind: "file" });
    }
    for (const audio of stringArray(payload?.audios)) {
      await sendLarkPath({ ...input, filePath: audio, kind: "audio" });
    }
    for (const video of stringArray(payload?.videos)) {
      await sendLarkPath({ ...input, filePath: video, kind: "video" });
    }
    return;
  }

  if (input.name === "lark.post" || input.name === "send.post") {
    const post = payload?.post ?? payload;
    if (!post || typeof post !== "object" || Array.isArray(post)) {
      throw new Error(`${input.name} requires an object payload`);
    }
    await input.channel.send(input.chatId, { post }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }

  if (input.name === "lark.card" || input.name === "send.card") {
    const card = buildLarkToolCard(payload, input.conversationKey, input.bridgeChatType);
    await input.channel.send(input.chatId, { card }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }

  if (input.name === "lark.doc.create" || input.name === "lark.doc") {
    const docInput = parseLarkDocumentCreateInput(payload);
    const created = await input.runtime.createDocument(docInput);
    const label = created.title ?? docInput.title ?? "飞书文档";
    const location = created.url ?? created.documentId ?? "(created)";
    await input.channel.send(input.chatId, {
      markdown: `已创建 ${label}：\n${location}`,
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
}

async function sendLarkPath(input: {
  channel: LarkChannelLike;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  filePath: string;
  kind: LarkSendPathKind;
  stateDir: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
}): Promise<void> {
  const workspaceRoot = await realpath(path.join(input.stateDir, "workspace"))
    .catch(() => path.join(input.stateDir, "workspace"));
  const outputRoot = input.requestOutputDir
    ? await realpath(input.requestOutputDir).catch(() => input.requestOutputDir)
    : undefined;
  const overrideRoot = input.workspaceOverride
    ? await realpath(input.workspaceOverride).catch(() => input.workspaceOverride)
    : undefined;
  const prefixes = [
    workspaceRoot + path.sep,
    ...(outputRoot ? [outputRoot + path.sep] : []),
    ...(overrideRoot ? [overrideRoot + path.sep] : []),
  ];
  const real = await realpath(input.filePath);
  if (!prefixes.some((prefix) => real.startsWith(prefix))) {
    await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  const body = await readFile(real);
  if (input.kind === "image") {
    await input.channel.send(input.chatId, { image: { source: body } }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  if (input.kind === "audio") {
    await input.channel.send(input.chatId, {
      audio: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  if (input.kind === "video") {
    await input.channel.send(input.chatId, {
      video: {
        source: body,
        fileName: path.basename(real),
      },
    }, larkReplyOptions(input.replyTo, input.replyInThread));
    return;
  }
  await input.channel.send(input.chatId, {
    file: {
      source: body,
      fileName: path.basename(real),
    },
  }, larkReplyOptions(input.replyTo, input.replyInThread));
}

async function createDefaultLarkBridge(env: LarkRuntimeEnv): Promise<{ stateDir: string; bridge: LarkBridgeLike }> {
  const { config, bridge } = await createBridgeDependencies({
    HOME: env.HOME,
    APPDATA: env.APPDATA,
    USERPROFILE: env.USERPROFILE,
    CODEX_HOME: env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    CODEX_TELEGRAM_INSTANCE: env.CODEX_TELEGRAM_INSTANCE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
    CLAUDE_EXECUTABLE: env.CLAUDE_EXECUTABLE,
    ANTIGRAVITY_EXECUTABLE: env.ANTIGRAVITY_EXECUTABLE,
  });
  return {
    stateDir: config.stateDir,
    bridge,
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildLarkToolCard(
  payload: Record<string, unknown> | null,
  conversationKey: string | undefined,
  bridgeChatType: "private" | "group" | undefined,
): object {
  if (!payload) {
    throw new Error("lark.card requires an object payload");
  }
  if (payload.card && typeof payload.card === "object" && !Array.isArray(payload.card)) {
    return decorateRawLarkCard(payload.card as Record<string, unknown>, conversationKey, bridgeChatType);
  }

  const title = typeof payload.title === "string" ? payload.title : "请选择";
  const body = typeof payload.body === "string" ? payload.body : "";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: body || title,
    },
  ];
  if (actions.length > 0) {
    elements.push({
      tag: "column_set",
      columns: actions
        .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === "object" && !Array.isArray(action))
        .map((action) => {
          const label = typeof action.label === "string" ? action.label : "选择";
          const value = action.value ?? label;
          return {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                text: {
                  tag: "plain_text",
                  content: label,
                },
                type: action.type === "danger" || action.type === "primary" || action.type === "default"
                  ? action.type
                  : "primary",
                behaviors: [callbackBehavior({
                  cctb_lark: "choice",
                  ...(conversationKey ? { conversationKey } : {}),
                  ...(bridgeChatType ? { bridgeChatType } : {}),
                  label,
                  value,
                })],
              },
            ],
          };
        }),
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: title,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    body: {
      direction: "vertical",
      elements,
    },
  };
}

function decorateRawLarkCard(
  card: Record<string, unknown>,
  conversationKey: string | undefined,
  bridgeChatType: "private" | "group" | undefined,
): Record<string, unknown> {
  if (!conversationKey) {
    return card;
  }
  return decorateLarkCardNode(card, conversationKey, bridgeChatType) as Record<string, unknown>;
}

function decorateLarkCardNode(
  value: unknown,
  conversationKey: string,
  bridgeChatType: "private" | "group" | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decorateLarkCardNode(item, conversationKey, bridgeChatType));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const node = value as Record<string, unknown>;
  const decorated: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    decorated[key] = decorateLarkCardNode(item, conversationKey, bridgeChatType);
  }

  if (decorated.tag === "button") {
    const currentValue = payloadObject(decorated.value);
    const existingCallback = findLarkCallbackValue(decorated.behaviors);
    if (!currentValue?.cctb_lark && !existingCallback?.cctb_lark) {
      const label = extractButtonLabel(decorated);
      decorated.behaviors = [
        ...arrayValue(decorated.behaviors),
        callbackBehavior({
          cctb_lark: "choice",
          conversationKey,
          ...(bridgeChatType ? { bridgeChatType } : {}),
          label,
          value: currentValue ?? label,
        }),
      ];
      delete decorated.value;
    } else if (currentValue?.cctb_lark && !existingCallback?.cctb_lark) {
      decorated.behaviors = [
        ...arrayValue(decorated.behaviors),
        callbackBehavior(currentValue),
      ];
      delete decorated.value;
    }
  }

  return decorated;
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    value,
  };
}

function findLarkCallbackValue(behaviors: unknown): Record<string, unknown> | null {
  for (const behavior of arrayValue(behaviors)) {
    if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) {
      continue;
    }
    const entry = behavior as Record<string, unknown>;
    if (entry.type === "callback") {
      return payloadObject(entry.value);
    }
  }
  return null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function ensureLarkCardActionAccess(input: {
  channel: LarkChannelLike;
  bridge?: LarkBridgeLike;
  stateDir?: string;
  event: {
    chatId: string;
    messageId: string;
    operator?: {
      openId?: string;
      userId?: string;
      name?: string;
    };
  };
  conversationKey: string;
  bridgeChatType: "private" | "group";
}): Promise<boolean> {
  if (!input.bridge?.checkAccess || !input.stateDir) {
    return true;
  }

  const operatorRawId = larkOperatorRawId(input.event.operator);
  const chatId = stableLarkNumericId(input.conversationKey);
  const userId = stableLarkNumericId(`user:${operatorRawId}`);
  await assertStableLarkIdMappings(input.stateDir, [
    ["chat", chatId, input.conversationKey],
    ["user", userId, operatorRawId],
  ]);

  const decision = await input.bridge.checkAccess({
    chatId,
    userId,
    chatType: input.bridgeChatType,
    conversationKey: input.conversationKey,
    locale: "zh",
  });
  if (decision.kind === "allow") {
    return true;
  }

  await input.channel.send(input.event.chatId, {
    text: decision.text ?? "当前操作者未获授权。",
  }, { replyTo: input.event.messageId });
  return false;
}

function larkOperatorRawId(operator: { openId?: string; userId?: string } | undefined): string {
  return operator?.openId ?? operator?.userId ?? "unknown";
}

function normalizeLarkCommentFileType(value: string): LarkCommentFileType {
  switch (value) {
    case "doc":
    case "docx":
    case "sheet":
    case "file":
    case "slides":
    case "bitable":
      return value;
    default:
      return "file";
  }
}

function buildLarkCommentPrompt(
  event: CommentEvent,
  fileType: LarkCommentFileType,
  context: LarkCommentContext,
): string {
  const latestReply = context.replies.at(-1);
  const replies = context.replies
    .map((reply, index) => [
      `reply_${index + 1}:`,
      reply.replyId ? `  reply_id: ${reply.replyId}` : undefined,
      reply.userId ? `  user_id: ${reply.userId}` : undefined,
      `  text: ${reply.text || "(empty)"}`,
      reply.docsLinks.length > 0 ? `  docs_links: ${reply.docsLinks.join(", ")}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n"))
    .join("\n");

  return [
    "<lark_comment_context>",
    `file_token: ${event.fileToken}`,
    `file_type: ${fileType}`,
    `comment_id: ${event.commentId}`,
    event.replyId ? `reply_id: ${event.replyId}` : undefined,
    `operator_id: ${larkOperatorRawId(event.operator)}`,
    `mentioned_bot: ${event.mentionedBot}`,
    context.quote ? `selected_quote: ${context.quote}` : "selected_quote: (none)",
    replies ? "comment_replies:" : "comment_replies: (none)",
    replies || undefined,
    "</lark_comment_context>",
    "",
    "你正在飞书云文档评论线程里回复用户。请直接回答评论里的请求，必要时可用 lark-cli 读取文档上下文。",
    latestReply?.text ? `用户评论：${latestReply.text}` : "用户在云文档评论中 @ 了你，请根据上下文回复。",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function extractButtonLabel(button: Record<string, unknown>): string {
  const text = payloadObject(button.text);
  const content = text && typeof text.content === "string" ? text.content.trim() : "";
  return content || "choice";
}

function renderLarkUserFacingError(error: unknown, phase: "prepare" | "engine" | "tool"): string {
  const category = classifyFailure(error);
  if (category === "auth") {
    return "错误：引擎或飞书认证已失效，请重新登录后重试。";
  }
  if (category === "write-permission") {
    return "错误：当前运行环境没有写入权限，请调整权限后重试。";
  }
  if (category === "file-workflow") {
    return "错误：文件处理失败，请换一个文件或缩小文件后重试。";
  }
  if (category === "session-state") {
    return "错误：会话状态不可用，请重置会话或让运维检查状态文件。";
  }
  if (category === "workflow-state") {
    return "错误：工作流状态不可用，请稍后重试或让运维检查服务状态。";
  }
  if (category === "engine-cli") {
    return "错误：引擎运行失败，请重启实例后重试。";
  }

  switch (phase) {
    case "prepare":
      return "错误：准备飞书消息时失败，请稍后重试。";
    case "tool":
      return "错误：飞书工具执行失败，详细原因已记录到日志。";
    case "engine":
      return "错误：本轮运行失败，详细原因已记录到日志。";
  }
}

function larkAgentInstructions(): string {
  return [
    "You are replying through Feishu/Lark via cc-telegram-bridge.",
    "Use the <lark_context> block for chat/message/thread identity; do not reveal app secrets or tokens.",
    "If the prompt contains <lark_comment_context>, answer as a Feishu Docs comment reply; use file_token/file_type/comment_id only as operational context, not as user-visible secrets.",
    "For Feishu Docs/IM/Calendar operations, prefer local `lark-cli` when available; ask in chat if authentication or permissions are missing.",
    "For rich replies, use [tool:{\"name\":\"lark.post\",\"payload\":{\"post\":{...}}}] or [tool:{\"name\":\"lark.card\",\"payload\":{\"title\":\"...\",\"body\":\"...\",\"actions\":[...]}}].",
    "For readable specs/docs, prefer [tool:{\"name\":\"lark.doc.create\",\"payload\":{\"title\":\"...\",\"content\":\"...\",\"docFormat\":\"markdown\"}}] instead of leaving long Markdown in chat.",
    "Deliver generated files/images/audio/video with [send-file:/absolute/path], [send-image:/absolute/path], or send.file/send.image/send.audio/send.video tool tags.",
    "If the user forwards merged Feishu messages, treat <forwarded_lark_messages> as the task context to process.",
  ].join("\n");
}

function cleanupPendingApproval(runtime: LarkServiceRuntime, requestId: string): void {
  const pending = runtime.pendingApprovals.get(requestId);
  if (!pending) {
    return;
  }
  runtime.pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.abortSignal && pending.abortHandler) {
    pending.abortSignal.removeEventListener("abort", pending.abortHandler);
  }
}

function actionValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function bridgeChatTypeFromValue(value: unknown): "private" | "group" {
  return value === "group" ? "group" : "private";
}

function isApprovalDecision(value: unknown): value is "allow_once" | "allow_session" | "deny" {
  return value === "allow_once" || value === "allow_session" || value === "deny";
}

function renderApprovalDecision(decision: "allow_once" | "allow_session" | "deny"): EngineApprovalDecision {
  if (decision === "deny") {
    return { behavior: "deny" };
  }
  return {
    behavior: "allow",
    scope: decision === "allow_session" ? "session" : "once",
  };
}

function renderApprovalResolution(decision: "allow_once" | "allow_session" | "deny"): string {
  if (decision === "deny") {
    return "已拒绝。";
  }
  return decision === "allow_session" ? "已允许本轮。" : "已允许一次。";
}

async function handleLarkSimpleCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  if (isHelpCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/help", renderLarkHelpMessage());
    return true;
  }

  if (await handleLarkSessionCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkLocalEngineCommand(input, normalized, commandText)) {
    return true;
  }

  const goalCommand = parseLarkGoalCommand(commandText);
  if (goalCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const handled = await handleLarkGoalCommand(input, normalized, cfg, goalCommand, commandText);
    if (handled !== null) {
      return handled;
    }
  }

  if (await handleLarkBoardCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkMiniBusCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleLarkDelegationCommand(input, normalized, commandText)) {
    return true;
  }

  if (isCronCommand(commandText)) {
    await handleLarkCronCommand(input, normalized, commandText);
    return true;
  }

  if (isStatusCommand(commandText)) {
    await sendLarkCommandMarkdown(input, normalized, "/status", await renderLarkStatusMessage(input.runtime, normalized, input.stateDir));
    return true;
  }

  if (isUsageCommand(commandText)) {
    const usage = await new UsageStore(input.stateDir).load();
    await sendLarkCommandMarkdown(input, normalized, "/usage", renderUsageMessage(usage, "zh"));
    return true;
  }

  const modelCommand = parseLarkModelCommand(commandText);
  if (modelCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkModelCommand(input.stateDir, cfg, modelCommand.model);
    await sendLarkCommandMarkdown(input, normalized, "/model", message);
    return true;
  }

  const effortCommand = parseLarkEffortCommand(commandText);
  if (effortCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEffortCommand(input.stateDir, cfg, effortCommand.level);
    await sendLarkCommandMarkdown(input, normalized, "/effort", message);
    return true;
  }

  const fastCommand = parseLarkFastCommand(commandText);
  if (fastCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkFastCommand(input.stateDir, cfg, fastCommand.action);
    await sendLarkCommandMarkdown(input, normalized, "/fast", message);
    return true;
  }

  const engineCommand = parseLarkEngineCommand(commandText);
  if (engineCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleLarkEngineCommand(input.stateDir, cfg, engineCommand.engine, engineCommand.invalid);
    await sendLarkCommandMarkdown(input, normalized, "/engine", message);
    return true;
  }

  const yoloCommand = parseLarkYoloCommand(commandText);
  if (yoloCommand) {
    const message = await handleLarkYoloCommand(input.stateDir, yoloCommand.action);
    await sendLarkCommandMarkdown(input, normalized, "/yolo", message);
    return true;
  }

  return false;
}

async function sendLarkCommandMarkdown(
  input: {
    channel: LarkChannelLike;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  command: string,
  markdown: string,
): Promise<void> {
  await input.channel.send(normalized.chatId, { markdown }, {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  });
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: command,
  });
}

function isLarkLocalEngineCommand(text: string): boolean {
  return /^\/(?:compact|context|ultrareview)(?:\s|$)/i.test(text.trim());
}

async function handleLarkLocalEngineCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  if (!isLarkLocalEngineCommand(commandText)) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalEngineTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
    cfg: {
      engine: cfg.engine,
      model: cfg.model,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
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
    },
    bridge: input.bridge,
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
  });
}

async function handleLarkSessionCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  return await handleLocalSessionTelegramCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale: "zh",
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    normalized: toSessionTelegramMessage(normalized, commandText),
    context: {
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
    },
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
    validateCodexThread: input.bridge.validateCodexThread?.bind(input.bridge),
    scanRecentSessions: input.runtime.sessionRuntime?.scanRecentSessions,
    scanRecentAntigravitySessions: input.runtime.sessionRuntime?.scanRecentAntigravitySessions,
  });
}

function toSessionTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

async function handleLarkBoardCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
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
    onApprovalRequest: async (request) => await requestLarkApproval({
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

async function handleLarkMiniBusCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
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
    onApprovalRequest: async (request) => await requestLarkApproval({
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

async function handleLarkDelegationCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
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

function formatLarkAccessReply(text: string): string {
  if (text.includes("lark access pair")) {
    return text;
  }

  const code = extractPairingCode(text);
  if (!code) {
    return text;
  }

  return `${text}\n在本机运行：node dist/src/index.js lark access pair ${code}`;
}

function extractPairingCode(text: string): string | null {
  return text.match(/使用配对码\s+([A-Z0-9]{6,12})\s+配对/)?.[1] ??
    text.match(/Pair this private chat with code\s+([A-Z0-9]{6,12})/i)?.[1]?.toUpperCase() ??
    null;
}

function extractLarkMessageBody(text: string): string {
  const contextEnd = text.indexOf("</lark_context>");
  if (contextEnd === -1) {
    return text.trim();
  }
  return text.slice(contextEnd + "</lark_context>".length).trim();
}

function isHelpCommand(text: string): boolean {
  return /^\/(?:help|start)(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string): boolean {
  return /^\/status(?:\s|$)/i.test(text.trim());
}

function isUsageCommand(text: string): boolean {
  return /^\/usage(?:\s|$)/i.test(text.trim());
}

function parseLarkModelCommand(text: string): { model: string } | null {
  const match = text.trim().match(/^\/model(?:\s+([\s\S]+))?$/i);
  return match ? { model: match[1]?.trim() ?? "" } : null;
}

function parseLarkEffortCommand(text: string): { level: string } | null {
  const match = text.trim().match(/^\/effort(?:\s+(\S+))?$/i);
  return match ? { level: match[1] ?? "" } : null;
}

function parseLarkFastCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/fast(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseLarkEngineCommand(text: string): { engine: string; invalid: boolean } | null {
  const match = text.trim().match(/^\/engine(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawArgs = match[1]?.trim() ?? "";
  if (!rawArgs) {
    return { engine: "", invalid: false };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  return parts.length === 1 ? { engine: parts[0] ?? "", invalid: false } : { engine: "", invalid: true };
}

function parseLarkYoloCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/yolo(?:\s+(\S+))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() } : null;
}

type LarkGoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; objective: string; tokenBudget: number | null; explicitUnbounded: boolean }
  | { kind: "invalid"; reason: "invalid_budget" | "missing_objective" };

function parseLarkGoalTokenBudget(value: string): number | null {
  const normalized = value.trim().replace(/[,_]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const budget = amount * scale;
  return Number.isSafeInteger(budget) && budget >= 1 ? budget : null;
}

function parseLarkSetGoal(rest: string): Extract<LarkGoalCommand, { kind: "set" | "invalid" }> {
  const unboundedMatch = rest.match(/^(?:--unbounded|--no-budget)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--unbounded|--no-budget)(?:$|\s+)/i.test(rest)) {
    const objective = unboundedMatch?.[1]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget: null, explicitUnbounded: true };
  }

  const budgetMatch = rest.match(/^(?:--budget|-b)(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--budget|-b)(?:$|=|\s+)/i.test(rest)) {
    const tokenBudget = budgetMatch ? parseLarkGoalTokenBudget(budgetMatch[1] ?? "") : null;
    if (!budgetMatch || tokenBudget === null) {
      return { kind: "invalid", reason: "invalid_budget" };
    }
    const objective = budgetMatch[2]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget, explicitUnbounded: false };
  }
  return { kind: "set", objective: rest, tokenBudget: null, explicitUnbounded: false };
}

function parseLarkGoalCommand(text: string): LarkGoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  if (!rest || /^status$/i.test(rest)) return { kind: "status" };
  if (/^(clear|off|reset)$/i.test(rest)) return { kind: "clear" };
  return parseLarkSetGoal(rest);
}

function isStopCommand(text: string): boolean {
  return /^\/stop(?:\s|$)/i.test(text.trim());
}

function renderLarkHelpMessage(): string {
  return [
    "**cc-telegram-bridge for Feishu/Lark**",
    "",
    "常用命令：",
    "- `/help`：显示这份帮助",
    "- `/status`：查看当前会话状态",
    "- `/usage`：查看本实例累计用量",
    "- `/model [名称|off]`：查看或设置模型",
    "- `/effort [low|medium|high|xhigh|max|off]`：查看或设置推理强度",
    "- `/fast [on|off|status]`：开关 Codex Fast Mode",
    "- `/engine [claude|codex|antigravity]`：查看或切换后端引擎",
    "- `/yolo [on|off|unsafe]`：查看或切换审批模式",
    "- `/context` / `/compact` / `/ultrareview`：Claude 本地上下文、压缩和深度代码审查命令",
    "- `/goal [status|clear|目标|--budget N 目标]`：管理当前会话 goal；默认无 token 预算",
    "- `/btw <问题>`：旁问，不影响当前会话",
    "- `/reset`：重置当前 Lark 会话",
    "- `/detach`：断开当前绑定的 Codex thread / Antigravity conversation",
    "- `/resume` / `/resume <编号>`：Claude 扫描并选择本地 session；Antigravity 扫描 recent conversation",
    "- `/resume thread <thread-id>`：绑定 Codex thread",
    "- `/resume conversation <conversation-id>`：显式绑定 Antigravity conversation",
    "- `/cron ...`：管理飞书侧定时提醒和任务",
    "- `/board ...`：管理持久任务板",
    "- `/mini ...`：把飞书群 thread 注册成轻量 peer，做 thread-to-thread 协作",
    "- `/ask <实例> <提示>`：委托给指定 peer bot 并内联返回结果",
    "- `/fan` / `/chain` / `/verify`：调用 Agent Bus 做并行、串联和验证",
    "- `/stop`：停止当前会话正在运行或排队的任务",
    "",
    "使用方式：直接发需求、文件、图片、音视频；群聊里默认需要 @bot 才会响应。",
    "复杂任务会以交互卡片流式更新，危险操作会发审批按钮。",
  ].join("\n");
}

async function renderLarkStatusMessage(
  runtime: LarkServiceRuntime,
  normalized: LarkNormalizedBridgeMessage,
  stateDir: string,
): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  const session = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(normalized.conversationKey);
  const currentSession = session.record;
  return [
    "**Lark conversation status**",
    "",
    `Engine: ${cfg.engine}`,
    `Model: ${cfg.model ?? "default"}`,
    `Effort: ${cfg.effort ?? "default"}`,
    `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`,
    `Conversation: ${normalized.conversationKey}`,
    `Chat type: ${normalized.bridgeChatType}`,
    session.warning
      ? `Session bound: unknown (${session.warning})`
      : `Session bound: ${currentSession ? "yes" : "no"}`,
    ...(cfg.engine === "codex" && currentSession ? [`Current thread: ${currentSession.codexSessionId}`] : []),
    ...(cfg.engine === "antigravity" && currentSession ? [`Current conversation: ${currentSession.codexSessionId}`] : []),
    `Active run: ${runtime.activeRuns.has(normalized.conversationKey) ? "yes" : "no"}`,
    `Pending approvals: ${runtime.pendingApprovals.size}`,
  ].join("\n");
}

function isSingleTokenLarkModelName(model: string): boolean {
  return !/\s/.test(model);
}

function renderLarkModelSelectionMessage(cfg: InstanceConfig): string {
  const current = cfg.model ?? "default";
  if (cfg.engine === "claude") {
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      "/model opus",
      "/model sonnet",
      "/model haiku",
      "/model off",
      "1M 上下文示例：/model opus[1m]",
    ].join("\n");
  }
  if (cfg.engine === "codex") {
    return [
      `当前模型: ${current}`,
      "用 /model <名称> 选择模型：",
      "/model gpt-5.4",
      "/model gpt-5.3-codex",
      "/model o3",
      "/model off",
    ].join("\n");
  }
  return [
    `当前模型: ${current}`,
    "Antigravity 模型暂不能从 Lark 切换；请在本机交互式 agy 里使用 /model。",
  ].join("\n");
}

async function handleLarkModelCommand(stateDir: string, cfg: InstanceConfig, model: string): Promise<string> {
  if (cfg.engine === "antigravity") {
    return "Antigravity 模型切换暂不支持从 Lark 发起，因为 agy --print 不会运行交互式 /model 解析器。请在本机交互式 agy 里使用 /model；bridge 不会把 /model 当普通聊天转发给模型。";
  }
  if (!model) {
    return renderLarkModelSelectionMessage(cfg);
  }
  if (!isSingleTokenLarkModelName(model)) {
    return "用法: /model <单个模型名|off>";
  }
  if (model === "off" || model === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.model;
    });
    return "模型已恢复默认。";
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.model = model;
  });
  return `模型已设为 ${model}。`;
}

async function handleLarkEffortCommand(stateDir: string, cfg: InstanceConfig, level: string): Promise<string> {
  if (cfg.engine === "antigravity") {
    return "Antigravity 的 effort 由 agy CLI 原生控制；bridge 目前还没有可用的 effort 启动参数。模型选择请在本机交互式 agy 里使用 /model。";
  }
  if (!level) {
    return `当前 effort: ${cfg.effort ?? "default"}`;
  }
  if (level === "off" || level === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.effort;
    });
    return "Effort 已恢复默认。";
  }
  if (!VALID_LARK_EFFORT_LEVELS.includes(level as EffortLevel)) {
    return "用法: /effort [low|medium|high|xhigh|max|off]";
  }
  const effectiveLevel = cfg.engine !== "claude" && level === "max" ? "xhigh" : level;
  await updateInstanceConfig(stateDir, (config) => {
    config.effort = effectiveLevel;
  });
  return cfg.engine !== "claude" && level === "max"
    ? "Codex 不支持 max，已改用 xhigh。"
    : `Effort 已设为 ${level}。`;
}

async function handleLarkFastCommand(stateDir: string, cfg: InstanceConfig, action: string): Promise<string> {
  if (cfg.engine !== "codex") {
    return "Fast Mode 仅 Codex 支持。";
  }
  if (action === "on" || action === "enable" || action === "fast") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return "Codex Fast Mode 已开启。支持的模型会更快，但会消耗更多 credits。";
  }
  if (action === "off" || action === "disable" || action === "standard" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return "Codex Fast Mode 已关闭。";
  }
  if (action === "status") {
    return `Codex Fast Mode: ${cfg.codexServiceTier === "fast" ? "on" : "off"}`;
  }
  return "用法: /fast [on|off|status]";
}

async function handleLarkEngineCommand(
  stateDir: string,
  cfg: InstanceConfig,
  engine: string,
  invalid: boolean,
): Promise<string> {
  if (!engine && !invalid) {
    return [
      `当前引擎：${cfg.engine}`,
      "用 /engine <名称> 选择引擎：",
      ...LARK_ENGINE_CHOICES.map((choice) => `/engine ${choice}`),
      "切换后请重启 Lark service 以生效。",
    ].join("\n");
  }
  if (invalid || !LARK_ENGINE_CHOICES.includes(engine as InstanceEngine)) {
    return "用法: /engine [claude|codex|antigravity]";
  }

  const selectedEngine = engine as InstanceEngine;
  const engineChanged = cfg.engine !== selectedEngine;
  let resetSessionBindings = false;
  if (engineChanged) {
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    resetSessionBindings = (await sessionStore.clearAll()) > 0;
  }

  let clearedModel = false;
  let enabledFullAuto = false;
  await updateInstanceConfig(stateDir, (config) => {
    const result = applyEngineSelection(config, selectedEngine);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });

  const details: string[] = [];
  if (clearedModel) {
    details.push("已清除先前的模型覆盖");
  }
  if (resetSessionBindings) {
    details.push("已重置该实例的会话绑定");
  }
  if (enabledFullAuto) {
    details.push("Antigravity 已自动开启 YOLO/full-auto");
  }
  const suffix = details.length > 0 ? ` ${details.join("，")}。` : "";
  return `引擎已设为 ${selectedEngine}。${suffix}重启 Lark service 后生效。`;
}

async function handleLarkYoloCommand(stateDir: string, action: string): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (!action || action === "status") {
    const mode = (await readRawLarkConfig(stateDir)).approvalMode ?? "normal";
    const label = mode === "bypass"
      ? "YOLO UNSAFE（跳过审批和 sandbox）"
      : mode === "full-auto" ? "YOLO（full-auto，sandboxed）" : "off（普通审批流程）";
    return `当前 YOLO: ${label}`;
  }
  if (action === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "full-auto";
    });
    return `YOLO mode ON（full-auto，sandboxed）。当前引擎：${cfg.engine}。`;
  }
  if (action === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "normal";
    });
    return "YOLO mode OFF。已恢复普通审批流程。";
  }
  if (action === "unsafe") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "bypass";
    });
    return "YOLO UNSAFE 已开启。将跳过审批和 sandbox，请只在可信机器和可信 workspace 使用。";
  }
  return "用法: /yolo [on|off|unsafe|status]";
}

function renderLarkGoal(goal: CodexThreadGoal): string {
  const budget = goal.tokenBudget === null ? "无 token 预算" : `${goal.tokenBudget} token 预算`;
  return [
    `目标：${goal.objective}`,
    `状态：${goal.status}`,
    budget,
    `已用 ${goal.tokensUsed} tokens，${Math.round(goal.timeUsedSeconds)} 秒`,
  ].join("\n");
}

function renderInvalidLarkGoalCommand(reason: "invalid_budget" | "missing_objective"): string {
  if (reason === "missing_objective") {
    return "请写目标，例如：/goal 写发布说明；如需限额，用 /goal --budget 50000 写发布说明。";
  }
  return "无效的 /goal token 预算。用法：--budget 50000 或 -b 50k。";
}

function toNativeLarkGoalCommandText(
  action: LarkGoalCommand,
  commandText: string,
  engine: "claude" | "antigravity",
): string | null {
  if (action.kind !== "set") {
    return commandText.trim();
  }
  if (action.tokenBudget === null) {
    return `/goal ${action.objective}`;
  }
  const engineName = engine === "antigravity" ? "Antigravity" : "Claude";
  return `/goal ${action.objective}\n\n[Bridge note: 用户请求 token 预算：${action.tokenBudget} tokens。原生 ${engineName} goal 可能只会把它当作指导，而不是强制预算。]`;
}

async function handleLarkGoalCommand(
  input: {
    channel: LarkChannelLike;
    bridge: LarkBridgeLike;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  cfg: InstanceConfig,
  action: LarkGoalCommand,
  commandText: string,
): Promise<boolean | null> {
  if (action.kind === "invalid") {
    await sendLarkCommandMarkdown(input, normalized, "/goal", renderInvalidLarkGoalCommand(action.reason));
    return true;
  }

  if (cfg.engine === "claude" || cfg.engine === "antigravity") {
    const nativeText = toNativeLarkGoalCommandText(action, commandText, cfg.engine);
    if (nativeText) {
      normalized.text = nativeText;
    }
    return null;
  }

  const goalInput = {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    workspaceOverride: cfg.resume?.workspacePath,
  };

  if (action.kind === "status") {
    if (!input.bridge.getThreadGoal) {
      await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal status。");
      return true;
    }
    const { goal } = await input.bridge.getThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", goal ? renderLarkGoal(goal) : "当前聊天没有活跃 goal。");
    return true;
  }

  if (action.kind === "clear") {
    if (!input.bridge.clearThreadGoal) {
      await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal clear。");
      return true;
    }
    const { cleared } = await input.bridge.clearThreadGoal(goalInput);
    await sendLarkCommandMarkdown(input, normalized, "/goal", cleared ? "已清除当前 goal。" : "当前聊天没有可清除的 goal。");
    return true;
  }

  if (!input.bridge.setThreadGoal) {
    await sendLarkCommandMarkdown(input, normalized, "/goal", "当前 runtime 不支持结构化 /goal。");
    return true;
  }
  const { goal } = await input.bridge.setThreadGoal({
    ...goalInput,
    objective: action.objective,
    tokenBudget: action.tokenBudget,
  });
  await sendLarkCommandMarkdown(input, normalized, "/goal", goal ? `Goal 已设置。\n\n${renderLarkGoal(goal)}` : "Goal 已设置。");
  return true;
}

async function handleLarkCronCommand(
  input: {
    channel: LarkChannelLike;
    runtime: LarkServiceRuntime;
    stateDir: string;
  },
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<void> {
  if (!input.runtime.cronRuntime) {
    await sendLarkCommandMarkdown(input, normalized, "/cron", "Lark cron runtime 尚未启动。请重启 Lark service 后再试。");
    return;
  }

  const api = {
    sendMessage: async (_chatId: number, text: string): Promise<{ message_id: number }> => {
      await input.channel.send(normalized.chatId, { markdown: text }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return { message_id: 0 };
    },
  };

  await handleCronCommand(commandText, {
    api,
    store: input.runtime.cronRuntime.store,
    scheduler: input.runtime.cronRuntime.scheduler as CronScheduler,
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    channel: "lark",
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    larkChatId: normalized.chatId,
    larkThreadId: normalized.threadId,
    larkMessageId: normalized.messageId,
    locale: "zh",
  });
  await appendLarkTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: "/cron",
  });
}

async function readRawLarkConfig(stateDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "message";
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[/\\:]/g, "_");
  return base || "attachment.bin";
}

function defaultExtension(kind: LarkNormalizedAttachment["kind"]): string {
  switch (kind) {
    case "image":
      return ".png";
    case "audio":
      return ".ogg";
    case "video":
      return ".mp4";
    case "file":
      return ".bin";
  }
}

export async function cleanupLarkMessageArtifacts(stateDir: string, messageId: string): Promise<void> {
  await rm(path.join(stateDir, "workspace", ".lark-files", safeSegment(messageId)), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
}
