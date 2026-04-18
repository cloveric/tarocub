import { classifyFailure, isStaleSessionError } from "../runtime/error-classification.js";
import { SessionStateError } from "../runtime/session-manager.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { FileWorkflowStore } from "../state/file-workflow-store.js";
import type { SessionStore } from "../state/session-store.js";
import {
  renderCategorizedErrorMessage,
  renderSessionStateErrorMessage,
  type Locale,
} from "./message-renderer.js";
import type { TelegramApi } from "./api.js";
import type { WorkflowAwareTurnState } from "./message-turn.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

function isResetCommand(text: string): boolean {
  return /^\/reset(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function shouldUseNonRepairableResetSessionGuidance(
  error: unknown,
  failureCategory: ReturnType<typeof classifyFailure>,
  originalText: string,
): boolean {
  if (!isResetCommand(originalText)) {
    return false;
  }

  if (error instanceof SessionStateError) {
    return !error.repairable;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  ) {
    return true;
  }

  if (failureCategory === "session-state") {
    return true;
  }

  const errorText =
    error instanceof Error
      ? `${error.name}\n${error.message}`.toLowerCase()
      : String(error).toLowerCase();

  return (
    errorText.includes("session state") ||
    errorText.includes("session-store") ||
    errorText.includes("session store") ||
    errorText.includes("session binding")
  );
}

export async function maybeRetryTelegramTurnError(input: {
  stateDir: string;
  normalized: NormalizedTelegramMessage;
  classifiedError: unknown;
  failureCategory: ReturnType<typeof classifyFailure>;
  context: {
    abortSignal?: AbortSignal;
    onAuthRetry?: () => Promise<void>;
    _authRetried?: boolean;
    _staleSessionRetried?: boolean;
    instanceName?: string;
    updateId?: number;
  };
  sessionStore: Pick<SessionStore, "removeByChatId">;
  stopTyping: () => void;
  restart: () => Promise<void>;
}): Promise<boolean> {
  const { stateDir, normalized, classifiedError, failureCategory, context, sessionStore, stopTyping, restart } = input;

  if (context.abortSignal?.aborted) {
    return true;
  }

  if (failureCategory === "auth" && context.onAuthRetry && !context._authRetried) {
    try {
      await context.onAuthRetry();
      context._authRetried = true;
      await appendTimelineEventBestEffort(stateDir, {
        type: "turn.retried",
        instanceName: context.instanceName,
        channel: "telegram",
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "retry",
        detail: "auth refresh",
      });
      stopTyping();
      await restart();
      return true;
    } catch {
      // Retry failed — fall through to normal error handling
    }
  }

  if (isStaleSessionError(classifiedError) && !context._staleSessionRetried) {
    try {
      await sessionStore.removeByChatId(normalized.chatId);
      context._staleSessionRetried = true;
      await appendTimelineEventBestEffort(stateDir, {
        type: "turn.retried",
        instanceName: context.instanceName,
        channel: "telegram",
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "retry",
        detail: "stale session",
      });
      stopTyping();
      await restart();
      return true;
    } catch {
      // Retry failed — fall through to normal error handling
    }
  }

  return false;
}

export async function finalizeTelegramTurnError(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  normalized: NormalizedTelegramMessage;
  context: TelegramTurnContext & {
    api: Pick<TelegramApi, "sendMessage">;
  };
  workflowStore: Pick<FileWorkflowStore, "update">;
  classifiedError: unknown;
  failureCategory: ReturnType<typeof classifyFailure>;
  turnState: WorkflowAwareTurnState;
}): Promise<void> {
  const {
    stateDir,
    startedAt,
    locale,
    normalized,
    context,
    workflowStore,
    classifiedError,
    failureCategory,
    turnState,
  } = input;

  const message = classifiedError instanceof Error ? classifiedError.message : String(classifiedError);
  const errorMessage = shouldUseNonRepairableResetSessionGuidance(classifiedError, failureCategory, normalized.text)
    ? renderSessionStateErrorMessage(false, locale)
    : classifiedError instanceof SessionStateError
    ? renderSessionStateErrorMessage(classifiedError.repairable, locale)
    : turnState.failureHint
    ? `${renderCategorizedErrorMessage(failureCategory, message, locale)}\n${turnState.failureHint}`
    : renderCategorizedErrorMessage(failureCategory, message, locale);
  let workflowCleanupError: unknown;

  if (turnState.workflowRecordId) {
    try {
      if (!turnState.archiveSummaryDelivered) {
        await workflowStore.update(turnState.workflowRecordId, (record) => {
          if (
            record.status === "preparing" ||
            record.status === "processing" ||
            record.status === "awaiting_continue"
          ) {
            record.status = "failed";
          }
        });
        await appendTimelineEventBestEffort(stateDir, {
          type: "workflow.failed",
          instanceName: context.instanceName,
          channel: "telegram",
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          detail: "workflow marked failed",
          metadata: {
            workflowRecordId: turnState.workflowRecordId,
            failureCategory,
          },
        });
      }
    } catch (cleanupError) {
      workflowCleanupError = cleanupError;
    }
  }

  if (!turnState.archiveSummaryDelivered) {
    await context.api.sendMessage(normalized.chatId, errorMessage);
  }

  await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
    outcome: "error",
    detail: message,
    metadata: {
      durationMs: Date.now() - startedAt,
      attachments: normalized.attachments.length,
      failureCategory,
      workflowCleanupError:
        workflowCleanupError === undefined
          ? undefined
          : workflowCleanupError instanceof Error
            ? workflowCleanupError.message
            : String(workflowCleanupError),
    },
  });
}
