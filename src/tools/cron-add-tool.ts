import type { CronRuntime } from "../runtime/cron-runtime.js";
import { validateCronExpression } from "../runtime/cron-scheduler.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type { CronJobInput, CronJobRecord } from "../state/cron-store.js";
import type { CronDeliveryMode, CronSessionMode } from "../state/cron-store-schema.js";
import { formatInCronTimezone, normalizeCronTimezone } from "../state/cron-timezone.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import type { Locale } from "../telegram/message-renderer.js";
import type { TelegramToolContext, TelegramToolResult } from "./telegram-tool-types.js";

export type CronAddToolContext = TelegramToolContext;

// Wall-clock ISO date-time WITHOUT an explicit offset/Z (optionally date-only).
// `new Date()` would interpret these in the HOST process timezone, so reminders
// fire hours off when the host TZ differs from the operator's cron timezone;
// these are resolved in the job/instance timezone instead.
const OFFSETLESS_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const zonedAsUtcMs = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return zonedAsUtcMs - Math.floor(date.getTime() / 1000) * 1000;
}

/** Resolves an offset-less wall-clock time to the instant it names in `timezone`.
 * Returns null for impossible component values (e.g. month 13). */
function wallClockInTimezoneToInstant(match: RegExpExecArray, timezone: string): Date | null {
  const [, year, month, day, hour, minute, second, fraction] = match;
  const components = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? "0"),
    minute: Number(minute ?? "0"),
    second: Number(second ?? "0"),
    millisecond: Number((fraction ?? "").padEnd(3, "0") || "0"),
  };
  const wallClockAsUtcMs = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    components.millisecond,
  );
  const probe = new Date(wallClockAsUtcMs);
  if (
    probe.getUTCFullYear() !== components.year ||
    probe.getUTCMonth() !== components.month - 1 ||
    probe.getUTCDate() !== components.day ||
    probe.getUTCHours() !== components.hour ||
    probe.getUTCMinutes() !== components.minute
  ) {
    return null;
  }
  // Two passes converge across DST transitions: the first guess uses the zone
  // offset at the UTC-interpreted wall clock, the second corrects it.
  let instantMs = wallClockAsUtcMs;
  for (let pass = 0; pass < 2; pass++) {
    instantMs = wallClockAsUtcMs - timezoneOffsetMs(new Date(instantMs), timezone);
  }
  return new Date(instantMs);
}

async function resolveAtInstant(
  rawAt: string,
  jobTimezone: string | undefined,
  stateDir: string,
): Promise<Date> {
  const offsetlessMatch = OFFSETLESS_AT_PATTERN.exec(rawAt.trim());
  if (!offsetlessMatch) {
    // Offset-carrying (or non-ISO) strings keep the existing Date parsing.
    return new Date(rawAt);
  }
  // The job's own timezone wins; otherwise the instance cron timezone — the same
  // default CronStore assigns to the stored record.
  const timezone = jobTimezone ?? (await loadInstanceConfig(stateDir)).timezone;
  const instant = wallClockInTimezoneToInstant(offsetlessMatch, timezone);
  return instant ?? new Date(Number.NaN);
}

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

function asOptionalSessionMode(value: unknown): CronSessionMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value !== "reuse" && value !== "new_per_run") {
    throw new Error("sessionMode must be 'reuse' or 'new_per_run'");
  }
  return value;
}

function asOptionalDeliveryMode(value: unknown): CronDeliveryMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value !== "agent" && value !== "notify") {
    throw new Error("deliveryMode must be 'agent' or 'notify'");
  }
  return value;
}

function parsePayload(payload: unknown): unknown {
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

async function buildCronInput(
  payload: unknown,
  context: Pick<
    CronAddToolContext,
    | "channel"
    | "chatId"
    | "messageThreadId"
    | "userId"
    | "chatType"
    | "conversationKey"
    | "larkChatId"
    | "larkThreadId"
    | "larkMessageId"
    | "locale"
    | "stateDir"
  >,
): Promise<CronJobInput> {
  const parsedPayload = parsePayload(payload);
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
    throw new Error("cron-add payload must be a JSON object");
  }
  const body = parsedPayload as Record<string, unknown>;
  const prompt = asPrompt(body.prompt);
  const timezone = normalizeCronTimezone(body.timezone);
  const sessionMode = asOptionalSessionMode(body.sessionMode) ?? "new_per_run";
  const deliveryMode = asOptionalDeliveryMode(body.deliveryMode);
  if (body.timezone !== undefined && timezone === undefined) {
    throw new Error("timezone must be a valid IANA timezone like Asia/Shanghai");
  }
  const hasIn = body.in !== undefined && body.in !== null && body.in !== "";
  const hasAt = body.at !== undefined && body.at !== null && body.at !== "";
  const hasCron = body.cron !== undefined && body.cron !== null && body.cron !== "";
  const modeCount = [hasIn, hasAt, hasCron].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("use exactly one of in, at, or cron");
  }

  if (hasCron) {
    const cronExpr = asOptionalString(body.cron, "cron", 120)!;
    if (validateCronExpression(cronExpr, timezone) === null) {
      throw new Error(`invalid cron expression: "${cronExpr}"`);
    }
    return {
      channel: context.channel,
      chatId: context.chatId,
      messageThreadId: context.messageThreadId,
      userId: context.userId,
      chatType: context.chatType ?? "private",
      conversationKey: context.conversationKey,
      larkChatId: context.larkChatId,
      larkThreadId: context.larkThreadId,
      larkMessageId: context.larkMessageId,
      locale: context.locale,
      cronExpr,
      timezone,
      prompt,
      description: asOptionalString(body.description, "description", 200),
      sessionMode,
      deliveryMode: deliveryMode ?? "agent",
      maxFailures: asOptionalInteger(body.maxFailures, "maxFailures", 1, 100),
    };
  }

  let targetAt: string;
  if (hasAt) {
    const rawAt = asOptionalString(body.at, "at", 120)!;
    const date = await resolveAtInstant(rawAt, timezone, context.stateDir);
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
    channel: context.channel,
    chatId: context.chatId,
    messageThreadId: context.messageThreadId,
    userId: context.userId,
    chatType: context.chatType ?? "private",
    conversationKey: context.conversationKey,
    larkChatId: context.larkChatId,
    larkThreadId: context.larkThreadId,
    larkMessageId: context.larkMessageId,
    locale: context.locale,
    cronExpr: cronExprFromRunAt(targetAt),
    timezone,
    prompt,
    description: asOptionalString(body.description, "description", 200),
    sessionMode,
    deliveryMode: deliveryMode ?? "notify",
    maxFailures: asOptionalInteger(body.maxFailures, "maxFailures", 1, 100),
    runOnce: true,
    targetAt,
  };
}

function renderAccepted(record: CronJobRecord, locale: Locale): string {
  const when = record.runOnce && record.targetAt
    ? formatInCronTimezone(record.targetAt, record.timezone)
    : record.cronExpr;
  const timezone = record.timezone && !record.runOnce ? ` (${record.timezone})` : "";
  return locale === "zh"
    ? `✓ 已添加定时任务  ID  ${record.id}\n⏰ ${when}${timezone}\n📝 ${record.prompt}`
    : `✓ Scheduled task added  ID  ${record.id}\n⏰ ${when}${timezone}\n📝 ${record.prompt}`;
}

export function renderCronAddInvalidPayloadMessage(detail: string, locale: Locale): string | null {
  if (detail === "at must be a valid date-time" || detail.startsWith("invalid at timestamp:")) {
    return locale === "zh"
      ? "✗ 提醒时间格式无效：at 必须使用 ISO 日期时间，例如 2026-05-27T13:30:00+08:00。如果只是相对时间，请改用 in，例如 {\"in\":\"10m\",\"prompt\":\"...\"}。"
      : "✗ Invalid reminder time: at must be an ISO date-time, for example 2026-05-27T13:30:00+08:00. For relative delays, use in, for example {\"in\":\"10m\",\"prompt\":\"...\"}.";
  }
  if (detail.startsWith("in must match pattern") || detail === "in must be a duration like 10m, 2h, or 1d") {
    return locale === "zh"
      ? "✗ 提醒延迟格式无效：in 必须是 10m、2h、1d 这样的相对时长。需要具体日期时间时，请使用 ISO 格式的 at。"
      : "✗ Invalid reminder delay: in must be a relative duration like 10m, 2h, or 1d. Use ISO date-time at for an exact date and time.";
  }
  return null;
}

function renderRejected(detail: string, locale: Locale): string {
  const invalidPayloadMessage = renderCronAddInvalidPayloadMessage(detail, locale);
  if (invalidPayloadMessage) {
    return invalidPayloadMessage;
  }
  return locale === "zh"
    ? `✗ 定时任务添加失败：${detail}`
    : `✗ Failed to add scheduled task: ${detail}`;
}

export async function executeCronAddTool(payload: unknown, context: CronAddToolContext): Promise<TelegramToolResult> {
  try {
    if (!context.cronRuntime) {
      throw new Error("cron subsystem is not running");
    }
    const record = await context.cronRuntime.store.add(await buildCronInput(payload, context));
    await context.cronRuntime.scheduler.refresh();
    const message = renderAccepted(record, context.locale);
    await appendTimelineEventBestEffort(context.stateDir, {
      type: "command.handled",
      instanceName: context.instanceName,
      channel: context.channel ?? "telegram",
      chatId: context.chatId,
      userId: context.userId,
      updateId: context.updateId,
      outcome: "success",
      detail: "cron.add tool accepted",
      metadata: {
        cronJobId: record.id,
        targetAt: record.targetAt,
        cronExpr: record.cronExpr,
        timezone: record.timezone,
      },
    });
    return { ok: true, status: "accepted", message, metadata: { cronJobId: record.id } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = renderRejected(detail, context.locale);
    await appendTimelineEventBestEffort(context.stateDir, {
      type: "command.handled",
      instanceName: context.instanceName,
      channel: context.channel ?? "telegram",
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
