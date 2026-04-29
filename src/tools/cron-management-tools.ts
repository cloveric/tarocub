import type { CronJobRecord } from "../state/cron-store.js";
import type { TelegramToolContext, TelegramToolResult } from "./telegram-tool-types.js";

function parsePayloadObject(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null || payload === "") {
    return {};
  }
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asId(payload: unknown): string {
  const body = parsePayloadObject(payload);
  const id = body.id;
  if (typeof id !== "string" || !/^[a-f0-9]{8}$/.test(id)) {
    throw new Error("id must be an 8-character lowercase hex string");
  }
  return id;
}

function renderRejected(detail: string, context: TelegramToolContext): TelegramToolResult {
    return {
      ok: false,
      status: "rejected",
      message: context.locale === "zh"
      ? `✗ 定时任务操作失败：${detail}`
      : `✗ Scheduled task operation failed: ${detail}`,
    error: detail,
  };
}

function requireCronRuntime(context: TelegramToolContext): NonNullable<TelegramToolContext["cronRuntime"]> {
  if (!context.cronRuntime) {
    throw new Error("cron subsystem is not running");
  }
  return context.cronRuntime;
}

function renderSchedule(job: CronJobRecord): string {
  return job.runOnce && job.targetAt
    ? job.targetAt
    : `${job.cronExpr}${job.timezone ? `  TZ ${job.timezone}` : ""}`;
}

function renderJob(job: CronJobRecord, index: number, locale: TelegramToolContext["locale"]): string {
  const status = job.enabled
    ? locale === "zh" ? "已启用" : "enabled"
    : locale === "zh" ? "已停用" : "disabled";
  const last = job.lastRunAt
    ? locale === "zh"
      ? `\n   上次：${job.lastRunAt}${job.lastError ? ` 失败：${job.lastError}` : " 成功"}`
      : `\n   last: ${job.lastRunAt}${job.lastError ? ` failed: ${job.lastError}` : " success"}`
    : "";
  const failures = job.failureCount > 0
    ? locale === "zh"
      ? `\n   失败次数：${job.failureCount}/${job.maxFailures}`
      : `\n   failures: ${job.failureCount}/${job.maxFailures}`
    : "";
  const latestHistory = job.runHistory.at(-1);
  const recent = latestHistory
    ? locale === "zh"
      ? `\n   最近：${latestHistory.ranAt}${latestHistory.success ? " 成功" : ` 失败：${latestHistory.error ?? "unknown error"}`}`
      : `\n   recent: ${latestHistory.ranAt}${latestHistory.success ? " success" : ` failed: ${latestHistory.error ?? "unknown error"}`}`
    : "";
  return `${index}. ID  ${job.id}  ${status}\n   ⏰ ${renderSchedule(job)}\n   📝 ${job.prompt}${last}${failures}${recent}`;
}

async function getCurrentChatJob(id: string, context: TelegramToolContext): Promise<CronJobRecord> {
  const runtime = requireCronRuntime(context);
  const job = await runtime.store.get(id);
  if (!job || job.chatId !== context.chatId) {
    throw new Error(context.locale === "zh" ? `未找到任务：${id}` : `Task not found: ${id}`);
  }
  return job;
}

export async function executeCronListTool(_payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const jobs = await runtime.store.listByChat(context.chatId);
    if (jobs.length === 0) {
      return {
        ok: true,
        status: "accepted",
        message: context.locale === "zh" ? "暂无定时任务。" : "No scheduled tasks.",
      };
    }
    const header = context.locale === "zh"
      ? `📅 已安排 ${jobs.length} 个任务：`
      : `📅 ${jobs.length} scheduled task${jobs.length === 1 ? "" : "s"}:`;
    return {
      ok: true,
      status: "accepted",
      message: `${header}\n\n${jobs.map((job, idx) => renderJob(job, idx + 1, context.locale)).join("\n\n")}`,
      metadata: { count: jobs.length },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context);
  }
}

export async function executeCronRemoveTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const id = asId(payload);
    await getCurrentChatJob(id, context);
    await runtime.store.remove(id);
    await runtime.scheduler.refresh();
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 已删除任务  ID  ${id}` : `✓ Removed task  ID  ${id}`,
      metadata: { cronJobId: id },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context);
  }
}

export async function executeCronToggleTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const id = asId(payload);
    await getCurrentChatJob(id, context);
    const updated = await runtime.store.toggleEnabled(id);
    if (!updated) {
      throw new Error(context.locale === "zh" ? `未找到任务：${id}` : `Task not found: ${id}`);
    }
    await runtime.scheduler.refresh();
    const stateLabel = updated.enabled
      ? context.locale === "zh" ? "已启用" : "enabled"
      : context.locale === "zh" ? "已停用" : "disabled";
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 任务 ${id} ${stateLabel}` : `✓ Task ${id} ${stateLabel}`,
      metadata: { cronJobId: id, enabled: updated.enabled },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context);
  }
}

export async function executeCronRunTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const id = asId(payload);
    await getCurrentChatJob(id, context);
    void runtime.scheduler.runJobNow(id).catch(() => {});
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 任务 ${id} 已触发` : `✓ Task ${id} triggered`,
      metadata: { cronJobId: id },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context);
  }
}
