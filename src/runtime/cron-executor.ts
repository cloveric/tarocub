import type { Bridge } from "./bridge.js";
import type { TelegramApi } from "../telegram/api.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import type { handleNormalizedTelegramMessage } from "../telegram/delivery.js";
import { CronAccessDeniedError } from "./cron-errors.js";

export interface CronExecutorContext {
  api: TelegramApi;
  bridge: Bridge;
  inboxDir: string;
  instanceName?: string;
}

interface SilentTelegramMessage {
  message_id: number;
}

const SILENT_REPLY: SilentTelegramMessage = { message_id: 0 };

/**
 * Wrap a TelegramApi with a no-op proxy so mute=true cron jobs run the engine
 * without delivering anything to the Telegram chat. file delivery (sendDocument
 * / sendPhoto / sendMediaGroup) is also silenced — mute means truly invisible.
 *
 * sendChatAction is silenced too: a typing indicator from a muted cron would
 * defeat the point.
 *
 * editMessage stays a no-op; getFile / downloadFile / answerCallbackQuery stay
 * functional in case a workflow path tries to read attachments before deciding
 * to suppress the reply.
 */
function muteTelegramApi(api: TelegramApi): TelegramApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      switch (prop) {
        case "sendMessage":
          return async (): Promise<SilentTelegramMessage> => SILENT_REPLY;
        case "sendDocument":
          return async (): Promise<SilentTelegramMessage> => SILENT_REPLY;
        case "sendPhoto":
          return async (): Promise<SilentTelegramMessage> => SILENT_REPLY;
        case "sendMediaGroup":
          return async (): Promise<void> => undefined;
        case "sendChatAction":
          return async (): Promise<void> => undefined;
        case "editMessage":
          return async (): Promise<SilentTelegramMessage> => SILENT_REPLY;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

function silentTelegramApi(api: TelegramApi): TelegramApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      switch (prop) {
        case "sendMessage":
          return async (chatId: number, text: string, options?: Record<string, unknown>) =>
            target.sendMessage(chatId, text, { ...options, disableNotification: true });
        case "sendDocument":
          return async (chatId: number, filename: string, contents: string | Uint8Array, options?: Record<string, unknown>) =>
            target.sendDocument(chatId, filename, contents, { ...options, disableNotification: true });
        case "sendPhoto":
          return async (
            chatId: number,
            filename: string,
            contents: Uint8Array,
            caption?: string,
            options?: Record<string, unknown>,
          ) => target.sendPhoto(chatId, filename, contents, caption, { ...options, disableNotification: true });
        case "sendMediaGroup":
          return async (
            chatId: number,
            photos: Array<{ filename: string; contents: Uint8Array; caption?: string }>,
            options?: Record<string, unknown>,
          ) => target.sendMediaGroup(chatId, photos, { ...options, disableNotification: true });
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}

/**
 * Build a synthetic NormalizedTelegramMessage that the rest of the pipeline
 * (handleNormalizedTelegramMessage → executeWorkflowAwareTelegramTurn) treats
 * like a real Telegram message. Cron-triggered turns deliberately omit
 * `callbackQueryId` and attachments because they originate from the scheduler.
 */
function buildSyntheticMessage(job: CronJobRecord): NormalizedTelegramMessage {
  return {
    chatId: job.chatId,
    userId: job.userId,
    chatType: job.chatType,
    text: job.prompt,
    attachments: [],
  };
}

export interface BuildCronExecutorOptions extends CronExecutorContext {
  handler: typeof handleNormalizedTelegramMessage;
}

/**
 * Build the executor function that {@link CronScheduler} calls when a job
 * fires. The returned function:
 *  - constructs a synthetic NormalizedTelegramMessage from the job
 *  - wraps the TelegramApi with a mute proxy when job.mute is true
 *  - calls handleNormalizedTelegramMessage with `updateId: undefined` (cron
 *    triggers do not have Telegram update_ids and must not pollute the
 *    watermark or `enqueuedUpdateIds` dedup set)
 */
function createCronSessionId(job: CronJobRecord): string {
  return `telegram-cron-${job.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildCronExecutor(options: BuildCronExecutorOptions): (job: CronJobRecord, abortSignal?: AbortSignal) => Promise<void> {
  const handler = options.handler;
  return async (job: CronJobRecord, abortSignal?: AbortSignal): Promise<void> => {
    const accessDecision = await options.bridge.checkAccess({
      chatId: job.chatId,
      userId: job.userId,
      chatType: job.chatType,
      locale: job.locale,
    });
    if (accessDecision.kind !== "allow") {
      throw new CronAccessDeniedError(accessDecision.text ? `cron access denied: ${accessDecision.text}` : undefined);
    }

    const effectiveApi = job.mute
      ? muteTelegramApi(options.api)
      : job.silent
        ? silentTelegramApi(options.api)
        : options.api;
    const normalized = buildSyntheticMessage(job);
    await handler(normalized, {
      api: effectiveApi,
      bridge: options.bridge,
      inboxDir: options.inboxDir,
      instanceName: options.instanceName,
      updateId: undefined,
      source: "cron",
      abortSignal,
      sessionIdOverride: job.sessionMode === "new_per_run" ? createCronSessionId(job) : undefined,
    });
  };
}

export async function sendCronFailureNotification(
  api: Pick<TelegramApi, "sendMessage">,
  job: CronJobRecord,
  detail: string,
): Promise<void> {
  if (job.mute) {
    return;
  }
  const message = job.locale === "zh"
    ? `⚠️ 定时任务执行失败\nID  ${job.id}\n📝 ${job.prompt}\n错误：${detail}`
    : `⚠️ Scheduled task failed\nID  ${job.id}\n📝 ${job.prompt}\nError: ${detail}`;
  await api.sendMessage(job.chatId, message, job.silent ? { disableNotification: true } : undefined);
}
