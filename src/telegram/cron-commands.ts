import type { TelegramApi } from "./api.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import type { CronStore } from "../state/cron-store.js";
import type { CronScheduler } from "../runtime/cron-scheduler.js";
import { validateCronExpression } from "../runtime/cron-scheduler.js";

export type CronLocale = "zh" | "en";

export interface CronCommandContext {
  api: Pick<TelegramApi, "sendMessage">;
  store: CronStore;
  scheduler: CronScheduler;
  chatId: number;
  userId: number;
  chatType?: string;
  locale: CronLocale;
}

const CRON_COMMAND_RE = /^\/cron(?:@\w+)?(?:\s|$)/i;

export function isCronCommand(text: string): boolean {
  return CRON_COMMAND_RE.test(text.trim());
}

interface ParsedCommand {
  sub: string;
  rest: string;
}

function parseCronCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  // Strip the leading "/cron" or "/cron@bot"
  const stripped = trimmed.replace(/^\/cron(?:@\w+)?/i, "").trim();
  if (!stripped) {
    return { sub: "list", rest: "" };
  }
  const firstSpace = stripped.search(/\s/);
  if (firstSpace === -1) {
    return { sub: stripped.toLowerCase(), rest: "" };
  }
  return {
    sub: stripped.slice(0, firstSpace).toLowerCase(),
    rest: stripped.slice(firstSpace + 1).trim(),
  };
}

function humanizeCronExpr(expr: string, locale: CronLocale): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return locale === "zh" ? "每分钟" : "every minute";
  }
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return locale === "zh" ? "每小时整点" : "hourly";
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    return locale === "zh" ? `每天 ${hh}:${mm}` : `daily ${hh}:${mm}`;
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    month === "*" &&
    /^[0-6]$/.test(dow)
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    const dayNamesZh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const dayNamesEn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const idx = Number(dow);
    return locale === "zh"
      ? `每${dayNamesZh[idx]} ${hh}:${mm}`
      : `weekly ${dayNamesEn[idx]} ${hh}:${mm}`;
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    month === "*" &&
    dow === "*"
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    return locale === "zh"
      ? `每月 ${dom} 日 ${hh}:${mm}`
      : `monthly day ${dom} ${hh}:${mm}`;
  }
  return null;
}

function humanizeRelative(iso: string, locale: CronLocale): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  let value: string;
  if (sec < 60) {
    value = locale === "zh" ? `${sec} 秒` : `${sec} second${sec === 1 ? "" : "s"}`;
  } else if (min < 60) {
    value = locale === "zh" ? `${min} 分钟` : `${min} minute${min === 1 ? "" : "s"}`;
  } else if (hr < 24) {
    value = locale === "zh" ? `${hr} 小时` : `${hr} hour${hr === 1 ? "" : "s"}`;
  } else {
    value = locale === "zh" ? `${day} 天` : `${day} day${day === 1 ? "" : "s"}`;
  }

  if (future) {
    return locale === "zh" ? `${value}后` : `in ${value}`;
  }
  return locale === "zh" ? `${value}前` : `${value} ago`;
}

function renderJob(job: CronJobRecord, index: number, locale: CronLocale): string {
  const lines: string[] = [];
  const enabledLabel = job.enabled
    ? locale === "zh" ? "✓ 已启用" : "✓ enabled"
    : locale === "zh" ? "✗ 已停用" : "✗ disabled";
  lines.push(`${index}. ID  ${job.id}  ${enabledLabel}`);
  const human = job.runOnce && job.targetAt
    ? locale === "zh"
      ? `仅一次 ${job.targetAt} (${humanizeRelative(job.targetAt, locale)})`
      : `once ${job.targetAt} (${humanizeRelative(job.targetAt, locale)})`
    : humanizeCronExpr(job.cronExpr, locale);
  const exprLine = job.runOnce && job.targetAt
    ? human
    : human ? `${job.cronExpr}  (${human})` : job.cronExpr;
  const timezone = job.timezone && !job.runOnce ? `  TZ ${job.timezone}` : "";
  lines.push(`   ⏰ ${exprLine}${timezone}`);
  lines.push(`   📝 ${job.prompt}`);
  if (job.lastRunAt) {
    const rel = humanizeRelative(job.lastRunAt, locale);
    const status = job.lastError
      ? locale === "zh" ? `失败：${job.lastError}` : `failed: ${job.lastError}`
      : locale === "zh" ? "成功" : "success";
    const label = locale === "zh" ? "上次" : "last";
    lines.push(`   ⏱ ${label}: ${rel} (${job.lastRunAt}) ${status}`);
  }
  return lines.join("\n");
}

function renderHelp(locale: CronLocale): string {
  if (locale === "zh") {
    return [
      "📅 /cron 命令用法：",
      "",
      "/cron              查看所有任务",
      "/cron list         同上",
      "/cron add <cron 表达式> <提示词>",
      "                   例：/cron add 0 9 * * * 早安总结",
      "/cron rm <id>      删除任务（别名 delete / del）",
      "/cron toggle <id>  启用/停用任务",
      "/cron run <id>     立即运行一次",
      "/cron help         显示本帮助",
    ].join("\n");
  }
  return [
    "📅 /cron command usage:",
    "",
    "/cron              list scheduled tasks",
    "/cron list         same as above",
    "/cron add <cron expr> <prompt>",
    "                   e.g. /cron add 0 9 * * * morning summary",
    "/cron rm <id>      remove task (alias delete / del)",
    "/cron toggle <id>  enable / disable task",
    "/cron run <id>     run once now",
    "/cron help         show this help",
  ].join("\n");
}

async function handleList(context: CronCommandContext): Promise<void> {
  const jobs = await context.store.listByChat(context.chatId);
  if (jobs.length === 0) {
    const msg = context.locale === "zh"
      ? "暂无定时任务。用 `/cron add 0 9 * * * 早安总结` 添加一个。"
      : "No scheduled tasks. Use `/cron add 0 9 * * * morning summary` to add one.";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const header = context.locale === "zh"
    ? `📅 已安排 ${jobs.length} 个任务：`
    : `📅 ${jobs.length} scheduled task${jobs.length === 1 ? "" : "s"}:`;
  const body = jobs.map((job, idx) => renderJob(job, idx + 1, context.locale)).join("\n\n");
  await context.api.sendMessage(context.chatId, `${header}\n\n${body}`);
}

async function handleAdd(rest: string, context: CronCommandContext): Promise<void> {
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) {
    const msg = context.locale === "zh"
      ? "用法：/cron add <分 时 日 月 周> <提示词>\n例：/cron add 0 9 * * * 早安总结"
      : "Usage: /cron add <m h dom mon dow> <prompt>\nExample: /cron add 0 9 * * * morning summary";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const cronExpr = tokens.slice(0, 5).join(" ");
  const prompt = tokens.slice(5).join(" ");

  if (validateCronExpression(cronExpr) === null) {
    const msg = context.locale === "zh"
      ? `无效的 cron 表达式：\`${cronExpr}\``
      : `Invalid cron expression: \`${cronExpr}\``;
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  if (prompt.length > 4000) {
    const msg = context.locale === "zh"
      ? "提示词过长（最多 4000 字符）。"
      : "Prompt too long (max 4000 characters).";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }

  let record: CronJobRecord;
  try {
    record = await context.store.add({
      chatId: context.chatId,
      userId: context.userId,
      chatType: context.chatType ?? "private",
      locale: context.locale,
      cronExpr,
      prompt,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const msg = context.locale === "zh"
      ? `添加任务失败：${detail}`
      : `Failed to add task: ${detail}`;
    await context.api.sendMessage(context.chatId, msg);
    return;
  }

  await context.scheduler.refresh();

  const human = humanizeCronExpr(cronExpr, context.locale);
  const exprLine = human ? `${cronExpr}  (${human})` : cronExpr;
  const timezone = record.timezone ? `  TZ ${record.timezone}` : "";
  const msg = context.locale === "zh"
    ? `✓ 已添加任务  ID  ${record.id}\n⏰ ${exprLine}${timezone}\n📝 ${prompt}`
    : `✓ Added task  ID  ${record.id}\n⏰ ${exprLine}${timezone}\n📝 ${prompt}`;
  await context.api.sendMessage(context.chatId, msg);
}

async function ensureChatJob(
  id: string,
  context: CronCommandContext,
): Promise<CronJobRecord | null> {
  if (!/^[a-f0-9]{8}$/.test(id)) {
    const msg = context.locale === "zh"
      ? `无效的 ID：${id}（应为 8 位十六进制）`
      : `Invalid ID: ${id} (must be 8 hex characters)`;
    await context.api.sendMessage(context.chatId, msg);
    return null;
  }
  const job = await context.store.get(id);
  if (!job || job.chatId !== context.chatId) {
    const msg = context.locale === "zh"
      ? `未找到任务：${id}`
      : `Task not found: ${id}`;
    await context.api.sendMessage(context.chatId, msg);
    return null;
  }
  return job;
}

async function handleRemove(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = context.locale === "zh"
      ? "用法：/cron rm <id>"
      : "Usage: /cron rm <id>";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const removed = await context.store.remove(id);
  if (!removed) {
    const msg = context.locale === "zh"
      ? `未找到任务：${id}`
      : `Task not found: ${id}`;
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  await context.scheduler.refresh();
  const msg = context.locale === "zh"
    ? `✓ 已删除任务  ID  ${id}`
    : `✓ Removed task  ID  ${id}`;
  await context.api.sendMessage(context.chatId, msg);
}

async function handleToggle(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = context.locale === "zh"
      ? "用法：/cron toggle <id>"
      : "Usage: /cron toggle <id>";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const updated = await context.store.toggleEnabled(id);
  if (!updated) {
    const msg = context.locale === "zh"
      ? `未找到任务：${id}`
      : `Task not found: ${id}`;
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  await context.scheduler.refresh();
  const stateLabel = updated.enabled
    ? context.locale === "zh" ? "已启用" : "enabled"
    : context.locale === "zh" ? "已停用" : "disabled";
  const msg = context.locale === "zh"
    ? `✓ 任务 ${id} ${stateLabel}`
    : `✓ Task ${id} ${stateLabel}`;
  await context.api.sendMessage(context.chatId, msg);
}

async function handleRun(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = context.locale === "zh"
      ? "用法：/cron run <id>"
      : "Usage: /cron run <id>";
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const ack = context.locale === "zh"
    ? `▶ 正在运行任务 ${id}…`
    : `▶ Running task ${id}…`;
  await context.api.sendMessage(context.chatId, ack);

  void context.scheduler.runJobNow(id).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const msg = context.locale === "zh"
      ? `任务 ${id} 运行失败：${detail}`
      : `Task ${id} run failed: ${detail}`;
    await context.api.sendMessage(context.chatId, msg);
  });

  const done = context.locale === "zh"
    ? `✓ 任务 ${id} 已触发`
    : `✓ Task ${id} triggered`;
  await context.api.sendMessage(context.chatId, done);
}

export async function handleCronCommand(
  text: string,
  context: CronCommandContext,
): Promise<{ handled: boolean; subcommand?: string }> {
  if (!isCronCommand(text)) {
    return { handled: false };
  }

  const { sub, rest } = parseCronCommand(text);

  switch (sub) {
    case "list":
      await handleList(context);
      return { handled: true, subcommand: "list" };
    case "add":
      await handleAdd(rest, context);
      return { handled: true, subcommand: "add" };
    case "rm":
    case "delete":
    case "del":
      await handleRemove(rest, context);
      return { handled: true, subcommand: "rm" };
    case "toggle":
      await handleToggle(rest, context);
      return { handled: true, subcommand: "toggle" };
    case "run":
      await handleRun(rest, context);
      return { handled: true, subcommand: "run" };
    case "help":
      await context.api.sendMessage(context.chatId, renderHelp(context.locale));
      return { handled: true, subcommand: "help" };
    default: {
      const msg = context.locale === "zh"
        ? `未知子命令：${sub}\n\n${renderHelp("zh")}`
        : `Unknown subcommand: ${sub}\n\n${renderHelp("en")}`;
      await context.api.sendMessage(context.chatId, msg);
      return { handled: true, subcommand: "unknown" };
    }
  }
}
