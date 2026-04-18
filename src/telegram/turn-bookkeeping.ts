import type { AdapterUsage } from "../codex/adapter.js";
import { appendAuditEventBestEffort } from "../runtime/audit-events.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import type { TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

export interface TelegramTurnContext {
  api: Pick<TelegramApi, "sendMessage">;
  instanceName?: string;
  updateId?: number;
}

export async function appendUpdateHandleAuditEventBestEffort(
  stateDir: string,
  context: TelegramTurnContext,
  normalized: NormalizedTelegramMessage,
  input: {
    outcome: "success" | "error" | "reply" | "duplicate" | "invalid" | "empty";
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const metadata = input.outcome === "error" && input.metadata?.failureCategory === undefined
    ? {
      ...input.metadata,
      failureCategory: classifyFailure(input.detail ?? "update.handle"),
    }
    : input.metadata;

  await appendAuditEventBestEffort(stateDir, {
    type: "update.handle",
    instanceName: context.instanceName,
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: input.outcome,
    detail: input.detail,
    metadata,
  });

  await appendTimelineEventBestEffort(stateDir, {
    type: typeof input.metadata?.command === "string" ? "command.handled" : "turn.completed",
    instanceName: context.instanceName,
    channel: "telegram",
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: input.outcome,
    detail: input.detail,
    metadata,
  });
}

export async function appendUpdateReplyAuditEventBestEffort(
  stateDir: string,
  context: TelegramTurnContext,
  normalized: NormalizedTelegramMessage,
  input: {
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendAuditEventBestEffort(stateDir, {
    type: "update.reply",
    instanceName: context.instanceName,
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: "reply",
    detail: input.detail,
    metadata: input.metadata,
  });
}

export async function appendCommandSuccessAuditEventBestEffort(
  stateDir: string,
  context: TelegramTurnContext,
  normalized: NormalizedTelegramMessage,
  input: {
    startedAt: number;
    command: string;
    responseText?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
    outcome: "success",
    metadata: {
      durationMs: Date.now() - input.startedAt,
      command: input.command,
      attachments: normalized.attachments.length,
      responseChars: input.responseText?.length,
      chunkCount: input.responseText ? chunkTelegramMessage(input.responseText).length : undefined,
      ...input.metadata,
    },
  });
}

export async function maybeReplyWithBudgetExhausted(
  stateDir: string,
  budgetUsd: number | undefined,
  locale: Locale,
  context: TelegramTurnContext,
  normalized: NormalizedTelegramMessage,
): Promise<boolean> {
  const exhausted = await checkBudgetAvailability(stateDir, budgetUsd, locale);
  if (!exhausted) {
    return false;
  }

  await context.api.sendMessage(normalized.chatId, exhausted.message);
  await appendUpdateReplyAuditEventBestEffort(stateDir, context, normalized, {
    detail: "budget exhausted",
  });
  await appendTimelineEventBestEffort(stateDir, {
    type: "budget.blocked",
    instanceName: context.instanceName,
    channel: "telegram",
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    detail: "budget exhausted",
    metadata: {
      budgetUsd: exhausted.budgetUsd,
      totalCostUsd: exhausted.usage.totalCostUsd,
    },
  });
  return true;
}

export async function recordTurnUsageAndBudgetAudit(
  stateDir: string,
  budgetUsd: number | undefined,
  context: TelegramTurnContext,
  normalized: NormalizedTelegramMessage,
  usage: AdapterUsage | undefined,
): Promise<void> {
  const recorded = await recordBridgeTurnUsage(stateDir, usage, budgetUsd);
  if (!recorded?.reachedBudget || budgetUsd === undefined) {
    return;
  }

  await appendUpdateReplyAuditEventBestEffort(stateDir, context, normalized, {
    detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
  });
  await appendTimelineEventBestEffort(stateDir, {
    type: "budget.threshold_reached",
    instanceName: context.instanceName,
    channel: "telegram",
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
    metadata: {
      budgetUsd,
      totalCostUsd: recorded.usage.totalCostUsd,
      requestCount: recorded.usage.requestCount,
    },
  });
}
