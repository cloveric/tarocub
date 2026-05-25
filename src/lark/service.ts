import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createLarkChannel,
  type CardActionEvent,
  type LarkChannelOptions,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";

import type {
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import type { BridgeAccessDecision } from "../runtime/bridge.js";
import { ChatQueue } from "../runtime/chat-queue.js";
import { createBridgeDependencies } from "../service.js";
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
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { withFileMutex } from "../state/file-mutex.js";
import { JsonStore } from "../state/json-store.js";
import { acquireInstanceLock, resolveInstanceLockPath, type InstanceLockHandle } from "../state/instance-lock.js";
import {
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkApprovalCard,
  renderLarkRunCard,
} from "./card-renderer.js";
import {
  normalizeLarkMessage,
  stableLarkNumericId,
  type LarkIncomingMessage,
  type LarkNormalizedBridgeMessage,
  type LarkNormalizedAttachment,
} from "./message-normalizer.js";

const execFile = promisify(execFileCallback);

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

const LARK_CHAT_ID_MAP_FILENAME = "lark-chat-id-map.json";
const LARK_USER_ID_MAP_FILENAME = "lark-user-id-map.json";
const LARK_SERVICE_LOCK_DIR = "lark-service";

export interface LarkRuntimeChannelLike extends LarkChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: "cardAction", handler: (event: CardActionEvent) => void | Promise<void>): () => void;
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
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    text: string;
    conversationKey?: string;
    files: string[];
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    instructions?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }>;
}

export interface LarkDocumentCreateInput {
  title?: string;
  content: string;
  docFormat?: "xml" | "markdown";
  as?: "user" | "bot";
  parentToken?: string;
  parentPosition?: string;
}

export interface LarkDocumentCreateResult {
  title?: string;
  url?: string;
  documentId?: string;
}

export interface LarkRuntimeEnv {
  HOME?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  CODEX_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
  CLAUDE_EXECUTABLE?: string;
  ANTIGRAVITY_EXECUTABLE?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  LARK_DOMAIN?: string;
  CCTB_LARK_STATE_DIR?: string;
  LARK_REQUIRE_MENTION_IN_GROUP?: string;
}

export interface LarkRuntimeConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  stateDir: string;
  requireMentionInGroup: boolean;
}

export interface LarkServiceLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface LarkActiveRun {
  abortController: AbortController;
}

export interface PendingLarkApproval {
  requestId: string;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  replyTo?: string;
  resolve: (decision: EngineApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

export interface LarkServiceRuntime {
  activeRuns: Map<string, LarkActiveRun>;
  pendingApprovals: Map<string, PendingLarkApproval>;
  chatQueue: ChatQueue;
  createDocument: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
}

export function createLarkServiceRuntime(options: {
  createDocument?: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
} = {}): LarkServiceRuntime {
  return {
    activeRuns: new Map(),
    pendingApprovals: new Map(),
    chatQueue: new ChatQueue(),
    createDocument: options.createDocument ?? createLarkDocumentWithCli,
  };
}

export function resolveLarkRuntimeConfig(env: LarkRuntimeEnv): LarkRuntimeConfig {
  if (!env.LARK_APP_ID) {
    throw new Error("LARK_APP_ID is required");
  }
  if (!env.LARK_APP_SECRET) {
    throw new Error("LARK_APP_SECRET is required");
  }
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!env.CCTB_LARK_STATE_DIR && !env.CODEX_TELEGRAM_STATE_DIR && !homeDir) {
    throw new Error(process.platform === "win32" ? "USERPROFILE or HOME is required" : "HOME or USERPROFILE is required");
  }

  return {
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    ...(env.LARK_DOMAIN ? { domain: env.LARK_DOMAIN } : {}),
    stateDir: env.CCTB_LARK_STATE_DIR ?? env.CODEX_TELEGRAM_STATE_DIR ?? path.join(homeDir!, ".cctb", "lark"),
    requireMentionInGroup: parseBooleanEnv(env.LARK_REQUIRE_MENTION_IN_GROUP, true),
  };
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
    CODEX_TELEGRAM_INSTANCE: env.CODEX_TELEGRAM_INSTANCE ?? "lark",
  };
  const { stateDir, bridge } = options.createBridge
    ? await options.createBridge(bridgeEnv, config)
    : await createDefaultLarkBridge(bridgeEnv);
  const runtime = options.runtime ?? createLarkServiceRuntime();
  const serviceLock = await acquireLarkServiceLock(stateDir);
  let channel: LarkRuntimeChannelLike | undefined;
  let connected = false;
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
      ...(config.domain ? { domain: config.domain } : {}),
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
    channel.on("error", (error) => {
      logger.error("Lark channel error:", error);
    });

    await channel.connect();
    connected = true;
    logger.log(`Lark channel connected; stateDir=${stateDir}; lock=${serviceLock.filePath}`);
    await waitForAbort(options.signal);
  } finally {
    try {
      if (connected && channel) {
        await channel.disconnect();
      }
    } finally {
      await serviceLock.release();
    }
  }
}

export function resolveLarkServiceLockDir(stateDir: string): string {
  return path.join(stateDir, LARK_SERVICE_LOCK_DIR);
}

export function resolveLarkServiceLockPath(stateDir: string): string {
  return resolveInstanceLockPath(resolveLarkServiceLockDir(stateDir));
}

async function acquireLarkServiceLock(stateDir: string): Promise<InstanceLockHandle> {
  try {
    return await acquireInstanceLock(resolveLarkServiceLockDir(stateDir));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Instance lock already held")) {
      throw new Error(error.message.replace("Instance lock", "Lark service lock"));
    }
    throw error;
  }
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

  if (isStopCommand(normalized.text)) {
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
    await input.channel.send(normalized.chatId, { text: accessDecision.text ?? "当前聊天未获授权。" }, {
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

  const abortController = new AbortController();

  let files: string[];
  let requestOutputDir: string;
  try {
    files = await downloadLarkAttachments({
      channel: input.channel,
      stateDir: input.stateDir,
      messageId: normalized.messageId,
      attachments: normalized.attachments,
    });
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
    await input.channel.stream(normalized.chatId, {
      card: {
        initial: renderLarkRunCard(initialLarkRunState(normalized.conversationKey, normalized.bridgeChatType)),
        producer: async (controller) => {
          let runState = initialLarkRunState(normalized.conversationKey, normalized.bridgeChatType);
          const updateCard = async (event: EngineStreamEvent) => {
            const cardEvent = stripDeliveryTagsFromEvent(event);
            runState = applyLarkEngineEvent(runState, cardEvent);
            await controller.update(renderLarkRunCard(runState));
          };

          try {
            const result = await input.bridge.handleAuthorizedMessage({
              chatId: normalized.bridgeChatId,
              userId: normalized.bridgeUserId,
              chatType: normalized.bridgeChatType,
              text: normalized.text,
              conversationKey: normalized.conversationKey,
              files,
              requestOutputDir,
              workspaceOverride: input.workspaceOverride,
              abortSignal: abortController.signal,
              onEngineEvent: updateCard,
              onApprovalRequest: async (request) => await requestLarkApproval({
                channel: input.channel,
                runtime: input.runtime,
                chatId: normalized.chatId,
                conversationKey: normalized.conversationKey,
                bridgeChatType: normalized.bridgeChatType,
                replyTo: controller.messageId,
                request,
                abortSignal: request.abortSignal ?? abortController.signal,
              }),
              instructions: larkAgentInstructions(),
            });
            const resultText = stripTelegramToolTags(stripDeliveryTags(result.text));
            runState = {
              ...runState,
              status: "done",
              resultText,
            };
            await controller.update(renderLarkRunCard(runState));

            await deliverLarkResponse({
              channel: input.channel,
              runtime: input.runtime,
              chatId: normalized.chatId,
              replyTo: controller.messageId,
              text: result.text,
              stateDir: input.stateDir,
              requestOutputDir,
              workspaceOverride: input.workspaceOverride,
              conversationKey: normalized.conversationKey,
              bridgeChatType: normalized.bridgeChatType,
              sendText: false,
            });
            await appendLarkTimelineEvent(input.stateDir, normalized, {
              type: "turn.completed",
              outcome: "success",
              metadata: {
                responseChars: result.text.length,
                attachments: normalized.attachments.length,
              },
            });
          } catch (error) {
            runState = {
              ...runState,
              status: "error",
              resultText: renderLarkUserFacingError(error, "engine"),
            };
            await controller.update(renderLarkRunCard(runState));
            await appendLarkTimelineEvent(input.stateDir, normalized, {
              type: "turn.completed",
              outcome: "error",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
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

async function downloadLarkAttachments(input: {
  channel: LarkChannelLike;
  stateDir: string;
  messageId: string;
  attachments: LarkNormalizedAttachment[];
}): Promise<string[]> {
  if (input.attachments.length === 0) {
    return [];
  }
  const dir = path.join(input.stateDir, "workspace", ".lark-files", safeSegment(input.messageId), "input");
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const downloadType = attachment.kind === "image" ? "image" : "file";
    const body = await input.channel.downloadResource(attachment.fileKey, downloadType);
    const fileName = attachment.fileName ?? `${attachment.kind}-${index + 1}${defaultExtension(attachment.kind)}`;
    const filePath = path.join(dir, safeFileName(fileName));
    await writeFile(filePath, body);
    files.push(filePath);
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
    await input.channel.stream(input.chatId, {
      card: {
        initial: renderLarkRunCard(initialLarkRunState(input.conversationKey, input.bridgeChatType)),
        producer: async (controller) => {
          let runState = initialLarkRunState(input.conversationKey, input.bridgeChatType);
          const updateCard = async (event: EngineStreamEvent) => {
            const cardEvent = stripDeliveryTagsFromEvent(event);
            runState = applyLarkEngineEvent(runState, cardEvent);
            await controller.update(renderLarkRunCard(runState));
          };

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
              onEngineEvent: updateCard,
              onApprovalRequest: async (request) => await requestLarkApproval({
                channel: input.channel,
                runtime: input.runtime,
                chatId: input.chatId,
                conversationKey: input.conversationKey,
                bridgeChatType: input.bridgeChatType,
                replyTo: controller.messageId,
                request,
                abortSignal: request.abortSignal ?? abortController.signal,
              }),
              instructions: larkAgentInstructions(),
            });
            const resultText = stripTelegramToolTags(stripDeliveryTags(result.text));
            runState = {
              ...runState,
              status: "done",
              resultText,
            };
            await controller.update(renderLarkRunCard(runState));
            await deliverLarkResponse({
              channel: input.channel,
              runtime: input.runtime,
              chatId: input.chatId,
              replyTo: controller.messageId,
              text: result.text,
              stateDir: input.stateDir,
              requestOutputDir,
              conversationKey: input.conversationKey,
              bridgeChatType: input.bridgeChatType,
              sendText: false,
            });
          } catch (error) {
            runState = {
              ...runState,
              status: "error",
              resultText: renderLarkUserFacingError(error, "engine"),
            };
            await controller.update(renderLarkRunCard(runState));
          }
        },
      },
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
  if (input.sendText !== false && cleanedText) {
    await input.channel.send(input.chatId, { markdown: cleanedText }, { replyTo: input.replyTo });
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
      }, { replyTo: input.replyTo });
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
        await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, { replyTo: input.replyTo });
        continue;
      }
      const body = await readFile(real);
      if (match.preferPhoto) {
        await input.channel.send(input.chatId, { image: { source: body } }, { replyTo: input.replyTo });
      } else {
        await input.channel.send(input.chatId, {
          file: {
            source: body,
            fileName: path.basename(real),
          },
        }, { replyTo: input.replyTo });
      }
    } catch {
      await input.channel.send(input.chatId, {
        text: "文件未发送：读取文件失败，详细原因已记录到日志。",
      }, { replyTo: input.replyTo });
    }
  }
}

async function executeLarkToolTag(input: {
  channel: LarkChannelLike;
  runtime: LarkServiceRuntime;
  chatId: string;
  replyTo?: string;
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
      await input.channel.send(input.chatId, { markdown: message.trim() }, { replyTo: input.replyTo });
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
    await input.channel.send(input.chatId, { post }, { replyTo: input.replyTo });
    return;
  }

  if (input.name === "lark.card" || input.name === "send.card") {
    const card = buildLarkToolCard(payload, input.conversationKey, input.bridgeChatType);
    await input.channel.send(input.chatId, { card }, { replyTo: input.replyTo });
    return;
  }

  if (input.name === "lark.doc.create" || input.name === "lark.doc") {
    const docInput = parseLarkDocumentCreateInput(payload);
    const created = await input.runtime.createDocument(docInput);
    const label = created.title ?? docInput.title ?? "飞书文档";
    const location = created.url ?? created.documentId ?? "(created)";
    await input.channel.send(input.chatId, {
      markdown: `已创建 ${label}：\n${location}`,
    }, { replyTo: input.replyTo });
    return;
  }
}

async function sendLarkPath(input: {
  channel: LarkChannelLike;
  chatId: string;
  replyTo?: string;
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
    await input.channel.send(input.chatId, { text: "文件未发送：路径不在允许目录内。" }, { replyTo: input.replyTo });
    return;
  }
  const body = await readFile(real);
  if (input.kind === "image") {
    await input.channel.send(input.chatId, { image: { source: body } }, { replyTo: input.replyTo });
    return;
  }
  if (input.kind === "audio") {
    await input.channel.send(input.chatId, {
      audio: {
        source: body,
        fileName: path.basename(real),
      },
    }, { replyTo: input.replyTo });
    return;
  }
  if (input.kind === "video") {
    await input.channel.send(input.chatId, {
      video: {
        source: body,
        fileName: path.basename(real),
      },
    }, { replyTo: input.replyTo });
    return;
  }
  await input.channel.send(input.chatId, {
    file: {
      source: body,
      fileName: path.basename(real),
    },
  }, { replyTo: input.replyTo });
}

function stripDeliveryTagsFromEvent(event: EngineStreamEvent): EngineStreamEvent {
  if (event.type === "assistant_text" || event.type === "result") {
    return {
      ...event,
      text: stripTelegramToolTags(stripDeliveryTags(event.text)),
    };
  }
  return event;
}

export async function createLarkDocumentWithCli(input: LarkDocumentCreateInput): Promise<LarkDocumentCreateResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-doc-"));
  const contentFileName = "content.md";
  const contentPath = path.join(tempDir, contentFileName);
  const docFormat = input.docFormat ?? inferDocFormat(input.content);
  if (docFormat !== "markdown") {
    throw new Error("lark.doc.create currently requires markdown content with the installed lark-cli");
  }
  await writeFile(contentPath, input.content);
  const args = [
    "docs",
    "+create",
    "--as",
    input.as ?? "user",
  ];
  if (input.title?.trim()) {
    args.push("--title", input.title.trim());
  }
  args.push(
    "--markdown",
    `@${contentFileName}`,
  );
  if (input.parentToken) {
    args.push("--folder-token", input.parentToken);
  }
  if (input.parentPosition) {
    throw new Error("lark.doc.create parentPosition is not supported by the installed lark-cli; use parentToken/folder token instead");
  }
  try {
    const { stdout } = await execFile("lark-cli", args, { cwd: tempDir, maxBuffer: 10 * 1024 * 1024 });
    const parsed = parseLarkCliJson(stdout) as {
      ok?: boolean;
      data?: {
        document?: {
          title?: string;
          url?: string;
          document_id?: string;
          documentId?: string;
        };
        url?: string;
      };
      error?: {
        message?: string;
      };
    };
    if (parsed.ok === false) {
      throw new Error(parsed.error?.message ?? "lark-cli docs +create failed");
    }
    const document = parsed.data?.document;
    return {
      title: document?.title ?? input.title,
      url: document?.url ?? parsed.data?.url,
      documentId: document?.document_id ?? document?.documentId,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function parseLarkCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("lark-cli docs +create returned empty output");
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some lark-cli commands print human-readable headers before the JSON body.
  }

  const jsonStart = trimmed.lastIndexOf("\n{");
  if (jsonStart !== -1) {
    const candidate = trimmed.slice(jsonStart + 1);
    return JSON.parse(candidate) as unknown;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    return JSON.parse(trimmed.slice(firstBrace)) as unknown;
  }

  throw new Error("lark-cli docs +create did not return JSON output");
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

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return /^(?:1|true|yes|on)$/i.test(value.trim());
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

function extractButtonLabel(button: Record<string, unknown>): string {
  const text = payloadObject(button.text);
  const content = text && typeof text.content === "string" ? text.content.trim() : "";
  return content || "choice";
}

function parseLarkDocumentCreateInput(payload: Record<string, unknown> | null): LarkDocumentCreateInput {
  if (!payload || typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new Error("lark.doc.create requires payload.content");
  }
  const docFormat = payload.docFormat === "markdown" || payload.format === "markdown"
    ? "markdown"
    : payload.docFormat === "xml" || payload.format === "xml"
      ? "xml"
      : undefined;
  const as = payload.as === "bot" ? "bot" : payload.as === "user" ? "user" : undefined;
  return {
    content: payload.content,
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(docFormat ? { docFormat } : {}),
    ...(as ? { as } : {}),
    ...(typeof payload.parentToken === "string" ? { parentToken: payload.parentToken } : {}),
    ...(typeof payload.parentPosition === "string" ? { parentPosition: payload.parentPosition } : {}),
  };
}

type LarkNumericIdKind = "chat" | "user";

async function verifyLarkNumericIds(stateDir: string, normalized: LarkNormalizedBridgeMessage): Promise<void> {
  await assertStableLarkIdMappings(stateDir, [
    ["chat", normalized.bridgeChatId, normalized.conversationKey],
    ["user", normalized.bridgeUserId, normalized.senderId],
  ]);
}

async function assertStableLarkIdMappings(stateDir: string, mappings: Array<[LarkNumericIdKind, number, string]>): Promise<void> {
  const grouped = new Map<LarkNumericIdKind, Array<[number, string]>>();
  for (const [kind, numericId, rawId] of mappings) {
    const entries = grouped.get(kind) ?? [];
    entries.push([numericId, rawId]);
    grouped.set(kind, entries);
  }

  for (const [kind, entries] of grouped) {
    const mapPath = path.join(stateDir, larkIdMapFilename(kind));
    await withFileMutex(mapPath, async () => {
      const store = new JsonStore<Record<string, string>>(mapPath, parseLarkIdMap);
      const current = await store.read({});
      let changed = false;
      for (const [numericId, rawId] of entries) {
        const key = String(numericId);
        const existing = current[key];
        if (existing && existing !== rawId) {
          throw new Error(`Lark ${kind} numeric ID collision for ${numericId}`);
        }
        if (!existing) {
          current[key] = rawId;
          changed = true;
        }
      }
      if (changed) {
        await store.write(current);
      }
    });
  }
}

function larkIdMapFilename(kind: LarkNumericIdKind): string {
  return kind === "chat" ? LARK_CHAT_ID_MAP_FILENAME : LARK_USER_ID_MAP_FILENAME;
}

function parseLarkIdMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^\d+$/.test(key) && typeof raw === "string") {
      parsed[key] = raw;
    }
  }
  return parsed;
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

function inferDocFormat(content: string): "xml" | "markdown" {
  return /^\s*</.test(content) ? "xml" : "markdown";
}

function larkAgentInstructions(): string {
  return [
    "You are replying through Feishu/Lark via cc-telegram-bridge.",
    "Use the <lark_context> block for chat/message/thread identity; do not reveal app secrets or tokens.",
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

function isStopCommand(text: string): boolean {
  return /^\/stop(?:\s|$)/i.test(text.trim());
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
