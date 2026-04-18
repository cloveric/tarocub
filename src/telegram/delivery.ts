import path from "node:path";

import { Bridge } from "../runtime/bridge.js";
import {
  FileWorkflowPreparationError,
} from "../runtime/file-workflow.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { dispatchAuthorizedTelegramMessage } from "./authorized-dispatch.js";
import { loadInstanceConfig, updateInstanceConfig } from "./instance-config.js";
import { deliverTelegramResponse, sendFileOrPhoto } from "./response-delivery.js";
import {
  appendUpdateReplyAuditEventBestEffort,
} from "./turn-bookkeeping.js";
import { finalizeTelegramTurnError, maybeRetryTelegramTurnError } from "./turn-error.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";

async function updateWorkflowBestEffort(
  workflowStore: FileWorkflowStore,
  workflowRecordId: string,
  mutate: Parameters<FileWorkflowStore["update"]>[1],
): Promise<void> {
  try {
    await workflowStore.update(workflowRecordId, mutate);
  } catch {
    // Visible Telegram delivery already succeeded; workflow persistence is bookkeeping-only now.
  }
}

import {
  renderErrorMessage,
  renderUnauthorizedMessage,
  type Locale,
} from "./message-renderer.js";
import { TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

export interface TelegramDeliveryContext {
  api: TelegramApi;
  bridge: Bridge;
  inboxDir: string;
  instanceName?: string;
  updateId?: number;
  abortSignal?: AbortSignal;
  onAuthRetry?: () => Promise<void>;
  _authRetried?: boolean;
  _staleSessionRetried?: boolean;
}

export async function handleNormalizedTelegramMessage(
  normalized: NormalizedTelegramMessage,
  context: TelegramDeliveryContext,
): Promise<void> {
  const startedAt = Date.now();
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  const turnState = {
    workflowRecordId: undefined as string | undefined,
    archiveSummaryDelivered: false,
    telegramOutDirPath: undefined as string | undefined,
    failureHint: undefined as string | undefined,
  };
  const stateDir = path.dirname(context.inboxDir);
  const workflowStore = new FileWorkflowStore(stateDir);
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  const cfg = await loadInstanceConfig(stateDir);
  const locale = cfg.locale;

  const startTyping = () => {
    context.api.sendChatAction(normalized.chatId).catch(() => {});
    typingInterval = setInterval(() => {
      context.api.sendChatAction(normalized.chatId).catch(() => {});
    }, 4000);
  };
  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  };

  try {
    if (normalized.callbackQueryId) {
      try {
        await context.api.answerCallbackQuery(normalized.callbackQueryId);
      } catch {
        // Callback acks are advisory; continuation should still proceed.
      }
    }
    startTyping();
    await appendTimelineEventBestEffort(stateDir, {
      type: "input.received",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      metadata: {
        attachments: normalized.attachments.length,
        hasReplyContext: normalized.replyContext !== undefined,
        hasCallbackQuery: normalized.callbackQueryId !== undefined,
      },
    });

    const accessDecision = await context.bridge.checkAccess({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
    });

    if (accessDecision.kind === "reply" || accessDecision.kind === "deny") {
      await context.api.sendMessage(
        normalized.chatId,
        accessDecision.text ?? renderErrorMessage(renderUnauthorizedMessage(locale), locale),
      );
      await appendUpdateReplyAuditEventBestEffort(path.dirname(context.inboxDir), context, normalized, {
        detail: accessDecision.text,
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
        },
      });
      return;
    }

    await dispatchAuthorizedTelegramMessage({
      stateDir,
      startedAt,
      locale,
      cfg: {
        engine: cfg.engine,
        budgetUsd: cfg.budgetUsd,
        effort: cfg.effort,
        model: cfg.model,
        resume: cfg.resume,
      },
      normalized,
      context,
      workflowStore,
      deps: {
        sessionStore,
        turnState,
        updateInstanceConfig: async (updater) => await updateInstanceConfig(stateDir, updater),
        deliverTelegramResponse: async (_api, chatId, text, inboxDir, workspaceOverride, turnLocale) => (
          deliverTelegramResponse(context.api, chatId, text, inboxDir, workspaceOverride, turnLocale)
        ),
        sendTelegramOutFile: async (chatId, filename, contents) => {
          await sendFileOrPhoto(context.api, chatId, filename, contents);
        },
        updateWorkflowBestEffort: async (_workflowStore, workflowRecordId, mutate) => {
          await updateWorkflowBestEffort(workflowStore, workflowRecordId, mutate);
        },
      },
    });
    return;
  } catch (error) {
    if (turnState.workflowRecordId === undefined && error instanceof FileWorkflowPreparationError) {
      turnState.workflowRecordId = error.workflowRecordId;
    }

    const classifiedError = error instanceof FileWorkflowPreparationError ? error.cause : error;
    const failureCategory = classifyFailure(classifiedError);
    if (await maybeRetryTelegramTurnError({
      stateDir,
      normalized,
      classifiedError,
      failureCategory,
      context,
      sessionStore,
      stopTyping,
      restart: async () => {
        await handleNormalizedTelegramMessage(normalized, context);
      },
    })) {
      return;
    }

    await finalizeTelegramTurnError({
      stateDir,
      startedAt,
      locale,
      normalized,
      context,
      workflowStore,
      classifiedError,
      failureCategory,
      turnState,
    });

  } finally {
    // Guarantee the typing interval always stops. Without this every new
    // early-return branch is a potential leak (setInterval pins the closure,
    // sendChatAction keeps firing forever). See f1bfc31 / aaca5f5 — both
    // were symptoms of this pattern.
    stopTyping();
  }
}
