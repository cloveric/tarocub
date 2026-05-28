import {
  createLarkChannel,
  type LarkChannelOptions,
} from "@larksuiteoapi/node-sdk";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { stripGeneratedTelegramTransportSection } from "../commands/access.js";
import { createBridgeDependencies } from "../service.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { CronStore } from "../state/cron-store.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkCardAction, requestLarkApproval } from "./card-actions.js";
import { handleLarkComment, normalizeLarkCommentFileType } from "./comment-handler.js";
import { createLarkCommentClient } from "./comment-client.js";
import { resolveLarkRuntimeConfig, type LarkRuntimeConfig, type LarkRuntimeEnv } from "./config.js";
import { buildLarkCronExecutor, sendLarkCronFailureNotification } from "./cron.js";
import { deliverLarkResponse } from "./delivery.js";
import { larkOperatorRawId } from "./identity.js";
import { resolveLarkLocale } from "./locale.js";
import { handleLarkMessage } from "./message-handler.js";
import { stableLarkNumericId } from "./message-normalizer.js";
import { resolveLarkReactionSettings } from "./reactions.js";
import { redactLarkErrorDetail } from "./redaction.js";
import { renderLarkUserFacingError } from "./errors.js";
import {
  createLarkServiceRuntime,
  type LarkServiceRuntime,
} from "./runtime.js";
import { acquireLarkServiceLock } from "./service-lifecycle.js";
import type {
  LarkBridgeLike,
  LarkRuntimeChannelLike,
  LarkServiceLogger,
} from "./types.js";

export { createLarkDocumentWithCli } from "./document-client.js";
export type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
export { createLarkChatWithCli } from "./chat-client.js";
export type { LarkChatCreateInput, LarkChatCreateResult } from "./chat-client.js";
export { buildLarkCronExecutor, sendLarkCronFailureNotification } from "./cron.js";
export { handleLarkCardAction, requestLarkApproval } from "./card-actions.js";
export { handleLarkComment } from "./comment-handler.js";
export { handleLarkMessage } from "./message-handler.js";
export { resolveLarkRuntimeConfig } from "./config.js";
export type { LarkRuntimeConfig, LarkRuntimeEnv } from "./config.js";
export { createLarkServiceRuntime } from "./runtime.js";
export { resolveLarkServiceLockDir, resolveLarkServiceLockPath } from "./service-lifecycle.js";
export { cleanupLarkMessageArtifacts } from "./files.js";
export type {
  LarkBridgeLike,
  LarkChannelLike,
  LarkRuntimeChannelLike,
  LarkSendOptions,
  LarkServiceLogger,
  LarkStreamControllerLike,
} from "./types.js";

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
  const debugLogging = isLarkDebugEnabled(env.CCTB_LARK_DEBUG);
  const reactionSettings = resolveLarkReactionSettings(env);
  const bridgeEnv = {
    ...env,
    CODEX_TELEGRAM_STATE_DIR: config.stateDir,
    CODEX_TELEGRAM_INSTANCE: "lark",
  };
  await removeGeneratedTelegramTransportFromLarkAgent(config.stateDir, logger);
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
      source: "tarocub",
      policy: {
        dmMode: "open",
        requireMention: false,
        respondToMentionAll: false,
      },
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
        if (debugLogging) {
          logger.log("Lark raw message event", JSON.stringify({
            chatId: message.chatId,
            chatType: message.chatType,
            messageId: message.messageId,
            mentionedBot: message.mentionedBot === true,
            mentionAll: message.mentionAll === true,
            contentLength: typeof message.content === "string" ? message.content.length : 0,
            rawContentType: message.rawContentType,
            resources: Array.isArray(message.resources) ? message.resources.length : 0,
          }));
        }
        await handleLarkMessage({
          channel: channel!,
          bridge,
          runtime,
          stateDir,
          message,
          requireMentionInGroup: config.requireMentionInGroup,
          reactionSettings,
        });
      } catch (error) {
        logLarkServiceError(logger, "Lark message handling failed", error);
        await appendLarkServiceMessageErrorTimelineEvent(stateDir, message);
        const locale = await resolveLarkLocale(stateDir);
        await channel!.send(message.chatId, {
          text: renderLarkUserFacingError(error, "engine", locale),
        }, {
          replyTo: message.messageId,
          ...((message as { threadId?: string }).threadId ? { replyInThread: true } : {}),
        }).catch(() => undefined);
      }
    });
    channel.on("reject", (event) => {
      if (debugLogging) {
        logger.log("Lark SDK rejected message", JSON.stringify({
          chatId: event.chatId,
          messageId: event.messageId,
          reason: event.reason,
        }));
      }
    });
    channel.on("cardAction", async (event) => {
      try {
        await handleLarkCardAction({ channel: channel!, bridge, runtime, stateDir, event });
      } catch (error) {
        logLarkServiceError(logger, "Lark card action handling failed", error);
        await appendLarkServiceCardActionErrorTimelineEvent(stateDir, event);
        const locale = await resolveLarkLocale(stateDir);
        await channel!.send(event.chatId, {
          text: renderLarkUserFacingError(error, "engine", locale),
        }, {
          replyTo: event.messageId,
          ...getCardActionReplyInThreadOption(event),
        }).catch(() => undefined);
      }
    });
    channel.on("comment", async (event) => {
      try {
        await handleLarkComment({ bridge, runtime, stateDir, event });
      } catch (error) {
        logLarkServiceError(logger, "Lark comment handling failed", error);
        await appendLarkServiceCommentErrorTimelineEvent(stateDir, event);
        if (event.mentionedBot && runtime.commentClient) {
          const locale = await resolveLarkLocale(stateDir);
          await runtime.commentClient.createReply({
            fileToken: event.fileToken,
            fileType: normalizeLarkCommentFileType(event.fileType),
            commentId: event.commentId,
            text: renderLarkUserFacingError(error, "engine", locale),
          }).catch(() => undefined);
        }
      }
    });
    channel.on("error", async (error) => {
      logLarkServiceError(logger, "Lark channel error", error);
      await appendLarkChannelErrorTimelineEvent(stateDir, error);
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
          await sendLarkCronFailureNotification(channel!, job, detail);
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

function logLarkServiceError(logger: LarkServiceLogger, label: string, error: unknown): void {
  logger.error(`${label}: ${redactLarkErrorDetail(error)}`);
}

async function appendLarkChannelErrorTimelineEvent(stateDir: string, error: unknown): Promise<void> {
  const conversationKey = "lark:service";
  await appendTimelineEventBestEffort(stateDir, {
    type: "service.error",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    conversationKey,
    outcome: "error",
    detail: redactLarkErrorDetail(error),
    metadata: {
      phase: "channel",
    },
  }, "Lark channel error timeline event");
}

async function appendLarkServiceCommentErrorTimelineEvent(
  stateDir: string,
  event: {
    fileToken: string;
    fileType: string;
    commentId: string;
    operator?: {
      openId?: string;
      userId?: string;
    };
    mentionedBot?: boolean;
  },
): Promise<void> {
  const conversationKey = `lark-comment:${event.fileToken}`;
  const operatorRawId = larkOperatorRawId(event.operator);
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${operatorRawId}`),
    conversationKey,
    outcome: "error",
    detail: "service-level comment handling failed",
    metadata: {
      phase: "service-comment",
      larkSurface: "comment",
      fileToken: event.fileToken,
      fileType: normalizeLarkCommentFileType(event.fileType),
      commentId: event.commentId,
      mentionedBot: event.mentionedBot === true,
    },
  }, "Lark service comment error timeline event");
}

async function appendLarkServiceCardActionErrorTimelineEvent(
  stateDir: string,
  event: {
    messageId: string;
    chatId: string;
    operator?: {
      openId?: string;
      userId?: string;
    };
    action?: {
      value?: unknown;
    };
  },
): Promise<void> {
  const value = getCardActionValue(event);
  const conversationKey = typeof value?.conversationKey === "string" ? value.conversationKey : `lark:${event.chatId}`;
  const operatorRawId = event.operator?.openId ?? event.operator?.userId ?? "unknown";
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${operatorRawId}`),
    conversationKey,
    outcome: "error",
    detail: "service-level card action handling failed",
    metadata: {
      phase: "service-card-action",
      larkChatId: event.chatId,
      larkMessageId: event.messageId,
      bridgeChatType: value?.bridgeChatType === "group" ? "group" : "private",
    },
  }, "Lark service card action error timeline event");
}

async function appendLarkServiceMessageErrorTimelineEvent(
  stateDir: string,
  message: {
    messageId: string;
    chatId: string;
    chatType: string;
    senderId?: string;
    threadId?: string;
  },
): Promise<void> {
  const conversationKey = message.threadId ? `lark:${message.chatId}:${message.threadId}` : `lark:${message.chatId}`;
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${message.senderId ?? "unknown"}`),
    conversationKey,
    outcome: "error",
    detail: "service-level message handling failed",
    metadata: {
      phase: "service-message",
      larkChatId: message.chatId,
      larkMessageId: message.messageId,
      bridgeChatType: message.chatType === "p2p" ? "private" : "group",
    },
  }, "Lark service message error timeline event");
}

function getCardActionReplyInThreadOption(event: {
  action?: {
    value?: unknown;
  };
}): { replyInThread: true } | Record<string, never> {
  const value = getCardActionValue(event);
  return value?.replyInThread === true ? { replyInThread: true } : {};
}

function getCardActionValue(event: {
  action?: {
    value?: unknown;
  };
}): Record<string, unknown> | null {
  const value = event.action?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isLarkDebugEnabled(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

async function removeGeneratedTelegramTransportFromLarkAgent(
  stateDir: string,
  logger: LarkServiceLogger,
): Promise<void> {
  const agentPath = path.join(stateDir, "agent.md");
  try {
    const original = await readFile(agentPath, "utf8");
    const stripped = stripGeneratedTelegramTransportSection(original);
    if (!stripped.removed) {
      return;
    }
    await writeFile(agentPath, stripped.content, { encoding: "utf8", mode: 0o600 });
    logger.log("Removed generated Telegram Transport instructions from Lark agent.md; Lark transport is injected per turn.");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
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
