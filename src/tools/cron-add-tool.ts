import type { CronRuntime } from "../runtime/cron-runtime.js";
import { validateCronExpression } from "../runtime/cron-scheduler.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { CronJobInput, CronJobRecord } from "../state/cron-store.js";
import type { Locale } from "../telegram/message-renderer.js";
import type { TelegramToolContext, TelegramToolResult } from "./telegram-tool-types.js";

export type CronAddToolContext = TelegramToolContext;

function cronExprFromRunAt(iso: string): string {
  const date = new Date(iso);
  return [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    "*",
  ].join(" ");
}

function parseRelativeDelay(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{1,6})(s|m|h|d)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "s"
    ? 1000
    : unit === "m"
      ? 60_000
      : unit === "h"
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  const delayMs = amount * multiplier;
  return delayMs <= 366 * 24 * 60 * 60_000 ? delayMs : null;
}

function asPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("prompt must be a string");
  }
  const prompt = value.trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }
  if (prompt.length > 4000) {
    throw new Error("prompt exceeds max length 4000");
  }
  return prompt;
}

function asOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > max) {
    throw new Error(`${field} exceeds max length ${max}`);
  }
  return trimmed;
}

function asOptionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function parsePayload(payload: unknown): unknown {
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

function buildCronInput(payload: unknown, context: Pick<CronAddToolContext, "chatId" | "userId" | "chatType" | "locale">): CronJobInput {
  const parsedPayload = parsePayload(payload);
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
    throw new Error("cron-add payload must be a JSON object");
  }
  const body = parsedPayload as Record<string, unknown>;
  const prompt = asPrompt(body.prompt);
  const hasIn = body.in !== undefined && body.in !== null && body.in !== "";
  const hasAt = body.at !== undefined && body.at !== null && body.at !== "";
  const hasCron = body.cron !== undefined && body.cron !== null && body.cron !== "";
  const modeCount = [hasIn, hasAt, hasCron].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("use exactly one of in, at, or cron");
  }

  if (hasCron) {
    const cronExpr = asOptionalString(body.cron, "cron", 120)!;
    if (validateCronExpression(cronExpr) === null) {
      throw new Error(`invalid cron expression: "${cronExpr}"`);
    }
    return {
      chatId: context.chatId,
      userId: context.userId,
      chatType: context.chatType ?? "private",
      locale: context.locale,
      cronExpr,
      prompt,
      description: asOptionalString(body.description, "description", 200),
      maxFailures: asOptionalInteger(body.maxFailures, "maxFailures", 1, 100),
    };
  }

  let targetAt: string;
  if (hasAt) {
    const rawAt = asOptionalString(body.at, "at", 120)!;
    const date = new Date(rawAt);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`invalid at timestamp: "${rawAt}"`);
    }
    if (date.getTime() <= Date.now()) {
      throw new Error("at must be in the future");
    }
    targetAt = date.toISOString();
  } else {
    const delayMs = parseRelativeDelay(body.in);
    if (delayMs === null) {
      throw new Error("in must be a duration like 10m, 2h, or 1d");
    }
    targetAt = new Date(Date.now() + delayMs).toISOString();
  }

  return {
    chatId: context.chatId,
    userId: context.userId,
    chatType: context.chatType ?? "private",
    locale: context.locale,
    cronExpr: cronExprFromRunAt(targetAt),
    prompt,
    description: asOptionalString(body.description, "description", 200),
    maxFailures: asOptionalInteger(body.maxFailures, "maxFailures", 1, 100),
    runOnce: true,
    targetAt,
  };
}

function renderAccepted(record: CronJobRecord, locale: Locale): string {
  const when = record.runOnce && record.targetAt ? record.targetAt : record.cronExpr;
  return locale === "zh"
    ? `✓ 已添加定时任务  ID  ${record.id}\n⏰ ${when}\n📝 ${record.prompt}`
    : `✓ Scheduled task added  ID  ${record.id}\n⏰ ${when}\n📝 ${record.prompt}`;
}

function renderRejected(detail: string, locale: Locale): string {
  return locale === "zh"
    ? `✗ 定时任务添加失败：${detail}`
    : `✗ Failed to add scheduled task: ${detail}`;
}

export async function executeCronAddTool(payload: unknown, context: CronAddToolContext): Promise<TelegramToolResult> {
  try {
    if (!context.cronRuntime) {
      throw new Error("cron subsystem is not running");
    }
    const record = await context.cronRuntime.store.add(buildCronInput(payload, context));
    await context.cronRuntime.scheduler.refresh();
    const message = renderAccepted(record, context.locale);
    await appendTimelineEventBestEffort(context.stateDir, {
      type: "command.handled",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: context.chatId,
      userId: context.userId,
      updateId: context.updateId,
      outcome: "success",
      detail: "cron.add tool accepted",
      metadata: {
        cronJobId: record.id,
        targetAt: record.targetAt,
        cronExpr: record.cronExpr,
      },
    });
    return { ok: true, status: "accepted", message, metadata: { cronJobId: record.id } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = renderRejected(detail, context.locale);
    await appendTimelineEventBestEffort(context.stateDir, {
      type: "command.handled",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: context.chatId,
      userId: context.userId,
      updateId: context.updateId,
      outcome: "error",
      detail: "cron.add tool rejected",
      metadata: {
        error: detail,
      },
    });
    return { ok: false, status: "rejected", message, error: detail };
  }
}
