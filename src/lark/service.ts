import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import { TELEGRAM_APPROVAL_TIMEOUT_MS } from "../telegram/approval-timeouts.js";
import { stripDeliveryTags } from "../telegram/delivery-tags.js";
import { stripTelegramToolTags } from "../telegram/tool-tags.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { CronStore } from "../state/cron-store.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { renderLarkApprovalCard } from "./card-renderer.js";
import {
  extractLarkMessageBody,
  formatLarkAccessReply,
  handleLarkSimpleCommand,
  isStopCommand,
} from "./commands.js";
import {
  createLarkCommentClient,
  type LarkCommentContext,
  type LarkCommentFileType,
} from "./comment-client.js";
import { resolveLarkRuntimeConfig, type LarkRuntimeConfig, type LarkRuntimeEnv } from "./config.js";
import { buildLarkCronExecutor } from "./cron.js";
import { deliverLarkResponse } from "./delivery.js";
import {
  normalizeLarkMessage,
  stableLarkNumericId,
  type LarkIncomingMessage,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { assertStableLarkIdMappings, verifyLarkNumericIds } from "./id-map.js";
import { renderLarkUserFacingError } from "./errors.js";
import {
  boundLarkArchiveSummary,
  downloadLarkAttachments,
  prepareLarkFileWorkflow,
  safeSegment,
  type DownloadedLarkAttachment,
} from "./files.js";
import {
  createLarkServiceRuntime,
  type LarkServiceRuntime,
  type PendingLarkApproval,
} from "./runtime.js";
import { acquireLarkServiceLock } from "./service-lifecycle.js";
import { appendLarkTimelineEvent } from "./timeline.js";

export { createLarkDocumentWithCli } from "./document-client.js";
export type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
export { buildLarkCronExecutor } from "./cron.js";
export { resolveLarkRuntimeConfig } from "./config.js";
export type { LarkRuntimeConfig, LarkRuntimeEnv } from "./config.js";
export { createLarkServiceRuntime } from "./runtime.js";
export { resolveLarkServiceLockDir, resolveLarkServiceLockPath } from "./service-lifecycle.js";
export { cleanupLarkMessageArtifacts } from "./files.js";

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
  if (await handleLarkSimpleCommand({ ...input, requestApproval: requestLarkApproval }, normalized, commandText)) {
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
        ? boundLarkArchiveSummary(workflowResult.text)
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
