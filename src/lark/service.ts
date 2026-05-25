import {
  createLarkChannel,
  type LarkChannelOptions,
} from "@larksuiteoapi/node-sdk";

import { createBridgeDependencies } from "../service.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { CronStore } from "../state/cron-store.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkCardAction, requestLarkApproval } from "./card-actions.js";
import { handleLarkComment, normalizeLarkCommentFileType } from "./comment-handler.js";
import { createLarkCommentClient } from "./comment-client.js";
import { resolveLarkRuntimeConfig, type LarkRuntimeConfig, type LarkRuntimeEnv } from "./config.js";
import { buildLarkCronExecutor } from "./cron.js";
import { deliverLarkResponse } from "./delivery.js";
import { handleLarkMessage } from "./message-handler.js";
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
export { buildLarkCronExecutor } from "./cron.js";
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
