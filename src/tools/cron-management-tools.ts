import type { CronJobRecord } from "../state/cron-store.js";
import type { TelegramToolContext, TelegramToolResult } from "./telegram-tool-types.js";

type CronJobSelector = { kind: "id"; id: string } | { kind: "query"; query: string };

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

function parseSelector(payload: unknown): CronJobSelector {
  const body = parsePayloadObject(payload);
  const id = body.id;
  const query = body.query;
  const hasId = typeof id === "string" && id.trim() !== "";
  const hasQuery = typeof query === "string" && query.trim() !== "";
  if (hasId === hasQuery) {
    throw new Error("use exactly one of id or query");
  }
  if (hasId) {
    const trimmed = id.trim();
    if (!/^[a-f0-9]{8}$/.test(trimmed)) {
      throw new Error("id must be an 8-character lowercase hex string");
    }
    return { kind: "id", id: trimmed };
  }
  const trimmed = (query as string).trim();
  if (trimmed.length > 200) {
    throw new Error("query must be at most 200 characters");
  }
  return { kind: "query", query: trimmed };
}

function asId(payload: unknown): string {
  const selector = parseSelector(payload);
  if (selector.kind !== "id") {
    throw new Error("id must be an 8-character lowercase hex string");
  }
  return selector.id;
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
  if (!job || job.chatId !== context.chatId || job.messageThreadId !== context.messageThreadId) {
    throw new Error(context.locale === "zh" ? `未找到任务：${id}` : `Task not found: ${id}`);
  }
  return job;
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[\s"'“”‘’`.,，。:：;；!?！？()\[\]{}<>《》【】]/g, "");
}

function stripQueryActionWords(value: string): string {
  return value
    .trim()
    .replace(/^(请)?(帮我)?(把)?(停掉|停止|取消|删除|关掉|关闭|禁用|暂停|remove|delete|cancel|stop|disable)\s*/i, "")
    .replace(/\s*(的)?(定时任务|提醒任务|提醒|任务|cron\s*job|job)$/i, "")
    .trim();
}

function jobSearchText(job: CronJobRecord): string {
  return [
    job.id,
    job.prompt,
    job.description ?? "",
    renderSchedule(job),
  ].join("\n").toLowerCase();
}

function jobMatchesQuery(job: CronJobRecord, query: string): boolean {
  const haystack = jobSearchText(job);
  const compactHaystack = compactSearchText(haystack);
  const candidates = Array.from(new Set([query, stripQueryActionWords(query)]))
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    if (haystack.includes(lower) || compactHaystack.includes(compactSearchText(lower))) {
      return true;
    }
    const tokens = lower.split(/\s+/).filter(Boolean);
    return tokens.length > 1 && tokens.every((token) => haystack.includes(token) || compactHaystack.includes(compactSearchText(token)));
  });
}

async function getCurrentChatJobBySelector(selector: CronJobSelector, context: TelegramToolContext): Promise<CronJobRecord> {
  if (selector.kind === "id") {
    return getCurrentChatJob(selector.id, context);
  }
  const runtime = requireCronRuntime(context);
  const jobs = await runtime.store.listByConversation(context.chatId, context.messageThreadId);
  const matches = jobs.filter((job) => jobMatchesQuery(job, selector.query));
  if (matches.length === 0) {
    throw new Error(context.locale === "zh"
      ? `未找到匹配任务：${selector.query}`
      : `No matching task: ${selector.query}`);
  }
  if (matches.length > 1) {
    const list = matches.map((job, index) => renderJob(job, index + 1, context.locale)).join("\n\n");
    throw new Error(context.locale === "zh"
      ? `匹配到多个任务，请使用 ID：\n\n${list}`
      : `Multiple tasks matched; use an ID:\n\n${list}`);
  }
  return matches[0]!;
}

export async function executeCronListTool(_payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const jobs = await runtime.store.listByConversation(context.chatId, context.messageThreadId);
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
    const job = await getCurrentChatJobBySelector(parseSelector(payload), context);
    await runtime.store.remove(job.id);
    await runtime.scheduler.refresh();
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 已删除任务  ID  ${job.id}` : `✓ Removed task  ID  ${job.id}`,
      metadata: { cronJobId: job.id },
    };
  } catch (error) {
    return renderRejected(error instanceof Error ? error.message : String(error), context);
  }
}

export async function executeCronToggleTool(payload: unknown, context: TelegramToolContext): Promise<TelegramToolResult> {
  try {
    const runtime = requireCronRuntime(context);
    const job = await getCurrentChatJobBySelector(parseSelector(payload), context);
    const updated = await runtime.store.toggleEnabled(job.id);
    if (!updated) {
      throw new Error(context.locale === "zh" ? `未找到任务：${job.id}` : `Task not found: ${job.id}`);
    }
    await runtime.scheduler.refresh();
    const stateLabel = updated.enabled
      ? context.locale === "zh" ? "已启用" : "enabled"
      : context.locale === "zh" ? "已停用" : "disabled";
    return {
      ok: true,
      status: "accepted",
      message: context.locale === "zh" ? `✓ 任务 ${job.id} ${stateLabel}` : `✓ Task ${job.id} ${stateLabel}`,
      metadata: { cronJobId: job.id, enabled: updated.enabled },
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
